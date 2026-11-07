/**
 * Tests pour WatchlistPage.tsx — page « Ma liste ».
 * Vérifie : chargement, liste vide, cartes et progression, ouverture d'une fiche, retrait,
 * titre introuvable, erreur avec nouvel essai, rafraîchissements, télécommande.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import type { LightIndexes } from '../../types/lightIndex';
import type { HydratedWatchlistItem } from '../../services/watchlistHydration';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { count?: number }) => (opts?.count !== undefined ? `${key}:${opts.count}` : key),
  }),
}));
vi.mock('../WatchlistPage.css', () => ({}));
vi.mock('../../utils/appNotice', () => ({ showAppNotice: vi.fn() }));
vi.mock('@formkit/auto-animate/react', () => ({ useAutoAnimate: () => [vi.fn()] }));

vi.mock('../../contexts/DevOverrideContext', () => ({
  useDevOverrides: () => ({
    overrides: { watchlistPage: { forceLoading: false, forceEmpty: false, forceOrphanItems: false, forceManyItems: null, forceError: null } },
    setActivePage: vi.fn(),
  }),
}));

let watchlistListener: (() => void) | null = null;
let detailsListener: (() => void) | null = null;
const unsubscribeWatchlist = vi.fn();
const unsubscribeDetails = vi.fn();

vi.mock('../../services/watchlistHydration', () => ({
  getHydratedWatchlist: vi.fn(),
  removeFromWatchlist: vi.fn(),
  onWatchlistChange: vi.fn((cb: () => void) => {
    watchlistListener = cb;
    return unsubscribeWatchlist;
  }),
  getShownWatchlist: vi.fn(() => null),
  rememberShownWatchlist: vi.fn(),
}));
vi.mock('../../services/tmdbCacheSqlite', () => ({
  onDetailsUpdate: vi.fn((cb: () => void) => {
    detailsListener = cb;
    return unsubscribeDetails;
  }),
}));
vi.mock('../../services/playbackProgressService', () => ({
  getProgressByTmdbIds: vi.fn(),
}));
vi.mock('../../components/Common/UnavailableTitleModal', () => ({
  default: ({ item, onRemove, onClose }: { item: { name: string }; onRemove: () => void; onClose: () => void }) => (
    <div data-testid="introuvable">
      <span>{item.name}</span>
      <button onClick={onRemove}>retirer-modal</button>
      <button onClick={onClose}>fermer-modal</button>
    </div>
  ),
}));

import WatchlistPage from '../WatchlistPage';
import {
  getHydratedWatchlist,
  removeFromWatchlist,
  getShownWatchlist,
  rememberShownWatchlist,
} from '../../services/watchlistHydration';
import { getProgressByTmdbIds } from '../../services/playbackProgressService';
import { PLAYBACK_EVENT } from '../../services/eventConstants';
import { setTvMode } from '../../utils/platform';
import { showAppNotice } from '../../utils/appNotice';

const indexes = {} as LightIndexes;

function item(over: Partial<HydratedWatchlistItem>): HydratedWatchlistItem {
  return {
    stream_id: 1,
    tmdb_id: 100,
    type: 'movie',
    added_at: 0,
    name: 'Film Un',
    posterUrl: 'http://exemple.test/p.jpg',
    isOrphan: false,
    ...over,
  };
}

const movie = item({});
const serie = item({ stream_id: 2, tmdb_id: 200, type: 'series', name: 'Serie Deux' });

function setup(extra: { withTab?: boolean } = { withTab: true }) {
  const onNavigateToContent = vi.fn();
  const onNavigateToTab = extra.withTab ? vi.fn() : undefined;
  render(<WatchlistPage onNavigateToContent={onNavigateToContent} onNavigateToTab={onNavigateToTab} lightIndexes={indexes} />);
  return { onNavigateToContent, onNavigateToTab };
}

describe('WatchlistPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    watchlistListener = null;
    detailsListener = null;
    vi.mocked(getShownWatchlist).mockReturnValue(null);
    vi.mocked(getHydratedWatchlist).mockResolvedValue([movie, serie]);
    vi.mocked(getProgressByTmdbIds).mockResolvedValue(new Map([[100, { progressPercent: 40 }]]) as never);
    vi.mocked(removeFromWatchlist).mockResolvedValue(undefined as never);
  });

  afterEach(() => {
    setTvMode(false);
  });

  describe('Chargement', () => {
    it('affiche des emplacements de chargement puis les cartes', async () => {
      const { container } = render(
        <WatchlistPage onNavigateToContent={vi.fn()} lightIndexes={indexes} />,
      );
      expect(container.querySelectorAll('.watchlist-skeleton-card')).toHaveLength(8);
      expect(screen.queryByTestId('watchlist-grid')).not.toBeInTheDocument();
      expect(await screen.findAllByTestId('watchlist-card')).toHaveLength(2);
    });

    it('affiche le nombre de titres', async () => {
      setup();
      expect(await screen.findByTestId('watchlist-count')).toHaveTextContent('watchlist_count:2');
    });

    it('demande les progressions des films seulement', async () => {
      setup();
      await screen.findByTestId('watchlist-grid');
      expect(getProgressByTmdbIds).toHaveBeenCalledWith([100]);
    });

    it('ne demande pas de progression quand il n\'y a que des séries', async () => {
      vi.mocked(getHydratedWatchlist).mockResolvedValue([serie]);
      setup();
      await screen.findByTestId('watchlist-grid');
      expect(getProgressByTmdbIds).not.toHaveBeenCalled();
    });

    it('affiche la barre de progression d\'un film entamé', async () => {
      setup();
      const cartes = await screen.findAllByTestId('watchlist-card');
      const barre = cartes[0].querySelector('.progress-fill') as HTMLElement;
      expect(barre.style.width).toBe('40%');
      expect(cartes[1].querySelector('.progress-fill')).toBeNull();
    });

    it('mémorise la liste affichée pour la prochaine visite', async () => {
      setup();
      await screen.findByTestId('watchlist-grid');
      expect(rememberShownWatchlist).toHaveBeenCalledWith(indexes, expect.objectContaining({ items: [movie, serie] }));
    });

    it('affiche tout de suite la liste de la visite précédente, sans emplacements', () => {
      vi.mocked(getShownWatchlist).mockReturnValue({ items: [movie], progress: new Map() });
      const { container } = render(<WatchlistPage onNavigateToContent={vi.fn()} lightIndexes={indexes} />);
      expect(container.querySelector('.watchlist-skeleton-card')).toBeNull();
      expect(screen.getAllByTestId('watchlist-card')).toHaveLength(1);
    });
  });

  describe('Liste vide', () => {
    beforeEach(() => {
      vi.mocked(getHydratedWatchlist).mockResolvedValue([]);
    });

    it('explique que la liste est vide et propose de découvrir des titres', async () => {
      const { onNavigateToTab } = setup();
      const vide = await screen.findByTestId('watchlist-empty');
      expect(within(vide).getByText('empty_watchlist_title')).toBeInTheDocument();
      expect(screen.queryByTestId('watchlist-count')).not.toBeInTheDocument();
      fireEvent.click(screen.getByTestId('watchlist-discover'));
      expect(onNavigateToTab).toHaveBeenCalledWith('dashboard');
    });

    it('ne propose pas de découvrir sans navigation par onglet', async () => {
      setup({ withTab: false });
      await screen.findByTestId('watchlist-empty');
      expect(screen.queryByTestId('watchlist-discover')).not.toBeInTheDocument();
    });
  });

  describe('Ouverture et retrait', () => {
    it('ouvre la fiche du film', async () => {
      const { onNavigateToContent } = setup();
      const cartes = await screen.findAllByTestId('watchlist-card');
      fireEvent.click(cartes[0]);
      expect(onNavigateToContent).toHaveBeenCalledWith('movie', { tmdbId: 100, streamId: 1 });
    });

    it('ouvre la fiche de la série', async () => {
      const { onNavigateToContent } = setup();
      const cartes = await screen.findAllByTestId('watchlist-card');
      fireEvent.click(cartes[1]);
      expect(onNavigateToContent).toHaveBeenCalledWith('series', { tmdbId: 200, seriesId: 2 });
    });

    it('affiche un message et garde le titre quand la base refuse le retrait', async () => {
      const { onNavigateToContent } = setup();
      const cartes = await screen.findAllByTestId('watchlist-card');
      vi.mocked(removeFromWatchlist).mockRejectedValue(new Error('database is locked'));
      fireEvent.click(within(cartes[0]).getByTestId('watchlist-card-remove'));
      await waitFor(() => expect(showAppNotice).toHaveBeenCalledWith('watchlist_update_failed'));
      expect(screen.getAllByTestId('watchlist-card')).toHaveLength(2);
      expect(onNavigateToContent).not.toHaveBeenCalled();
    });

    it('retire un titre sans ouvrir sa fiche puis recharge la liste', async () => {
      const { onNavigateToContent } = setup();
      const cartes = await screen.findAllByTestId('watchlist-card');
      vi.mocked(getHydratedWatchlist).mockResolvedValue([serie]);
      fireEvent.click(within(cartes[0]).getByTestId('watchlist-card-remove'));
      await waitFor(() => expect(screen.getAllByTestId('watchlist-card')).toHaveLength(1));
      expect(removeFromWatchlist).toHaveBeenCalledWith(1, 100, 'movie');
      expect(onNavigateToContent).not.toHaveBeenCalled();
    });

    it('affiche « Introuvable » et ouvre la fenêtre au lieu de la fiche pour un titre orphelin', async () => {
      vi.mocked(getHydratedWatchlist).mockResolvedValue([item({ isOrphan: true })]);
      const { onNavigateToContent } = setup();
      const carte = await screen.findByTestId('watchlist-card');
      expect(within(carte).getByTestId('watchlist-card-unavailable')).toBeInTheDocument();
      fireEvent.click(carte);
      expect(onNavigateToContent).not.toHaveBeenCalled();
      expect(screen.getByTestId('introuvable')).toHaveTextContent('Film Un');
    });

    it('retire le titre introuvable depuis la fenêtre', async () => {
      vi.mocked(getHydratedWatchlist).mockResolvedValue([item({ isOrphan: true })]);
      setup();
      fireEvent.click(await screen.findByTestId('watchlist-card'));
      vi.mocked(getHydratedWatchlist).mockResolvedValue([]);
      fireEvent.click(screen.getByText('retirer-modal'));
      await waitFor(() => expect(removeFromWatchlist).toHaveBeenCalledWith(1, 100, 'movie'));
      await screen.findByTestId('watchlist-empty');
    });

    it('referme la fenêtre du titre introuvable', async () => {
      vi.mocked(getHydratedWatchlist).mockResolvedValue([item({ isOrphan: true })]);
      setup();
      fireEvent.click(await screen.findByTestId('watchlist-card'));
      fireEvent.click(screen.getByText('fermer-modal'));
      expect(screen.queryByTestId('introuvable')).not.toBeInTheDocument();
    });

    it('utilise un nom de remplacement pour un titre sans nom', async () => {
      vi.mocked(getHydratedWatchlist).mockResolvedValue([item({ name: '' })]);
      setup();
      const carte = await screen.findByTestId('watchlist-card');
      expect(within(carte).getByText('unknown_title')).toBeInTheDocument();
    });
  });

  describe('Erreur', () => {
    it('affiche un bandeau d\'erreur puis recharge au nouvel essai', async () => {
      vi.mocked(getHydratedWatchlist).mockRejectedValueOnce(new Error('base indisponible'));
      setup();
      expect(await screen.findByText('watchlist_load_error')).toBeInTheDocument();
      expect(screen.queryByTestId('watchlist-empty')).not.toBeInTheDocument();
      fireEvent.click(screen.getByTestId('watchlist-retry'));
      expect(await screen.findAllByTestId('watchlist-card')).toHaveLength(2);
      expect(screen.queryByText('watchlist_load_error')).not.toBeInTheDocument();
    });
  });

  describe('Rafraîchissements', () => {
    it('recharge quand Ma liste change ailleurs', async () => {
      setup();
      await screen.findByTestId('watchlist-grid');
      vi.mocked(getHydratedWatchlist).mockResolvedValue([movie]);
      act(() => watchlistListener?.());
      await waitFor(() => expect(screen.getAllByTestId('watchlist-card')).toHaveLength(1));
    });

    it('recharge quand le cache TMDB est complété', async () => {
      setup();
      await screen.findByTestId('watchlist-grid');
      expect(getHydratedWatchlist).toHaveBeenCalledTimes(1);
      act(() => detailsListener?.());
      await waitFor(() => expect(getHydratedWatchlist).toHaveBeenCalledTimes(2));
    });

    it('recharge quand une position de lecture est enregistrée', async () => {
      setup();
      await screen.findByTestId('watchlist-grid');
      act(() => {
        window.dispatchEvent(new Event(PLAYBACK_EVENT));
      });
      await waitFor(() => expect(getHydratedWatchlist).toHaveBeenCalledTimes(2));
    });

    it('se désabonne au démontage', async () => {
      const { unmount } = render(<WatchlistPage onNavigateToContent={vi.fn()} lightIndexes={indexes} />);
      await screen.findByTestId('watchlist-grid');
      unmount();
      expect(unsubscribeWatchlist).toHaveBeenCalled();
      expect(unsubscribeDetails).toHaveBeenCalled();
      vi.mocked(getHydratedWatchlist).mockClear();
      window.dispatchEvent(new Event(PLAYBACK_EVENT));
      expect(getHydratedWatchlist).not.toHaveBeenCalled();
    });
  });

  describe('Android TV', () => {
    it('rend les cartes activables à la télécommande', async () => {
      setTvMode(true);
      const { onNavigateToContent } = setup();
      const cartes = await screen.findAllByTestId('watchlist-card');
      expect(cartes[0]).toHaveAttribute('tabindex', '0');
      expect(within(cartes[0]).getByTestId('watchlist-card-remove')).toHaveAttribute('tabindex', '-1');
      fireEvent.keyDown(cartes[0], { key: 'Enter' });
      expect(onNavigateToContent).toHaveBeenCalledWith('movie', { tmdbId: 100, streamId: 1 });
    });
  });
});
