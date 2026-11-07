//! Tests de l'index commun aux sources d'un espace (`fusion_index.rs`), sur des catalogues inventés.

use super::*;
use rusqlite::params;

const SPACE: &str = "550e8400-e29b-41d4-a716-446655440000";
const SOURCE_A: &str = "6a1e5c3b-9d2f-4e7a-b8c1-0d2e4f6a8b9c";
const SOURCE_B: &str = "1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d";
const SOURCE_C: &str = "0f8b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d";

fn index_name() -> String {
    format!("nyxidx_{SPACE}.db")
}

fn source(id: &str) -> IndexSource {
    IndexSource { id: id.to_string(), file: format!("nyxcat_{SPACE}_{id}.db") }
}

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("nyx-fusion-index-{}-{}", name, std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

/// Catalogue d'une source, au schéma de l'app (fichier en WAL, refermé ensuite)
fn catalogue(dir: &Path, id: &str, sql: &str) {
    let conn = crate::catalog_parser::open_connection(&dir.join(source(id).file)).unwrap();
    conn.execute_batch(sql).unwrap();
}

fn never() -> bool {
    false
}

fn dump(conn: &Connection, sql: &str) -> Vec<Vec<rusqlite::types::Value>> {
    let mut stmt = conn.prepare(sql).unwrap();
    let n = stmt.column_count();
    stmt.query_map([], |r| (0..n).map(|i| r.get(i)).collect::<rusqlite::Result<Vec<_>>>())
        .unwrap()
        .map(Result::unwrap)
        .collect()
}

fn open_index(dir: &Path) -> Connection {
    Connection::open_with_flags(dir.join(index_name()), OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap()
}

/// Tout le contenu de l'index, dans un ordre stable
fn whole_index(dir: &Path) -> Vec<Vec<Vec<rusqlite::types::Value>>> {
    let conn = open_index(dir);
    [
        "SELECT * FROM titles ORDER BY id",
        "SELECT * FROM offers ORDER BY source_id, kind, stream_id",
        "SELECT * FROM channels ORDER BY id",
        "SELECT * FROM channel_streams ORDER BY source_id, stream_id",
        "SELECT * FROM categories ORDER BY type, key",
        "SELECT * FROM category_parts ORDER BY type, source_id, category_id",
        "SELECT * FROM meta ORDER BY key",
    ]
    .iter()
    .map(|sql| dump(&conn, sql))
    .collect()
}

/// Deux fournisseurs qui proposent en partie la même chose, écrite autrement
fn two_sources(dir: &Path) {
    catalogue(
        dir,
        SOURCE_A,
        "INSERT INTO categories (id, name, type, sort_order) VALUES ('1', 'FR | Action', 'movie', 1), ('2', 'France', 'live', 1);
         INSERT INTO movies (id, tmdb_id, name, icon, category_id, added, container_extension, sort_order) VALUES
           (10, 603, 'Le Grand Départ (2018) 4K', 'a.jpg', '1', 100, 'mkv', 1),
           (11, NULL, 'Le Retour (1998)', NULL, '1', 200, 'mp4', 2),
           (12, NULL, 'Sans Année', NULL, '1', 300, 'mp4', 3);
         INSERT INTO series (id, tmdb_id, name, category_id) VALUES (20, 777, 'Une Série', NULL);
         INSERT INTO live (id, name, category_id, epg_channel_id, geo_hint) VALUES
           (30, 'Chaîne Une HD', '2', 'chaineune.fr', 'fr'),
           (31, 'Info 24', '2', NULL, NULL);",
    );
    catalogue(
        dir,
        SOURCE_B,
        "INSERT INTO categories (id, name, type, sort_order) VALUES ('7', '|FR| ACTION', 'movie', 1), ('8', 'Documentaires', 'movie', 2);
         INSERT INTO movies (id, tmdb_id, name, icon, category_id, added, container_extension, sort_order) VALUES
           (500, 603, 'Grand Depart, Le', 'b.jpg', '7', 400, 'mp4', 1),
           (501, NULL, 'Le Retour (2021)', NULL, '7', 50, 'mp4', 2),
           (502, NULL, 'Sans Année', NULL, '8', 60, 'mp4', 3);
         INSERT INTO live (id, name, category_id, epg_channel_id, geo_hint) VALUES
           (600, 'FR | Chaîne Une FHD', NULL, 'CHAINEUNE.fr', NULL),
           (601, 'Info 24', NULL, NULL, NULL);",
    );
}

fn titles_named(conn: &Connection) -> Vec<(String, i64)> {
    let mut stmt = conn.prepare("SELECT name, offer_count FROM titles ORDER BY name").unwrap();
    stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().map(Result::unwrap).collect()
}

#[test]
fn the_same_film_from_two_providers_is_one_title_with_two_offers() {
    let dir = temp_dir("merge");
    two_sources(&dir);
    let report = build_index(&dir, &index_name(), &[source(SOURCE_A), source(SOURCE_B)], &never).unwrap();
    assert_eq!(report.status, "built");
    assert!(report.missing_sources.is_empty());
    // Films : 603 réuni ; « Le Retour » de deux années différentes et les titres sans année restent à part
    assert_eq!((report.titles, report.offers), (6, 7));
    let conn = open_index(&dir);
    assert_eq!(
        titles_named(&conn),
        vec![
            ("Le Grand Départ (2018) 4K".to_string(), 2),
            ("Le Retour (1998)".to_string(), 1),
            ("Le Retour (2021)".to_string(), 1),
            ("Sans Année".to_string(), 1),
            ("Sans Année".to_string(), 1),
            ("Une Série".to_string(), 1),
        ]
    );
    // Les offres du titre réuni, dans l'ordre de priorité, avec leur qualité
    let offers = dump(
        &conn,
        "SELECT o.source_id, o.stream_id, o.quality, o.container_extension FROM offers o JOIN titles t ON t.id = o.title_id
         WHERE t.tmdb_id = 603 ORDER BY o.source_rank",
    );
    assert_eq!(offers.len(), 2);
    assert_eq!(offers[0][0], rusqlite::types::Value::Text(SOURCE_A.into()));
    assert_eq!(offers[0][2], rusqlite::types::Value::Text("4K".into()));
    assert_eq!(offers[1][1], rusqlite::types::Value::Integer(500));
    // La plus récente des dates d'ajout, l'affiche de la source prioritaire
    let (icon, added): (String, i64) =
        conn.query_row("SELECT icon, added FROM titles WHERE tmdb_id = 603", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
    assert_eq!((icon.as_str(), added), ("a.jpg", 400));
    // Chaînes : même identifiant de guide et même nom ; « Info 24 » sans pays connu reste en double
    assert_eq!((report.channels, report.streams), (3, 4));
    let streams: i64 = conn
        .query_row("SELECT stream_count FROM channels WHERE epg_id = 'chaineune.fr'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(streams, 2);
    // Catégories : « FR | Action » et « |FR| ACTION » se rejoignent, les autres gardent leur nom
    assert_eq!(report.categories, 3);
    let parts: i64 = conn
        .query_row("SELECT part_count FROM categories WHERE type = 'movie' AND name = 'FR | Action'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(parts, 2);
    let action_offers: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM offers WHERE kind = 'movie' AND category_key = (SELECT key FROM categories WHERE name = 'FR | Action')",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(action_offers, 5);
    assert!(!temp_path(&dir.join(index_name())).exists());
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn a_rebuild_gives_exactly_the_same_index() {
    let dir = temp_dir("rebuild");
    two_sources(&dir);
    let sources = [source(SOURCE_A), source(SOURCE_B)];
    build_index(&dir, &index_name(), &sources, &never).unwrap();
    let first = whole_index(&dir);
    build_index(&dir, &index_name(), &sources, &never).unwrap();
    assert_eq!(whole_index(&dir), first);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn the_priority_source_gives_the_name_and_comes_first() {
    let dir = temp_dir("priority");
    two_sources(&dir);
    build_index(&dir, &index_name(), &[source(SOURCE_B), source(SOURCE_A)], &never).unwrap();
    let conn = open_index(&dir);
    let (name, icon): (String, String) =
        conn.query_row("SELECT name, icon FROM titles WHERE tmdb_id = 603", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
    assert_eq!((name.as_str(), icon.as_str()), ("Grand Depart, Le", "b.jpg"));
    let first: String = conn
        .query_row(
            "SELECT o.source_id FROM offers o JOIN titles t ON t.id = o.title_id WHERE t.tmdb_id = 603 ORDER BY o.source_rank LIMIT 1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(first, SOURCE_B);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn a_stopped_build_leaves_the_previous_index_untouched() {
    let dir = temp_dir("stopped");
    two_sources(&dir);
    let sources = [source(SOURCE_A), source(SOURCE_B)];
    build_index(&dir, &index_name(), &sources[..1], &never).unwrap();
    let before = whole_index(&dir);
    let report = build_index(&dir, &index_name(), &sources, &|| true).unwrap();
    assert_eq!(report.status, "stopped");
    assert_eq!(whole_index(&dir), before);
    assert!(!temp_path(&dir.join(index_name())).exists());
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn a_stop_is_seen_during_a_long_read() {
    let dir = temp_dir("long");
    let conn = crate::catalog_parser::open_connection(&dir.join(source(SOURCE_A).file)).unwrap();
    for id in 1..=(CHECK_EVERY_ROWS as i64 * 2) {
        conn.execute("INSERT INTO movies (id, name) VALUES (?1, ?2)", params![id, format!("Film {id} (2000)")]).unwrap();
    }
    drop(conn);
    let asked = std::cell::Cell::new(0);
    let stop = || {
        asked.set(asked.get() + 1);
        true
    };
    let report = build_index(&dir, &index_name(), &[source(SOURCE_A)], &stop).unwrap();
    assert_eq!(report.status, "stopped");
    // Arrêt vu au premier contrôle, en pleine lecture des films
    assert_eq!(asked.get(), 1);
    assert!(!dir.join(index_name()).exists());
    assert!(!temp_path(&dir.join(index_name())).exists());
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn a_source_not_yet_loaded_or_being_deleted_is_left_out() {
    let dir = temp_dir("missing");
    two_sources(&dir);
    fs::write(dir.join(format!("{}.delete-pending", source(SOURCE_B).file)), b"").unwrap();
    let report = build_index(&dir, &index_name(), &[source(SOURCE_A), source(SOURCE_B), source(SOURCE_C)], &never).unwrap();
    assert_eq!(report.status, "built");
    assert_eq!(report.missing_sources, vec![SOURCE_B.to_string(), SOURCE_C.to_string()]);
    assert_eq!(report.offers, 4);
    // Le fichier absent n'est pas créé par la lecture
    assert!(!dir.join(source(SOURCE_C).file).exists());
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn names_outside_the_space_are_refused_before_anything_is_written() {
    let dir = temp_dir("names");
    two_sources(&dir);
    let other_space = "0f8b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2e";
    let refused: Vec<(String, Vec<IndexSource>)> = vec![
        ("../nyxidx_x.db".into(), vec![source(SOURCE_A)]),
        (format!("nyxplayer_{SPACE}.db"), vec![source(SOURCE_A)]),
        (format!("nyxcat_{SPACE}_{SOURCE_A}.db"), vec![source(SOURCE_A)]),
        (format!("nyxidx_{}.db", SPACE.to_uppercase()), vec![source(SOURCE_A)]),
        // Fichier d'un autre espace, ou qui ne correspond pas à l'identifiant donné
        (index_name(), vec![IndexSource { id: SOURCE_A.into(), file: format!("nyxcat_{other_space}_{SOURCE_A}.db") }]),
        (index_name(), vec![IndexSource { id: SOURCE_A.into(), file: source(SOURCE_B).file }]),
        (index_name(), vec![IndexSource { id: SOURCE_A.into(), file: format!("../nyxcat_{SPACE}_{SOURCE_A}.db") }]),
        (index_name(), vec![IndexSource { id: SOURCE_A.into(), file: format!("nyxplayer_{SPACE}.db") }]),
        (index_name(), vec![source(SOURCE_A), source(SOURCE_A)]),
        (index_name(), vec![source(SOURCE_A); MAX_SOURCES + 1]),
    ];
    for (index, sources) in refused {
        assert!(build_index(&dir, &index, &sources, &never).is_err(), "accepté à tort : {index} {sources:?}");
    }
    let leftovers: Vec<String> = fs::read_dir(&dir)
        .unwrap()
        .flatten()
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| !n.starts_with("nyxcat_"))
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn without_a_tmdb_sheet_nothing_is_grouped() {
    let dir = temp_dir("false-groups");
    let names = [
        "Le Retour (1998)",
        "Le Retour (2021)",
        "Le Voyage (2021)",
        "Le Voyage 2 (2021)",
        "Le Voyage (Version longue) (2021)",
        "Planète (2017)",
        "Planète 2049 (2017)",
        "The French Line (1971)",
        "The Line (1971)",
        "Le Grand Départ",
        "FR | Le Grand Départ 4K",
    ];
    let insert = |id: &str, offset: i64| {
        let conn = crate::catalog_parser::open_connection(&dir.join(source(id).file)).unwrap();
        for (i, name) in names.iter().enumerate() {
            conn.execute("INSERT INTO movies (id, name) VALUES (?1, ?2)", params![i as i64 + offset, name]).unwrap();
        }
    };
    insert(SOURCE_A, 1);
    insert(SOURCE_B, 1001);
    let report = build_index(&dir, &index_name(), &[source(SOURCE_A), source(SOURCE_B)], &never).unwrap();
    let conn = open_index(&dir);
    // Sans fiche TMDB, rien n'est réuni, même un titre et une année identiques chez les deux
    let grouped: i64 = conn.query_row("SELECT COUNT(*) FROM titles WHERE offer_count > 1", [], |r| r.get(0)).unwrap();
    assert_eq!(grouped, 0);
    let wrong: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM titles t WHERE (SELECT COUNT(DISTINCT o.stream_id % 1000) FROM offers o WHERE o.title_id = t.id) > 1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(wrong, 0);
    assert_eq!(report.titles, 2 * 11);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn an_older_file_without_some_columns_is_still_read() {
    let dir = temp_dir("older");
    let conn = Connection::open(dir.join(source(SOURCE_A).file)).unwrap();
    conn.execute_batch(
        "CREATE TABLE movies (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
         CREATE TABLE live (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
         CREATE TABLE categories (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL);
         INSERT INTO movies VALUES (1, 'Ancien (1990)');
         INSERT INTO live VALUES (2, 'FR | Info 24');
         INSERT INTO categories VALUES ('3', 'Films', 'movie');",
    )
    .unwrap();
    drop(conn);
    let report = build_index(&dir, &index_name(), &[source(SOURCE_A)], &never).unwrap();
    assert_eq!((report.titles, report.offers, report.channels, report.categories), (1, 1, 1, 1));
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn a_new_index_replaces_the_old_and_drops_a_stale_deletion_mark() {
    let dir = temp_dir("replace");
    two_sources(&dir);
    build_index(&dir, &index_name(), &[source(SOURCE_A), source(SOURCE_B)], &never).unwrap();
    fs::write(dir.join(format!("{}.delete-pending", index_name())), b"").unwrap();
    let report = build_index(&dir, &index_name(), &[source(SOURCE_A)], &never).unwrap();
    assert_eq!(report.offers, 4);
    let offers: i64 = open_index(&dir).query_row("SELECT COUNT(*) FROM offers", [], |r| r.get(0)).unwrap();
    assert_eq!(offers, 4);
    assert!(!dir.join(format!("{}.delete-pending", index_name())).exists());
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn the_sources_are_only_read() {
    let dir = temp_dir("read-only");
    two_sources(&dir);
    let file = dir.join(source(SOURCE_A).file);
    let before = fs::read(&file).unwrap();
    build_index(&dir, &index_name(), &[source(SOURCE_A)], &never).unwrap();
    assert_eq!(fs::read(&file).unwrap(), before);
    let _ = fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn no_build_starts_or_lands_while_a_space_is_being_wiped() {
    {
        let _held = hold_builds().await;
        assert!(builds_held());
        assert!(ABORT.load(Ordering::SeqCst));
        let _second = hold_builds().await;
        drop(_second);
        assert!(builds_held());
    }
    assert!(!builds_held());
}

#[test]
fn a_damaged_source_is_left_out_and_the_others_are_indexed() {
    let dir = temp_dir("damaged");
    two_sources(&dir);
    fs::write(dir.join(source(SOURCE_B).file), b"ceci n'est pas une base SQLite, juste du texte assez long pour l'en-tete").unwrap();
    let report = build_index(&dir, &index_name(), &[source(SOURCE_A), source(SOURCE_B)], &never).unwrap();
    assert_eq!(report.status, "built");
    assert_eq!(report.failed_sources, vec![SOURCE_B.to_string()]);
    assert_eq!(report.offers, 4);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn a_journal_that_cannot_be_removed_blocks_the_new_index() {
    let dir = temp_dir("held");
    two_sources(&dir);
    build_index(&dir, &index_name(), &[source(SOURCE_A)], &never).unwrap();
    // Un journal WAL qui ne s'efface pas (un dossier à sa place) : le nouvel index n'est pas posé à
    // côté de lui, où il serait rejoué et l'abîmerait
    let wal = dir.join(format!("{}-wal", index_name()));
    fs::create_dir(&wal).unwrap();
    fs::write(wal.join("x"), b"x").unwrap();
    assert!(build_index(&dir, &index_name(), &[source(SOURCE_A), source(SOURCE_B)], &never).is_err());
    assert!(!dir.join(index_name()).exists());
    assert!(!temp_path(&dir.join(index_name())).exists());
    let _ = fs::remove_dir_all(&dir);
}
