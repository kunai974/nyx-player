import React, { useRef, useEffect, useState, useMemo } from 'react';
import tmdb from '../services/tmdbApi';
import { isInWatchlist } from '../services/watchlistHydration';
import { toggleWatchlistOrNotify } from '../services/watchlistActions';
import WatchlistButton from '../components/Common/WatchlistButton';
import type { XtreamEpisode, AppSeriesInfo } from '../types/xtream';
import { useTmdbSeries } from '../hooks/useTmdbSeries';
import { useSeriesSourceSelection } from '../hooks/useSeriesSourceSelection';
import { useSeriesDetail } from '../hooks/useSeriesDetail';
import { useBackdropUrl } from '../hooks/useBackdropUrl';
import { useInertiaScroll } from '../hooks/useInertiaScroll';
import { SeriesSkeleton, SeriesCarouselSkeleton } from '../components/Skeletons/SeriesSkeletons';
import { EpisodeCard } from '../components/Lists/EpisodeCard';
import NyxDropdown from '../components/Common/NyxDropdown';
import { renderStars } from '../components/Detail/StarRating';
import SourceSelector from '../components/Detail/SourceSelector';
import { clearMultipleProgress } from '../services/playbackProgressService';
import { formatResumeTime } from '../utils/timeHelpers';
import { useDevOverrides } from '../contexts/DevOverrideContext';
import { usePlayer } from '../contexts/PlayerContext';
import { useTranslation } from 'react-i18next';
import { getTmdbLanguage } from '../utils/tmdbLanguage';
import { pickBestLogo } from '../utils/tmdbLogoHelper';
import { useTvPageFocus } from '../hooks/useTvPageFocus';
import { isTv } from '../utils/platform';
import './SeriesDetailPage.css';
import { warnOnReject } from '../utils/warnOnReject';

interface SeriesDetailPageProps {
  series: AppSeriesInfo;
  onBack: () => void;
  replayEntrance?: boolean;
  /** JIT hydration: charge l'objet série complet depuis SQLite (pattern unifié avec MovieDetailPage) */
  onLoadVersion?: (seriesId: number) => Promise<import('../types/iptv').IptvSeries | null>;
}


const SeriesDetailPage: React.FC<SeriesDetailPageProps> = ({
  series: initialSeries,
  onBack,
  replayEntrance,
  onLoadVersion,
}) => {
  const { t } = useTranslation('details');
  const { play, setCurrentSeries } = usePlayer();
  const { overrides, setActivePage } = useDevOverrides();
  const devOverrides = overrides.seriesDetailPage;

  // Register active page for DevPanel
  useEffect(() => {
    setActivePage('SeriesDetailPage');
  }, [setActivePage]);

  // =========================================================================
  // HOOKS — Logique extraite
  // =========================================================================
  const {
    series,
    groupedVersions,
    handleSourceChange,
  } = useSeriesSourceSelection({ initialSeries, onLoadVersion });

  // Series detail data (episodes, season, progress)
  const {
    localEpisodes,
    isEpisodesLoading,
    selectedSeason,
    setSelectedSeason,
    episodeProgress,
    resetKey,
    setResetKey,
  } = useSeriesDetail({ series });

  // TMDB Data (single call with actual selectedSeason)
  const {
    tmdbId,
    details,
    currentSeasonEpisodes: tmdbSeasonEpisodes,
    loadingState: rawLoadingState,
    isSeasonLoading,
  } = useTmdbSeries(series, selectedSeason);

  // =========================================================================
  // DEV OVERRIDES — appliqués sur les valeurs réelles
  // =========================================================================
  const loadingState = devOverrides.forceLoadingState ?? rawLoadingState;

  // Watchlist state — uses tmdbId from useTmdbSeries as primary key
  const watchlistTmdbId = tmdbId && tmdbId > 0 ? tmdbId : 0;
  const watchlistStreamId = Number(series.series_id) || 0;
  const [inWatchlist, setInWatchlist] = useState(false);
  useEffect(() => {
    if (watchlistTmdbId > 0 || watchlistStreamId > 0) {
      isInWatchlist(watchlistStreamId, watchlistTmdbId, 'series').then(setInWatchlist).catch(warnOnReject('SeriesDetailPage'));
    }
  }, [watchlistTmdbId, watchlistStreamId]);

  // Start an episode (episode card, or the Resume button)
  const playEpisode = (ep: XtreamEpisode) => {
    const seriesWithEpisodes = { ...series, episodes: localEpisodes || undefined };
    setCurrentSeries({ ...seriesWithEpisodes, tmdbTitle: details?.name });
    void play(ep, seriesWithEpisodes, undefined, {
      tmdbTitle: details?.name,
      tmdbId: details?.id || undefined,
      posterUrl: details?.poster_path
        ? tmdb.imageUrl(details.poster_path, 'w500') || undefined
        : series.cover || undefined,
    });
  };

  // Backdrop
  const [backdropIndex] = useState(() => Math.floor(Math.random() * 5));
  const backdropUrl = useBackdropUrl(
    details,
    series.backdrop_path as string[] | undefined,
    series.cover || '',
    backdropIndex,
  );
  const effectiveBackdropUrl = devOverrides.forceNoBackdrop ? '' : backdropUrl;

  // UI States
  const [isVisible, setIsVisible] = useState(false);
  const [showResetToast, setShowResetToast] = useState(false);

  // Carousel scroll hook
  const { ref: carouselRef, isDragging, handleMouseDown, dragStarted } = useInertiaScroll();

  // Handle initial entrance animation
  useEffect(() => {
    const timer = setTimeout(() => setIsVisible(true), 10);
    return () => clearTimeout(timer);
  }, []);

  // Replay entrance animation when returning from video
  useEffect(() => {
    if (replayEntrance) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- animation d'entrée rejouée au retour de la vidéo (masquée puis réaffichée)
      setIsVisible(false);
      const timer = setTimeout(() => setIsVisible(true), 50);
      return () => clearTimeout(timer);
    }
  }, [replayEntrance]);



  // --- UI Data Calculation ---
  const title = details?.name || series.name;
  const overview = details?.overview || series.plot || t('synopsis_unavailable');
  
  const userLang = getTmdbLanguage() === 'fr-FR' ? 'fr' : 'en';
  const logoUrl = pickBestLogo(details?.images, userLang);
  const year = details?.first_air_date?.split('-')[0] || '';
  const rating = details?.vote_average?.toFixed(1) || '';
  const genres = details?.genres?.map((g) => g.name).join(', ') || '';
  const cast =
    details?.credits?.cast
      ?.slice(0, 6)
      .map((c) => c.name)
      .join(', ') || '';
  const numberOfSeasons = details?.number_of_seasons || Object.keys(localEpisodes || {}).length;
  const status =
    details?.status === 'Returning Series'
      ? t('status_returning')
      : details?.status === 'Ended'
        ? t('status_ended')
        : '';

  // Episodes for current season
  const seasonNumbers = useMemo(
    () => (localEpisodes ? Object.keys(localEpisodes).map(Number).sort((a, b) => a - b) : []),
    [localEpisodes],
  );
  const currentEpisodes = devOverrides.forceEmptySeason
    ? []
    : (localEpisodes?.[selectedSeason] || []);

  // The episode the viewer stopped in: the latest one of this season that is started but not finished
  const resumeEpisode = [...currentEpisodes]
    .reverse()
    .find((ep) => {
      const info = ep.id ? episodeProgress.get(Number(ep.id)) : undefined;
      return !!info && info.timeSeconds >= 10 && info.progressPercent < 95;
    });
  const resumeInfo = resumeEpisode?.id ? episodeProgress.get(Number(resumeEpisode.id)) : undefined;


  // Poster fallback for episode images
  const posterFallback =
    (details?.poster_path ? tmdb.imageUrl(details.poster_path, 'w500') : series.cover) || '';

  // Get episode image URL with fallbacks
  const getEpisodeImage = (ep: XtreamEpisode, episodeNum: number): string => {
    const tmdbEp = tmdbSeasonEpisodes[episodeNum];
    if (tmdbEp?.still_path) {
      const url = tmdb.imageUrl(tmdbEp.still_path, 'w500');
      if (url) return url;
    }
    const xtreamImage = ep.info?.movie_image;
    if (xtreamImage) return xtreamImage;
    return posterFallback;
  };

  const getTmdbEpisodeInfo = (episodeNum: number) => tmdbSeasonEpisodes[episodeNum];

  // Season dropdown options for NyxDropdown
  const seasonOptions = useMemo(
    () => seasonNumbers.map(num => ({ value: String(num), label: t('select_season', { num }) })),
    [seasonNumbers, t],
  );

  // Source versions for SourceSelector
  const sourceVersions = useMemo(
    () => groupedVersions.map(v => ({ id: Number(v.series_id), name: v.name })),
    [groupedVersions],
  );

  // Télécommande : focus sur le premier épisode (OK = lecture), retour sur la carte d'origine
  const tv = isTv();
  // TV : le synopsis est une zone sélectionnable seulement s'il est coupé (`data-nav-scroll`) ; ailleurs, un simple paragraphe
  const synopsis = (text: React.ReactNode) =>
    tv ? (
      <div className="synopsis-container scrollbar-thin" data-nav-scroll tabIndex={0}>
        {text}
      </div>
    ) : (
      text
    );
  const sourceSelector = (
    <SourceSelector
      versions={sourceVersions}
      selectedId={Number(series.series_id)}
      onSelect={(version) => void handleSourceChange(version)}
    />
  );
  const pageRef = useRef<HTMLDivElement>(null);
  useTvPageFocus(
    pageRef,
    ['.episode-card-netflix', '#season-selector', '.watchlist-button'],
    loadingState !== 'loading' && !isEpisodesLoading && !!localEpisodes,
    initialSeries.series_id,
  );

  return (
    <div
      ref={pageRef}
      className={`series-detail-page state-${loadingState} ${isVisible ? 'is-visible' : ''}`}
      data-testid="series-detail"
      data-nav-layer="page"
    >
      {/* Stable Backdrop Background */}
      <div
        className="backdrop-bg"
        style={{
          backgroundImage: effectiveBackdropUrl ? `url(${effectiveBackdropUrl})` : 'none',
        }}
      />

      {/* Content Overlay */}
      <div className="content-overlay">
        <button className="back-button" onClick={onBack} title={t('back')} data-testid="series-detail-back">
          <svg
            width="40"
            height="40"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="3.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M16 20l-8-8 8-8" />
          </svg>
        </button>

        <div className="detail-layout">
          <div className="info-column">
            {/* Layer 1: Skeleton (visible only during loading) */}
            <div
              className={`content-layer skeleton-layer ${loadingState === 'loading' ? 'active' : 'hidden'}`}
            >
              <SeriesSkeleton />
            </div>

            {/* Layer 2: Real Content (TMDB or Fallback) */}
            <div
              className={`content-layer main-layer ${loadingState !== 'loading' ? 'active' : 'hidden'}`}
            >
              {logoUrl ? (
                <img src={logoUrl} className="detail-logo" alt={title} draggable={false} data-testid="series-detail-logo" />
              ) : (
                <h1 className="series-title" data-testid="series-detail-title">{title}</h1>
              )}

              <div className="badges-row">
                <span className="badge"><svg width="14" height="14" viewBox="0 0 188.49 179.27" fill="currentColor" aria-hidden="true" style={{verticalAlign: 'middle', marginRight: '0.25rem'}}><path d="M152.49,179.27l-58.25-32.96-58.25,32.96,13.34-65.58L0,68.47l66.49-7.58L94.25,0l27.75,60.9,66.49,7.58-49.34,45.21,13.34,65.58ZM94.25,123.33l29.9,16.92-6.85-33.66,25.33-23.21-34.13-3.89-14.25-31.26-14.25,31.26-34.13,3.89,25.33,23.21-6.85,33.66,29.9-16.92Z"/></svg>{t('series_label')}</span>
                {numberOfSeasons > 0 && (
                  <span className="badge">
                    {t(numberOfSeasons > 1 ? 'season_count_plural' : 'season_count', { count: numberOfSeasons })}
                  </span>
                )}
                {year && <span className="badge">{year}</span>}
                {status && <span className="badge">{status}</span>}
                {rating && (
                  <span className="badge rating">
                    <span className="stars">{renderStars(details?.vote_average || 0)}</span>
                    {rating}
                  </span>
                )}
              </div>

              {loadingState === 'ready' && (
                <>
                  {genres && <div className="genres">{genres}</div>}
                  {synopsis(<p className="synopsis">{overview}</p>)}
                  {cast && (
                    <div className="casting">
                      <span className="label">{t('casting')}</span> {cast}
                    </div>
                  )}
                </>
              )}

              {loadingState === 'fallback' && (
                synopsis(<p className="synopsis">{t('tmdb_unavailable')}</p>)
              )}

              {/* Season Dropdown Selector */}
              {seasonNumbers.length > 0 && (
                <div className="season-selector" data-nav-row="series-season" data-testid="series-detail-season-bar">
                  <NyxDropdown
                    value={String(selectedSeason)}
                    onChange={(val) => setSelectedSeason(Number(val))}
                    options={seasonOptions}
                    id="season-selector"
                    testId="series-detail-season"
                  />
                  <span className="episode-count">
                    {t(currentEpisodes.length > 1 ? 'episode_count_plural' : 'episode_count', { count: currentEpisodes.length })}
                  </span>

                  {/* Resume the episode the viewer stopped in */}
                  {resumeEpisode && resumeInfo && (
                    <button
                      type="button"
                      className="resume-episode-btn"
                      data-testid="series-detail-resume"
                      onClick={() => playEpisode(resumeEpisode)}
                    >
                      <span aria-hidden="true">▶</span>
                      {t('resume_episode', {
                        season: selectedSeason,
                        episode: resumeEpisode.episode_num || 1,
                        time: formatResumeTime(resumeInfo.timeSeconds),
                      })}
                      <i className="resume-episode-bar" aria-hidden="true" style={{ width: `${Math.min(100, resumeInfo.progressPercent)}%` }} />
                    </button>
                  )}

                  {/* Watchlist Button */}
                  <WatchlistButton
                    isAdded={inWatchlist}
                    size="md"
                    title={inWatchlist ? t('remove_from_watchlist') : t('add_to_watchlist')}
                    className="watchlist-button"
                    testId="series-detail-watchlist"
                    onClick={(e) => {
                      e.stopPropagation();
                      const streamId = Number(series?.series_id);
                      // Échec : message affiché, le bouton garde l'état enregistré
                      void toggleWatchlistOrNotify(streamId, tmdbId || 0, 'series').then((newState) => {
                        if (newState !== null) setInWatchlist(newState);
                      });
                    }}
                  />

                  {!tv && sourceSelector}

                  {/* Reset Season Button */}
                  {(devOverrides.forceProgress || currentEpisodes.some(ep => ep.id && episodeProgress.has(Number(ep.id)))) && (
                    <button
                      className="reset-season-btn"
                      data-testid="series-detail-reset-season"
                      aria-label={t('reset_season_tooltip')}
                      data-tip={t('reset_season_tooltip')}
                      onClick={() => {
                        const episodeIds = currentEpisodes.map(ep => ep.id || ep.title).filter(Boolean);
                        clearMultipleProgress(episodeIds as (string | number)[]).catch(warnOnReject('SeriesDetail'));
                        setResetKey(prev => prev + 1);
                        setShowResetToast(true);
                        setTimeout(() => setShowResetToast(false), 3000);
                      }}
                    >
                      <svg width="14" height="14" viewBox="0 0 192.49 171.14" fill="currentColor" aria-hidden="true" style={{verticalAlign: 'middle'}}><path d="M105.53,171.05c.45.06.92.09,1.39.09,60.32,0,106.26-62.73,76.01-126.37-7.32-15.4-19.77-27.86-35.17-35.19C84.47-20.52,22.13,24.71,21.38,84.5H0l32.72,31.05,32.72-31.05h-23.06c.76-45.82,49.45-80.19,98.01-54.95,9.73,5.06,17.67,13.08,22.7,22.83,25.41,49.33-10.61,98.75-57.56,97.74v20.93Z"/></svg> {t('reset_season_label')}
                    </button>
                  )}
                </div>
              )}

              {/* TV : la source a son propre étage, sous les saisons (Haut/Bas). Ailleurs, elle reste dans la ligne des saisons. */}
              {tv && seasonNumbers.length > 0 && sourceVersions.length > 1 && (
                <div className="source-row" data-nav-row="series-source">
                  {sourceSelector}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Carousel Wrapper */}
        <div className="carousel-wrapper">
          {/* Repli (fiche TMDB absente ou inconnue) : épisodes du fournisseur, pas de squelette sans fin */}
          {loadingState === 'loading' || isEpisodesLoading || !localEpisodes ? (
            <SeriesCarouselSkeleton />
          ) : currentEpisodes.length === 0 ? (
            <div className="empty-season-message" data-testid="series-detail-no-episodes">
              <p>{t('no_episodes')}</p>
            </div>
          ) : (
            // Fondu d'entrée en CSS (SeriesDetailPage.css), rejoué à chaque saison grâce à la clé
            <div key={selectedSeason} className="episodes-carousel-container episodes-carousel-container--enter">
              <div
                className={`episodes-carousel ${isDragging ? 'grabbing' : ''}`}
                data-testid="series-detail-episodes"
                data-nav-row
                ref={carouselRef}
                onMouseDown={handleMouseDown}
              >
                {currentEpisodes.map((ep: XtreamEpisode) => {
                  const episodeNum = ep.episode_num || 1;
                  const progress = devOverrides.forceProgress
                    // eslint-disable-next-line react-hooks/purity -- forçage du DevPanel (développement) : progression factice
                    ? 45 + Math.random() * 50
                    : (ep.id ? (episodeProgress.get(Number(ep.id))?.progressPercent ?? 0) : 0);
                  const episodeImage = getEpisodeImage(ep, episodeNum) || '';
                  const tmdbEp = getTmdbEpisodeInfo(episodeNum);

                  return (
                    <EpisodeCard
                      key={`${ep.id || ep.episode_num}-${resetKey}`}
                      episode={ep}
                      episodeNum={episodeNum}
                      tmdbEpisode={devOverrides.forceNoEpisodeSynopsis ? (tmdbEp ? { ...tmdbEp, overview: null } : tmdbEp) : tmdbEp}
                      imageUrl={episodeImage}
                      posterFallback={posterFallback}
                      progress={progress}
                      dragStarted={dragStarted}
                      tmdbLoading={devOverrides.forceSeasonLoading || isSeasonLoading}
                      onPlay={playEpisode}
                      onProgressReset={() => {
                        setShowResetToast(true);
                        setTimeout(() => setShowResetToast(false), 3000);
                      }}
                    />
                  );
                })}
              </div>
            </div>
          )}
        </div>
    </div>

      {showResetToast && (
        <div className="detail-toast">{t('progress_reset_success')}</div>
      )}
    </div>
  );
};

export default SeriesDetailPage;
