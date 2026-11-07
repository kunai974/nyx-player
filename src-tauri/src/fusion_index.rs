//! Index commun à toutes les sources d'un espace (`nyxidx_<espace>.db`) : un film, une série ou une
//! chaîne n'y a qu'une ligne, avec derrière elle toutes ses offres (une par source et par version).
//!
//! Il ne contient que des données **dérivées** des fichiers des sources (`nyxcat_<espace>_<source>.db`) :
//! abîmé, ou après un changement des règles de regroupement (`fusion_rules.rs`), on le reconstruit
//! sans rien télécharger et sans toucher aux données perso.
//!
//! Construction complète, dans un fichier provisoire mis en place par renommage : la page ne voit
//! jamais un index à moitié fait. Les sources sont lues dans l'ordre de priorité ; la première qui
//! propose un titre donne son nom et son affiche. Une construction peut être arrêtée (lecture d'une
//! vidéo) : le fichier provisoire est alors effacé et l'index précédent reste en place.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use rusqlite::{params, Connection, OpenFlags};
use serde::{Deserialize, Serialize};

use crate::fusion_rules::{category_key, channel_clean_name, channel_group_key, title_group_key, title_parts};
use crate::storage::{
    catalog_deletion_pending, get_data_dir, sanitize_error_path, validate_index_db_name, validate_source_catalog_name,
    INDEX_BUILD_TMP_SUFFIX,
};

/// Version des règles et du schéma : un index d'une autre version est reconstruit
pub const INDEX_VERSION: &str = "2";

/// Lignes lues entre deux vérifications de l'arrêt demandé
const CHECK_EVERY_ROWS: usize = 2_000;

static ABORT: AtomicBool = AtomicBool::new(false);
static RUNNING: AtomicBool = AtomicBool::new(false);
/// Effacements d'index en cours (réinitialisation d'un espace) : aucune construction ne démarre
/// ni ne se met en place pendant ce temps
static HELD: AtomicUsize = AtomicUsize::new(0);

/// Sources au plus dans une construction (bien au-delà de la limite par appareil)
const MAX_SOURCES: usize = 16;

const SCHEMA: &str = "
    CREATE TABLE titles (
        id INTEGER PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('movie', 'series')),
        group_key TEXT NOT NULL,
        name TEXT NOT NULL,
        year INTEGER,
        tmdb_id INTEGER,
        icon TEXT,
        added INTEGER,
        rating REAL,
        offer_count INTEGER NOT NULL DEFAULT 0,
        UNIQUE (kind, group_key)
    );
    CREATE TABLE offers (
        title_id INTEGER NOT NULL,
        kind TEXT NOT NULL,
        source_id TEXT NOT NULL,
        source_rank INTEGER NOT NULL,
        stream_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        quality TEXT,
        language TEXT,
        container_extension TEXT,
        category_key TEXT,
        PRIMARY KEY (source_id, kind, stream_id)
    );
    CREATE TABLE channels (
        id INTEGER PRIMARY KEY,
        group_key TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        icon TEXT,
        epg_id TEXT,
        stream_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE channel_streams (
        channel_id INTEGER NOT NULL,
        source_id TEXT NOT NULL,
        source_rank INTEGER NOT NULL,
        stream_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        quality TEXT,
        category_key TEXT,
        PRIMARY KEY (source_id, stream_id)
    );
    CREATE TABLE categories (
        type TEXT NOT NULL,
        key TEXT NOT NULL,
        name TEXT NOT NULL,
        source_rank INTEGER NOT NULL,
        sort_order INTEGER NOT NULL,
        part_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (type, key)
    );
    CREATE TABLE category_parts (
        type TEXT NOT NULL,
        key TEXT NOT NULL,
        source_id TEXT NOT NULL,
        category_id TEXT NOT NULL,
        PRIMARY KEY (type, source_id, category_id)
    );
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
";

/// Index posés après le remplissage (plus rapide qu'à chaque insertion)
const INDEXES: &str = "
    CREATE INDEX idx_titles_kind_added ON titles(kind, added);
    CREATE INDEX idx_titles_tmdb ON titles(tmdb_id);
    CREATE INDEX idx_offers_title ON offers(title_id, source_rank);
    CREATE INDEX idx_offers_category ON offers(kind, category_key);
    CREATE INDEX idx_streams_channel ON channel_streams(channel_id, source_rank);
    CREATE INDEX idx_streams_category ON channel_streams(category_key);
";

/// Une source, dans l'ordre de priorité : son identifiant et son fichier catalogue
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexSource {
    pub id: String,
    pub file: String,
}

#[derive(Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IndexReport {
    /// `built`, `stopped` (arrêt demandé) ou `busy` (une construction tourne déjà)
    pub status: String,
    pub titles: i64,
    pub offers: i64,
    pub channels: i64,
    pub streams: i64,
    pub categories: i64,
    /// Sources dont le fichier manque (pas encore chargées) : absentes de l'index
    pub missing_sources: Vec<String>,
    /// Sources dont le fichier est illisible (abîmé) : absentes de l'index
    pub failed_sources: Vec<String>,
}

#[derive(Debug)]
enum BuildError {
    Stopped,
    /// Lecture d'une source impossible (fichier abîmé) : cette source seule est laissée de côté
    Source,
    /// Écriture de l'index impossible (disque plein…) : toute la construction échoue
    Failed(String),
}

impl From<String> for BuildError {
    fn from(e: String) -> Self {
        BuildError::Failed(e)
    }
}

fn db_error(step: &str, e: rusqlite::Error) -> BuildError {
    BuildError::Failed(sanitize_error_path(format!("Fusion index ({}): {}", step, e)))
}

fn temp_path(target: &Path) -> PathBuf {
    let mut name = target.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    name.push(INDEX_BUILD_TMP_SUFFIX);
    target.with_file_name(name)
}

/// Efface une base et ses fichiers compagnons, le journal WAL d'abord : un journal resté seul à
/// côté d'un nouvel index y serait rejoué et l'abîmerait.
fn remove_quietly(path: &Path) {
    for suffix in ["-wal", "-shm", "-journal", ""] {
        let mut name = path.as_os_str().to_os_string();
        name.push(suffix);
        let file = PathBuf::from(name);
        if file.exists() {
            let _ = fs::remove_file(file);
        }
    }
}

fn table_has(conn: &Connection, table: &str, column: &str) -> bool {
    conn.prepare(&format!("SELECT {column} FROM {table} LIMIT 0")).is_ok()
}

/// Colonne lue si elle existe dans ce fichier, sinon NULL (fichier d'une version plus ancienne)
fn col(conn: &Connection, table: &str, column: &str) -> String {
    if table_has(conn, table, column) { column.to_string() } else { "NULL".to_string() }
}

struct Builder<'a> {
    out: &'a Connection,
    should_stop: &'a dyn Fn() -> bool,
    read: usize,
}

impl Builder<'_> {
    fn tick(&mut self) -> Result<(), BuildError> {
        self.read += 1;
        if self.read.is_multiple_of(CHECK_EVERY_ROWS) && (self.should_stop)() {
            return Err(BuildError::Stopped);
        }
        Ok(())
    }

    /// Lit une source entière. Lecture seule, sans jamais créer le fichier, dans une seule
    /// transaction de lecture : une actualisation qui écrit en même temps n'est pas vue à moitié.
    fn add_source(&mut self, path: &Path, source: &IndexSource, rank: i64) -> Result<(), BuildError> {
        let src = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)
            .map_err(|_| BuildError::Source)?;
        src.execute_batch("BEGIN").map_err(|_| BuildError::Source)?;
        // Un fichier qui n'est pas une base lisible échoue ici, et pas en silence plus loin
        src.query_row("SELECT COUNT(*) FROM sqlite_master", [], |r| r.get::<_, i64>(0))
            .map_err(|_| BuildError::Source)?;
        let categories = self.categories(&src, source, rank)?;
        self.titles(&src, source, rank, "movie", &categories)?;
        self.titles(&src, source, rank, "series", &categories)?;
        self.channels(&src, source, rank, &categories)
    }

    /// Catégories d'une source : réunies par nom nettoyé, pour le même type. Renvoie, par type, le
    /// lien numéro de catégorie de la source → clé réunie.
    fn categories(&mut self, src: &Connection, source: &IndexSource, rank: i64) -> Result<HashMap<(String, String), String>, BuildError> {
        let mut map = HashMap::new();
        if !table_has(src, "categories", "id") {
            return Ok(map);
        }
        let sort = col(src, "categories", "sort_order");
        let mut stmt = src
            .prepare(&format!("SELECT id, name, type, COALESCE({sort}, 0) FROM categories ORDER BY {sort}, rowid"))
            .map_err(|_| BuildError::Source)?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, i64>(3)?)))
            .map_err(|_| BuildError::Source)?;
        for row in rows {
            let (id, name, kind, sort_order) = row.map_err(|_| BuildError::Source)?;
            self.tick()?;
            let Some(key) = category_key(&name) else { continue };
            self.out
                .execute(
                    "INSERT INTO categories (type, key, name, source_rank, sort_order, part_count) VALUES (?1, ?2, ?3, ?4, ?5, 1)
                     ON CONFLICT(type, key) DO UPDATE SET part_count = part_count + 1",
                    params![kind, key, name, rank, sort_order],
                )
                .map_err(|e| db_error("write categories", e))?;
            self.out
                .execute(
                    "INSERT OR IGNORE INTO category_parts (type, key, source_id, category_id) VALUES (?1, ?2, ?3, ?4)",
                    params![kind, key, source.id, id],
                )
                .map_err(|e| db_error("write categories", e))?;
            map.insert((kind, id), key);
        }
        Ok(map)
    }

    fn titles(
        &mut self,
        src: &Connection,
        source: &IndexSource,
        rank: i64,
        kind: &str,
        categories: &HashMap<(String, String), String>,
    ) -> Result<(), BuildError> {
        let table = if kind == "movie" { "movies" } else { "series" };
        if !table_has(src, table, "id") {
            return Ok(());
        }
        let ext = if kind == "movie" { col(src, table, "container_extension") } else { "NULL".to_string() };
        let order = col(src, table, "sort_order");
        let sql = format!(
            "SELECT id, {tmdb}, name, {icon}, {cat}, {added}, {rating}, {ext} FROM {table} ORDER BY {order}, id",
            tmdb = col(src, table, "tmdb_id"),
            icon = col(src, table, "icon"),
            cat = col(src, table, "category_id"),
            added = col(src, table, "added"),
            rating = col(src, table, "rating"),
        );
        let mut stmt = src.prepare(&sql).map_err(|_| BuildError::Source)?;
        let mut rows = stmt.query([]).map_err(|_| BuildError::Source)?;
        let mut upsert = self
            .out
            .prepare_cached(
                "INSERT INTO titles (kind, group_key, name, year, tmdb_id, icon, added, rating, offer_count)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1)
                 ON CONFLICT(kind, group_key) DO UPDATE SET
                    offer_count = offer_count + 1,
                    icon = COALESCE(icon, excluded.icon),
                    year = COALESCE(year, excluded.year),
                    tmdb_id = COALESCE(tmdb_id, excluded.tmdb_id),
                    rating = COALESCE(rating, excluded.rating),
                    added = MAX(COALESCE(added, 0), COALESCE(excluded.added, 0))
                 RETURNING id",
            )
            .map_err(|e| db_error("write titles", e))?;
        let mut offer = self
            .out
            .prepare_cached(
                "INSERT OR IGNORE INTO offers (title_id, kind, source_id, source_rank, stream_id, name, quality, language, container_extension, category_key)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            )
            .map_err(|e| db_error("write offers", e))?;
        while let Some(r) = rows.next().map_err(|_| BuildError::Source)? {
            let stream_id: i64 = r.get(0).map_err(|_| BuildError::Source)?;
            let tmdb: Option<i64> = r.get(1).ok().flatten();
            let name: String = r.get(2).map_err(|_| BuildError::Source)?;
            let icon: Option<String> = r.get(3).ok().flatten();
            let category: Option<String> = r.get::<_, Option<String>>(4).ok().flatten();
            let added: Option<i64> = r.get(5).ok().flatten();
            let rating: Option<f64> = r.get(6).ok().flatten();
            let extension: Option<String> = r.get(7).ok().flatten();
            self.tick()?;
            let parts = title_parts(&name);
            // Jamais regroupé : une ligne à part, propre à cette offre
            let group_key = title_group_key(tmdb).unwrap_or_else(|| format!("solo:{}:{stream_id}", source.id));
            let title_id: i64 = upsert
                .query_row(
                    params![kind, group_key, name, parts.year, tmdb.filter(|t| *t > 0), icon, added, rating],
                    |row| row.get(0),
                )
                .map_err(|e| db_error("write titles", e))?;
            let category_key = category.and_then(|c| categories.get(&(kind.to_string(), c)).cloned());
            offer
                .execute(params![
                    title_id, kind, source.id, rank, stream_id, name, parts.quality, parts.language, extension, category_key
                ])
                .map_err(|e| db_error("write offers", e))?;
        }
        Ok(())
    }

    fn channels(&mut self, src: &Connection, source: &IndexSource, rank: i64, categories: &HashMap<(String, String), String>) -> Result<(), BuildError> {
        if !table_has(src, "live", "id") {
            return Ok(());
        }
        let sql = format!(
            "SELECT id, name, {icon}, {cat}, {epg}, {geo} FROM live ORDER BY {order}, id",
            icon = col(src, "live", "icon"),
            cat = col(src, "live", "category_id"),
            epg = col(src, "live", "epg_channel_id"),
            geo = col(src, "live", "geo_hint"),
            order = col(src, "live", "sort_order"),
        );
        let mut stmt = src.prepare(&sql).map_err(|_| BuildError::Source)?;
        let mut rows = stmt.query([]).map_err(|_| BuildError::Source)?;
        let mut upsert = self
            .out
            .prepare_cached(
                "INSERT INTO channels (group_key, name, icon, epg_id, stream_count) VALUES (?1, ?2, ?3, ?4, 1)
                 ON CONFLICT(group_key) DO UPDATE SET
                    stream_count = stream_count + 1,
                    icon = COALESCE(icon, excluded.icon),
                    epg_id = COALESCE(epg_id, excluded.epg_id)
                 RETURNING id",
            )
            .map_err(|e| db_error("write channels", e))?;
        let mut stream = self
            .out
            .prepare_cached(
                "INSERT OR IGNORE INTO channel_streams (channel_id, source_id, source_rank, stream_id, name, quality, category_key)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            )
            .map_err(|e| db_error("write channels", e))?;
        while let Some(r) = rows.next().map_err(|_| BuildError::Source)? {
            let stream_id: i64 = r.get(0).map_err(|_| BuildError::Source)?;
            let name: String = r.get(1).map_err(|_| BuildError::Source)?;
            let icon: Option<String> = r.get(2).ok().flatten();
            let category: Option<String> = r.get::<_, Option<String>>(3).ok().flatten();
            let epg: Option<String> = r.get::<_, Option<String>>(4).ok().flatten().filter(|e| !e.trim().is_empty());
            let geo: Option<String> = r.get(5).ok().flatten();
            self.tick()?;
            let group_key = channel_group_key(&name, epg.as_deref(), geo.as_deref())
                .unwrap_or_else(|| format!("solo:{}:{stream_id}", source.id));
            let channel_id: i64 = upsert
                .query_row(params![group_key, name, icon, epg], |row| row.get(0))
                .map_err(|e| db_error("write channels", e))?;
            let (_, quality, _) = channel_clean_name(&name);
            let category_key = category.and_then(|c| categories.get(&("live".to_string(), c)).cloned());
            stream
                .execute(params![channel_id, source.id, rank, stream_id, name, quality, category_key])
                .map_err(|e| db_error("write channels", e))?;
        }
        Ok(())
    }
}

fn count(conn: &Connection, table: &str) -> i64 {
    conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0)).unwrap_or(0)
}

/// Construit l'index dans `tmp` à partir des fichiers des sources (dans l'ordre de priorité).
fn build_into(dir: &Path, tmp: &Path, sources: &[IndexSource], should_stop: &dyn Fn() -> bool) -> Result<IndexReport, BuildError> {
    remove_quietly(tmp);
    let mut out = Connection::open(tmp).map_err(|e| db_error("open", e))?;
    out.execute_batch("PRAGMA journal_mode = DELETE; PRAGMA synchronous = NORMAL; PRAGMA cache_size = -8000;")
        .map_err(|e| db_error("pragmas", e))?;
    out.execute_batch(SCHEMA).map_err(|e| db_error("schema", e))?;
    let mut report = IndexReport::default();
    let tx = out.transaction().map_err(|e| db_error("begin", e))?;
    {
        let mut builder = Builder { out: &tx, should_stop, read: 0 };
        for (rank, source) in sources.iter().enumerate() {
            let path = dir.join(&source.file);
            // Pas encore chargée, ou en cours de suppression : absente de l'index
            if !path.exists() || catalog_deletion_pending(&path) {
                report.missing_sources.push(source.id.clone());
                continue;
            }
            // Une source illisible (fichier abîmé) est laissée de côté, sans rien laisser dans l'index
            tx.execute_batch("SAVEPOINT source").map_err(|e| db_error("savepoint", e))?;
            match builder.add_source(&path, source, rank as i64) {
                Ok(()) => tx.execute_batch("RELEASE source").map_err(|e| db_error("savepoint", e))?,
                Err(BuildError::Stopped) => return Err(BuildError::Stopped),
                Err(BuildError::Failed(e)) => return Err(BuildError::Failed(e)),
                Err(BuildError::Source) => {
                    tx.execute_batch("ROLLBACK TO source; RELEASE source").map_err(|e| db_error("savepoint", e))?;
                    log::warn!("[FusionIndex] Une source illisible est laissée hors de l'index");
                    report.failed_sources.push(source.id.clone());
                }
            }
        }
        let sources_json = serde_json::to_string(&sources.iter().map(|s| s.id.as_str()).collect::<Vec<_>>()).unwrap_or_default();
        for (key, value) in [("version", INDEX_VERSION.to_string()), ("sources", sources_json)] {
            tx.execute("INSERT OR REPLACE INTO meta (key, value) VALUES (?1, ?2)", params![key, value])
                .map_err(|e| db_error("meta", e))?;
        }
    }
    tx.commit().map_err(|e| db_error("commit", e))?;
    if should_stop() {
        return Err(BuildError::Stopped);
    }
    out.execute_batch(INDEXES).map_err(|e| db_error("indexes", e))?;
    report.titles = count(&out, "titles");
    report.offers = count(&out, "offers");
    report.channels = count(&out, "channels");
    report.streams = count(&out, "channel_streams");
    report.categories = count(&out, "categories");
    out.close().map_err(|(_, e)| db_error("close", e))?;
    report.status = "built".to_string();
    Ok(report)
}

/// Vérifie les noms : l'index et chaque fichier de source appartiennent au même espace
fn check_names(index_db: &str, sources: &[IndexSource]) -> Result<(), String> {
    validate_index_db_name(index_db)?;
    if sources.len() > MAX_SOURCES {
        return Err("Fusion index: too many sources".to_string());
    }
    let space = &index_db["nyxidx_".len()..index_db.len() - ".db".len()];
    for source in sources {
        validate_source_catalog_name(&source.file)?;
        if source.file != format!("nyxcat_{space}_{}.db", source.id) {
            return Err("Fusion index: a source file does not match its space or its id".to_string());
        }
    }
    let mut ids: Vec<&str> = sources.iter().map(|s| s.id.as_str()).collect();
    ids.sort_unstable();
    ids.dedup();
    if ids.len() != sources.len() {
        return Err("Fusion index: a source is listed twice".to_string());
    }
    Ok(())
}

/// Construit l'index dans son fichier provisoire. `None` : arrêt demandé (le provisoire est effacé).
fn build_to_tmp(dir: &Path, index_db: &str, sources: &[IndexSource], should_stop: &dyn Fn() -> bool) -> Result<Option<IndexReport>, String> {
    check_names(index_db, sources)?;
    let tmp = temp_path(&dir.join(index_db));
    match build_into(dir, &tmp, sources, should_stop) {
        Ok(report) => Ok(Some(report)),
        Err(BuildError::Stopped) => {
            remove_quietly(&tmp);
            Ok(None)
        }
        Err(BuildError::Failed(e)) => {
            remove_quietly(&tmp);
            Err(e)
        }
        Err(BuildError::Source) => {
            remove_quietly(&tmp);
            Err("Fusion index: unreadable source".to_string())
        }
    }
}

/// Met l'index construit à la place de l'ancien. Windows ne renomme pas sur un fichier existant :
/// l'ancien est effacé d'abord ; s'il est encore tenu, il reste en place et le nouveau est jeté.
fn place_index(dir: &Path, index_db: &str) -> Result<(), String> {
    let target = dir.join(index_db);
    let tmp = temp_path(&target);
    remove_quietly(&target);
    let still_there = ["", "-wal", "-shm", "-journal"].iter().any(|suffix| {
        let mut name = target.as_os_str().to_os_string();
        name.push(suffix);
        Path::new(&name).exists()
    });
    if still_there {
        remove_quietly(&tmp);
        return Err("Fusion index: the previous index is still held".to_string());
    }
    fs::rename(&tmp, &target).map_err(|e| sanitize_error_path(format!("Fusion index (rename): {}", e)))?;
    // Effacement d'un ancien index resté en attente : le nouveau ne doit pas tomber avec lui
    let _ = fs::remove_file(dir.join(format!("{index_db}.delete-pending")));
    Ok(())
}

fn stopped() -> IndexReport {
    IndexReport { status: "stopped".to_string(), ..Default::default() }
}

/// Construit l'index `index_db` dans `dir` et le met en place. Arrêté : l'index précédent reste.
#[cfg(test)]
fn build_index(dir: &Path, index_db: &str, sources: &[IndexSource], should_stop: &dyn Fn() -> bool) -> Result<IndexReport, String> {
    let Some(report) = build_to_tmp(dir, index_db, sources, should_stop)? else {
        return Ok(stopped());
    };
    place_index(dir, index_db)?;
    Ok(report)
}

struct RunningGuard;
impl Drop for RunningGuard {
    fn drop(&mut self) {
        RUNNING.store(false, Ordering::SeqCst);
    }
}

/// Commande : (re)construit l'index commun d'un espace à partir de ses sources, données dans
/// l'ordre de priorité. Une seule construction à la fois. La page garde l'ancien index jusqu'au
/// remplacement ; sa connexion à l'index est alors fermée.
#[tauri::command]
pub async fn build_fusion_index(
    app: tauri::AppHandle,
    databases: tauri::State<'_, crate::secure_db::NyxDatabases>,
    index_db_name: String,
    sources: Vec<IndexSource>,
) -> Result<IndexReport, String> {
    check_names(&index_db_name, &sources)?;
    if RUNNING.swap(true, Ordering::SeqCst) {
        return Ok(IndexReport { status: "busy".to_string(), ..Default::default() });
    }
    let _running = RunningGuard;
    // Dans cet ordre : un effacement qui commence en même temps voit la construction (RUNNING) ou
    // est vu par elle (HELD), et sa demande d'arrêt n'est jamais effacée derrière lui
    ABORT.store(false, Ordering::SeqCst);
    if builds_held() {
        return Ok(stopped());
    }
    let dir = get_data_dir(&app);
    let built = {
        let (dir, name) = (dir.clone(), index_db_name.clone());
        tokio::task::spawn_blocking(move || build_to_tmp(&dir, &name, &sources, &|| ABORT.load(Ordering::SeqCst)))
            .await
            .map_err(|_| "Fusion index interrupted".to_string())??
    };
    let Some(report) = built else {
        return Ok(stopped());
    };
    databases.forget(&index_db_name).await;
    // Arrêt demandé pendant la fin (réinitialisation de l'espace) : rien n'est mis en place
    if ABORT.load(Ordering::SeqCst) || builds_held() {
        remove_quietly(&temp_path(&dir.join(&index_db_name)));
        return Ok(stopped());
    }
    place_index(&dir, &index_db_name)?;
    log::info!(
        "[FusionIndex] Index construit : {} titres, {} offres, {} chaînes",
        report.titles, report.offers, report.channels
    );
    Ok(report)
}

/// Commande : arrête la construction en cours (lecture d'une vidéo) ; l'index précédent reste.
#[tauri::command]
pub fn abort_fusion_index() {
    ABORT.store(true, Ordering::SeqCst);
}

fn builds_held() -> bool {
    HELD.load(Ordering::SeqCst) > 0
}

/// Tant qu'il vit, aucune construction ne démarre ni ne met d'index en place
pub struct BuildsHeld;
impl Drop for BuildsHeld {
    fn drop(&mut self) {
        HELD.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Bloque les constructions, arrête celle en cours et attend qu'elle ait rendu la main (5 s au
/// plus) : avant d'effacer l'index d'un espace, pour qu'aucune ne le remette en place derrière.
pub async fn hold_builds() -> BuildsHeld {
    HELD.fetch_add(1, Ordering::SeqCst);
    let held = BuildsHeld;
    ABORT.store(true, Ordering::SeqCst);
    for _ in 0..100 {
        if !RUNNING.load(Ordering::SeqCst) {
            return held;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    log::warn!("[FusionIndex] Construction encore en cours après la demande d'arrêt");
    held
}

#[cfg(test)]
#[path = "fusion_index_tests.rs"]
mod tests;
