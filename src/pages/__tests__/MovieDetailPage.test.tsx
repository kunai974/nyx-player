/**
 * Tests pour MovieDetailPage.tsx — fiche d'un film.
 * Vérifie : chargement / TMDB indisponible / fiche complète, lecture, Ma liste, choix de la source,
 * remise à zéro de la progression, films similaires, retour, bandeau d'entrée.
 * Les hooks de données (TMDB, source) sont simulés ; les composants lourds sont des relevés.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import type { XtreamMovie } from '../../types/xtream';
import type { LightIndexes } from '../../types/lightIndex';
import type { CarouselItem } from '../../components/Lists/ContentCarousel';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('../MovieDetailPage.css', () => ({}));
vi.mock('../../utils/tmdbLanguage', () => ({ getTmdbLanguage: () => 'fr-FR', getAppLanguage: () => 'fr' }));

const play = vi.fn();
vi.mock('../../contexts/PlayerContext', () => ({ usePlayer: () => ({ play }) }));
const overrides = vi.hoisted(() => ({
  value: { forceLoadingState: null, forceNoBackdrop: false, forceNoSimilar: false, forceNoTrailer: false, forceProgress: false } as {
    forceLoadingState: 'loading' | 'ready' | 'fallback' | null;
    forceNoBackdrop: boolean; forceNoSimilar: boolean; forceNoTrailer: boolean; forceProgress: boolean;
  },
}));
vi.mock('../../contexts/DevOverrideContext', () => ({
  useDevOverrides: () => ({ overrides: { movieDetailPage: overrides.value }, setActivePage: vi.fn() }),
}));

const tmdbState = vi.hoisted(() => ({ value: { details: null, resolvedTmdbId: 0, loadingState: 'ready' } as Record<string, unknown> }));
vi.mock('../../hooks/useTmdbMovie', () => ({ useTmdbMovie: () => tmdbState.value }));
vi.mock('../../hooks/useBackdropUrl', () => ({ useBackdropUrl: () => 'http://exemple.test/fond.jpg' }));
vi.mock('../../hooks/useTvPageFocus', () => ({ useTvPageFocus: vi.fn() }));

const setInWatchlist = vi.fn();
const setHasMovieProgress = vi.fn();
const handleVersionSelect = vi.fn();
const source = vi.hoisted(() => ({ value: {} as Record<string, unknown>, args: null as null | { initialVersions: Array<{ stream_id: number }> } }));
vi.mock('../../hooks/useMovieSourceSelection', () => ({
  useMovieSourceSelection: (args: { initialVersions: Array<{ stream_id: number }> }) => { source.args = args; return source.value; },
}));

vi.mock('../../services/tmdbApi', () => ({
  default: { imageUrl: (path: string, size: string) => `http://exemple.test/${size}${path}` },
}));
vi.mock('../../services/watchlistActions', () => ({ toggleWatchlistOrNotify: vi.fn() }));
vi.mock('../../services/playbackProgressService', () => ({ clearProgress: vi.fn() }));

vi.mock('../../components/Skeletons/MovieSkeleton', () => ({ default: () => <div data-testid="squelette" /> }));
vi.mock('../../components/Detail/TrailerCard', () => ({
  default: ({ trailerKey }: { trailerKey: string }) => <div data-testid="bande-annonce">{trailerKey}</div>,
}));
vi.mock('../../components/Detail/SourceSelector', () => ({
  default: ({ versions, onSelect }: { versions: Array<{ id: number; name: string }>; onSelect: (v: { id: number; name: string }) => void }) => (
    <div data-testid="sources">
      {versions.map((v) => <button key={v.id} onClick={() => onSelect(v)}>{v.name}</button>)}
    </div>
  ),
}));
vi.mock('../../components/Lists/ContentCarousel', () => ({
  default: ({ items, loading }: { items: CarouselItem[]; loading?: boolean }) => (
    <div data-testid="similaires" data-loading={String(loading)}>
      {items.map((i) => <button key={i.id} onClick={i.onClick}>{i.title}</button>)}
    </div>
  ),
}));

vi.mock('../../services/titleTmdbLinks', () => ({
  linkTitlesByName: vi.fn(async () => 1),
  mostlyWithoutTmdb: vi.fn(() => false),
}));

import MovieDetailPage from '../MovieDetailPage';
import { linkTitlesByName, mostlyWithoutTmdb } from '../../services/titleTmdbLinks';
import { toggleWatchlistOrNotify } from '../../services/watchlistActions';
import { clearProgress } from '../../services/playbackProgressService';
import { setTvMode } from '../../utils/platform';

const v1 = { stream_id: 100, name: 'Film Source A', tmdb: '55' } as unknown as XtreamMovie;
const v2 = { stream_id: 200, name: 'Film Source B', tmdb: '55' } as unknown as XtreamMovie;

const details = {
  title: 'Titre TMDB',
  overview: 'Un synopsis complet.',
  release_date: '2021-05-04',
  runtime: 125,
  vote_average: 7.84,
  genres: [{ name: 'Action' }, { name: 'Drame' }],
  credits: { cast: Array.from({ length: 8 }, (_, i) => ({ name: `Acteur ${i + 1}` })) },
  poster_path: '/affiche.jpg',
  adult: false,
  videos: { results: [{ type: 'Trailer', site: 'YouTube', key: 'CLE123' }] },
  recommendations: {
    results: [
      { id: 1, poster_path: '/a.jpg', original_title: 'Similaire A' },
      { id: 2, poster_path: null, original_title: 'Sans affiche' },
      { id: 3, poster_path: '/c.jpg', original_title: 'Absent du catalogue' },
    ],
  },
};

const catalog = {
  movies: new Map([[900, { id: 900, name: 'Similaire A', tmdbId: 1 }]]),
  moviesByTmdb: new Map([[1, { id: 900, name: 'Similaire A' }]]),
} as unknown as LightIndexes;

function setSource(over: Record<string, unknown> = {}) {
  source.value = {
    selectedVersion: v1,
    inWatchlist: false,
    setInWatchlist,
    hasMovieProgress: false,
    setHasMovieProgress,
    displayVersions: [{ id: 100, name: 'Film Source A' }, { id: 200, name: 'Film Source B' }],
    handleVersionSelect,
    ...over,
  };
}

function setup(extra: Partial<React.ComponentProps<typeof MovieDetailPage>> = {}) {
  const props = {
    tmdbId: 55,
    versions: [v1, v2],
    lightIndexes: catalog,
    onBack: vi.fn(),
    onNavigateToMovie: vi.fn(),
    ...extra,
  };
  const view = render(<MovieDetailPage {...props} />);
  return { props, ...view };
}

describe('MovieDetailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    overrides.value = { forceLoadingState: null, forceNoBackdrop: false, forceNoSimilar: false, forceNoTrailer: false, forceProgress: false };
    tmdbState.value = { details, resolvedTmdbId: 55, loadingState: 'ready' };
    setSource();
    vi.mocked(toggleWatchlistOrNotify).mockResolvedValue(true);
    vi.mocked(clearProgress).mockResolvedValue(undefined as never);
  });

  afterEach(() => {
    vi.useRealTimers();
    setTvMode(false);
  });

  describe('Fiche complète', () => {
    it('affiche le titre TMDB, les pastilles, les genres, le synopsis et la distribution limitée à six', () => {
      setup();
      expect(screen.getByTestId('movie-detail-title')).toHaveTextContent('Titre TMDB');
      expect(screen.getByText('2h5min')).toBeInTheDocument();
      expect(screen.getByText('2021')).toBeInTheDocument();
      expect(screen.getByText(/7\.8/)).toBeInTheDocument();
      expect(screen.getByText('Action, Drame')).toBeInTheDocument();
      expect(screen.getByText('Un synopsis complet.')).toBeInTheDocument();
      expect(screen.getByText(/Acteur 1, .*Acteur 6$/)).toBeInTheDocument();
      expect(screen.queryByText(/Acteur 7/)).not.toBeInTheDocument();
    });

    it('affiche la bande-annonce YouTube', () => {
      setup();
      expect(screen.getByTestId('bande-annonce')).toHaveTextContent('CLE123');
    });

    it('affiche la mention adulte quand TMDB l\'indique', () => {
      tmdbState.value = { details: { ...details, adult: true }, resolvedTmdbId: 55, loadingState: 'ready' };
      setup();
      expect(screen.getByText('badge_adult')).toBeInTheDocument();
    });

    it('affiche le synopsis de remplacement quand TMDB n\'en fournit pas', () => {
      tmdbState.value = { details: { ...details, overview: '' }, resolvedTmdbId: 55, loadingState: 'ready' };
      setup();
      expect(screen.getByText('synopsis_unavailable')).toBeInTheDocument();
    });

    it('affiche le logo du film à la place du titre quand TMDB en fournit un', () => {
      tmdbState.value = {
        details: { ...details, images: { logos: [{ file_path: '/logo.png', iso_639_1: 'fr', width: 500, height: 200, vote_average: 5 }] } },
        resolvedTmdbId: 55,
        loadingState: 'ready',
      };
      setup();
      expect(screen.getByTestId('movie-detail-logo')).toBeInTheDocument();
      expect(screen.queryByTestId('movie-detail-title')).not.toBeInTheDocument();
    });
  });

  describe('Chargement et repli', () => {
    it('affiche le squelette et le carrousel en chargement, sans genres ni synopsis', () => {
      tmdbState.value = { details: null, resolvedTmdbId: 55, loadingState: 'loading' };
      const { container } = setup();
      expect(container.querySelector('.skeleton-layer')).not.toHaveClass('hidden');
      expect(screen.getByTestId('similaires')).toHaveAttribute('data-loading', 'true');
      expect(screen.queryByText('Un synopsis complet.')).not.toBeInTheDocument();
    });

    it('affiche le nom du fournisseur et le message « TMDB indisponible » en repli', () => {
      tmdbState.value = { details: null, resolvedTmdbId: 0, loadingState: 'fallback' };
      setup();
      expect(screen.getByTestId('movie-detail-title')).toHaveTextContent('Film Source A');
      expect(screen.getByText('tmdb_unavailable')).toBeInTheDocument();
      expect(screen.queryByTestId('bande-annonce')).not.toBeInTheDocument();
    });
  });

  describe('Actions', () => {
    it('revient en arrière au clic sur le bouton retour', () => {
      const { props } = setup();
      fireEvent.click(screen.getByTestId('movie-detail-back'));
      expect(props.onBack).toHaveBeenCalledTimes(1);
    });

    it('lance la lecture de la source choisie avec les informations TMDB', () => {
      setup();
      fireEvent.click(screen.getByTestId('movie-detail-play'));
      expect(play).toHaveBeenCalledWith(v1, undefined, undefined, {
        tmdbTitle: 'Titre TMDB',
        tmdbId: 55,
        posterUrl: 'http://exemple.test/w500/affiche.jpg',
      });
    });

    it('ne lance rien tant qu\'aucune source n\'est choisie', () => {
      setSource({ selectedVersion: null });
      setup();
      fireEvent.click(screen.getByTestId('movie-detail-play'));
      expect(play).not.toHaveBeenCalled();
      expect(screen.queryByTestId('sources')).not.toBeInTheDocument();
    });

    it('ajoute à Ma liste puis met le bouton à jour', async () => {
      setup();
      fireEvent.click(screen.getByTestId('movie-detail-watchlist'));
      await waitFor(() => expect(setInWatchlist).toHaveBeenCalledWith(true));
      expect(toggleWatchlistOrNotify).toHaveBeenCalledWith(100, 55, 'movie');
    });

    it('laisse le bouton inchangé quand l\'ajout à Ma liste échoue', async () => {
      vi.mocked(toggleWatchlistOrNotify).mockResolvedValue(null as never);
      setup();
      fireEvent.click(screen.getByTestId('movie-detail-watchlist'));
      await waitFor(() => expect(toggleWatchlistOrNotify).toHaveBeenCalled());
      expect(setInWatchlist).not.toHaveBeenCalled();
    });

    it('propose le choix de la source et transmet la version choisie', () => {
      setup();
      fireEvent.click(screen.getByText('Film Source B'));
      expect(handleVersionSelect).toHaveBeenCalledWith({ id: 200, name: 'Film Source B' });
    });
  });

  describe('Remise à zéro de la progression', () => {
    it('masque le bouton sans progression', () => {
      setup();
      expect(screen.queryByTestId('movie-detail-reset-progress')).not.toBeInTheDocument();
    });

    it('efface la progression, confirme par un message puis le retire après 3 secondes', async () => {
      setSource({ hasMovieProgress: true });
      setup();
      vi.useFakeTimers();
      await act(async () => {
        fireEvent.click(screen.getByTestId('movie-detail-reset-progress'));
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(clearProgress).toHaveBeenCalledWith(100);
      expect(setHasMovieProgress).toHaveBeenCalledWith(false);
      expect(screen.getByText('progress_reset_success')).toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(3000);
      });
      expect(screen.queryByText('progress_reset_success')).not.toBeInTheDocument();
    });

    it('garde la progression quand l\'effacement échoue', async () => {
      vi.mocked(clearProgress).mockRejectedValue(new Error('base indisponible'));
      setSource({ hasMovieProgress: true });
      setup();
      fireEvent.click(screen.getByTestId('movie-detail-reset-progress'));
      await waitFor(() => expect(clearProgress).toHaveBeenCalled());
      expect(setHasMovieProgress).not.toHaveBeenCalled();
      expect(screen.queryByText('progress_reset_success')).not.toBeInTheDocument();
    });
  });

  describe('Films similaires', () => {
    it('ne propose que les recommandations avec affiche présentes dans le catalogue', () => {
      setup();
      const boutons = screen.getByTestId('similaires').querySelectorAll('button');
      expect(boutons).toHaveLength(1);
      expect(boutons[0]).toHaveTextContent('Similaire A');
    });

    it('ouvre la fiche du film similaire avec son numéro TMDB et celui du fournisseur', () => {
      const { props } = setup();
      fireEvent.click(screen.getByText('Similaire A'));
      expect(props.onNavigateToMovie).toHaveBeenCalledWith(1, 900);
    });

    it('ne plante pas au clic quand la navigation n\'est pas fournie', () => {
      setup({ onNavigateToMovie: undefined });
      expect(() => fireEvent.click(screen.getByText('Similaire A'))).not.toThrow();
    });

    it('n\'affiche rien sans catalogue', () => {
      setup({ lightIndexes: undefined });
      expect(screen.getByTestId('similaires').querySelectorAll('button')).toHaveLength(0);
    });
  });

  describe('Entrée de la page', () => {
    it('devient visible peu après l\'ouverture', () => {
      vi.useFakeTimers();
      render(<MovieDetailPage tmdbId={55} versions={[v1]} onBack={vi.fn()} />);
      const page = screen.getByTestId('movie-detail');
      expect(page).not.toHaveClass('is-visible');
      act(() => {
        vi.advanceTimersByTime(20);
      });
      expect(page).toHaveClass('is-visible');
    });

    it('rejoue l\'animation d\'entrée au retour de la vidéo', () => {
      vi.useFakeTimers();
      const { rerender } = render(<MovieDetailPage tmdbId={55} versions={[v1]} onBack={vi.fn()} />);
      act(() => {
        vi.advanceTimersByTime(20);
      });
      rerender(<MovieDetailPage tmdbId={55} versions={[v1]} onBack={vi.fn()} replayEntrance />);
      expect(screen.getByTestId('movie-detail')).not.toHaveClass('is-visible');
      act(() => {
        vi.advanceTimersByTime(60);
      });
      expect(screen.getByTestId('movie-detail')).toHaveClass('is-visible');
    });

    it('ne laisse aucune minuterie après le démontage', () => {
      vi.useFakeTimers();
      const { unmount } = render(<MovieDetailPage tmdbId={55} versions={[v1]} onBack={vi.fn()} />);
      unmount();
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe('Android TV', () => {
    it('rend le synopsis accessible à la télécommande pour le faire défiler', () => {
      setTvMode(true);
      const { container } = setup();
      expect(container.querySelector('.synopsis-container')).toHaveAttribute('tabindex', '0');
    });
  });
});

describe('MovieDetailPage — numéro trouvé par le titre après l\'ouverture', () => {
  it('adds the other versions of the same title to the sources', () => {
    setSource();
    tmdbState.value = { details: null, resolvedTmdbId: 42, loadingState: 'ready' };
    const lone = { stream_id: 100, name: 'Elf (2003)' } as unknown as XtreamMovie;
    const linked = {
      movies: new Map([
        [100, { id: 100, name: 'Elf (2003)', tmdbId: 42, containerExt: 'mkv' }],
        [101, { id: 101, name: 'FR | Elf (2003)', tmdbId: 42, containerExt: 'mp4' }],
        [102, { id: 102, name: 'Autre', tmdbId: 0, containerExt: 'mkv' }],
      ]),
      moviesByTmdb: new Map(),
    } as unknown as LightIndexes;
    render(<MovieDetailPage tmdbId={0} versions={[lone]} lightIndexes={linked} onBack={vi.fn()} />);
    expect(source.args!.initialVersions.map((v) => Number(v.stream_id))).toEqual([100, 101]);
  });

  it('keeps the versions given at opening when the provider gave the TMDB id', () => {
    setSource();
    tmdbState.value = { details: null, resolvedTmdbId: 55, loadingState: 'ready' };
    const linked = { movies: new Map([[300, { id: 300, name: 'X', tmdbId: 55 }]]), moviesByTmdb: new Map() } as unknown as LightIndexes;
    render(<MovieDetailPage tmdbId={55} versions={[v1, v2]} lightIndexes={linked} onBack={vi.fn()} />);
    expect(source.args!.initialVersions).toEqual([v1, v2]);
  });

  describe('films similaires reliés par leurs titres (catalogue sans numéros TMDB)', () => {
    beforeEach(() => {
      vi.mocked(linkTitlesByName).mockClear();
      setSource();
      tmdbState.value = { details, resolvedTmdbId: 55, loadingState: 'ready' };
    });
    afterEach(() => vi.useRealTimers());

    it('compare les titres conseillés par TMDB au catalogue, un peu après l\'ouverture', async () => {
      vi.useFakeTimers();
      vi.mocked(mostlyWithoutTmdb).mockReturnValue(true);
      setup();
      expect(linkTitlesByName).not.toHaveBeenCalled();
      await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
      expect(linkTitlesByName).toHaveBeenCalledTimes(1);
      const titles = vi.mocked(linkTitlesByName).mock.calls[0][1];
      expect(titles.map((t) => t.tmdbId)).toEqual([1, 2, 3]);
      expect(titles[0]).toMatchObject({ kind: 'movie', titles: ['Similaire A'] });
    });

    it('rien à faire quand le fournisseur donne ses numéros', async () => {
      vi.useFakeTimers();
      vi.mocked(mostlyWithoutTmdb).mockReturnValue(false);
      setup();
      await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
      expect(linkTitlesByName).not.toHaveBeenCalled();
    });

    it('fiche quittée avant la comparaison : elle n\'a pas lieu', async () => {
      vi.useFakeTimers();
      vi.mocked(mostlyWithoutTmdb).mockReturnValue(true);
      const { unmount } = setup();
      unmount();
      await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
      expect(linkTitlesByName).not.toHaveBeenCalled();
    });
  });
});
