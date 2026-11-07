import { useState, useEffect, useDeferredValue, useMemo } from 'react';
import type { LightMovie, LightSeries, LightLive, LightIndexes } from '../types/lightIndex';
import { searchContent, normalizeName, matchesSearch } from '../services/searchIndex';
import { groupByTmdbId, type GroupedItem } from '../utils/movieGrouping';
import { providerTmdbCount, sameTitleVersionKey } from '../services/titleTmdbLinkStore';
import { isHidden } from '../services/hiddenCategoriesService';
import { useHiddenCategoriesVersion } from './useHiddenCategoriesVersion';
import { hasValidTmdbId } from '../utils/normalizeTmdb';
import { devLog } from '../utils/devLog';
import { warnOnReject } from '../utils/warnOnReject';

/** Résultats bruts demandés à FTS5 par type (avant groupage). */
const RAW_LIMIT = 500;

/**
 * Les versions d'un même titre sans numéro TMDB (« FR | Dune (2021) », « Dune (2021) 4K ») ne font qu'une carte,
 * comme celles qui ont un numéro : seulement quand le nom donne la même année des deux côtés.
 * Les groupes avec numéro et ceux sans année restent tels quels.
 */
function mergeUnnumberedVersions<T extends LightMovie | LightSeries>(groups: GroupedItem<T>[]): GroupedItem<T>[] {
  const byKey = new Map<string, GroupedItem<T>>();
  const merged: GroupedItem<T>[] = [];
  for (const group of groups) {
    const key = hasValidTmdbId(group.representative.tmdbId) ? null : sameTitleVersionKey(group.representative.name);
    const first = key ? byKey.get(key) : undefined;
    if (!first) {
      const own = { ...group, items: [...group.items] };
      if (key) byKey.set(key, own);
      merged.push(own);
      continue;
    }
    first.items.push(...group.items);
    first.sourceCount = first.items.length;
  }
  return merged;
}

/**
 * Groupes d'un type, limités à `limit`. Aucun titre n'est écarté parce qu'il n'a pas de numéro TMDB : sans
 * fiche, il n'était trouvable nulle part chez un fournisseur qui en donne pour ses autres titres.
 * - Catalogue avec des numéros TMDB : les titres avec fiche d'abord (rang de la recherche), puis ceux sans
 *   fiche, qui gardent au moins un tiers des places (des séparateurs aux noms très courts, comme
 *   « ### FR ### », passeraient sinon devant les vrais titres).
 * - Un titre sans fiche d'une catégorie masquée par l'utilisateur (adultes, par exemple) reste écarté.
 */
function searchGroups<T extends LightMovie | LightSeries>(
  items: T[],
  catalogHasTmdb: boolean,
  type: 'movie' | 'series',
  limit: number,
): GroupedItem<T>[] {
  // Catégories masquées écartées AVANT la fusion : une version masquée ne cache ni ne rejoint une carte visible
  const visible = groupByTmdbId(items, true).filter((group) =>
    hasValidTmdbId(group.representative.tmdbId) || !isHidden(group.representative.categoryId, type));
  const groups = mergeUnnumberedVersions(visible);
  if (!catalogHasTmdb) return groups.slice(0, limit);
  const linked = groups.filter((group) => hasValidTmdbId(group.representative.tmdbId));
  const orphans = groups.filter((group) => !hasValidTmdbId(group.representative.tmdbId));
  const orphanSlots = Math.min(orphans.length, Math.max(limit - linked.length, Math.ceil(limit / 3)));
  return linked.slice(0, limit - orphanSlots).concat(orphans.slice(0, orphanSlots));
}

interface GroupedSearchResults {
  movies: GroupedItem<LightMovie>[];
  series: GroupedItem<LightSeries>[];
  live: LightLive[]; // Live channels are not grouped
  total: number;
  rawTotal: number; // Total before grouping
  /** Un type au moins a atteint RAW_LIMIT : la recherche a pu en laisser de côté */
  rawTruncated: boolean;
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
  const hiddenVersion = useHiddenCategoriesVersion();
  const [searchResults, setSearchResults] = useState<GroupedSearchResults>({
    movies: [],
    series: [],
    live: [],
    total: 0,
    rawTotal: 0,
    rawTruncated: false,
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
      setSearchResults({ movies: [], series: [], live: [], total: 0, rawTotal: 0, rawTruncated: false });
      setResultsQuery('');
      return;
    }

    let cancelled = false;

    const doSearch = async () => {
      const t0 = performance.now();
      
      // Step 1: FTS5 Search (async, ~5-20ms)
      // Up to RAW_LIMIT results per type, grouped below
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

      // Step 3: Group by TMDB ID, max `limit` groups per type (for UI performance). Les numéros trouvés par
      // le titre ne comptent pas pour dire si le fournisseur donne des numéros TMDB (comme l'accueil).
      const tGroup0 = performance.now();
      const limitedMovies = searchGroups(movies, providerTmdbCount(lightIndexes.moviesByTmdb) > 0, 'movie', limit);
      const limitedSeries = searchGroups(series, providerTmdbCount(lightIndexes.seriesByTmdb) > 0, 'series', limit);
      devLog('perf', `groupByTmdbId: ${(performance.now() - tGroup0).toFixed(1)}ms`);
      const limitedLive = live.slice(0, limit);

      devLog('perf', `FTS5Search.total: ${(performance.now() - t0).toFixed(1)}ms`);

      if (!cancelled) {
        setSearchResults({
          movies: limitedMovies,
          series: limitedSeries,
          live: limitedLive,
          total: limitedMovies.length + limitedSeries.length + limitedLive.length,
          rawTotal: ftsResults.length,
          rawTruncated: (['movie', 'series', 'live'] as const).some((type) => ftsResults.filter((r) => r.type === type).length >= RAW_LIMIT),
        });
        setResultsQuery(deferredQuery);
      }
    };

    doSearch().catch(warnOnReject('GlobalSearch'));

    return () => {
      cancelled = true;
    };
    // hiddenVersion n'est pas lu : il change quand une catégorie est masquée ou rendue (isHidden) et relance la recherche
  }, [lightIndexes, deferredQuery, limit, hiddenVersion]);

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
    const truncated = searchResults.rawTruncated
      || searchResults.movies.length >= limit
      || searchResults.series.length >= limit
      || searchResults.live.length >= limit;
    if (total === 0 && truncated) return null;
    return { movies, series, live, total, rawTotal: searchResults.rawTotal, rawTruncated: searchResults.rawTruncated };
  }, [typed, resultsQuery, searchResults, limit]);

  return {
    results: narrowed ?? searchResults,
    debouncedQuery: narrowed ? typed : deferredQuery,
    isSearching,
  };
};
