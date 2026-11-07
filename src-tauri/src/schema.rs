//! Schema SQL — Single Source of Truth (Rust)
//!
//! Toutes les définitions CREATE TABLE et ALTER TABLE auto-repair utilisées
//! par les modules Rust sont centralisées ici. AUCUN autre fichier Rust ne doit
//! contenir de CREATE TABLE inline (sauf `migrations.rs`, journal historique gardé pour les tests).
//!
//! Quand on ajoute une colonne :
//! 1. Modifier la constante ici (CATALOG_TABLES ou EPG_TABLES)
//! 2. Ajouter l'ALTER TABLE dans CATALOG_AUTO_REPAIR ou EPG_LIVE_AUTO_REPAIR
//! 3. `cargo test` vérifiera la cohérence automatiquement

use rusqlite::Connection;

// =============================================================================
// PRAGMAS
// =============================================================================

/// PRAGMAs pour toute connexion Rust ouverte directement (hors base de la page, `secure_db.rs`).
/// WAL mode pour concurrence lecture/écriture, busy_timeout pour éviter SQLITE_BUSY.
pub const PRAGMAS_WAL: &str = "
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
";

/// PRAGMAs supplémentaires pour les ingestions batch (catalog_parser).
pub const PRAGMAS_BATCH: &str = "
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA cache_size = 10000;
    PRAGMA temp_store = MEMORY;
";

// =============================================================================
// CATALOG TABLES (movies, series, live, categories)
// =============================================================================

/// Crée les tables du catalogue IPTV si elles n'existent pas.
/// Source de vérité pour la structure des tables movies, series, live, categories.
pub const CATALOG_TABLES: &str = "
    CREATE TABLE IF NOT EXISTS movies (
        id INTEGER PRIMARY KEY,
        tmdb_id INTEGER,
        name TEXT NOT NULL,
        icon TEXT,
        category_id TEXT,
        added INTEGER,
        rating REAL,
        container_extension TEXT,
        data TEXT,
        sort_order INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS series (
        id INTEGER PRIMARY KEY,
        tmdb_id INTEGER,
        name TEXT NOT NULL,
        icon TEXT,
        category_id TEXT,
        added INTEGER,
        rating REAL,
        data TEXT,
        sort_order INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS live (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        icon TEXT,
        category_id TEXT,
        epg_channel_id TEXT,
        matched_epg_id TEXT,
        match_method TEXT,
        geo_hint TEXT,
        data TEXT,
        sort_order INTEGER DEFAULT 0
    );
    -- Rangées par type ET numéro : des fournisseurs numérotent chaque type à part (catégorie 1 des
    -- films et catégorie 1 des chaînes). Les bases d'avant : `upgrade_categories_key`.
    CREATE TABLE IF NOT EXISTS categories (
        id TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        sort_order INTEGER DEFAULT 0,
        PRIMARY KEY (type, id)
    );
    -- Liens TMDB trouvés par le titre pour les films et séries d'une liste M3U, qui ne donne jamais
    -- de numéro TMDB (tmdb_id = 0 : aucun lien sûr). Gardée à chaque nouvelle lecture de la liste
    -- (qui vide les tables ci-dessus) : les liens y sont reposés tant que le nom n'a pas changé.
    CREATE TABLE IF NOT EXISTS m3u_tmdb_links (
        kind TEXT NOT NULL,
        id INTEGER NOT NULL,
        name TEXT NOT NULL,
        tmdb_id INTEGER NOT NULL,
        checked_at INTEGER NOT NULL,
        PRIMARY KEY (kind, id)
    );
";

// =============================================================================
// EPG TABLES (epg_programs, epg_channels)
// =============================================================================

/// Crée les tables EPG + indexes si elles n'existent pas.
/// Source de vérité pour la structure des tables epg_programs et epg_channels.
pub const EPG_TABLES: &str = "
    CREATE TABLE IF NOT EXISTS epg_programs (
        channel_id TEXT NOT NULL,
        title TEXT NOT NULL,
        start_ts INTEGER NOT NULL,
        stop_ts INTEGER NOT NULL,
        description TEXT,
        PRIMARY KEY (channel_id, start_ts)
    );
    CREATE INDEX IF NOT EXISTS idx_epg_start ON epg_programs(start_ts);
    DROP INDEX IF EXISTS idx_epg_channel_start;
    CREATE INDEX IF NOT EXISTS idx_epg_channel_stop ON epg_programs(channel_id, stop_ts);
    CREATE TABLE IF NOT EXISTS epg_channels (
        id TEXT PRIMARY KEY NOT NULL,
        display_name TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS epg_kept_channels (
        id TEXT PRIMARY KEY NOT NULL
    );
";

/// Table de travail d'une lecture de liste M3U (`m3u_ingest.rs`) : les épisodes, regroupés par
/// série avant d'être écrits dans `series`. Dans la base elle-même, créée et supprimée dans la même
/// transaction (jamais validée) : une table TEMP irait en mémoire ou dans un dossier temporaire
/// absent sur Android. Un reste d'une lecture tuée est supprimé d'abord.
pub const M3U_EPISODES_WORK: &str = "
    DROP TABLE IF EXISTS m3u_episodes_work;
    CREATE TABLE m3u_episodes_work (
        series_id INTEGER NOT NULL,
        series_name TEXT NOT NULL,
        category_id TEXT,
        icon TEXT,
        id INTEGER NOT NULL,
        title TEXT NOT NULL,
        season INTEGER NOT NULL,
        episode INTEGER NOT NULL,
        container_extension TEXT,
        data TEXT NOT NULL,
        ord INTEGER NOT NULL
    );
    CREATE INDEX m3u_episodes_work_by_series ON m3u_episodes_work(series_id, season, episode, ord);
";

/// Table where a guide sync writes the new programs before they replace `epg_programs`
/// (epg_parser.rs, ProgramWriter): same columns and key, indexes built after the swap.
/// A leftover of a killed sync is dropped first.
pub const EPG_PROGRAMS_STAGING: &str = "
    DROP TABLE IF EXISTS epg_programs_staging;
    CREATE TABLE epg_programs_staging (
        channel_id TEXT NOT NULL,
        title TEXT NOT NULL,
        start_ts INTEGER NOT NULL,
        stop_ts INTEGER NOT NULL,
        description TEXT,
        PRIMARY KEY (channel_id, start_ts)
    );
";

// =============================================================================
// AUTO-REPAIR — colonnes ajoutées post-v1
// =============================================================================

/// Auto-repair pour les tables catalogue.
/// Chaque ALTER TABLE est exécuté avec let _ = (ignore "duplicate column").
/// Couvre les colonnes ajoutées dans les migrations v8..v16.
pub const CATALOG_AUTO_REPAIR: &[&str] = &[
    // v14: sort_order sur les 4 tables catalogue
    "ALTER TABLE movies ADD COLUMN sort_order INTEGER DEFAULT 0",
    "ALTER TABLE series ADD COLUMN sort_order INTEGER DEFAULT 0",
    "ALTER TABLE live ADD COLUMN sort_order INTEGER DEFAULT 0",
    "ALTER TABLE categories ADD COLUMN sort_order INTEGER DEFAULT 0",
    // v8: container_extension sur movies
    "ALTER TABLE movies ADD COLUMN container_extension TEXT",
    // v15: epg_channel_id sur live
    "ALTER TABLE live ADD COLUMN epg_channel_id TEXT",
    // v16+: EPG matching columns sur live
    "ALTER TABLE live ADD COLUMN matched_epg_id TEXT",
    "ALTER TABLE live ADD COLUMN match_method TEXT",
    "ALTER TABLE live ADD COLUMN geo_hint TEXT",
];

/// Auto-repair pour les colonnes EPG sur la table live.
/// Utilisé par `build_epg_mapping` quand il s'exécute de manière isolée.
pub const EPG_LIVE_AUTO_REPAIR: &[&str] = &[
    "ALTER TABLE live ADD COLUMN geo_hint TEXT",
];

// =============================================================================
// CATÉGORIES — clé (type, numéro) pour les bases d'avant
// =============================================================================

/// Passe la table `categories` d'une base d'avant (clé = numéro seul) à la clé (type, numéro).
///
/// Avec le numéro seul, un fournisseur qui numérote chaque type à part (catégorie 1 des films et
/// catégorie 1 des chaînes) voyait ses catégories de films et de séries écrasées par celles des
/// chaînes : onglets Films et Séries vides alors que le catalogue était chargé (retour du 02/11).
/// Les lignes gardées sont recopiées telles quelles ; les catégories déjà écrasées reviennent à la
/// prochaine actualisation. Une seule transaction : en cas d'échec (base occupée), rien ne change
/// et la base reste lisible comme avant ; nouvel essai à la prochaine ouverture.
///
/// Renvoie `true` si la table a été transformée.
pub fn upgrade_categories_key(conn: &Connection) -> rusqlite::Result<bool> {
    if !categories_key_is_id_only(conn)? {
        return Ok(false);
    }
    // Base très ancienne : la colonne de rang avant la recopie
    let _ = conn.execute("ALTER TABLE categories ADD COLUMN sort_order INTEGER DEFAULT 0", []);
    conn.execute_batch("BEGIN IMMEDIATE;")?;
    let result = (|| {
        // Une autre connexion a pu la faire entre-temps
        if !categories_key_is_id_only(conn)? {
            return Ok(false);
        }
        conn.execute_batch(
            "CREATE TABLE categories_by_type (
                 id TEXT NOT NULL,
                 name TEXT NOT NULL,
                 type TEXT NOT NULL,
                 sort_order INTEGER DEFAULT 0,
                 PRIMARY KEY (type, id)
             );
             INSERT OR IGNORE INTO categories_by_type (id, name, type, sort_order)
                 SELECT id, name, type, sort_order FROM categories WHERE id IS NOT NULL;
             DROP TABLE categories;
             ALTER TABLE categories_by_type RENAME TO categories;",
        )?;
        if lost_categories(conn)? && table_exists(conn, "meta")? {
            // Actualisation automatique à la prochaine occasion (catalogAutoRefresh.ts : due sans
            // `lastUpdate`) : elle réécrit les catégories écrasées
            conn.execute("DELETE FROM meta WHERE key = 'lastUpdate'", [])?;
        }
        Ok(true)
    })();
    let result = result.and_then(|changed| conn.execute_batch("COMMIT;").map(|_| changed));
    if result.is_err() {
        // Jamais de transaction laissée ouverte sur la connexion rendue à l'appelant
        let _ = conn.execute_batch("ROLLBACK;");
    }
    result
}

/// Films ou séries rangés dans une catégorie absente de leur type : signe de catégories écrasées
/// par l'ancienne clé (ou d'un fournisseur qui oublie des catégories : une actualisation de plus)
fn lost_categories(conn: &Connection) -> rusqlite::Result<bool> {
    let mut lost = false;
    for (table, kind) in [("movies", "movie"), ("series", "series")] {
        if !table_exists(conn, table)? {
            continue;
        }
        lost |= conn.query_row(
            &format!(
                "SELECT EXISTS(SELECT 1 FROM {table} t WHERE t.category_id IS NOT NULL AND t.category_id != ''
                   AND NOT EXISTS(SELECT 1 FROM categories c WHERE c.type = '{kind}' AND c.id = t.category_id))"
            ),
            [],
            |r| r.get::<_, bool>(0),
        )?;
    }
    Ok(lost)
}

fn table_exists(conn: &Connection, table: &str) -> rusqlite::Result<bool> {
    conn.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)", [table], |r| r.get(0))
}

/// Table `categories` présente avec une clé sans la colonne `type` (bases d'avant)
fn categories_key_is_id_only(conn: &Connection) -> rusqlite::Result<bool> {
    let mut stmt = conn.prepare("SELECT name FROM pragma_table_info('categories') WHERE pk > 0")?;
    let key = stmt.query_map([], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(!key.is_empty() && !key.iter().any(|name| name == "type"))
}

// =============================================================================
// HELPER — exécuter un tableau d'auto-repair
// =============================================================================

/// Exécute une liste de ALTER TABLE en ignorant silencieusement les erreurs
/// "duplicate column name" (colonne déjà présente = pas un problème).
pub fn run_auto_repair(conn: &Connection, repairs: &[&str]) {
    for sql in repairs {
        let _ = conn.execute(sql, []);
    }
}

// =============================================================================
// TESTS — vérification de cohérence du schema
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    /// Vérifie que CATALOG_TABLES produit les bonnes tables avec les bonnes colonnes.
    #[test]
    fn test_catalog_tables_schema() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(CATALOG_TABLES).unwrap();

        // Verify 'live' table has all 10 columns
        let live_cols = get_column_names(&conn, "live");
        assert!(live_cols.contains(&"id".to_string()), "missing id");
        assert!(live_cols.contains(&"name".to_string()), "missing name");
        assert!(live_cols.contains(&"icon".to_string()), "missing icon");
        assert!(live_cols.contains(&"category_id".to_string()), "missing category_id");
        assert!(live_cols.contains(&"epg_channel_id".to_string()), "missing epg_channel_id");
        assert!(live_cols.contains(&"matched_epg_id".to_string()), "missing matched_epg_id");
        assert!(live_cols.contains(&"match_method".to_string()), "missing match_method");
        assert!(live_cols.contains(&"geo_hint".to_string()), "missing geo_hint");
        assert!(live_cols.contains(&"data".to_string()), "missing data");
        assert!(live_cols.contains(&"sort_order".to_string()), "missing sort_order");
        assert_eq!(live_cols.len(), 10, "live table should have exactly 10 columns, got {:?}", live_cols);

        // Verify 'movies' table
        let movies_cols = get_column_names(&conn, "movies");
        assert!(movies_cols.contains(&"container_extension".to_string()), "missing container_extension");
        assert!(movies_cols.contains(&"sort_order".to_string()), "missing sort_order");
        assert_eq!(movies_cols.len(), 10, "movies table should have 10 columns");

        // Verify 'series' table
        let series_cols = get_column_names(&conn, "series");
        assert!(series_cols.contains(&"sort_order".to_string()), "missing sort_order");
        assert_eq!(series_cols.len(), 9, "series table should have 9 columns");

        // Verify 'categories' table
        let cat_cols = get_column_names(&conn, "categories");
        assert_eq!(cat_cols.len(), 4, "categories table should have 4 columns");
    }

    /// Vérifie que EPG_TABLES produit les bonnes tables.
    #[test]
    fn test_epg_tables_schema() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(EPG_TABLES).unwrap();

        // Verify 'epg_programs'
        let prog_cols = get_column_names(&conn, "epg_programs");
        assert_eq!(prog_cols.len(), 5, "epg_programs should have 5 columns, got {:?}", prog_cols);
        assert!(prog_cols.contains(&"channel_id".to_string()));
        assert!(prog_cols.contains(&"title".to_string()));
        assert!(prog_cols.contains(&"start_ts".to_string()));
        assert!(prog_cols.contains(&"stop_ts".to_string()));
        assert!(prog_cols.contains(&"description".to_string()));

        // Verify 'epg_channels'
        let ch_cols = get_column_names(&conn, "epg_channels");
        assert_eq!(ch_cols.len(), 2, "epg_channels should have 2 columns, got {:?}", ch_cols);
        assert!(ch_cols.contains(&"id".to_string()));
        assert!(ch_cols.contains(&"display_name".to_string()));
    }

    /// La table d'attente du guide a exactement les colonnes et la clé de `epg_programs`
    /// (elle la remplace à la fin de chaque synchro).
    #[test]
    fn test_epg_staging_matches_programs() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(EPG_TABLES).unwrap();
        conn.execute_batch(EPG_PROGRAMS_STAGING).unwrap();
        let describe = |table: &str| -> Vec<(String, String, i64, i64)> {
            let mut stmt = conn.prepare(&format!("PRAGMA table_info({})", table)).unwrap();
            stmt.query_map([], |r| Ok((r.get(1)?, r.get(2)?, r.get(3)?, r.get(5)?)))
                .unwrap()
                .map(Result::unwrap)
                .collect()
        };
        assert_eq!(describe("epg_programs_staging"), describe("epg_programs"));
    }

    /// Vérifie que l'auto-repair fonctionne sur une DB fraîche (colonnes déjà présentes).
    #[test]
    fn test_auto_repair_idempotent() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(CATALOG_TABLES).unwrap();

        // Running auto-repair on a table that already has all columns should not error
        run_auto_repair(&conn, CATALOG_AUTO_REPAIR);
        run_auto_repair(&conn, EPG_LIVE_AUTO_REPAIR);

        // Verify columns are still correct
        let live_cols = get_column_names(&conn, "live");
        assert_eq!(live_cols.len(), 10);
    }

    /// Table `categories` des bases d'avant (clé = numéro seul)
    const OLD_CATEGORIES: &str = "CREATE TABLE categories (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, sort_order INTEGER DEFAULT 0
    );";

    fn categories(conn: &Connection) -> Vec<(String, String, String, i64)> {
        let mut stmt = conn.prepare("SELECT type, id, name, sort_order FROM categories ORDER BY type, id").unwrap();
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    }

    /// Le même numéro pour une catégorie de films, une de séries et une de chaînes : les trois
    /// restent (avant : la dernière écrite remplaçait les autres, onglets Films et Séries vides).
    #[test]
    fn same_number_in_each_type_keeps_every_category() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(CATALOG_TABLES).unwrap();
        let mut stmt = conn
            .prepare("INSERT OR REPLACE INTO categories (id, name, type, sort_order) VALUES (?, ?, ?, ?)")
            .unwrap();
        stmt.execute(rusqlite::params!["1", "Films FR", "movie", 0]).unwrap();
        stmt.execute(rusqlite::params!["1", "Séries FR", "series", 0]).unwrap();
        stmt.execute(rusqlite::params!["1", "TNT", "live", 0]).unwrap();
        assert_eq!(
            categories(&conn),
            vec![
                ("live".into(), "1".into(), "TNT".into(), 0),
                ("movie".into(), "1".into(), "Films FR".into(), 0),
                ("series".into(), "1".into(), "Séries FR".into(), 0),
            ]
        );
    }

    #[test]
    fn old_categories_table_gets_the_type_in_its_key_and_keeps_its_rows() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(OLD_CATEGORIES).unwrap();
        conn.execute_batch(
            "INSERT INTO categories VALUES ('1', 'TNT', 'live', 3), ('2', 'Action', 'movie', 0), ('3', 'Drames', 'series', 1);",
        )
        .unwrap();
        let before = categories(&conn);

        assert!(upgrade_categories_key(&conn).unwrap());
        assert_eq!(categories(&conn), before);
        conn.execute("INSERT INTO categories (id, name, type, sort_order) VALUES ('1', 'Films FR', 'movie', 0)", [])
            .unwrap();
        assert_eq!(categories(&conn).len(), 4);
        // Même structure qu'une base neuve
        let fresh = Connection::open_in_memory().unwrap();
        fresh.execute_batch(CATALOG_TABLES).unwrap();
        let shape = |c: &Connection| -> Vec<(String, String, bool, i64)> {
            let mut stmt = c.prepare("SELECT name, type, \"notnull\", pk FROM pragma_table_info('categories') ORDER BY cid").unwrap();
            stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))).unwrap().map(Result::unwrap).collect()
        };
        assert_eq!(shape(&conn), shape(&fresh));
        // Deuxième ouverture : rien à faire
        assert!(!upgrade_categories_key(&conn).unwrap());
    }

    /// Catégories de films déjà écrasées : l'actualisation automatique est demandée ; sinon, rien
    #[test]
    fn lost_movie_categories_ask_for_a_refresh() {
        let setup = |movie_category: &str| {
            let conn = Connection::open_in_memory().unwrap();
            conn.execute_batch(OLD_CATEGORIES).unwrap();
            conn.execute_batch(
                "CREATE TABLE movies (id INTEGER PRIMARY KEY, name TEXT, category_id TEXT);
                 CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
                 INSERT INTO meta VALUES ('lastUpdate', '2026-11-01T00:00:00Z');
                 INSERT INTO categories VALUES ('1', 'TNT', 'live', 0), ('2', 'Action', 'movie', 0);",
            )
            .unwrap();
            conn.execute("INSERT INTO movies VALUES (7, 'Film', ?1)", [movie_category]).unwrap();
            assert!(upgrade_categories_key(&conn).unwrap());
            conn.query_row("SELECT COUNT(*) FROM meta WHERE key = 'lastUpdate'", [], |r| r.get::<_, i64>(0)).unwrap()
        };
        // Film rangé dans la catégorie 1, qui n'existe plus que pour les chaînes
        assert_eq!(setup("1"), 0);
        assert_eq!(setup("2"), 1);
    }

    /// La connexion du catalogue (ingestion, actualisation) met aussi à niveau une base d'avant
    #[test]
    fn catalog_connection_upgrades_an_old_database() {
        let path = std::env::temp_dir().join(format!("nyx_schema_open_{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        Connection::open(&path).unwrap().execute_batch(OLD_CATEGORIES).unwrap();
        let conn = crate::catalog_parser::open_connection(&path).unwrap();
        assert!(!categories_key_is_id_only(&conn).unwrap());
        // Aucune transaction laissée ouverte
        assert!(conn.is_autocommit());
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn very_old_categories_table_without_rank_column_is_upgraded() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE categories (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL); INSERT INTO categories VALUES ('5', 'A', 'movie');")
            .unwrap();
        assert!(upgrade_categories_key(&conn).unwrap());
        assert_eq!(categories(&conn), vec![("movie".into(), "5".into(), "A".into(), 0)]);
    }

    #[test]
    fn upgrade_does_nothing_on_a_new_or_missing_table() {
        let conn = Connection::open_in_memory().unwrap();
        assert!(!upgrade_categories_key(&conn).unwrap());
        conn.execute_batch(CATALOG_TABLES).unwrap();
        assert!(!upgrade_categories_key(&conn).unwrap());
    }

    /// Base occupée par une autre connexion : rien ne change, la base reste lisible comme avant
    #[test]
    fn busy_database_is_left_untouched() {
        let path = std::env::temp_dir().join(format!("nyx_schema_busy_{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let holder = Connection::open(&path).unwrap();
        holder.execute_batch(OLD_CATEGORIES).unwrap();
        holder.execute_batch("INSERT INTO categories VALUES ('1', 'TNT', 'live', 0); BEGIN IMMEDIATE;").unwrap();

        let conn = Connection::open(&path).unwrap();
        conn.busy_timeout(std::time::Duration::from_millis(50)).unwrap();
        assert!(upgrade_categories_key(&conn).is_err());
        holder.execute_batch("COMMIT;").unwrap();
        assert!(categories_key_is_id_only(&conn).unwrap());
        assert_eq!(categories(&conn).len(), 1);
        drop((holder, conn));
        let _ = std::fs::remove_file(&path);
    }

    /// Helper : retourne les noms de colonnes d'une table.
    fn get_column_names(conn: &Connection, table: &str) -> Vec<String> {
        let mut stmt = conn.prepare(&format!("PRAGMA table_info({})", table)).unwrap();
        stmt.query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect()
    }
}
