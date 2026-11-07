//! Tests du journal des migrations (`migrations.rs`) face aux schémas réellement utilisés.
//!
//! Situation :
//! - le journal visait l'ancienne base `nyxplayer.db`, que plus rien n'ouvre (l'app ne l'applique
//!   plus) : la page passe par `secure_db.rs`, qui n'accepte que `nyxplayer_<uuid>.db` ;
//! - la base de chaque compte est donc créée et mise à niveau par le « schéma fusionné » de
//!   `src/services/dbCore.ts` (+ ses `ALTER TABLE` de réparation), puis par `schema.rs` côté Rust.
//!
//! Ces tests figent ce journal, vérifient qu'il décrit bien le schéma fusionné, et qu'une base
//! au format d'une ancienne version (journal appliqué jusqu'à la version N) arrive au schéma
//! actuel quand l'app d'aujourd'hui l'ouvre. Ce cas n'arrive plus tel quel (`nyxplayer.db` n'est
//! plus ouverte), mais il sert d'image des anciennes bases de comptes que les réparations de
//! dbCore.ts (« pre-v14 multi-user ») rattrapent encore. Les écarts connus sont listés (`KNOWN_*`) : un test échoue
//! s'il en apparaît un nouveau, ou si l'un d'eux disparaît (liste à mettre à jour).

use super::{get_migrations, MigrationKind};
use crate::schema;
use rusqlite::Connection;
use std::collections::{BTreeMap, BTreeSet};

// =============================================================================
// SCHÉMA DES COMPTES (dbCore.ts), lu dans le code de la page
// =============================================================================

const DB_CORE_TS: &str = include_str!("../../src/services/dbCore.ts");

/// Contenu de `const MERGED_SCHEMA = `…`;` dans dbCore.ts.
fn merged_schema() -> &'static str {
    let marker = "const MERGED_SCHEMA = `";
    let start = DB_CORE_TS.find(marker).expect("MERGED_SCHEMA introuvable dans dbCore.ts") + marker.len();
    let end = start + DB_CORE_TS[start..].find('`').unwrap();
    &DB_CORE_TS[start..end]
}

/// Table de recherche FTS5, créée à part dans dbCore.ts (hors schéma fusionné).
fn ts_search_index() -> &'static str {
    let start = DB_CORE_TS
        .find("CREATE VIRTUAL TABLE IF NOT EXISTS search_index")
        .expect("création de search_index introuvable dans dbCore.ts");
    let end = start + DB_CORE_TS[start..].find(");").unwrap() + 2;
    &DB_CORE_TS[start..end]
}

/// `ALTER TABLE` de réparation exécutés par dbCore.ts à chaque ouverture (erreurs ignorées).
/// Repère le modèle `sort_order` (4 tables écrites ici) et les `'ALTER TABLE …'` entre
/// apostrophes : une réparation écrite autrement serait ignorée (écart « disparu » signalé).
fn ts_auto_repairs() -> Vec<String> {
    let mut repairs = Vec::new();
    let template = "ALTER TABLE ${table} ADD COLUMN sort_order INTEGER DEFAULT 0";
    assert!(DB_CORE_TS.contains(template), "réparation sort_order introuvable dans dbCore.ts");
    for table in ["movies", "series", "live", "categories"] {
        repairs.push(template.replace("${table}", table));
    }
    for (start, _) in DB_CORE_TS.match_indices("'ALTER TABLE ") {
        let body = &DB_CORE_TS[start + 1..];
        repairs.push(body[..body.find('\'').unwrap()].to_string());
    }
    assert!(repairs.len() >= 8, "réparations trouvées : {:?}", repairs);
    repairs
}

/// Ce que l'app actuelle exécute sur la base d'un compte : ouverture par la page (dbCore.ts),
/// puis par Rust (catalogue `catalog_parser::open_connection`, guide `epg_parser`).
fn open_like_current_app(conn: &Connection) {
    // Avant la page : mise à niveau de la clé des catégories (secure_db.rs, nyx_db_load)
    schema::upgrade_categories_key(conn).expect("clé des catégories");
    conn.execute_batch(merged_schema()).expect("schéma fusionné de dbCore.ts");
    for sql in ts_auto_repairs() {
        let _ = conn.execute(&sql, []);
    }
    conn.execute_batch(ts_search_index()).expect("search_index de dbCore.ts");
    conn.execute_batch(schema::CATALOG_TABLES).expect("CATALOG_TABLES");
    schema::run_auto_repair(conn, schema::CATALOG_AUTO_REPAIR);
    conn.execute_batch(schema::EPG_TABLES).expect("EPG_TABLES");
    schema::run_auto_repair(conn, schema::EPG_LIVE_AUTO_REPAIR);
}

// =============================================================================
// JOURNAL
// =============================================================================

/// Applique les migrations `versions` du journal, chaque migration dans sa transaction (comme sqlx,
/// qui s'arrête à la première en échec). Renvoie cette migration et son erreur.
fn apply_journal(conn: &Connection, versions: std::ops::RangeInclusive<i64>) -> Result<(), (i64, String)> {
    for m in get_migrations().into_iter().filter(|m| versions.contains(&m.version)) {
        let sql = format!("BEGIN; {} COMMIT;", m.sql);
        if let Err(e) = conn.execute_batch(&sql) {
            let _ = conn.execute_batch("ROLLBACK;");
            return Err((m.version, e.to_string()));
        }
    }
    Ok(())
}

fn last_version() -> i64 {
    get_migrations().last().unwrap().version
}

// =============================================================================
// DESCRIPTION D'UN SCHÉMA
// =============================================================================

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct Column {
    name: String,
    decl_type: String,
    not_null: bool,
    default: Option<String>,
    pk: i64,
}

#[derive(Debug, Default, PartialEq, Eq)]
struct Schema {
    /// Table → colonnes (ensemble : `ALTER TABLE` ajoute en fin de table, l'ordre peut différer)
    tables: BTreeMap<String, BTreeSet<Column>>,
    /// Index → (table, colonnes, unique)
    indexes: BTreeMap<String, (String, Vec<String>, bool)>,
}

fn squash(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn describe(conn: &Connection) -> Schema {
    let mut schema = Schema::default();
    let tables: Vec<String> = conn
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .map(Result::unwrap)
        // Tables internes de FTS5 (search_index_data, _idx, _content, _docsize, _config)
        .filter(|name: &String| !name.starts_with("search_index_"))
        .collect();
    for table in tables {
        let columns = conn
            .prepare(&format!("PRAGMA table_info(\"{}\")", table))
            .unwrap()
            .query_map([], |r| {
                Ok(Column {
                    name: r.get(1)?,
                    decl_type: r.get::<_, String>(2)?.to_uppercase(),
                    not_null: r.get::<_, i64>(3)? != 0,
                    default: r.get::<_, Option<String>>(4)?.map(|d| squash(&d)),
                    pk: r.get(5)?,
                })
            })
            .unwrap()
            .map(Result::unwrap)
            .collect();
        schema.tables.insert(table, columns);
    }
    let indexes: Vec<(String, String, String)> = conn
        .prepare("SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    for (name, table, sql) in indexes {
        let columns = conn
            .prepare(&format!("PRAGMA index_info(\"{}\")", name))
            .unwrap()
            .query_map([], |r| r.get::<_, String>(2))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        let unique = sql.to_uppercase().starts_with("CREATE UNIQUE");
        schema.indexes.insert(name, (table, columns, unique));
    }
    schema
}

/// Écarts entre deux schémas, en lignes lisibles (vide = identiques).
fn differences(expected: &Schema, actual: &Schema) -> BTreeSet<String> {
    let mut diffs = BTreeSet::new();
    for (table, cols) in &expected.tables {
        match actual.tables.get(table) {
            None => {
                diffs.insert(format!("table manquante : {}", table));
            }
            Some(actual_cols) => {
                for col in cols.difference(actual_cols) {
                    let same_name = actual_cols.iter().find(|c| c.name == col.name);
                    diffs.insert(match same_name {
                        Some(other) => format!("colonne différente : {}.{} ({:?} au lieu de {:?})", table, col.name, other, col),
                        None => format!("colonne manquante : {}.{}", table, col.name),
                    });
                }
                for col in actual_cols.difference(cols) {
                    if !cols.iter().any(|c| c.name == col.name) {
                        diffs.insert(format!("colonne en trop : {}.{}", table, col.name));
                    }
                }
            }
        }
    }
    for table in actual.tables.keys().filter(|t| !expected.tables.contains_key(*t)) {
        diffs.insert(format!("table en trop : {}", table));
    }
    for (name, def) in &expected.indexes {
        match actual.indexes.get(name) {
            None => {
                diffs.insert(format!("index manquant : {}", name));
            }
            Some(other) if other != def => {
                diffs.insert(format!("index différent : {}", name));
            }
            _ => {}
        }
    }
    for name in actual.indexes.keys().filter(|n| !expected.indexes.contains_key(*n)) {
        diffs.insert(format!("index en trop : {}", name));
    }
    diffs
}

fn set(lines: &[&str]) -> BTreeSet<String> {
    lines.iter().map(|s| s.to_string()).collect()
}

fn current_schema() -> Schema {
    let conn = Connection::open_in_memory().unwrap();
    open_like_current_app(&conn);
    describe(&conn)
}

// =============================================================================
// TESTS DU JOURNAL
// =============================================================================

/// Versions 1, 2, 3… sans trou ni doublon, toutes « montantes », chacune décrite.
#[test]
fn versions_follow_each_other_from_one() {
    let migrations = get_migrations();
    assert!(!migrations.is_empty());
    for (i, m) in migrations.iter().enumerate() {
        assert_eq!(m.version, i as i64 + 1, "version inattendue à la position {}", i);
        assert!(matches!(m.kind, MigrationKind::Up), "migration {} n'est pas « Up »", m.version);
        assert!(!m.description.trim().is_empty(), "migration {} sans description", m.version);
        assert!(!m.sql.trim().is_empty(), "migration {} vide", m.version);
    }
}

/// sqlx (dans l'ancien plugin SQL) refusait d'ouvrir une base dont une migration déjà appliquée
/// avait été modifiée depuis (somme de contrôle du texte SQL). Le journal est donc figé : on ajoute une
/// migration, on ne réécrit jamais une ancienne. Empreinte FNV-1a 64 bits du texte exact.
#[test]
fn existing_migrations_are_never_rewritten() {
    fn fnv1a(text: &str) -> u64 {
        text.bytes().fold(0xcbf2_9ce4_8422_2325, |h, b| (h ^ b as u64).wrapping_mul(0x0100_0000_01b3))
    }
    const FROZEN: &[(i64, u64)] = &[
        (1, 0xa8ce_d5e6_2626_d9c6),
        (2, 0x1d6f_f3eb_c15e_da4e),
        (3, 0x6571_7694_8522_ad67),
        (4, 0x5e1d_3544_196c_2416),
        (5, 0x4a3f_5f3b_4e11_3712),
        (6, 0x43b3_f56a_ec43_37ed),
        (7, 0x0aef_1569_6cd5_2c69),
        (8, 0x8ed6_f341_a1b5_73fc),
        (9, 0xdb44_d5a9_1f1c_d4ee),
        (10, 0x79a3_9285_c76a_944f),
        (11, 0xb0f9_2f29_a83f_7ac8),
        (12, 0xe380_4cc9_7cab_bddd),
        (13, 0xf54c_6a28_662a_4f85),
        (14, 0x3b22_1d2e_f689_241f),
        (15, 0x18df_e2f6_a4b2_1374),
    ];
    let migrations = get_migrations();
    let actual: Vec<(i64, u64)> = migrations.iter().map(|m| (m.version, fnv1a(m.sql))).collect();
    for (version, hash) in FROZEN {
        let found = actual.iter().find(|(v, _)| v == version).map(|(_, h)| *h);
        assert_eq!(
            found,
            Some(*hash),
            "migration {} modifiée ou supprimée : ajouter une nouvelle migration à la place. Empreintes actuelles : {:x?}",
            version,
            actual
        );
    }
}

/// Sur une base vide, tout le journal passe.
#[test]
fn journal_applies_on_an_empty_database() {
    let conn = Connection::open_in_memory().unwrap();
    apply_journal(&conn, 1..=last_version()).unwrap();
}

/// Défaut connu : la migration 13 ajoute `watchlist.updated_at` avec une valeur
/// par défaut calculée (`strftime('%s','now')`), ce que SQLite refuse dès que la table contient
/// une ligne. Une ancienne base arrêtée à la version 12 avec des titres dans Ma liste ne passe
/// donc pas la 13, et sqlx bloque tout le journal. Sans effet aujourd'hui : l'ancienne base
/// `nyxplayer.db` n'est plus ouverte. Ce test échouera le jour où ce sera corrigé.
#[test]
fn migration_13_fails_when_my_list_is_not_empty() {
    let conn = Connection::open_in_memory().unwrap();
    apply_journal(&conn, 1..=12).unwrap();
    conn.execute_batch("INSERT INTO watchlist (stream_id, type, added_at) VALUES (1, 'movie', 1700000000000);")
        .unwrap();
    let (version, error) = apply_journal(&conn, 13..=last_version()).unwrap_err();
    assert_eq!(version, 13);
    assert!(error.contains("non-constant default"), "{}", error);
    // La transaction annulée laisse Ma liste intacte
    assert_eq!(count(&conn, "watchlist"), 1);
}

/// Le journal complet décrit le « schéma fusionné » des comptes (dbCore.ts se présente comme
/// « schéma final fusionné des 15 migrations ») : mêmes tables, colonnes et index, à la liste
/// d'écarts près. Tout nouvel écart doit être voulu, et ajouté ici.
#[test]
fn journal_matches_the_account_schema() {
    let conn = Connection::open_in_memory().unwrap();
    apply_journal(&conn, 1..=last_version()).unwrap();
    let journal = describe(&conn);
    let accounts = current_schema();
    let known = set(&[
        // Ajouts faits hors journal, directement dans dbCore.ts et schema.rs
        "table manquante : epg_channels",
        "table manquante : epg_kept_channels",
        "table manquante : hidden_categories",
        "table manquante : picon_cache",
        // Liste des sources (multi-sources, PR 1) : dbCore.ts seulement, la base perso
        "table manquante : iptv_sources",
        // Liens TMDB trouvés par le titre (listes M3U) : dbCore.ts et schema.rs, comme le catalogue
        "table manquante : m3u_tmdb_links",
        // Affiches TMDB des titres reliés par leur nom : dbCore.ts seulement, la base perso (cache)
        "table manquante : title_tmdb_posters",
        "colonne manquante : live.geo_hint",
        "colonne manquante : live.match_method",
        "colonne manquante : live.matched_epg_id",
        // Clé (type, numéro) des catégories : hors journal, posée sur les bases d'avant par
        // schema::upgrade_categories_key à l'ouverture
        "colonne différente : categories.id (Column { name: \"id\", decl_type: \"TEXT\", not_null: false, default: None, pk: 1 } au lieu de Column { name: \"id\", decl_type: \"TEXT\", not_null: true, default: None, pk: 2 })",
        "colonne différente : categories.type (Column { name: \"type\", decl_type: \"TEXT\", not_null: true, default: None, pk: 0 } au lieu de Column { name: \"type\", decl_type: \"TEXT\", not_null: true, default: None, pk: 1 })",
        // Index du guide remplacé hors journal (schema.rs, EPG_TABLES)
        "index en trop : idx_epg_channel_start",
        "index manquant : idx_epg_channel_stop",
    ]);
    assert_eq!(differences(&accounts, &journal), known);
}

// =============================================================================
// COHÉRENCE DES DEUX SOURCES ACTUELLES (dbCore.ts et schema.rs)
// =============================================================================

/// Les tables définies des deux côtés (page et Rust) ont exactement les mêmes colonnes : sinon la
/// base d'un compte dépend de qui l'ouvre en premier.
#[test]
fn account_schema_and_schema_rs_agree() {
    let ts = Connection::open_in_memory().unwrap();
    ts.execute_batch(merged_schema()).unwrap();
    let ts = describe(&ts);

    let rs = Connection::open_in_memory().unwrap();
    rs.execute_batch(schema::CATALOG_TABLES).unwrap();
    rs.execute_batch(schema::EPG_TABLES).unwrap();
    let rs = describe(&rs);

    let shared: Vec<&String> = rs.tables.keys().filter(|t| ts.tables.contains_key(*t)).collect();
    assert!(shared.len() >= 6, "tables communes : {:?}", shared);
    for table in shared {
        assert_eq!(ts.tables[table], rs.tables[table], "colonnes de {} différentes", table);
    }
    // Seule table du guide créée uniquement par Rust
    let rust_only: Vec<&String> = rs.tables.keys().filter(|t| !ts.tables.contains_key(*t)).collect();
    assert_eq!(rust_only, vec!["epg_kept_channels"]);
}

/// Ouvrir deux fois la même base (relance de l'app) ne change rien et ne lève aucune erreur.
#[test]
fn reopening_a_current_database_changes_nothing() {
    let conn = Connection::open_in_memory().unwrap();
    open_like_current_app(&conn);
    let first = describe(&conn);
    open_like_current_app(&conn);
    assert_eq!(describe(&conn), first);
}

// =============================================================================
// BASES CRÉÉES PAR UNE ANCIENNE VERSION
// =============================================================================

/// Remplit les tables qui existent déjà à la version donnée (colonnes de la version 1 à 7).
fn insert_sample_rows(conn: &Connection, version: i64) {
    conn.execute_batch(
        "INSERT INTO movies (id, tmdb_id, name, category_id) VALUES (1, 603, 'Matrix', '10');
         INSERT INTO series (id, tmdb_id, name) VALUES (2, 1399, 'Game of Thrones');
         INSERT INTO live (id, name, category_id) VALUES (3, 'TF1', '20');
         INSERT INTO categories (id, name, type) VALUES ('10', 'Films', 'movie');
         INSERT INTO meta (key, value) VALUES ('last_sync', '123');",
    )
    .unwrap();
    if version >= 5 {
        conn.execute_batch(
            "INSERT INTO playback_progress (content_type, stream_id, title, time_seconds, duration_seconds, updated_at)
             VALUES ('movie', 1, 'Matrix', 600, 8160, 1700000000000);",
        )
        .unwrap();
    }
    if version >= 6 {
        conn.execute_batch("INSERT INTO watchlist (stream_id, type, added_at) VALUES (1, 'movie', 1700000000000);")
            .unwrap();
    }
}

fn count(conn: &Connection, table: &str) -> i64 {
    conn.query_row(&format!("SELECT COUNT(*) FROM {}", table), [], |r| r.get(0)).unwrap()
}

/// Pour chaque version N du journal : une base arrêtée à N, avec des données, est ouverte par
/// l'app actuelle. Elle garde ses données et rejoint le schéma d'aujourd'hui, aux écarts connus
/// près (colonnes qu'aucune réparation n'ajoute).
#[test]
fn a_database_from_any_older_version_reaches_the_current_schema() {
    let current = current_schema();
    for version in 1..=last_version() {
        let conn = Connection::open_in_memory().unwrap();
        apply_journal(&conn, 1..=version).unwrap();
        insert_sample_rows(&conn, version);

        open_like_current_app(&conn);

        let mut known = BTreeSet::new();
        // Colonnes que ni dbCore.ts ni schema.rs ne rattrapent sur une table déjà existante
        if (5..9).contains(&version) {
            known.insert("colonne manquante : playback_progress.container_extension".to_string());
        }
        if (6..13).contains(&version) {
            known.insert("colonne manquante : watchlist.updated_at".to_string());
        }
        // (l'index du guide créé par la migration 15 est supprimé par EPG_TABLES : pas d'écart)
        assert_eq!(differences(&current, &describe(&conn)), known, "base arrêtée à la version {}", version);

        for table in ["movies", "series", "live", "categories", "meta"] {
            assert_eq!(count(&conn, table), 1, "{} vidée (version {})", table, version);
        }
        if version >= 5 {
            assert_eq!(count(&conn, "playback_progress"), 1, "reprises perdues (version {})", version);
        }
        if version >= 6 {
            assert_eq!(count(&conn, "watchlist"), 1, "Ma liste perdue (version {})", version);
        }
        // Colonnes ajoutées après coup : valeur par défaut sur les lignes anciennes
        let sort_order: i64 = conn.query_row("SELECT sort_order FROM movies WHERE id = 1", [], |r| r.get(0)).unwrap();
        assert_eq!(sort_order, 0, "version {}", version);
        let epg: Option<String> = conn.query_row("SELECT epg_channel_id FROM live WHERE id = 3", [], |r| r.get(0)).unwrap();
        assert_eq!(epg, None, "version {}", version);
    }
}
