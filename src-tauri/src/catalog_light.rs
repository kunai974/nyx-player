//! Lecture compacte du catalogue pour le démarrage.
//!
//! Avant : à chaque entrée dans un profil, le frontend lisait les tables `movies`, `series`, `live`
//! et `categories` en entier par `tauri-plugin-sql` : une ligne = un objet JSON avec le nom de chaque
//! colonne et l'adresse complète de l'affiche (≈ 290 000 lignes, des dizaines de Mo à fabriquer,
//! transmettre et relire ; ≈ 6 s mesurées sur un téléphone). Puis il découpait les adresses en
//! « début commun + fin » (registre des préfixes, `buildLightIndexesFromSQLite`).
//!
//! Ici : mêmes requêtes, même ordre (`ORDER BY sort_order ASC`), et le même découpage des adresses,
//! fait une seule fois côté natif. Le résultat part en colonnes (un tableau par champ), sans noms de
//! colonne répétés ni adresses complètes. Le frontend reconstruit exactement les mêmes index
//! (`buildLightIndexesFromCatalog`, contrôle d'identité dans la version de mesure).
//!
//! Règles reproduites À L'IDENTIQUE du frontend (src/utils/lightIndexBuilder.ts) :
//! - préfixe d'une adresse = tout jusqu'au dernier `/` inclus ; adresse sans `/` : pas de préfixe ;
//! - registre = préfixes non vides, triés par fréquence décroissante, à égalité dans l'ordre de
//!   première apparition (le tri de JavaScript est stable), en parcourant films, séries puis chaînes ;
//! - adresse vide : préfixe -1, fin vide ; adresse sans préfixe : préfixe -1, fin = adresse entière.
//!
//! Les autres valeurs sont transmises telles quelles (null compris) : les valeurs par défaut
//! (`|| ''`, `|| 0`) et le filtre des identifiants 0 restent appliqués côté frontend, comme avant.

use rusqlite::{types::ValueRef, Connection, OpenFlags};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use tauri::Manager;

use crate::storage::{sanitize_error_path, validate_catalog_db_name};

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MovieColumns {
    id: Vec<i64>,
    name: Vec<Value>,
    icon_prefix_id: Vec<i32>,
    icon_suffix: Vec<String>,
    tmdb_id: Vec<Value>,
    category_id: Vec<Value>,
    added: Vec<Value>,
    container_extension: Vec<Value>,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SeriesColumns {
    id: Vec<i64>,
    name: Vec<Value>,
    icon_prefix_id: Vec<i32>,
    icon_suffix: Vec<String>,
    tmdb_id: Vec<Value>,
    category_id: Vec<Value>,
    added: Vec<Value>,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LiveColumns {
    id: Vec<i64>,
    name: Vec<Value>,
    icon_prefix_id: Vec<i32>,
    icon_suffix: Vec<String>,
    category_id: Vec<Value>,
    epg_channel_id: Vec<Value>,
    matched_epg_id: Vec<Value>,
    match_method: Vec<Value>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LightCatalog {
    icon_prefixes: Vec<String>,
    movies: MovieColumns,
    series: SeriesColumns,
    live: LiveColumns,
    /// [id, name, type] par catégorie, dans l'ordre `sort_order`
    categories: Vec<[Value; 3]>,
}

/// Valeur SQLite → JSON, sans conversion de type (null reste null).
fn to_json(v: ValueRef<'_>) -> Value {
    match v {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => Value::from(i),
        ValueRef::Real(f) => Value::from(f),
        ValueRef::Text(t) => Value::from(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(_) => Value::Null,
    }
}

/// Préfixe (jusqu'au dernier `/` inclus) ; None si vide ou sans `/` (règle du frontend).
fn prefix_of(url: &str) -> Option<&str> {
    if url.is_empty() {
        return None;
    }
    url.rfind('/').map(|i| &url[..=i]).filter(|p| !p.is_empty())
}

/// Registre des préfixes : fréquence décroissante, puis ordre de première apparition.
fn build_prefix_registry<'a>(urls: impl Iterator<Item = &'a str>) -> (Vec<String>, HashMap<String, i32>) {
    let mut order: Vec<(String, usize)> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    for url in urls {
        if let Some(p) = prefix_of(url) {
            match index.get(p) {
                Some(&i) => order[i].1 += 1,
                None => {
                    index.insert(p.to_string(), order.len());
                    order.push((p.to_string(), 1));
                }
            }
        }
    }
    // Tri stable : à fréquence égale, l'ordre de première apparition est conservé
    order.sort_by_key(|entry| std::cmp::Reverse(entry.1));
    let prefixes: Vec<String> = order.into_iter().map(|(p, _)| p).collect();
    let ids = prefixes.iter().enumerate().map(|(i, p)| (p.clone(), i as i32)).collect();
    (prefixes, ids)
}

/// Adresse → (identifiant du préfixe, fin), règle `internIcon` du frontend.
fn intern(url: &str, ids: &HashMap<String, i32>) -> (i32, String) {
    if url.is_empty() {
        return (-1, String::new());
    }
    match prefix_of(url).and_then(|p| ids.get(p).map(|&id| (id, p.len()))) {
        Some((id, len)) => (id, url[len..].to_string()),
        None => (-1, url.to_string()),
    }
}

fn text(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}

/// Lit le catalogue (même requêtes et même ordre que movieRepository / seriesRepository /
/// liveRepository / categoryRepository) et le met en colonnes.
pub fn read_catalog(conn: &Connection) -> Result<LightCatalog, String> {
    let err = |e: rusqlite::Error| sanitize_error_path(format!("Lecture du catalogue impossible : {}", e));

    // Lignes brutes, dans l'ordre d'affichage
    let mut movies_raw: Vec<[Value; 7]> = Vec::new();
    {
        let mut stmt = conn
            .prepare("SELECT id, tmdb_id, name, icon, category_id, added, container_extension FROM movies ORDER BY sort_order ASC")
            .map_err(err)?;
        let mut rows = stmt.query([]).map_err(err)?;
        while let Some(r) = rows.next().map_err(err)? {
            movies_raw.push(std::array::from_fn(|i| to_json(r.get_ref(i).unwrap_or(ValueRef::Null))));
        }
    }
    let mut series_raw: Vec<[Value; 6]> = Vec::new();
    {
        let mut stmt = conn
            .prepare("SELECT id, tmdb_id, name, icon, category_id, added FROM series ORDER BY sort_order ASC")
            .map_err(err)?;
        let mut rows = stmt.query([]).map_err(err)?;
        while let Some(r) = rows.next().map_err(err)? {
            series_raw.push(std::array::from_fn(|i| to_json(r.get_ref(i).unwrap_or(ValueRef::Null))));
        }
    }
    let mut live_raw: Vec<[Value; 7]> = Vec::new();
    {
        let mut stmt = conn
            .prepare("SELECT id, name, icon, category_id, epg_channel_id, matched_epg_id, match_method FROM live ORDER BY sort_order ASC")
            .map_err(err)?;
        let mut rows = stmt.query([]).map_err(err)?;
        while let Some(r) = rows.next().map_err(err)? {
            live_raw.push(std::array::from_fn(|i| to_json(r.get_ref(i).unwrap_or(ValueRef::Null))));
        }
    }
    let mut categories: Vec<[Value; 3]> = Vec::new();
    {
        let mut stmt = conn
            .prepare("SELECT id, name, type FROM categories ORDER BY sort_order ASC")
            .map_err(err)?;
        let mut rows = stmt.query([]).map_err(err)?;
        while let Some(r) = rows.next().map_err(err)? {
            categories.push(std::array::from_fn(|i| to_json(r.get_ref(i).unwrap_or(ValueRef::Null))));
        }
    }

    // Registre des préfixes sur toutes les adresses : films, séries, puis chaînes (ordre du frontend)
    let urls = movies_raw.iter().map(|m| text(&m[3]))
        .chain(series_raw.iter().map(|s| text(&s[3])))
        .chain(live_raw.iter().map(|l| text(&l[2])));
    let (icon_prefixes, ids) = build_prefix_registry(urls);

    let id_of = |v: &Value| v.as_i64().unwrap_or(0);

    let mut movies = MovieColumns::default();
    for [id, tmdb, name, icon, cat, added, ext] in movies_raw {
        let (p, s) = intern(text(&icon), &ids);
        movies.id.push(id_of(&id));
        movies.name.push(name);
        movies.icon_prefix_id.push(p);
        movies.icon_suffix.push(s);
        movies.tmdb_id.push(tmdb);
        movies.category_id.push(cat);
        movies.added.push(added);
        movies.container_extension.push(ext);
    }
    let mut series = SeriesColumns::default();
    for [id, tmdb, name, icon, cat, added] in series_raw {
        let (p, s) = intern(text(&icon), &ids);
        series.id.push(id_of(&id));
        series.name.push(name);
        series.icon_prefix_id.push(p);
        series.icon_suffix.push(s);
        series.tmdb_id.push(tmdb);
        series.category_id.push(cat);
        series.added.push(added);
    }
    let mut live = LiveColumns::default();
    for [id, name, icon, cat, epg, matched, method] in live_raw {
        let (p, s) = intern(text(&icon), &ids);
        live.id.push(id_of(&id));
        live.name.push(name);
        live.icon_prefix_id.push(p);
        live.icon_suffix.push(s);
        live.category_id.push(cat);
        live.epg_channel_id.push(epg);
        live.matched_epg_id.push(matched);
        live.match_method.push(method);
    }

    Ok(LightCatalog { icon_prefixes, movies, series, live, categories })
}

/// Attente maximale d'une base occupée. La synchro écrit pendant cette lecture à la reprise :
/// sans attente, un `SQLITE_BUSY` passager faisait retomber le frontend sur l'ancienne lecture ligne
/// à ligne, bien plus lente. Court : au-delà, cette lecture de secours reste le
/// bon choix.
const BUSY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

/// Connexion en lecture seule qui attend une base momentanément occupée au lieu d'échouer.
fn open_read_only(path: &std::path::Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)?;
    conn.busy_timeout(BUSY_TIMEOUT)?;
    Ok(conn)
}

/// Commande : catalogue compact, en lecture seule, de la base du compte (`nyxplayer_<uid>.db`) ou
/// du fichier catalogue d'une source (`nyxcat_<espace>_<source>.db`).
#[tauri::command]
pub async fn load_light_catalog(app: tauri::AppHandle, db_name: String) -> Result<LightCatalog, String> {
    validate_catalog_db_name(&db_name)?;
    let db_path = app
        .path()
        .app_data_dir()
        .map_err(|e| sanitize_error_path(format!("Dossier des données introuvable : {}", e)))?
        .join(&db_name);
    tokio::task::spawn_blocking(move || {
        let conn = open_read_only(&db_path)
            .map_err(|e| sanitize_error_path(format!("Ouverture de la base impossible : {}", e)))?;
        read_catalog(&conn)
    })
    .await
    .map_err(|e| format!("Lecture du catalogue interrompue : {}", e))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefix_rules_match_the_frontend() {
        assert_eq!(prefix_of(""), None);
        assert_eq!(prefix_of("sans-barre.jpg"), None);
        assert_eq!(prefix_of("http://a.com/img/x.jpg"), Some("http://a.com/img/"));
        assert_eq!(prefix_of("/x.jpg"), Some("/"));
    }

    #[test]
    fn registry_sorted_by_frequency_then_first_seen() {
        let urls = ["http://b/1.jpg", "http://a/1.jpg", "http://a/2.jpg", "http://c/1.jpg", "http://b/2.jpg", "", "x.jpg"];
        let (prefixes, ids) = build_prefix_registry(urls.iter().copied());
        // a et b : 2 chacun ; b vu en premier → b avant a ; c : 1
        assert_eq!(prefixes, vec!["http://b/", "http://a/", "http://c/"]);
        assert_eq!(intern("http://a/2.jpg", &ids), (1, "2.jpg".to_string()));
        assert_eq!(intern("x.jpg", &ids), (-1, "x.jpg".to_string()));
        assert_eq!(intern("", &ids), (-1, String::new()));
    }

    #[test]
    fn read_only_connection_waits_for_a_busy_database() {
        let path = std::env::temp_dir().join(format!("nyx_catalog_light_busy_{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        Connection::open(&path).unwrap().execute_batch(crate::schema::CATALOG_TABLES).unwrap();

        let conn = open_read_only(&path).unwrap();
        let timeout: i64 = conn.pragma_query_value(None, "busy_timeout", |row| row.get(0)).unwrap();
        assert_eq!(timeout, BUSY_TIMEOUT.as_millis() as i64);

        // Écriture en cours sur une base sans WAL : la lecture attend puis réussit au lieu d'échouer
        let writer = Connection::open(&path).unwrap();
        writer.execute_batch("BEGIN EXCLUSIVE; INSERT INTO categories (id, name, type, sort_order) VALUES ('1', 'A', 'movie', 0);").unwrap();
        let release = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(300));
            writer.execute_batch("COMMIT;").unwrap();
        });
        let catalog = read_catalog(&conn).unwrap();
        release.join().unwrap();
        assert_eq!(catalog.categories.len(), 1);
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn reads_tables_in_display_order_with_raw_values() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::schema::CATALOG_TABLES).unwrap();
        conn.execute_batch(
            "INSERT INTO movies (id, tmdb_id, name, icon, category_id, added, container_extension, sort_order) VALUES
               (2, NULL, 'B', 'http://p/i/b.jpg', '10', 1700000000, 'mkv', 1),
               (1, 603, 'A', 'http://p/i/a.jpg', '10', NULL, NULL, 0),
               (0, 0, 'Zéro', '', NULL, NULL, NULL, 2);
             INSERT INTO series (id, tmdb_id, name, icon, category_id, added, sort_order) VALUES (5, 1399, 'S', 'nobarre', '20', 1, 0);
             INSERT INTO live (id, name, icon, category_id, epg_channel_id, matched_epg_id, match_method, sort_order)
               VALUES (7, 'TF1', 'http://p/i/tf1.png', '30', 'tf1.fr', NULL, 'P1', 0);
             INSERT INTO categories (id, name, type, sort_order) VALUES ('20', 'Séries', 'series', 1), ('10', 'Films', 'movie', 0);",
        )
        .unwrap();
        let c = read_catalog(&conn).unwrap();
        assert_eq!(c.movies.id, vec![1, 2, 0]);
        assert_eq!(c.icon_prefixes, vec!["http://p/i/"]);
        assert_eq!(c.movies.icon_suffix, vec!["a.jpg", "b.jpg", ""]);
        assert_eq!(c.movies.icon_prefix_id, vec![0, 0, -1]);
        assert_eq!(c.movies.tmdb_id[1], Value::Null);
        assert_eq!(c.movies.added[1], Value::from(1_700_000_000_i64));
        assert_eq!(c.series.icon_prefix_id, vec![-1]);
        assert_eq!(c.series.icon_suffix, vec!["nobarre"]);
        assert_eq!(c.live.icon_suffix, vec!["tf1.png"]);
        assert_eq!(c.live.matched_epg_id, vec![Value::Null]);
        assert_eq!(c.categories[0][0], Value::from("10"));
    }
}
