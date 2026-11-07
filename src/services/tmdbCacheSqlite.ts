/**
 * TMDB Cache SQLite Service
 * 
 * Replaces localStorage-based tmdbCache.ts with SQLite storage.
 * Uses 2 tables: tmdb_details_cache, cache_lists
 * 
 * Key features:
 * - Unified display_name/display_date (handles movie vs series differences)
 * - TTL-based expiration with is_referenced protection for watchlist items
 * - Covering index for fast JOINs with watchlist/playback_progress
 * 
 * Note: Xtream series cache extracted to xtreamSeriesCache.ts
 */

import { getDatabase } from './dbCore';
import type { TmdbMovieDetails } from '../types/tmdb';
import type { TmdbTvDetails } from '../types/tmdb';
import { nowSeconds, isCacheValid } from '../utils/timeHelpers';
import { createLogger } from '../utils/logger';

const log = createLogger('TmdbCacheSqlite');

// ============================================================================
// CONSTANTS - TTL in seconds
// ============================================================================

/** 7 days for movie/series details (rarely change) */
const TTL_DETAILS = 7 * 24 * 60 * 60; // 604800

/** 24 hours for lists (trending, now_playing, etc.) */
const TTL_LISTS = 24 * 60 * 60; // 86400


// ============================================================================
// EVENT BUS - Notify when movie/TV details are cached
// ============================================================================

type DetailsUpdateListener = (tmdbId: number, type: 'movie' | 'series') => void;
const detailsListeners = new Set<DetailsUpdateListener>();

/**
 * Subscribe to TMDB details cache updates
 * Used by WatchlistContext to refresh when details are enriched
 * @returns Unsubscribe function
 */
export function onDetailsUpdate(callback: DetailsUpdateListener): () => void {
  detailsListeners.add(callback);
  return () => detailsListeners.delete(callback);
}

/**
 * Notify all listeners that details were cached
 */
function notifyDetailsUpdate(tmdbId: number, type: 'movie' | 'series'): void {
  detailsListeners.forEach((cb) => cb(tmdbId, type));
}

// ============================================================================
// TYPES
// ============================================================================

/** Content type for TMDB cache */
type TmdbCacheType = 'movie' | 'series' | 'season';

/** Row in tmdb_details_cache table */
interface TmdbDetailsCacheRow {
  tmdb_id: number;
  type: TmdbCacheType;
  season_number: number;
  display_name: string | null;
  display_date: string | null;
  poster_path: string | null;
  backdrop_path: string | null;
  overview: string | null;
  vote_average: number | null;
  number_of_seasons: number | null;
  full_data: string;
  cached_at: number;
  ttl_seconds: number;
  is_referenced: number;
}

/** Row in cache_lists table */
interface CacheListRow {
  cache_key: string;
  data: string;
  cached_at: number;
  ttl_seconds: number;
}


// Utility functions (nowSeconds, isCacheValid) imported from utils/timeHelpers.ts

/** Intervalle minimal entre deux « touch » de la date d'une entrée (secondes) : un jour. */
const TOUCH_INTERVAL_SECONDS = 24 * 60 * 60;

// ============================================================================
// TMDB DETAILS CACHE (movies, series, seasons)
// ============================================================================

/**
 * Get cached TMDB details for a movie or series.
 * Returns null if not found.
 * Touches cached_at on read to keep the entry alive (LRU), au plus une fois par jour : la durée de
 * vie se compte en jours, une écriture à chaque ouverture de fiche était inutile.
 */
export async function getCachedDetails<T>(
  tmdbId: number,
  type: TmdbCacheType,
  seasonNumber = 0
): Promise<T | null> {
  const db = await getDatabase();
  
  const results = await db.select<Pick<TmdbDetailsCacheRow, 'full_data' | 'cached_at'>[]>(
    `SELECT full_data, cached_at FROM tmdb_details_cache
     WHERE tmdb_id = ? AND type = ? AND season_number = ?`,
    [tmdbId, type, seasonNumber]
  );

  if (results.length === 0) return null;

  const row = results[0];

  // Touch : relancer la durée de vie (fire-and-forget), si la dernière date a plus d'un jour
  const now = nowSeconds();
  if (!(typeof row.cached_at === 'number' && now - row.cached_at < TOUCH_INTERVAL_SECONDS)) {
    db.execute(
      `UPDATE tmdb_details_cache SET cached_at = ? WHERE tmdb_id = ? AND type = ? AND season_number = ?`,
      [now, tmdbId, type, seasonNumber]
    ).catch(() => {});
  }
  
  // Fiche gardée pour Ma liste lors d'un changement de langue : à redemander (ensureCacheLanguage)
  if (!row.full_data) return null;

  try {
    return JSON.parse(row.full_data) as T;
  } catch {
    log.error(`Failed to parse cached data for ${type} ${tmdbId}`);
    return null;
  }
}

/**
 * Cache TMDB details for a movie
 * Handles display_name/display_date unification
 */
export async function cacheMovieDetails(
  tmdbId: number,
  data: TmdbMovieDetails,
  options: { notify?: boolean } = {},
): Promise<void> {
  try {
    const db = await getDatabase();
    
    await db.execute(
      `INSERT OR REPLACE INTO tmdb_details_cache 
       (tmdb_id, type, season_number, display_name, display_date, poster_path, backdrop_path, overview, vote_average, number_of_seasons, full_data, cached_at, ttl_seconds, is_referenced)
       VALUES (?, 'movie', 0, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 
         COALESCE((SELECT is_referenced FROM tmdb_details_cache WHERE tmdb_id = ? AND type = 'movie' AND season_number = 0), 0))`,
      [
        tmdbId,
        data.title || null,
        data.release_date || null,
        data.poster_path || null,
        data.backdrop_path || null,
        data.overview || null,
        data.vote_average ?? null,
        JSON.stringify(data),
        nowSeconds(),
        TTL_DETAILS,
        tmdbId
      ]
    );
    
    
    // Fiche gardée pour la bannière de l'accueil : Ma liste n'a pas à se relire pour elle
    if (options.notify !== false) notifyDetailsUpdate(tmdbId, 'movie');
  } catch (error) {
    log.error(`Failed to cache movie ${tmdbId}:`, error);
  }
}

/**
 * Cache TMDB details for a series
 * Handles display_name/display_date unification
 */
export async function cacheSeriesDetails(tmdbId: number, data: TmdbTvDetails): Promise<void> {
  try {
    const db = await getDatabase();
    
    await db.execute(
      `INSERT OR REPLACE INTO tmdb_details_cache 
       (tmdb_id, type, season_number, display_name, display_date, poster_path, backdrop_path, overview, vote_average, number_of_seasons, full_data, cached_at, ttl_seconds, is_referenced)
       VALUES (?, 'series', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
         COALESCE((SELECT is_referenced FROM tmdb_details_cache WHERE tmdb_id = ? AND type = 'series' AND season_number = 0), 0))`,
      [
        tmdbId,
        data.name || null,
        data.first_air_date || null,
        data.poster_path || null,
        data.backdrop_path || null,
        data.overview || null,
        data.vote_average ?? null,
        data.number_of_seasons ?? null,
        JSON.stringify(data),
        nowSeconds(),
        TTL_DETAILS,
        tmdbId
      ]
    );
    
    
    notifyDetailsUpdate(tmdbId, 'series');
  } catch (error) {
    log.error(`Failed to cache series ${tmdbId}:`, error);
  }
}

/**
 * Cache TMDB season details
 */
export async function cacheSeasonDetails(tmdbId: number, seasonNumber: number, data: unknown): Promise<void> {
  try {
    const db = await getDatabase();
    
    await db.execute(
      `INSERT OR REPLACE INTO tmdb_details_cache 
       (tmdb_id, type, season_number, display_name, display_date, poster_path, backdrop_path, overview, vote_average, number_of_seasons, full_data, cached_at, ttl_seconds, is_referenced)
       VALUES (?, 'season', ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, 0)`,
      [
        tmdbId,
        seasonNumber,
        JSON.stringify(data),
        nowSeconds(),
        TTL_DETAILS
      ]
    );

  } catch (error) {
    log.error(`Failed to cache season ${tmdbId} S${seasonNumber}:`, error);
  }
}

// ============================================================================
// CACHE LISTS (trending, now_playing, genres, etc.)
// ============================================================================

/** Cache keys for lists */
type CacheListKey = 
  | 'trending'
  | 'now_playing'
  | 'on_the_air'
  | 'top_rated'
  | 'popular'
  | 'hero'
  | `genre_${number}`
  | 'this_week_movies'
  | 'this_week_series';

/**
 * Get a cached list (trending, now_playing, etc.)
 * Returns null if not found or expired
 */
export async function getCachedList<T>(key: CacheListKey): Promise<T[] | null> {
  const db = await getDatabase();
  
  const results = await db.select<CacheListRow[]>(
    `SELECT data, cached_at, ttl_seconds FROM cache_lists WHERE cache_key = ?`,
    [key]
  );
  
  if (results.length === 0) return null;
  
  const row = results[0];
  
  if (!isCacheValid(row.cached_at, row.ttl_seconds)) {
    return null;
  }
  
  try {
    return JSON.parse(row.data) as T[];
  } catch {
    log.error(`Failed to parse list cache for ${key}`);
    return null;
  }
}

/**
 * Cache a list (trending, now_playing, etc.)
 */
export async function setCachedList<T>(key: CacheListKey, data: T[]): Promise<void> {
  try {
    const db = await getDatabase();
    
    await db.execute(
      `INSERT OR REPLACE INTO cache_lists (cache_key, data, cached_at, ttl_seconds)
       VALUES (?, ?, ?, ?)`,
      [key, JSON.stringify(data), nowSeconds(), TTL_LISTS]
    );
  } catch (error) {
    log.error(`Failed to cache list ${key}:`, error);
  }
}

// ============================================================================
// STATS AND SELECTIVE CLEAR (for SettingsPage)
// ============================================================================

interface CacheStats {
  movies: number;
  series: number;
  seasons: number;
  lists: number;
  xtreamSeries: number;
  total: number;
}

/**
 * Get cache statistics for all TMDB tables
 */
export async function getCacheStats(): Promise<CacheStats> {
  const db = await getDatabase();
  
  const [movieCount, seriesCount, seasonCount, listCount, xtreamCount] = await Promise.all([
    db.select<{ count: number }[]>(`SELECT COUNT(*) as count FROM tmdb_details_cache WHERE type = 'movie'`),
    db.select<{ count: number }[]>(`SELECT COUNT(*) as count FROM tmdb_details_cache WHERE type = 'series'`),
    db.select<{ count: number }[]>(`SELECT COUNT(*) as count FROM tmdb_details_cache WHERE type = 'season'`),
    db.select<{ count: number }[]>('SELECT COUNT(*) as count FROM cache_lists'),
    db.select<{ count: number }[]>('SELECT COUNT(*) as count FROM xtream_series_cache')
  ]);
  
  const movies = movieCount[0]?.count || 0;
  const series = seriesCount[0]?.count || 0;
  const seasons = seasonCount[0]?.count || 0;
  const lists = listCount[0]?.count || 0;
  const xtreamSeries = xtreamCount[0]?.count || 0;
  
  return {
    movies,
    series,
    seasons,
    lists,
    xtreamSeries,
    total: movies + series + seasons + lists + xtreamSeries
  };
}

/**
 * Clear cache by content type (movies or series)
 */
export async function clearCacheByType(type: 'movies' | 'series'): Promise<void> {
  const db = await getDatabase();
  
  if (type === 'movies') {
    await db.execute(`DELETE FROM tmdb_details_cache WHERE type = 'movie'`);
  } else {
    await Promise.all([
      db.execute(`DELETE FROM tmdb_details_cache WHERE type IN ('series', 'season')`),
      db.execute('DELETE FROM xtream_series_cache')
    ]);
  }
}

/**
 * Clear all cache data (for debugging or logout)
 */
export async function clearAllCache(): Promise<void> {
  const db = await getDatabase();
  
  await Promise.all([
    db.execute('DELETE FROM tmdb_details_cache'),
    db.execute('DELETE FROM cache_lists'),
    db.execute('DELETE FROM xtream_series_cache')
  ]);
}

/** Ligne témoin de cache_lists : langue TMDB dans laquelle le cache a été rempli */
const CACHE_LANGUAGE_KEY = '__tmdb_cache_language';

/**
 * Langue du cache laissé par la 0.7.6, qui ne notait pas de langue : les fiches y étaient demandées
 * en français, sauf si l'anglais avait été choisi dans les Paramètres.
 */
const LANGUAGE_BEFORE_WITNESS = 'fr-FR';

/**
 * Fiches gardées quand la langue change : films et séries de Ma liste et de « Reprendre » (même
 * règle que le nettoyage de dbCore.ts). Ma liste n'a pas d'autre copie du nom et de l'affiche, et
 * un titre « Introuvable » ne peut plus les retrouver (sa fiche ne s'ouvre pas).
 */
const KEPT_ON_LANGUAGE_CHANGE = `type IN ('movie', 'series') AND season_number = 0
  AND (tmdb_id IN (SELECT tmdb_id FROM watchlist WHERE tmdb_id > 0)
    OR tmdb_id IN (SELECT tmdb_id FROM playback_progress WHERE tmdb_id > 0))`;

/**
 * Vide ce qui dépend de la langue : listes de l'accueil, saisons et fiches consultées. Les fiches de
 * Ma liste et de « Reprendre » gardent nom et affiche pour l'affichage, mais perdent la fiche
 * complète (`full_data` vide) : elle est redemandée dans la nouvelle langue à la prochaine
 * ouverture. Les épisodes du fournisseur (`xtream_series_cache`) ne dépendent pas de la langue.
 * `cache_lists`, qui porte le témoin de langue, est vidé en dernier : une app arrêtée en cours de
 * route garde l'ancien témoin et recommence au lancement suivant.
 */
async function clearLanguageDependentCache(): Promise<void> {
  const db = await getDatabase();
  await db.execute(`UPDATE tmdb_details_cache SET full_data = '' WHERE ${KEPT_ON_LANGUAGE_CHANGE}`);
  await db.execute(`DELETE FROM tmdb_details_cache WHERE NOT (${KEPT_ON_LANGUAGE_CHANGE})`);
  await db.execute('DELETE FROM cache_lists');
}

/**
 * Vide le cache TMDB s'il a été rempli dans une autre langue que `lang`.
 * Le cache n'est pas indexé par langue : sans ce contrôle, des titres français
 * mis en cache par erreur restaient affichés en anglais.
 * Premier lancement après la 0.7.6 (pas de langue notée) en français : le cache est déjà dans la
 * bonne langue, rien n'est vidé.
 * Retourne true si le cache a été vidé.
 */
export async function ensureCacheLanguage(lang: string): Promise<boolean> {
  try {
    const db = await getDatabase();
    const rows = await db.select<{ data: string }[]>(
      `SELECT data FROM cache_lists WHERE cache_key = ?`,
      [CACHE_LANGUAGE_KEY]
    );
    const noted = rows[0]?.data;
    if (noted === lang) return false;
    const cleared = !(noted === undefined && lang === LANGUAGE_BEFORE_WITNESS);

    if (cleared) await clearLanguageDependentCache();
    await db.execute(
      `INSERT OR REPLACE INTO cache_lists (cache_key, data, cached_at, ttl_seconds)
       VALUES (?, ?, ?, ?)`,
      [CACHE_LANGUAGE_KEY, lang, nowSeconds(), 0]
    );
    return cleared;
  } catch (error) {
    log.error('Failed to check cache language:', error);
    return false;
  }
}

// ============================================================================
// DEBUG FUNCTIONS
// ============================================================================

// Commandes de console de développement (window.debug*) : elles écrivent directement dans la console.
/* eslint-disable no-console -- commandes window.debug* tapées à la main (docs/CONVENTIONS.md) */
if (typeof window !== 'undefined') {
  /**
   * Show TMDB cache statistics
   */
  (window as unknown as Record<string, unknown>).debugTmdbCacheStats = async () => {
    const db = await getDatabase();
    
    const [details, lists, xtream] = await Promise.all([
      db.select<{ count: number; referenced: number }[]>(`
        SELECT COUNT(*) as count, SUM(is_referenced) as referenced 
        FROM tmdb_details_cache
      `),
      db.select<{ count: number }[]>('SELECT COUNT(*) as count FROM cache_lists'),
      db.select<{ count: number }[]>('SELECT COUNT(*) as count FROM xtream_series_cache')
    ]);
    
    console.table({
      'tmdb_details_cache': { total: details[0].count, referenced: details[0].referenced },
      'cache_lists': lists[0].count,
      'xtream_series_cache': xtream[0].count
    });
  };
  
  /**
   * Clear all TMDB cache
   */
  (window as unknown as Record<string, unknown>).debugClearTmdbCache = async () => {
    await clearAllCache();
    console.log('✅ TMDB cache cleared!');
  };

  /**
   * List all cache entries with human-readable dates
   * Usage: debugTmdbCacheList()
   */
  (window as unknown as Record<string, unknown>).debugTmdbCacheList = async () => {
    const db = await getDatabase();
    const rows = await db.select<{
      tmdb_id: number;
      type: string;
      season_number: number;
      display_name: string | null;
      cached_at: number;
    }[]>(`
      SELECT tmdb_id, type, season_number, display_name, cached_at
      FROM tmdb_details_cache
      ORDER BY cached_at DESC
    `);

    const formatted = rows.map(r => ({
      tmdb_id: r.tmdb_id,
      type: r.type,
      season: r.season_number,
      name: r.display_name || '(no name)',
      cached_at: new Date(r.cached_at * 1000).toLocaleString(),
      age_hours: Math.round((Date.now() / 1000 - r.cached_at) / 3600),
    }));

    console.table(formatted);
    console.log(`Total: ${rows.length} entrées`);
  };

  /**
   * Age all cache entries — sets cached_at to 8 days ago
   * After running this, restart the app to trigger cleanup.
   * Protected items (watchlist/playback) will survive.
   * Usage: debugAgeTmdbCache()
   */
  (window as unknown as Record<string, unknown>).debugAgeTmdbCache = async () => {
    const db = await getDatabase();
    const eightDaysAgo = Math.floor(Date.now() / 1000) - (8 * 24 * 60 * 60);
    await db.execute(
      `UPDATE tmdb_details_cache SET cached_at = ?`,
      [eightDaysAgo]
    );
    const [{ count }] = await db.select<{ count: number }[]>(
      'SELECT COUNT(*) as count FROM tmdb_details_cache'
    );
    console.log(`⏳ ${count} entrées vieillies à 8 jours. Redémarre l'app pour déclencher le cleanup.`);
    console.log(`   → Les items en watchlist/playback survivront.`);
  };
}
/* eslint-enable no-console */
