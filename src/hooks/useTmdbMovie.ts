import { useState, useEffect, useRef, useCallback } from 'react';
import tmdb from '../services/tmdbApi';
// Details cache (SQLite)
import { 
  getCachedDetails, 
  cacheMovieDetails 
} from '../services/tmdbCacheSqlite';
import type { XtreamMovie } from '../types/xtream';
import type { IptvStream } from '../types/iptv';
import { normalizeTmdbId } from '../utils/normalizeTmdb';
import { useTmdbIdFromTitle } from './useTmdbIdFromTitle';
import { getTmdbLanguage } from '../utils/tmdbLanguage';
import type { TmdbMovieDetails } from '../types/tmdb';
import { TMDB_LANGUAGE_EVENT } from '../services/eventConstants';
import { createLogger } from '../utils/logger';

const log = createLogger('useTmdbMovie');

// Minimum time to display skeleton (avoids flash when cache responds instantly)
const MIN_LOADING_DISPLAY_MS = 600;

/**
 * Hook for fetching TMDB movie details
 * 
 * PHASE C3: Title matching REMOVED - only uses TMDB ID provided by provider
 * If tmdb_id = 0 → fallback direct to Xtream data (lightIndex)
 * 
 * @param baseItem - IptvStream or XtreamMovie with stream data
 * @param initialTmdbId - Optional TMDB ID if already known
 */
export const useTmdbMovie = (baseItem: IptvStream | XtreamMovie | null, initialTmdbId?: number) => {
  // Track when loading started for minimum display time
  // Heure du montage lue une seule fois (initialisation paresseuse) : pas d'appel à Date.now() à chaque rendu
  const [mountedAt] = useState(Date.now);
  const loadingStartRef = useRef<number>(mountedAt);
  // Ref to clear the transition timer on unmount (prevents memory leak)
  const transitionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Provider id first (prop or baseItem); providers that send none: found by title search
  const providerTmdbId = (() => {
    if (initialTmdbId && initialTmdbId > 0) return initialTmdbId;
    if (!baseItem) return 0;
    return normalizeTmdbId((baseItem as XtreamMovie).tmdb);
  })();
  const titleName = providerTmdbId === 0 ? ((baseItem as { name?: string } | null)?.name ?? null) : null;
  const titleSearch = useTmdbIdFromTitle(titleName, 'movie');
  const resolvedTmdbId = providerTmdbId || titleSearch.id;
  const searchPending = providerTmdbId === 0 && !titleSearch.done;

  // Initialize details to null - SQLite cache is async, will be loaded in effect
  const [details, setDetails] = useState<TmdbMovieDetails | null>(null);

  // Loading state: if no tmdb_id → fallback immediately, else loading
  const [loadingState, setLoadingState] = useState<'loading' | 'ready' | 'fallback'>(() => {
    if (providerTmdbId === 0 && !titleName) return 'fallback';
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

  // Track if we're currently fetching (prevents double calls from StrictMode)
  const fetchingRef = useRef<number | null>(null);

  // Augmenté à chaque changement de langue : relance le chargement même si `details` était déjà
  // nul (langue changée pendant un chargement : sans lui, le squelette restait affiché).
  const [langVersion, setLangVersion] = useState(0);

  // Effect: Fetch TMDB Details (check SQLite cache first, then API)
  useEffect(() => {
    // No TMDB ID → stay in fallback, no fetch needed
    if (!resolvedTmdbId || resolvedTmdbId === 0) {
      // Title search still running: keep the skeleton
      if (searchPending) return;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- pas d'identifiant TMDB : passage direct au repli (machine d'état du chargement)
      setLoadingState('fallback');
      return;
    }
    
    // Already have details → skip
    if (details) return;
    
    // Already fetching this ID → skip (prevents StrictMode double calls)
    if (fetchingRef.current === resolvedTmdbId) return;
    fetchingRef.current = resolvedTmdbId;

    let mounted = true;

    const fetchDetails = async () => {
      // 1. Cache SQLite d'abord ; illisible (base occupée, changement de compte) : on passe par l'API
      // au lieu de laisser la fiche en squelette
      let cached: TmdbMovieDetails | null = null;
      try {
        cached = await getCachedDetails<TmdbMovieDetails>(resolvedTmdbId, 'movie');
      } catch (e) {
        log.warn('Cache TMDB illisible, passage par l’API :', e);
      }
      if (!mounted) return;

      if (cached && (cached.images?.backdrops?.length || 0) > 0) {
        if (mounted) {
          setDetails(cached);
          setLoadingState('ready'); // Cache hit = instant, no delay
          fetchingRef.current = null;
        }
        return;
      }

      // 2. Cache miss - fetch from API
      const langAtFetchStart = getTmdbLanguage();

      try {
        const data = await tmdb.getMovieDetails(resolvedTmdbId);
        if (!mounted) return;
        
        // Langue changée pendant l'appel : réponse jetée, le changement de langue relance
        // le chargement (langVersion)
        const currentLang = getTmdbLanguage();
        if (langAtFetchStart !== currentLang) {
          log.warn('Language changed during fetch, discarding result');
          fetchingRef.current = null;
          return;
        }
        
        // Cache in SQLite
        await cacheMovieDetails(resolvedTmdbId, data);
        setDetails(data);
        transitionToState('ready');
        fetchingRef.current = null;
      } catch (err) {
        if (!mounted) return;
        log.error('API Error:', err);
        fetchingRef.current = null;
        // Hors ligne : la fiche déjà en cache sans photo de fond vaut mieux que la fiche du
        // fournisseur (titre et résumé TMDB gardés)
        if (cached) {
          setDetails(cached);
          transitionToState('ready');
          return;
        }
        transitionToState('fallback');
      }
    };

    void fetchDetails();

    return () => {
      mounted = false;
      // Reset fetching flag au démontage pour permettre refetch au retour
      fetchingRef.current = null;
    };
  }, [resolvedTmdbId, searchPending, details, transitionToState, langVersion]);

  // Clear pending transition timer on unmount / TMDB ID change only.
  // Must NOT live in the fetch effect above: its cleanup runs when `details` is set,
  // which cancelled the 'ready' transition when the API answered in < MIN_LOADING_DISPLAY_MS
  // (page stuck on skeleton).
  useEffect(() => {
    return () => {
      if (transitionTimerRef.current) {
        clearTimeout(transitionTimerRef.current);
        transitionTimerRef.current = null;
      }
    };
  }, [resolvedTmdbId]);

  // Effect: React to language change — reset state to trigger refetch
  useEffect(() => {
    const handleLanguageChange = () => {
      // Transition « prête » ou « repli » de l'ancienne langue encore programmée : annulée
      if (transitionTimerRef.current) {
        clearTimeout(transitionTimerRef.current);
        transitionTimerRef.current = null;
      }
      // Reset details to null to trigger refetch with new language
      setDetails(null);
      setLoadingState('loading');
      loadingStartRef.current = Date.now();
      setLangVersion((v) => v + 1);
    };

    window.addEventListener(TMDB_LANGUAGE_EVENT, handleLanguageChange);
    return () => {
      window.removeEventListener(TMDB_LANGUAGE_EVENT, handleLanguageChange);
    };
  }, []);

  return { details, resolvedTmdbId, loadingState };
};
