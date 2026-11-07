//! Recopie du catalogue de la base du compte (`nyxplayer_<espace>.db`, une seule source jusqu'ici)
//! dans le fichier catalogue de la première source (`nyxcat_<espace>_<source>.db`), sans rien
//! retélécharger.
//!
//! Sûre face à une coupure (app tuée, batterie, Windows qui ferme) :
//! - tout est écrit dans un fichier provisoire (`<fichier>.copy-tmp`), puis compté ligne à ligne
//!   contre la base du compte ;
//! - le fichier de la source n'apparaît que par un renommage, une fois la copie complète et notée
//!   (`meta.copied_from_account`) ;
//! - relancée, la recopie reprend de zéro si le fichier provisoire est resté, et ne fait rien si le
//!   fichier de la source existe déjà (copie finie, ou catalogue chargé depuis le fournisseur).
//!
//! La base du compte n'est que lue : ses tables restent en place (retour possible à la version
//! précédente). Les données perso n'en sortent pas.

use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::Connection;
use serde::Serialize;

use crate::storage::{
    catalog_db_path, catalog_deletion_pending, get_data_dir, sanitize_error_path, validate_db_name,
    validate_source_catalog_name, COPY_TMP_SUFFIX, SOURCE_CATALOG_DELETED,
};

/// Tables du catalogue d'un fournisseur, recopiées telles quelles
const CATALOG_TABLES: [&str; 7] = [
    "movies",
    "series",
    "live",
    "categories",
    "epg_programs",
    "epg_channels",
    "epg_kept_channels",
];

/// Notes de `meta` qui décrivent le catalogue (adresse, actualisation, listes trop grandes, guide) :
/// elles suivent le catalogue. Restent à la base du compte : réglages, synchro, et la recherche
/// (son index et ses notes iront dans l'index commun à toutes les sources) ; le compteur de
/// changements repart de zéro dans le nouveau fichier, qui n'a encore rien changé.
const CATALOG_META_KEYS: [&str; 15] = [
    "lastProvider",
    "lastUpdate",
    "catalog_retry_lists",
    "catalog_retry_count",
    "catalog_retry_after",
    "catalog_last_error",
    "catalog_manual_advised",
    "lastTooLargeLists",
    "epg_filtered",
    "epg_needs_resync",
    "epg_sync_status",
    "last_epg_sync",
    "epg_missing_links",
    "epg_sync_interrupted",
    "epg_auto_sync_paused_until",
];

/// Tables du guide sans leurs index (créés après la recopie par `schema::EPG_TABLES`, mêmes colonnes)
const EPG_TABLES_WITHOUT_INDEXES: &str = "
    CREATE TABLE IF NOT EXISTS epg_programs (
        channel_id TEXT NOT NULL,
        title TEXT NOT NULL,
        start_ts INTEGER NOT NULL,
        stop_ts INTEGER NOT NULL,
        description TEXT,
        PRIMARY KEY (channel_id, start_ts)
    );
    CREATE TABLE IF NOT EXISTS epg_channels (
        id TEXT PRIMARY KEY NOT NULL,
        display_name TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS epg_kept_channels (
        id TEXT PRIMARY KEY NOT NULL
    );
";

/// Note écrite dans le fichier de la source quand la recopie est complète
const COPIED_MARK: &str = "copied_from_account";

/// Lignes recopiées, par table. `already_done` : le fichier de la source existait déjà, rien n'a
/// été écrit (les nombres sont alors ceux du fichier existant).
#[derive(Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CopyReport {
    pub movies: i64,
    pub series: i64,
    pub live: i64,
    pub categories: i64,
    pub epg_programs: i64,
    pub already_done: bool,
}

fn db_error(step: &str, e: rusqlite::Error) -> String {
    sanitize_error_path(format!("Catalogue copy ({}): {}", step, e))
}

fn temp_path(target: &Path) -> PathBuf {
    let mut name = target.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    name.push(COPY_TMP_SUFFIX);
    target.with_file_name(name)
}

/// Fichiers annexes d'une base SQLite (journal classique, journal WAL, mémoire partagée)
fn side_files(path: &Path) -> [PathBuf; 3] {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    [
        path.with_file_name(format!("{name}-journal")),
        path.with_file_name(format!("{name}-wal")),
        path.with_file_name(format!("{name}-shm")),
    ]
}

fn remove_with_side_files(path: &Path) -> Result<(), String> {
    for file in std::iter::once(path.to_path_buf()).chain(side_files(path)) {
        if file.exists() {
            fs::remove_file(&file).map_err(|e| sanitize_error_path(format!("Catalogue copy (cleanup): {}", e)))?;
        }
    }
    Ok(())
}

fn table_exists(conn: &Connection, schema: &str, table: &str) -> Result<bool, String> {
    conn.query_row(
        &format!("SELECT COUNT(*) FROM {schema}.sqlite_master WHERE type = 'table' AND name = ?1"),
        [table],
        |r| r.get::<_, i64>(0),
    )
    .map(|n| n > 0)
    .map_err(|e| db_error("schema", e))
}

fn columns(conn: &Connection, schema: &str, table: &str) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA {schema}.table_info({table})"))
        .map_err(|e| db_error("columns", e))?;
    let names = stmt
        .query_map([], |r| r.get::<_, String>(1))
        .map_err(|e| db_error("columns", e))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| db_error("columns", e))?;
    Ok(names)
}

fn count(conn: &Connection, schema: &str, table: &str) -> Result<i64, String> {
    conn.query_row(&format!("SELECT COUNT(*) FROM {schema}.{table}"), [], |r| r.get(0))
        .map_err(|e| db_error("count", e))
}

fn report_of(conn: &Connection, already_done: bool) -> Result<CopyReport, String> {
    let n = |table: &str| -> Result<i64, String> {
        if table_exists(conn, "main", table)? { count(conn, "main", table) } else { Ok(0) }
    };
    Ok(CopyReport {
        movies: n("movies")?,
        series: n("series")?,
        live: n("live")?,
        categories: n("categories")?,
        epg_programs: n("epg_programs")?,
        already_done,
    })
}

/// Écrit la copie complète dans le fichier provisoire `tmp` (recréé de zéro) et la vérifie.
/// Ne touche jamais au fichier de la source.
fn build_copy(account: &Path, tmp: &Path) -> Result<CopyReport, String> {
    remove_with_side_files(tmp)?;
    let mut conn = Connection::open(tmp).map_err(|e| db_error("open", e))?;
    // Journal classique : le fichier provisoire se renomme seul, sans fichier WAL à côté
    conn.execute_batch("PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL;")
        .map_err(|e| db_error("pragmas", e))?;
    conn.execute_batch(crate::schema::CATALOG_TABLES).map_err(|e| db_error("tables", e))?;
    crate::schema::run_auto_repair(&conn, crate::schema::CATALOG_AUTO_REPAIR);
    conn.execute_batch(EPG_TABLES_WITHOUT_INDEXES).map_err(|e| db_error("guide tables", e))?;
    conn.execute_batch("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);")
        .map_err(|e| db_error("meta", e))?;
    // Nom de fichier pris tel quel (pas de forme URI) : la base du compte n'est que lue
    conn.execute("ATTACH DATABASE ?1 AS account", [account.to_string_lossy().as_ref()])
        .map_err(|e| db_error("attach", e))?;

    let tx = conn.transaction().map_err(|e| db_error("begin", e))?;
    for table in CATALOG_TABLES {
        if !table_exists(&tx, "account", table)? {
            continue;
        }
        let source_columns = columns(&tx, "account", table)?;
        let shared: Vec<String> = columns(&tx, "main", table)?
            .into_iter()
            .filter(|c| source_columns.contains(c))
            .map(|c| format!("\"{c}\""))
            .collect();
        if shared.is_empty() {
            continue;
        }
        let list = shared.join(", ");
        tx.execute(&format!("INSERT INTO main.{table} ({list}) SELECT {list} FROM account.{table}"), [])
            .map_err(|e| db_error(table, e))?;
        let (copied, original) = (count(&tx, "main", table)?, count(&tx, "account", table)?);
        if copied != original {
            return Err(format!("Catalogue copy ({table}): {copied} rows copied out of {original}"));
        }
    }
    if table_exists(&tx, "account", "meta")? {
        for key in CATALOG_META_KEYS {
            tx.execute(
                "INSERT OR REPLACE INTO main.meta (key, value) SELECT key, value FROM account.meta WHERE key = ?1",
                [key],
            )
            .map_err(|e| db_error("meta", e))?;
        }
    }
    tx.execute("INSERT OR REPLACE INTO main.meta (key, value) VALUES (?1, '1')", [COPIED_MARK])
        .map_err(|e| db_error("mark", e))?;
    tx.commit().map_err(|e| db_error("commit", e))?;
    // Index créés une fois les lignes en place : plus rapide qu'à chaque insertion
    crate::catalog_parser::recreate_indexes(&conn)?;
    conn.execute_batch(crate::schema::EPG_TABLES).map_err(|e| db_error("guide indexes", e))?;
    conn.execute("DETACH DATABASE account", []).map_err(|e| db_error("detach", e))?;
    let report = report_of(&conn, false)?;
    conn.close().map_err(|(_, e)| db_error("close", e))?;
    Ok(report)
}

/// Met la copie à sa place, sauf si la source a été supprimée ou l'espace réinitialisé pendant la
/// recopie : rien n'apparaît alors après coup, et le fichier provisoire est effacé.
fn place_copy(account: &Path, tmp: &Path, target: &Path) -> Result<(), String> {
    if catalog_deletion_pending(target) || !account.exists() {
        let _ = remove_with_side_files(tmp);
        return Err(SOURCE_CATALOG_DELETED.to_string());
    }
    finish_copy(tmp, target)
}

/// Met le fichier provisoire à sa place : le fichier de la source n'existe qu'une fois complet.
fn finish_copy(tmp: &Path, target: &Path) -> Result<(), String> {
    // Restes d'un fichier de la source effacé à la main : jamais mêlés à la copie neuve
    for file in side_files(target) {
        if file.exists() {
            fs::remove_file(&file).map_err(|e| sanitize_error_path(format!("Catalogue copy (cleanup): {}", e)))?;
        }
    }
    fs::rename(tmp, target).map_err(|e| sanitize_error_path(format!("Catalogue copy (rename): {}", e)))
}

/// Recopie le catalogue de la base du compte `account_db` dans le fichier `source_db` d'une source du
/// même espace, dans le dossier `dir`. Rejouable : voir l'en-tête du module.
pub fn copy_account_catalog(dir: &Path, account_db: &str, source_db: &str) -> Result<CopyReport, String> {
    validate_db_name(account_db)?;
    validate_source_catalog_name(source_db)?;
    let space = &account_db["nyxplayer_".len()..account_db.len() - ".db".len()];
    if !source_db.starts_with(&format!("nyxcat_{space}_")) {
        return Err("Catalogue copy: the source belongs to another space".to_string());
    }
    let target = catalog_db_path(dir, source_db)?;
    if target.exists() {
        // Copie déjà finie, ou catalogue déjà chargé depuis le fournisseur (même en partie : catégories
        // ou guide seuls) : jamais remplacé. Un fichier vide (ouvert trop tôt) ne compte pas : il est
        // remplacé.
        let conn = Connection::open_with_flags(&target, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|e| db_error("open source file", e))?;
        let report = report_of(&conn, true)?;
        let copied = conn
            .query_row("SELECT value FROM meta WHERE key = ?1", [COPIED_MARK], |r| r.get::<_, String>(0))
            .is_ok();
        drop(conn);
        let content = report.movies + report.series + report.live + report.categories + report.epg_programs;
        if copied || content > 0 {
            return Ok(report);
        }
        remove_with_side_files(&target)?;
    }
    let account = dir.join(account_db);
    if !account.exists() {
        return Err("Catalogue copy: no account database".to_string());
    }
    let tmp = temp_path(&target);
    let built = build_copy(&account, &tmp);
    let report = match built {
        Ok(report) => report,
        Err(e) => {
            let _ = remove_with_side_files(&tmp);
            return Err(e);
        }
    };
    place_copy(&account, &tmp, &target)?;
    log::info!(
        "[CatalogCopy] Catalogue recopié dans le fichier de la source : {} films, {} séries, {} chaînes",
        report.movies, report.series, report.live
    );
    Ok(report)
}

/// Commande : recopie le catalogue de la base du compte dans le fichier de sa première source.
/// Les écritures lourdes (chargement, guide) passent avant ou après, jamais pendant ; l'actualisation
/// de fond s'efface.
#[tauri::command]
pub async fn copy_catalog_to_source(
    app: tauri::AppHandle,
    databases: tauri::State<'_, crate::secure_db::NyxDatabases>,
    account_db_name: String,
    source_db_name: String,
) -> Result<CopyReport, String> {
    validate_db_name(&account_db_name)?;
    validate_source_catalog_name(&source_db_name)?;
    let _heavy = crate::db_activity::HeavyWriteGuard::new();
    let _turn = crate::db_activity::exclusive_write().await;
    // Un fichier de source ouvert trop tôt par la page est refermé : vide, il sera remplacé, et
    // aucune connexion ne doit rester sur l'ancien fichier
    databases.forget(&source_db_name).await;
    let dir = get_data_dir(&app);
    tokio::task::spawn_blocking(move || copy_account_catalog(&dir, &account_db_name, &source_db_name))
        .await
        .map_err(|e| format!("Catalogue copy interrupted: {}", e))?
}

#[cfg(test)]
#[path = "catalog_split_tests.rs"]
mod tests;
