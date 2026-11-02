//! Actualisation du catalogue en arrière-plan, par comparaison.
//!
//! Contrairement à l'écriture complète de la connexion (`ingestion.rs`, qui télécharge les six
//! listes en parallèle, les garde entières en mémoire puis efface et réécrit les tables), cette
//! actualisation doit passer inaperçue sur un Chromecast :
//! - **une liste à la fois**, téléchargée dans un fichier temporaire (gardé compressé si le
//!   fournisseur compresse), jamais entière en mémoire ;
//! - lue **au fil de l'eau**, deux fois : une passe de vérification, puis une passe de comparaison
//!   avec la base qui n'écrit **que ce qui a changé** (ajouts, modifications, positions,
//!   suppressions), par paquets de `BATCH_ROWS` lignes, une courte transaction par paquet et une
//!   petite pause entre deux ;
//! - **une liste n'est écrite qu'une fois arrivée entière et lisible** ; un arrêt (vidéo lancée,
//!   déconnexion, écriture lourde d'un autre module) laisse une base cohérente, et la fois suivante
//!   termine le travail (la comparaison est rejouable) ;
//! - tout ce que la page doit refaire ensuite est **noté en base dans la même transaction** que
//!   l'écriture qui le rend nécessaire (compteur `catalog_changes_seq`, recherche à mettre à jour,
//!   chaînes à relier au guide) : une interruption ne perd rien.
//!
//! Même conversion « élément du fournisseur → ligne » que l'écriture complète (`movie_row`,
//! `series_row`, `live_row` de `catalog_parser.rs`) : les deux chemins ne peuvent pas diverger.
//! Aucune adresse ni aucun identifiant n'est jamais journalisé.

use crate::catalog_parser::{
    insert_categories, item_text, live_row, movie_row, normalize_category_id, open_connection, series_row,
    ListItem, XtreamCategory, XtreamLive, XtreamMovie, XtreamSeries,
};
use crate::storage::{get_data_dir, validate_db_name};
use rusqlite::types::Value as SqlValue;
use rusqlite::{params, Connection, ErrorCode, OptionalExtension, Transaction};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::hash::{DefaultHasher, Hash, Hasher};
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::OnceLock;
use tauri::Manager;
use tokio::io::AsyncWriteExt;
use tokio::sync::Notify;

// =============================================================================
// RÉGLAGES
// =============================================================================

/// Lignes écrites par transaction : une transaction reste courte (la page ne doit jamais attendre
/// plus que ses 5 s de patience pour enregistrer une reprise de lecture).
pub const BATCH_ROWS: usize = 2_000;
/// Pause entre deux paquets : laisse le processeur au reste de l'app sur les petits appareils.
const PAUSE_BETWEEN_BATCHES_MS: u64 = 15;
/// Courte pause tous les `CHECK_EVERY_ITEMS` éléments lus, même sans rien écrire : un passage où
/// presque rien ne change ne doit pas occuper un cœur du processeur sans répit (Chromecast)
const PAUSE_WHILE_READING_MS: u64 = 5;
/// Fréquence de la vérification de l'arrêt pendant la lecture d'une liste.
const CHECK_EVERY_ITEMS: usize = 2_000;
// Au-delà de 1 % d'éléments illisibles, la liste est abandonnée (table gardée) : règle commune
// avec la connexion, `catalog_parser::unreadable_tolerated`.
/// Mode automatique : plus de 20 % de titres disparus sans remplaçant = fournisseur malade, ils ne
/// sont pas supprimés (conseil d'actualiser à la main).
const MAX_LOST_RATIO_AUTO: f64 = 0.20;
/// Au-delà, la recherche est entièrement reconstruite par la page au lieu d'une mise à jour ligne à
/// ligne (`content_id` n'est pas indexé dans la table de recherche).
const SEARCH_PENDING_CAP: usize = 2_000;
/// Taille maximale d'une liste téléchargée (protection du disque).
const MAX_DOWNLOAD_BYTES: u64 = 512 * 1024 * 1024;
/// Taille maximale d'une liste une fois décompressée : une petite réponse compressée ne peut pas
/// remplir la mémoire ni occuper le processeur pendant des heures (une vraie liste de 100 000
/// films fait environ 100 Mo).
const MAX_LIST_BYTES: u64 = 512 * 1024 * 1024;
/// Vérification de l'arrêt pendant la lecture, même au milieu d'un élément démesuré
const CHECK_EVERY_BYTES: u64 = 8 * 1024 * 1024;
/// Liaison au guide : le guide entier n'est rechargé que si au moins 20 chaînes reliées n'ont pas
/// de programmes, ou s'il a plus de 24 h (voir `flag_guide_if_many_links_lack_programs`).
const GUIDE_RELOAD_MIN_MISSING: i64 = 20;
const GUIDE_RELOAD_MAX_AGE_MS: i64 = 24 * 3600 * 1000;

// =============================================================================
// TYPES
// =============================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Kind {
    Movies,
    Series,
    Live,
}

impl Kind {
    fn list_name(self) -> &'static str {
        match self {
            Kind::Movies => "movies",
            Kind::Series => "series",
            Kind::Live => "live",
        }
    }
    fn action(self) -> &'static str {
        match self {
            Kind::Movies => "get_vod_streams",
            Kind::Series => "get_series",
            Kind::Live => "get_live_streams",
        }
    }
    /// Valeur de `content_type` dans la table de recherche
    fn search_type(self) -> &'static str {
        match self {
            Kind::Movies => "movie",
            Kind::Series => "series",
            Kind::Live => "live",
        }
    }
    fn id_field(self) -> &'static str {
        match self {
            Kind::Series => "series_id",
            _ => "stream_id",
        }
    }
    /// Même plafond d'éléments que la connexion (`catalog_parser::ListItem`)
    fn max_items(self) -> usize {
        match self {
            Kind::Movies => XtreamMovie::MAX_ITEMS,
            Kind::Series => XtreamSeries::MAX_ITEMS,
            Kind::Live => XtreamLive::MAX_ITEMS,
        }
    }
}

/// Automatique (toutes les 12 h) ou demandée par l'utilisateur (pas de seuil « fournisseur malade »).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Auto,
    Manual,
}

/// Raison d'un arrêt en cours de route. Ce qui est déjà écrit reste valable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stop {
    /// Demandé par la page (vidéo lancée, déconnexion, actualisation manuelle…)
    Aborted,
    /// Une écriture lourde est en cours (connexion, guide) : on réessaiera plus tard
    Busy,
    /// Le fournisseur enregistré n'est plus celui de cette actualisation
    ProviderChanged,
}

#[derive(Debug)]
pub enum ApplyError {
    Stopped(Stop),
    /// Liste illisible, réponse d'erreur du fournisseur, erreur de base : rien n'est perdu
    Failed(String),
}

impl From<Stop> for ApplyError {
    fn from(s: Stop) -> Self {
        ApplyError::Stopped(s)
    }
}

fn db_error(context: &str, e: rusqlite::Error) -> ApplyError {
    if let rusqlite::Error::SqliteFailure(ref f, _) = e {
        if f.code == ErrorCode::DatabaseBusy || f.code == ErrorCode::DatabaseLocked {
            return ApplyError::Stopped(Stop::Busy);
        }
    }
    ApplyError::Failed(format!("{}: {}", context, e))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    /// Des lignes ont été écrites
    Applied,
    /// Rien n'a changé
    Unchanged,
    /// Liste vide ou identifiants TMDB en chute : table gardée telle quelle (garde-fous actuels)
    Kept,
    /// Téléchargement ou lecture impossible
    Failed,
    /// Pas traitée (arrêt avant elle, ou non demandée)
    #[default]
    NotRun,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListSummary {
    pub list: String,
    pub outcome: Outcome,
    pub added: usize,
    pub changed: usize,
    pub moved: usize,
    pub removed: usize,
    /// Vraies nouveautés : un titre seulement renuméroté n'en est pas une
    pub new_items: usize,
    /// Disparus sans remplaçant gardés (plus de 20 %, mode automatique)
    pub removal_skipped: bool,
    pub skipped_items: usize,
}

impl ListSummary {
    fn new(list: &str) -> Self {
        ListSummary { list: list.to_string(), ..Default::default() }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProgressRelink {
    pub from: i64,
    pub to: i64,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshSummary {
    /// done | unchanged | partial | failed | aborted | busy | rate_limited
    pub status: String,
    /// Pour `aborted` : page | provider_changed
    pub stop_reason: Option<String>,
    pub retry_after_sec: Option<u64>,
    pub lists: Vec<ListSummary>,
    /// Listes à retenter seules (movies, series, live, categories)
    pub failed_lists: Vec<String>,
    /// Reprises de films re-liées à un nouveau numéro (même TMDB), pour le cloud
    pub progress_relinks: Vec<ProgressRelink>,
    /// Chaînes reliées au guide pendant ce passage
    pub epg_relinked: usize,
    pub duration_ms: u64,
    pub bytes_downloaded: u64,
}

// =============================================================================
// LIGNE COMMUNE ET EMPREINTES
// =============================================================================

/// Ligne d'une des trois tables, dans une forme commune pour comparer : les colonnes absentes d'une
/// table restent à None. Construite depuis `movie_row`/`series_row`/`live_row` d'un côté, depuis la
/// base de l'autre.
#[derive(Debug, Clone, Default, PartialEq)]
struct Row {
    id: i64,
    tmdb: Option<i64>,
    name: String,
    icon: Option<String>,
    category_id: Option<String>,
    added: Option<i64>,
    rating: Option<f64>,
    ext: Option<String>,
    epg_channel_id: Option<String>,
    geo_hint: Option<String>,
}

fn hash_of<T: Hash + ?Sized>(value: &T) -> u64 {
    let mut h = DefaultHasher::new();
    value.hash(&mut h);
    h.finish()
}

impl Row {
    /// Empreinte de tout ce que l'écriture enregistre, sauf la position (comparée à part : un ajout
    /// en tête ne doit pas faire passer toutes les lignes pour modifiées).
    fn content_hash(&self) -> u64 {
        let mut h = DefaultHasher::new();
        self.tmdb.hash(&mut h);
        self.name.hash(&mut h);
        self.icon.hash(&mut h);
        self.category_id.hash(&mut h);
        self.added.hash(&mut h);
        self.rating.map(f64::to_bits).hash(&mut h);
        self.ext.hash(&mut h);
        self.epg_channel_id.hash(&mut h);
        self.geo_hint.hash(&mut h);
        h.finish()
    }

    fn name_hash(&self) -> u64 {
        hash_of(self.name.as_str())
    }

    /// Chaînes : ce dont dépend la liaison au guide (nom, catégorie, identifiant du guide, pays).
    /// Séries : date de modification (nouveaux épisodes). Films : rien.
    fn aux_hash(&self, kind: Kind) -> u64 {
        match kind {
            Kind::Live => hash_of(&(&self.name, &self.category_id, &self.epg_channel_id, &self.geo_hint)),
            Kind::Series => hash_of(&self.added),
            Kind::Movies => 0,
        }
    }
}

/// Ligne d'un élément, et vrai si un champ secondaire de forme inattendue y a été ignoré
/// (`take_odd_field`).
fn convert(kind: Kind, text: &str) -> Result<(Row, bool), serde_json::Error> {
    crate::catalog_parser::take_odd_field();
    let row = convert_row(kind, text);
    let odd = crate::catalog_parser::take_odd_field();
    row.map(|row| (row, odd))
}

fn convert_row(kind: Kind, text: &str) -> Result<Row, serde_json::Error> {
    Ok(match kind {
        Kind::Movies => {
            let r = movie_row(&serde_json::from_str::<XtreamMovie>(text)?);
            Row {
                id: r.id,
                tmdb: r.tmdb_id,
                name: r.name,
                icon: r.icon,
                category_id: r.category_id,
                added: r.added,
                rating: r.rating,
                ext: r.container_extension,
                ..Default::default()
            }
        }
        Kind::Series => {
            let r = series_row(&serde_json::from_str::<XtreamSeries>(text)?);
            Row {
                id: r.id,
                tmdb: r.tmdb_id,
                name: r.name,
                icon: r.icon,
                category_id: r.category_id,
                added: r.added,
                rating: r.rating,
                ..Default::default()
            }
        }
        Kind::Live => {
            let r = live_row(&serde_json::from_str::<XtreamLive>(text)?);
            Row {
                id: r.id,
                name: r.name,
                icon: r.icon,
                category_id: r.category_id,
                epg_channel_id: r.epg_channel_id,
                geo_hint: r.geo_hint,
                ..Default::default()
            }
        }
    })
}

/// Numéro d'un élément illisible, s'il se lit au moins lui (nombre ou texte)
fn value_id(kind: Kind, text: &str) -> Option<i64> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    crate::catalog_parser::id_from_value(value.get(kind.id_field())?)
}

// Lecture tolérante des valeurs de la base (une valeur d'un ancien format donne simplement une
// empreinte différente, et la ligne est réécrite proprement).
fn sql_i64(v: SqlValue) -> Option<i64> {
    match v {
        SqlValue::Integer(i) => Some(i),
        SqlValue::Real(f) => Some(f as i64),
        SqlValue::Text(s) => s.trim().parse::<i64>().ok(),
        _ => None,
    }
}
fn sql_f64(v: SqlValue) -> Option<f64> {
    match v {
        SqlValue::Integer(i) => Some(i as f64),
        SqlValue::Real(f) => Some(f),
        SqlValue::Text(s) => s.trim().parse::<f64>().ok(),
        _ => None,
    }
}
fn sql_text(v: SqlValue) -> Option<String> {
    match v {
        SqlValue::Text(s) => Some(s),
        SqlValue::Integer(i) => Some(i.to_string()),
        SqlValue::Real(f) => Some(f.to_string()),
        _ => None,
    }
}

// =============================================================================
// LECTURE AU FIL DE L'EAU
// =============================================================================

/// Lecture bornée : au-delà de `MAX_LIST_BYTES` octets décompressés, ou si l'arrêt est demandé
/// (vérifié tous les `CHECK_EVERY_BYTES`), la lecture échoue. L'arrêt est noté dans `stopped`,
/// pour être rendu comme un arrêt et non comme une liste illisible.
struct GuardedReader<'s, R> {
    inner: R,
    read: u64,
    limit: u64,
    next_check: u64,
    should_stop: &'s dyn Fn() -> Option<Stop>,
    stopped: std::rc::Rc<std::cell::Cell<Option<Stop>>>,
}

impl<R: Read> Read for GuardedReader<'_, R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.read >= self.next_check {
            self.next_check = self.read + CHECK_EVERY_BYTES;
            if let Some(stop) = (self.should_stop)() {
                self.stopped.set(Some(stop));
                return Err(std::io::Error::other("stopped"));
            }
        }
        let n = self.inner.read(buf)?;
        self.read += n as u64;
        if self.read > self.limit {
            return Err(std::io::Error::other("list too large"));
        }
        Ok(n)
    }
}

/// Ouvre un fichier téléchargé, décompressé à la volée s'il est compressé (octets 1F 8B, même
/// vérification que le guide).
fn open_list_reader(path: &Path) -> Result<Box<dyn Read>, String> {
    let mut file = std::fs::File::open(path).map_err(|e| format!("open list: {}", e.kind()))?;
    let mut magic = [0u8; 2];
    let n = file.read(&mut magic).map_err(|e| format!("read list: {}", e.kind()))?;
    let file = std::fs::File::open(path).map_err(|e| format!("open list: {}", e.kind()))?;
    let reader = BufReader::with_capacity(64 * 1024, file);
    let reader: Box<dyn Read> = if n == 2 && magic == [0x1f, 0x8b] {
        Box::new(BufReader::with_capacity(64 * 1024, flate2::read::GzDecoder::new(reader)))
    } else {
        Box::new(reader)
    };
    // Avertissements PHP avant la liste (vieux panneaux) : sautés, même règle que la connexion
    crate::catalog_parser::skip_php_notice(reader)
        // Tampon autour de l'enveloppe : serde lit octet par octet, sans appel indirect à chaque fois
        .map(|r| Box::new(BufReader::with_capacity(64 * 1024, r)) as Box<dyn Read>)
        .map_err(|e| format!("read list: {}", e.kind()))
}

struct SeqVisitor<'f, F> {
    on_item: &'f mut F,
    max_items: usize,
    /// Arrêt ou échec demandé par `on_item` : la lecture s'arrête là (le reste de la liste n'est pas
    /// lu, d'où l'erreur de serde qui suit, ignorée au profit de celle-ci)
    early_exit: &'f mut Option<ApplyError>,
}

impl<'de, F> serde::de::Visitor<'de> for SeqVisitor<'_, F>
where
    F: FnMut(usize, Option<&str>) -> Result<(), ApplyError>,
{
    type Value = usize;

    fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str("a list")
    }

    fn visit_seq<A: serde::de::SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
        use serde::de::Error as _;
        let mut index = 0;
        // Chaque élément est gardé tel quel (son texte JSON) puis lu à part : un élément mal formé
        // n'arrête pas la liste (serde ne sait pas reprendre au milieu d'une lecture typée). Un
        // élément démesuré n'est pas lu (`None`, donc illisible, sans numéro de secours : sa ligne
        // n'est pas gardée) : même règle que la connexion (`catalog_parser::item_text`).
        while let Some(raw) = seq.next_element::<Box<serde_json::value::RawValue>>()? {
            // Au-delà du plafond, la liste est refusée (table gardée) : même règle que la connexion
            if index >= self.max_items {
                *self.early_exit = Some(ApplyError::Failed(format!("more than {} items", self.max_items)));
                return Err(A::Error::custom("stopped"));
            }
            if let Err(e) = (self.on_item)(index, item_text(&raw)) {
                *self.early_exit = Some(e);
                return Err(A::Error::custom("stopped"));
            }
            index += 1;
        }
        Ok(index)
    }

    /// Liste envoyée comme objet à clés numériques (`{"0":{…},"7":{…}}`) : lue comme une liste,
    /// même règle que la connexion (`catalog_parser`). Un objet à autres clés reste illisible.
    fn visit_map<A: serde::de::MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        use serde::de::Error as _;
        let mut index = 0;
        while let Some(key) = map.next_key::<crate::catalog_parser::NumericKey>()? {
            if key.0.is_none() {
                return Err(A::Error::custom(crate::catalog_parser::NOT_A_LIST));
            }
            let raw = map.next_value::<Box<serde_json::value::RawValue>>()?;
            if index >= self.max_items {
                *self.early_exit = Some(ApplyError::Failed(format!("more than {} items", self.max_items)));
                return Err(A::Error::custom("stopped"));
            }
            if let Err(e) = (self.on_item)(index, item_text(&raw)) {
                *self.early_exit = Some(e);
                return Err(A::Error::custom("stopped"));
            }
            index += 1;
        }
        Ok(index)
    }
}

/// Parcourt une liste JSON élément par élément. Une réponse qui n'est pas une liste (réponse
/// d'erreur du fournisseur) ou un fichier tronqué = échec.
fn for_each_item<F>(path: &Path, max_items: usize, should_stop: &dyn Fn() -> Option<Stop>, mut on_item: F) -> Result<usize, ApplyError>
where
    F: FnMut(usize, Option<&str>) -> Result<(), ApplyError>,
{
    use serde::Deserializer as _;
    let stopped = std::rc::Rc::new(std::cell::Cell::new(None));
    let reader = GuardedReader {
        inner: open_list_reader(path).map_err(ApplyError::Failed)?,
        read: 0,
        limit: MAX_LIST_BYTES,
        next_check: CHECK_EVERY_BYTES,
        should_stop,
        stopped: stopped.clone(),
    };
    let mut de = serde_json::Deserializer::from_reader(reader);
    let mut early_exit: Option<ApplyError> = None;
    // `deserialize_any` : une liste envoyée comme objet à clés numériques est lue aussi (visit_map)
    let result = (&mut de).deserialize_any(SeqVisitor { on_item: &mut on_item, max_items, early_exit: &mut early_exit });
    if let Some(e) = early_exit {
        return Err(e);
    }
    if let Some(stop) = stopped.get() {
        return Err(stop.into());
    }
    let count = result.map_err(|e| ApplyError::Failed(format!("unreadable list: {}", e)))?;
    de.end().map_err(|e| ApplyError::Failed(format!("unreadable list: {}", e)))?;
    Ok(count)
}

// =============================================================================
// NOTES « À FAIRE » (dans la même transaction que les écritures)
// =============================================================================

fn meta_get(conn: &Connection, key: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row("SELECT value FROM meta WHERE key = ?1", params![key], |r| r.get::<_, Option<String>>(0))
        .optional()
        .map(Option::flatten)
}

fn meta_set(conn: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
    conn.execute("INSERT OR REPLACE INTO meta (key, value) VALUES (?1, ?2)", params![key, value])
        .map(|_| ())
}

fn meta_increment(conn: &Connection, key: &str) -> rusqlite::Result<()> {
    let current = meta_get(conn, key)?.and_then(|v| v.trim().parse::<i64>().ok()).unwrap_or(0);
    meta_set(conn, key, &(current + 1).to_string())
}

/// Numéros dont le nom a changé (ajout, modification, suppression) : la page met la recherche à
/// jour ligne à ligne, ou la reconstruit (« all ») au-delà de `SEARCH_PENDING_CAP`.
/// Forme : `meta.search_pending` = `{"movie":[…],"series":[…],"live":[…]}` ou `"all"`,
/// `meta.search_dirty` = `1`, `meta.search_seq` augmenté (la page n'efface la note que si ce
/// compteur n'a pas bougé pendant son travail).
fn note_search_changes(conn: &Connection, kind: Kind, ids: &[i64]) -> rusqlite::Result<()> {
    if ids.is_empty() {
        return Ok(());
    }
    let current = meta_get(conn, "search_pending")?;
    let next: String = match current.as_deref() {
        Some("all") => "all".to_string(),
        _ => {
            let mut pending: HashMap<String, Vec<i64>> = current
                .as_deref()
                .and_then(|v| serde_json::from_str(v).ok())
                .unwrap_or_default();
            let total: usize = pending.values().map(Vec::len).sum::<usize>() + ids.len();
            if total > SEARCH_PENDING_CAP {
                "all".to_string()
            } else {
                pending.entry(kind.search_type().to_string()).or_default().extend_from_slice(ids);
                serde_json::to_string(&pending).unwrap_or_else(|_| "all".to_string())
            }
        }
    };
    meta_set(conn, "search_pending", &next)?;
    meta_set(conn, "search_dirty", "1")?;
    meta_increment(conn, "search_seq")
}

// =============================================================================
// COMPARAISON ET ÉCRITURE D'UNE LISTE
// =============================================================================

/// État actuel d'une ligne en base, réduit à des empreintes
struct Existing {
    hash: u64,
    aux: u64,
    name_hash: u64,
    sort: i64,
    tmdb: i64,
}

struct Snapshot {
    rows: HashMap<i64, Existing>,
    /// Photo prise avant tout paquet, pour juger les vraies nouveautés
    tmdb: HashSet<i64>,
    names: HashSet<u64>,
    tmdb_rows: i64,
}

fn load_snapshot(conn: &Connection, kind: Kind) -> Result<Snapshot, ApplyError> {
    let sql = match kind {
        Kind::Movies => "SELECT id, tmdb_id, name, icon, category_id, added, rating, container_extension, sort_order FROM movies",
        Kind::Series => "SELECT id, tmdb_id, name, icon, category_id, added, rating, NULL, sort_order FROM series",
        Kind::Live => "SELECT id, NULL, name, icon, category_id, epg_channel_id, geo_hint, NULL, sort_order FROM live",
    };
    let mut stmt = conn.prepare(sql).map_err(|e| db_error("read table", e))?;
    let mut rows = stmt.query([]).map_err(|e| db_error("read table", e))?;
    let mut snapshot = Snapshot { rows: HashMap::new(), tmdb: HashSet::new(), names: HashSet::new(), tmdb_rows: 0 };
    while let Some(r) = rows.next().map_err(|e| db_error("read table", e))? {
        let get = |i: usize| r.get::<_, SqlValue>(i).unwrap_or(SqlValue::Null);
        let id = match sql_i64(get(0)) {
            Some(id) => id,
            None => continue,
        };
        let row = match kind {
            Kind::Live => Row {
                id,
                name: sql_text(get(2)).unwrap_or_default(),
                icon: sql_text(get(3)),
                category_id: sql_text(get(4)),
                epg_channel_id: sql_text(get(5)),
                geo_hint: sql_text(get(6)),
                ..Default::default()
            },
            _ => Row {
                id,
                tmdb: sql_i64(get(1)).filter(|&t| t > 0),
                name: sql_text(get(2)).unwrap_or_default(),
                icon: sql_text(get(3)),
                category_id: sql_text(get(4)),
                added: sql_i64(get(5)),
                rating: sql_f64(get(6)),
                ext: if kind == Kind::Movies { sql_text(get(7)) } else { None },
                ..Default::default()
            },
        };
        let tmdb = row.tmdb.unwrap_or(0);
        if tmdb > 0 {
            snapshot.tmdb.insert(tmdb);
            snapshot.tmdb_rows += 1;
        }
        let name_hash = row.name_hash();
        snapshot.names.insert(name_hash);
        snapshot.rows.insert(
            id,
            Existing {
                hash: row.content_hash(),
                aux: row.aux_hash(kind),
                name_hash,
                sort: sql_i64(get(8)).unwrap_or(0),
                tmdb,
            },
        );
    }
    Ok(snapshot)
}

enum Op {
    Upsert { row: Row, sort: i64, relink_guide: bool },
    Move { id: i64, sort: i64 },
    Delete { id: i64 },
}

/// Paquet d'écritures en attente, avec ses notes
struct Batch {
    kind: Kind,
    ops: Vec<Op>,
    search_ids: Vec<i64>,
    /// Séries dont les épisodes ont changé : leur liste d'épisodes gardée par la page est oubliée
    episodes_changed: Vec<i64>,
}

impl Batch {
    fn new(kind: Kind) -> Self {
        Batch { kind, ops: Vec::with_capacity(BATCH_ROWS), search_ids: Vec::new(), episodes_changed: Vec::new() }
    }

    fn is_full(&self) -> bool {
        self.ops.len() >= BATCH_ROWS
    }

    /// Écrit le paquet dans une transaction, avec ses notes, puis rend la main un instant
    fn flush(&mut self, conn: &mut Connection, should_stop: &dyn Fn() -> Option<Stop>) -> Result<(), ApplyError> {
        if self.ops.is_empty() {
            return Ok(());
        }
        if let Some(stop) = should_stop() {
            return Err(stop.into());
        }
        let tx = conn.transaction().map_err(|e| db_error("begin", e))?;
        write_ops(&tx, self.kind, &self.ops).map_err(|e| db_error("write batch", e))?;
        meta_increment(&tx, "catalog_changes_seq").map_err(|e| db_error("note changes", e))?;
        note_search_changes(&tx, self.kind, &self.search_ids).map_err(|e| db_error("note search", e))?;
        if !self.episodes_changed.is_empty() {
            // Table de la page, absente tant qu'aucune fiche série n'a été ouverte : erreur ignorée
            if let Ok(mut stmt) = tx.prepare_cached("DELETE FROM xtream_series_cache WHERE series_id = ?1") {
                for id in &self.episodes_changed {
                    let _ = stmt.execute(params![id]);
                }
            }
        }
        tx.commit().map_err(|e| db_error("commit", e))?;
        self.ops.clear();
        self.search_ids.clear();
        self.episodes_changed.clear();
        std::thread::sleep(std::time::Duration::from_millis(PAUSE_BETWEEN_BATCHES_MS));
        Ok(())
    }
}

fn write_ops(tx: &Transaction, kind: Kind, ops: &[Op]) -> rusqlite::Result<()> {
    let table = kind.list_name();
    for op in ops {
        match op {
            Op::Upsert { row, sort, relink_guide } => match kind {
                Kind::Movies => {
                    tx.prepare_cached(
                        "INSERT INTO movies (id, tmdb_id, name, icon, category_id, added, rating, container_extension, data, sort_order)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, ?9)
                         ON CONFLICT(id) DO UPDATE SET tmdb_id = excluded.tmdb_id, name = excluded.name,
                           icon = excluded.icon, category_id = excluded.category_id, added = excluded.added,
                           rating = excluded.rating, container_extension = excluded.container_extension,
                           data = NULL, sort_order = excluded.sort_order",
                    )?
                    .execute(params![row.id, row.tmdb, row.name, row.icon, row.category_id, row.added, row.rating, row.ext, sort])?;
                }
                Kind::Series => {
                    tx.prepare_cached(
                        "INSERT INTO series (id, tmdb_id, name, icon, category_id, added, rating, data, sort_order)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, ?8)
                         ON CONFLICT(id) DO UPDATE SET tmdb_id = excluded.tmdb_id, name = excluded.name,
                           icon = excluded.icon, category_id = excluded.category_id, added = excluded.added,
                           rating = excluded.rating, data = NULL, sort_order = excluded.sort_order",
                    )?
                    .execute(params![row.id, row.tmdb, row.name, row.icon, row.category_id, row.added, row.rating, sort])?;
                }
                Kind::Live if *relink_guide => {
                    // Nouveau lien au guide à calculer : l'ancien est effacé, la chaîne est notée
                    tx.prepare_cached(
                        "INSERT INTO live (id, name, icon, category_id, epg_channel_id, matched_epg_id, match_method, geo_hint, data, sort_order)
                         VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?7, NULL, ?8)
                         ON CONFLICT(id) DO UPDATE SET name = excluded.name, icon = excluded.icon,
                           category_id = excluded.category_id, epg_channel_id = excluded.epg_channel_id,
                           matched_epg_id = NULL, match_method = excluded.match_method,
                           geo_hint = excluded.geo_hint, data = NULL, sort_order = excluded.sort_order",
                    )?
                    .execute(params![
                        row.id,
                        row.name,
                        row.icon,
                        row.category_id,
                        row.epg_channel_id,
                        crate::epg_parser::PENDING_LINK,
                        row.geo_hint,
                        sort
                    ])?;
                }
                Kind::Live => {
                    // Seul le logo a changé : le lien au guide reste valable
                    tx.prepare_cached(
                        "UPDATE live SET name = ?2, icon = ?3, category_id = ?4, epg_channel_id = ?5,
                           geo_hint = ?6, data = NULL, sort_order = ?7 WHERE id = ?1",
                    )?
                    .execute(params![row.id, row.name, row.icon, row.category_id, row.epg_channel_id, row.geo_hint, sort])?;
                }
            },
            Op::Move { id, sort } => {
                tx.prepare_cached(&format!("UPDATE {} SET sort_order = ?2 WHERE id = ?1", table))?
                    .execute(params![id, sort])?;
            }
            Op::Delete { id } => {
                tx.prepare_cached(&format!("DELETE FROM {} WHERE id = ?1", table))?.execute(params![id])?;
                if kind == Kind::Series {
                    // Table de la page, peut-être absente
                    if let Ok(mut stmt) = tx.prepare_cached("DELETE FROM xtream_series_cache WHERE series_id = ?1") {
                        let _ = stmt.execute(params![id]);
                    }
                }
            }
        }
    }
    Ok(())
}

/// Le fournisseur enregistré est toujours celui de l'actualisation (valeur absente = même
/// fournisseur, comme la page). Sinon on mélangerait deux catalogues.
fn check_provider(conn: &Connection, host: &str) -> Result<(), ApplyError> {
    match meta_get(conn, "lastProvider") {
        Ok(Some(p)) if p != host => Err(Stop::ProviderChanged.into()),
        Ok(_) => Ok(()),
        Err(e) => Err(db_error("read provider", e)),
    }
}

/// Compare une liste téléchargée (fichier) à la table et n'écrit que les différences.
pub fn apply_list_file(
    conn: &mut Connection,
    kind: Kind,
    path: &Path,
    mode: Mode,
    host: &str,
    should_stop: &dyn Fn() -> Option<Stop>,
) -> Result<ListSummary, ApplyError> {
    let mut summary = ListSummary::new(kind.list_name());

    // ---- Passe 1 : vérification complète, sans rien écrire ----
    let mut last_pos: HashMap<i64, usize> = HashMap::new();
    let mut unreadable_ids: HashSet<i64> = HashSet::new();
    let mut received_tmdb: HashSet<i64> = HashSet::new();
    let mut received_names: HashSet<u64> = HashSet::new();
    let mut unreadable = 0usize;
    let mut tmdb_items = 0i64;
    let total = for_each_item(path, kind.max_items(), should_stop, |index, item| {
        if index % CHECK_EVERY_ITEMS == 0 {
            if let Some(stop) = should_stop() {
                return Err(stop.into());
            }
            if index > 0 {
                std::thread::sleep(std::time::Duration::from_millis(PAUSE_WHILE_READING_MS));
            }
        }
        match item.map(|text| convert(kind, text)) {
            Some(Ok((row, _))) => {
                if let Some(t) = row.tmdb {
                    tmdb_items += 1;
                    received_tmdb.insert(t);
                }
                received_names.insert(row.name_hash());
                last_pos.insert(row.id, index);
            }
            _ => {
                unreadable += 1;
                if let Some(id) = item.and_then(|text| value_id(kind, text)) {
                    unreadable_ids.insert(id);
                }
            }
        }
        Ok(())
    })?;
    summary.skipped_items = unreadable;

    if !crate::catalog_parser::unreadable_tolerated(unreadable, total) {
        return Err(ApplyError::Failed(format!("{} unreadable items of {}", unreadable, total)));
    }
    // Garde-fou actuel : une liste vide ne remplace jamais une table (fournisseur capricieux)
    if last_pos.is_empty() {
        log::info!("[CatalogRefresh] {}: empty list, table kept", kind.list_name());
        summary.outcome = Outcome::Kept;
        return Ok(summary);
    }

    check_provider(conn, host)?;
    let mut snapshot = load_snapshot(conn, kind)?;

    // Garde-fou actuel : identifiants TMDB en chute de plus de moitié = table gardée
    if kind != Kind::Live && snapshot.tmdb_rows > 0 && tmdb_items < snapshot.tmdb_rows / 2 {
        log::info!(
            "[CatalogRefresh] {}: TMDB ids dropped ({} → {}), table kept",
            kind.list_name(),
            snapshot.tmdb_rows,
            tmdb_items
        );
        summary.outcome = Outcome::Kept;
        return Ok(summary);
    }

    let existing_count = snapshot.rows.len();
    // Éléments illisibles dont le numéro se lit : leur ligne est gardée, jamais supprimée
    for id in &unreadable_ids {
        if !last_pos.contains_key(id) {
            snapshot.rows.remove(id);
        }
    }

    // ---- Passe 2 : comparaison et écriture par paquets ----
    let mut batch = Batch::new(kind);
    let mut wrote = false;
    for_each_item(path, kind.max_items(), should_stop, |index, item| {
        if index % CHECK_EVERY_ITEMS == 0 {
            if let Some(stop) = should_stop() {
                return Err(stop.into());
            }
            if index > 0 {
                std::thread::sleep(std::time::Duration::from_millis(PAUSE_WHILE_READING_MS));
            }
        }
        let (row, odd) = match item.map(|text| convert(kind, text)) {
            Some(Ok(converted)) => converted,
            _ => return Ok(()),
        };
        // Doublons : seule la dernière occurrence compte, à sa position, comme l'écriture complète
        if last_pos.get(&row.id) != Some(&index) {
            return Ok(());
        }
        // Champ secondaire de forme inattendue (affiche, catégorie… en liste ou en objet) sur un titre
        // déjà en base : ligne gardée telle quelle, sans effacer une bonne valeur sur un hoquet du
        // fournisseur (un titre nouveau, lui, est ajouté sans ce champ)
        if odd && snapshot.rows.remove(&row.id).is_some() {
            return Ok(());
        }
        let sort = index as i64;
        let name_hash = row.name_hash();
        match snapshot.rows.remove(&row.id) {
            None => {
                let already_there = match (kind, row.tmdb) {
                    (Kind::Live, _) | (_, None) => snapshot.names.contains(&name_hash),
                    (_, Some(t)) => snapshot.tmdb.contains(&t),
                };
                if !already_there {
                    summary.new_items += 1;
                }
                summary.added += 1;
                batch.search_ids.push(row.id);
                let id = row.id;
                batch.ops.push(Op::Upsert { row, sort, relink_guide: kind == Kind::Live });
                if kind == Kind::Series {
                    batch.episodes_changed.push(id);
                }
            }
            Some(old) => {
                if old.hash != row.content_hash() {
                    summary.changed += 1;
                    if old.name_hash != name_hash {
                        batch.search_ids.push(row.id);
                    }
                    let aux_changed = old.aux != row.aux_hash(kind);
                    if kind == Kind::Series && aux_changed {
                        batch.episodes_changed.push(row.id);
                    }
                    batch.ops.push(Op::Upsert { row, sort, relink_guide: kind == Kind::Live && aux_changed });
                } else if old.sort != sort {
                    summary.moved += 1;
                    batch.ops.push(Op::Move { id: row.id, sort });
                } else {
                    return Ok(());
                }
            }
        }
        if batch.is_full() {
            batch.flush(conn, should_stop)?;
            wrote = true;
            // Le fournisseur peut changer pendant une longue liste (reconnexion à une autre source)
            check_provider(conn, host)?;
        }
        Ok(())
    })?;

    // ---- Disparus : renumérotés (supprimés) ou perdus (garde-fou en automatique) ----
    let mut renumbered: Vec<i64> = Vec::new();
    let mut lost: Vec<i64> = Vec::new();
    for (id, old) in snapshot.rows.iter() {
        let still_offered = (old.tmdb > 0 && received_tmdb.contains(&old.tmdb)) || received_names.contains(&old.name_hash);
        if still_offered {
            renumbered.push(*id);
        } else {
            lost.push(*id);
        }
    }
    if mode == Mode::Auto && !lost.is_empty() && lost.len() as f64 > existing_count as f64 * MAX_LOST_RATIO_AUTO {
        log::warn!(
            "[CatalogRefresh] {}: {} of {} titles gone without replacement, kept (manual refresh advised)",
            kind.list_name(),
            lost.len(),
            existing_count
        );
        summary.removal_skipped = true;
        lost.clear();
        if let Err(e) = meta_set(conn, "catalog_manual_advised", "1") {
            log::warn!("[CatalogRefresh] advice note failed: {}", e);
        }
    }
    for id in renumbered.into_iter().chain(lost) {
        summary.removed += 1;
        batch.search_ids.push(id);
        batch.ops.push(Op::Delete { id });
        if batch.is_full() {
            batch.flush(conn, should_stop)?;
            wrote = true;
        }
    }
    if !batch.ops.is_empty() {
        batch.flush(conn, should_stop)?;
        wrote = true;
    }

    summary.outcome = if wrote { Outcome::Applied } else { Outcome::Unchanged };
    Ok(summary)
}

// =============================================================================
// CATÉGORIES
// =============================================================================

type CategoryTable = HashMap<String, (String, String, i64)>;

/// Compare le résultat que produirait l'écriture complète (trois listes fusionnées, la dernière
/// gagne par numéro : la table n'a que le numéro pour clé) à la table actuelle. S'il diffère, les
/// trois types sont réécrits dans une transaction, dans l'ordre de l'écriture complète. `None` =
/// téléchargement en échec, liste vide = type gardé (garde-fou actuel).
pub fn apply_categories(
    conn: &mut Connection,
    host: &str,
    vod: &[XtreamCategory],
    series: &[XtreamCategory],
    live: &[XtreamCategory],
    should_stop: &dyn Fn() -> Option<Stop>,
) -> Result<ListSummary, ApplyError> {
    let mut summary = ListSummary::new("categories");
    if let Some(stop) = should_stop() {
        return Err(stop.into());
    }
    check_provider(conn, host)?;

    let mut current: CategoryTable = HashMap::new();
    {
        let mut stmt = conn
            .prepare("SELECT id, name, type, sort_order FROM categories")
            .map_err(|e| db_error("read categories", e))?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    sql_text(r.get::<_, SqlValue>(0)?).unwrap_or_default(),
                    sql_text(r.get::<_, SqlValue>(1)?).unwrap_or_default(),
                    sql_text(r.get::<_, SqlValue>(2)?).unwrap_or_default(),
                    sql_i64(r.get::<_, SqlValue>(3)?).unwrap_or(0),
                ))
            })
            .map_err(|e| db_error("read categories", e))?;
        for (id, name, kind, sort) in rows.flatten() {
            current.insert(id, (name, kind, sort));
        }
    }

    let lists: [(&str, &[XtreamCategory]); 3] = [("movie", vod), ("series", series), ("live", live)];
    let mut next = current.clone();
    next.retain(|_, (_, kind, _)| lists.iter().all(|(k, l)| l.is_empty() || kind.as_str() != *k));
    for (kind, list) in lists {
        for (index, cat) in list.iter().enumerate() {
            next.insert(normalize_category_id(&cat.category_id), (cat.category_name.clone(), kind.to_string(), index as i64));
        }
    }
    if next == current {
        summary.outcome = if lists.iter().all(|(_, l)| l.is_empty()) { Outcome::Kept } else { Outcome::Unchanged };
        return Ok(summary);
    }

    // Chaînes dont la catégorie est apparue, disparue ou renommée : la liaison au guide lit ce nom
    let live_names = |t: &CategoryTable| -> HashMap<String, String> {
        t.iter().filter(|(_, (_, k, _))| k == "live").map(|(id, (n, _, _))| (id.clone(), n.clone())).collect()
    };
    let (old_live, new_live) = (live_names(&current), live_names(&next));
    let mut relink: Vec<&String> = old_live.keys().filter(|id| new_live.get(*id) != old_live.get(*id)).collect();
    relink.extend(new_live.keys().filter(|id| !old_live.contains_key(*id)));

    let tx = conn.transaction().map_err(|e| db_error("begin", e))?;
    for (kind, list) in lists {
        if !list.is_empty() {
            tx.execute("DELETE FROM categories WHERE type = ?1", params![kind])
                .map_err(|e| db_error("clear categories", e))?;
        }
    }
    insert_categories(&tx, vod, series, live).map_err(ApplyError::Failed)?;
    for id in relink {
        tx.execute(
            "UPDATE live SET matched_epg_id = NULL, match_method = ?2 WHERE category_id = ?1",
            params![id, crate::epg_parser::PENDING_LINK],
        )
        .map_err(|e| db_error("note guide links", e))?;
    }
    meta_increment(&tx, "catalog_changes_seq").map_err(|e| db_error("note changes", e))?;
    tx.commit().map_err(|e| db_error("commit", e))?;

    summary.changed = next.iter().filter(|(id, v)| current.get(*id) != Some(v)).count();
    summary.removed = current.keys().filter(|id| !next.contains_key(*id)).count();
    summary.outcome = Outcome::Applied;
    Ok(summary)
}

// =============================================================================
// DERNIÈRE ÉTAPE : REPRISES DE LECTURE ET LIENS DU GUIDE
// =============================================================================

/// Reprises de films dont le numéro n'existe plus : re-liées au film présent avec le même
/// identifiant TMDB (plusieurs versions : la dernière dans l'ordre d'affichage, comme
/// `moviesByTmdb` côté page). Jamais de suppression ici : sans remplaçant, la reprise attend
/// (elle peut revenir, et le cloud ne doit pas perdre une reprise valable pour un autre appareil).
/// Traite toutes les orphelines, pas seulement celles de ce passage (reprise redescendue du cloud
/// avec un ancien numéro, par exemple).
pub fn relink_orphan_progress(conn: &mut Connection) -> Vec<ProgressRelink> {
    let mut relinks = Vec::new();
    let orphans: Vec<(i64, i64, i64, i64)> = match conn.prepare(
        "SELECT id, stream_id, tmdb_id, updated_at FROM playback_progress
         WHERE content_type = 'movie' AND tmdb_id > 0 AND stream_id NOT IN (SELECT id FROM movies)",
    ) {
        Ok(mut stmt) => stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .map(|rows| rows.flatten().collect())
            .unwrap_or_default(),
        // Table de la page absente : rien à faire
        Err(_) => return relinks,
    };
    if orphans.is_empty() {
        return relinks;
    }
    let tx = match conn.transaction() {
        Ok(tx) => tx,
        Err(_) => return relinks,
    };
    for (row_id, old_id, tmdb, updated_at) in orphans {
        let target: Option<(i64, Option<String>)> = tx
            .query_row(
                "SELECT id, container_extension FROM movies WHERE tmdb_id = ?1 ORDER BY sort_order DESC, id DESC LIMIT 1",
                params![tmdb],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .unwrap_or(None);
        let Some((new_id, ext)) = target else { continue };
        let taken: Option<(i64, String, i64)> = tx
            .query_row(
                "SELECT id, content_type, updated_at FROM playback_progress WHERE stream_id = ?1",
                params![new_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()
            .unwrap_or(None);
        let done = match taken {
            None => tx
                .execute(
                    "UPDATE playback_progress SET stream_id = ?2, container_extension = ?3 WHERE id = ?1",
                    params![row_id, new_id, ext],
                )
                .is_ok(),
            // Un épisode occupe ce numéro (contrainte commune aux films et épisodes) : on ne touche à rien
            Some((_, kind, _)) if kind != "movie" => false,
            // Déjà une reprise pour le nouveau numéro : la plus récente gagne
            Some((other_id, _, other_updated)) if updated_at > other_updated => {
                tx.execute("DELETE FROM playback_progress WHERE id = ?1", params![other_id]).is_ok()
                    && tx
                        .execute(
                            "UPDATE playback_progress SET stream_id = ?2, container_extension = ?3 WHERE id = ?1",
                            params![row_id, new_id, ext],
                        )
                        .is_ok()
            }
            Some(_) => tx.execute("DELETE FROM playback_progress WHERE id = ?1", params![row_id]).is_ok(),
        };
        if done {
            relinks.push(ProgressRelink { from: old_id, to: new_id });
        }
    }
    if tx.commit().is_err() {
        return Vec::new();
    }
    relinks
}

/// Chaînes notées « à relier » (ce passage ou un passage interrompu) : liaison au guide, puis
/// rechargement du guide seulement s'il manque beaucoup de programmes.
pub fn link_pending_channels(conn: &Connection, now_ms: i64) -> usize {
    let pending: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM live WHERE match_method = ?1",
            params![crate::epg_parser::PENDING_LINK],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if pending == 0 {
        return 0;
    }
    let linked = crate::epg_parser::map_pending_live_channels(conn);
    if linked > 0 {
        crate::epg_parser::flag_guide_if_many_links_lack_programs(conn, now_ms, GUIDE_RELOAD_MIN_MISSING, GUIDE_RELOAD_MAX_AGE_MS);
    }
    // Liens écrits après les paquets : la page doit relire les chaînes, même si ce passage n'a
    // rien écrit d'autre (marques laissées par un passage arrêté avant sa dernière étape)
    if let Err(e) = meta_increment(conn, "catalog_changes_seq") {
        log::warn!("[CatalogRefresh] changes counter not updated ({})", e);
    }
    linked
}

// =============================================================================
// ARRÊT
// =============================================================================

/// Numéro de passage le plus grand dont l'arrêt a été demandé. Un arrêt demandé avant même le
/// démarrage de la commande est donc retenu (le planificateur donne des numéros croissants).
static ABORT_UP_TO: AtomicU64 = AtomicU64::new(0);
static RUNNING: AtomicBool = AtomicBool::new(false);

fn abort_notify() -> &'static Notify {
    static NOTIFY: OnceLock<Notify> = OnceLock::new();
    NOTIFY.get_or_init(Notify::new)
}

fn stop_reason(run_id: u64) -> Option<Stop> {
    if run_id <= ABORT_UP_TO.load(Ordering::SeqCst) {
        Some(Stop::Aborted)
    } else if crate::db_activity::heavy_write_in_progress() {
        Some(Stop::Busy)
    } else {
        None
    }
}

/// Se résout dès qu'un arrêt est demandé pour ce passage (ou qu'une écriture lourde commence)
async fn wait_for_stop(run_id: u64) -> Stop {
    loop {
        let notified = abort_notify().notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        if let Some(stop) = stop_reason(run_id) {
            return stop;
        }
        tokio::select! {
            _ = notified => {}
            _ = tokio::time::sleep(std::time::Duration::from_secs(1)) => {}
        }
    }
}

#[tauri::command]
pub fn abort_catalog_refresh(run_id: u64) {
    ABORT_UP_TO.fetch_max(run_id, Ordering::SeqCst);
    abort_notify().notify_waiters();
}

struct RunningGuard;

impl Drop for RunningGuard {
    fn drop(&mut self) {
        RUNNING.store(false, Ordering::SeqCst);
    }
}

// =============================================================================
// TÉLÉCHARGEMENT
// =============================================================================

enum FetchError {
    RateLimited(Option<u64>),
    Stopped(Stop),
    Failed(String),
}

/// Télécharge une liste dans un fichier, telle quelle (compressée si le fournisseur compresse).
/// Un seul nouvel essai après 5 s ; 429/458 = on arrête tout.
async fn download(client: &reqwest::Client, url: &str, path: &Path, run_id: u64) -> Result<u64, FetchError> {
    let mut last_error = String::new();
    for attempt in 0..2 {
        if attempt > 0 {
            tokio::select! {
                stop = wait_for_stop(run_id) => return Err(FetchError::Stopped(stop)),
                _ = tokio::time::sleep(std::time::Duration::from_secs(5)) => {}
            }
        }
        let request = client.get(url).header("Accept-Encoding", "gzip").send();
        let response = tokio::select! {
            stop = wait_for_stop(run_id) => return Err(FetchError::Stopped(stop)),
            r = request => r,
        };
        let mut response = match response {
            // without_url() : le message de reqwest contient sinon l'adresse, identifiants compris
            Err(e) => {
                last_error = format!("request failed: {}", e.without_url());
                continue;
            }
            Ok(r) => r,
        };
        let status = response.status().as_u16();
        if status == 429 || status == 458 {
            let retry_after = response
                .headers()
                .get("Retry-After")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.trim().parse::<u64>().ok());
            return Err(FetchError::RateLimited(retry_after));
        }
        if !response.status().is_success() {
            last_error = format!("HTTP {}", status);
            continue;
        }
        let mut file = match tokio::fs::File::create(path).await {
            Ok(f) => f,
            Err(e) => return Err(FetchError::Failed(format!("temp file: {}", e.kind()))),
        };
        let mut bytes: u64 = 0;
        let complete = loop {
            let chunk = tokio::select! {
                stop = wait_for_stop(run_id) => return Err(FetchError::Stopped(stop)),
                c = response.chunk() => c,
            };
            match chunk {
                Ok(Some(data)) => {
                    bytes += data.len() as u64;
                    if bytes > MAX_DOWNLOAD_BYTES {
                        return Err(FetchError::Failed("list too large".to_string()));
                    }
                    if let Err(e) = file.write_all(&data).await {
                        return Err(FetchError::Failed(format!("temp file: {}", e.kind())));
                    }
                }
                Ok(None) => break true,
                Err(e) => {
                    // Coupure en route : pas de fichier partiel analysé
                    last_error = format!("download interrupted: {}", e.without_url());
                    break false;
                }
            }
        };
        if complete {
            if let Err(e) = file.flush().await {
                return Err(FetchError::Failed(format!("temp file: {}", e.kind())));
            }
            return Ok(bytes);
        }
    }
    Err(FetchError::Failed(last_error))
}

async fn fetch_categories(client: &reqwest::Client, url: &str, path: &Path, run_id: u64) -> Result<(Vec<XtreamCategory>, u64), FetchError> {
    let bytes = download(client, url, path, run_id).await?;
    let path = path.to_path_buf();
    let parsed = tokio::task::spawn_blocking(move || -> Result<Vec<XtreamCategory>, String> {
        let reader = GuardedReader {
            inner: open_list_reader(&path)?,
            read: 0,
            limit: MAX_LIST_BYTES,
            next_check: CHECK_EVERY_BYTES,
            should_stop: &move || stop_reason(run_id),
            stopped: std::rc::Rc::new(std::cell::Cell::new(None)),
        };
        // Une catégorie mal formée est écartée au lieu de faire refuser toute la liste
        let list = crate::catalog_parser::read_list_lenient::<XtreamCategory, _>(reader)
            .map(|list| {
                if list.skipped > 0 {
                    log::warn!("[CatalogRefresh] categories: {} unreadable skipped", list.skipped);
                }
                list.items
            })
            .map_err(|e| format!("unreadable categories: {}", e));
        let _ = std::fs::remove_file(&path);
        list
    })
    .await
    .map_err(|e| FetchError::Failed(format!("task: {}", e)))?
    .map_err(FetchError::Failed)?;
    Ok((parsed, bytes))
}

// =============================================================================
// COMMANDE
// =============================================================================

fn open_refresh_connection(db_path: &Path) -> Result<Connection, ApplyError> {
    let conn = open_connection(db_path).map_err(ApplyError::Failed)?;
    // Connexion légère : petit cache (8 Mo) au lieu de celui de l'écriture complète
    conn.execute_batch(
        "PRAGMA cache_size = -8000;
         PRAGMA busy_timeout = 5000;
         CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);",
    )
    .map_err(|e| db_error("pragmas", e))?;
    Ok(conn)
}

async fn run_blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, ApplyError> + Send + 'static,
) -> Result<T, ApplyError> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| ApplyError::Failed(format!("task: {}", e)))?
}

fn parse_lists(lists: &Option<Vec<String>>) -> Vec<&'static str> {
    const ALL: [&str; 4] = ["categories", "movies", "series", "live"];
    match lists {
        Some(wanted) if !wanted.is_empty() => ALL.iter().copied().filter(|l| wanted.iter().any(|w| w == l)).collect(),
        _ => ALL.to_vec(),
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Actualise le catalogue par comparaison, en arrière-plan. `run_id` : numéro de passage donné par
/// la page (croissant), pour `abort_catalog_refresh`. `lists` : listes à traiter (toutes par
/// défaut ; les listes en échec la fois précédente sont retentées seules). `mode` : `auto`
/// (défaut) ou `manual`.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn refresh_catalog(
    app: tauri::AppHandle,
    run_id: u64,
    host: String,
    username: String,
    password: String,
    db_name: String,
    dns_provider: String,
    lists: Option<Vec<String>>,
    mode: Option<String>,
) -> Result<RefreshSummary, String> {
    validate_db_name(&db_name)?;
    let start = std::time::Instant::now();
    let mut summary = RefreshSummary::default();

    if RUNNING.swap(true, Ordering::SeqCst) {
        summary.status = "busy".to_string();
        return Ok(summary);
    }
    let _running = RunningGuard;

    let mode = if mode.as_deref() == Some("manual") { Mode::Manual } else { Mode::Auto };
    let selected = parse_lists(&lists);
    let db_path = get_data_dir(&app).join(&db_name);
    let tmp_dir: PathBuf = app
        .path()
        .app_cache_dir()
        .map_err(|_| "cache dir unavailable".to_string())?
        .join("catalog_refresh");
    // Restes d'un arrêt brutal (Android tue parfois l'app en arrière-plan)
    let _ = std::fs::remove_dir_all(&tmp_dir);
    std::fs::create_dir_all(&tmp_dir).map_err(|e| format!("cache dir: {}", e.kind()))?;

    let encoded_user: String = form_urlencoded::byte_serialize(username.as_bytes()).collect();
    let encoded_pass: String = form_urlencoded::byte_serialize(password.as_bytes()).collect();
    let base_url = format!(
        "{}/player_api.php?username={}&password={}",
        host.trim_end_matches('/'),
        encoded_user,
        encoded_pass
    );
    let client = crate::http::build_http_client(&dns_provider, 10, 600)?;
    log::info!("[CatalogRefresh] Start (run {}, lists {:?})", run_id, selected);

    // Arrêt demandé, écriture lourde ou autre fournisseur : on ne commence même pas
    let mut stopped: Option<Stop> = stop_reason(run_id);
    if stopped.is_none() {
        let (path, host2) = (db_path.clone(), host.clone());
        match run_blocking(move || {
            let conn = open_refresh_connection(&path)?;
            check_provider(&conn, &host2)
        })
        .await
        {
            Ok(()) => {}
            Err(ApplyError::Stopped(s)) => stopped = Some(s),
            Err(ApplyError::Failed(e)) => return Err(e),
        }
    }

    let mut rate_limited: Option<Option<u64>> = None;
    for list in selected.iter().copied() {
        if stopped.is_some() || rate_limited.is_some() {
            break;
        }
        let outcome: Result<ListSummary, FetchError> = if list == "categories" {
            let mut fetched: Vec<Vec<XtreamCategory>> = Vec::new();
            let mut error: Option<FetchError> = None;
            for action in ["get_vod_categories", "get_series_categories", "get_live_categories"] {
                let url = format!("{}&action={}", base_url, action);
                match fetch_categories(&client, &url, &tmp_dir.join("categories.json"), run_id).await {
                    Ok((cats, bytes)) => {
                        summary.bytes_downloaded += bytes;
                        fetched.push(cats);
                    }
                    Err(e) => {
                        error = Some(e);
                        break;
                    }
                }
            }
            match error {
                Some(e) => Err(e),
                None => {
                    let (path, host2) = (db_path.clone(), host.clone());
                    run_blocking(move || {
                        let mut conn = open_refresh_connection(&path)?;
                        apply_categories(&mut conn, &host2, &fetched[0], &fetched[1], &fetched[2], &move || stop_reason(run_id))
                    })
                    .await
                    .map_err(|e| match e {
                        ApplyError::Stopped(s) => FetchError::Stopped(s),
                        ApplyError::Failed(msg) => FetchError::Failed(msg),
                    })
                }
            }
        } else {
            let kind = match list {
                "movies" => Kind::Movies,
                "series" => Kind::Series,
                _ => Kind::Live,
            };
            let file = tmp_dir.join(format!("{}.json", list));
            let url = format!("{}&action={}", base_url, kind.action());
            match download(&client, &url, &file, run_id).await {
                Err(e) => Err(e),
                Ok(bytes) => {
                    summary.bytes_downloaded += bytes;
                    let (path, host2, file2) = (db_path.clone(), host.clone(), file.clone());
                    let result = run_blocking(move || {
                        let mut conn = open_refresh_connection(&path)?;
                        apply_list_file(&mut conn, kind, &file2, mode, &host2, &move || stop_reason(run_id))
                    })
                    .await;
                    let _ = std::fs::remove_file(&file);
                    result.map_err(|e| match e {
                        ApplyError::Stopped(s) => FetchError::Stopped(s),
                        ApplyError::Failed(msg) => FetchError::Failed(msg),
                    })
                }
            }
        };
        match outcome {
            Ok(list_summary) => {
                log::info!(
                    "[CatalogRefresh] {}: {:?} (+{} ~{} ↕{} -{}, {} new, {} unreadable{})",
                    list,
                    list_summary.outcome,
                    list_summary.added,
                    list_summary.changed,
                    list_summary.moved,
                    list_summary.removed,
                    list_summary.new_items,
                    list_summary.skipped_items,
                    if list_summary.removal_skipped { ", removals kept" } else { "" }
                );
                summary.lists.push(list_summary);
            }
            Err(FetchError::Stopped(s)) => stopped = Some(s),
            Err(FetchError::RateLimited(after)) => rate_limited = Some(after),
            Err(FetchError::Failed(msg)) => {
                log::warn!("[CatalogRefresh] {}: failed ({})", list, msg);
                let mut failed = ListSummary::new(list);
                failed.outcome = Outcome::Failed;
                summary.lists.push(failed);
                summary.failed_lists.push(list.to_string());
            }
        }
    }
    let _ = std::fs::remove_dir_all(&tmp_dir);

    // Dernière étape, seulement si le passage n'a pas été arrêté : reprises et liens du guide
    if stopped.is_none() && rate_limited.is_none() {
        let path = db_path.clone();
        let final_step = run_blocking(move || {
            if let Some(stop) = stop_reason(run_id) {
                return Err(stop.into());
            }
            let mut conn = open_refresh_connection(&path)?;
            let relinks = relink_orphan_progress(&mut conn);
            // Une vidéo qui démarre ici n'attend pas la liaison au guide (refaite au passage suivant)
            let linked = if stop_reason(run_id).is_some() { 0 } else { link_pending_channels(&conn, now_ms()) };
            // Vidage « au mieux » du journal de la base, sans bloquer les autres connexions
            let _ = conn.execute_batch("PRAGMA wal_checkpoint(PASSIVE);");
            Ok((relinks, linked))
        })
        .await;
        match final_step {
            Ok((relinks, linked)) => {
                summary.progress_relinks = relinks;
                summary.epg_relinked = linked;
            }
            Err(ApplyError::Stopped(s)) => stopped = Some(s),
            Err(ApplyError::Failed(e)) => log::warn!("[CatalogRefresh] final step failed ({})", e),
        }
    }

    let attempted = summary.lists.len();
    summary.status = if let Some(stop) = stopped {
        match stop {
            Stop::Busy => "busy".to_string(),
            Stop::Aborted => {
                summary.stop_reason = Some("page".to_string());
                "aborted".to_string()
            }
            Stop::ProviderChanged => {
                summary.stop_reason = Some("provider_changed".to_string());
                "aborted".to_string()
            }
        }
    } else if let Some(after) = rate_limited {
        summary.retry_after_sec = after;
        "rate_limited".to_string()
    } else if !summary.failed_lists.is_empty() {
        if summary.failed_lists.len() == attempted { "failed" } else { "partial" }.to_string()
    } else if summary.lists.iter().any(|l| l.outcome == Outcome::Applied) {
        "done".to_string()
    } else {
        "unchanged".to_string()
    };
    summary.duration_ms = start.elapsed().as_millis() as u64;
    log::info!(
        "[CatalogRefresh] End: {} in {} ms, {} bytes, {} progress relinked, {} channels linked",
        summary.status,
        summary.duration_ms,
        summary.bytes_downloaded,
        summary.progress_relinks.len(),
        summary.epg_relinked
    );
    Ok(summary)
}

// =============================================================================
// TESTS
// =============================================================================

#[cfg(test)]
#[path = "catalog_refresh_tests.rs"]
mod tests;
