/**
 * Database Core — Singleton SQLite + Meta + Utility
 *
 * Point d'entrée unique pour la connexion à la base SQLite.
 * Tous les repositories et services importent `getDatabase` depuis ce module.
 *
 * Phase 2 Multi-User : le nom de la DB est dynamique (`nyxplayer_<uid>.db`).
 * `setDatabaseName(uid)` DOIT être appelé avant tout accès DB.
 * Le schéma fusionné est exécuté automatiquement à chaque nouvelle connexion
 * (CREATE TABLE IF NOT EXISTS — idempotent).
 */

import Database from './nyxDatabase';
import { WATCHLIST_EVENT } from './eventConstants';
import { bumpGeneration } from './sync/syncBaseline';
import { bothBaselineScopes } from './sync/cloudScope';
import { createLogger } from '../utils/logger';

const log = createLogger('SQLite');

// Singleton database instance
let db: Database | null = null;
let cleanupDone = false; // Track if zombie cleanup has been done

// Phase 2 Multi-User: dynamic DB name per Supabase UID
let dbName: string | null = null;
// Nom de la base réellement ouverte par le singleton (peut différer de dbName pendant un changement de compte)
let openedName: string | null = null;

/**
 * Configure le nom de la DB pour l'utilisateur Supabase courant.
 * DOIT être appelé dans onAuthStateChange AVANT tout accès DB.
 */
export function setDatabaseName(uid: string): void {
  dbName = `sqlite:nyxplayer_${uid}.db`;
}

/**
 * Retourne le nom de fichier de la DB courante (sans préfixe `sqlite:`).
 * Utilisé par catalogIngestion et fullResetService pour passer au Rust.
 */
export function getDatabaseFileName(): string | null {
  return dbName?.replace('sqlite:', '') ?? null;
}

/**
 * Vrai si la base ouverte (ou qui s'ouvrira au prochain accès) est celle de ce compte Supabase.
 * À vérifier avant d'écrire après une attente réseau : entre-temps, le compte a pu changer et la
 * base du compte suivant être ouverte à sa place.
 */
export function isDatabaseOf(uid: string): boolean {
  const expected = `sqlite:nyxplayer_${uid}.db`;
  return dbName === expected && (db === null || openedName === expected);
}

/**
 * Reset le nom de la DB (appelé au logout Supabase).
 */
export function resetDatabaseName(): void {
  dbName = null;
}

/**
 * La base déjà ouverte, sans jamais l'ouvrir (null sinon). Pour les lectures d'observation (pont
 * d'audit) qui ne doivent pas avancer le moment où l'app ouvre sa base.
 */
export function getOpenDatabase(): Database | null {
  return db;
}

/**
 * Ouverture en cours : les accès simultanés l'attendent au lieu d'ouvrir chacun une connexion.
 * `generation` change à chaque fermeture : une ouverture finie après une
 * fermeture n'est pas installée, sinon la base du compte précédent resterait en place.
 */
let opening: { name: string; promise: Promise<Database> } | null = null;
let generation = 0;

/**
 * Initialize and get the database connection.
 * Throws if dbName is not set (= no Supabase user logged in).
 */
export async function getDatabase(): Promise<Database> {
  if (db) return db;
  if (!dbName) {
    throw new Error('[SQLite] dbName is null — setDatabaseName(uid) must be called before any DB access');
  }
  if (opening && opening.name === dbName) return opening.promise;
  const name = dbName;
  const startedAt = generation;
  const current = { name, promise: openDatabase(name, startedAt) };
  opening = current;
  try {
    return await current.promise;
  } finally {
    if (opening === current) opening = null;
  }
}

/** Ouvre la base, crée le schéma, puis l'installe comme singleton si rien ne l'a fermée entre-temps */
async function openDatabase(name: string, startedAt: number): Promise<Database> {
  const opened = await Database.load(name);
  // Fermée entre-temps, ou autre compte annoncé sans fermeture (SIGNED_IN sans SIGNED_OUT)
  const abandoned = () => generation !== startedAt || dbName !== name;
  if (abandoned()) return discardOpened(opened);

  let schemaError: Error | null = null;
  try {
    await createSchema(opened);
  } catch (e) {
    // Tauri SQL rejette souvent avec une simple chaîne : toujours remonter une Error
    schemaError = e instanceof Error ? e : new Error(String(e));
  }
  if (abandoned()) return discardOpened(opened);

  // Installée seulement une fois le schéma prêt : un accès simultané ne reçoit pas une base sans
  // tables. Comme avant, une erreur de schéma est remontée mais la base reste utilisable.
  db = opened;
  openedName = name;
  if (schemaError) throw schemaError;

  // Cleanup on first load (fire-and-forget)
  if (!cleanupDone) {
    cleanupDone = true;
    Promise.all([
      // Purge zombie playback entries
      opened.execute(`DELETE FROM playback_progress WHERE duration_seconds = 0`),
      // Cache TMDB : supprimer les entrées non consultées depuis > 7 jours
      // Protège les items en watchlist ou playback_progress
      // SQL inliné ici pour éviter import circulaire avec tmdbCacheSqlite.ts
      opened.execute(`
        DELETE FROM tmdb_details_cache
        WHERE cached_at < (unixepoch() - 604800)
          AND tmdb_id NOT IN (SELECT tmdb_id FROM watchlist)
          AND tmdb_id NOT IN (SELECT tmdb_id FROM playback_progress)
      `),
    ]).catch(() => {}); // Silently ignore errors (tables may not exist yet)
  }
  return opened;
}

/**
 * Base fermée (changement de compte, remise à zéro) pendant son ouverture : elle n'est pas
 * installée et l'appelant reçoit une erreur, comme s'il avait accédé à une base fermée. La
 * connexion est refermée si la base n'est plus celle du compte ; même base rouverte entre-temps :
 * le Rust a déjà remplacé la connexion, la fermer par son nom fermerait la nouvelle.
 */
async function discardOpened(opened: Database): Promise<never> {
  if (opened.path !== dbName && opening?.name !== opened.path && !(db && openedName === opened.path)) {
    try {
      await opened.close(opened.path);
    } catch (e) {
      log.warn('Base ouverte pendant une fermeture : fermeture impossible (non bloquant) :', e);
    }
  }
  throw new Error('[SQLite] Base fermée pendant son ouverture');
}

/** Schéma fusionné, colonnes ajoutées après coup et index de recherche (idempotent) */
async function createSchema(database: Database): Promise<void> {
  // Exécuter le schéma fusionné (idempotent — CREATE IF NOT EXISTS)
  await database.execute(MERGED_SCHEMA);

  // Auto-repair v14: ensure sort_order exists on pre-v14 multi-user databases.
  // CREATE TABLE IF NOT EXISTS is a no-op for existing tables, so we need
  // ALTER TABLE to add the column. Silently ignore "duplicate column" errors.
  for (const table of ['movies', 'series', 'live', 'categories']) {
    try {
      await database.execute(`ALTER TABLE ${table} ADD COLUMN sort_order INTEGER DEFAULT 0`);
    } catch {
      // Column already exists — expected
    }
  }

  // Auto-repair v15: ensure epg_channel_id exists on pre-v15 multi-user databases.
  try {
    await database.execute('ALTER TABLE live ADD COLUMN epg_channel_id TEXT');
  } catch {
    // Column already exists — expected
  }

  // Auto-repair v16: ensure match_method exists on pre-v16 multi-user databases.
  try {
    await database.execute('ALTER TABLE live ADD COLUMN match_method TEXT');
  } catch {
    // Column already exists — expected
  }

  // Auto-repair v17: ensure matched_epg_id + geo_hint exist on pre-v17 databases.
  try {
    await database.execute('ALTER TABLE live ADD COLUMN matched_epg_id TEXT');
  } catch {
    // Column already exists — expected
  }
  try {
    await database.execute('ALTER TABLE live ADD COLUMN geo_hint TEXT');
  } catch {
    // Column already exists — expected
  }

  // FTS5 search index (séparé car VIRTUAL TABLE a un comportement différent)
  try {
    await database.execute(`
      CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
        name,
        normalized_name,
        content_type,
        content_id UNINDEXED
      );
    `);
  } catch {
    // FTS5 table already exists — ignore
  }
}

/**
 * Reset the singleton (used by debugFullReset)
 */
export function resetDatabaseSingleton(): void {
  generation++;
  db = null;
  opening = null;
  cleanupDone = false;
}

/**
 * Close the SQLite connection and reset the singleton.
 * CRITICAL for Full Reset: releases the file handle so Rust can delete the .db file.
 * On Windows, deleting a file with an active handle fails with Access Denied.
 */
export async function closeDatabaseConnection(): Promise<void> {
  // Singleton libéré AVANT d'attendre la fermeture : au changement de compte, l'appelant n'attend
  // pas (onAuthStateChange), et un accès du compte suivant pendant la fermeture doit ouvrir sa
  // propre base, pas recevoir celle du compte précédent. Une ouverture en cours n'est
  // plus installée (generation).
  const closing = db;
  const pendingOpen = opening;
  generation++;
  db = null;
  opening = null;
  cleanupDone = false;
  // Ouverture en cours : attendue, pour que sa connexion soit refermée avant de rendre la main (la
  // remise à zéro supprime ensuite le fichier, ce qui échoue sous Windows s'il est encore ouvert)
  if (pendingOpen) await pendingOpen.promise.catch(() => {});
  if (closing) {
    try {
      // Par son nom : sans nom, le Rust ferme toutes les bases, dont celle du compte suivant si
      // elle vient d'être ouverte
      await closing.close(closing.path);
    } catch (e) {
      log.warn('closeDatabaseConnection: close failed (non-fatal):', e);
    }
  }
}

/**
 * Remplace la connexion de la page par une neuve, sous le même nom, sans la fermer d'abord.
 *
 * Après que le Rust `ingestCatalog` (ou le guide) écrit via sa propre connexion rusqlite (WAL),
 * la connexion de la page (secure_db.rs) peut garder une vue périmée. Le Rust remplace le pool
 * sous ce nom : les requêtes en cours finissent sur l'ancien, qu'il supprime ensuite, et les
 * suivantes passent par le neuf. Le schéma n'est pas recréé : l'ingestion et le guide recréent
 * eux-mêmes leurs index et leurs colonnes.
 */
export async function refreshConnection(): Promise<void> {
  // Ouverture en cours : attendue, pour recycler la connexion qu'elle installe
  if (opening) await opening.promise.catch(() => {});
  const current = db;
  if (!current) {
    await getDatabase();
    return;
  }
  // Autre compte annoncé sans fermeture : sa base remplacera celle-ci à la fermeture
  if (openedName !== dbName) return;
  // Fermer puis rouvrir laissait un moment où une synchro qui tenait déjà la base (reprises, Live
  // TV, lancées à la connexion) tombait sur « attempted to acquire a connection on a closed pool »
  const startedAt = generation;
  const reopened = await Database.load(current.path);
  // Fermée entre-temps (déconnexion, remise à zéro) : la connexion rouverte ne reste pas ouverte
  if (generation !== startedAt || dbName !== current.path) await discardOpened(reopened);
}

// ============================================================================
// META OPERATIONS
// ============================================================================

export async function getMeta(key: string): Promise<string | null> {
  const database = await getDatabase();
  const result = await database.select<{ value: string }[]>(
    'SELECT value FROM meta WHERE key = ?',
    [key]
  );
  return result.length > 0 ? result[0].value : null;
}

export async function setMeta(key: string, value: string): Promise<void> {
  const database = await getDatabase();
  await database.execute(
    'INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)',
    [key, value]
  );
}

// ============================================================================
// UTILITY
// ============================================================================

/**
 * Purge ALL tables — Commande de diagnostic DEV uniquement.
 *
 * ⚠️  NON utilisé par l'app en production (le Full Reset supprime le .db directement).
 * Exposé via debugTools.ts → window.debugClearSQLite() dans la console F12.
 *
 * Vide les 15 tables applicatives via la connexion ouverte (garde la structure).
 */
export async function purgeAllTables(): Promise<void> {
  const database = await getDatabase();
  // Les derniers accords avec le cloud disparaissent avec `meta` : une synchro en cours ne peut plus
  // les réécrire
  bumpGeneration();

  // Ordre: dépendances d'abord (pas de FK, mais logiquement cohérent)
  const tables = [
    // Caches (safe to drop first)
    'tmdb_details_cache',
    'cache_lists',
    'xtream_series_cache',
    'lightmaps_cache',
    // User data
    'playback_progress',
    'watchlist',
    'content_preferences',
    'user_preferences',
    'live_tv_favorites',
    'live_tv_pinned_categories',
    'hidden_categories',
    // EPG data
    'epg_programs',
    // Core catalog
    'movies',
    'series',
    'live',
    'categories',
    // Metadata
    'meta',
  ];

  for (const table of tables) {
    try {
      await database.execute(`DELETE FROM ${table}`);
    } catch {
      // Table may not exist (migration not yet applied) — skip silently
    }
  }

  // Clear FTS5 search index if it exists
  try {
    await database.execute(`DELETE FROM search_index`);
  } catch {
    // FTS5 table may not exist
  }

  window.dispatchEvent(new CustomEvent(WATCHLIST_EVENT));
}

/**
 * Clear catalog data only (movies/series/live/categories).
 * Used by startFresh() via StorageService.clearAll().
 * Resilient: silently ignores missing tables (e.g. after full reset deleted .db).
 */
export async function clearAllData(): Promise<void> {
  const database = await getDatabase();
  // Une synchro de Ma liste en cours ne peut plus réécrire le dernier accord effacé ci-dessous :
  // Ma liste vide + dernier accord rétabli = titres retirés du cloud
  bumpGeneration(bothBaselineScopes('watchlist'));
  try { await database.execute('DELETE FROM movies'); } catch { /* table may not exist */ }
  try { await database.execute('DELETE FROM series'); } catch { /* table may not exist */ }
  try { await database.execute('DELETE FROM live'); } catch { /* table may not exist */ }
  try { await database.execute('DELETE FROM categories'); } catch { /* table may not exist */ }
  try { await database.execute('DELETE FROM watchlist'); } catch { /* table may not exist */ }
  // Ma liste vidée en local : son dernier accord avec le cloud ne vaut plus (sinon la synchro
  // suivante prendrait ce vide pour des retraits et viderait Ma liste du cloud, sync/syncBaseline.ts)
  // Les deux derniers accords de Ma liste : tables du cloud d'une seule source et par fournisseur
  try { await database.execute(`DELETE FROM meta WHERE key IN ('sync_baseline:watchlist', 'sync_baseline:watchlist_v2')`); } catch { /* table may not exist */ }
  // « Ma liste » vidée : la mémoire de watchlistHydration et les cartes se mettent à jour
  window.dispatchEvent(new CustomEvent(WATCHLIST_EVENT));
}

/**
 * Vide le catalogue seulement (films, séries, chaînes, catégories), avant la lecture complète d'une
 * connexion. Ma liste est gardée avec son dernier accord avec le cloud : un titre ajouté hors ligne
 * et pas encore envoyé part au cloud à la synchro qui suit, et la re-liaison remet chaque titre au
 * numéro du nouveau catalogue.
 */
export async function clearCatalogData(): Promise<void> {
  const database = await getDatabase();
  for (const table of ['movies', 'series', 'live', 'categories']) {
    try { await database.execute(`DELETE FROM ${table}`); } catch { /* table may not exist */ }
  }
}

/**
 * Vrai si le catalogue en base contient au moins une chaîne, un film ou une série. Ne compter que
 * les films faisait croire qu'un fournisseur « chaînes seulement » n'avait rien : la session n'était
 * pas reprise et les identifiants redemandés à chaque lancement. Une base vide (première
 * connexion interrompue, catalogue vidé) reste « sans contenu ». Le catalogue est écrit d'un bloc
 * (transaction unique côté Rust) : un arrêt de l'app ne le laisse pas à moitié rempli. Une liste en
 * échec à la connexion peut laisser sa section vide : la session est alors reprise, signalée
 * partielle (`lastIngestionPartial`), et l'actualisation automatique complète le catalogue.
 */
export async function hasContent(): Promise<boolean> {
  const database = await getDatabase();
  const result = await database.select<{ count: number }[]>(
    `SELECT (EXISTS(SELECT 1 FROM live) OR EXISTS(SELECT 1 FROM movies) OR EXISTS(SELECT 1 FROM series)) as count`
  );
  return (result[0]?.count ?? 0) > 0;
}

// ============================================================================
// MERGED SCHEMA — Phase 2 Multi-User
// ============================================================================
//
// Schéma final fusionné des 15 migrations (v1→v15).
// Exécuté à chaque nouvelle connexion via CREATE TABLE IF NOT EXISTS (idempotent).
// Les colonnes ajoutées par ALTER TABLE (v8, v9, v13, v14, v15) sont intégrées directement.
//
// NOTE: les tables FTS5 ne supportent pas IF NOT EXISTS de la même manière.
// On les crée séparément avec un try/catch.

const MERGED_SCHEMA = `
  -- ===== Core catalog =====

  CREATE TABLE IF NOT EXISTS movies (
    id INTEGER PRIMARY KEY,
    tmdb_id INTEGER,
    name TEXT NOT NULL,
    icon TEXT,
    category_id TEXT,
    added INTEGER,
    rating REAL,
    data TEXT,
    container_extension TEXT,
    sort_order INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_movies_tmdb ON movies(tmdb_id);
  CREATE INDEX IF NOT EXISTS idx_movies_category ON movies(category_id);
  CREATE INDEX IF NOT EXISTS idx_movies_added ON movies(added);

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
  CREATE INDEX IF NOT EXISTS idx_series_tmdb ON series(tmdb_id);

  -- Liens TMDB trouvés par le titre pour une liste M3U (même table côté Rust, schema.rs)
  CREATE TABLE IF NOT EXISTS m3u_tmdb_links (
    kind TEXT NOT NULL,
    id INTEGER NOT NULL,
    name TEXT NOT NULL,
    tmdb_id INTEGER NOT NULL,
    checked_at INTEGER NOT NULL,
    PRIMARY KEY (kind, id)
  );
  CREATE INDEX IF NOT EXISTS idx_series_category ON series(category_id);

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
  CREATE INDEX IF NOT EXISTS idx_live_category ON live(category_id);

  -- Clé (type, numéro) : des fournisseurs numérotent chaque type à part. Bases d'avant mises à
  -- niveau par le Rust à l'ouverture (schema.rs, upgrade_categories_key)
  CREATE TABLE IF NOT EXISTS categories (
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0,
    PRIMARY KEY (type, id)
  );

  -- ===== Metadata =====

  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  -- ===== Caches =====

  CREATE TABLE IF NOT EXISTS lightmaps_cache (
    id INTEGER PRIMARY KEY,
    data_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    data TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tmdb_details_cache (
    tmdb_id INTEGER NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('movie', 'series', 'season')),
    season_number INTEGER NOT NULL DEFAULT 0,
    display_name TEXT,
    display_date TEXT,
    poster_path TEXT,
    backdrop_path TEXT,
    overview TEXT,
    vote_average REAL,
    number_of_seasons INTEGER,
    full_data TEXT NOT NULL,
    cached_at INTEGER NOT NULL,
    ttl_seconds INTEGER NOT NULL,
    is_referenced INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(tmdb_id, type, season_number)
  );
  CREATE INDEX IF NOT EXISTS idx_tmdb_cache_display
    ON tmdb_details_cache(tmdb_id, type, display_name, poster_path);
  CREATE INDEX IF NOT EXISTS idx_tmdb_cache_cleanup
    ON tmdb_details_cache(cached_at, is_referenced);

  -- Affiche TMDB des titres reliés par leur nom (listes sans image) : notée lors de la recherche, sans demande en plus
  CREATE TABLE IF NOT EXISTS title_tmdb_posters (
    kind TEXT NOT NULL,
    tmdb_id INTEGER NOT NULL,
    poster_path TEXT NOT NULL,
    PRIMARY KEY (kind, tmdb_id)
  );

  CREATE TABLE IF NOT EXISTS cache_lists (
    cache_key TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    cached_at INTEGER NOT NULL,
    ttl_seconds INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS xtream_series_cache (
    series_id INTEGER PRIMARY KEY,
    data TEXT NOT NULL,
    cached_at INTEGER NOT NULL,
    ttl_seconds INTEGER NOT NULL
  );

  -- ===== User data =====

  CREATE TABLE IF NOT EXISTS playback_progress (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content_type TEXT NOT NULL CHECK(content_type IN ('movie', 'episode')),
    stream_id INTEGER NOT NULL,
    tmdb_id INTEGER DEFAULT 0,
    title TEXT NOT NULL,
    poster_url TEXT,
    series_id INTEGER,
    season_number INTEGER,
    episode_number INTEGER,
    next_episode_id TEXT,
    next_season INTEGER,
    next_episode_number INTEGER,
    time_seconds REAL NOT NULL,
    duration_seconds REAL NOT NULL,
    updated_at INTEGER NOT NULL,
    container_extension TEXT,
    UNIQUE(stream_id)
  );
  CREATE INDEX IF NOT EXISTS idx_playback_tmdb
    ON playback_progress(tmdb_id, content_type);
  CREATE INDEX IF NOT EXISTS idx_playback_updated
    ON playback_progress(updated_at DESC);

  CREATE TABLE IF NOT EXISTS watchlist (
    stream_id INTEGER NOT NULL,
    tmdb_id INTEGER DEFAULT 0,
    type TEXT NOT NULL CHECK(type IN ('movie', 'series')),
    added_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
    PRIMARY KEY (stream_id, type)
  );
  CREATE INDEX IF NOT EXISTS idx_watchlist_added
    ON watchlist(added_at DESC);

  CREATE TABLE IF NOT EXISTS user_preferences (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
  );

  CREATE TABLE IF NOT EXISTS content_preferences (
    content_type TEXT NOT NULL,
    identifier TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
    PRIMARY KEY (content_type, identifier, key)
  );

  CREATE TABLE IF NOT EXISTS live_tv_favorites (
    stream_id INTEGER PRIMARY KEY,
    added_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
  );

  CREATE TABLE IF NOT EXISTS live_tv_pinned_categories (
    category_id TEXT PRIMARY KEY,
    added_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
  );

  CREATE TABLE IF NOT EXISTS hidden_categories (
    category_id TEXT NOT NULL,
    type TEXT NOT NULL,
    PRIMARY KEY (category_id, type)
  );

  -- ===== Sources IPTV (services/sources/sourceRegistry.ts) =====
  -- Partie affichable seulement : identifiants et adresses complètes restent au coffre

  CREATE TABLE IF NOT EXISTS iptv_sources (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('xtream', 'm3u')),
    host_label TEXT NOT NULL DEFAULT '',
    provider_hash TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    show_in_catalog INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  -- ===== Picon cache =====

  CREATE TABLE IF NOT EXISTS picon_cache (
    channel_key  TEXT PRIMARY KEY,
    url          TEXT,
    updated_at   INTEGER NOT NULL
  );

  -- ===== EPG (v15) =====

  CREATE TABLE IF NOT EXISTS epg_programs (
    channel_id TEXT NOT NULL,
    title TEXT NOT NULL,
    start_ts INTEGER NOT NULL,
    stop_ts INTEGER NOT NULL,
    description TEXT,
    PRIMARY KEY (channel_id, start_ts)
  );
  CREATE INDEX IF NOT EXISTS idx_epg_start ON epg_programs(start_ts);
  -- idx_epg_channel_start removed: redundant with PK (channel_id, start_ts)
  -- New: covering index for the "now playing" query (WHERE channel_id IN (...) AND stop_ts > ?)
  CREATE INDEX IF NOT EXISTS idx_epg_channel_stop ON epg_programs(channel_id, stop_ts);

  CREATE TABLE IF NOT EXISTS epg_channels (
    id TEXT PRIMARY KEY NOT NULL,
    display_name TEXT NOT NULL DEFAULT ''
  );
`;

