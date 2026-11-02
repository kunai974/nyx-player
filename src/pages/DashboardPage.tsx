import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DashboardRowItem } from '../components/Dashboard/DashboardRow';
import VirtualDashboardRow from '../components/Dashboard/VirtualDashboardRow';
import DashboardHero from '../components/Dashboard/DashboardHero';
import DashboardModeSwitch, { DashboardMode } from '../components/Dashboard/DashboardModeSwitch';
import ContinueWatchingRow from '../components/Dashboard/ContinueWatchingRow';
import LightIptvMode from '../components/Iptv/LightIptvMode';
import { knownCategoryIds, rowCategoryOf } from '../components/Iptv/categoryRows';
import RecycledRail from '../components/Iptv/rail/RecycledRail';
import { isRailOn } from '../components/Iptv/rail/rail';
import { buildContinueItems, type ContinueActions } from '../components/Dashboard/continueItems';
import { suggestionRows, useSuggestionsRail } from '../components/Dashboard/suggestionsRail';
import { usePlayer } from '../contexts/PlayerContext';
import { cleanTitle } from '../utils/itemHelpers';
import type { TrendingItem } from '../services/tmdbMatchingService';
import { requestMemoryPurge } from '../services/memoryService';
import { trackScrollPosition } from '../utils/scrollPositionSaver';
import { getDashboardDefaultMode } from '../services/preferencesService';
import { DASHBOARD_RESET_EVENT } from '../services/eventConstants';
import { getGenreName, getCarouselLabel } from '../services/carouselConstants';
import type { IptvStream, IptvSeries } from '../types/iptv';
import type { LightIndexes } from '../types/lightIndex';
import { getIconUrl } from '../types/lightIndex';
import type { NavigateToContent } from '../types/navigation';
import { useDashboardData, isDashboardReloading } from '../hooks/useDashboardData';
import { useContinueWatching } from '../hooks/useContinueWatching';
import { useWatchlistData } from '../hooks/useWatchlistData';
import { useDevOverrides } from '../contexts/DevOverrideContext';
import UnavailableTitleModal from '../components/Common/UnavailableTitleModal';
import type { HydratedWatchlistItem } from '../services/watchlistHydration';
import { clearUnavailableResume, type PlaybackProgressItem } from '../services/playbackProgressService';
import { isTv } from '../utils/platform';
import { cancelScroll } from '../utils/spatialNavigation/scrollAnimator';
import { forgetZone } from '../utils/spatialNavigation/focusMemory';
import './DashboardPage.css';

interface DashboardPageProps {
  /**
   * CALLBACK UNIFIÉ pour naviguer vers une page de détail.
   * @see types/navigation.ts pour les types
   */
  onNavigateToContent: NavigateToContent;
  onOpenCategoryDetail?: (
    categoryId: string,
    categoryName: string,
    items: (IptvStream | IptvSeries)[],
    type: 'movies' | 'series'
  ) => void;
  /**
   * IPTV data status indicator (passed from App.tsx).
   * Shows alert banner when source is unstable.
   */
  iptvStatus?: 'ok' | 'warning' | 'error';
  /**
   * Light Indexes for RAM-efficient display.
   * PRIMARY source for carrousel data.
   */
  lightIndexes?: LightIndexes;
  /** Accueil caché par une fiche ou par la lecture : la bannière arrête sa rotation, le rail TV garde les rangées de la dernière sélection. */
  heroPaused?: boolean;
}

// =========================================================================
// SESSION CACHE (Preserved across unmounts / remounts)
// =========================================================================
let sessionDashboardMode: DashboardMode | null = null;
const sessionScrollPositions: Record<string, number> = {
  suggestions: 0,
  films: 0,
  series: 0,
};

/** Vider le cache de mémorisation du Dashboard (ex: quand on quitte la page depuis la sidebar) */
export function clearDashboardSessionCache() {
  sessionDashboardMode = null;
  sessionScrollPositions.suggestions = 0;
  sessionScrollPositions.films = 0;
  sessionScrollPositions.series = 0;
}

const DashboardPage: React.FC<DashboardPageProps> = ({
  onNavigateToContent,
  onOpenCategoryDetail,
  iptvStatus = 'ok',
  lightIndexes,
  heroPaused = false,
}) => {
  const { t } = useTranslation('dashboard');
  const { t: tNav } = useTranslation('navigation');
  const { play, setCurrentSeries } = usePlayer();

  // =========================================================================
  // DEV OVERRIDES
  // =========================================================================
  const { overrides, setActivePage } = useDevOverrides();
  const dp = overrides.dashboardPage;

  useEffect(() => {
    setActivePage('DashboardPage');
  }, [setActivePage]);

  // =========================================================================
  // HOOKS EXTRAITS (Phase 3A)
  // =========================================================================
  const {
    trendingContent,
    nowPlayingContent,
    onTheAirContent,
    topRatedContent,
    popularContent,
    genreCarousels,
    heroMovies,
    loadingHero: rawLoadingHero,
    carouselPrefs,
    thisWeekMovies,
    thisWeekSeries,
  } = useDashboardData(lightIndexes);

  const { continueWatching } = useContinueWatching();
  const { watchlist, handleWatchlistToggle } = useWatchlistData(lightIndexes);
  // Titre de Ma liste introuvable chez le fournisseur actuel : fenêtre Rechercher / Retirer
  const [unavailable, setUnavailable] = useState<HydratedWatchlistItem | null>(null);
  // Reprise « Introuvable » (titre plus au catalogue) : même fenêtre Rechercher / Retirer que
  // Ma liste ; « Retirer » l'enlève de « Reprendre »
  const [unavailableResume, setUnavailableResume] = useState<PlaybackProgressItem | null>(null);
  // TV : rangée de la carte retirée. Les cartes suivantes glissent sous la sélection ; si c'était la
  // dernière, la sélection disparaissait avec elle et passe à la nouvelle dernière carte.
  const resumeRowRef = useRef<Element | null>(null);
  const removedFromRowRef = useRef<Element | null>(null);
  const openUnavailableResume = useCallback((item: PlaybackProgressItem) => {
    resumeRowRef.current = isTv() ? document.activeElement?.closest('[data-nav-row]') ?? null : null;
    setUnavailableResume(item);
  }, []);
  const removeUnavailableResume = (item: PlaybackProgressItem) => {
    removedFromRowRef.current = resumeRowRef.current;
    // Rien de retiré : la rangée ne bougera pas, la sélection non plus
    void clearUnavailableResume(item).then((count) => { if (count === 0) removedFromRowRef.current = null; });
  };
  useEffect(() => {
    const row = removedFromRowRef.current;
    if (!row) return;
    removedFromRowRef.current = null;
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    const cards = row.isConnected ? row.querySelectorAll<HTMLElement>('.carousel-card') : [];
    cards[cards.length - 1]?.focus({ preventScroll: true });
  }, [continueWatching]);

  // =========================================================================
  // DASHBOARD MODE (persisted in SQLite)
  // =========================================================================
  const [dashboardMode, setDashboardModeState] = useState<DashboardMode>(() => {
    return sessionDashboardMode || (getDashboardDefaultMode() as DashboardMode);
  });

  const [isModeSwitching, setIsModeSwitching] = useState(false);
  const pendingModeRef = React.useRef<DashboardMode | null>(null);

  const handleModeChange = (mode: DashboardMode) => {
    if (mode === dashboardMode || isModeSwitching) return;
    setIsModeSwitching(true);
    pendingModeRef.current = mode;
    sessionDashboardMode = mode;
    setTimeout(() => {
      setDashboardModeState(mode);
      requestAnimationFrame(() => {
        setIsModeSwitching(false);
        pendingModeRef.current = null;
      });
    }, 200);
  };

  // Reset vers le mode par défaut quand on clique sur Dashboard dans la sidebar
  useEffect(() => {
    const handleDashboardReset = () => {
      clearDashboardSessionCache(); // Reset du cache global (y compris TOUS les scrolls)
      
      const defaultMode = getDashboardDefaultMode() as DashboardMode;
      sessionDashboardMode = defaultMode; // On redéfinit la valeur initialisée pour la session active
      setDashboardModeState(defaultMode);
      
      // Force scroll to top immediately
      if (containerRef.current) {
        cancelScroll(containerRef.current); // écriture directe : pas un ancrage de l'animation en cours
        containerRef.current.scrollTop = 0;
      }
      // Page remontée : Droite depuis la barre latérale entre par la bannière, pas par la carte quittée en bas
      forgetZone('content');
    };
    window.addEventListener(DASHBOARD_RESET_EVENT, handleDashboardReset);
    return () => {
      window.removeEventListener(DASHBOARD_RESET_EVENT, handleDashboardReset);
    };
  }, []);

  // =========================================================================
  // OVERRIDE APPLICATION
  // =========================================================================
  const loadingHero = dp.forceHeroLoading || rawLoadingHero;
  const effectiveIptvStatus = dp.forceIptvStatus ?? iptvStatus;
  const effectiveLightIndexes = dp.forceNoLightIndexes ? undefined : lightIndexes;
  const effectiveDashboardMode = dp.forceDashboardMode ?? dashboardMode;
  const effectiveIsModeSwitching = dp.forceModeSwitching || isModeSwitching;

  // =========================================================================
  // MEMORY PURGE & SCROLL RESTORE
  // =========================================================================
  const containerRef = useRef<HTMLDivElement>(null);

  // Dernière position rendue : le mode concerné et la valeur relue juste après l'écriture (déjà bornée par la hauteur
  // de la page). Si la page n'a plus cette valeur à la fin du chargement, c'est que la personne a défilé.
  const restoredModeRef = useRef<DashboardMode | null>(null);
  const restoredTopRef = useRef<number | null>(null);
  // Dernier mode vu, chargement compris : un changement d'onglet pendant le chargement est repéré
  const seenModeRef = useRef<DashboardMode | null>(null);

  // Restauration synchrone avant le DOM Paint
  useLayoutEffect(() => {
    const container = containerRef.current;
    const switched = seenModeRef.current !== null && seenModeRef.current !== effectiveDashboardMode;
    seenModeRef.current = effectiveDashboardMode;
    if (loadingHero && !isDashboardReloading()) {
      // Onglet changé pendant le chargement : sa position sera rendue à la fin, sauf si la personne défile d'ici là
      if (switched && container) {
        restoredModeRef.current = effectiveDashboardMode;
        restoredTopRef.current = container.scrollTop;
      }
      return;
    }
    if (!container) return;
    // L'accueil se parcourt déjà pendant son chargement : revenir à la position mémorisée à la fin du chargement
    // ramenait la page en arrière en pleine descente, puis la sélection la faisait repartir d'un coup
    if (restoredModeRef.current === effectiveDashboardMode) {
      const writtenTop = restoredTopRef.current ?? 0;
      if (Math.abs(container.scrollTop - writtenTop) > 1) return;
    } else if (restoredModeRef.current === null && container.scrollTop > 0) {
      // Première restauration après un chargement pendant lequel la personne a déjà défilé
      restoredModeRef.current = effectiveDashboardMode;
      restoredTopRef.current = null;
      return;
    }

    const savedScroll = sessionScrollPositions[effectiveDashboardMode] || 0;
    cancelScroll(container); // écriture directe : pas un ancrage de l'animation en cours
    // eslint-disable-next-line react-hooks/immutability -- restauration du défilement dans le DOM avant l'affichage (rôle de useLayoutEffect)
    container.scrollTop = savedScroll;
    restoredModeRef.current = effectiveDashboardMode;
    restoredTopRef.current = container.scrollTop;
  }, [effectiveDashboardMode, loadingHero]);

  // Effet de mise en page : son nettoyage tourne avant le retrait du conteneur et avant la restauration du mode suivant,
  // la position en attente est donc lue au bon moment
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // La position est lue au repos seulement (scrollPositionSaver.ts) : la lire à chaque événement forçait une mise en page
    const stopTracking = trackScrollPosition(container, (scrollTop) => {
      sessionScrollPositions[effectiveDashboardMode] = scrollTop;
      requestMemoryPurge();
    });
    return stopTracking;
  }, [effectiveDashboardMode]);

  // =========================================================================
  // NAVIGATION HELPERS
  // =========================================================================
  // Identité stable : les tableaux de cartes ci-dessous en dépendent, et le React.memo des rangées
  // et des cartes ne sert à rien si chaque rendu de la page leur donne de nouveaux tableaux.
  // La ref garde la dernière version de onNavigateToContent sans changer l'identité de la fonction.
  const onNavigateRef = useRef(onNavigateToContent);
  useLayoutEffect(() => {
    onNavigateRef.current = onNavigateToContent;
  }, [onNavigateToContent]);
  const navigateById = useCallback((type: 'movie' | 'series', id: number | string, tmdbId?: number) => {
    if (type === 'movie') {
      onNavigateRef.current('movie', {
        tmdbId: tmdbId || 0,
        streamId: Number(id),
      });
    } else {
      onNavigateRef.current('series', {
        tmdbId: tmdbId || 0,
        seriesId: Number(id),
      });
    }
  }, []);

  // =========================================================================
  // TMDB → DashboardRowItem HELPER
  // =========================================================================
  const mapTmdbToRowItems = useCallback((items: TrendingItem[]): DashboardRowItem[] => {
    return items.map((item) => {
      const itemId = Number(item.id);
      const tmdbId = item.tmdbId || 0;

      return {
        id: item.id,
        title: item.title,
        image: item.image,
        onClick: () => navigateById(item.type, item.id, item.tmdbId),
        overlayText: item.rating ? `★ ${item.rating.toFixed(1)}` : undefined,
        mediaType: item.type,
        overview: item.overview,
        tmdbId: tmdbId,
        streamId: itemId,
        onAddToList: () => {
          void handleWatchlistToggle(itemId, tmdbId, item.type);
        },
      };
    });
  }, [navigateById, handleWatchlistToggle]);

  // Cartes de chaque rangée : recalculées seulement quand leurs données changent, pas à chaque
  // rendu de la page (mode, fenêtre « titre indisponible », bannière…).
  const trendingRowItems = useMemo(() => mapTmdbToRowItems(trendingContent), [mapTmdbToRowItems, trendingContent]);
  const nowPlayingRowItems = useMemo(() => mapTmdbToRowItems(nowPlayingContent), [mapTmdbToRowItems, nowPlayingContent]);
  const onTheAirRowItems = useMemo(() => mapTmdbToRowItems(onTheAirContent), [mapTmdbToRowItems, onTheAirContent]);
  const topRatedRowItems = useMemo(() => mapTmdbToRowItems(topRatedContent), [mapTmdbToRowItems, topRatedContent]);
  const popularRowItems = useMemo(() => mapTmdbToRowItems(popularContent), [mapTmdbToRowItems, popularContent]);
  const genreRowItems = useMemo(
    () => Array.from(genreCarousels.entries()).map(([genreId, items]) => [genreId, mapTmdbToRowItems(items)] as const),
    [mapTmdbToRowItems, genreCarousels],
  );

  const watchlistRowItems = useMemo(() => watchlist.map((item) => ({
    id: item.stream_id,
    title: item.name ? cleanTitle(item.name) : tNav('unknown_title'),
    image: item.posterUrl,
    mediaType: item.type,
    unavailable: item.isOrphan,
    overlayText: item.isOrphan ? tNav('unavailable_badge') : undefined,
    onClick: () => (item.isOrphan
      ? setUnavailable(item)
      : navigateById(item.type, item.stream_id, item.tmdb_id)),
    inWatchlist: true,
    tmdbId: item.tmdb_id,
    streamId: item.stream_id,
    onAddToList: () =>
      handleWatchlistToggle(item.stream_id, item.tmdb_id, item.type),
  })), [watchlist, tNav, navigateById, handleWatchlistToggle]);

  const iconPrefixes = lightIndexes?.iconPrefixes;
  const thisWeekMovieRowItems = useMemo(() => thisWeekMovies.map((m) => {
    const itemId = m.id;
    const tmdbId = m.tmdbId || 0;
    return {
      id: m.id,
      title: cleanTitle(m.name),
      image: getIconUrl(m, iconPrefixes || []),
      mediaType: 'movie' as const,
      onClick: () => navigateById('movie', m.id, m.tmdbId),
      tmdbId: tmdbId,
      streamId: itemId,
      onAddToList: () =>
        handleWatchlistToggle(itemId, tmdbId, 'movie'),
    };
  }), [thisWeekMovies, iconPrefixes, navigateById, handleWatchlistToggle]);

  const thisWeekSeriesRowItems = useMemo(() => thisWeekSeries.map((s) => {
    const itemId = s.id;
    const tmdbId = s.tmdbId || 0;
    return {
      id: s.id,
      title: cleanTitle(s.name),
      image: getIconUrl(s, iconPrefixes || []),
      mediaType: 'series' as const,
      onClick: () => navigateById('series', s.id, s.tmdbId),
      tmdbId: tmdbId,
      streamId: itemId,
      onAddToList: () =>
        handleWatchlistToggle(itemId, tmdbId, 'series'),
    };
  }), [thisWeekSeries, iconPrefixes, navigateById, handleWatchlistToggle]);

  // =========================================================================
  // TV : SUGGESTIONS SUR LE RAIL RECYCLÉ (components/Iptv/rail)
  // =========================================================================
  // Les rangées sont écrites sans React. `play`, `setCurrentSeries`, `navigateById` et les autres rappels gardent leur
  // identité d'un rendu à l'autre : la rangée Reprendre n'est remplie de nouveau que si ses reprises changent
  const rail = isRailOn();
  const mapContinueToRowItems = useCallback((items: PlaybackProgressItem[], indexes: LightIndexes | undefined) => {
    const actions: ContinueActions = {
      play,
      setCurrentSeries,
      navigateById,
      handleWatchlistToggle,
      onUnavailable: openUnavailableResume,
    };
    return buildContinueItems(items, indexes, actions, { unavailable: tNav('unavailable_badge') });
  }, [play, setCurrentSeries, navigateById, handleWatchlistToggle, openUnavailableResume, tNav]);
  const continueRowItems = useMemo(
    // eslint-disable-next-line react-hooks/refs -- les cartes gardent les rappels pour le geste (OK, clic), aucun n'est appelé pendant le rendu
    () => (rail ? mapContinueToRowItems(continueWatching, lightIndexes) : []),
    [rail, mapContinueToRowItems, continueWatching, lightIndexes],
  );
  const railRowList = useMemo(() => (rail ? suggestionRows(
    {
      trending: trendingRowItems,
      continueWatching: continueRowItems,
      nowPlaying: nowPlayingRowItems,
      onTheAir: onTheAirRowItems,
      watchlist: watchlistRowItems,
      topRated: topRatedRowItems,
      popular: popularRowItems,
      genres: genreRowItems,
      thisWeekMovies: thisWeekMovieRowItems,
      thisWeekSeries: thisWeekSeriesRowItems,
    },
    {
      trending: t('carousel_trending'),
      continueWatching: t('carousel_continue'),
      nowPlaying: t('carousel_recent_movies'),
      onTheAir: t('carousel_recent_series'),
      watchlist: t('carousel_watchlist'),
      topRated: t('carousel_top_rated'),
      popular: getCarouselLabel('popular'),
      genre: getGenreName,
      thisWeekMovies: t('carousel_new_movies_this_week'),
      thisWeekSeries: t('carousel_new_series_this_week'),
    },
    carouselPrefs.disabledCarousels,
    loadingHero,
  ) : []), [
    rail, trendingRowItems, continueRowItems, nowPlayingRowItems, onTheAirRowItems, watchlistRowItems, topRatedRowItems,
    popularRowItems, genreRowItems, thisWeekMovieRowItems, thisWeekSeriesRowItems, t, carouselPrefs.disabledCarousels,
    loadingHero,
  ]);
  const railSuggestions = useSuggestionsRail(railRowList, t('add_to_watchlist' as 'loading', { ns: 'common' })); // Cast: key exists but types not regenerated

  // =========================================================================
  // RENDER
  // =========================================================================

  return (
    <div ref={containerRef} className="dashboard-page scrollbar-thin" data-testid="dashboard-page" data-nav-cadence>
      {unavailable && (
        <UnavailableTitleModal
          item={unavailable}
          onRemove={() => void handleWatchlistToggle(unavailable.stream_id, unavailable.tmdb_id, unavailable.type)}
          onClose={() => setUnavailable(null)}
        />
      )}
      {unavailableResume && (
        <UnavailableTitleModal
          item={{ name: unavailableResume.title }}
          scope="resume"
          onRemove={() => removeUnavailableResume(unavailableResume)}
          onClose={() => setUnavailableResume(null)}
        />
      )}
      {/* IPTV Status Alert Banner */}
      {effectiveIptvStatus !== 'ok' && (
        <div className="dashboard-status-alert">
          <span className="alert-icon">⚠️</span>
          <span className="alert-message">
            {t('source_instability_message')}
          </span>
        </div>
      )}

      <DashboardHero
        heroMovies={heroMovies}
        loading={loadingHero}
        lightIndexes={lightIndexes}
        play={play}
        navigateById={navigateById}
        handleWatchlistToggle={handleWatchlistToggle}
        paused={heroPaused}
        forceFading={dp.forceHeroFading}
        forceEmpty={dp.forceHeroEmpty}
        forceNoLogo={dp.forceHeroNoLogo}
      />

      {/* Onglets cachés pendant le chargement. TV : leur place est gardée, sinon leur arrivée décalait les rangées en
          plein défilement (sur le rail, la descente jouée par le compositeur sautait de la hauteur des onglets) */}
      {!loadingHero ? (
        <DashboardModeSwitch activeMode={effectiveDashboardMode} onModeChange={handleModeChange} />
      ) : isTv() ? (
        <DashboardModeSwitch activeMode={effectiveDashboardMode} onModeChange={handleModeChange} reserved />
      ) : null}

      {/* Content based on mode - Fade transition wrapper */}
      <div className={`dashboard-mode-content ${effectiveIsModeSwitching ? 'mode-switching' : ''}`} data-testid="dashboard-mode-content">
        {effectiveDashboardMode === 'suggestions' && rail ? (
          <RecycledRail
            className="dashboard-content rail"
            layout="carousel"
            rows={railSuggestions.keys}
            source={railSuggestions.source}
            gap={1.75}
            covered={heroPaused}
          />
        ) : effectiveDashboardMode === 'suggestions' ? (
          <div className="dashboard-content">
            {/* 1. Tendances */}
            {!carouselPrefs.disabledCarousels.includes('trending') && (
              <VirtualDashboardRow gap={1.75} title={t('carousel_trending')} items={trendingRowItems} priority loading={loadingHero} />
            )}

            {/* 2. Reprendre la lecture */}
            {!carouselPrefs.disabledCarousels.includes('continue') && (
              <ContinueWatchingRow
                items={continueWatching}
                lightIndexes={lightIndexes}
                play={play}
                setCurrentSeries={setCurrentSeries}
                navigateById={navigateById}
                handleWatchlistToggle={handleWatchlistToggle}
                onUnavailable={openUnavailableResume}
                gap={1.75}
              />
            )}

            {/* 3. Films Récents (TMDB Now Playing) */}
            {!carouselPrefs.disabledCarousels.includes('nowPlaying') && (
              <VirtualDashboardRow gap={1.75} title={t('carousel_recent_movies')} items={nowPlayingRowItems} priority loading={loadingHero} />
            )}

            {/* 4. Séries Récentes (TMDB On The Air) */}
            {!carouselPrefs.disabledCarousels.includes('onTheAir') && (
              <VirtualDashboardRow gap={1.75} title={t('carousel_recent_series')} items={onTheAirRowItems} priority loading={loadingHero} />
            )}

            {/* 5. Ma Liste */}
            {watchlist.length > 0 && !carouselPrefs.disabledCarousels.includes('watchlist') && (
              <VirtualDashboardRow gap={1.75}
                title={t('carousel_watchlist')}
                priority
                items={watchlistRowItems}
              />
            )}

            {/* 6. Top Films (TMDB Top Rated) */}
            {!carouselPrefs.disabledCarousels.includes('topRated') && (
              <VirtualDashboardRow gap={1.75} title={t('carousel_top_rated')} items={topRatedRowItems} loading={loadingHero} />
            )}

            {/* 7. Films Populaires (lifetime popularity) */}
            {!carouselPrefs.disabledCarousels.includes('popular') && (
              <VirtualDashboardRow gap={1.75} title={getCarouselLabel('popular')} items={popularRowItems} loading={loadingHero} />
            )}

            {/* 8. Genres dynamiques */}
            {genreRowItems.map(([genreId, items]) => (
              <VirtualDashboardRow gap={1.75}
                key={`genre-${genreId}`}
                title={getGenreName(genreId)}
                items={items}
              />
            ))}

            {/* 9. Nouveautés de la semaine */}
            {!carouselPrefs.disabledCarousels.includes('thisWeekMovies') && thisWeekMovies.length > 0 && (
              <VirtualDashboardRow gap={1.75}
                title={t('carousel_new_movies_this_week')}
                items={thisWeekMovieRowItems}
              />
            )}

            {!carouselPrefs.disabledCarousels.includes('thisWeekSeries') && thisWeekSeries.length > 0 && (
              <VirtualDashboardRow gap={1.75}
                title={t('carousel_new_series_this_week')}
                items={thisWeekSeriesRowItems}
              />
            )}
          </div>
        ) : effectiveLightIndexes ? (
          /* IPTV Mode (Films or Series) - RAM optimized with LightIndexes */
          <LightIptvMode
            key={effectiveDashboardMode}
            type={effectiveDashboardMode === 'films' ? 'movies' : 'series'}
            lightIndexes={effectiveLightIndexes}
            forceNoCategories={dp.forceIptvNoCategories}
            gap={1.75}
            onItemClick={(id, tmdbId) => {
              navigateById(
                effectiveDashboardMode === 'films' ? 'movie' : 'series',
                id,
                tmdbId > 0 ? tmdbId : undefined
              );
            }}
            onSeeAll={(categoryId, categoryName) => {
              if (onOpenCategoryDetail && effectiveLightIndexes) {
                const itemsMap = effectiveDashboardMode === 'films' ? effectiveLightIndexes.movies : effectiveLightIndexes.series;
                const iconPrefixes = effectiveLightIndexes.iconPrefixes;
                // Rangée « Autres » comprise : même rangement que les rangées de l'accueil
                const known = knownCategoryIds(effectiveLightIndexes.categories, effectiveDashboardMode === 'films' ? 'movie' : 'series');

                const items: Array<{ name: string; stream_id?: number; series_id?: number; tmdb: number; stream_icon?: string; cover?: string; category_id: string }> = [];
                itemsMap.forEach((item) => {
                  if (rowCategoryOf(item, known) === categoryId) {
                    const iconUrl = getIconUrl(item, iconPrefixes);
                    if (effectiveDashboardMode === 'films') {
                      items.push({
                        name: item.name,
                        stream_id: item.id,
                        tmdb: item.tmdbId,
                        stream_icon: iconUrl,
                        category_id: item.categoryId,
                      });
                    } else {
                      items.push({
                        name: item.name,
                        series_id: item.id,
                        tmdb: item.tmdbId,
                        cover: iconUrl,
                        category_id: item.categoryId,
                      });
                    }
                  }
                });

                onOpenCategoryDetail(
                  categoryId,
                  categoryName,
                  items as unknown as IptvStream[],
                  effectiveDashboardMode === 'films' ? 'movies' : 'series'
                );
              }
            }}
            covered={heroPaused}
          />
        ) : (
          <div className="iptv-mode-empty">
            <p>{t('loading')}</p>
          </div>
        )}
      </div>
    </div>
  );
};

export default DashboardPage;
