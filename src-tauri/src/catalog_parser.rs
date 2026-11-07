//! Catalog Parser Module
//!
//! Parse les réponses JSON de l'API Xtream Codes et insère dans SQLite.
//! Ce module fait partie de la refonte SQLite-First Architecture (Phase 1).
//!
//! ## Usage
//! ```rust,ignore
//! let result = ingest_catalog(app, host, username, password).await?;
//! ```

use rusqlite::{params, Connection, Transaction};
use serde::Deserialize;
use std::path::Path;
use regex::Regex;
use std::sync::OnceLock;

// =============================================================================
// FLEXIBLE DESERIALIZERS
// =============================================================================

/// Valeur simple d'un champ : texte, nombre, booléen ou null, lue comme `serde_json::Value`.
/// Un tableau ou un objet est parcouru sans être construit et donne `None` : lu en `Value`, un
/// tableau de petits morceaux (`[0,0,0…]`) pèserait seize fois sa taille.
fn deserialize_scalar<'de, D>(deserializer: D) -> Result<Option<serde_json::Value>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    deserializer.deserialize_any(ScalarVisitor)
}

struct ScalarVisitor;

impl<'de> serde::de::Visitor<'de> for ScalarVisitor {
    type Value = Option<serde_json::Value>;

    fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str("a JSON value")
    }

    // Mêmes valeurs que `serde_json::Value::deserialize`
    fn visit_bool<E>(self, v: bool) -> Result<Self::Value, E> {
        Ok(Some(serde_json::Value::Bool(v)))
    }
    fn visit_i64<E>(self, v: i64) -> Result<Self::Value, E> {
        Ok(Some(serde_json::Value::Number(v.into())))
    }
    fn visit_u64<E>(self, v: u64) -> Result<Self::Value, E> {
        Ok(Some(serde_json::Value::Number(v.into())))
    }
    fn visit_f64<E>(self, v: f64) -> Result<Self::Value, E> {
        Ok(Some(serde_json::Number::from_f64(v).map_or(serde_json::Value::Null, serde_json::Value::Number)))
    }
    fn visit_str<E>(self, v: &str) -> Result<Self::Value, E> {
        Ok(Some(serde_json::Value::String(v.to_string())))
    }
    fn visit_string<E>(self, v: String) -> Result<Self::Value, E> {
        Ok(Some(serde_json::Value::String(v)))
    }
    fn visit_unit<E>(self) -> Result<Self::Value, E> {
        Ok(Some(serde_json::Value::Null))
    }
    fn visit_none<E>(self) -> Result<Self::Value, E> {
        Ok(Some(serde_json::Value::Null))
    }
    fn visit_some<D: serde::Deserializer<'de>>(self, deserializer: D) -> Result<Self::Value, D::Error> {
        deserialize_scalar(deserializer)
    }
    fn visit_seq<A: serde::de::SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
        while seq.next_element::<serde::de::IgnoredAny>()?.is_some() {}
        Ok(None)
    }
    fn visit_map<A: serde::de::MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        while map.next_entry::<serde::de::IgnoredAny, serde::de::IgnoredAny>()?.is_some() {}
        Ok(None)
    }
}

/// Deserialize stream_id qui peut être String ou Number selon le provider
fn deserialize_stream_id<'de, D>(deserializer: D) -> Result<i64, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde::de::Error;
    match deserialize_scalar(deserializer)? {
        Some(value @ (serde_json::Value::Number(_) | serde_json::Value::String(_))) => {
            id_from_value(&value).ok_or_else(|| D::Error::custom(format!("Cannot parse stream_id: {}", value)))
        }
        _ => Err(D::Error::custom("stream_id must be String or Number")),
    }
}

/// Numéro de flux tiré d'une valeur (nombre ou texte). Un entier écrit en nombre à virgule (`1.0`,
/// `1e3`) est le même numéro ; un vrai nombre à virgule est refusé : on ne devine pas un numéro.
/// Même règle pour la lecture d'un élément et pour l'actualisation (`catalog_refresh.rs`, numéro
/// d'un élément illisible dont la ligne est gardée).
pub fn id_from_value(value: &serde_json::Value) -> Option<i64> {
    let whole = |f: f64| Some(f).filter(|f| f.fract() == 0.0 && f.abs() < 9.0e15).map(|f| f as i64);
    match value {
        serde_json::Value::Number(n) => n.as_i64().or_else(|| n.as_f64().and_then(whole)),
        serde_json::Value::String(s) => {
            let s = s.trim();
            s.parse::<i64>().ok().or_else(|| s.parse::<f64>().ok().filter(|f| f.is_finite()).and_then(whole))
        }
        _ => None,
    }
}

thread_local! {
    /// Vrai si un champ secondaire de forme inattendue a été ignoré depuis la dernière lecture
    /// (`take_odd_field`) : l'actualisation garde alors la ligne en place au lieu d'effacer une bonne
    /// valeur sur un hoquet du fournisseur.
    static ODD_FIELD: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Lit et remet à zéro la marque « champ de forme inattendue ignoré » de ce fil d'exécution.
pub fn take_odd_field() -> bool {
    ODD_FIELD.with(|odd| odd.replace(false))
}

/// Texte facultatif envoyé tantôt en texte, tantôt en nombre selon le fournisseur (`"rating": 7.5`
/// au lieu de `"7.5"`) : un nombre ou un booléen devient son texte, au lieu de rendre l'élément
/// illisible. Un objet ou un tableau reste une erreur : réservé au nom, sans lequel l'élément est
/// vraiment mal formé (une actualisation garde alors la ligne en place au lieu d'effacer son nom).
fn deserialize_opt_text<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde::de::Error;
    match deserialize_scalar(deserializer)? {
        Some(serde_json::Value::Null) => Ok(None),
        Some(serde_json::Value::String(s)) => Ok(Some(s)),
        Some(serde_json::Value::Number(n)) => Ok(Some(n.to_string())),
        Some(serde_json::Value::Bool(b)) => Ok(Some(b.to_string())),
        _ => Err(D::Error::custom("expected a text, a number or null")),
    }
}

/// Champ secondaire (affiche, catégorie, date, note, extension, guide) : même lecture, mais un objet
/// ou un tableau (forme inattendue) est ignoré comme un champ absent, et le titre reste visible.
/// Avant, il était jeté, et au-delà de 1 % de titres jetés toute la liste était refusée.
fn deserialize_opt_extra<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(match deserialize_scalar(deserializer)? {
        Some(serde_json::Value::String(s)) => Some(s),
        Some(serde_json::Value::Number(n)) => Some(n.to_string()),
        Some(serde_json::Value::Bool(b)) => Some(b.to_string()),
        Some(_) => None,
        // tableau ou objet sautés sans être construits
        None => {
            ODD_FIELD.with(|odd| odd.set(true));
            None
        }
    })
}

/// Numéro TMDB ou de catégorie gardé tel quel (texte ou nombre, lu ensuite par `normalize_tmdb` et
/// `normalize_category_id`) ; un tableau ou un objet, qu'elles ignorent, devient null sans être lu.
fn deserialize_loose_id<'de, D>(deserializer: D) -> Result<serde_json::Value, D::Error>
where
    D: serde::Deserializer<'de>,
{
    deserialize_scalar(deserializer).map(Option::unwrap_or_default)
}

/// Même chose pour un champ facultatif (null ou absent = `None`, comme avant).
fn deserialize_opt_loose_id<'de, D>(deserializer: D) -> Result<Option<serde_json::Value>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    deserialize_loose_id(deserializer).map(|v| Some(v).filter(|v| !v.is_null()))
}

/// Nom de catégorie : même tolérance, un nom absent devient vide plutôt que de rendre la catégorie
/// illisible.
fn deserialize_text<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    deserialize_opt_text(deserializer).map(Option::unwrap_or_default)
}

// =============================================================================
// LECTURE TOLÉRANTE D'UNE LISTE
// =============================================================================

/// Part maximale d'éléments illisibles tolérée dans une liste (même règle que l'actualisation
/// automatique) ; au-delà, la liste entière est refusée et la table en place est gardée.
pub const MAX_UNREADABLE_RATIO: f64 = 0.01;

/// Nombre maximal d'éléments d'une liste (lisibles et illisibles), propre à chaque type. Au-delà,
/// la liste est refusée sans rien effacer : sans plafond, une réponse faite de petits éléments
/// (`0,0,0…`) reste sous la borne en octets mais demande bien plus de mémoire une fois lue, et les
/// six listes sont gardées ensemble jusqu'à l'écriture. Un très gros catalogue réel compte environ
/// 183 000 films, 49 000 séries, 58 000 chaînes et quelques milliers de catégories : près de trois
/// fois de marge ou plus, pour un pire cas d'environ 360 Mo pour les six listes faites de petits
/// éléments (au-delà, c'est la borne en octets du téléchargement qui limite).
pub trait ListItem: serde::de::DeserializeOwned {
    const MAX_ITEMS: usize;
}

impl ListItem for XtreamMovie {
    const MAX_ITEMS: usize = 500_000;
}

impl ListItem for XtreamSeries {
    const MAX_ITEMS: usize = 200_000;
}

impl ListItem for XtreamLive {
    const MAX_ITEMS: usize = 200_000;
}

impl ListItem for XtreamCategory {
    const MAX_ITEMS: usize = 50_000;
}

/// Taille maximale d'un élément (en octets de JSON). Un élément réel fait moins de quelques Ko ; un
/// élément plus gros est compté illisible et jeté sans être lu, car un JSON fait de petits morceaux
/// (`[0,0,0…]`) pèse une trentaine de fois sa taille une fois lu en valeur générique.
pub const MAX_ITEM_BYTES: usize = 1024 * 1024;

/// Élément d'une liste lu à part : `None` s'il est mal formé ou démesuré, sans faire
/// échouer la liste. L'élément est d'abord gardé tel quel (son texte JSON), puis lu dans son type.
pub fn read_item<T: serde::de::DeserializeOwned>(raw: &serde_json::value::RawValue) -> Option<T> {
    serde_json::from_str(item_text(raw)?).ok()
}

/// Texte JSON d'un élément, ou `None` s'il dépasse `MAX_ITEM_BYTES` (jamais lu) ou n'est pas un
/// objet (un tableau comme `[5]` serait sinon lu par position).
pub fn item_text(raw: &serde_json::value::RawValue) -> Option<&str> {
    Some(raw.get()).filter(|text| text.len() <= MAX_ITEM_BYTES && text.starts_with('{'))
}

/// Longueur maximale des avertissements PHP cherchés avant une liste (quelques lignes en vrai).
pub const MAX_PHP_NOTICE_BYTES: usize = 64 * 1024;

/// Longueur des avertissements PHP placés avant le JSON par de vieux panneaux
/// (`<br /><b>Deprecated</b>: … <br />[{…}]`), 0 s'il n'y en a pas. Une vraie page web (Cloudflare,
/// maintenance) n'est jamais sautée : son début contient `<html`, `<body`, `<!doctype`… Même règle
/// que la page (`xtreamApi.ts`, `jsonAfterPhpNotice`).
pub fn php_notice_len(prefix: &[u8]) -> usize {
    let window = &prefix[..prefix.len().min(MAX_PHP_NOTICE_BYTES)];
    let Some(first) = window.iter().position(|b| !b.is_ascii_whitespace()) else { return 0 };
    if window[first] != b'<' {
        return 0;
    }
    let start = window.windows(2).enumerate().find_map(|(i, w)| {
        if w[0] != b'[' && w[0] != b'{' {
            return None;
        }
        // Premier caractère utile après `[` ou `{` : début d'un élément, d'une clé, ou liste vide
        let next = window[i + 1..].iter().find(|b| !b.is_ascii_whitespace())?;
        matches!(next, b'"' | b'{' | b'[' | b']' | b'}').then_some(i)
    });
    let Some(start) = start else { return 0 };
    let before = String::from_utf8_lossy(&window[..start]).to_ascii_lowercase();
    let is_page = ["<!doctype", "<html", "<head", "<body", "<script", "<style"]
        .iter()
        .any(|tag| before.contains(tag));
    if is_page { 0 } else { start }
}

/// Flux d'une liste débarrassé des avertissements PHP qui la précèdent (`php_notice_len`).
pub fn skip_php_notice<R: std::io::Read>(mut reader: R) -> std::io::Result<std::io::Chain<std::io::Cursor<Vec<u8>>, R>> {
    let mut head = vec![0u8; MAX_PHP_NOTICE_BYTES];
    let mut filled = 0;
    while filled < head.len() {
        match reader.read(&mut head[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        }
    }
    head.truncate(filled);
    let skip = php_notice_len(&head);
    head.drain(..skip);
    Ok(std::io::Read::chain(std::io::Cursor::new(head), reader))
}

/// Liste lue avec tolérance : les éléments lisibles et le nombre d'éléments illisibles écartés.
#[derive(Debug)]
pub struct LenientList<T> {
    pub items: Vec<T>,
    pub skipped: usize,
}

/// Pourquoi une liste est refusée.
#[derive(Debug, PartialEq)]
pub enum ListError {
    /// Réponse qui n'est pas une liste JSON complète (coupée en route, page d'erreur…) : un nouvel
    /// essai peut réussir.
    Unreadable(String),
    /// Liste lisible mais trop d'éléments mal formés : le fournisseur envoie la même chose à
    /// chaque essai, inutile de retélécharger.
    TooManyUnreadable { skipped: usize, total: usize },
    /// Plus de `limit` éléments : lecture arrêtée là, inutile de retélécharger.
    TooManyItems { limit: usize },
}

impl std::fmt::Display for ListError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ListError::Unreadable(e) => write!(f, "unreadable list: {}", e),
            ListError::TooManyUnreadable { skipped, total } => {
                write!(f, "{} unreadable items of {}", skipped, total)
            }
            ListError::TooManyItems { limit } => write!(f, "more than {} items", limit),
        }
    }
}

/// Vrai si `skipped` éléments illisibles sur `total` restent tolérables (au plus 1 %).
pub fn unreadable_tolerated(skipped: usize, total: usize) -> bool {
    skipped as f64 <= total as f64 * MAX_UNREADABLE_RATIO
}

/// Lit une liste JSON élément par élément : avant, un seul élément mal formé faisait
/// refuser toute la liste, et la section restait vide ou figée tant que le fournisseur ne
/// corrigeait pas.
pub fn parse_list_lenient<T: ListItem>(bytes: &[u8]) -> Result<LenientList<T>, ListError> {
    // Avertissements PHP avant la liste (vieux panneaux) : sautés
    let bytes = &bytes[php_notice_len(bytes)..];
    // Éléments lus sur place, sans copie
    read_lenient::<T, _, &serde_json::value::RawValue>(&mut serde_json::Deserializer::from_slice(bytes), T::MAX_ITEMS)
}

/// Même lecture tolérante, depuis un flux (fichier téléchargé).
pub fn read_list_lenient<T: ListItem, R: std::io::Read>(reader: R) -> Result<LenientList<T>, ListError> {
    read_lenient::<T, _, Box<serde_json::value::RawValue>>(&mut serde_json::Deserializer::from_reader(reader), T::MAX_ITEMS)
}

/// Lecture au fil de l'eau : un élément illisible est compté puis jeté aussitôt, seuls les éléments
/// lisibles sont gardés, et la lecture s'arrête au-delà de `max_items` éléments. `H` garde le texte
/// d'un élément : emprunté à la réponse en mémoire, ou copié depuis un flux.
fn read_lenient<'de, T, R, H>(de: &mut serde_json::Deserializer<R>, max_items: usize) -> Result<LenientList<T>, ListError>
where
    T: serde::de::DeserializeOwned,
    R: serde_json::de::Read<'de>,
    H: Deserialize<'de> + std::ops::Deref<Target = serde_json::value::RawValue>,
{
    use serde::Deserializer as _;
    let too_many = std::cell::Cell::new(false);
    // `deserialize_any` : une liste envoyée comme objet à clés numériques est lue aussi (visit_map)
    let result = de.deserialize_any(LenientVisitor::<T, H> { max_items, too_many: &too_many, item: std::marker::PhantomData });
    if too_many.get() {
        return Err(ListError::TooManyItems { limit: max_items });
    }
    let list: LenientList<T> = result.map_err(|e| ListError::Unreadable(e.to_string()))?;
    de.end().map_err(|e| ListError::Unreadable(e.to_string()))?;
    let total = list.items.len() + list.skipped;
    if !unreadable_tolerated(list.skipped, total) {
        return Err(ListError::TooManyUnreadable { skipped: list.skipped, total });
    }
    Ok(list)
}

struct LenientVisitor<'a, T, H> {
    max_items: usize,
    /// Plafond atteint : l'erreur de serde qui suit (lecture interrompue) n'est pas une liste illisible
    too_many: &'a std::cell::Cell<bool>,
    item: std::marker::PhantomData<(T, H)>,
}

impl<'de, T, H> serde::de::Visitor<'de> for LenientVisitor<'_, T, H>
where
    T: serde::de::DeserializeOwned,
    H: Deserialize<'de> + std::ops::Deref<Target = serde_json::value::RawValue>,
{
    type Value = LenientList<T>;

    fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str("a list")
    }

    fn visit_seq<A: serde::de::SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
        use serde::de::Error as _;
        let mut list = LenientList { items: Vec::new(), skipped: 0 };
        while let Some(raw) = seq.next_element::<H>()? {
            if list.items.len() + list.skipped >= self.max_items {
                self.too_many.set(true);
                return Err(A::Error::custom("too many items"));
            }
            match read_item::<T>(&raw) {
                Some(item) => list.items.push(item),
                None => list.skipped += 1,
            }
        }
        Ok(list)
    }

    /// Liste envoyée comme objet (`{"0":{…},"7":{…}}`) : PHP écrit ainsi un tableau dont des
    /// éléments ont été retirés. Les éléments sont lus dans l'ordre reçu, comme une liste.
    fn visit_map<A: serde::de::MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        use serde::de::Error as _;
        let mut list = LenientList { items: Vec::new(), skipped: 0 };
        while let Some(key) = map.next_key::<NumericKey>()? {
            if key.0.is_none() {
                return Err(A::Error::custom(NOT_A_LIST));
            }
            let raw = map.next_value::<H>()?;
            if list.items.len() + list.skipped >= self.max_items {
                self.too_many.set(true);
                return Err(A::Error::custom("too many items"));
            }
            match read_item::<T>(&raw) {
                Some(item) => list.items.push(item),
                None => list.skipped += 1,
            }
        }
        Ok(list)
    }
}

/// Erreur d'un objet qui n'est pas une liste écrite en objet (réponse d'erreur du fournisseur,
/// comme `{"user_info":{"auth":0}}`) : illisible, comme avant.
pub const NOT_A_LIST: &str = "an object that is not a list";

/// Clé d'un objet lu comme une liste : `Some` seulement pour un numéro (`"0"`, `"12"`), seule forme
/// qu'écrit PHP pour un tableau. Toute autre clé dit une vraie réponse en objet, pas une liste.
pub struct NumericKey(pub Option<u64>);

impl<'de> Deserialize<'de> for NumericKey {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct KeyVisitor;
        impl serde::de::Visitor<'_> for KeyVisitor {
            type Value = NumericKey;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("a key")
            }
            fn visit_str<E>(self, v: &str) -> Result<Self::Value, E> {
                let numeric = !v.is_empty() && v.len() <= 19 && v.bytes().all(|b| b.is_ascii_digit());
                Ok(NumericKey(if numeric { v.parse().ok() } else { None }))
            }
        }
        deserializer.deserialize_str(KeyVisitor)
    }
}

// =============================================================================
// API RESPONSE STRUCTS
// =============================================================================

/// Film depuis l'API Xtream (get_vod_streams)
#[derive(Debug, Deserialize)]
pub struct XtreamMovie {
    #[serde(deserialize_with = "deserialize_stream_id")]
    pub stream_id: i64,
    #[serde(default, deserialize_with = "deserialize_opt_text")]
    pub name: Option<String>,
    #[serde(default, deserialize_with = "deserialize_opt_extra")]
    pub stream_icon: Option<String>,
    #[serde(default, deserialize_with = "deserialize_opt_extra")]
    pub category_id: Option<String>,
    /// TMDB ID - peut être String ou Number selon le provider
    #[serde(default, deserialize_with = "deserialize_opt_loose_id")]
    pub tmdb: Option<serde_json::Value>,
    #[serde(default, deserialize_with = "deserialize_opt_extra")]
    pub added: Option<String>,
    #[serde(default, deserialize_with = "deserialize_opt_extra")]
    pub rating: Option<String>,
    #[serde(default, deserialize_with = "deserialize_opt_extra")]
    pub container_extension: Option<String>,
}

/// Série depuis l'API Xtream (get_series)
#[derive(Debug, Deserialize)]
pub struct XtreamSeries {
    #[serde(deserialize_with = "deserialize_stream_id")]
    pub series_id: i64,
    #[serde(default, deserialize_with = "deserialize_opt_text")]
    pub name: Option<String>,
    #[serde(default, deserialize_with = "deserialize_opt_extra")]
    pub cover: Option<String>,
    #[serde(default, deserialize_with = "deserialize_opt_extra")]
    pub category_id: Option<String>,
    /// TMDB ID - peut être String ou Number selon le provider
    #[serde(default, alias = "tmdb", deserialize_with = "deserialize_opt_loose_id")]
    pub tmdb_id: Option<serde_json::Value>,
    #[serde(default, deserialize_with = "deserialize_opt_extra")]
    pub last_modified: Option<String>,
    #[serde(default, deserialize_with = "deserialize_opt_extra")]
    pub rating: Option<String>,
}

/// Chaîne Live depuis l'API Xtream (get_live_streams)
#[derive(Debug, Deserialize)]
pub struct XtreamLive {
    #[serde(deserialize_with = "deserialize_stream_id")]
    pub stream_id: i64,
    #[serde(default, deserialize_with = "deserialize_opt_text")]
    pub name: Option<String>,
    #[serde(default, deserialize_with = "deserialize_opt_extra")]
    pub stream_icon: Option<String>,
    #[serde(default, deserialize_with = "deserialize_opt_extra")]
    pub category_id: Option<String>,
    #[serde(default, deserialize_with = "deserialize_opt_extra")]
    pub epg_channel_id: Option<String>,
}

/// Catégorie depuis l'API Xtream (get_*_categories)
#[derive(Debug, Deserialize)]
pub struct XtreamCategory {
    #[serde(deserialize_with = "deserialize_loose_id")]
    pub category_id: serde_json::Value, // String ou Number selon provider
    #[serde(default, deserialize_with = "deserialize_text")]
    pub category_name: String,
}

// =============================================================================
// RESULT STRUCT
// =============================================================================

/// Résultat de l'ingestion du catalogue
#[derive(Debug, serde::Serialize, Clone)]
pub struct IngestResult {
    pub movies_count: usize,
    pub series_count: usize,
    pub live_count: usize,
    pub categories_count: usize,
    pub duration_ms: u128,
    /// True si au moins un endpoint a échoué
    pub partial: bool,
    /// Liste des endpoints qui ont échoué (ex: ["series", "live_categories"])
    pub failed_endpoints: Vec<String>,
    /// Parmi eux, ceux refusés car trop gros (`LIST_TOO_LARGE`) : la page l'annonce
    pub too_large_endpoints: Vec<String>,
    /// Logs d'ingestion pour affichage console F12
    pub logs: Vec<String>,
    /// Reprises de films re-liées à leur nouveau numéro (même TMDB), pour que le cloud suive
    pub progress_relinks: Vec<crate::catalog_refresh::ProgressRelink>,
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/// Normalise une valeur TMDB (String ou Number) en Option<i64>
/// Retourne None si la valeur est invalide, 0, ou négative
pub fn normalize_tmdb(value: &Option<serde_json::Value>) -> Option<i64> {
    match value {
        Some(serde_json::Value::Number(n)) => n.as_i64().filter(|&v| v > 0),
        Some(serde_json::Value::String(s)) => s.trim().parse::<i64>().ok().filter(|&v| v > 0),
        _ => None,
    }
}

/// Normalise un category_id (String ou Number) en String
pub fn normalize_category_id(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::String(s) => s.clone(),
        _ => String::new(),
    }
}

/// Parse un timestamp string en Option<i64>
pub fn parse_timestamp(value: &Option<String>) -> Option<i64> {
    value.as_ref().and_then(|s| s.trim().parse::<i64>().ok())
}

/// Parse un rating string en Option<f64>
pub fn parse_rating(value: &Option<String>) -> Option<f64> {
    value.as_ref().and_then(|s| s.trim().parse::<f64>().ok())
}

// =============================================================================
// DATABASE OPERATIONS
// =============================================================================

/// Ouvre une connexion SQLite avec configuration optimale.
/// Crée les tables de base si elles n'existent pas (auto-repair après full reset).
pub fn open_connection(db_path: &Path) -> Result<Connection, String> {
    let conn = Connection::open(db_path).map_err(|e| crate::storage::sanitize_error_path(format!("Failed to open database: {}", e)))?;

    // Optimisations SQLite pour batch insert
    conn.execute_batch(crate::schema::PRAGMAS_BATCH)
        .map_err(|e| format!("Failed to set pragmas: {}", e))?;

    // Ensure core tables exist (auto-repair after full reset).
    // After a full reset the .db is deleted; Rust may open the fresh file
    // before the page has created its schema. Without these tables,
    // clear_tables() would fail with "no such table".
    conn.execute_batch(crate::schema::CATALOG_TABLES)
        .map_err(|e| format!("Failed to ensure core tables: {}", e))?;

    // Auto-repair: ensure columns added in post-v1 migrations exist.
    crate::schema::run_auto_repair(&conn, crate::schema::CATALOG_AUTO_REPAIR);
    // Clé (type, numéro) des catégories : déjà posée à l'ouverture par la page ; ici pour une
    // base ouverte d'abord par le Rust. Un échec laisse l'ancienne clé, comme avant.
    if let Err(e) = crate::schema::upgrade_categories_key(&conn) {
        eprintln!("[catalog_parser] categories key upgrade postponed: {}", e);
    }

    Ok(conn)
}

/// Recrée les indexes après insertion (appelé après commit)
pub fn recreate_indexes(conn: &rusqlite::Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_movies_tmdb ON movies(tmdb_id);
         CREATE INDEX IF NOT EXISTS idx_movies_category ON movies(category_id);
         CREATE INDEX IF NOT EXISTS idx_movies_added ON movies(added);
         CREATE INDEX IF NOT EXISTS idx_series_tmdb ON series(tmdb_id);
         CREATE INDEX IF NOT EXISTS idx_series_category ON series(category_id);
         CREATE INDEX IF NOT EXISTS idx_live_category ON live(category_id);",
    )
    .map_err(|e| format!("Failed to recreate indexes: {}", e))
}

/// Ligne de la table `movies` telle que l'écriture l'enregistre, sans sa position (`sort_order`).
/// Seule conversion « élément du fournisseur → ligne » : l'écriture complète (`insert_movies`) et
/// l'actualisation par comparaison (`catalog_refresh.rs`) ne peuvent donc pas diverger.
#[derive(Debug, Clone, PartialEq)]
pub struct MovieRow {
    pub id: i64,
    pub tmdb_id: Option<i64>,
    pub name: String,
    pub icon: Option<String>,
    pub category_id: Option<String>,
    pub added: Option<i64>,
    pub rating: Option<f64>,
    pub container_extension: Option<String>,
}

pub fn movie_row(movie: &XtreamMovie) -> MovieRow {
    MovieRow {
        id: movie.stream_id,
        tmdb_id: normalize_tmdb(&movie.tmdb),
        name: movie.name.as_deref().unwrap_or("").to_string(),
        icon: movie.stream_icon.clone(),
        category_id: movie.category_id.clone(),
        added: parse_timestamp(&movie.added),
        rating: parse_rating(&movie.rating),
        container_extension: movie.container_extension.clone(),
    }
}

pub fn insert_movies(tx: &Transaction, movies: &[XtreamMovie]) -> Result<usize, String> {
    let mut stmt = tx
        .prepare_cached(
            "INSERT OR REPLACE INTO movies (id, tmdb_id, name, icon, category_id, added, rating, container_extension, data, sort_order)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)"
        )
        .map_err(|e| format!("Failed to prepare movies statement: {}", e))?;

    let mut count = 0;
    for (index, movie) in movies.iter().enumerate() {
        let row = movie_row(movie);
        let result = stmt.execute(params![
            row.id,
            row.tmdb_id,
            row.name,
            row.icon,
            row.category_id,
            row.added,
            row.rating,
            row.container_extension,
            index as i64,
        ]);

        if let Err(e) = result {
            eprintln!("[catalog_parser] insert_movies failed for stream_id {}: {}", movie.stream_id, e);
        } else {
            count += 1;
        }
    }

    Ok(count)
}

/// Ligne de la table `series` (même rôle que `MovieRow`). `added` vient de `last_modified` : il
/// change quand le fournisseur ajoute des épisodes.
#[derive(Debug, Clone, PartialEq)]
pub struct SeriesRow {
    pub id: i64,
    pub tmdb_id: Option<i64>,
    pub name: String,
    pub icon: Option<String>,
    pub category_id: Option<String>,
    pub added: Option<i64>,
    pub rating: Option<f64>,
}

pub fn series_row(s: &XtreamSeries) -> SeriesRow {
    SeriesRow {
        id: s.series_id,
        tmdb_id: normalize_tmdb(&s.tmdb_id),
        name: s.name.as_deref().unwrap_or("").to_string(),
        icon: s.cover.clone(),
        category_id: s.category_id.clone(),
        added: parse_timestamp(&s.last_modified),
        rating: parse_rating(&s.rating),
    }
}

/// Insère les séries dans SQLite
pub fn insert_series(tx: &Transaction, series: &[XtreamSeries]) -> Result<usize, String> {
    let mut stmt = tx
        .prepare_cached(
            "INSERT OR REPLACE INTO series (id, tmdb_id, name, icon, category_id, added, rating, data, sort_order)
             VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)"
        )
        .map_err(|e| format!("Failed to prepare series statement: {}", e))?;

    let mut count = 0;
    for (index, s) in series.iter().enumerate() {
        let row = series_row(s);
        let result = stmt.execute(params![
            row.id,
            row.tmdb_id,
            row.name,
            row.icon,
            row.category_id,
            row.added,
            row.rating,
            index as i64,
        ]);

        if let Err(e) = result {
            eprintln!("[catalog_parser] insert_series failed for series_id {}: {}", s.series_id, e);
        } else {
            count += 1;
        }
    }

    Ok(count)
}

/// Extrait un code pays ISO 2 lettres depuis les tags du nom brut M3U.
/// Cherche dans l'ordre : |FR|, [FR], FR| (préfixe cassé).
/// Retourne None si aucun tag géographique n'est trouvé.
pub(crate) fn extract_geo_hint(name: &str) -> Option<String> {
    static RE_PIPE: OnceLock<Regex> = OnceLock::new();
    static RE_BRACKET: OnceLock<Regex> = OnceLock::new();
    static RE_PREFIX: OnceLock<Regex> = OnceLock::new();

    // |FR| — tag pipe standard (2 lettres uniquement = code pays)
    let re_pipe = RE_PIPE.get_or_init(|| Regex::new(r"\|([A-Za-z]{2})\|").unwrap());
    if let Some(caps) = re_pipe.captures(name) {
        return Some(caps[1].to_lowercase());
    }
    // [FR] — tag bracket
    let re_bracket = RE_BRACKET.get_or_init(|| Regex::new(r"\[([A-Za-z]{2})\]").unwrap());
    if let Some(caps) = re_bracket.captures(name) {
        return Some(caps[1].to_lowercase());
    }
    // FR| — préfixe cassé en début de chaîne
    let re_prefix = RE_PREFIX.get_or_init(|| Regex::new(r"^([A-Za-z]{2})\s*\|").unwrap());
    if let Some(caps) = re_prefix.captures(name) {
        return Some(caps[1].to_lowercase());
    }
    None
}

/// Nettoie le nom de la chaîne pour un affichage UI propre.
/// Utilise des patterns structurels (et non une liste hardcodée) pour retirer
/// tous les tags |XX|, [XX], (XX), et les préfixes cassés type "FR|".
/// Conserve la Qualité (UHD) et TimeShift (-2H) qui ne sont pas entre tags.
pub(crate) fn clean_display_name_for_ui(name: &str) -> String {
    static RE_PIPE_TAGS: OnceLock<Regex> = OnceLock::new();
    static RE_BRACKET_TAGS: OnceLock<Regex> = OnceLock::new();
    static RE_PAREN_TAGS: OnceLock<Regex> = OnceLock::new();
    static RE_BROKEN_PREFIX: OnceLock<Regex> = OnceLock::new();
    static RE_SPACE: OnceLock<Regex> = OnceLock::new();

    // |XX| — tout contenu entre pipes (1-10 chars)
    let re_pipe = RE_PIPE_TAGS.get_or_init(|| Regex::new(r"\|[^|]{1,10}\|").unwrap());
    // [XX] — tout contenu entre crochets (1-10 chars)
    let re_bracket = RE_BRACKET_TAGS.get_or_init(|| Regex::new(r"\[[^\]]{1,10}\]").unwrap());
    // (XX) — tout contenu entre parenthèses (1-10 chars)
    let re_paren = RE_PAREN_TAGS.get_or_init(|| Regex::new(r"\([^)]{1,10}\)").unwrap());
    // Préfixe cassé: "FR| ", "AR| ", "USA| " en début de chaîne (2-3 lettres max)
    let re_broken = RE_BROKEN_PREFIX.get_or_init(|| Regex::new(r"^[A-Za-z]{2,3}\s*\|\s*").unwrap());
    let re_space = RE_SPACE.get_or_init(|| Regex::new(r"\s+").unwrap());

    let mut cleaned = name.to_string();
    cleaned = re_pipe.replace_all(&cleaned, " ").to_string();
    cleaned = re_bracket.replace_all(&cleaned, " ").to_string();
    cleaned = re_paren.replace_all(&cleaned, " ").to_string();
    cleaned = re_broken.replace(&cleaned, "").to_string();
    cleaned = re_space.replace_all(&cleaned, " ").to_string();
    let cleaned = cleaned.trim();
    // Nom fait seulement d'étiquettes (« [FR] », « (HD) ») : gardé tel quel plutôt que vide (carte
    // sans nom, introuvable dans la recherche)
    if cleaned.is_empty() { name.trim().to_string() } else { cleaned.to_string() }
}

/// Ligne de la table `live` (même rôle que `MovieRow`) : nom nettoyé pour l'affichage et pays
/// tiré des étiquettes du nom brut. Les liens du guide (`matched_epg_id`, `match_method`) n'en font
/// pas partie : ils sont calculés après coup (`epg_parser.rs`).
#[derive(Debug, Clone, PartialEq)]
pub struct LiveRow {
    pub id: i64,
    pub name: String,
    pub icon: Option<String>,
    pub category_id: Option<String>,
    pub epg_channel_id: Option<String>,
    pub geo_hint: Option<String>,
}

pub fn live_row(l: &XtreamLive) -> LiveRow {
    let raw_name = l.name.as_deref().unwrap_or("");
    LiveRow {
        id: l.stream_id,
        name: clean_display_name_for_ui(raw_name),
        icon: l.stream_icon.clone(),
        category_id: l.category_id.clone(),
        epg_channel_id: l.epg_channel_id.clone(),
        geo_hint: extract_geo_hint(raw_name),
    }
}

/// Insère les chaînes live dans SQLite
pub fn insert_live(tx: &Transaction, live_streams: &[XtreamLive]) -> Result<usize, String> {
    let mut stmt = tx
        .prepare_cached(
            "INSERT OR REPLACE INTO live (id, name, icon, category_id, epg_channel_id, matched_epg_id, match_method, geo_hint, data, sort_order)
             VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, NULL, ?)",
        )
        .map_err(|e| format!("Failed to prepare live statement: {}", e))?;

    let mut count = 0;
    for (index, l) in live_streams.iter().enumerate() {
        let row = live_row(l);

        let result = stmt.execute(params![
            row.id,
            row.name,
            row.icon,
            row.category_id,
            row.epg_channel_id,
            row.geo_hint,
            index as i64,
        ]);

        if let Err(e) = result {
            eprintln!("[catalog_parser] insert_live failed for stream_id {}: {}", l.stream_id, e);
        } else {
            count += 1;
        }
    }

    Ok(count)
}

/// Insère les catégories dans SQLite
pub fn insert_categories(
    tx: &Transaction,
    vod_cats: &[XtreamCategory],
    series_cats: &[XtreamCategory],
    live_cats: &[XtreamCategory],
) -> Result<usize, String> {
    let mut stmt = tx
        .prepare_cached("INSERT OR REPLACE INTO categories (id, name, type, sort_order) VALUES (?, ?, ?, ?)")
        .map_err(|e| format!("Failed to prepare categories statement: {}", e))?;

    let mut count = 0;

    for (index, cat) in vod_cats.iter().enumerate() {
        let id = normalize_category_id(&cat.category_id);
        if stmt
            .execute(params![id, cat.category_name, "movie", index as i64])
            .is_ok()
        {
            count += 1;
        }
    }

    for (index, cat) in series_cats.iter().enumerate() {
        let id = normalize_category_id(&cat.category_id);
        if stmt
            .execute(params![id, cat.category_name, "series", index as i64])
            .is_ok()
        {
            count += 1;
        }
    }

    for (index, cat) in live_cats.iter().enumerate() {
        let id = normalize_category_id(&cat.category_id);
        if stmt.execute(params![id, cat.category_name, "live", index as i64]).is_ok() {
            count += 1;
        }
    }

    Ok(count)
}

// =============================================================================
// TESTS
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    /// Un champ secondaire de forme inattendue (liste, objet) est ignoré : le titre reste dans la
    /// liste (le nom, lui, reste exigé : une actualisation garde la ligne au lieu d'effacer son nom).
    /// Avant, il était jeté, et au-delà de 1 % de titres jetés toute la liste était refusée
    /// (films, séries ou chaînes tous invisibles).
    #[test]
    fn an_odd_secondary_field_never_hides_the_title() {
        let movies = br#"[{"stream_id":1,"name":"Dune","stream_icon":{},"category_id":[3],"added":[],"rating":{"v":7},"container_extension":["mkv"],"tmdb":{}},
                          {"stream_id":2,"name":"Arrival"}]"#;
        let list = parse_list_lenient::<XtreamMovie>(movies).unwrap();
        assert_eq!(list.skipped, 0);
        assert_eq!(
            movie_row(&list.items[0]),
            MovieRow { id: 1, tmdb_id: None, name: "Dune".to_string(), icon: None, category_id: None, added: None, rating: None, container_extension: None }
        );
        let series = br#"[{"series_id":5,"name":"Dark","cover":[],"category_id":{"id":1},"last_modified":[1],"rating":[]}]"#;
        let list = parse_list_lenient::<XtreamSeries>(series).unwrap();
        assert_eq!((list.items.len(), list.skipped), (1, 0));
        assert_eq!(series_row(&list.items[0]).name, "Dark");
        let live = br#"[{"stream_id":9,"name":"TF1","stream_icon":[],"category_id":{},"epg_channel_id":["tf1.fr"]}]"#;
        let list = parse_list_lenient::<XtreamLive>(live).unwrap();
        assert_eq!((list.items.len(), list.skipped), (1, 0));
        assert_eq!(live_row(&list.items[0]).name, "TF1");
    }

    /// Fournisseur farfelu du banc (src-tauri/tests/fixtures/farfelu.json) : chaque élément est un
    /// piège vu chez de vrais fournisseurs ; aucun ne doit être jeté à la lecture, et chaque titre garde
    /// un nom (cherchable).
    #[test]
    fn every_trap_of_the_odd_provider_is_kept() {
        use serde_json::value::RawValue;
        let lists: std::collections::HashMap<String, Box<RawValue>> =
            serde_json::from_str(include_str!("../tests/fixtures/farfelu.json")).unwrap();
        let raw = |key: &str| lists.get(key).unwrap_or_else(|| panic!("{} absent", key)).get().as_bytes();
        let len = |key: &str| serde_json::from_slice::<Vec<serde_json::Value>>(raw(key)).unwrap().len();
        for key in ["get_live_categories", "get_vod_categories", "get_series_categories"] {
            let list = parse_list_lenient::<XtreamCategory>(raw(key)).unwrap();
            assert_eq!((list.items.len(), list.skipped), (len(key), 0), "{}", key);
        }
        let live = parse_list_lenient::<XtreamLive>(raw("get_live_streams")).unwrap();
        assert_eq!((live.items.len(), live.skipped), (len("get_live_streams"), 0));
        assert!(live.items.iter().all(|l| !live_row(l).name.is_empty()), "chaîne sans nom");
        let movies = parse_list_lenient::<XtreamMovie>(raw("get_vod_streams")).unwrap();
        assert_eq!((movies.items.len(), movies.skipped), (len("get_vod_streams"), 0));
        assert!(movies.items.iter().all(|m| !movie_row(m).name.is_empty()));
        let series = parse_list_lenient::<XtreamSeries>(raw("get_series")).unwrap();
        assert_eq!((series.items.len(), series.skipped), (len("get_series"), 0));
        assert!(series.items.iter().all(|s| !series_row(s).name.is_empty()));
    }

    /// Numéro envoyé en nombre à virgule mais entier (`1.0`, `1e3`) : lu comme l'entier ; un vrai
    /// nombre à virgule reste refusé (on ne devine pas un numéro de flux).
    #[test]
    fn a_whole_number_written_as_a_float_is_a_valid_id() {
        let list = parse_list_lenient::<XtreamMovie>(br#"[{"stream_id":1.0},{"stream_id":1e3},{"stream_id":"12.0"}]"#).unwrap();
        assert_eq!(list.items.iter().map(|m| m.stream_id).collect::<Vec<_>>(), [1, 1000, 12]);
        let mut items: Vec<String> = (1..=200).map(|i| format!(r#"{{"stream_id":{}}}"#, i)).collect();
        items.push(r#"{"stream_id":1.5}"#.to_string());
        let list = parse_list_lenient::<XtreamMovie>(format!("[{}]", items.join(",")).as_bytes()).unwrap();
        assert_eq!(list.skipped, 1);
    }

    /// Nom de chaîne fait seulement d'étiquettes : le nettoyage ne doit pas le vider (carte sans
    /// nom, introuvable dans la recherche) ; le nom d'origine est gardé.
    #[test]
    fn a_channel_name_made_only_of_tags_is_kept() {
        assert_eq!(clean_display_name_for_ui("[FR]"), "[FR]");
        assert_eq!(clean_display_name_for_ui("  |UK|  "), "|UK|");
        assert_eq!(clean_display_name_for_ui("(HD)"), "(HD)");
        assert_eq!(clean_display_name_for_ui("FR| TF1 HD"), "TF1 HD");
        assert_eq!(clean_display_name_for_ui(""), "");
    }

    #[test]
    fn test_normalize_tmdb_number() {
        let val = Some(serde_json::Value::Number(serde_json::Number::from(12345)));
        assert_eq!(normalize_tmdb(&val), Some(12345));
    }

    #[test]
    fn test_normalize_tmdb_string() {
        let val = Some(serde_json::Value::String("67890".to_string()));
        assert_eq!(normalize_tmdb(&val), Some(67890));
    }

    #[test]
    fn test_normalize_tmdb_zero() {
        let val = Some(serde_json::Value::Number(serde_json::Number::from(0)));
        assert_eq!(normalize_tmdb(&val), None);
    }

    #[test]
    fn test_normalize_tmdb_empty_string() {
        let val = Some(serde_json::Value::String("".to_string()));
        assert_eq!(normalize_tmdb(&val), None);
    }

    #[test]
    fn test_normalize_tmdb_none() {
        assert_eq!(normalize_tmdb(&None), None);
    }

    #[test]
    fn test_normalize_category_id_number() {
        let val = serde_json::Value::Number(serde_json::Number::from(42));
        assert_eq!(normalize_category_id(&val), "42");
    }

    #[test]
    fn test_normalize_category_id_string() {
        let val = serde_json::Value::String("42".to_string());
        assert_eq!(normalize_category_id(&val), "42");
    }

    #[test]
    fn category_with_numeric_or_missing_name_is_read() {
        // Un nom de catégorie en nombre ou absent faisait refuser toute la liste
        let list = parse_list_lenient::<XtreamCategory>(
            br#"[{"category_id":"1","category_name":"Films"},{"category_id":2,"category_name":2024},{"category_id":"3"}]"#,
        )
        .unwrap();
        assert_eq!(list.skipped, 0);
        let names: Vec<&str> = list.items.iter().map(|c| c.category_name.as_str()).collect();
        assert_eq!(names, vec!["Films", "2024", ""]);
    }

    /// Fournisseur sans aucun numéro TMDB dans ses listes, note en nombre (relevé sur de vrais
    /// fournisseurs) : chaque film et chaque série est lu, sans numéro TMDB
    #[test]
    fn provider_lists_without_tmdb_and_with_numeric_ratings_are_read() {
        let movies = br#"[{"num":1,"name":"Film A","stream_type":"movie","stream_id":11,"stream_icon":"http://x/a.jpg","rating":7.4,"rating_5based":3.7,"added":"1700000000","category_id":"5","container_extension":"mkv"},
                          {"num":2,"name":"Film B","stream_id":12,"rating":0,"category_id":"5","container_extension":"mp4"}]"#;
        let list = parse_list_lenient::<XtreamMovie>(movies).unwrap();
        assert_eq!((list.items.len(), list.skipped), (2, 0));
        assert!(list.items.iter().all(|m| movie_row(m).tmdb_id.is_none()));
        let series = br#"[{"num":1,"name":"Serie A","series_id":21,"cover":"http://x/s.jpg","rating":8,"rating_5based":4,"last_modified":"1700000000","category_id":"7"}]"#;
        let list = parse_list_lenient::<XtreamSeries>(series).unwrap();
        assert_eq!((list.items.len(), list.skipped), (1, 0));
        assert!(series_row(&list.items[0]).tmdb_id.is_none());
    }

    #[test]
    fn lenient_list_keeps_the_readable_items_up_to_one_percent() {
        let mut items: Vec<String> = (1..=100).map(|i| format!(r#"{{"stream_id":{}}}"#, i)).collect();
        items[0] = r#"{"stream_id":[1]}"#.to_string();
        let one_bad = format!("[{}]", items.join(","));
        let list = parse_list_lenient::<XtreamLive>(one_bad.as_bytes()).unwrap();
        assert_eq!((list.items.len(), list.skipped), (99, 1));

        items[1] = r#"{"name":"sans identifiant"}"#.to_string();
        let two_bad = format!("[{}]", items.join(","));
        assert_eq!(
            parse_list_lenient::<XtreamLive>(two_bad.as_bytes()).unwrap_err(),
            ListError::TooManyUnreadable { skipped: 2, total: 100 }
        );
        // Réponse qui n'est pas une liste (erreur du fournisseur, réponse coupée)
        assert!(matches!(
            parse_list_lenient::<XtreamLive>(br#"{"user_info":{"auth":0}}"#),
            Err(ListError::Unreadable(_))
        ));
        assert!(matches!(parse_list_lenient::<XtreamLive>(br#"[{"stream_id":1},"#), Err(ListError::Unreadable(_))));
    }

    /// Liste envoyée comme objet à clés numériques (PHP, éléments filtrés) : lue comme une liste, dans
    /// l'ordre reçu ; un objet à autres clés (réponse d'erreur) reste illisible, donc retenté.
    #[test]
    fn a_list_sent_as_an_object_with_numeric_keys_is_read() {
        let body = br#"{"0":{"stream_id":5,"name":"A"},"7":{"stream_id":"9","name":"B"}}"#;
        let list = parse_list_lenient::<XtreamLive>(body).unwrap();
        let ids: Vec<i64> = list.items.iter().map(|l| l.stream_id).collect();
        assert_eq!((ids, list.skipped), (vec![5, 9], 0));
        let cats = read_list_lenient::<XtreamCategory, _>(&br#"{"3":{"category_id":"3","category_name":"Films"}}"#[..]).unwrap();
        assert_eq!(cats.items.len(), 1);
        // Objet vide : liste vide, comme `[]`
        assert_eq!(parse_list_lenient::<XtreamLive>(b"{}").unwrap().items.len(), 0);
        for not_a_list in [&br#"{"user_info":{"auth":0}}"#[..], br#"{"0":{"stream_id":1},"error":"x"}"#, br#"{"-1":{"stream_id":1}}"#] {
            assert!(matches!(parse_list_lenient::<XtreamLive>(not_a_list), Err(ListError::Unreadable(_))), "{:?}", std::str::from_utf8(not_a_list));
        }
        // Le plafond d'éléments vaut aussi pour la forme objet
        let many = format!("{{{}}}", (0..60_001).map(|i| format!(r#""{}":{{"category_id":"{}"}}"#, i, i)).collect::<Vec<_>>().join(","));
        assert!(matches!(parse_list_lenient::<XtreamCategory>(many.as_bytes()), Err(ListError::TooManyItems { .. })));
    }

    /// Avertissements PHP avant la liste (vieux panneaux) : sautés ; une vraie page web jamais.
    #[test]
    fn php_notices_before_a_list_are_skipped_but_never_a_web_page() {
        let notice = "<br />\n<b>Deprecated</b>:  Function create_function() is deprecated in <b>/home/xtreamcodes/wwwdir/player_api.php</b> on line <b>12</b><br />\n";
        let body = format!("{}[{{\"stream_id\":1,\"name\":\"A\"}}]", notice);
        assert_eq!(parse_list_lenient::<XtreamLive>(body.as_bytes()).unwrap().items.len(), 1);
        let empty = format!("{}[]", notice);
        assert_eq!(parse_list_lenient::<XtreamLive>(empty.as_bytes()).unwrap().items.len(), 0);
        let streamed = skip_php_notice(body.as_bytes()).unwrap();
        assert_eq!(read_list_lenient::<XtreamLive, _>(streamed).unwrap().items.len(), 1);
        // Page Cloudflare ou de maintenance contenant du JSON : jamais lue comme une liste
        for page in [
            r#"<!DOCTYPE html><html><head><script>var a=[{"stream_id":1}]</script></head></html>"#,
            r#"<html><body>[{"stream_id":1}]</body></html>"#,
            r#"<br /><style>p{"x"}</style>[{"stream_id":1}]"#,
        ] {
            assert_eq!(php_notice_len(page.as_bytes()), 0, "{}", page);
            assert!(parse_list_lenient::<XtreamLive>(page.as_bytes()).is_err(), "{}", page);
        }
        // Réponse ordinaire : rien n'est sauté
        assert_eq!(php_notice_len(br#"  [{"stream_id":1}]"#), 0);
        assert_eq!(php_notice_len(b""), 0);
    }

    /// Liste de `n` éléments `0` (2 octets chacun) : illisibles, mais sous la borne en octets.
    fn zeros(n: usize) -> Vec<u8> {
        let mut body = Vec::with_capacity(2 * n + 1);
        body.push(b'[');
        for i in 0..n {
            if i > 0 {
                body.push(b',');
            }
            body.push(b'0');
        }
        body.push(b']');
        body
    }

    #[test]
    fn a_list_of_tiny_items_is_refused_without_building_a_big_vector() {
        // 3 Mo de `0,` demandaient environ 280 Mo (un `Option<XtreamMovie>`
        // par élément, même illisible) avant que la règle du 1 % ne refuse la liste
        let body = zeros(1_500_000);
        let (result, peak) = crate::test_alloc::peak_during(|| parse_list_lenient::<XtreamMovie>(&body).map(|l| l.items.len()));
        assert!(result.is_err());
        assert!(peak < 8 * 1024 * 1024, "peak {} bytes for a {} bytes answer", peak, body.len());
    }

    #[test]
    fn a_huge_item_is_dropped_without_being_read() {
        // Un seul élément de 6 Mo fait de petits morceaux pesait une vingtaine de fois sa taille en
        // valeur générique ; il est maintenant écarté sans être lu
        let inner = zeros(3 * 1024 * 1024);
        let mut body = b"[".to_vec();
        body.extend_from_slice(&inner);
        body.push(b']');
        let (result, peak) = crate::test_alloc::peak_during(|| parse_list_lenient::<XtreamMovie>(&body).map(|l| l.items.len()));
        assert!(result.is_err());
        assert!(peak < 2 * body.len(), "peak {} bytes for a {} bytes answer", peak, body.len());
    }

    #[test]
    fn a_list_over_the_item_cap_is_refused() {
        let read = |json: &str, max: usize| {
            read_lenient::<XtreamLive, _, &serde_json::value::RawValue>(&mut serde_json::Deserializer::from_str(json), max).map(|l| (l.items.len(), l.skipped))
        };
        let three = r#"[{"stream_id":1},{"stream_id":2},{"stream_id":3}]"#;
        assert_eq!(read(three, 3), Ok((3, 0)));
        // Lisibles ou non, tous les éléments comptent
        assert_eq!(read(three, 2), Err(ListError::TooManyItems { limit: 2 }));
        assert_eq!(read("[0,0,0]", 2), Err(ListError::TooManyItems { limit: 2 }));
        // Le refus arrive avant la fin : même une liste coupée après le plafond est « trop grosse »
        assert_eq!(read(r#"[{"stream_id":1},{"stream_id":2},{"stream_id":"#, 1), Err(ListError::TooManyItems { limit: 1 }));
        // Le vrai plafond, depuis un flux (catégories de l'actualisation de fond)
        let body = zeros(XtreamCategory::MAX_ITEMS + 1);
        assert_eq!(
            read_list_lenient::<XtreamCategory, _>(&body[..]).map(|l| l.items.len()).unwrap_err(),
            ListError::TooManyItems { limit: XtreamCategory::MAX_ITEMS }
        );
    }

    #[test]
    fn an_item_over_the_size_cap_counts_as_unreadable() {
        let mut items: Vec<String> = (1..=150).map(|i| format!(r#"{{"stream_id":{}}}"#, i)).collect();
        // Juste au plafond : lu normalement
        let name_at_cap = "a".repeat(MAX_ITEM_BYTES - r#"{"stream_id":151,"name":""}"#.len());
        items.push(format!(r#"{{"stream_id":151,"name":"{}"}}"#, name_at_cap));
        // Un octet de plus : écarté
        items.push(format!(r#"{{"stream_id":152,"name":"{}a"}}"#, name_at_cap));
        let list = parse_list_lenient::<XtreamLive>(format!("[{}]", items.join(",")).as_bytes()).unwrap();
        assert_eq!((list.items.len(), list.skipped), (151, 1));
        assert_eq!(list.items[150].name.as_deref().map(str::len), Some(name_at_cap.len()));
        // Même règle depuis un flux
        let list = read_list_lenient::<XtreamLive, _>(format!("[{}]", items.join(",")).as_bytes()).unwrap();
        assert_eq!((list.items.len(), list.skipped), (151, 1));
    }

    #[test]
    fn deeply_nested_item_is_skipped_or_refused_without_crashing() {
        let deep = format!("{}{}", "[".repeat(100_000), "]".repeat(100_000));
        let mut items: Vec<String> = (1..=200).map(|i| format!(r#"{{"stream_id":{}}}"#, i)).collect();
        items.push(deep);
        let result = parse_list_lenient::<XtreamLive>(format!("[{}]", items.join(",")).as_bytes());
        // Élément écarté (trop profond pour être lu), jamais un plantage
        let list = result.unwrap();
        assert_eq!((list.items.len(), list.skipped), (200, 1));
    }

    #[test]
    fn duplicate_keys_make_the_item_unreadable() {
        // Lu directement dans son type (plus rapide qu'en passant par une valeur générique) : une
        // clé répétée, impossible dans une réponse de panneau Xtream (PHP), rend l'élément illisible
        let mut items: Vec<String> = (1..=150).map(|i| format!(r#"{{"stream_id":{}}}"#, i)).collect();
        items.push(r#"{"stream_id":151,"name":"A","name":"B"}"#.to_string());
        let list = parse_list_lenient::<XtreamLive>(format!("[{}]", items.join(",")).as_bytes()).unwrap();
        assert_eq!((list.items.len(), list.skipped), (150, 1));
    }

    /// Résultat d'un élément seul : sa ligne en base, ou « illisible »
    fn outcomes() -> Vec<String> {
        fn one<T: ListItem>(item: &str, row: impl Fn(&T) -> String) -> String {
            match parse_list_lenient::<T>(format!("[{}]", item).as_bytes()) {
                Ok(list) if list.items.len() == 1 => row(&list.items[0]),
                _ => "illisible".to_string(),
            }
        }
        let movies = [
            r#"{"stream_id":1}"#, r#"{"stream_id":" 7 "}"#, r#"{"stream_id":1.0}"#, r#"{"stream_id":1e3}"#,
            r#"{"stream_id":9223372036854775808}"#, r#"{"stream_id":-5}"#, r#"{"stream_id":true}"#,
            r#"{"stream_id":null}"#, r#"{"stream_id":[1]}"#, r#"{"stream_id":{"a":1}}"#, r#"{"name":"x"}"#,
            r#"{"stream_id":1,"tmdb":"123"}"#, r#"{"stream_id":1,"tmdb":123}"#, r#"{"stream_id":1,"tmdb":0}"#,
            r#"{"stream_id":1,"tmdb":"-1"}"#, r#"{"stream_id":1,"tmdb":1.5}"#, r#"{"stream_id":1,"tmdb":[1]}"#,
            r#"{"stream_id":1,"tmdb":{"x":1}}"#, r#"{"stream_id":1,"tmdb":null}"#, r#"{"stream_id":1,"tmdb":true}"#,
            r#"{"stream_id":1,"tmdb":" 42 "}"#, r#"{"stream_id":1,"name":7.5}"#, r#"{"stream_id":1,"name":true}"#,
            r#"{"stream_id":1,"name":[1]}"#, r#"{"stream_id":1,"name":{}}"#, r#"{"stream_id":1,"name":null}"#,
            r#"{"stream_id":1,"name":1e2}"#, r#"{"stream_id":1,"name":-0.0}"#, r#"{"stream_id":1,"name":12345678901234567890}"#,
            r#"{"stream_id":1,"name":"éé\n"}"#, r#"{"stream_id":1,"rating":7.50,"added":1700000000,"category_id":12}"#,
            r#"{"stream_id":1,"container_extension":"mkv","stream_icon":"http://x/y.jpg","extra":[1,{"a":[]}]}"#,
            r#"0"#, r#""texte""#, r#"null"#, r#"[]"#, r#"[5]"#,
        ];
        let series = [
            r#"{"series_id":1,"tmdb":"5"}"#, r#"{"series_id":1,"tmdb_id":5}"#, r#"{"series_id":1,"tmdb":"5","tmdb_id":6}"#,
            r#"{"series_id":1,"tmdb":[5]}"#, r#"[5]"#, r#"{"series_id":"2","last_modified":"1700000000","rating":"8"}"#,
        ];
        let cats = [
            r#"{"category_id":1,"category_name":"a"}"#, r#"{"category_id":"x"}"#, r#"{"category_id":[1]}"#,
            r#"{"category_id":null,"category_name":null}"#, r#"{"category_name":"sans id"}"#, r#"{"category_id":1.5}"#,
            r#"{"category_id":true}"#, r#"{"category_id":{"a":1},"category_name":[1]}"#, r#"[5,"a"]"#,
        ];
        let mut out: Vec<String> = movies.iter().map(|m| one::<XtreamMovie>(m, |x| format!("{:?}", movie_row(x)))).collect();
        out.extend(series.iter().map(|m| one::<XtreamSeries>(m, |x| format!("{:?}", series_row(x)))));
        out.extend(cats.iter().map(|m| one::<XtreamCategory>(m, |x| format!("{:?}/{:?}", normalize_category_id(&x.category_id), x.category_name))));
        out
    }

    #[test]
    fn items_are_read_exactly_as_before() {
        // Relevé fait sur l'ancienne lecture (valeur générique puis type) avant la lecture directe :
        // chaque cas limite donne la même ligne, ou reste illisible. Écarts voulus : un élément qui
        // n'est pas un objet (lu avant par position s'il était un tableau) ; un champ secondaire (pas le nom)
        // en tableau ou en objet, ignoré au lieu de jeter le titre ; un numéro entier écrit 1.0 ou 1e3
        let expected = [
            r##"MovieRow { id: 1, tmdb_id: None, name: "", icon: None, category_id: None, added: None, rating: None, container_extension: None }"##,
            r##"MovieRow { id: 7, tmdb_id: None, name: "", icon: None, category_id: None, added: None, rating: None, container_extension: None }"##,
            r##"MovieRow { id: 1, tmdb_id: None, name: "", icon: None, category_id: None, added: None, rating: None, container_extension: None }"##, // 1.0 : entier écrit en nombre à virgule (illisible avant)
            r##"MovieRow { id: 1000, tmdb_id: None, name: "", icon: None, category_id: None, added: None, rating: None, container_extension: None }"##, // 1e3 (illisible avant)
            r##"illisible"##,
            r##"MovieRow { id: -5, tmdb_id: None, name: "", icon: None, category_id: None, added: None, rating: None, container_extension: None }"##,
            r##"illisible"##,
            r##"illisible"##,
            r##"illisible"##,
            r##"illisible"##,
            r##"illisible"##,
            r##"MovieRow { id: 1, tmdb_id: Some(123), name: "", icon: None, category_id: None, added: None, rating: None, container_extension: None }"##,
            r##"MovieRow { id: 1, tmdb_id: Some(123), name: "", icon: None, category_id: None, added: None, rating: None, container_extension: None }"##,
            r##"MovieRow { id: 1, tmdb_id: None, name: "", icon: None, category_id: None, added: None, rating: None, container_extension: None }"##,
            r##"MovieRow { id: 1, tmdb_id: None, name: "", icon: None, category_id: None, added: None, rating: None, container_extension: None }"##,
            r##"MovieRow { id: 1, tmdb_id: None, name: "", icon: None, category_id: None, added: None, rating: None, container_extension: None }"##,
            r##"MovieRow { id: 1, tmdb_id: None, name: "", icon: None, category_id: None, added: None, rating: None, container_extension: None }"##,
            r##"MovieRow { id: 1, tmdb_id: None, name: "", icon: None, category_id: None, added: None, rating: None, container_extension: None }"##,
            r##"MovieRow { id: 1, tmdb_id: None, name: "", icon: None, category_id: None, added: None, rating: None, container_extension: None }"##,
            r##"MovieRow { id: 1, tmdb_id: None, name: "", icon: None, category_id: None, added: None, rating: None, container_extension: None }"##,
            r##"MovieRow { id: 1, tmdb_id: Some(42), name: "", icon: None, category_id: None, added: None, rating: None, container_extension: None }"##,
            r##"MovieRow { id: 1, tmdb_id: None, name: "7.5", icon: None, category_id: None, added: None, rating: None, container_extension: None }"##,
            r##"MovieRow { id: 1, tmdb_id: None, name: "true", icon: None, category_id: None, added: None, rating: None, container_extension: None }"##,
            r##"illisible"##,
            r##"illisible"##,
            r##"MovieRow { id: 1, tmdb_id: None, name: "", icon: None, category_id: None, added: None, rating: None, container_extension: None }"##,
            r##"MovieRow { id: 1, tmdb_id: None, name: "100.0", icon: None, category_id: None, added: None, rating: None, container_extension: None }"##,
            r##"MovieRow { id: 1, tmdb_id: None, name: "-0.0", icon: None, category_id: None, added: None, rating: None, container_extension: None }"##,
            r##"MovieRow { id: 1, tmdb_id: None, name: "12345678901234567890", icon: None, category_id: None, added: None, rating: None, container_extension: None }"##,
            r##"MovieRow { id: 1, tmdb_id: None, name: "éé\n", icon: None, category_id: None, added: None, rating: None, container_extension: None }"##,
            r##"MovieRow { id: 1, tmdb_id: None, name: "", icon: None, category_id: Some("12"), added: Some(1700000000), rating: Some(7.5), container_extension: None }"##,
            r##"MovieRow { id: 1, tmdb_id: None, name: "", icon: Some("http://x/y.jpg"), category_id: None, added: None, rating: None, container_extension: Some("mkv") }"##,
            r##"illisible"##,
            r##"illisible"##,
            r##"illisible"##,
            r##"illisible"##,
            r##"illisible"##, // [5] : illisible avant aussi
            r##"SeriesRow { id: 1, tmdb_id: Some(5), name: "", icon: None, category_id: None, added: None, rating: None }"##,
            r##"SeriesRow { id: 1, tmdb_id: Some(5), name: "", icon: None, category_id: None, added: None, rating: None }"##,
            r##"illisible"##,
            r##"SeriesRow { id: 1, tmdb_id: None, name: "", icon: None, category_id: None, added: None, rating: None }"##,
            r##"illisible"##, // [5] : illisible avant aussi
            r##"SeriesRow { id: 2, tmdb_id: None, name: "", icon: None, category_id: None, added: Some(1700000000), rating: Some(8.0) }"##,
            r##""1"/"a""##,
            r##""x"/"""##,
            r##"""/"""##,
            r##"""/"""##,
            r##"illisible"##,
            r##""1.5"/"""##,
            r##"""/"""##,
            r##"illisible"##,
            r##"illisible"##, // [5,"a"] : lu par position avant ("5"/"a") ; écart voulu, un élément doit être un objet
        ];
        assert_eq!(outcomes(), expected);
    }

    #[test]
    fn container_ids_are_skipped_without_being_built() {
        // Élément lisible de 1 Mo dont le numéro TMDB est un tableau de petits morceaux : lu en
        // valeur générique et gardé, il pesait seize fois sa taille (16 Mo de réponse → 268 Mo)
        let filler = String::from_utf8(zeros(500_000)).unwrap();
        let movies = vec![format!(r#"{{"stream_id":1,"tmdb":{}}}"#, filler); 16].join(",");
        let series = vec![format!(r#"{{"series_id":1,"tmdb":{}}}"#, filler); 16].join(",");
        let cats = vec![format!(r#"{{"category_id":{},"category_name":"a"}}"#, filler); 16].join(",");
        for (kind, body) in [("movies", movies), ("series", series), ("categories", cats)] {
            let body = format!("[{}]", body);
            let (count, peak) = crate::test_alloc::peak_during(|| match kind {
                "movies" => parse_list_lenient::<XtreamMovie>(body.as_bytes()).map(|l| l.items.len()),
                "series" => parse_list_lenient::<XtreamSeries>(body.as_bytes()).map(|l| l.items.len()),
                _ => read_list_lenient::<XtreamCategory, _>(body.as_bytes()).map(|l| l.items.len()),
            });
            assert_eq!(count, Ok(16), "{}", kind);
            assert!(peak < 2 * 1024 * 1024 + 2 * body.len() / 16, "{}: peak {} bytes for a {} bytes answer", kind, peak, body.len());
        }
    }

    #[test]
    fn each_kind_of_list_has_its_own_item_cap() {
        // Les six listes sont gardées ensemble jusqu'à l'écriture : un plafond unique de 1 000 000
        // laissait plus d'un gigaoctet sur une box de 2 Go. 200 000 chaînes passent, une de plus non.
        let channels = |n: usize| {
            let items: Vec<String> = (1..=n).map(|i| format!(r#"{{"stream_id":{}}}"#, i)).collect();
            format!("[{}]", items.join(","))
        };
        assert_eq!(parse_list_lenient::<XtreamLive>(channels(200_000).as_bytes()).map(|l| l.items.len()), Ok(200_000));
        assert!(matches!(
            parse_list_lenient::<XtreamLive>(channels(200_001).as_bytes()),
            Err(ListError::TooManyItems { limit: 200_000 })
        ));
    }

    #[test]
    fn scalar_fields_read_like_generic_values_on_random_input() {
        // Le lecteur de champs simples doit donner exactement ce que donnait une lecture en valeur
        // générique (tableaux et objets mis à part : sautés, sans être construits)
        let mut seed: u64 = 0x2545_F491_4F6C_DD1D;
        let mut next = move |n: u64| {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed % n
        };
        let pieces = [
            "0", "-0", "-0.0", "1.5", "1e3", "5e-324", "1e308", "-9223372036854775808", "9223372036854775807",
            "9223372036854775808", "18446744073709551615", "18446744073709551616", "true", "false", "null",
            r#""""#, r#"" 42 ""#, r#""é\u00e9\n""#, r#""\ud83d\ude00""#,
        ];
        let value = |next: &mut dyn FnMut(u64) -> u64| -> String {
            match next(5) {
                0 => format!("[{}]", pieces[next(pieces.len() as u64) as usize]),
                1 => format!(r#"{{"a":{}}}"#, pieces[next(pieces.len() as u64) as usize]),
                _ => pieces[next(pieces.len() as u64) as usize].to_string(),
            }
        };
        for _ in 0..20_000 {
            let text = value(&mut next);
            let generic: serde_json::Value = serde_json::from_str(&text).unwrap();
            let scalar = deserialize_scalar(&mut serde_json::Deserializer::from_str(&text)).unwrap();
            let expected = if generic.is_array() || generic.is_object() { None } else { Some(generic) };
            assert_eq!(scalar, expected, "{}", text);
        }
    }
}
