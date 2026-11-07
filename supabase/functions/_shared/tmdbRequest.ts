/**
 * TMDB relay: what a caller may ask for, and what may be written to the shared cache.
 * Every value that becomes part of a cache key is checked against a closed list or normalised, so a
 * single account can no longer create rows at will (invented languages, ids with leading zeros,
 * free-text searches, unbounded genre lists). Pure functions: tested from the app's test suite.
 */

/** The only languages the app sends (src/utils/tmdbLanguage.ts, 0.7.6 included). */
export const TMDB_LANGUAGES: ReadonlySet<string> = new Set(["fr-FR", "en-US"]);
export const TMDB_DEFAULT_LANGUAGE = "en-US";

/** Above this many rows, new keys are served without being cached (production: 217 rows when this was set). */
export const TMDB_CACHE_MAX_ROWS = 3000;
/** Larger TMDB answers are served without being cached (largest real entry: ~0.6 MB of JSON). */
export const TMDB_CACHE_MAX_ENTRY_CHARS = 1_000_000;

const MAX_GENRES = 5;
const MAX_GENRES_LENGTH = 40;

/** Closed list: null when the language is not one the app uses; missing means the default. */
export function normalizeLanguage(raw: string | null): string | null {
  if (!raw) return TMDB_DEFAULT_LANGUAGE;
  return TMDB_LANGUAGES.has(raw) ? raw : null;
}

/**
 * Numeric id without leading zeros ("0550" and "550" are the same TMDB title, one cache row),
 * at most `maxDigits` significant digits. Zero is refused unless `allowZero` (season 0 = specials).
 */
export function normalizeId(raw: string, maxDigits: number, allowZero = false): string | null {
  if (!/^\d{1,20}$/.test(raw)) return null;
  const id = raw.replace(/^0+(?=\d)/, "");
  if (id.length > maxDigits) return null;
  if (id === "0" && !allowZero) return null;
  return id;
}

/** TMDB title ids (movies, series, genres): 9 digits leave room far above today's ~1.5 million. */
export function normalizeTmdbId(raw: string): string | null {
  return normalizeId(raw, 9);
}

/** Season number: 0 (specials) to 9999 (some daily shows number seasons by year). */
export function normalizeSeasonNumber(raw: string): string | null {
  return normalizeId(raw, 4, true);
}

/** Genre list for discover: 1 to 5 ids, sorted and deduplicated so one set gives one cache key. */
export function normalizeGenres(raw: string): string | null {
  if (!raw || raw.length > MAX_GENRES_LENGTH) return null;
  const ids: string[] = [];
  for (const part of raw.split(",")) {
    const id = normalizeTmdbId(part);
    if (!id) return null;
    if (!ids.includes(id)) ids.push(id);
  }
  if (ids.length > MAX_GENRES) return null;
  return ids.sort((a, b) => Number(a) - Number(b)).join(",");
}

/**
 * May this answer be written to the cache? Refreshing a row that already exists never adds one;
 * a new key is only written while the cache is under its cap (an unknown count counts as full).
 */
export function mayWriteCache(rowExists: boolean, rowCount: number | null, entryChars: number): boolean {
  if (entryChars > TMDB_CACHE_MAX_ENTRY_CHARS) return false;
  if (rowExists) return true;
  return rowCount !== null && rowCount < TMDB_CACHE_MAX_ROWS;
}

// ---------------------------------------------------------------------------
// Title searches (the app searches a title when the provider gives no TMDB number)
// ---------------------------------------------------------------------------

/** Searches get their own row budget: junk queries can never take the places of titles and lists. */
export const TMDB_SEARCH_CACHE_MAX_ROWS = 1500; // 3000 + 1500 stays under the database's hard limit of 5000 rows
/** A search answer is at most 20 results (~15 KB); anything bigger is served without being cached. */
export const TMDB_SEARCH_CACHE_MAX_ENTRY_CHARS = 60_000;
/** Shorter than a real title or longer than any cleaned title the app sends: never cached. */
const SEARCH_QUERY_MIN = 2;
const SEARCH_QUERY_MAX = 80;

/**
 * Search text as the cache key sees it: Unicode-normalised, lower case, control characters dropped, runs of
 * spaces collapsed. Null when the text could not be a cleaned title (the answer is then not cached).
 * The same text is sent to TMDB, so the cached answer is exactly the one TMDB gave for this key.
 */
export function normalizeSearchQuery(raw: string): string | null {
  const text = raw.normalize("NFKC").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
  if (text.length < SEARCH_QUERY_MIN || text.length > SEARCH_QUERY_MAX) return null;
  return text;
}

/** One cache row per kind, language, year and normalised text. */
export function searchCacheKey(kind: "movie" | "tv", language: string, year: string, query: string): string {
  return `search:${kind}:${language}:${year || "-"}:${query}`;
}

/** Number of results in a TMDB search answer (0 when the answer has none or is not a search answer). */
export function searchResultCount(answer: unknown): number {
  const results = (answer as { results?: unknown } | null)?.results;
  return Array.isArray(results) ? results.length : 0;
}

/**
 * May this search answer be written? Never an answer without result (it helps nobody: the app already
 * remembers "not found" for 30 days, and a made-up title usually finds nothing). TMDB's fuzzy search can
 * still answer a made-up title with something, so the budget below is what really bounds the rows: only while the search
 * budget has room (unknown count = full).
 */
export function mayWriteSearchCache(rowExists: boolean, searchRowCount: number | null, entryChars: number, resultCount: number): boolean {
  if (resultCount < 1) return false;
  if (entryChars > TMDB_SEARCH_CACHE_MAX_ENTRY_CHARS) return false;
  if (rowExists) return true;
  return searchRowCount !== null && searchRowCount < TMDB_SEARCH_CACHE_MAX_ROWS;
}
