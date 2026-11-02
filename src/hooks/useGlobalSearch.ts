import { useState, useEffect, useDeferredValue, useMemo } from 'react';
import type { LightMovie, LightSeries, LightLive, LightIndexes } from '../types/lightIndex';
import { searchContent, normalizeName, matchesSearch } from '../services/searchIndex';
import { groupByTmdbId, type GroupedItem } from '../utils/movieGrouping';
import { devLog } from '../utils/devLog';
import { warnOnReject } from '../utils/warnOnReject';

/** Résultats bruts demandés à FTS5 par recherche (avant groupage). */
const RAW_LIMIT = 500;

interface GroupedSearchResults {
  movies: GroupedItem<LightMovie>[];
  series: GroupedItem<LightSeries>[];
  live: LightLive[]; // Live channels are not grouped
  total: number;
  rawTotal: number; // Total before grouping
}

/**
 * Hook de recherche globale avec SQLite FTS5.
 * 
 * PHASE A1 v2: Remplace FlexSearch par SQLite FTS5
 * - 0 MB RAM overhead (index sur disque)
 * - Recherche ~5-20ms
 * - Prefix search avec wildcard
 * 
 * Retourne les résultats PRÉ-GROUPÉS par TMDB ID pour éviter
 * de recalculer le groupage dans le render.
 * 
 * @param lightIndexes - Les LightIndexes pour lookup des items complets
 * @param query - La requête de recherche
 * Réactivité : la vraie recherche part 300 ms après la
 * dernière lettre ; entre-temps, quand l'utilisateur ajoute des lettres, les résultats déjà affichés
 * sont filtrés aussitôt selon la même règle que FTS5 (`matchesSearch`) : de vrais résultats, tout
 * de suite, puis complétés par la recherche.
 *
 * @param lightIndexes - Les LightIndexes pour lookup des items complets
 * @param query - La requête de recherche
 * @param debounceMs - Délai de debounce (default 300ms)
 * @param limit - Nombre max de résultats par catégorie (default 30)
 */
export const useGlobalSearch = (
  lightIndexes: LightIndexes | null,
  query: string,
  debounceMs = 300,
  limit = 30
) => {
  const [debouncedQuery, setDebouncedQuery] = useState(query);
  const [searchResults, setSearchResults] = useState<GroupedSearchResults>({
    movies: [],
    series: [],
    live: [],
    total: 0,
    rawTotal: 0,
  });
  // Requête dont `searchResults` est le résultat (pour le filtrage immédiat)
  const [resultsQuery, setResultsQuery] = useState('');

  // React 18: useDeferredValue creates an interruptible deferred version
  const deferredQuery = useDeferredValue(debouncedQuery);

  // Derived state: searching if queries don't match
  const isSearching = query.trim() !== deferredQuery;

  // Debounce the query
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(query.trim());
    }, debounceMs);
    return () => clearTimeout(timer);
  }, [query, debounceMs]);

  // Perform async FTS5 search
  useEffect(() => {
    if (!lightIndexes || !deferredQuery || deferredQuery.length < 2) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- requête trop courte : résultats de la recherche SQLite précédente effacés
      setSearchResults({ movies: [], series: [], live: [], total: 0, rawTotal: 0 });
      setResultsQuery('');
      return;
    }

    let cancelled = false;

    const doSearch = async () => {
      const t0 = performance.now();
      
      // Step 1: FTS5 Search (async, ~5-20ms)
      // Get many results because they're mixed across types and will be grouped
      const tSearch0 = performance.now();
      const ftsResults = await searchContent(deferredQuery, RAW_LIMIT);
      devLog('perf', `FTS5.search: ${(performance.now() - tSearch0).toFixed(1)}ms`);

      if (cancelled) return;

      // Step 2: Lookup full items from lightIndexes
      // Don't limit here - let grouping reduce the count naturally
      const tLookup0 = performance.now();
      const movies: LightMovie[] = [];
      const series: LightSeries[] = [];
      const live: LightLive[] = [];

      for (const result of ftsResults) {
        if (result.type === 'movie') {
          const item = lightIndexes.movies.get(result.id);
          if (item) movies.push(item);
        } else if (result.type === 'series') {
          const item = lightIndexes.series.get(result.id);
          if (item) series.push(item);
        } else if (result.type === 'live') {
          const item = lightIndexes.live.get(result.id);
          if (item) live.push(item);
        }
      }
      devLog('perf', `FTS5.lookup: ${(performance.now() - tLookup0).toFixed(1)}ms`);

      // Step 3: Group by TMDB ID
      const tGroup0 = performance.now();
      // Titres sans numéro TMDB gardés seulement si aucun titre de ce type n'en a (même règle que l'accueil).
      const groupedMovies = groupByTmdbId(movies, lightIndexes.moviesByTmdb.size === 0);
      const groupedSeries = groupByTmdbId(series, lightIndexes.seriesByTmdb.size === 0);
      devLog('perf', `groupByTmdbId: ${(performance.now() - tGroup0).toFixed(1)}ms`);

      // Step 4: Limit to max `limit` groups per type (for UI performance)
      const limitedMovies = groupedMovies.slice(0, limit);
      const limitedSeries = groupedSeries.slice(0, limit);
      const limitedLive = live.slice(0, limit);

      devLog('perf', `FTS5Search.total: ${(performance.now() - t0).toFixed(1)}ms`);

      if (!cancelled) {
        setSearchResults({
          movies: limitedMovies,
          series: limitedSeries,
          live: limitedLive,
          total: limitedMovies.length + limitedSeries.length + limitedLive.length,
          rawTotal: ftsResults.length,
        });
        setResultsQuery(deferredQuery);
      }
    };

    doSearch().catch(warnOnReject('GlobalSearch'));

    return () => {
      cancelled = true;
    };
  }, [lightIndexes, deferredQuery, limit]);

  // Filtrage immédiat : la requête tapée prolonge celle des résultats affichés (« the » → « the m ») ;
  // ses résultats en sont forcément une partie. Si les résultats affichés étaient tronqués (limites)
  // et que le filtrage ne garde rien, on garde l'affichage tel quel en attendant la vraie recherche.
  const typed = query.trim();
  const narrowed = useMemo<GroupedSearchResults | null>(() => {
    if (resultsQuery.length < 2 || typed === resultsQuery) return null;
    if (!normalizeName(typed).startsWith(normalizeName(resultsQuery))) return null;
    const keepGroup = <T extends { name: string }>(group: GroupedItem<T>) =>
      group.items.some((item) => matchesSearch(item.name, typed));
    const movies = searchResults.movies.filter(keepGroup);
    const series = searchResults.series.filter(keepGroup);
    const live = searchResults.live.filter((item) => matchesSearch(item.name, typed));
    const total = movies.length + series.length + live.length;
    const truncated = searchResults.rawTotal >= RAW_LIMIT
      || searchResults.movies.length >= limit
      || searchResults.series.length >= limit
      || searchResults.live.length >= limit;
    if (total === 0 && truncated) return null;
    return { movies, series, live, total, rawTotal: searchResults.rawTotal };
  }, [typed, resultsQuery, searchResults, limit]);

  return {
    results: narrowed ?? searchResults,
    debouncedQuery: narrowed ? typed : deferredQuery,
    isSearching,
  };
};
