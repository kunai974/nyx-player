import { useEffect, useState, useMemo, useRef } from 'react';
import type { HeroMovie } from '../types/dashboard';
import {
  buildHeroFromTrendingItems,
  getTmdbTrendingAndMatch,
  getTmdbNowPlayingAndMatch,
  getTmdbOnTheAirAndMatch,
  getTmdbTopRatedAndMatch,
  getTmdbPopularAndMatch,
  getTmdbByGenreAndMatch,
  readTmdbList,
} from '../services/tmdbMatchingService';
import type { TrendingItem } from '../services/tmdbMatchingService';
import {
  getCarouselPreferences,
  getEnabledGenres,
  isExoticFilterEnabled,
} from '../services/preferencesService';
import type { CarouselPreferences } from '../services/preferencesService';
import type { LightIndexes, LightMovie, LightSeries } from '../types/lightIndex';
import { getThisWeekMovies, getThisWeekSeries } from '../utils/lightIndexHelpers';
import { PREFERENCES_EVENT, TMDB_LANGUAGE_EVENT } from '../services/eventConstants';
import { devLog } from '../utils/devLog';
import { perfMark } from '../utils/perfMarks';
import { getTmdbLanguage } from '../utils/tmdbLanguage';
import {
  dashboardCache,
  markDashboardLoaded,
  subscribeDashboardCache,
  getDashboardCacheGeneration,
  installDashboardRematch,
  resetDashboardCache,
  baseKeyFor,
  genreKeyFor,
  sameBaseCatalog,
  catalogTableId,
  DASHBOARD_ROW_LIMIT,
  DASHBOARD_HERO_COUNT,
} from '../services/dashboardCache';
import { isTmdbAvailable } from '../services/tmdbApi';
import { computeBaseRematch, computeGenreRematch } from '../services/dashboardRematch';
import { linkHomeTitlesAndRefresh, linkRecentByTitle, mostlyWithoutTmdb, titleLinksSettled } from '../services/titleTmdbLinks';
import { createLogger } from '../utils/logger';

const log = createLogger('Dashboard');

/**
 * Délai avant de comparer les listes TMDB de l'accueil aux noms du catalogue (fournisseurs sans
 * numéro TMDB) : l'accueil est affiché et ses rangées par genre chargées avant ce travail.
 */
/** Catalogues dont les essais sont finis : revenir sur l'accueil ne remet pas de cartes grises */
const exhaustedCatalogs = new WeakSet<object>();

export const TITLE_LINKS_TIMING = { firstMs: 4000, retryMs: [8000, 18000] as number[] };
/**
 * Nouveaux essais si les listes TMDB de l'accueil ne sont pas encore en cache (catalogue neuf, changement de
 * source : elles arrivent après l'affichage). Un essai déjà fait pour les mêmes listes ne refait aucun travail.
 */

// Cache du module (affichage immédiat au retour) et recalcul après une actualisation du catalogue :
// services/dashboardCache.ts. Réexportés ici pour les appelants historiques.
export { isDashboardReloading, resetDashboardCache } from '../services/dashboardCache';

interface UseDashboardDataReturn {
  trendingContent: TrendingItem[];
  nowPlayingContent: TrendingItem[];
  onTheAirContent: TrendingItem[];
  topRatedContent: TrendingItem[];
  popularContent: TrendingItem[];
  genreCarousels: Map<number, TrendingItem[]>;
  heroMovies: HeroMovie[];
  loadingHero: boolean;
  carouselPrefs: CarouselPreferences;
  thisWeekMovies: LightMovie[];
  thisWeekSeries: LightSeries[];
  /** Fournisseur sans numéro TMDB : les rangées arrivent avec les liens par le titre (cartes grises en attendant) */
  linkingTitles: boolean;
}

/** Au moins une liste de l'accueil a été lue (elle est en cache) : TMDB répondait */
async function anyDashboardListRead(): Promise<boolean> {
  const keys = ['trending', 'now_playing', 'on_the_air', 'top_rated', 'popular'] as const;
  const lists = await Promise.all(keys.map((key) => readTmdbList(key, false).catch(() => null)));
  return lists.some((list) => list !== null);
}

/**
 * Centralise tout le data-fetching TMDB du Dashboard :
 * trending, nowPlaying, onTheAir, topRated, popular, genres,
 * hero banner, préférences carrousel, nouveautés de la semaine.
 *
 * Extrait de DashboardPage (Phase 3A.1).
 */
export function useDashboardData(lightIndexes: LightIndexes | undefined): UseDashboardDataReturn {
  const [heroMovies, setHeroMovies] = useState<HeroMovie[]>(dashboardCache.heroMovies);
  // loadingHero tracks whether TMDB data is ready for display.
  // DashboardPage should render nothing (not skeletons) when this is true.
  const [loadingHero, setLoadingHero] = useState(!dashboardCache.hasData);

  // TMDB-sourced content (async) — initialized from module cache for instant return
  const [trendingContent, setTrendingContent] = useState<TrendingItem[]>(dashboardCache.trending);
  const [nowPlayingContent, setNowPlayingContent] = useState<TrendingItem[]>(dashboardCache.nowPlaying);
  const [onTheAirContent, setOnTheAirContent] = useState<TrendingItem[]>(dashboardCache.onTheAir);
  const [topRatedContent, setTopRatedContent] = useState<TrendingItem[]>(dashboardCache.topRated);
  const [popularContent, setPopularContent] = useState<TrendingItem[]>(dashboardCache.popular);

  // Dynamic genre carousels (from preferences) — initialized from cache
  const [genreCarousels, setGenreCarousels] = useState<Map<number, TrendingItem[]>>(dashboardCache.genreCarousels);

  // Carousel preferences (sync with localStorage)
  const [carouselPrefs, setCarouselPrefs] = useState<CarouselPreferences>(getCarouselPreferences);

  // Force reload of TMDB content when language changes
  const [langVersion, setLangVersion] = useState(0);
  // Nouvel essai quand le réseau revient, si l'accueil n'a rien pu charger (hors ligne)
  const [retryVersion, setRetryVersion] = useState(0);

  // Sync preferences on change (SQLite preferencesUpdated + legacy events)
  useEffect(() => {
    const handleStorage = () => setCarouselPrefs(getCarouselPreferences());
    window.addEventListener(PREFERENCES_EVENT, handleStorage);
    return () => {
      window.removeEventListener(PREFERENCES_EVENT, handleStorage);
    };
  }, []);

  // React to language change — force refetch of TMDB carousels
  useEffect(() => {
    const handleLanguageChange = () => {
      // Rangées de l'ancienne langue oubliées ici même, sans compter sur l'émetteur de l'événement
      // (GeneralSection le fait aussi) : sinon l'effet ci-dessous croirait l'accueil à jour.
      resetDashboardCache();
      // Clear React state so skeletons appear during re-fetch
      setHeroMovies([]);
      setTrendingContent([]);
      setNowPlayingContent([]);
      setOnTheAirContent([]);
      setTopRatedContent([]);
      setPopularContent([]);
      setGenreCarousels(new Map());
      setLoadingHero(true);
      setLangVersion(v => v + 1);
    };

    window.addEventListener(TMDB_LANGUAGE_EVENT, handleLanguageChange);
    return () => {
      window.removeEventListener(TMDB_LANGUAGE_EVENT, handleLanguageChange);
    };
  }, []);

  // Accueil chargé hors ligne (rangées toutes vides, non gardées) : nouvel essai au retour du réseau,
  // sans attendre « Actualiser »
  useEffect(() => {
    const handleOnline = () => {
      if (!dashboardCache.hasData || !dashboardCache.baseFor) setRetryVersion(v => v + 1);
    };
    window.addEventListener('online', handleOnline);
    return () => {
      window.removeEventListener('online', handleOnline);
    };
  }, []);

  // Stable reference for enabled genres (to avoid infinite re-renders)
  const enabledGenresKey = JSON.stringify(carouselPrefs.enabledGenres);

  // Use lightIndexes for thisWeek content (RAM optimized)
  // carouselPrefs in deps ensures recalc when exotic filter toggles
  const exoticEnabled = isExoticFilterEnabled();
  // Nouveautés reliées par le titre après coup : les rangées « cette semaine » se recalculent
  const [recentVersion, setRecentVersion] = useState(0);
  const thisWeekMovies = useMemo(() => {
    if (!lightIndexes) return [];
    return getThisWeekMovies(lightIndexes, 20, exoticEnabled);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- recentVersion relance le calcul quand des nouveautés sont reliées (le catalogue est modifié sur place)
  }, [lightIndexes, exoticEnabled, recentVersion]);

  const thisWeekSeries = useMemo(() => {
    if (!lightIndexes) return [];
    return getThisWeekSeries(lightIndexes, 20, exoticEnabled);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- recentVersion relance le calcul quand des nouveautés sont reliées (le catalogue est modifié sur place)
  }, [lightIndexes, exoticEnabled, recentVersion]);

  // Rangées installées depuis l'extérieur (actualisation du catalogue) : on les affiche telles
  // quelles, sans passer par l'état « chargement ».
  useEffect(() => subscribeDashboardCache(() => {
    setHeroMovies(dashboardCache.heroMovies);
    setTrendingContent(dashboardCache.trending);
    setNowPlayingContent(dashboardCache.nowPlaying);
    setOnTheAirContent(dashboardCache.onTheAir);
    setTopRatedContent(dashboardCache.topRated);
    setPopularContent(dashboardCache.popular);
    setGenreCarousels(dashboardCache.genreCarousels);
    if (dashboardCache.hasData) setLoadingHero(false);
  }), []);

  // Load base TMDB content (Hero, Trending, etc) — NOT genre-dependent
  useEffect(() => {
    let mounted = true;

    async function loadBaseContent(indexes: LightIndexes) {
      const lang = getTmdbLanguage();
      const loadedFor = dashboardCache.baseFor;

      // Déjà calculé pour cette langue : pas de rechargement (retour sur l'accueil, ou catalogue
      // neuf). Le changement de langue vide le cache avant de prévenir (GeneralSection).
      if (dashboardCache.hasData && loadedFor && loadedFor.lang === lang) {
        setLoadingHero(false);
        if (sameBaseCatalog(loadedFor, indexes)) return;

        // Catalogue neuf que personne n'a encore rapproché de l'accueil : recalcul discret depuis
        // le cache TMDB, sans réseau ni état « chargement ». Les rangées ne changent à l'écran que
        // si leur contenu a changé.
        const generation = getDashboardCacheGeneration();
        try {
          const base = await computeBaseRematch(indexes);
          if (mounted && base) installDashboardRematch({ generation, base, genres: null });
        } catch (e) {
          log.warn('Recalcul discret impossible, rangées actuelles gardées', e);
        }
        return;
      }

      // Mark as loading (DashboardPage renders nothing while loading)
      if (!dashboardCache.hasData) {
        setLoadingHero(true);
      }

      const t0 = performance.now();
      try {
        // Sans compte ni clé TMDB personnelle : l'accueil ne garde que les rangées du fournisseur
        // (reprises, Ma liste, nouveautés de la semaine). Rien à demander à TMDB, et rien à réessayer
        // tant que la situation ne change pas : l'accueil recalcule au retour de la clé.
        if (!(await isTmdbAvailable())) {
          if (mounted) {
            setHeroMovies([]);
            setTrendingContent([]);
            setNowPlayingContent([]);
            setOnTheAirContent([]);
            setTopRatedContent([]);
            setPopularContent([]);
            markDashboardLoaded();
          }
          return;
        }

        const getValue = <T,>(result: PromiseSettledResult<T>, fallback: T): T => {
          if (result.status === 'fulfilled') return result.value;
          log.warn('Dashboard content load failed:', result.reason);
          return fallback;
        };

        // 1. Fetch ALL 5 lists in parallel (trending + 4 carousels)
        const results = await Promise.allSettled([
          getTmdbTrendingAndMatch(indexes, DASHBOARD_ROW_LIMIT),
          getTmdbNowPlayingAndMatch(indexes, DASHBOARD_ROW_LIMIT),
          getTmdbOnTheAirAndMatch(indexes, DASHBOARD_ROW_LIMIT),
          getTmdbTopRatedAndMatch(indexes, DASHBOARD_ROW_LIMIT),
          getTmdbPopularAndMatch(indexes, DASHBOARD_ROW_LIMIT),
        ]);
        const tFetch = performance.now();

        const trending = getValue(results[0], [] as TrendingItem[]) as TrendingItem[];
        const nowPlaying = getValue(results[1], [] as TrendingItem[]) as TrendingItem[];
        const onTheAir = getValue(results[2], [] as TrendingItem[]) as TrendingItem[];
        const topRated = getValue(results[3], [] as TrendingItem[]) as TrendingItem[];
        const popular = getValue(results[4], [] as TrendingItem[]) as TrendingItem[];

        // 2. Build heroes from trending data (local only, ~5ms)
        const heroes = await buildHeroFromTrendingItems(trending, indexes, DASHBOARD_HERO_COUNT);
        const tHero = performance.now();

        devLog('perf',
          `Dashboard base content loaded — fetch: ${(tFetch - t0).toFixed(0)}ms, hero: ${(tHero - tFetch).toFixed(0)}ms, total: ${(tHero - t0).toFixed(0)}ms`
        );

        // Toutes les rangées vides parce que TMDB était injoignable (hors ligne, listes > 24 h, donc
        // aucune liste en cache) : rien n'est gardé comme « chargé », le retour sur l'accueil ou le
        // retour du réseau réessaient au lieu de garder un accueil vide jusqu'à « Actualiser ».
        // Listes lues mais sans titre du catalogue (fournisseur sans
        // numéros TMDB, chaînes seulement) : accueil gardé comme avant, sans relecture à chaque retour.
        const allEmpty = [trending, nowPlaying, onTheAir, topRated, popular].every((row) => row.length === 0);
        const nothingLoaded = allEmpty && !(await anyDashboardListRead());
        // Bannière vide parce que la liste des tendances, sa source, n'a pas pu être lue (réseau pas
        // encore prêt au réveil, proxy en erreur) alors que d'autres rangées sont arrivées : rangées
        // gardées pour un retour instantané, mais pas comme « calculées pour cette langue » (baseFor
        // vide), sinon la bannière restait vide jusqu'à un changement de langue, les recalculs suivants
        // se faisant sans réseau (Chromecast). Le retour sur l'accueil, un catalogue relu ou le
        // retour du réseau rechargent alors, sans repasser par l'état « chargement ».
        const heroSourceMissing = heroes.length === 0
          && (await readTmdbList('trending', false).catch(() => null)) === null;

        if (mounted) {
          setHeroMovies(heroes);
          setTrendingContent(trending);
          setNowPlayingContent(nowPlaying);
          setOnTheAirContent(onTheAir);
          setTopRatedContent(topRated);
          setPopularContent(popular);
          markDashboardLoaded(); // Chargement terminé (même vide) : l'accueil n'est plus « en rechargement »
        }

        if (mounted && !nothingLoaded) {
          // Sync module cache for instant return
          dashboardCache.heroMovies = heroes;
          dashboardCache.trending = trending;
          dashboardCache.nowPlaying = nowPlaying;
          dashboardCache.onTheAir = onTheAir;
          dashboardCache.topRated = topRated;
          dashboardCache.popular = popular;
          dashboardCache.hasData = true;
          dashboardCache.baseFor = heroSourceMissing ? null : baseKeyFor(indexes, lang);
          perfMark('home-data-ready');
        }
      } catch (e) {
        log.error('Failed to load dashboard base content', e);
      } finally {
        if (mounted) setLoadingHero(false);
      }
    }

    // Check if we have lightIndexes
    if (lightIndexes) {
      void loadBaseContent(lightIndexes);
    }
    // When lightIndexes is undefined (fetch in progress), loadingHero stays true
    // → skeletons remain visible until data arrives

    return () => {
      mounted = false;
    };
  }, [langVersion, lightIndexes, retryVersion]);

  // Load genre carousels separately (so changing genres doesn't reload Hero)
  useEffect(() => {
    let mounted = true;

    async function loadGenreContent() {
      const enabledGenres = getEnabledGenres();
      if (enabledGenres.length === 0 || !lightIndexes || lightIndexes.movies.size === 0) {
        setGenreCarousels(new Map());
        // Le cache suit l'affichage : une installation ultérieure ne doit pas remettre d'anciens genres
        dashboardCache.genreCarousels = new Map();
        dashboardCache.genreFor = null;
        return;
      }

      // Clé complète du dernier calcul, gardée dans le cache du module (l'accueil est démonté
      // pendant qu'on choisit les genres dans les Paramètres) : on ne recalcule que si le
      // catalogue, les genres choisis ou la langue ont changé.
      // Sans compte ni clé TMDB : pas de rangées par genre (elles viennent toutes de TMDB)
      if (!(await isTmdbAvailable())) {
        if (mounted) setGenreCarousels(new Map());
        return;
      }

      const lang = getTmdbLanguage();
      const loadedFor = dashboardCache.genreFor;
      if (loadedFor && loadedFor.lang === lang && loadedFor.genresKey === enabledGenresKey) {
        if (loadedFor.moviesId === catalogTableId(lightIndexes.movies)) {
          setGenreCarousels(dashboardCache.genreCarousels);
          return;
        }
        // Seul le catalogue a changé : recalcul discret depuis le cache TMDB, sans réseau.
        const generation = getDashboardCacheGeneration();
        try {
          const genres = await computeGenreRematch(lightIndexes);
          if (mounted && genres) installDashboardRematch({ generation, base: null, genres });
        } catch (e) {
          log.warn('Recalcul discret des genres impossible, rangées actuelles gardées', e);
        }
        return;
      }

      try {
        const genreRequests = enabledGenres.map((genreId) =>
          getTmdbByGenreAndMatch(lightIndexes, genreId, DASHBOARD_ROW_LIMIT)
        );

        const results = await Promise.allSettled(genreRequests);

        const genreMap = new Map<number, TrendingItem[]>();
        enabledGenres.forEach((genreId, index) => {
          const result = results[index];
          if (result.status === 'fulfilled') {
            genreMap.set(genreId, result.value);
          } else {
            log.warn(`Genre ${genreId} load failed:`, result.reason);
            genreMap.set(genreId, []);
          }
        });

        if (mounted) {
          setGenreCarousels(genreMap);
          dashboardCache.genreCarousels = genreMap;
          dashboardCache.genreFor = genreKeyFor(lightIndexes, enabledGenresKey, lang);
        }
      } catch (e) {
        log.error('Failed to load genre carousels', e);
      }
    }

    void loadGenreContent();

    return () => {
      mounted = false;
    };
  }, [enabledGenresKey, langVersion, lightIndexes]);

  // Fournisseur sans numéro TMDB : titres des listes de l'accueil retrouvés par le nom, puis rangées
  // recalculées discrètement (titleTmdbLinks.ts). Rien à faire quand tout est déjà relié.
  const currentIndexesRef = useRef(lightIndexes);
  // Compté une fois par catalogue (des centaines de milliers de titres)
  const withoutTmdb = useMemo(() => (lightIndexes ? mostlyWithoutTmdb(lightIndexes) : false), [lightIndexes]);
  // Catalogue pour lequel les essais sont finis (relié, ou plus d'essai prévu)
  const [linkingDoneFor, setLinkingDoneFor] = useState<LightIndexes | null>(null);
  useEffect(() => {
    currentIndexesRef.current = lightIndexes;
    if (!lightIndexes || loadingHero) return;
    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const waits = withoutTmdb;
    const stillCurrent = () => !cancelled && currentIndexesRef.current === lightIndexes;
    const attempt = (index: number) => {
      void linkHomeTitlesAndRefresh(lightIndexes, stillCurrent).then((linked) => {
        if (!stillCurrent()) return;
        const next = TITLE_LINKS_TIMING.retryMs[index];
        // Rien relié et d'autres essais prévus : les listes n'étaient peut-être pas encore là
        // (une comparaison déjà faite, même sans nouveau lien, met fin aux essais)
        if (linked === 0 && waits && !titleLinksSettled(lightIndexes) && next !== undefined) timers.push(setTimeout(() => attempt(index + 1), next));
        else {
          exhaustedCatalogs.add(lightIndexes.movies);
          setLinkingDoneFor(lightIndexes);
          // Catalogue sans numéros : les nouveautés de la semaine sont cherchées par le titre
          if (waits) {
            void linkRecentByTitle(lightIndexes, stillCurrent).then((n) => {
              if (n > 0 && currentIndexesRef.current === lightIndexes) setRecentVersion((v) => v + 1);
            });
          }
        }
      });
    };
    timers.push(setTimeout(() => attempt(0), TITLE_LINKS_TIMING.firstMs));
    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
  }, [lightIndexes, loadingHero, genreCarousels, withoutTmdb]);
  const linkingTitles = withoutTmdb && !loadingHero && linkingDoneFor !== lightIndexes && !(lightIndexes && exhaustedCatalogs.has(lightIndexes.movies));

  return {
    trendingContent,
    nowPlayingContent,
    onTheAirContent,
    topRatedContent,
    popularContent,
    genreCarousels,
    heroMovies,
    loadingHero,
    carouselPrefs,
    thisWeekMovies,
    thisWeekSeries,
    linkingTitles,
  };
}
