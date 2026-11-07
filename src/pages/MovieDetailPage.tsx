import React, { useEffect, useState, useMemo, useRef } from 'react';
import tmdb from '../services/tmdbApi';
import { toggleWatchlistOrNotify } from '../services/watchlistActions';
import WatchlistButton from '../components/Common/WatchlistButton';
import { getAllVersionsByTmdb } from '../utils/lightIndexHelpers';
import type { XtreamMovie } from '../types/xtream';
import type { LightIndexes } from '../types/lightIndex';
import { useTmdbMovie } from '../hooks/useTmdbMovie';
import { useBackdropUrl } from '../hooks/useBackdropUrl';
import { useMovieSourceSelection } from '../hooks/useMovieSourceSelection';
import MovieSkeleton from '../components/Skeletons/MovieSkeleton';
import ContentCarousel from '../components/Lists/ContentCarousel';
import SourceSelector from '../components/Detail/SourceSelector';
import TrailerCard from '../components/Detail/TrailerCard';
import { renderStars } from '../components/Detail/StarRating';
import { clearProgress } from '../services/playbackProgressService';
import { usePlayer } from '../contexts/PlayerContext';
import { useDevOverrides } from '../contexts/DevOverrideContext';
import { useTranslation } from 'react-i18next';
import { getTmdbLanguage } from '../utils/tmdbLanguage';
import { pickBestLogo } from '../utils/tmdbLogoHelper';
import { useTvPageFocus } from '../hooks/useTvPageFocus';
import { isTv } from '../utils/platform';
import './MovieDetailPage.css';
import { linkTitlesByName, mostlyWithoutTmdb } from '../services/titleTmdbLinks';
import { warnOnReject } from '../utils/warnOnReject';
import { showAppNotice } from '../utils/appNotice';

// Constants
const MAX_SIMILAR_MOVIES = 20;

// Similar movie with TMDB poster info (simplified - uses streamId for navigation)
interface SimilarMovie {
  streamId: number; // For navigation (lightIndexes id)
  tmdbId: number;
  posterPath: string; // Required - we filter out movies without poster
  originalTitle: string;
}

interface MovieDetailPageProps {
  tmdbId: number;
  versions: XtreamMovie[];
  lightIndexes?: LightIndexes; // RAM-optimized: use lightIndexes for similar movies
  onBack: () => void;
  onNavigateToMovie?: (tmdbId: number, streamId: number) => void; // For similar movies
  /** Callback pour charger une source à la demande (JIT re-hydration) */
  onLoadVersion?: (streamId: number) => Promise<XtreamMovie | null>;
  replayEntrance?: boolean;
}

const MovieDetailPage: React.FC<MovieDetailPageProps> = ({
  tmdbId: initialTmdbId,
  versions: initialVersions,
  lightIndexes,
  onBack,
  onNavigateToMovie,
  onLoadVersion,
  replayEntrance,
}) => {
  const { t } = useTranslation('details');
  const { play } = usePlayer();
  const { overrides, setActivePage } = useDevOverrides();
  const mdOverrides = overrides.movieDetailPage;
  // Stable base item for identification
  const baseItem = initialVersions[0];

  // --- Logic Layer: TMDB Hook ---
  const { details, resolvedTmdbId, loadingState: rawLoadingState } = useTmdbMovie(baseItem, initialTmdbId);

  // --- DevPanel override: loadingState ---
  const loadingState = mdOverrides.forceLoadingState ?? rawLoadingState;

  // --- Detect active page for DevPanel ---
  useEffect(() => {
    setActivePage('MovieDetailPage');
  }, [setActivePage]);

  // Numéro trouvé par le titre après l'ouverture (recherche plus longue que l'attente de
  // useContentNavigation) : les autres versions du même titre rejoignent la fiche
  const versionsWithTitleLinks = useMemo<XtreamMovie[]>(() => {
    if (!lightIndexes || resolvedTmdbId <= 0 || initialTmdbId > 0) return initialVersions;
    const shown = new Set(initialVersions.map((v) => Number(v.stream_id)));
    const extra = getAllVersionsByTmdb(lightIndexes, resolvedTmdbId, 'movie')
      .filter((lv) => !shown.has(lv.id))
      .map((lv) => ({
        stream_id: lv.id,
        name: lv.name,
        tmdb: resolvedTmdbId,
        container_extension: lv.containerExt || undefined,
      } as unknown as XtreamMovie));
    return extra.length > 0 ? [...initialVersions, ...extra] : initialVersions;
  }, [initialVersions, initialTmdbId, lightIndexes, resolvedTmdbId]);

  // --- Logic Layer: Source Selection Hook ---
  const {
    selectedVersion,
    inWatchlist,
    setInWatchlist,
    hasMovieProgress,
    setHasMovieProgress,
    displayVersions,
    handleVersionSelect,
  } = useMovieSourceSelection({
    initialVersions: versionsWithTitleLinks,
    resolvedTmdbId,
    onLoadVersion,
  });

  // --- Derived Data ---
  const xtreamItem = selectedVersion || initialVersions[0];

  // Similar Movies (Derived via useMemo - uses lightIndexes.moviesByTmdb)
  const recommendations = details?.recommendations?.results;
  const moviesByTmdb = lightIndexes?.moviesByTmdb;
  // Catalogue sans numéros TMDB : les similaires choisis par TMDB sont cherchés par leurs titres dans le
  // catalogue (en local, titre exact et année), puis la rangée se recalcule
  const [similarLinks, setSimilarLinks] = useState(0);
  useEffect(() => {
    if (!lightIndexes || !recommendations?.length || !mostlyWithoutTmdb(lightIndexes)) return;
    let cancelled = false;
    const titles = recommendations.flatMap((rec) => {
      const names = [rec.title, rec.original_title].filter((t): t is string => !!t);
      const year = Number.parseInt((rec.release_date ?? '').slice(0, 4), 10);
      return names.length > 0 ? [{ kind: 'movie' as const, tmdbId: rec.id, titles: names, ...(year ? { year } : {}) }] : [];
    });
    // Un peu après l'ouverture : la comparaison parcourt tout le catalogue, la fiche s'affiche d'abord
    const timer = setTimeout(() => {
      void linkTitlesByName(lightIndexes, titles, () => !cancelled).then((n) => {
        if (n > 0 && !cancelled) setSimilarLinks((v) => v + 1);
      });
    }, 1500);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [lightIndexes, recommendations]);
  const similarMovies = useMemo(() => {
    if (!recommendations || recommendations.length === 0) return [];
    if (!moviesByTmdb || moviesByTmdb.size === 0) return [];

    const foundMovies: SimilarMovie[] = [];

    for (const rec of recommendations) {
      if (foundMovies.length >= MAX_SIMILAR_MOVIES) break;
      if (!rec.poster_path) continue;  // Skip if no poster

      // Lookup in lightIndexes (O(1))
      const lightMovie = moviesByTmdb.get(rec.id);
      if (lightMovie) {
        foundMovies.push({
          streamId: lightMovie.id,
          tmdbId: rec.id,
          posterPath: rec.poster_path,
          originalTitle: rec.original_title || rec.title || lightMovie.name,
        });
      }
    }
    return foundMovies;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- similarLinks relance le calcul quand des similaires sont reliés (catalogue modifié sur place)
  }, [recommendations, moviesByTmdb, similarLinks]);

  // --- UI States ---
  const [isVisible, setIsVisible] = useState(false);
  const [showResetToast, setShowResetToast] = useState(false);

  // Handle initial entrance animation
  useEffect(() => {
    const visTimer = setTimeout(() => setIsVisible(true), 10);
    return () => { clearTimeout(visTimer); };
  }, []);

  // Replay entrance animation when returning from video
  useEffect(() => {
    if (replayEntrance) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- animation d'entrée rejouée au retour de la vidéo (masquée puis réaffichée)
      setIsVisible(false);
      const visTimer = setTimeout(() => setIsVisible(true), 50);
      return () => { clearTimeout(visTimer); };
    }
  }, [replayEntrance]);



  // --- UI Data Calculation ---
  const title = details?.title || xtreamItem?.name || t('movie_label');
  const overview = details?.overview || t('synopsis_unavailable');
  
  const userLang = getTmdbLanguage() === 'fr-FR' ? 'fr' : 'en';
  const logoUrl = pickBestLogo(details?.images, userLang);

  // Backdrop via shared hook
  const [backdropIndex] = useState(() => Math.floor(Math.random() * 5));
  const rawBackdropUrl = useBackdropUrl(
    details,
    Array.isArray(xtreamItem?.backdrop_path) ? xtreamItem.backdrop_path : undefined,
    xtreamItem?.stream_icon || '',
    backdropIndex,
  );
  const backdropUrl = mdOverrides.forceNoBackdrop ? '' : rawBackdropUrl;

  const year = details?.release_date?.split('-')[0] || '';
  const duration = details?.runtime
    ? `${Math.floor(details.runtime / 60)}h${details.runtime % 60}min`
    : '';
  const rating = details?.vote_average?.toFixed(1) || '';
  const genres = details?.genres?.map((g) => g.name).join(', ') || '';
  const cast =
    details?.credits?.cast
      ?.slice(0, 6)
      .map((c) => c.name)
      .join(', ') || '';
  // Télécommande : focus sur Lecture à l'ouverture, retour sur la carte d'origine à la fermeture
  const tv = isTv();
  const pageRef = useRef<HTMLDivElement>(null);
  useTvPageFocus(pageRef, ['.action-buttons .btn-primary'], loadingState !== 'loading', initialTmdbId);

  const trailer = mdOverrides.forceNoTrailer ? undefined : details?.videos?.results?.find(
    (v) => v.type === 'Trailer' && v.site === 'YouTube'
  );

  return (
    <div
      ref={pageRef}
      className={`movie-detail-page scrollbar-thin state-${loadingState} ${isVisible ? 'is-visible' : ''}`}
      data-testid="movie-detail"
      data-nav-layer="page"
    >
      {/* Stable Backdrop Background */}
      <div
        className="backdrop-bg"
        style={{
          backgroundImage: backdropUrl ? `url(${backdropUrl})` : 'none',
        }}
      />

      {/* Content Overlay */}
      <div className="content-overlay">
        <button className="back-button" onClick={onBack} title={t('back')} data-testid="movie-detail-back">
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
            {/* Layer 1: Skeleton - always in DOM, visibility controlled by CSS */}
            <div className={`skeleton-layer ${loadingState === 'loading' ? '' : 'hidden'}`}>
              <MovieSkeleton />
            </div>

            {/* Layer 2: Content - always in DOM, visibility controlled by CSS */}
            <div className={`main-layer ${loadingState !== 'loading' ? 'active' : ''}`}>
              {logoUrl ? (
                <img src={logoUrl} className="detail-logo" alt={title} draggable={false} data-testid="movie-detail-logo" />
              ) : (
                <h1 className="movie-title" data-testid="movie-detail-title">{title}</h1>
              )}

              <div className="badges-row">
                <span className="badge"><svg className="badge-icon" viewBox="0 0 194.26 197.44" fill="currentColor" aria-hidden="true"><path d="M194.26,21.83l-55.7-7.07-2.69,21.16-60.57-7.69,2.69-21.16L22.3,0l-6.16,48.54-4.98,39.26-4.98,39.26L0,175.61l55.7,7.07,2.69-21.16,60.57,7.69-2.69,21.16,55.7,7.07,6.16-48.55,4.98-39.26,4.98-39.26,6.16-48.54ZM165.72,97.99l-18.55-2.36,2.63-20.69,18.55,2.36-2.63,20.69ZM144.81,114.21l18.55,2.36-2.63,20.69-18.55-2.36,2.63-20.69ZM154.78,35.69l18.55,2.36-2.63,20.69-18.55-2.36,2.63-20.69ZM49.45,83.23l-18.55-2.36,2.63-20.69,18.55,2.36-2.63,20.69ZM28.54,99.45l18.55,2.36-2.63,20.69-18.55-2.36,2.63-20.69ZM38.51,20.93l18.55,2.36-2.63,20.69-18.55-2.36,2.63-20.69ZM39.48,161.75l-18.55-2.36,2.63-20.69,18.55,2.36-2.63,20.69ZM60.74,142.94l1.12-8.81,4.98-39.26,4.98-39.26,1.12-8.81,60.57,7.69-1.12,8.81-4.98,39.26-4.98,39.26-1.12,8.81-60.57-7.69ZM155.75,176.51l-18.55-2.36,2.63-20.69,18.55,2.36-2.63,20.69Z"/></svg> {t('movie_label')}</span>
                {duration && <span className="badge">{duration}</span>}
                {year && <span className="badge">{year}</span>}
                {details?.adult && <span className="badge age">{t('badge_adult')}</span>}
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
                  <div className="synopsis-container scrollbar-thin" data-nav-scroll tabIndex={tv ? 0 : undefined}>
                    <p className="synopsis">{overview}</p>
                  </div>
                  {cast && (
                    <div className="casting">
                      <span className="label">{t('casting')}</span> {cast}
                    </div>
                  )}
                </>
              )}

              {loadingState === 'fallback' && (
                <div className="synopsis-container scrollbar-thin" data-nav-scroll tabIndex={tv ? 0 : undefined}>
                  <p className="synopsis">
                    {t('tmdb_unavailable')}
                  </p>
                </div>
              )}

              <div className="action-buttons" data-nav-row>
                <button
                  className="btn-primary"
                  data-testid="movie-detail-play"
                  onClick={() => {
                    if (!selectedVersion) return;
                    void play(selectedVersion, undefined, undefined, {
                      tmdbTitle: details?.title,
                      tmdbId: resolvedTmdbId || undefined,
                      posterUrl: details?.poster_path
                        ? tmdb.imageUrl(details.poster_path, 'w500') || undefined
                        : undefined,
                    });
                  }}
                >
                  <span>▶</span> {t('play')}
                </button>

                <WatchlistButton
                  isAdded={inWatchlist}
                  size="md"
                  title={inWatchlist ? t('remove_from_watchlist') : t('add_to_watchlist')}
                  className="watchlist-button"
                  testId="movie-detail-watchlist"
                  onClick={(e) => {
                    e.stopPropagation();
                    const itemId = resolvedTmdbId || (baseItem?.stream_id as number);
                    if (!itemId) return;
                    const streamId = baseItem?.stream_id as number;
                    // Échec : message affiché, le bouton garde l'état enregistré
                    void toggleWatchlistOrNotify(streamId, resolvedTmdbId || 0, 'movie').then((newState) => {
                      if (newState !== null) setInWatchlist(newState);
                    });
                  }}
                />

                {/* Source Selector — composant partagé */}
                {selectedVersion && (
                  <SourceSelector
                    versions={displayVersions}
                    selectedId={Number(selectedVersion.stream_id)}
                    onSelect={(version) => void handleVersionSelect(version)}
                    className="version-selector"
                  />
                )}

                {/* Reset progress — action button */}
                {(mdOverrides.forceProgress || hasMovieProgress) && selectedVersion && (
                  <button
                    className="reset-progress-btn"
                    data-testid="movie-detail-reset-progress"
                    title={t('reset_progress')}
                    onClick={() => {
                      clearProgress(selectedVersion.stream_id).then(() => {
                        setHasMovieProgress(false);
                        setShowResetToast(true);
                        setTimeout(() => setShowResetToast(false), 3000);
                      }).catch((err) => {
                        warnOnReject('MovieDetail')(err);
                        showAppNotice('progress_reset_failed');
                      });
                    }}
                  >
                    <svg className="reset-icon" viewBox="0 0 192.49 171.14" fill="currentColor" aria-hidden="true"><path d="M105.53,171.05c.45.06.92.09,1.39.09,60.32,0,106.26-62.73,76.01-126.37-7.32-15.4-19.77-27.86-35.17-35.19C84.47-20.52,22.13,24.71,21.38,84.5H0l32.72,31.05,32.72-31.05h-23.06c.76-45.82,49.45-80.19,98.01-54.95,9.73,5.06,17.67,13.08,22.7,22.83,25.41,49.33-10.61,98.75-57.56,97.74v20.93Z"/></svg>
                  </button>
                )}
              </div>

              {/* Trailer Card */}
              {trailer && (
                <TrailerCard trailerKey={trailer.key} backdropUrl={backdropUrl} />
              )}
            </div>
          </div>
        </div>


        {/* Similar Movies Carousel (Reusable Component) */}
        <div className={`similar-movies-carousel-container ${loadingState !== 'loading' ? 'ready' : ''}`}>
          <ContentCarousel
            title={t('similar_movies')}
            loading={loadingState === 'loading'}
            items={
              similarMovies.length > 0 && !mdOverrides.forceNoSimilar
                ? similarMovies.map((movie) => {
                  const streamId = movie.streamId;
                  return {
                    id: streamId,
                    title: movie.originalTitle,
                    image: tmdb.imageUrl(movie.posterPath, 'w342') || '',
                    onClick: () =>
                      onNavigateToMovie && onNavigateToMovie(movie.tmdbId, movie.streamId),
                    mediaType: 'movie' as const,
                    tmdbId: movie.tmdbId,
                    streamId: streamId,
                  };
                })
                : []
            }
          />
        </div>
      </div>

      {showResetToast && (
        <div className="detail-toast">{t('progress_reset_success')}</div>
      )}
    </div>
  );
};

export default MovieDetailPage;
