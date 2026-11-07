//! Tests de la recopie du catalogue vers le fichier de la première source (`catalog_split.rs`).

use super::*;
use rusqlite::params;

const SPACE: &str = "550e8400-e29b-41d4-a716-446655440000";
const SOURCE: &str = "6a1e5c3b-9d2f-4e7a-b8c1-0d2e4f6a8b9c";

fn account_name() -> String {
    format!("nyxplayer_{SPACE}.db")
}

fn source_name() -> String {
    format!("nyxcat_{SPACE}_{SOURCE}.db")
}

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("nyx-catalog-split-{}-{}", name, std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

/// Base du compte comme en 0.8.0 : catalogue, guide et données perso dans le même fichier
fn account_base(dir: &Path) {
    let conn = crate::catalog_parser::open_connection(&dir.join(account_name())).unwrap();
    conn.execute_batch(crate::schema::EPG_TABLES).unwrap();
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
         CREATE TABLE IF NOT EXISTS playback_progress (id INTEGER PRIMARY KEY, stream_id INTEGER, title TEXT);
         CREATE TABLE IF NOT EXISTS watchlist (stream_id INTEGER, type TEXT, PRIMARY KEY (stream_id, type));
         INSERT INTO playback_progress (stream_id, title) VALUES (1, 'Alpha');
         INSERT INTO watchlist VALUES (2, 'movie');",
    )
    .unwrap();
    for id in 1..=50i64 {
        conn.execute(
            "INSERT INTO movies (id, tmdb_id, name, category_id, container_extension, data, sort_order) VALUES (?1, ?2, ?3, '10', 'mkv', '{}', ?1)",
            params![id, id + 1000, format!("Film {id}")],
        )
        .unwrap();
    }
    conn.execute_batch(
        "INSERT INTO series (id, tmdb_id, name, category_id) VALUES (100, 2000, 'Série', '20');
         INSERT INTO live (id, name, category_id, epg_channel_id, matched_epg_id, match_method, geo_hint)
           VALUES (200, 'TF1 HD', '30', 'tf1.fr', 'tf1.fr', 'exact', 'fr');
         INSERT INTO categories (id, name, type) VALUES ('10', 'Films', 'movie'), ('30', 'France', 'live');
         INSERT INTO epg_programs VALUES ('tf1.fr', 'Journal', 100, 200, NULL);
         INSERT INTO epg_channels VALUES ('tf1.fr', 'TF1');
         INSERT INTO epg_kept_channels VALUES ('tf1.fr');
         INSERT INTO meta VALUES ('lastProvider', 'http://provider.example:8080');
         INSERT INTO meta VALUES ('last_epg_sync', '1700000000');
         INSERT INTO meta VALUES ('search_seq', '7');
         INSERT INTO meta VALUES ('catalog_auto_refresh', '1');",
    )
    .unwrap();
}

fn dump(conn: &Connection, sql: &str) -> Vec<Vec<rusqlite::types::Value>> {
    let mut stmt = conn.prepare(sql).unwrap();
    let n = stmt.column_count();
    stmt.query_map([], |r| (0..n).map(|i| r.get(i)).collect::<rusqlite::Result<Vec<_>>>())
        .unwrap()
        .map(Result::unwrap)
        .collect()
}

fn meta_of(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| r.get(0)).ok()
}

#[test]
fn the_catalogue_is_copied_identically_and_nothing_personal_leaves() {
    let dir = temp_dir("identical");
    account_base(&dir);
    let report = copy_account_catalog(&dir, &account_name(), &source_name()).unwrap();
    assert_eq!(
        report,
        CopyReport { movies: 50, series: 1, live: 1, categories: 2, epg_programs: 1, already_done: false }
    );
    let account = Connection::open(dir.join(account_name())).unwrap();
    let source = Connection::open(dir.join(source_name())).unwrap();
    for table in CATALOG_TABLES {
        let sql = format!("SELECT * FROM {table} ORDER BY 1");
        assert_eq!(dump(&source, &sql), dump(&account, &sql), "{table}");
    }
    // Notes du catalogue suivies ; recherche, réglages et données perso restent au compte
    assert_eq!(meta_of(&source, "lastProvider").as_deref(), Some("http://provider.example:8080"));
    assert_eq!(meta_of(&source, "last_epg_sync").as_deref(), Some("1700000000"));
    assert_eq!(meta_of(&source, "search_seq"), None);
    assert_eq!(meta_of(&source, "catalog_auto_refresh"), None);
    let personal: i64 = source
        .query_row("SELECT COUNT(*) FROM sqlite_master WHERE name IN ('playback_progress', 'watchlist')", [], |r| r.get(0))
        .unwrap();
    assert_eq!(personal, 0);
    // La base du compte n'est pas touchée (retour possible à la version précédente)
    assert_eq!(dump(&account, "SELECT COUNT(*) FROM movies"), vec![vec![rusqlite::types::Value::Integer(50)]]);
    assert_eq!(dump(&account, "SELECT COUNT(*) FROM playback_progress"), vec![vec![rusqlite::types::Value::Integer(1)]]);
    // Rien de provisoire ne reste à côté
    assert!(!temp_path(&dir.join(source_name())).exists());
    // Le fichier se lit ensuite comme un fichier rempli par le chargement
    drop(source);
    let reopened = crate::catalog_parser::open_connection(&dir.join(source_name())).unwrap();
    assert!(crate::catalog_refresh::check_provider(&reopened, "http://provider.example:8080").is_ok());
    drop((account, reopened));
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn replaying_a_finished_copy_changes_nothing() {
    let dir = temp_dir("replay");
    account_base(&dir);
    copy_account_catalog(&dir, &account_name(), &source_name()).unwrap();
    // Le fichier de la source vit sa vie (actualisation) : une nouvelle recopie ne l'écrase pas
    let source = Connection::open(dir.join(source_name())).unwrap();
    source.execute("DELETE FROM movies WHERE id > 40", []).unwrap();
    drop(source);
    let again = copy_account_catalog(&dir, &account_name(), &source_name()).unwrap();
    assert!(again.already_done);
    assert_eq!(again.movies, 40);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn a_copy_cut_before_the_rename_leaves_no_source_file_and_is_redone() {
    let dir = temp_dir("cut");
    account_base(&dir);
    let target = dir.join(source_name());
    let tmp = temp_path(&target);
    // Coupure après l'écriture du fichier provisoire, avant le renommage
    build_copy(&dir.join(account_name()), &tmp).unwrap();
    assert!(tmp.exists());
    assert!(!target.exists());
    // Coupure en pleine écriture : fichier provisoire tronqué, journal resté à côté
    fs::write(&tmp, b"SQLite format 3\0 tronque").unwrap();
    fs::write(side_files(&tmp)[0].clone(), b"x").unwrap();
    let report = copy_account_catalog(&dir, &account_name(), &source_name()).unwrap();
    assert!(!report.already_done);
    assert_eq!(report.movies, 50);
    assert!(!tmp.exists());
    assert!(!side_files(&tmp)[0].exists());
    let source = Connection::open(&target).unwrap();
    assert_eq!(meta_of(&source, COPIED_MARK).as_deref(), Some("1"));
    drop(source);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn a_failed_copy_leaves_nothing_behind() {
    let dir = temp_dir("failed");
    // Base du compte illisible : erreur, aucun fichier de source, aucun reste
    fs::write(dir.join(account_name()), b"pas une base").unwrap();
    assert!(copy_account_catalog(&dir, &account_name(), &source_name()).is_err());
    assert!(!dir.join(source_name()).exists());
    assert!(!temp_path(&dir.join(source_name())).exists());
    // Pas de base du compte du tout : rien à recopier
    fs::remove_file(dir.join(account_name())).unwrap();
    assert!(copy_account_catalog(&dir, &account_name(), &source_name()).is_err());
    assert!(!dir.join(source_name()).exists());
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn an_older_account_base_without_the_guide_is_copied_too() {
    let dir = temp_dir("older");
    // Base ancienne : sans tables du guide, sans les colonnes ajoutées depuis
    let conn = Connection::open(dir.join(account_name())).unwrap();
    conn.execute_batch(
        "CREATE TABLE movies (id INTEGER PRIMARY KEY, tmdb_id INTEGER, name TEXT NOT NULL, icon TEXT, category_id TEXT, added INTEGER, rating REAL, data TEXT);
         INSERT INTO movies (id, name) VALUES (1, 'Alpha'), (2, 'Bravo');",
    )
    .unwrap();
    drop(conn);
    let report = copy_account_catalog(&dir, &account_name(), &source_name()).unwrap();
    assert_eq!((report.movies, report.series, report.epg_programs), (2, 0, 0));
    let source = Connection::open(dir.join(source_name())).unwrap();
    let sort: i64 = source.query_row("SELECT sort_order FROM movies WHERE id = 1", [], |r| r.get(0)).unwrap();
    assert_eq!(sort, 0);
    drop(source);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn only_a_source_of_the_same_space_and_never_a_deleted_one() {
    let dir = temp_dir("guards");
    account_base(&dir);
    let other = "0f8b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d";
    for (account, source) in [
        (account_name(), format!("nyxcat_{other}_{SOURCE}.db")),
        (account_name(), "../x.db".to_string()),
        (format!("nyxplayer_{other}.db"), source_name()),
        (source_name(), source_name()),
        (account_name(), account_name()),
    ] {
        assert!(copy_account_catalog(&dir, &account, &source).is_err(), "{account} → {source}");
    }
    fs::write(dir.join(format!("{}.delete-pending", source_name())), b"").unwrap();
    assert_eq!(
        copy_account_catalog(&dir, &account_name(), &source_name()).unwrap_err(),
        crate::storage::SOURCE_CATALOG_DELETED
    );
    assert!(!dir.join(source_name()).exists());
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn a_source_deleted_or_a_space_reset_during_the_copy_gets_no_file() {
    let dir = temp_dir("deleted-during");
    account_base(&dir);
    let account = dir.join(account_name());
    let target = dir.join(source_name());
    let tmp = temp_path(&target);
    // Source supprimée pendant la recopie
    build_copy(&account, &tmp).unwrap();
    fs::write(dir.join(format!("{}.delete-pending", source_name())), b"").unwrap();
    assert_eq!(place_copy(&account, &tmp, &target).unwrap_err(), crate::storage::SOURCE_CATALOG_DELETED);
    assert!(!target.exists());
    assert!(!tmp.exists());
    // Espace réinitialisé pendant la recopie : base du compte partie
    fs::remove_file(dir.join(format!("{}.delete-pending", source_name()))).unwrap();
    build_copy(&account, &tmp).unwrap();
    fs::remove_file(&account).unwrap();
    assert!(place_copy(&account, &tmp, &target).is_err());
    assert!(!target.exists());
    assert!(!tmp.exists());
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn an_empty_source_file_opened_too_early_does_not_count_as_copied() {
    let dir = temp_dir("empty-target");
    account_base(&dir);
    // Fichier de la source créé vide (ouvert avant la recopie)
    drop(crate::catalog_parser::open_connection(&dir.join(source_name())).unwrap());
    let report = copy_account_catalog(&dir, &account_name(), &source_name()).unwrap();
    assert!(!report.already_done);
    assert_eq!(report.movies, 50);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn a_folder_with_spaces_and_accents_and_a_base_still_in_its_wal_journal() {
    let dir = temp_dir("dossier de données é");
    account_base(&dir);
    // Écritures restées dans le journal WAL de la base du compte, connexion encore ouverte
    let writer = Connection::open(dir.join(account_name())).unwrap();
    writer.execute_batch("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;").unwrap();
    writer.execute("INSERT INTO movies (id, name) VALUES (999, 'Dans le journal')", []).unwrap();
    let report = copy_account_catalog(&dir, &account_name(), &source_name()).unwrap();
    assert_eq!(report.movies, 51);
    drop(writer);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn guide_tables_without_indexes_match_the_schema() {
    let a = Connection::open_in_memory().unwrap();
    let b = Connection::open_in_memory().unwrap();
    a.execute_batch(EPG_TABLES_WITHOUT_INDEXES).unwrap();
    b.execute_batch(crate::schema::EPG_TABLES).unwrap();
    for table in ["epg_programs", "epg_channels", "epg_kept_channels"] {
        let sql = format!("SELECT name, type, \"notnull\", dflt_value, pk FROM pragma_table_info('{table}')");
        assert_eq!(dump(&a, &sql), dump(&b, &sql), "{table}");
    }
}

#[test]
fn a_source_file_with_only_categories_or_guide_is_never_replaced() {
    let dir = temp_dir("partial-target");
    account_base(&dir);
    let conn = crate::catalog_parser::open_connection(&dir.join(source_name())).unwrap();
    conn.execute("INSERT INTO categories (id, name, type) VALUES ('1', 'Seule', 'movie')", []).unwrap();
    drop(conn);
    let report = copy_account_catalog(&dir, &account_name(), &source_name()).unwrap();
    assert!(report.already_done);
    assert_eq!((report.movies, report.categories), (0, 1));
    let _ = fs::remove_dir_all(&dir);
}
