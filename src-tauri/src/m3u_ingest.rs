//! Écriture d'une liste M3U dans le catalogue local (tables `live`, `movies`, `series`,
//! `categories`), la même base que celle d'un compte Xtream : le reste de l'app la lit sans savoir
//! d'où vient le contenu.
//!
//! La liste est d'abord téléchargée dans un fichier (taille bornée, arrêt à la déconnexion), ou
//! prise dans la copie d'un fichier de l'appareil (`m3u_local_file`), puis
//! lue en flux par `m3u_parser` et écrite au fil de la lecture, dans une seule transaction : la
//! liste n'est jamais entière en mémoire, ni ses lignes. Une liste vide ou illisible ne remplace
//! jamais le catalogue en place.
//!
//! Chaque entrée garde dans la colonne `data` (JSON) ce qu'il faut pour la lire : son adresse et,
//! s'il y a lieu, l'agent et la page d'origine demandés par la liste. Les épisodes sont regroupés
//! par série ; la liste des épisodes de chaque série (saison, numéro, adresse) est dans la colonne
//! `data` de la série.
//!
//! Aucune adresse n'est écrite dans les journaux ni dans les messages d'erreur : elles portent
//! souvent un identifiant et un mot de passe.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use rusqlite::{params, Connection, Transaction};
use tauri::Emitter;

use crate::catalog_parser::{clean_display_name_for_ui, extract_geo_hint, IngestResult};
use crate::ingestion::Stopper;
use crate::m3u_parser::{fnv1a, hash_id, read_m3u_until, EntryKind, M3uEntry, M3uSummary};

/// Taille maximale de la liste téléchargée (comme une liste Xtream).
pub const MAX_M3U_DOWNLOAD_BYTES: u64 = 512 * 1024 * 1024;
/// Taille maximale une fois décompressée (une petite liste compressée ne peut pas en remplir le
/// disque ni occuper la lecture sans fin).
pub const MAX_M3U_TEXT_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// Entrées lues au plus (comme les chaînes d'un compte Xtream).
pub const MAX_M3U_ENTRIES: usize = 500_000;
/// Durée maximale du téléchargement.
const DOWNLOAD_LIMIT: Duration = Duration::from_secs(10 * 60);

/// Ordre des chaînes : d'abord celles qui ont un numéro de chaîne (`tvg-chno`), dans l'ordre des
/// numéros, puis les autres dans l'ordre de la liste.
const UNNUMBERED_SORT_BASE: i64 = 1 << 50;

static M3U_GENERATION: AtomicU64 = AtomicU64::new(0);
/// Numéro du fichier téléchargé : deux lectures en même temps (deux sources) ont chacune le sien.
static DOWNLOAD_SEQUENCE: AtomicU64 = AtomicU64::new(0);
/// Entrées écrites entre deux regards sur l'arrêt demandé.
const STOP_CHECK_EVERY: i64 = 1000;
/// Préfixe des fichiers téléchargés, dans le dossier de l'app.
const DOWNLOAD_PREFIX: &str = "m3u_download_";

/// Marque de ce lancement de l'app dans le nom des fichiers téléchargés : numéro du processus et
/// heure de démarrage (un numéro de processus seul revient vite sous Windows, et le reste d'un
/// plantage porterait alors le même nom).
fn launch_marker() -> &'static str {
    static MARKER: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    MARKER.get_or_init(|| {
        let started = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        format!("{}-{started}", std::process::id())
    })
}

/// Arrête la lecture de liste M3U en cours (déconnexion). Sans effet si rien n'est en cours.
#[tauri::command]
pub fn cancel_m3u_ingestion() {
    M3U_GENERATION.fetch_add(1, Ordering::SeqCst);
    log::info!("[M3U] Arrêt demandé");
}

/// Ce que l'écriture a mis dans le catalogue.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct M3uWriteCounts {
    pub live: usize,
    pub movies: usize,
    pub series: usize,
    pub episodes: usize,
    pub categories: usize,
    /// Le catalogue a été remplacé (faux : liste vide, l'ancien est gardé).
    pub replaced: bool,
    pub summary: M3uSummary,
}

/// Numéro de catégorie d'un groupe : tiré de la sorte et du nom, stable, en chiffres comme ceux
/// d'un fournisseur Xtream. Les trois sortes ont des numéros distincts (la table est commune).
fn category_id(kind: &str, group: &str) -> String {
    let mut key = Vec::with_capacity(kind.len() + group.len() + 8);
    key.extend_from_slice(b"m3u-cat\0");
    key.extend_from_slice(kind.as_bytes());
    key.push(0);
    key.extend_from_slice(group.to_lowercase().as_bytes());
    hash_id(fnv1a(&key)).to_string()
}

/// Numéro d'une série : tiré de son nom et de son groupe, stable d'une lecture à l'autre.
fn series_id(series_name: &str, group: &str) -> i64 {
    let mut key = Vec::with_capacity(series_name.len() + group.len() + 12);
    key.extend_from_slice(b"m3u-series\0");
    key.extend_from_slice(series_name.to_lowercase().as_bytes());
    key.push(0);
    key.extend_from_slice(group.to_lowercase().as_bytes());
    hash_id(fnv1a(&key))
}

/// Ce que le lecteur doit savoir pour jouer l'entrée.
fn playback_data(entry: &M3uEntry) -> String {
    let mut data = serde_json::json!({ "source": "m3u", "url": entry.url });
    if let Some(ua) = &entry.user_agent {
        data["user_agent"] = ua.clone().into();
    }
    if let Some(r) = &entry.referrer {
        data["referrer"] = r.clone().into();
    }
    if let Some(y) = entry.year {
        data["year"] = y.into();
    }
    data.to_string()
}

/// Écrit la liste lue depuis `reader` dans le catalogue, en une transaction. Une liste sans
/// aucune entrée lisible laisse le catalogue tel quel (`replaced` faux).
#[cfg(test)]
pub fn write_m3u_catalog<R: BufRead>(conn: &mut Connection, reader: R) -> Result<M3uWriteCounts, String> {
    write_m3u_catalog_until(conn, reader, &|| false)
}

/// Message d'une écriture arrêtée (déconnexion) : rien n'a été changé dans le catalogue.
pub const WRITE_CANCELLED: &str = "M3U loading cancelled";

/// Comme `write_m3u_catalog`, arrêtée dès que `should_stop` le dit (regardé toutes les
/// `STOP_CHECK_EVERY` entrées et avant la validation) : la transaction est alors abandonnée et le
/// catalogue reste tel qu'il était.
pub fn write_m3u_catalog_until<R: BufRead>(
    conn: &mut Connection,
    reader: R,
    should_stop: &dyn Fn() -> bool,
) -> Result<M3uWriteCounts, String> {
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| format!("Transaction start failed: {}", e))?;
    // Index retirés pendant l'écriture (comme une lecture Xtream), refaits après la validation
    tx.execute_batch(
        "DROP INDEX IF EXISTS idx_movies_tmdb; DROP INDEX IF EXISTS idx_movies_category;
         DROP INDEX IF EXISTS idx_movies_added; DROP INDEX IF EXISTS idx_series_tmdb;
         DROP INDEX IF EXISTS idx_series_category; DROP INDEX IF EXISTS idx_live_category;",
    )
    .map_err(|e| format!("Failed to drop indexes: {}", e))?;
    for table in ["movies", "series", "live", "categories"] {
        tx.execute(&format!("DELETE FROM {table}"), [])
            .map_err(|e| format!("Failed to clear {table}: {}", e))?;
    }
    // Table de travail des épisodes, dans la base (jamais validée), indexée par série : le
    // regroupement ne relit pas toute la table pour chaque série
    tx.execute_batch(crate::schema::M3U_EPISODES_WORK)
    .map_err(|e| format!("Failed to create episode staging: {}", e))?;

    let mut counts = M3uWriteCounts::default();
    // (sorte, groupe) → numéro de catégorie, dans l'ordre d'apparition : quelques centaines au plus
    // Clé en minuscules (« Sport » et « SPORT » sont un seul groupe) ; le nom gardé est le premier vu
    let mut categories: HashMap<(&'static str, String), (String, usize, String)> = HashMap::new();
    let mut write_error: Option<String> = None;

    let summary = {
        let mut live_stmt = tx
            .prepare_cached(
                "INSERT OR REPLACE INTO live (id, name, icon, category_id, epg_channel_id, matched_epg_id, match_method, geo_hint, data, sort_order)
                 VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)",
            )
            .map_err(|e| format!("Failed to prepare live statement: {}", e))?;
        let mut movie_stmt = tx
            .prepare_cached(
                "INSERT OR REPLACE INTO movies (id, tmdb_id, name, icon, category_id, added, rating, container_extension, data, sort_order)
                 VALUES (?, NULL, ?, ?, ?, NULL, NULL, ?, ?, ?)",
            )
            .map_err(|e| format!("Failed to prepare movie statement: {}", e))?;
        let mut episode_stmt = tx
            .prepare_cached(
                "INSERT INTO m3u_episodes_work (series_id, series_name, category_id, icon, id, title, season, episode, container_extension, data, ord)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .map_err(|e| format!("Failed to prepare episode statement: {}", e))?;

        let mut index: i64 = 0;
        let mut category_of = |kind: &'static str, group: &str| -> String {
            let next = categories.len();
            categories
                .entry((kind, group.to_lowercase()))
                .or_insert_with(|| (category_id(kind, group), next, group.to_string()))
                .0
                .clone()
        };

        read_m3u_until(reader, MAX_M3U_ENTRIES, |entry| {
            if write_error.is_some() {
                return false;
            }
            index += 1;
            if index % STOP_CHECK_EVERY == 0 && should_stop() {
                return false;
            }
            let data = playback_data(&entry);
            let result = match (entry.kind, &entry.episode) {
                (EntryKind::Live, _) => {
                    let category = category_of("live", &entry.group);
                    let sort = match entry.chno {
                        Some(n) => (n * 1000.0).round().min(UNNUMBERED_SORT_BASE as f64 - 1.0) as i64,
                        None => UNNUMBERED_SORT_BASE + index,
                    };
                    let raw_name = entry.tvg_name.as_deref().unwrap_or(&entry.name);
                    counts.live += 1;
                    live_stmt.execute(params![
                        entry.id,
                        clean_display_name_for_ui(&entry.name),
                        entry.logo,
                        category,
                        entry.tvg_id.clone().or_else(|| entry.tvg_name.clone()),
                        extract_geo_hint(raw_name),
                        data,
                        sort,
                    ])
                }
                (EntryKind::Episode, Some(info)) => {
                    let category = category_of("series", &entry.group);
                    counts.episodes += 1;
                    episode_stmt.execute(params![
                        series_id(&info.series_name, &entry.group),
                        info.series_name,
                        category,
                        entry.logo,
                        entry.id,
                        entry.name,
                        info.season,
                        info.episode,
                        entry.extension,
                        data,
                        index,
                    ])
                }
                // Film, ou épisode sans marque de saison dans son nom : rangé avec les films
                _ => {
                    let category = category_of("movie", &entry.group);
                    counts.movies += 1;
                    movie_stmt.execute(params![
                        entry.id,
                        entry.name,
                        entry.logo,
                        category,
                        entry.extension,
                        data,
                        index,
                    ])
                }
            };
            if let Err(e) = result {
                write_error = Some(format!("Failed to write entry: {}", e));
                return false;
            }
            true
        })
        .map_err(|e| e.to_string())?
    };
    if let Some(e) = write_error {
        return Err(e);
    }
    if summary.stopped || should_stop() {
        return Err(WRITE_CANCELLED.to_string());
    }

    if summary.entries == 0 {
        // Rien de lisible : le catalogue en place est gardé (transaction abandonnée)
        drop(tx);
        return Ok(M3uWriteCounts { summary, ..M3uWriteCounts::default() });
    }

    // Séries : une ligne par série, ses épisodes triés par saison et numéro dans `data`
    counts.series = tx
        .execute(
            "INSERT OR REPLACE INTO series (id, tmdb_id, name, icon, category_id, added, rating, data, sort_order)
             SELECT e.series_id, NULL, MIN(e.series_name), MIN(e.icon), MIN(e.category_id), NULL, NULL,
                    json_object('source', 'm3u', 'episodes', (
                        SELECT json_group_array(json_object(
                            'id', x.id, 'title', x.title, 'season', x.season, 'episode_num', x.episode,
                            'container_extension', x.container_extension, 'data', json(x.data)))
                        FROM (SELECT * FROM m3u_episodes_work x2 WHERE x2.series_id = e.series_id
                              ORDER BY x2.season, x2.episode, x2.ord) x)),
                    MIN(e.ord)
             FROM m3u_episodes_work e GROUP BY e.series_id",
            [],
        )
        .map_err(|e| format!("Failed to write series: {}", e))?;
    tx.execute_batch("DROP TABLE m3u_episodes_work;")
        .map_err(|e| format!("Failed to drop episode staging: {}", e))?;

    counts.categories = write_categories(&tx, &categories)?;
    if should_stop() {
        return Err(WRITE_CANCELLED.to_string());
    }
    tx.commit().map_err(|e| format!("Commit failed: {}", e))?;
    crate::catalog_parser::recreate_indexes(conn)?;
    counts.replaced = true;
    counts.summary = summary;
    Ok(counts)
}

/// Écrit la liste puis vide le journal WAL, que l'écriture réussisse, échoue ou soit arrêtée.
/// La table de travail des épisodes passe par le journal : sans ce vidage, le fichier `-wal`
/// garderait pour de bon la taille d'une grosse liste (des centaines de Mo sur un boîtier TV).
/// Les pages libérées dans la base elle-même sont réutilisées par la lecture suivante.
pub(crate) fn write_then_shrink_journal<R: BufRead>(
    conn: &mut Connection,
    reader: R,
    should_stop: &dyn Fn() -> bool,
) -> Result<M3uWriteCounts, String> {
    let result = write_m3u_catalog_until(conn, reader, should_stop);
    let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
    result
}

fn write_categories(tx: &Transaction, categories: &HashMap<(&'static str, String), (String, usize, String)>) -> Result<usize, String> {
    let mut stmt = tx
        .prepare_cached("INSERT OR REPLACE INTO categories (id, name, type, sort_order) VALUES (?, ?, ?, ?)")
        .map_err(|e| format!("Failed to prepare categories statement: {}", e))?;
    let mut count = 0;
    for ((kind, _), (id, order, group)) in categories {
        let name = if group.is_empty() { "—" } else { group.as_str() };
        stmt.execute(params![id, name, kind, *order as i64])
            .map_err(|e| format!("Failed to write category: {}", e))?;
        count += 1;
    }
    Ok(count)
}

/// Lecture bornée qui échoue au-delà de `remaining` octets (au lieu de finir comme une fin de
/// fichier normale) : une liste trop grosse une fois décompressée est refusée, jamais écrite à moitié.
struct LimitedText<R> {
    inner: R,
    remaining: u64,
}

impl<R: Read> Read for LimitedText<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.inner.read(buf)?;
        if n as u64 > self.remaining {
            return Err(std::io::Error::other("list too large once decompressed"));
        }
        self.remaining -= n as u64;
        Ok(n)
    }
}

/// Ouvre la liste téléchargée, décompressée à la volée si elle est compressée (octets 1F 8B), et
/// bornée une fois décompressée.
fn open_playlist(path: &Path) -> Result<Box<dyn BufRead>, String> {
    open_playlist_limited(path, MAX_M3U_TEXT_BYTES)
}

fn open_playlist_limited(path: &Path, limit: u64) -> Result<Box<dyn BufRead>, String> {
    let mut file = std::fs::File::open(path).map_err(|e| format!("open list: {}", e.kind()))?;
    let mut magic = [0u8; 2];
    let n = file.read(&mut magic).map_err(|e| format!("read list: {}", e.kind()))?;
    let file = std::fs::File::open(path).map_err(|e| format!("open list: {}", e.kind()))?;
    let reader = BufReader::with_capacity(64 * 1024, file);
    if n == 2 && magic == [0x1f, 0x8b] {
        let text = LimitedText { inner: flate2::read::MultiGzDecoder::new(reader), remaining: limit };
        Ok(Box::new(BufReader::with_capacity(64 * 1024, text)))
    } else {
        Ok(Box::new(BufReader::with_capacity(64 * 1024, LimitedText { inner: reader, remaining: limit })))
    }
}

/// Télécharge la liste dans `path`. Erreurs sans adresse (`without_url`).
async fn download_playlist(client: &reqwest::Client, url: &str, path: &Path, stopper: &Stopper) -> Result<u64, String> {
    use tokio::io::AsyncWriteExt;
    let interrupted = |i: crate::ingestion::Interrupt| match i {
        crate::ingestion::Interrupt::Cancelled => WRITE_CANCELLED.to_string(),
        crate::ingestion::Interrupt::Deadline => "download timed out".to_string(),
    };
    let mut response = stopper
        .run(client.get(url).send())
        .await
        .map_err(interrupted)?
        .map_err(|e| format!("request failed: {}", e.without_url()))?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status().as_u16()));
    }
    if response.content_length().is_some_and(|n| n > MAX_M3U_DOWNLOAD_BYTES) {
        return Err("list too large".to_string());
    }
    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .await
        .map_err(|e| format!("temp file: {}", e.kind()))?;
    let mut bytes: u64 = 0;
    loop {
        let chunk = stopper
            .run(response.chunk())
            .await
            .map_err(interrupted)?
            .map_err(|e| format!("download interrupted: {}", e.without_url()))?;
        let Some(data) = chunk else { break };
        bytes += data.len() as u64;
        if bytes > MAX_M3U_DOWNLOAD_BYTES {
            return Err("list too large".to_string());
        }
        file.write_all(&data).await.map_err(|e| format!("temp file: {}", e.kind()))?;
    }
    file.flush().await.map_err(|e| format!("temp file: {}", e.kind()))?;
    Ok(bytes)
}

/// Supprime les fichiers téléchargés laissés par un lancement précédent arrêté net (plantage,
/// appareil éteint) : ceux d'un autre lancement seulement, jamais ceux d'une lecture en cours.
/// Deux fenêtres de l'app ouvertes en même temps sur le même dossier ne sont pas protégées l'une
/// de l'autre (la seconde efface le téléchargement de la première, qui échoue alors proprement).
fn remove_leftover_downloads(dir: &Path) {
    remove_downloads_except(dir, launch_marker());
}

fn remove_downloads_except(dir: &Path, marker: &str) {
    let own = format!("{DOWNLOAD_PREFIX}{marker}_");
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with(DOWNLOAD_PREFIX) && name.ends_with(".part") && !name.starts_with(&own) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Supprime le fichier téléchargé quand la lecture se termine, quelle qu'en soit l'issue.
struct TempFile(std::path::PathBuf);

impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// Lit une liste M3U depuis `url` et l'écrit dans le catalogue de la base `db_name`. Même
/// résultat qu'une lecture Xtream (`ingest_catalog`), pour que l'écran la traite de la même façon.
#[tauri::command]
pub async fn ingest_m3u(
    app: tauri::AppHandle,
    url: String,
    db_name: String,
    dns_provider: String,
) -> Result<IngestResult, String> {
    crate::storage::validate_catalog_db_name(&db_name)?;
    let url = url.trim().to_string();
    // Liste recopiée depuis un fichier de l'appareil (m3u_local_file.rs) ou adresse web
    let is_local = crate::m3u_local_file::local_list_id(&url)?.is_some();
    if !is_local && !(url.to_ascii_lowercase().starts_with("http://") || url.to_ascii_lowercase().starts_with("https://")) {
        return Err("Only http and https playlists are supported".to_string());
    }
    // Pris avant tout : une déconnexion demandée à partir d'ici arrête cette lecture
    let stopper = Stopper::new(DOWNLOAD_LIMIT, &M3U_GENERATION);
    let _heavy = crate::db_activity::HeavyWriteGuard::new();
    let start = std::time::Instant::now();
    let emit = |payload: serde_json::Value| {
        let _ = app.emit("ingest-progress", payload);
    };
    emit(serde_json::json!({ "phase": "fetch", "status": "started" }));
    log::info!("[M3U] Démarrage de la lecture de la liste");

    let data_dir = crate::storage::get_data_dir(&app);
    // Fichier à lire, et sa copie téléchargée à effacer à la fin (aucune pour une liste recopiée)
    let local = match crate::m3u_local_file::local_list_source(&url, &data_dir) {
        Ok(local) => local,
        Err(e) => {
            log::warn!("[M3U] Copie du fichier de l'appareil illisible : {}", e);
            emit(serde_json::json!({ "phase": "fetch", "endpoint": "m3u", "status": "failed", "error": e }));
            return Err(e);
        }
    };
    let (list_path, temp) = match local {
        Some(path) => {
            log::info!("[M3U] Liste lue depuis la copie du fichier de l'appareil");
            (path, None)
        }
        None => {
            let client = crate::http::build_http_client(&dns_provider, 10, DOWNLOAD_LIMIT.as_secs())?;
            remove_leftover_downloads(&data_dir);
            let sequence = DOWNLOAD_SEQUENCE.fetch_add(1, Ordering::SeqCst);
            let temp = TempFile(data_dir.join(format!("{DOWNLOAD_PREFIX}{}_{sequence}.part", launch_marker())));
            let bytes = match download_playlist(&client, &url, &temp.0, &stopper).await {
                Ok(b) => b,
                Err(e) => {
                    log::warn!("[M3U] Téléchargement échoué : {}", e);
                    emit(serde_json::json!({ "phase": "fetch", "endpoint": "m3u", "status": "failed", "error": e }));
                    return Err(e);
                }
            };
            log::info!("[M3U] Liste reçue : {} octets", bytes);
            (temp.0.clone(), Some(temp))
        }
    };
    emit(serde_json::json!({ "phase": "fetch", "endpoint": "m3u", "status": "done" }));

    // Attend la fin d'une écriture du guide ou d'un recalcul des liens sur les mêmes tables
    // (une déconnexion pendant l'attente arrête la lecture)
    let Ok(_turn) = stopper.run_until_cancelled(crate::db_activity::exclusive_write()).await else {
        return Err(WRITE_CANCELLED.to_string());
    };
    emit(serde_json::json!({ "phase": "sqlite", "status": "started" }));
    // Après le tour d'écriture : refuse le fichier d'une source supprimée entre-temps (sans le recréer)
    let db_path = crate::storage::catalog_db_path(&data_dir, &db_name)?;
    let counts = tokio::task::spawn_blocking(move || -> Result<M3uWriteCounts, String> {
        let mut conn = crate::catalog_parser::open_connection(&db_path)?;
        // Copie de l'appareil effacée entre-temps (ménage, remise à zéro) : le message qui demande de la choisir de nouveau
        let reader = open_playlist(&list_path).map_err(|e| {
            if is_local && !list_path.is_file() { crate::m3u_local_file::LOCAL_LIST_MISSING.to_string() } else { e }
        })?;
        write_then_shrink_journal(&mut conn, reader, &|| stopper.cancelled())
    })
    .await
    .map_err(|e| format!("M3U write task failed: {}", e))??;
    drop(temp);

    let duration_ms = start.elapsed().as_millis();
    let s = &counts.summary;
    let mut failed_endpoints = Vec::new();
    let mut too_large_endpoints = Vec::new();
    if !counts.replaced {
        failed_endpoints.push("m3u_empty".to_string());
    }
    if s.truncated {
        failed_endpoints.push("m3u".to_string());
        too_large_endpoints.push("m3u".to_string());
    }
    let msg = format!(
        "M3U : {} chaînes, {} films, {} séries ({} épisodes), {} catégories en {} ms ; sautées : {} illisibles, {} hors http, {} doublons, {} lignes trop longues",
        counts.live, counts.movies, counts.series, counts.episodes, counts.categories, duration_ms,
        s.skipped_invalid, s.skipped_scheme, s.skipped_duplicate, s.skipped_long_lines
    );
    log::info!("[M3U] {}", msg);
    let partial = !failed_endpoints.is_empty();
    emit(serde_json::json!({ "phase": "done", "status": if partial { "partial" } else { "complete" }, "durationMs": duration_ms }));

    Ok(IngestResult {
        movies_count: counts.movies,
        series_count: counts.series,
        live_count: counts.live,
        categories_count: counts.categories,
        duration_ms,
        partial,
        failed_endpoints,
        too_large_endpoints,
        logs: vec![msg],
        progress_relinks: Vec::new(),
    })
}

#[cfg(test)]
#[path = "m3u_ingest_tests.rs"]
mod tests;
