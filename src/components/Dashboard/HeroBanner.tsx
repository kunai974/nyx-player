import './HeroBanner.css';
import infoIcon from '../../assets/icons/info.svg';
import { useTranslation } from 'react-i18next';
import { useState, useEffect, useCallback, useRef } from 'react';
import { isInWatchlist, onWatchlistChange } from '../../services/watchlistHydration';
import WatchlistButton from '../Common/WatchlistButton';
import WelcomeSlideshow from './WelcomeSlideshow';
import type { LatestBackdrop } from '../../hooks/useLatestBackdrops';

// Re-export for backward compatibility
export type { HeroMovie } from '../../types/dashboard';
import type { HeroMovie } from '../../types/dashboard';
import { warnOnReject } from '../../utils/warnOnReject';
import { isTv } from '../../utils/platform';
import { createLogger } from '../../utils/logger';

const log = createLogger('HeroBanner');


/** Distance minimale d'un balayage horizontal pour changer de contenu */
const SWIPE_MIN_PX = 40;

/** Photo de fond non reçue : nouveaux essais après ces délais (ms). */
const BACKDROP_RETRY_DELAYS_MS = [2000, 5000];
/** Au-delà, la photo est affichée quand même : le navigateur termine le chargement du fond. */
const BACKDROP_GIVE_UP_MS = 12000;
/** Photos déjà reçues dans cette session : leur retour dans la rotation est instantané. */
const loadedBackdrops = new Set<string>();

interface HeroBannerProps<T = unknown> {
  movie: HeroMovie<T> | null;
  onPlay: () => void;
  onInfo: () => void;
  onToggleWatchlist: () => void;
  loading?: boolean;
  isFading?: boolean;
  totalSlides?: number;
  currentIndex?: number;
  onDotClick?: (index: number) => void;
  /** Bannière tenue (souris dessus, ou focus de la télécommande dedans) ou relâchée : pause de la rotation. */
  onHoldChange?: (held: boolean) => void;
  /** Welcome slideshow (no featured title): is this title in the catalogue, and how to play it */
  welcomeIsAvailable?: (slide: LatestBackdrop) => boolean;
  onWelcomePlay?: (slide: LatestBackdrop) => void;
}

const HeroBanner = <T,>({
  movie,
  onPlay,
  onInfo,
  onToggleWatchlist,
  loading = false,
  isFading = false,
  totalSlides = 0,
  currentIndex = 0,
  onDotClick,
  onHoldChange,
  welcomeIsAvailable,
  onWelcomePlay,
}: HeroBannerProps<T>) => {
  const { t } = useTranslation(['dashboard', 'common']);

  // =========================================================================
  // TENUE — rotation en pause tant que l'on est sur la bannière
  // =========================================================================
  // Souris (pas le toucher : un tapotement émet un survol sans jamais le quitter), ou focus de la
  // télécommande. Le focus seul ne compte qu'en TV : sur le bureau, un bouton cliqué garde le focus et
  // la bannière ne repartirait plus.
  const onHoldChangeRef = useRef(onHoldChange);
  useEffect(() => { onHoldChangeRef.current = onHoldChange; }, [onHoldChange]);
  const hover = useRef(false);
  const focusWithin = useRef(false);
  const updateHold = () => onHoldChangeRef.current?.(hover.current || focusWithin.current);
  const handlePointerEnter = (e: React.PointerEvent) => {
    if (e.pointerType !== 'mouse') return;
    hover.current = true;
    updateHold();
  };
  const handlePointerLeave = (e: React.PointerEvent) => {
    if (e.pointerType !== 'mouse') return;
    hover.current = false;
    updateHold();
  };
  const handleFocus = () => {
    if (!isTv()) return;
    focusWithin.current = true;
    updateHold();
  };
  const handleBlur = (e: React.FocusEvent<HTMLElement>) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    focusWithin.current = false;
    updateHold();
  };
  // Bannière remplacée (chargement, accueil sans film) ou démontée en étant tenue : ni la sortie de la
  // souris ni la perte du focus ne seront vues, la tenue est relâchée tout de suite (sinon la rotation
  // resterait bloquée après un rechargement de l'accueil)
  const shown = !loading && !!movie;
  useEffect(() => {
    if (shown) return undefined;
    if (hover.current || focusWithin.current) {
      hover.current = false;
      focusWithin.current = false;
      onHoldChangeRef.current?.(false);
    }
    return undefined;
  }, [shown]);
  useEffect(() => () => { if (hover.current || focusWithin.current) onHoldChangeRef.current?.(false); }, []);

  // =========================================================================
  // BALAYAGE (tactile) — viser les points est trop précis au doigt
  // =========================================================================
  const swipeStart = useRef<{ x: number; y: number } | null>(null);

  const handleTouchStart = (e: React.TouchEvent) => {
    const touch = e.touches[0];
    swipeStart.current = touch ? { x: touch.clientX, y: touch.clientY } : null;
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    const start = swipeStart.current;
    const touch = e.changedTouches[0];
    swipeStart.current = null;
    if (!start || !touch || totalSlides <= 1 || !onDotClick) return;

    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    // Horizontal franc uniquement : le défilement vertical de la page reste prioritaire
    if (Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dx) <= Math.abs(dy)) return;

    const next = dx < 0 ? currentIndex + 1 : currentIndex - 1;
    onDotClick((next + totalSlides) % totalSlides);
  };

  // Async watchlist state
  const [inWatchlistAsync, setInWatchlistAsync] = useState<boolean>(false);

  // =========================================================================
  // BACKDROP PRELOAD — fade in only when image is ready
  // =========================================================================
  const [backdropReady, setBackdropReady] = useState(false);
  const preloadedUrlRef = useRef<string | null>(null);

  // Échec ou lenteur du téléchargement (audit performance, fiche F9 : au premier lancement, la bannière
  // restait parfois sans photo pour de bon, seul « reçue » était prévu) : nouveaux essais, puis affichage
  // quand même au bout de BACKDROP_GIVE_UP_MS (le navigateur finit de charger le fond lui-même).
  useEffect(() => {
    const url = movie?.backdropUrl;
    if (!url) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- état du préchargement de la photo (ressource externe) remis à zéro quand le film n'en a pas
      setBackdropReady(false);
      preloadedUrlRef.current = null;
      return;
    }
    // Already preloaded this URL
    if (url === preloadedUrlRef.current) return;
    if (loadedBackdrops.has(url)) {
      preloadedUrlRef.current = url;
      setBackdropReady(true);
      return;
    }

    setBackdropReady(false);
    let settled = false;
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const img = new Image();
    const show = () => {
      if (settled) return;
      settled = true;
      clearTimeout(retryTimer);
      clearTimeout(giveUpTimer);
      preloadedUrlRef.current = url;
      setBackdropReady(true);
    };
    img.onload = () => {
      loadedBackdrops.add(url);
      show();
    };
    img.onerror = () => {
      if (settled) return;
      const delay = BACKDROP_RETRY_DELAYS_MS[attempt];
      attempt += 1;
      log.warn(`Photo de fond non reçue (essai ${attempt})`);
      if (delay === undefined) show();
      else retryTimer = setTimeout(() => { img.src = url; }, delay);
    };
    const giveUpTimer = setTimeout(show, BACKDROP_GIVE_UP_MS);
    img.src = url;
    return () => {
      settled = true;
      clearTimeout(retryTimer);
      clearTimeout(giveUpTimer);
      img.onload = null;
      img.onerror = null;
    };
  }, [movie?.backdropUrl]);

  // Function to reload watchlist status
  const movieId = movie?.id;
  const movieTmdbId = movie?.tmdbId;
  const reloadWatchlistStatus = useCallback(() => {
    const tmdbId = movieTmdbId ?? 0;
    const streamId = Number(movieId) || 0;
    if (tmdbId > 0 || streamId > 0) {
      isInWatchlist(streamId, tmdbId, 'movie').then(setInWatchlistAsync).catch(warnOnReject('HeroBanner'));
    }
  }, [movieId, movieTmdbId]);

  // Load watchlist status when movie changes
  useEffect(() => {
    reloadWatchlistStatus();
  }, [reloadWatchlistStatus]);

  // Subscribe to watchlist changes from other components
  useEffect(() => {
    return onWatchlistChange(reloadWatchlistStatus);
  }, [reloadWatchlistStatus]);

  // Handle toggle with optimistic update
  const handleToggleWatchlist = () => {
    setInWatchlistAsync((prev) => !prev); // Optimistic update
    onToggleWatchlist();
  };

  // Use async state (overrides movie.inWatchlist if set)
  const isItemInWatchlist = inWatchlistAsync;

  if (loading) {
    return (
      <div className="hero-banner skeleton" data-nav-top data-testid="hero-banner-loading">
        <div className="hero-overlay">
          <div className="hero-content">
            <div className="skeleton-text title" />
            <div className="skeleton-text meta" />
            <div className="skeleton-text overview" />
            <div className="hero-buttons" data-nav-row>
              <div className="skeleton-btn" />
              <div className="skeleton-btn" />
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!movie) {
    return (
      <div className="hero-banner fallback" data-nav-top data-testid="hero-banner-welcome">
        <WelcomeSlideshow isAvailable={welcomeIsAvailable} onPlayTitle={onWelcomePlay} />
        <div className="hero-overlay">
          <div className="hero-content">
            <h1 className="hero-title">{t('hero_welcome_title')}</h1>
            <p className="hero-overview">{t('hero_welcome_subtitle')}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`hero-banner ${isFading || !backdropReady ? 'fading' : ''}`}
      data-nav-top
      data-testid="hero-banner"
      style={backdropReady ? { backgroundImage: `url(${movie.backdropUrl})` } : undefined}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
      onFocus={handleFocus}
      onBlur={handleBlur}
    >
      <div className="hero-overlay">
        <div className="hero-content">
          {movie.logoUrl ? (
            <img src={movie.logoUrl} alt={movie.title} className="hero-logo" />
          ) : (
            <h1 className="hero-title">{movie.title}</h1>
          )}

          <div className="hero-meta">
            {movie.rating && (
              <span className="match-score">{t('recommended_score', { score: Math.round(movie.rating * 10) })}</span>
            )}
            {movie.year && <span className="year">{movie.year}</span>}
            {movie.duration && <span className="duration">{movie.duration}</span>}
            <span className="quality-badge">{t('quality_badge_hd')}</span>
          </div>

          <p className="hero-overview">{movie.overview}</p>

          <div className="hero-buttons" data-nav-row data-nav-cols="banner">
            <button className="btn-hero-play" onClick={onPlay} data-testid="hero-play">
              <span className="hero-btn-icon">▶</span> {t('play')}
            </button>
            <button className="btn-hero-info" onClick={onInfo} data-testid="hero-info">
              <img src={infoIcon} alt="" className="hero-btn-icon info-svg" /> {t('more_info')}
            </button>
            <WatchlistButton
              isAdded={isItemInWatchlist}
              onClick={(e) => {
                e.stopPropagation();
                handleToggleWatchlist();
              }}
              size="md"
              title={isItemInWatchlist ? t('remove_from_watchlist') : t('add_to_watchlist')}
              className="btn-hero-watchlist"
              testId="hero-watchlist"
            />
          </div>
        </div>
      </div>

      {/* Points : étage à part, atteint par Droite depuis la fin d'une rangée de la bannière ; Haut mène aux boutons, Bas à Suggestions / Films / Séries */}
      {totalSlides > 1 && (
        <div className="hero-dots" data-nav-row="hero-dots">
          {Array.from({ length: totalSlides }, (_, i) => (
            <button
              key={i}
              className={`hero-dot ${i === currentIndex ? 'active' : ''}`}
              data-testid="hero-dot"
              data-nav-lateral-only
              onClick={() => onDotClick?.(i)}
              aria-label={t('common:slide_n', { n: i + 1 })}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export default HeroBanner;
