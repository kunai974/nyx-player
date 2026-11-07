import React from 'react';
import { useTranslation } from 'react-i18next';
import { useAutoAnimate } from '@formkit/auto-animate/react';
import { getHydratedWatchlist, removeFromWatchlist, HydratedWatchlistItem, onWatchlistChange, getShownWatchlist, rememberShownWatchlist } from '../services/watchlistHydration';
import { onDetailsUpdate } from '../services/tmdbCacheSqlite';
import { getProgressByTmdbIds } from '../services/playbackProgressService';
import type { EpisodeProgressInfo } from '../services/playbackProgressService';
import { PLAYBACK_EVENT } from '../services/eventConstants';
import type { LightIndexes } from '../types/lightIndex';
import type { NavigateToContent, TabType } from '../types/navigation';
import { useDevOverrides } from '../contexts/DevOverrideContext';
import { devLog } from '../utils/devLog';
import { createLogger } from '../utils/logger';
import { showAppNotice } from '../utils/appNotice';
import filmIcon from '../assets/icons/film.svg';
import starIcon from '../assets/icons/star.svg';
import NyxButton from '../components/Common/NyxButton';
import WatchlistButton from '../components/Common/WatchlistButton';
import UnavailableTitleModal from '../components/Common/UnavailableTitleModal';
import { useTvLongPress } from '../hooks/useTvLongPress';
import { clickableProps } from '../utils/clickable';
import { isTv } from '../utils/platform';
import './WatchlistPage.css';

const log = createLogger('WatchlistPage');

interface WatchlistPageProps {
  onNavigateToContent: NavigateToContent;
  onNavigateToTab?: (tab: TabType) => void;
  lightIndexes: LightIndexes;
}

// ---- Mock data generator for DevPanel ----
function generateMockItems(count: number): HydratedWatchlistItem[] {
  const titles = [
    'The Shawshank Redemption', 'Inception', 'Interstellar', 'The Dark Knight',
    'Pulp Fiction', 'Fight Club', 'Forrest Gump', 'The Matrix', 'Goodfellas',
    'The Godfather', 'Breaking Bad', 'Stranger Things', 'The Witcher',
    'Game of Thrones', 'The Mandalorian', 'Dark', 'Money Heist',
    'Narcos', 'The Crown', 'Peaky Blinders', 'Vikings',
    'Westworld', 'Black Mirror', 'Ozark', 'Better Call Saul',
  ];
  return Array.from({ length: count }, (_, i) => ({
    stream_id: 90000 + i,
    tmdb_id: 10000 + i,
    type: (i % 3 === 0 ? 'series' : 'movie') as 'movie' | 'series',
    added_at: Date.now() - i * 86400000,
    name: titles[i % titles.length] + (i >= titles.length ? ` ${Math.floor(i / titles.length) + 1}` : ''),
    posterUrl: '',
    isOrphan: false,
  }));
}

// ---- Carte de la grille ----

interface WatchlistGridCardProps {
  item: HydratedWatchlistItem;
  progress: number;
  onOpen: () => void;
  onRemove: (e?: React.MouseEvent) => void;
}

/** Télécommande : la carte est un arrêt (OK ouvre), appui long = retirer de Ma liste. */
const WatchlistGridCard: React.FC<WatchlistGridCardProps> = ({ item, progress, onOpen, onRemove }) => {
  const { t } = useTranslation('navigation');
  const rootRef = React.useRef<HTMLDivElement>(null);
  const tvLongPress = useTvLongPress(rootRef, () => onRemove());

  return (
    <div
      ref={rootRef}
      className={`watchlist-card${item.isOrphan ? ' watchlist-card--unavailable' : ''}`}
      data-testid="watchlist-card"
      data-media-type={item.type}
      {...(isTv() ? clickableProps(onOpen) : {})}
      onClick={onOpen}
      {...tvLongPress.rootProps}
    >
      <div className="poster-container">
        <img
          src={item.posterUrl || undefined}
          alt={item.name || t('unknown_title')}
          onError={(e) => {
            (e.target as HTMLImageElement).src =
              'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300" viewBox="0 0 200 300"><rect fill="%231a1a1a" width="200" height="300"/><text fill="%23666" font-family="Arial" font-size="14" x="50%" y="50%" text-anchor="middle">No Image</text></svg>';
          }}
        />
        <div className="type-badge">
          {item.type === 'movie'
            ? <img src={filmIcon} alt="Film" />
            : <img src={starIcon} alt="Series" />
          }
        </div>

        {item.isOrphan && (
          <div className="unavailable-badge" data-testid="watchlist-card-unavailable">
            {t('unavailable_badge')}
          </div>
        )}

        <WatchlistButton
          isAdded={true}
          onClick={onRemove}
          size="sm"
          title={t('remove_from_list_tooltip')}
          className="card-watchlist-btn"
          testId="watchlist-card-remove"
          focusable={!tvLongPress.tv}
        />

        {progress > 0 && (
          <div className="watchlist-progress-bar">
            <div className="progress-fill" style={{ width: `${progress}%` }} />
          </div>
        )}
      </div>
      <div className="card-info">
        <span className="card-name">{item.name || t('unknown_title')}</span>
      </div>
    </div>
  );
};

// ---- Skeleton loading component ----
const SKELETON_COUNT = 8;

const WatchlistSkeleton: React.FC = () => (
  <div className="watchlist-skeleton-grid">
    {Array.from({ length: SKELETON_COUNT }, (_, i) => (
      <div key={i} className="watchlist-skeleton-card">
        <div className="watchlist-skeleton-card__poster" />
        <div className="watchlist-skeleton-card__info">
          <div className="watchlist-skeleton-card__title" style={{ width: `${60 + (i % 4) * 10}%` }} />
        </div>
      </div>
    ))}
  </div>
);

// ---- Empty state SVG icon ----
const EmptyListIcon: React.FC = () => (
  <svg className="watchlist-empty-state__icon" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="8" y="4" width="48" height="56" rx="4" stroke="currentColor" strokeWidth="2" fill="none" />
    <line x1="18" y1="18" x2="46" y2="18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity="0.6" />
    <line x1="18" y1="28" x2="40" y2="28" stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity="0.4" />
    <line x1="18" y1="38" x2="36" y2="38" stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity="0.3" />
    <circle cx="48" cy="48" r="14" fill="none" stroke="currentColor" strokeWidth="2" opacity="0.5" />
    <line x1="42" y1="48" x2="54" y2="48" stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity="0.5" />
    <line x1="48" y1="42" x2="48" y2="54" stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity="0.5" />
  </svg>
);

const WatchlistPage: React.FC<WatchlistPageProps> = ({
  onNavigateToContent,
  onNavigateToTab,
  lightIndexes,
}) => {
  const { t } = useTranslation('navigation');
  // Liste de la visite précédente, affichée tout de suite (sans cartes fantômes) puis relue
  const [initial] = React.useState(() => getShownWatchlist(lightIndexes));
  const [watchlist, setWatchlist] = React.useState<HydratedWatchlistItem[]>(initial?.items ?? []);
  const [progressMap, setProgressMap] = React.useState<Map<number, EpisodeProgressInfo>>(initial?.progress ?? new Map());
  const [isLoading, setIsLoading] = React.useState(!initial);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  // DevPanel overrides
  const { overrides, setActivePage } = useDevOverrides();
  const wo = overrides.watchlistPage;

  // Register active page for DevPanel detection
  React.useEffect(() => {
    setActivePage('WatchlistPage');
  }, [setActivePage]);

  // Auto-animate: just attach this ref to the parent container. Pas sur TV : il surveillait la position de
  // chaque affiche à chaque déplacement, même sous une fiche ouverte (Chromecast).
  const [animationParent] = useAutoAnimate();
  const gridRef = isTv() ? undefined : animationParent;

  // Load watchlist from SQLite with hydration (TMDB cache + lightIndexes fallback)
  const loadWatchlist = React.useCallback(async () => {
    if (!lightIndexes) return;
    try {
      setLoadError(null);
      const items = await getHydratedWatchlist(lightIndexes);
      setWatchlist(items);

      // Charger les progressions par tmdb_id (multi-source safe)
      const movieTmdbIds = items
        .filter(i => i.type === 'movie' && i.tmdb_id > 0)
        .map(i => i.tmdb_id);
      const progressData = movieTmdbIds.length > 0
        ? await getProgressByTmdbIds(movieTmdbIds)
        : new Map<number, EpisodeProgressInfo>();
      setProgressMap(progressData);
      rememberShownWatchlist(lightIndexes, { items, progress: progressData });
    } catch (error) {
      devLog('data', '[WatchlistPage] Error loading watchlist:', error);
      setLoadError((error as Error).message || 'Unknown error');
    } finally {
      setIsLoading(false);
    }
  }, [lightIndexes]);

  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- chargement SQLite de la liste ; seule l'erreur précédente est effacée avant l'appel
    void loadWatchlist();
  }, [loadWatchlist]);

  // Subscribe to watchlist changes from other components (add/remove from other pages)
  React.useEffect(() => {
    return onWatchlistChange(() => {
      void loadWatchlist();
    });
  }, [loadWatchlist]);

  // Subscribe to TMDB cache updates (when visiting detail page fills cache)
  React.useEffect(() => {
    return onDetailsUpdate(() => {
      void loadWatchlist();
    });
  }, [loadWatchlist]);

  // Subscribe to playback progress updates (refresh bars after watching)
  React.useEffect(() => {
    const handler = () => { void loadWatchlist(); };
    window.addEventListener(PLAYBACK_EVENT, handler);
    return () => window.removeEventListener(PLAYBACK_EVENT, handler);
  }, [loadWatchlist]);

  // ---- Apply DevPanel overrides ----

  const effectiveLoading = wo.forceLoading || isLoading;
  const effectiveError = wo.forceError || loadError;

  const effectiveWatchlist = React.useMemo(() => {
    if (wo.forceEmpty) return [];
    if (wo.forceManyItems !== null && wo.forceManyItems > 0) {
      const mocks = generateMockItems(wo.forceManyItems);
      if (wo.forceOrphanItems) {
        return mocks.map(item => ({ ...item, isOrphan: true }));
      }
      return mocks;
    }
    if (wo.forceOrphanItems) {
      return watchlist.map(item => ({ ...item, isOrphan: true }));
    }
    return watchlist;
  }, [watchlist, wo.forceEmpty, wo.forceManyItems, wo.forceOrphanItems]);

  const sortedWatchlist = effectiveWatchlist;

  // Titre introuvable chez le fournisseur actuel : fenêtre Rechercher / Retirer au lieu de la fiche
  const [unavailable, setUnavailable] = React.useState<HydratedWatchlistItem | null>(null);

  const handleItemClick = (item: HydratedWatchlistItem) => {
    if (item.isOrphan) {
      setUnavailable(item);
      return;
    }
    if (item.type === 'movie') {
      onNavigateToContent('movie', {
        tmdbId: item.tmdb_id,
        streamId: item.stream_id,
      });
    } else {
      onNavigateToContent('series', {
        tmdbId: item.tmdb_id,
        seriesId: item.stream_id,
      });
    }
  };

  const handleRemove = async (e: React.MouseEvent | undefined, item: HydratedWatchlistItem) => {
    e?.stopPropagation();
    try {
      await removeFromWatchlist(item.stream_id, item.tmdb_id, item.type);
    } catch (err) {
      // Base occupée ou fermée : même message que le bouton « Ma liste » des autres écrans.
      log.error('Retrait de Ma liste impossible :', err);
      showAppNotice('watchlist_update_failed');
    }
    await loadWatchlist();
  };

  // ---- Loading state ----
  if (effectiveLoading) {
    return (
      <div className="watchlist-page scrollbar-thin">
        <div className="watchlist-header">
          <h1 className="watchlist-title">{t('watchlist')}</h1>
        </div>
        <WatchlistSkeleton />
      </div>
    );
  }

  return (
    <div className="watchlist-page scrollbar-thin" data-testid="watchlist-page" data-nav-cadence>
      {/* Header with count */}
      <div className="watchlist-header">
        <h1 className="watchlist-title">{t('watchlist')}</h1>
        {sortedWatchlist.length > 0 && (
          <span className="watchlist-count" data-testid="watchlist-count">
            {t('watchlist_count', { count: sortedWatchlist.length })}
          </span>
        )}
      </div>

      {/* Error banner */}
      {effectiveError && (
        <div className="watchlist-error">
          <span className="watchlist-error__message">{t('watchlist_load_error')}</span>
          <button
            type="button"
            className="watchlist-error__retry"
            data-testid="watchlist-retry"
            onClick={() => void loadWatchlist()}
          >
            {t('watchlist_retry')}
          </button>
        </div>
      )}

      {/* Empty state */}
      {sortedWatchlist.length === 0 && !effectiveError ? (
        <div className="watchlist-empty-state" data-testid="watchlist-empty">
          <EmptyListIcon />
          <h2>{t('empty_watchlist_title')}</h2>
          <p>{t('empty_watchlist_desc')}</p>
          {onNavigateToTab && (
            <NyxButton
              variant="secondary"
              size="md"
              color="blue"
              onClick={() => onNavigateToTab('dashboard')}
              data-testid="watchlist-discover"
            >
              {t('watchlist_discover')}
            </NyxButton>
          )}
        </div>
      ) : sortedWatchlist.length > 0 && (
        <div className="watchlist-grid" ref={gridRef} data-testid="watchlist-grid">
          {sortedWatchlist.map((item) => (
            <WatchlistGridCard
              key={`${item.type}-${item.stream_id}`}
              item={item}
              progress={item.type === 'movie' ? (progressMap.get(item.tmdb_id)?.progressPercent ?? 0) : 0}
              onOpen={() => handleItemClick(item)}
              onRemove={(e) => void handleRemove(e, item)}
            />
          ))}
        </div>
      )}

      {unavailable && (
        <UnavailableTitleModal
          item={unavailable}
          onRemove={() => void handleRemove(undefined, unavailable)}
          onClose={() => setUnavailable(null)}
        />
      )}
    </div>
  );
};

export default WatchlistPage;
