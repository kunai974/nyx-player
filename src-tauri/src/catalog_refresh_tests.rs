//! Tests de l'actualisation par comparaison (`catalog_refresh.rs`), sur des bases en mémoire et de
//! petits catalogues écrits dans des fichiers temporaires.
//!
//! Le test central est l'**équivalence** : écriture complète de A puis actualisation vers B donne
//! exactement les mêmes tables que l'écriture complète de B.

use super::*;
use crate::catalog_parser::{insert_categories, insert_live, insert_movies, insert_series};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::cell::Cell;
use std::io::Write;
use std::sync::atomic::AtomicUsize;

const HOST: &str = "http://provider.test:8080";

fn never() -> Option<Stop> {
    None
}

fn db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(crate::schema::CATALOG_TABLES).unwrap();
    conn.execute_batch(crate::schema::EPG_TABLES).unwrap();
    conn.execute_batch(
        "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
         CREATE TABLE xtream_series_cache (series_id INTEGER PRIMARY KEY, data TEXT NOT NULL, cached_at INTEGER NOT NULL, ttl_seconds INTEGER NOT NULL);
         CREATE TABLE playback_progress (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            content_type TEXT NOT NULL CHECK(content_type IN ('movie', 'episode')),
            stream_id INTEGER NOT NULL, tmdb_id INTEGER DEFAULT 0, title TEXT NOT NULL,
            time_seconds REAL NOT NULL, duration_seconds REAL NOT NULL, updated_at INTEGER NOT NULL,
            container_extension TEXT, UNIQUE(stream_id));",
    )
    .unwrap();
    conn
}

/// Fichier temporaire unique, supprimé à la fin du test
struct TempList(PathBuf);

impl Drop for TempList {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn temp_path() -> PathBuf {
    static N: AtomicUsize = AtomicUsize::new(0);
    std::env::temp_dir().join(format!(
        "nyx_catalog_refresh_test_{}_{}.json",
        std::process::id(),
        N.fetch_add(1, Ordering::SeqCst)
    ))
}

fn write_raw(content: &[u8]) -> TempList {
    let path = temp_path();
    std::fs::write(&path, content).unwrap();
    TempList(path)
}

fn write_list(items: &[Value]) -> TempList {
    write_raw(serde_json::to_string(items).unwrap().as_bytes())
}

fn write_gzip(items: &[Value]) -> TempList {
    let path = temp_path();
    let mut enc = flate2::write::GzEncoder::new(std::fs::File::create(&path).unwrap(), flate2::Compression::default());
    enc.write_all(serde_json::to_string(items).unwrap().as_bytes()).unwrap();
    enc.finish().unwrap();
    TempList(path)
}

fn movie(id: i64, name: &str, tmdb: Option<i64>) -> Value {
    json!({
        "stream_id": id, "name": name, "stream_icon": format!("http://img/{}.jpg", id),
        "category_id": "10", "tmdb": tmdb.map(|t| t.to_string()), "added": "1700000000",
        "rating": "7.5", "container_extension": "mkv"
    })
}

fn serie(id: i64, name: &str, tmdb: Option<i64>, modified: &str) -> Value {
    json!({
        "series_id": id, "name": name, "cover": "http://img/s.jpg", "category_id": "20",
        "tmdb": tmdb, "last_modified": modified, "rating": "8"
    })
}

fn channel(id: i64, name: &str, epg: &str, cat: &str) -> Value {
    json!({ "stream_id": id, "name": name, "stream_icon": "http://img/c.png", "category_id": cat, "epg_channel_id": epg })
}

fn category(id: &str, name: &str) -> Value {
    json!({ "category_id": id, "category_name": name })
}

fn parse<T: serde::de::DeserializeOwned>(items: &[Value]) -> Vec<T> {
    items.iter().map(|v| serde_json::from_value(v.clone()).unwrap()).collect()
}

/// Écriture complète, comme `ingest_catalog` (sans les garde-fous, déjà testés à part)
fn full_write(conn: &mut Connection, movies: &[Value], series: &[Value], live: &[Value], cats: [&[Value]; 3]) {
    let tx = conn.transaction().unwrap();
    tx.execute("DELETE FROM movies", []).unwrap();
    tx.execute("DELETE FROM series", []).unwrap();
    tx.execute("DELETE FROM live", []).unwrap();
    insert_movies(&tx, &parse::<XtreamMovie>(movies)).unwrap();
    insert_series(&tx, &parse::<XtreamSeries>(series)).unwrap();
    insert_live(&tx, &parse::<XtreamLive>(live)).unwrap();
    for (kind, list) in [("movie", cats[0]), ("series", cats[1]), ("live", cats[2])] {
        if !list.is_empty() {
            tx.execute("DELETE FROM categories WHERE type = ?1", params![kind]).unwrap();
        }
    }
    insert_categories(&tx, &parse(cats[0]), &parse(cats[1]), &parse(cats[2])).unwrap();
    tx.commit().unwrap();
}

fn apply(conn: &mut Connection, kind: Kind, items: &[Value], mode: Mode) -> ListSummary {
    let file = write_list(items);
    apply_list_file(conn, kind, &file.0, mode, HOST, &never).unwrap()
}

fn apply_cats(conn: &mut Connection, cats: [&[Value]; 3]) -> ListSummary {
    apply_categories(conn, HOST, &parse(cats[0]), &parse(cats[1]), &parse(cats[2]), &never).unwrap()
}

fn dump(conn: &Connection, sql: &str) -> Vec<Vec<SqlValue>> {
    let mut stmt = conn.prepare(sql).unwrap();
    let n = stmt.column_count();
    stmt.query_map([], |r| (0..n).map(|i| r.get::<_, SqlValue>(i)).collect::<rusqlite::Result<Vec<_>>>())
        .unwrap()
        .map(Result::unwrap)
        .collect()
}

fn tables(conn: &Connection) -> Vec<Vec<Vec<SqlValue>>> {
    vec![
        dump(conn, "SELECT * FROM movies ORDER BY id"),
        dump(conn, "SELECT * FROM series ORDER BY id"),
        dump(conn, "SELECT id, name, icon, category_id, epg_channel_id, geo_hint, data, sort_order FROM live ORDER BY id"),
        dump(conn, "SELECT * FROM categories ORDER BY type, id"),
    ]
}

fn meta(conn: &Connection, key: &str) -> Option<String> {
    meta_get(conn, key).unwrap()
}

fn count(conn: &Connection, sql: &str) -> i64 {
    conn.query_row(sql, [], |r| r.get(0)).unwrap()
}

// ---------------------------------------------------------------------------------------------
// Catalogues A et B
// ---------------------------------------------------------------------------------------------

/// Films, séries, chaînes, et catégories (films, séries, chaînes)
type Catalog = (Vec<Value>, Vec<Value>, Vec<Value>, [Vec<Value>; 3]);

fn catalog_a() -> Catalog {
    let movies = vec![
        movie(1, "Alpha", Some(101)),
        movie(2, "Bravo", Some(102)),
        movie(3, "Charlie", None),
        movie(4, "Delta", Some(104)),
        movie(2, "Bravo (doublon)", Some(102)), // doublon : le dernier gagne
    ];
    let series = vec![serie(10, "Série Un", Some(201), "100"), serie(11, "Série Deux", Some(202), "100")];
    let live = vec![
        channel(20, "|FR| TF1 HD", "tf1.fr", "30"),
        channel(21, "FR| France 2", "", "30"),
        channel(22, "Canal Info", "canalinfo", "31"),
    ];
    let cats = [
        vec![category("10", "Films")],
        vec![category("20", "Séries")],
        vec![category("30", "France"), category("31", "Infos")],
    ];
    (movies, series, live, cats)
}

fn catalog_b() -> Catalog {
    let mut m5 = movie(5, "Echo", Some(105));
    m5["rating"] = json!("6.1");
    let mut m1 = movie(1, "Alpha", Some(101));
    m1["stream_icon"] = json!("http://img/1-new.jpg"); // modifié
    let movies = vec![
        m5, // ajout en tête : tout le monde se décale
        m1,
        movie(2, "Bravo", Some(102)),
        movie(6, "Delta", Some(104)), // Delta renuméroté 4 → 6
        movie(2, "Bravo final", Some(102)),
        // Charlie (3) disparu
    ];
    let series = vec![serie(11, "Série Deux", Some(202), "200"), serie(12, "Série Trois", Some(203), "100")];
    let live = vec![
        channel(22, "Canal Info", "canalinfo", "31"),
        channel(20, "|FR| TF1 HD", "tf1.fr", "30"),
        channel(23, "M6", "m6.fr", "30"),
    ];
    let cats = [
        vec![category("10", "Films"), category("11", "Nouveautés")],
        vec![category("20", "Séries")],
        vec![category("30", "France TNT"), category("31", "Infos")],
    ];
    (movies, series, live, cats)
}

fn refresh_to(conn: &mut Connection, b: &Catalog, mode: Mode) {
    apply_cats(conn, [&b.3[0], &b.3[1], &b.3[2]]);
    apply(conn, Kind::Movies, &b.0, mode);
    apply(conn, Kind::Series, &b.1, mode);
    apply(conn, Kind::Live, &b.2, mode);
}

// ---------------------------------------------------------------------------------------------
// Équivalence
// ---------------------------------------------------------------------------------------------

#[test]
fn diff_refresh_equals_full_write() {
    let (a, b) = (catalog_a(), catalog_b());
    let mut expected = db();
    full_write(&mut expected, &b.0, &b.1, &b.2, [&b.3[0], &b.3[1], &b.3[2]]);

    let mut conn = db();
    full_write(&mut conn, &a.0, &a.1, &a.2, [&a.3[0], &a.3[1], &a.3[2]]);
    refresh_to(&mut conn, &b, Mode::Manual);

    assert_eq!(tables(&conn), tables(&expected));
}

#[test]
fn diff_refresh_equals_full_write_with_gzip_and_shared_category_ids() {
    let (a, mut b) = (catalog_a(), catalog_b());
    // Même numéro de catégorie pour un film et une chaîne : les deux restent
    b.3[2].push(category("10", "Chaînes 10"));
    let mut expected = db();
    full_write(&mut expected, &b.0, &b.1, &b.2, [&b.3[0], &b.3[1], &b.3[2]]);

    let mut conn = db();
    full_write(&mut conn, &a.0, &a.1, &a.2, [&a.3[0], &a.3[1], &a.3[2]]);
    apply_cats(&mut conn, [&b.3[0], &b.3[1], &b.3[2]]);
    for (kind, items) in [(Kind::Movies, &b.0), (Kind::Series, &b.1), (Kind::Live, &b.2)] {
        let file = write_gzip(items);
        apply_list_file(&mut conn, kind, &file.0, Mode::Manual, HOST, &never).unwrap();
    }
    assert_eq!(tables(&conn), tables(&expected));
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM categories WHERE id = '10'"), 2);

    // Rien de changé ensuite, même avec des numéros partagés entre types
    let again = apply_cats(&mut conn, [&b.3[0], &b.3[1], &b.3[2]]);
    assert_eq!(again.outcome, Outcome::Unchanged);
}

#[test]
fn nothing_changed_writes_nothing_even_with_duplicates() {
    let a = catalog_a();
    let mut conn = db();
    full_write(&mut conn, &a.0, &a.1, &a.2, [&a.3[0], &a.3[1], &a.3[2]]);
    assert_eq!(apply_cats(&mut conn, [&a.3[0], &a.3[1], &a.3[2]]).outcome, Outcome::Unchanged);
    for (kind, items) in [(Kind::Movies, &a.0), (Kind::Series, &a.1), (Kind::Live, &a.2)] {
        let s = apply(&mut conn, kind, items, Mode::Auto);
        assert_eq!(s.outcome, Outcome::Unchanged, "{:?}", kind);
        assert_eq!((s.added, s.changed, s.moved, s.removed), (0, 0, 0, 0));
    }
    assert_eq!(meta(&conn, "catalog_changes_seq"), None);
    assert_eq!(meta(&conn, "search_dirty"), None);
}

#[test]
fn prepend_counts_moves_not_changes() {
    let a = catalog_a();
    let mut conn = db();
    full_write(&mut conn, &a.0, &a.1, &a.2, [&a.3[0], &a.3[1], &a.3[2]]);
    let mut shifted = vec![movie(9, "Nouveau", Some(109))];
    shifted.extend(a.0.iter().cloned());
    let s = apply(&mut conn, Kind::Movies, &shifted, Mode::Auto);
    assert_eq!((s.added, s.changed, s.new_items), (1, 0, 1));
    // Alpha, Charlie, Delta et Bravo (dont la dernière occurrence passe de 4 à 5)
    assert_eq!(s.moved, 4);
}

#[test]
fn counts_and_notes_after_a_refresh() {
    let (a, b) = (catalog_a(), catalog_b());
    let mut conn = db();
    full_write(&mut conn, &a.0, &a.1, &a.2, [&a.3[0], &a.3[1], &a.3[2]]);
    conn.execute("INSERT INTO xtream_series_cache VALUES (11, '{}', 0, 86400), (10, '{}', 0, 86400)", []).unwrap();

    // Manuel : sur 4 films, Charlie seul disparu dépasse déjà le seuil de 20 % de l'automatique
    let m = apply(&mut conn, Kind::Movies, &b.0, Mode::Manual);
    // Echo et Delta (6) ajoutés, Alpha et Bravo modifiés, Delta (4) et Charlie disparus
    assert_eq!((m.added, m.changed, m.removed), (2, 2, 2));
    // Echo est nouveau ; Delta seulement renuméroté (même TMDB) n'en est pas un
    assert_eq!(m.new_items, 1);
    assert_eq!(m.outcome, Outcome::Applied);

    let s = apply(&mut conn, Kind::Series, &b.1, Mode::Manual);
    assert_eq!((s.added, s.changed, s.removed), (1, 1, 1));
    // Épisodes de la série 11 changés, série 10 retirée : leur liste d'épisodes est oubliée
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM xtream_series_cache"), 0);

    let seq: i64 = meta(&conn, "catalog_changes_seq").unwrap().parse().unwrap();
    assert!(seq >= 2);
    assert_eq!(meta(&conn, "search_dirty").as_deref(), Some("1"));
    let pending: HashMap<String, Vec<i64>> = serde_json::from_str(&meta(&conn, "search_pending").unwrap()).unwrap();
    let mut movies_touched = pending["movie"].clone();
    movies_touched.sort();
    // Ajouts, suppressions, et Bravo dont le nom a changé ; pas Alpha (seul le logo a changé)
    assert_eq!(movies_touched, vec![2, 3, 4, 5, 6]);
    assert_eq!(pending["series"].len(), 2);
}

#[test]
fn search_note_turns_into_full_rebuild_above_the_cap() {
    let mut conn = db();
    let items: Vec<Value> = (0..(SEARCH_PENDING_CAP as i64 + 10)).map(|i| movie(i, &format!("Film {}", i), None)).collect();
    let s = apply(&mut conn, Kind::Movies, &items, Mode::Auto);
    assert_eq!(s.added, items.len());
    assert_eq!(meta(&conn, "search_pending").as_deref(), Some("all"));
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM movies"), items.len() as i64);
}

// ---------------------------------------------------------------------------------------------
// Disparus : renumérotés et perdus
// ---------------------------------------------------------------------------------------------

fn ten_movies() -> Vec<Value> {
    (1..=10).map(|i| movie(i, &format!("Film {}", i), Some(100 + i))).collect()
}

#[test]
fn many_lost_titles_are_kept_in_auto_mode() {
    let mut conn = db();
    apply(&mut conn, Kind::Movies, &ten_movies(), Mode::Auto);
    // 3 titres sur 10 disparaissent sans remplaçant (30 %)
    let s = apply(&mut conn, Kind::Movies, &ten_movies()[3..], Mode::Auto);
    assert!(s.removal_skipped);
    assert_eq!(s.removed, 0);
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM movies"), 10);
    assert_eq!(meta(&conn, "catalog_manual_advised").as_deref(), Some("1"));
}

#[test]
fn a_few_lost_titles_are_removed_in_auto_mode() {
    let mut conn = db();
    apply(&mut conn, Kind::Movies, &ten_movies(), Mode::Auto);
    let s = apply(&mut conn, Kind::Movies, &ten_movies()[1..], Mode::Auto);
    assert!(!s.removal_skipped);
    assert_eq!(s.removed, 1);
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM movies"), 9);
}

#[test]
fn manual_mode_removes_every_lost_title() {
    let mut conn = db();
    apply(&mut conn, Kind::Movies, &ten_movies(), Mode::Auto);
    let s = apply(&mut conn, Kind::Movies, &ten_movies()[5..], Mode::Manual);
    assert_eq!(s.removed, 5);
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM movies"), 5);
}

#[test]
fn full_renumbering_is_applied_without_duplicates_or_news() {
    let mut conn = db();
    apply(&mut conn, Kind::Movies, &ten_movies(), Mode::Auto);
    let renumbered: Vec<Value> = (1..=10).map(|i| movie(1000 + i, &format!("Film {}", i), Some(100 + i))).collect();
    let s = apply(&mut conn, Kind::Movies, &renumbered, Mode::Auto);
    assert!(!s.removal_skipped);
    assert_eq!((s.added, s.removed, s.new_items), (10, 10, 0));
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM movies"), 10);
    assert_eq!(count(&conn, "SELECT MIN(id) FROM movies"), 1001);
}

#[test]
fn interrupted_renumbering_is_finished_by_the_next_run() {
    let mut conn = db();
    let many: Vec<Value> = (1..=5000).map(|i| movie(i, &format!("Film {}", i), Some(100_000 + i))).collect();
    apply(&mut conn, Kind::Movies, &many, Mode::Auto);
    let renumbered: Vec<Value> = (1..=5000).map(|i| movie(10_000 + i, &format!("Film {}", i), Some(100_000 + i))).collect();

    // Arrêt après le premier paquet écrit (3 vérifications en passe 1, 1 au début de la passe 2,
    // 1 avant l'écriture du premier paquet)
    let calls = Cell::new(0);
    let stop_after_first_batch = || {
        calls.set(calls.get() + 1);
        if calls.get() > 5 { Some(Stop::Aborted) } else { None }
    };
    let file = write_list(&renumbered);
    let err = apply_list_file(&mut conn, Kind::Movies, &file.0, Mode::Auto, HOST, &stop_after_first_batch).unwrap_err();
    assert!(matches!(err, ApplyError::Stopped(Stop::Aborted)));
    let partial = count(&conn, "SELECT COUNT(*) FROM movies");
    assert!(partial > 5000 && partial < 10_000, "{}", partial);

    // La fois suivante : plus aucun doublon
    let s = apply_list_file(&mut conn, Kind::Movies, &file.0, Mode::Auto, HOST, &never).unwrap();
    assert!(!s.removal_skipped);
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM movies"), 5000);
    assert_eq!(count(&conn, "SELECT MIN(id) FROM movies"), 10_001);
}

#[test]
fn interrupted_refresh_then_next_run_equals_full_write() {
    let a: Vec<Value> = (1..=4500).map(|i| movie(i, &format!("Film {}", i), Some(i))).collect();
    let mut b: Vec<Value> = (1..=4500).rev().map(|i| movie(i, &format!("Film {} v2", i), Some(i))).collect();
    b.push(movie(9999, "Dernier", None));
    let mut expected = db();
    full_write(&mut expected, &b, &[], &[], [&[], &[], &[]]);

    let mut conn = db();
    full_write(&mut conn, &a, &[], &[], [&[], &[], &[]]);
    let calls = Cell::new(0);
    let stop_soon = || {
        calls.set(calls.get() + 1);
        if calls.get() > 5 { Some(Stop::Aborted) } else { None }
    };
    let file = write_list(&b);
    assert!(apply_list_file(&mut conn, Kind::Movies, &file.0, Mode::Auto, HOST, &stop_soon).is_err());
    let seq_after_stop = meta(&conn, "catalog_changes_seq");
    assert!(seq_after_stop.is_some(), "écritures déjà faites notées");
    apply_list_file(&mut conn, Kind::Movies, &file.0, Mode::Auto, HOST, &never).unwrap();
    assert_eq!(tables(&conn)[0], tables(&expected)[0]);
}

// ---------------------------------------------------------------------------------------------
// Garde-fous et listes illisibles
// ---------------------------------------------------------------------------------------------

#[test]
fn empty_list_keeps_the_table() {
    let mut conn = db();
    apply(&mut conn, Kind::Movies, &ten_movies(), Mode::Auto);
    let s = apply(&mut conn, Kind::Movies, &[], Mode::Manual);
    assert_eq!(s.outcome, Outcome::Kept);
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM movies"), 10);
}

#[test]
fn tmdb_drop_keeps_the_table() {
    let mut conn = db();
    apply(&mut conn, Kind::Movies, &ten_movies(), Mode::Auto);
    let degraded: Vec<Value> = (1..=10).map(|i| movie(i, &format!("Film {}", i), if i < 3 { Some(100 + i) } else { None })).collect();
    let s = apply(&mut conn, Kind::Movies, &degraded, Mode::Manual);
    assert_eq!(s.outcome, Outcome::Kept);
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM movies WHERE tmdb_id > 0"), 10);
}

#[test]
fn truncated_error_or_mostly_unreadable_lists_write_nothing() {
    let mut conn = db();
    apply(&mut conn, Kind::Movies, &ten_movies(), Mode::Auto);
    let before = tables(&conn);

    let full = serde_json::to_string(&ten_movies()).unwrap();
    let truncated = write_raw(&full.as_bytes()[..full.len() / 2]);
    let error_object = write_raw(br#"{"user_info":{"auth":0}}"#);
    let mut mostly_bad = ten_movies();
    mostly_bad.push(json!({ "stream_id": "pas un nombre", "name": 1 }));
    let bad = write_list(&mostly_bad);

    for file in [&truncated, &error_object, &bad] {
        let err = apply_list_file(&mut conn, Kind::Movies, &file.0, Mode::Manual, HOST, &never).unwrap_err();
        assert!(matches!(err, ApplyError::Failed(_)));
    }
    assert_eq!(tables(&conn), before);
}

/// Liste envoyée comme objet à clés numériques, ou précédée d'avertissements PHP (compressée ou non) :
/// l'actualisation écrit la même chose qu'avec la liste ordinaire.
#[test]
fn a_list_as_an_object_or_after_php_notices_is_refreshed_like_a_plain_list() {
    let mut expected = db();
    apply(&mut expected, Kind::Movies, &ten_movies(), Mode::Manual);

    // Écrit à la main : l'ordre reçu est gardé (un `serde_json::Map` trierait les clés)
    let entries: Vec<String> =
        ten_movies().iter().enumerate().map(|(i, m)| format!("\"{}\":{}", i * 3, m)).collect();
    let object_file = write_raw(format!("{{{}}}", entries.join(",")).as_bytes());
    let notice = "<br />\n<b>Deprecated</b>: x in <b>/wwwdir/player_api.php</b><br />\n";
    let notice_file = write_raw(format!("{}{}", notice, serde_json::to_string(&ten_movies()).unwrap()).as_bytes());
    let gz_path = temp_path();
    let mut enc = flate2::write::GzEncoder::new(std::fs::File::create(&gz_path).unwrap(), flate2::Compression::default());
    enc.write_all(format!("{}{}", notice, serde_json::to_string(&ten_movies()).unwrap()).as_bytes()).unwrap();
    enc.finish().unwrap();
    let gz_file = TempList(gz_path);

    for file in [&object_file, &notice_file, &gz_file] {
        let mut conn = db();
        apply_list_file(&mut conn, Kind::Movies, &file.0, Mode::Manual, HOST, &never).unwrap();
        assert_eq!(tables(&conn), tables(&expected));
    }

    // Page web contenant du JSON : toujours un échec, rien n'est écrit
    let mut conn = db();
    apply(&mut conn, Kind::Movies, &ten_movies(), Mode::Auto);
    let before = tables(&conn);
    let page = write_raw(br#"<!DOCTYPE html><html><body>[{"stream_id":1,"name":"x"}]</body></html>"#);
    let err = apply_list_file(&mut conn, Kind::Movies, &page.0, Mode::Manual, HOST, &never).unwrap_err();
    assert!(matches!(err, ApplyError::Failed(_)));
    assert_eq!(tables(&conn), before);
}

#[test]
fn a_list_over_the_item_cap_writes_nothing() {
    // Même plafond d'éléments que la connexion, lisibles ou non
    let mut conn = db();
    apply(&mut conn, Kind::Movies, &ten_movies(), Mode::Auto);
    let before = tables(&conn);
    let mut body = String::from("[");
    body.push_str(&vec!["0"; 500_001].join(","));
    body.push(']');
    let file = write_raw(body.as_bytes());
    let (result, peak) = crate::test_alloc::peak_during(|| {
        apply_list_file(&mut conn, Kind::Movies, &file.0, Mode::Manual, HOST, &never).map(|s| s.skipped_items)
    });
    assert!(matches!(result, Err(ApplyError::Failed(e)) if e.contains("more than")));
    assert!(peak < 8 * 1024 * 1024, "peak {}", peak);
    assert_eq!(tables(&conn), before);

    // Plafond propre à chaque type : 200 000 chaînes passent, une de plus non
    let channels = |n: i64| (1..=n).map(|i| json!({ "stream_id": i })).collect::<Vec<Value>>();
    let at_cap = write_list(&channels(200_000));
    assert!(apply_list_file(&mut conn, Kind::Live, &at_cap.0, Mode::Manual, HOST, &never).is_ok());
    let over = write_list(&channels(200_001));
    let err = apply_list_file(&mut conn, Kind::Live, &over.0, Mode::Manual, HOST, &never).unwrap_err();
    assert!(matches!(err, ApplyError::Failed(e) if e == "more than 200000 items"));
}

#[test]
fn an_item_over_the_size_cap_is_unreadable_in_the_refresh_too() {
    let mut conn = db();
    let mut items: Vec<Value> = (1..=200).map(|i| movie(i, &format!("Film {}", i), Some(i))).collect();
    apply(&mut conn, Kind::Movies, &items, Mode::Auto);
    items[6]["plot"] = json!("x".repeat(crate::catalog_parser::MAX_ITEM_BYTES));
    let s = apply(&mut conn, Kind::Movies, &items, Mode::Auto);
    assert_eq!(s.skipped_items, 1);
}

#[test]
fn unreadable_item_with_a_readable_id_keeps_its_row() {
    let mut conn = db();
    let mut items: Vec<Value> = (1..=200).map(|i| movie(i, &format!("Film {}", i), Some(i))).collect();
    apply(&mut conn, Kind::Movies, &items, Mode::Auto);
    // Le fournisseur envoie un objet au lieu d'un nom pour le film 7 (une note en nombre, elle, est
    // lue désormais : voir `number_where_text_expected_is_read`)
    items[6]["name"] = json!({ "fr": "Film 7" });
    let s = apply(&mut conn, Kind::Movies, &items, Mode::Manual);
    assert_eq!(s.skipped_items, 1);
    assert_eq!(s.removed, 0);
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM movies WHERE id = 7"), 1);
}

#[test]
fn number_where_text_expected_is_read() {
    // `"rating": 7.5` ou `"category_id": 3` au lieu d'un texte rendaient le film illisible
    let mut conn = db();
    let mut items: Vec<Value> = (1..=10).map(|i| movie(i, &format!("Film {}", i), Some(i))).collect();
    items[6]["rating"] = json!(6.5);
    items[6]["category_id"] = json!(3);
    items[6]["added"] = json!(1_700_000_000);
    let s = apply(&mut conn, Kind::Movies, &items, Mode::Manual);
    assert_eq!(s.skipped_items, 0);
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM movies WHERE id = 7 AND rating = 6.5 AND category_id = '3' AND added = 1700000000"), 1);
}

#[test]
fn provider_change_stops_before_writing() {
    let mut conn = db();
    meta_set(&conn, "lastProvider", "http://other.test").unwrap();
    let file = write_list(&ten_movies());
    let err = apply_list_file(&mut conn, Kind::Movies, &file.0, Mode::Auto, HOST, &never).unwrap_err();
    assert!(matches!(err, ApplyError::Stopped(Stop::ProviderChanged)));
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM movies"), 0);

    // Valeur absente ou identique : même fournisseur
    meta_set(&conn, "lastProvider", HOST).unwrap();
    assert!(apply_list_file(&mut conn, Kind::Movies, &file.0, Mode::Auto, HOST, &never).is_ok());
}

#[test]
fn busy_stop_before_first_write() {
    let mut conn = db();
    let file = write_list(&ten_movies());
    let busy = || Some(Stop::Busy);
    let err = apply_list_file(&mut conn, Kind::Movies, &file.0, Mode::Auto, HOST, &busy).unwrap_err();
    assert!(matches!(err, ApplyError::Stopped(Stop::Busy)));
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM movies"), 0);
}

// ---------------------------------------------------------------------------------------------
// Catégories
// ---------------------------------------------------------------------------------------------

#[test]
fn empty_category_type_is_kept() {
    let a = catalog_a();
    let mut conn = db();
    apply_cats(&mut conn, [&a.3[0], &a.3[1], &a.3[2]]);
    let s = apply_cats(&mut conn, [&a.3[0], &[], &[]]);
    assert_eq!(s.outcome, Outcome::Unchanged);
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM categories WHERE type = 'live'"), 2);
    let all_empty = apply_cats(&mut conn, [&[], &[], &[]]);
    assert_eq!(all_empty.outcome, Outcome::Kept);
}

/// Fournisseur qui numérote chaque type à part (retour du 02/11 : chaînes visibles, films et
/// séries vides) : écriture complète puis actualisation gardent les catégories des trois types.
#[test]
fn categories_numbered_per_type_are_all_kept() {
    let per_type = |name: &str| vec![category("1", &format!("{name} 1")), category("2", &format!("{name} 2"))];
    let (movies, series, live) = (per_type("Films"), per_type("Séries"), per_type("Chaînes"));
    let mut conn = db();
    full_write(&mut conn, &[], &[], &[], [&movies, &series, &live]);
    for kind in ["movie", "series", "live"] {
        assert_eq!(count(&conn, &format!("SELECT COUNT(*) FROM categories WHERE type = '{kind}'")), 2, "{kind}");
    }
    assert_eq!(apply_cats(&mut conn, [&movies, &series, &live]).outcome, Outcome::Unchanged);

    let renamed = vec![category("1", "Films 1 bis"), category("2", "Films 2")];
    let s = apply_cats(&mut conn, [&renamed, &series, &live]);
    assert_eq!((s.outcome, s.changed, s.removed), (Outcome::Applied, 1, 0));
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM categories"), 6);
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM categories WHERE type = 'live' AND name = 'Chaînes 1'"), 1);
}

#[test]
fn renamed_live_category_marks_its_channels_for_the_guide() {
    let a = catalog_a();
    let mut conn = db();
    full_write(&mut conn, &a.0, &a.1, &a.2, [&a.3[0], &a.3[1], &a.3[2]]);
    conn.execute("UPDATE live SET matched_epg_id = 'x', match_method = 'Passe 1'", []).unwrap();
    let renamed = vec![category("30", "France TNT"), category("31", "Infos")];
    apply_cats(&mut conn, [&a.3[0], &a.3[1], &renamed]);
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM live WHERE match_method = '__pending' AND matched_epg_id IS NULL"), 2);
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM live WHERE id = 22 AND match_method = 'Passe 1'"), 1);
}

// ---------------------------------------------------------------------------------------------
// Liens du guide
// ---------------------------------------------------------------------------------------------

fn guide(conn: &Connection) {
    conn.execute_batch(
        "INSERT INTO epg_channels (id, display_name) VALUES
           ('tf1.fr', 'TF1'), ('m6.fr', 'M6'), ('france2.fr', 'France 2'), ('canalinfo', 'Canal Info');",
    )
    .unwrap();
}

fn changes_seq(conn: &Connection) -> i64 {
    count(conn, "SELECT COALESCE(CAST((SELECT value FROM meta WHERE key = 'catalog_changes_seq') AS INTEGER), 0)")
}

fn links(conn: &Connection) -> Vec<Vec<SqlValue>> {
    dump(conn, "SELECT id, matched_epg_id, match_method FROM live ORDER BY id")
}

#[test]
fn only_changed_channels_are_relinked_and_the_result_matches_a_full_mapping() {
    let (a, b) = (catalog_a(), catalog_b());
    let mut conn = db();
    guide(&conn);
    full_write(&mut conn, &a.0, &a.1, &a.2, [&a.3[0], &a.3[1], &a.3[2]]);
    crate::epg_parser::build_epg_mapping(&conn, None);
    // Lien d'une chaîne inchangée : gardé tel quel (pas recalculé)
    conn.execute("UPDATE live SET match_method = 'gardé' WHERE id = 22", []).unwrap();

    let mut icon_only = b.2.clone();
    icon_only[1]["stream_icon"] = json!("http://img/tf1-new.png");
    refresh_to(&mut conn, &(b.0.clone(), b.1.clone(), icon_only.clone(), b.3.clone()), Mode::Manual);
    // Nouvelle chaîne M6 notée ; TF1 aussi (sa catégorie 30 a été renommée)
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM live WHERE match_method = '__pending'"), 2);
    let seq_before = changes_seq(&conn);
    let linked = link_pending_channels(&conn, 0);
    assert_eq!(linked, 2);
    // Liens écrits après les paquets : la page est prévenue de relire les chaînes
    assert_eq!(changes_seq(&conn), seq_before + 1);
    // Rien en attente : compteur inchangé
    assert_eq!(link_pending_channels(&conn, 0), 0);
    assert_eq!(changes_seq(&conn), seq_before + 1);
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM live WHERE match_method = '__pending'"), 0);
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM live WHERE id = 22 AND match_method = 'gardé'"), 1);

    // Même résultat qu'un calcul complet pour les chaînes reliées ici
    let mut full = db();
    guide(&full);
    full_write(&mut full, &b.0, &b.1, &icon_only, [&b.3[0], &b.3[1], &b.3[2]]);
    crate::epg_parser::build_epg_mapping(&full, None);
    let (got, want) = (links(&conn), links(&full));
    for id in [20, 23] {
        let row = |l: &Vec<Vec<SqlValue>>| l.iter().find(|r| r[0] == SqlValue::Integer(id)).cloned();
        assert_eq!(row(&got), row(&want), "chaîne {}", id);
    }
}

#[test]
fn icon_change_keeps_the_guide_link() {
    let a = catalog_a();
    let mut conn = db();
    full_write(&mut conn, &a.0, &a.1, &a.2, [&a.3[0], &a.3[1], &a.3[2]]);
    conn.execute("UPDATE live SET matched_epg_id = 'tf1.fr', match_method = 'Passe 1'", []).unwrap();
    let mut changed = a.2.clone();
    changed[0]["stream_icon"] = json!("http://img/autre.png");
    let s = apply(&mut conn, Kind::Live, &changed, Mode::Auto);
    assert_eq!(s.changed, 1);
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM live WHERE match_method = 'Passe 1'"), 3);
}

#[test]
fn empty_guide_clears_pending_marks() {
    let a = catalog_a();
    let mut conn = db();
    apply(&mut conn, Kind::Live, &a.2, Mode::Auto);
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM live WHERE match_method = '__pending'"), 3);
    assert_eq!(link_pending_channels(&conn, 0), 0);
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM live WHERE match_method IS NOT NULL"), 0);
}

#[test]
fn guide_reload_brake() {
    let conn = db();
    guide(&conn);
    conn.execute_batch(
        "INSERT INTO meta VALUES ('epg_filtered', '1'), ('last_epg_sync', '1000');
         INSERT INTO epg_kept_channels VALUES ('tf1.fr');
         INSERT INTO live (id, name, matched_epg_id) VALUES (1, 'TF1', 'tf1.fr'), (2, 'M6', 'm6.fr');",
    )
    .unwrap();
    let hour = 3600 * 1000;
    // Une chaîne sans programmes, guide récent : pas de rechargement, compte noté
    assert!(!crate::epg_parser::flag_guide_if_many_links_lack_programs(&conn, 1000 + hour, 20, 24 * hour));
    assert_eq!(meta(&conn, "epg_missing_links").as_deref(), Some("1"));
    assert_eq!(meta(&conn, "epg_needs_resync"), None);
    // Guide de plus de 24 h : rechargement
    assert!(crate::epg_parser::flag_guide_if_many_links_lack_programs(&conn, 1000 + 25 * hour, 20, 24 * hour));
    assert_eq!(meta(&conn, "epg_needs_resync").as_deref(), Some("1"));
    // Seuil atteint : rechargement même avec un guide récent
    conn.execute("DELETE FROM meta WHERE key = 'epg_needs_resync'", []).unwrap();
    assert!(crate::epg_parser::flag_guide_if_many_links_lack_programs(&conn, 1000 + hour, 1, 24 * hour));
}

// ---------------------------------------------------------------------------------------------
// Reprises de lecture
// ---------------------------------------------------------------------------------------------

fn progress(conn: &Connection, kind: &str, stream: i64, tmdb: i64, updated: i64) {
    conn.execute(
        "INSERT INTO playback_progress (content_type, stream_id, tmdb_id, title, time_seconds, duration_seconds, updated_at, container_extension)
         VALUES (?1, ?2, ?3, 'Titre', 60, 3600, ?4, 'avi')",
        params![kind, stream, tmdb, updated],
    )
    .unwrap();
}

#[test]
fn orphan_progress_follows_the_renumbered_movie() {
    let mut conn = db();
    apply(
        &mut conn,
        Kind::Movies,
        &[movie(50, "Version A", Some(777)), movie(51, "Version B", Some(777)), movie(60, "Autre", Some(888))],
        Mode::Auto,
    );
    progress(&conn, "movie", 5, 777, 10); // orpheline, même TMDB que 50 et 51
    progress(&conn, "movie", 6, 999, 10); // orpheline sans remplaçant : gardée
    progress(&conn, "movie", 7, 888, 30); // orpheline, mais 60 a déjà une reprise plus ancienne
    progress(&conn, "movie", 60, 888, 20);
    let relinks = relink_orphan_progress(&mut conn);
    // Plusieurs versions : la dernière dans l'ordre d'affichage (51)
    assert!(relinks.contains(&ProgressRelink { from: 5, to: 51 }));
    assert!(relinks.contains(&ProgressRelink { from: 7, to: 60 }));
    assert_eq!(relinks.len(), 2);
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM playback_progress WHERE stream_id = 51 AND container_extension = 'mkv'"), 1);
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM playback_progress WHERE stream_id = 6"), 1);
    // La plus récente gagne
    assert_eq!(count(&conn, "SELECT updated_at FROM playback_progress WHERE stream_id = 60"), 30);
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM playback_progress"), 3);
}

#[test]
fn orphan_progress_never_takes_an_episode_slot() {
    let mut conn = db();
    apply(&mut conn, Kind::Movies, &[movie(50, "Film", Some(777))], Mode::Auto);
    progress(&conn, "movie", 5, 777, 10);
    progress(&conn, "episode", 50, 0, 5);
    assert!(relink_orphan_progress(&mut conn).is_empty());
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM playback_progress"), 2);
}

#[test]
fn search_pending_is_readable_by_the_page() {
    // Même forme que celle lue par searchIndex.ts (applySearchDelta)
    let conn = db();
    note_search_changes(&conn, Kind::Live, &[3, 4]).unwrap();
    note_search_changes(&conn, Kind::Movies, &[1]).unwrap();
    let pending: Value = serde_json::from_str(&meta(&conn, "search_pending").unwrap()).unwrap();
    assert_eq!(pending["live"], json!([3, 4]));
    assert_eq!(pending["movie"], json!([1]));
    assert_eq!(meta(&conn, "search_seq").as_deref(), Some("2"));
}

#[test]
fn abort_is_kept_even_when_requested_before_the_run_starts() {
    let run = ABORT_UP_TO.load(Ordering::SeqCst) + 1_000_000;
    abort_catalog_refresh(run);
    assert_eq!(stop_reason(run), Some(Stop::Aborted));
    assert_eq!(stop_reason(run - 1), Some(Stop::Aborted));
    assert_ne!(stop_reason(run + 1), Some(Stop::Aborted));
}

#[test]
fn list_selection() {
    assert_eq!(parse_lists(&None), vec!["categories", "movies", "series", "live"]);
    assert_eq!(parse_lists(&Some(vec!["live".into(), "movies".into()])), vec!["movies", "live"]);
    assert_eq!(parse_lists(&Some(vec![])), vec!["categories", "movies", "series", "live"]);
}

#[test]
fn guarded_reader_stops_on_size_and_on_request() {
    use std::io::Read;
    let stopped = std::rc::Rc::new(std::cell::Cell::new(None));
    let never = || None;
    // Au-delà de la limite : erreur (une « bombe » compressée ne remplit pas la mémoire)
    let mut big = GuardedReader {
        inner: std::io::repeat(b' ').take(10_000),
        read: 0,
        limit: 4_096,
        next_check: CHECK_EVERY_BYTES,
        should_stop: &never,
        stopped: stopped.clone(),
    };
    let mut out = Vec::new();
    assert!(big.read_to_end(&mut out).is_err());
    assert!(stopped.get().is_none());
}

#[test]
fn stop_is_seen_inside_a_huge_element() {
    // « [ » suivi de 20 Mo d'espaces : aucun élément lu, l'arrêt passe quand même
    let mut body = vec![b'['];
    body.extend(std::iter::repeat_n(b' ', 20 * 1024 * 1024));
    body.push(b']');
    let file = write_raw(&body);
    let mut conn = db();
    // Premier contrôle par élément (index 0) évité : l'arrêt n'est demandé qu'après 1 Mo lu
    let calls = std::cell::Cell::new(0);
    let stop = || {
        calls.set(calls.get() + 1);
        if calls.get() > 1 { Some(Stop::Aborted) } else { None }
    };
    let result = apply_list_file(&mut conn, Kind::Live, &file.0, Mode::Auto, HOST, &stop);
    assert!(matches!(result, Err(ApplyError::Stopped(Stop::Aborted))), "{:?}", result.err());
}

// ---------------------------------------------------------------------------------------------
// Enrichissement TMDB et « Ma liste » : jamais touchés par le catalogue
// ---------------------------------------------------------------------------------------------

const DB_CORE_TS: &str = include_str!("../../src/services/dbCore.ts");

/// Schéma créé par la page pour chaque compte (`const MERGED_SCHEMA = `…`;` dans dbCore.ts), lu
/// dans son code : `tmdb_details_cache` et `watchlist` sont ici exactement celles de l'app
/// (`playback_progress`, déjà créée par `db()`, garde la définition de ce fichier).
fn page_schema() -> &'static str {
    let marker = "const MERGED_SCHEMA = `";
    let start = DB_CORE_TS
        .find(marker)
        .expect("MERGED_SCHEMA introuvable dans dbCore.ts : le test doit suivre le schéma de la page")
        + marker.len();
    let end = start + DB_CORE_TS[start..].find('`').expect("fin de MERGED_SCHEMA introuvable");
    &DB_CORE_TS[start..end]
}

/// Base de test (`db()`), complétée par le schéma de la page ; les tables déjà créées par `db()`
/// sont gardées (`IF NOT EXISTS`).
fn db_with_page_tables() -> Connection {
    let conn = db();
    conn.execute_batch(page_schema()).expect("schéma de dbCore.ts");
    for table in ["tmdb_details_cache", "watchlist"] {
        assert_eq!(count(&conn, &format!("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = '{}'", table)), 1);
    }
    conn
}

fn cache_row(conn: &Connection, tmdb: i64, kind: &str, season: i64, name: &str) {
    conn.execute(
        "INSERT INTO tmdb_details_cache (tmdb_id, type, season_number, display_name, display_date, poster_path,
            backdrop_path, overview, vote_average, number_of_seasons, full_data, cached_at, ttl_seconds, is_referenced)
         VALUES (?1, ?2, ?3, ?4, '2001-05-16', '/p.jpg', '/b.jpg', 'Résumé', 7.25, NULL, ?5, 1700000000000, 604800, 1)",
        params![tmdb, kind, season, name, format!("{{\"id\":{},\"title\":\"{}\"}}", tmdb, name)],
    )
    .unwrap();
}

fn watch_row(conn: &Connection, stream: i64, tmdb: i64, kind: &str) {
    conn.execute(
        "INSERT INTO watchlist (stream_id, tmdb_id, type, added_at, updated_at) VALUES (?1, ?2, ?3, 1700000000001, 1700000000002)",
        params![stream, tmdb, kind],
    )
    .unwrap();
}

/// Toutes les colonnes des données personnelles, dans un ordre stable
fn personal_data(conn: &Connection) -> Vec<Vec<Vec<SqlValue>>> {
    vec![
        dump(conn, "SELECT * FROM tmdb_details_cache ORDER BY tmdb_id, type, season_number"),
        dump(conn, "SELECT * FROM watchlist ORDER BY stream_id, type"),
        dump(conn, "SELECT * FROM playback_progress ORDER BY id"),
    ]
}

/// Chargement complet puis actualisation (un film renuméroté, moins de la moitié des numéros TMDB
/// perdus, un numéro corrigé) : le cache TMDB, « Ma liste » et une reprise non concernée restent
/// identiques colonne par colonne ; `movies.tmdb_id` suit le fournisseur.
///
/// L'écriture complète passe par `full_write`, image de `write_catalog` (ingestion.rs, privée à
/// son module) : mêmes tables vidées et mêmes fonctions d'insertion. L'actualisation est la vraie
/// (`apply_list_file`).
#[test]
fn full_load_then_refresh_keep_tmdb_cache_and_watchlist() {
    let mut conn = db_with_page_tables();
    let cats: [&[Value]; 3] = [&[category("10", "Films")], &[category("20", "Séries")], &[]];
    let series = vec![serie(10, "Série Un", Some(201), "100"), serie(11, "Série Deux", Some(202), "100")];

    // Données personnelles déjà là (compte en service)
    cache_row(&conn, 104, "movie", 0, "Film 4");
    cache_row(&conn, 109, "movie", 0, "Film 9");
    cache_row(&conn, 110, "movie", 0, "Film 10");
    cache_row(&conn, 201, "series", 0, "Série Un");
    cache_row(&conn, 201, "season", 1, "Saison 1");
    watch_row(&conn, 3, 103, "movie");
    watch_row(&conn, 4, 104, "movie"); // film bientôt renuméroté
    watch_row(&conn, 9, 109, "movie"); // film qui va perdre son numéro TMDB
    watch_row(&conn, 10, 201, "series");
    progress(&conn, "movie", 1, 101, 10); // reprise d'un film qui ne change pas
    let before = personal_data(&conn);
    assert_eq!(before[0].len(), 5);
    assert_eq!(before[1].len(), 4);

    // Chargement complet
    full_write(&mut conn, &ten_movies(), &series, &[], cats);
    assert_eq!(personal_data(&conn), before, "chargement complet");

    // Actualisation : 4 → 40 (même titre, même TMDB), 7, 8 et 9 perdent leur numéro TMDB
    // (3 sur 10 : sous le seuil du garde-fou), 10 passe de 110 à 555
    let refreshed: Vec<Value> = (1..=10)
        .map(|i| match i {
            4 => movie(40, "Film 4", Some(104)),
            7..=9 => movie(i, &format!("Film {}", i), None),
            10 => movie(10, "Film 10", Some(555)),
            _ => movie(i, &format!("Film {}", i), Some(100 + i)),
        })
        .collect();
    apply_cats(&mut conn, cats);
    let s = apply(&mut conn, Kind::Movies, &refreshed, Mode::Auto);
    assert_eq!(s.outcome, Outcome::Applied);
    assert!(!s.removal_skipped);
    assert_eq!(apply(&mut conn, Kind::Series, &series, Mode::Auto).outcome, Outcome::Unchanged);
    assert_eq!(personal_data(&conn), before, "actualisation");

    let mut stmt = conn.prepare("SELECT id, tmdb_id FROM movies ORDER BY id").unwrap();
    let tmdb: Vec<(i64, Option<i64>)> = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().map(Result::unwrap).collect();
    assert_eq!(
        tmdb,
        vec![
            (1, Some(101)),
            (2, Some(102)),
            (3, Some(103)),
            (5, Some(105)),
            (6, Some(106)),
            (7, None),
            (8, None),
            (9, None),
            (10, Some(555)),
            (40, Some(104)),
        ]
    );
}

// ---------------------------------------------------------------------------------------------
// Fichier catalogue d'une source
// ---------------------------------------------------------------------------------------------

const SOURCE_FILE: &str = "nyxcat_550e8400-e29b-41d4-a716-446655440000_6a1e5c3b-9d2f-4e7a-b8c1-0d2e4f6a8b9c.db";

fn source_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("nyx-refresh-source-{}-{}", name, std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn refresh_works_on_a_source_file_without_any_personal_table() {
    let dir = source_dir("diff");
    let path = dir.join(SOURCE_FILE);
    let (a, b) = (catalog_a(), catalog_b());
    // Fichier tel que le chargement le crée : tables du catalogue seulement
    let mut first = crate::catalog_parser::open_connection(&path).unwrap();
    full_write(&mut first, &a.0, &a.1, &a.2, [&a.3[0], &a.3[1], &a.3[2]]);
    drop(first);
    let mut conn = open_refresh_connection(&path).unwrap();
    // Séries disparues : leur cache de détails (table perso, absente ici) n'empêche rien
    refresh_to(&mut conn, &b, Mode::Manual);
    let mut expected = db();
    full_write(&mut expected, &b.0, &b.1, &b.2, [&b.3[0], &b.3[1], &b.3[2]]);
    assert_eq!(tables(&conn), tables(&expected));
    let personal = count(&conn, "SELECT COUNT(*) FROM sqlite_master WHERE name IN ('playback_progress', 'xtream_series_cache', 'watchlist')");
    assert_eq!(personal, 0);
    drop(conn);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn refresh_never_recreates_the_file_of_a_deleted_source() {
    let dir = source_dir("deleted");
    let path = dir.join(SOURCE_FILE);
    std::fs::write(dir.join(format!("{SOURCE_FILE}.delete-pending")), b"").unwrap();
    assert!(open_refresh_connection(&path).is_err());
    assert!(!path.exists());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn an_odd_secondary_field_keeps_the_existing_row_untouched() {
    // Hoquet du fournisseur : affiche et catégorie en liste vide pour le film 7. Lu (le titre reste
    // visible à la connexion), mais la ligne en place garde ses bonnes valeurs au lieu de les perdre.
    let mut conn = db();
    let mut items: Vec<Value> = (1..=10).map(|i| movie(i, &format!("Film {}", i), Some(i))).collect();
    apply(&mut conn, Kind::Movies, &items, Mode::Auto);
    items[6]["stream_icon"] = json!([]);
    items[6]["category_id"] = json!({});
    // Nouveau film arrivé avec un champ de forme inattendue : ajouté sans ce champ
    let mut new_one = movie(11, "Film 11", Some(11));
    new_one["stream_icon"] = json!([]);
    items.push(new_one);
    let s = apply(&mut conn, Kind::Movies, &items, Mode::Manual);
    assert_eq!(s.skipped_items, 0);
    assert_eq!((s.removed, s.changed, s.added), (0, 0, 1));
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM movies WHERE id = 7 AND icon = 'http://img/7.jpg' AND category_id = '10'"), 1);
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM movies WHERE id = 11 AND icon IS NULL AND category_id = '10'"), 1);
}

#[test]
fn an_unreadable_item_with_a_float_id_keeps_its_row() {
    // Numéro écrit 7.0 sur un élément illisible (nom en objet) : sa ligne est gardée, comme avec 7
    let mut conn = db();
    let mut items: Vec<Value> = (1..=200).map(|i| movie(i, &format!("Film {}", i), Some(i))).collect();
    apply(&mut conn, Kind::Movies, &items, Mode::Auto);
    items[6]["stream_id"] = json!(7.0);
    items[6]["name"] = json!({ "fr": "Film 7" });
    let s = apply(&mut conn, Kind::Movies, &items, Mode::Manual);
    assert_eq!((s.skipped_items, s.removed), (1, 0));
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM movies WHERE id = 7"), 1);
}
