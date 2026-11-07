/**
 * LightItem - Lightweight representation of IPTV content for RAM optimization
 * 
 * These types store only the essential fields needed for:
 * - Display in lists/carousels (name, icon)
 * - Quick lookups (id, tmdbId)
 * - Categorization (categoryId, type)
 * 
 * Full item details are fetched on-demand from SQLite when needed.
 * 
 * OPTIMIZATION: Icon URLs use string interning to save ~25MB RAM.
 * Instead of storing full URLs, we store prefixId + suffix.
 * Example: "http://provider.com/images/movie_123.jpg" becomes:
 *   prefixId: 0 (index into iconPrefixes registry)
 *   iconSuffix: "movie_123.jpg"
 */

/** Minimal representation of a movie for RAM efficiency */
export interface LightMovie {
  id: number;           // stream_id
  name: string;         // Display name
  iconPrefixId: number; // Index into iconPrefixes registry
  iconSuffix: string;   // Filename part of icon URL
  tmdbId: number;       // TMDB ID for matching (0 if unknown)
  categoryId: string;   // Category ID for filtering
  added: number;        // Unix timestamp when added (for ThisWeek carousel)
  containerExt: string; // container_extension (mp4, mkv...) pour l'URL de streaming
}

/** Minimal representation of a series for RAM efficiency */
export interface LightSeries {
  id: number;           // series_id
  name: string;         // Display name
  iconPrefixId: number; // Index into iconPrefixes registry
  iconSuffix: string;   // Filename part of cover URL
  tmdbId: number;       // TMDB ID for matching (0 if unknown)
  categoryId: string;   // Category ID for filtering
  added: number;        // Unix timestamp (last_modified) for ThisWeek carousel
}

/** Minimal representation of a live stream for RAM efficiency */
export interface LightLive {
  id: number;           // stream_id
  name: string;         // Display name
  iconPrefixId: number; // Index into iconPrefixes registry
  iconSuffix: string;   // Filename part of icon URL
  categoryId: string;   // Category ID for filtering
  epgChannelId?: string; // Original EPG channel ID from M3U (tf1.fr)
  matchedEpgId?: string; // Matched EPG TVG-ID after parsing (tf1.fr)
  matchMethod?: string; // String indicating logic used to match (Pass 1-5) 
}

/** Category mapping for display */
export interface LightCategory {
  id: string;
  name: string;
  type: 'movie' | 'series' | 'live';
}

/** Clé d'une catégorie dans `LightIndexes.categories` : le numéro seul ne suffit pas (même numéro pour un film et une chaîne chez certains fournisseurs) */
export function categoryKey(type: LightCategory['type'], id: string): string {
  return `${type}:${id}`;
}

/** Container for all light indexes */
export interface LightIndexes {
  movies: Map<number, LightMovie>;       // by stream_id
  series: Map<number, LightSeries>;      // by series_id
  live: Map<number, LightLive>;          // by stream_id
  /** Par `categoryKey(type, id)` : un même numéro peut désigner une catégorie de films et une de chaînes */
  categories: Map<string, LightCategory>;
  // TMDB lookup indexes for matching
  moviesByTmdb: Map<number, LightMovie>;  // by tmdbId
  seriesByTmdb: Map<number, LightSeries>; // by tmdbId
  // Icon URL reconstruction registry (string interning optimization)
  iconPrefixes: string[];  // prefixId -> prefix URL (e.g., "http://provider.com/images/")
}


/**
 * Reconstruct full icon URL from prefixId and suffix.
 * TMDB URLs from providers often use oversized formats (w600_and_h900_bestv2, w500, etc.)
 * We rewrite them to w342 (342×513px) which is sufficient for 250px-wide carousel cards.
 */
export function getIconUrl(
  item: { iconPrefixId: number; iconSuffix: string },
  prefixes: string[]
): string {
  if (item.iconPrefixId < 0 || !item.iconSuffix) return '';
  const prefix = prefixes[item.iconPrefixId] || '';
  const url = prefix + item.iconSuffix;

  // Rewrite oversized TMDB image URLs → w342
  if (url.includes('image.tmdb.org')) {
    return url.replace(/\/t\/p\/[^/]+\//, '/t/p/w342/');
  }

  return url;
}
