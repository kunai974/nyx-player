import { useEffect, useState } from 'react';
import tmdb from '../services/tmdbApi';
import { parseTitleForSearch } from '../utils/tmdbTitleSearch';
import { createLogger } from '../utils/logger';

const log = createLogger('useTmdbIdFromTitle');

/** Results of earlier searches (0 = nothing found), so reopening a title costs no request */
const SEARCHED = new Map<string, number>();

/**
 * Finds a TMDB id from a title, for providers that send none (every title then shows
 * "No additional information"). Pass `null` when the provider already gave an id: nothing is searched.
 * `done` is true once the search finished (found or not) or when there is nothing to search.
 */
export function useTmdbIdFromTitle(title: string | null, kind: 'movie' | 'tv'): { id: number; done: boolean } {
  const key = title && title.trim() ? `${kind}:${title.trim()}` : null;
  const [result, setResult] = useState<{ key: string; id: number } | null>(null);

  useEffect(() => {
    if (!key || !title) return;
    const known = SEARCHED.get(key);
    if (known !== undefined) {
      void Promise.resolve().then(() => setResult({ key, id: known }));
      return;
    }
    let cancelled = false;
    const { query, year } = parseTitleForSearch(title);
    const search = query
      ? (kind === 'movie' ? tmdb.searchMovie(query, year) : tmdb.searchTv(query, year))
      : Promise.resolve(null);
    void search
      .then(async (response) => {
        let results = response?.results ?? [];
        // A wrong year (provider typo) must not hide the title: retry without it
        if (results.length === 0 && year && query) {
          const retry = await (kind === 'movie' ? tmdb.searchMovie(query) : tmdb.searchTv(query));
          results = retry?.results ?? [];
        }
        return results[0]?.id ?? 0;
      })
      .catch((e) => {
        log.warn('TMDB title search failed:', e);
        return 0;
      })
      .then((id) => {
        SEARCHED.set(key, id);
        if (!cancelled) setResult({ key, id });
      });
    return () => { cancelled = true; };
  }, [key, title, kind]);

  if (!key) return { id: 0, done: true };
  return result?.key === key ? { id: result.id, done: true } : { id: 0, done: false };
}
