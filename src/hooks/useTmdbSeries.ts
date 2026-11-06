import { useState, useEffect, useRef, useCallback } from 'react';
import tmdb from '../services/tmdbApi';
// Details cache (SQLite)
import { 
  getCachedDetails, 
  cacheSeriesDetails
} from '../services/tmdbCacheSqlite';
import type { AppSeriesInfo } from '../types/xtream';
import type { IptvSeries } from '../types/iptv';
import { normalizeTmdbId } from '../utils/normalizeTmdb';
import { useTmdbIdFromTitle } from './useTmdbIdFromTitle';
import { getTmdbLanguage } from '../utils/tmdbLanguage';
import type { TmdbTvDetails, TmdbEpisode } from '../types/tmdb';
import { TMDB_LANGUAGE_EVENT } from '../services/eventConstants';
import { createLogger } from '../utils/logger';

const log = createLogger('useTmdbSeries');

// Minimum time to display skeleton (avoids flash when cache responds instantly)
const MIN_LOADING_DISPLAY_MS = 600;

interface UseTmdbSeriesResult {
  tmdbId: number | null;
  details: TmdbTvDetails | null;
  currentSeasonEpisodes: TmdbEpisode[];
  loadingState: 'loading' | 'ready' | 'fallback';  // Changed from isLoading boolean
  isSeasonLoading: boolean;
  error: string | null;
}

interface SeasonState {
  episodes: TmdbEpisode[];
  isLoading: boolean;
}

/**
 * Hook for fetching TMDB series data.
 * ALIGNED with useTmdbMovie pattern:
 * - Synchronous initialization from props/cache
 * - loadingState enum instead of isLoading boolean
 * - Minimal re-renders
 */
export const useTmdbSeries = (
  series: AppSeriesInfo | IptvSeries,
  selectedSeason: number
): UseTmdbSeriesResult => {
  
  // Track when loading started for minimum display time
  // Heure du montage lue une seule fois (initialisation paresseuse) : pas d'appel à Date.now() à chaque rendu
  const [mountedAt] = useState(Date.now);
  const loadingStartRef = useRef<number>(mountedAt);
  // Ref to clear the transition timer on unmount (prevents memory leak)
  const transitionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // =========================================================================
  // SYNCHRONOUS INITIALIZATION (like useTmdbMovie)
  // =========================================================================
  
  // Helper to extract TMDB ID from various sources
  const getInitialTmdbId = (): number | null => {
    if (!series) return null;
    // From AppSeriesInfo.xtreamInfo
    if ('xtreamInfo' in series && series.xtreamInfo?.tmdb_id) {
      return normalizeTmdbId(series.xtreamInfo.tmdb_id);
    }
    // From IptvSeries.tmdb_id
    if ('tmdb_id' in series && series.tmdb_id) {
      return normalizeTmdbId(series.tmdb_id);
    }
    // From IptvSeries.tmdb
    if ('tmdb' in series && series.tmdb) {
      return normalizeTmdbId(series.tmdb);
    }
    return null;
  };

  // Providers that send no TMDB id: found by title search
  const seriesTitle = !getInitialTmdbId() ? ((series as { name?: string } | null)?.name ?? null) : null;
  const titleSearch = useTmdbIdFromTitle(seriesTitle, 'tv');

  // 1. Init tmdbId synchronously from props
  const [tmdbId, setTmdbId] = useState<number | null>(() => getInitialTmdbId());

  // 2. Init details to null - SQLite cache is async, will be loaded in effect
  const [details, setDetails] = useState<TmdbTvDetails | null>(null);

  // Augmenté à chaque changement de langue : relance le chargement de la fiche (sans lui, la fiche
  // restait sur le squelette après un changement de langue)
  const [langVersion, setLangVersion] = useState(0);

  // 3. Init loadingState - fallback immediately if no TMDB ID (like useTmdbMovie)
  const [loadingState, setLoadingState] = useState<'loading' | 'ready' | 'fallback'>(() => {
    const id = getInitialTmdbId();
    if ((!id || id === 0) && !seriesTitle) return 'fallback';
    return 'loading';
  });

  // Helper to transition to ready/fallback with minimum display time
  const transitionToState = useCallback((newState: 'ready' | 'fallback') => {
    const elapsed = Date.now() - loadingStartRef.current;
    const remaining = MIN_LOADING_DISPLAY_MS - elapsed;

    if (remaining > 0) {
      // Clear any pending transition timer
      if (transitionTimerRef.current) clearTimeout(transitionTimerRef.current);
      // Wait for remaining time before transitioning
      transitionTimerRef.current = setTimeout(() => {
        transitionTimerRef.current = null;
        setLoadingState(newState);
      }, remaining);
    } else {
      // Already past minimum, transition immediately
      setLoadingState(newState);
    }
  }, []);

  // Combined season state to reduce re-renders (batch updates)
  const [seasonState, setSeasonState] = useState<SeasonState>({
    episodes: [],
    isLoading: false,
  });
  const [error, setError] = useState<string | null>(null);

  // =========================================================================
  // EFFECT 1: Resolve TMDB ID and fetch Series Details
  // PHASE C3: Title matching REMOVED - only uses TMDB ID from provider
  // If tmdb_id = 0 → fallback direct to Xtream data (lightIndex)
  // =========================================================================
  useEffect(() => {
    // Skip if already have details from cache
    if (details) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- fiche déjà en cache : état « prêt » sans chargement
      setLoadingState('ready');
      return;
    }

    // Get ID from props (NO title matching - only provider ID)
    const id = getInitialTmdbId() || titleSearch.id;
    
    // No TMDB ID from the provider nor from the title search → fallback
    if (!id || id === 0) {
      // Title search still running: keep the skeleton
      if (!titleSearch.done) return;
      transitionToState('fallback');
      return;
    }

    let mounted = true;

    const fetchDetails = async () => {
      if (!series) return;
      setError(null);
      setTmdbId(id);

      try {
        // Check SQLite cache first
        const cachedDetails = await getCachedDetails<TmdbTvDetails>(id, 'series');
        if (cachedDetails) {
          if (mounted) {
            setDetails(cachedDetails);
            setLoadingState('ready'); // Cache hit = instant, no delay
          }
          return;
        }
        
        // Cache miss - fetch from API
        const langAtFetchStart = getTmdbLanguage();
        
        const tvDetails = await tmdb.getTvDetails(id);
        if (!mounted) return;
        
        if (tvDetails) {
          // Race condition protection: only cache if language hasn't changed
          const currentLang = getTmdbLanguage();
          if (langAtFetchStart !== currentLang) {
            log.warn('Language changed during details fetch, discarding');
            return;
          }
          // Cache in SQLite
          await cacheSeriesDetails(id, tvDetails);
          if (mounted) {
            setDetails(tvDetails);
            transitionToState('ready');
          }
        } else {
          if (mounted) {
            transitionToState('fallback');
          }
        }
      } catch (err) {
        log.error('Error fetching:', err);
        if (mounted) {
          setError('Erreur de chargement TMDB');
          transitionToState('fallback');
        }
      }
    };

    void fetchDetails();

    return () => {
      mounted = false;
      // Clear pending transition timer to avoid setState on unmounted component
      if (transitionTimerRef.current) {
        clearTimeout(transitionTimerRef.current);
        transitionTimerRef.current = null;
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- recharge seulement pour une autre série ou une autre langue, pas à chaque nouvel état
  }, [series?.series_id, langVersion, titleSearch.id, titleSearch.done]); // series_id is a stable unique identifier (name could be duplicated)

  // =========================================================================
  // EFFECT 2: Fetch Season Details when tmdbId or selectedSeason changes
  // Uses batched state updates to minimize re-renders during animation
  // =========================================================================
  useEffect(() => {
    if (!tmdbId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- pas d'identifiant TMDB : saison vide, pas de requête
      setSeasonState({ episodes: [], isLoading: false });
      return;
    }

    let mounted = true;
    
    const fetchSeason = async () => {
      // Cache miss - set loading then fetch
      // Note: getSeasonDetailsWithFallback has its own cache check,
      // so we delegate entirely to it (no double cache check)
      if (mounted) {
        setSeasonState(prev => ({ ...prev, isLoading: true }));
      }

      try {
        // getSeasonDetailsWithFallback handles: cache check → FR fetch → EN fallback
        const seasonData = await tmdb.getSeasonDetailsWithFallback(tmdbId, selectedSeason);
        if (!mounted) return;
        if (Array.isArray(seasonData?.episodes)) {
          const episodesMap: TmdbEpisode[] = [];
          seasonData.episodes.forEach((ep: TmdbEpisode) => {
            episodesMap[ep.episode_number] = ep;
          });
          // Single batched update
          setSeasonState({ episodes: episodesMap, isLoading: false });
        } else {
          // Rien, ou une réponse sans liste d'épisodes : les épisodes du fournisseur prennent le
          // relais (sans ce cas, les cartes restaient en squelettes pour toujours)
          setSeasonState({ episodes: [], isLoading: false });
        }
      } catch {
        // Both FR and EN failed - clear TMDB episodes, fallback to Xtream data
        log.warn(`Season ${selectedSeason} not available on TMDB, using Xtream data`);
        if (mounted) setSeasonState({ episodes: [], isLoading: false });
      }
    };

    void fetchSeason();

    return () => {
      mounted = false;
    };
  }, [tmdbId, selectedSeason, langVersion]);

  // =========================================================================
  // EFFECT 3: React to language change — reset state to trigger refetch
  // =========================================================================
  useEffect(() => {
    const handleLanguageChange = () => {
      // Transition « prête » ou « repli » de l'ancienne langue encore programmée : annulée
      if (transitionTimerRef.current) {
        clearTimeout(transitionTimerRef.current);
        transitionTimerRef.current = null;
      }
      // Reset all TMDB-related state to trigger refetch with new language
      setDetails(null);
      setSeasonState({ episodes: [], isLoading: false });
      setLoadingState('loading');
      loadingStartRef.current = Date.now();
      setLangVersion((v) => v + 1);
    };

    window.addEventListener(TMDB_LANGUAGE_EVENT, handleLanguageChange);
    return () => {
      window.removeEventListener(TMDB_LANGUAGE_EVENT, handleLanguageChange);
    };
  }, []);

  return {
    tmdbId,
    details,
    currentSeasonEpisodes: seasonState.episodes,
    loadingState,
    isSeasonLoading: seasonState.isLoading,
    error,
  };
};
