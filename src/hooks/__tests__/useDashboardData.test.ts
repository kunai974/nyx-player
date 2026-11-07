/**
 * Accueil et catalogue neuf : après une actualisation des sources, l'accueil
 * doit montrer le catalogue neuf (nouveaux numéros, nouveautés du fournisseur, titres retirés
 * enlevés), sans passer par l'état « chargement » et sans appel réseau quand c'est un recalcul
 * discret.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { LightIndexes, LightMovie, LightSeries } from '../../types/lightIndex';

// ============================================================================
// MOCKS
// ============================================================================

const cachedLists = new Map<string, unknown[]>();

const mockIsTmdbAvailable = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => true));
vi.mock('../../services/tmdbCacheSqlite', () => ({
  getCachedList: vi.fn(async (key: string) => cachedLists.get(key) ?? null),
  setCachedList: vi.fn(async (key: string, data: unknown[]) => { cachedLists.set(key, data); }),
  // Fiches des films de la bannière : rien de gardé ici, les tests suivent les demandes au réseau
  getCachedDetails: vi.fn(async () => null),
  cacheMovieDetails: vi.fn(async () => {}),
}));

vi.mock('../../services/tmdbApi', () => ({
  isTmdbAvailable: (...args: unknown[]) => mockIsTmdbAvailable(...args),
  default: {
    imageUrl: (path: string | null) => (path ? `img:${path}` : null),
    getTrending: vi.fn(async () => ({ results: [] })),
    getNowPlaying: vi.fn(async () => ({ results: [] })),
    getOnTheAir: vi.fn(async () => ({ results: [] })),
    getTopRated: vi.fn(async () => ({ results: [] })),
    getPopular: vi.fn(async () => ({ results: [] })),
    getByGenre: vi.fn(async () => ({ results: [] })),
    getMovieDetails: vi.fn(async () => ({ images: undefined })),
  },
}));

vi.mock('../../utils/tmdbLanguage', () => ({
  getTmdbLanguage: vi.fn(() => 'fr-FR'),
}));

let enabledGenres: number[] = [];
vi.mock('../../services/preferencesService', () => ({
  getCarouselPreferences: () => ({ disabledCarousels: [], enabledGenres, filterExoticScripts: false }),
  getEnabledGenres: () => enabledGenres,
  isExoticFilterEnabled: () => false,
  isTmdbTitleSearchEnabled: () => true,
}));

const mockLinkTitles = vi.hoisted(() => vi.fn(async (..._args: unknown[]): Promise<number> => 0));
vi.mock('../../services/titleTmdbLinks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/titleTmdbLinks')>()),
  linkHomeTitlesAndRefresh: (...args: unknown[]) => mockLinkTitles(...args),
}));

// ============================================================================
// IMPORTS APRÈS LES MOCKS
// ============================================================================

import tmdb from '../../services/tmdbApi';
import { useDashboardData, TITLE_LINKS_TIMING } from '../useDashboardData';
import { TMDB_LANGUAGE_EVENT } from '../../services/eventConstants';
import { getTmdbLanguage } from '../../utils/tmdbLanguage';
import {
  catalogTableId,
  clearDashboardCache,
  installDashboardRematch,
  markDashboardLoaded,
  dashboardCache,
} from '../../services/dashboardCache';
import { computeDashboardRematch } from '../../services/dashboardRematch';

// ============================================================================
// DONNÉES
// ============================================================================

function movie(id: number, tmdbId: number): LightMovie {
  return { id, name: `m${id}`, iconPrefixId: -1, iconSuffix: '', tmdbId, categoryId: '1', added: 0, containerExt: 'mp4' };
}

function series(id: number, tmdbId: number): LightSeries {
  return { id, name: `s${id}`, iconPrefixId: -1, iconSuffix: '', tmdbId, categoryId: '2', added: 0 };
}

/** Catalogue : [numéro, tmdbId] pour les films et les séries */
function catalogue(movies: Array<[number, number]>, seriesList: Array<[number, number]> = []): LightIndexes {
  const m = movies.map(([id, tmdbId]) => movie(id, tmdbId));
  const s = seriesList.map(([id, tmdbId]) => series(id, tmdbId));
  return {
    movies: new Map(m.map((x) => [x.id, x])),
    series: new Map(s.map((x) => [x.id, x])),
    live: new Map(),
    categories: new Map(),
    moviesByTmdb: new Map(m.map((x) => [x.tmdbId, x])),
    seriesByTmdb: new Map(s.map((x) => [x.tmdbId, x])),
    iconPrefixes: [],
  };
}

function tmdbMovie(id: number, extra: Record<string, unknown> = {}) {
  return { id, title: `Film ${id}`, poster_path: `/p${id}.jpg`, backdrop_path: `/b${id}.jpg`, vote_average: 7, overview: '', media_type: 'movie', ...extra };
}

function tmdbShow(id: number) {
  return { id, name: `Série ${id}`, poster_path: `/p${id}.jpg`, backdrop_path: null, vote_average: 8, overview: '', media_type: 'tv' };
}

const ids = (items: Array<{ id: string | number }>) => items.map((i) => i.id);

// Tendances TMDB : les films 10 et 20, la série 30
function seedTmdbCache() {
  cachedLists.set('trending', [tmdbMovie(10), tmdbMovie(20), tmdbShow(30)]);
  cachedLists.set('now_playing', [tmdbMovie(20), tmdbMovie(10)]);
  cachedLists.set('on_the_air', [tmdbShow(30)]);
  cachedLists.set('top_rated', [tmdbMovie(10)]);
  cachedLists.set('popular', [tmdbMovie(20)]);
}

// Ancien catalogue : seul le film 10 (numéro 1) et la série 30 (numéro 3)
const OLD = () => catalogue([[1, 10]], [[3, 30]]);
// Catalogue actualisé : film 10 renuméroté 99, film 20 ajouté (numéro 5), série 30 retirée
const NEW = () => catalogue([[99, 10], [5, 20]]);

// Catalogue stable d'un rendu à l'autre, comme dans l'app (état React de la session)
let oldIndexes: LightIndexes;

beforeEach(() => {
  oldIndexes = OLD();
  cachedLists.clear();
  clearDashboardCache();
  markDashboardLoaded();
  enabledGenres = [];
  vi.clearAllMocks();
  seedTmdbCache();
});

afterEach(() => {
  // Remis en état même si un test échoue en cours de route
  vi.mocked(getTmdbLanguage).mockReturnValue('fr-FR');
});

// ============================================================================
// TESTS
// ============================================================================

describe('useDashboardData — catalogue neuf', () => {
  it('premier chargement : rangées rapprochées du catalogue', async () => {
    const { result } = renderHook(() => useDashboardData(oldIndexes));
    await waitFor(() => expect(result.current.loadingHero).toBe(false));
    expect(ids(result.current.trendingContent)).toEqual([1, 3]);
    expect(ids(result.current.heroMovies)).toEqual([1]);
  });

  it('accueil affiché : un catalogue actualisé met les rangées à jour', async () => {
    const old = OLD();
    const { result, rerender } = renderHook(({ indexes }) => useDashboardData(indexes), {
      initialProps: { indexes: old },
    });
    await waitFor(() => expect(ids(result.current.trendingContent)).toEqual([1, 3]));

    rerender({ indexes: NEW() });

    // Nouveaux numéros, nouveauté du fournisseur présente, série retirée absente
    await waitFor(() => expect(ids(result.current.trendingContent)).toEqual([99, 5]));
    expect(ids(result.current.nowPlayingContent)).toEqual([5, 99]);
    expect(ids(result.current.popularContent)).toEqual([5]);
    expect(result.current.onTheAirContent).toEqual([]);
    expect(ids(result.current.heroMovies)).toEqual([99, 5]);
    expect(result.current.loadingHero).toBe(false);
  });

  it('accueil démonté : il revient directement avec le catalogue neuf, sans état « chargement »', async () => {
    const first = renderHook(() => useDashboardData(oldIndexes));
    await waitFor(() => expect(first.result.current.loadingHero).toBe(false));
    first.unmount();

    // Chemin « Actualiser » : préparation puis installation
    const fresh = NEW();
    const rematch = await computeDashboardRematch(fresh);
    act(() => { installDashboardRematch(rematch); });

    const second = renderHook(() => useDashboardData(fresh));
    expect(second.result.current.loadingHero).toBe(false);
    expect(ids(second.result.current.trendingContent)).toEqual([99, 5]);
    expect(ids(second.result.current.heroMovies)).toEqual([99, 5]);
  });

  it('le recalcul discret ne fait aucun appel réseau, même si les listes ont expiré', async () => {
    const { result, rerender } = renderHook(({ indexes }) => useDashboardData(indexes), {
      initialProps: { indexes: oldIndexes },
    });
    await waitFor(() => expect(ids(result.current.trendingContent)).toEqual([1, 3]));
    vi.mocked(tmdb.getMovieDetails).mockClear();

    // Listes expirées : le cache ne répond plus
    cachedLists.clear();
    rerender({ indexes: NEW() });

    // Rangées actuelles gardées, renumérotées ; titre retiré enlevé
    await waitFor(() => expect(ids(result.current.trendingContent)).toEqual([99]));
    expect(ids(result.current.heroMovies)).toEqual([99]);
    expect(tmdb.getTrending).not.toHaveBeenCalled();
    expect(tmdb.getNowPlaying).not.toHaveBeenCalled();
    expect(tmdb.getMovieDetails).not.toHaveBeenCalled();
    expect(result.current.loadingHero).toBe(false);
  });

  it('les logos déjà connus de la bannière sont gardés, sans réseau', async () => {
    vi.mocked(tmdb.getMovieDetails).mockResolvedValue({
      images: { logos: [{ file_path: '/logo10.png', iso_639_1: 'fr', vote_average: 5, width: 500, height: 100, aspect_ratio: 5 }] },
    } as never);
    const { result, rerender } = renderHook(({ indexes }) => useDashboardData(indexes), {
      initialProps: { indexes: oldIndexes },
    });
    await waitFor(() => expect(result.current.heroMovies[0]?.logoUrl).toBeTruthy());
    const logo = result.current.heroMovies[0].logoUrl;
    vi.mocked(tmdb.getMovieDetails).mockClear();

    rerender({ indexes: NEW() });

    await waitFor(() => expect(ids(result.current.heroMovies)).toEqual([99, 5]));
    expect(result.current.heroMovies[0].logoUrl).toBe(logo);
    expect(result.current.heroMovies[1].logoUrl).toBeUndefined();
    expect(tmdb.getMovieDetails).not.toHaveBeenCalled();
  });

  it('rien ne bouge quand le catalogue neuf donne les mêmes rangées (mise à jour du guide)', async () => {
    const { result, rerender } = renderHook(({ indexes }) => useDashboardData(indexes), {
      initialProps: { indexes: oldIndexes },
    });
    await waitFor(() => expect(ids(result.current.trendingContent)).toEqual([1, 3]));
    const before = result.current.trendingContent;

    // Relecture du même contenu (nouvel objet catalogue, mêmes numéros)
    const reread = OLD();
    rerender({ indexes: reread });

    await waitFor(() => expect(dashboardCache.baseFor?.moviesId).toBe(catalogTableId(reread.movies)));
    expect(result.current.trendingContent).toBe(before);
  });

  it('un recalcul commencé avant une déconnexion n\'est pas installé', async () => {
    const { result } = renderHook(() => useDashboardData(oldIndexes));
    await waitFor(() => expect(result.current.loadingHero).toBe(false));

    const rematch = await computeDashboardRematch(NEW());
    clearDashboardCache();

    expect(installDashboardRematch(rematch)).toBe(false);
    expect(dashboardCache.hasData).toBe(false);
  });

  it('le cache ne garde que l\'identité du catalogue, jamais ses tables', async () => {
    const { result } = renderHook(() => useDashboardData(oldIndexes));
    await waitFor(() => expect(result.current.loadingHero).toBe(false));
    const kept = Object.values(dashboardCache.baseFor ?? {});
    expect(kept).not.toContain(oldIndexes.movies);
    expect(kept).not.toContain(oldIndexes.series);
    expect(dashboardCache.baseFor).toEqual({
      moviesId: catalogTableId(oldIndexes.movies),
      seriesId: catalogTableId(oldIndexes.series),
      lang: 'fr-FR',
    });
  });

  it('changement de langue : rechargement complet, même si l\'émetteur n\'a pas vidé le cache', async () => {
    const { result } = renderHook(() => useDashboardData(oldIndexes));
    await waitFor(() => expect(ids(result.current.trendingContent)).toEqual([1, 3]));
    vi.mocked(getTmdbLanguage).mockReturnValue('en-US');
    cachedLists.set('trending', [tmdbMovie(10, { title: 'Movie 10' })]);

    act(() => { window.dispatchEvent(new Event(TMDB_LANGUAGE_EVENT)); });

    await waitFor(() => expect(result.current.trendingContent[0]?.title).toBe('Movie 10'));
    expect(dashboardCache.baseFor?.lang).toBe('en-US');
  });

  it('sans accueil déjà calculé, le recalcul ne prépare rien : l\'accueil se chargera normalement', async () => {
    const rematch = await computeDashboardRematch(NEW());
    expect(rematch.base).toBeNull();
    expect(rematch.genres).toBeNull();
  });

  it('réseau permis (bouton « Actualiser ») : listes expirées relues et logo des nouveaux films cherché', async () => {
    const first = renderHook(() => useDashboardData(oldIndexes));
    await waitFor(() => expect(first.result.current.loadingHero).toBe(false));
    first.unmount();

    cachedLists.delete('trending');
    vi.mocked(tmdb.getTrending).mockResolvedValue({ results: [tmdbMovie(20), tmdbMovie(10)] } as never);
    vi.mocked(tmdb.getMovieDetails).mockClear();

    const rematch = await computeDashboardRematch(NEW(), { allowNetwork: true });
    installDashboardRematch(rematch);

    expect(tmdb.getTrending).toHaveBeenCalledTimes(1);
    expect(ids(dashboardCache.trending)).toEqual([5, 99]);
    // Seul le nouveau film de la bannière est cherché (le film 10 était déjà affiché)
    expect(tmdb.getMovieDetails).toHaveBeenCalledTimes(1);
    expect(tmdb.getMovieDetails).toHaveBeenCalledWith(20);
  });
});

describe('useDashboardData — accueil chargé hors ligne', () => {
  function goOffline() {
    cachedLists.clear();
    const offline = async () => { throw new Error('Failed to fetch'); };
    for (const fn of [tmdb.getTrending, tmdb.getNowPlaying, tmdb.getOnTheAir, tmdb.getTopRated, tmdb.getPopular]) {
      vi.mocked(fn).mockImplementation(offline as never);
    }
  }
  function goOnline() {
    for (const fn of [tmdb.getTrending, tmdb.getNowPlaying, tmdb.getOnTheAir, tmdb.getTopRated, tmdb.getPopular]) {
      vi.mocked(fn).mockReset().mockResolvedValue({ results: [] } as never);
    }
    seedTmdbCache();
  }

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    goOnline();
    vi.restoreAllMocks();
  });

  it('un accueil vide n\'est pas gardé : le retour sur l\'accueil réessaie, sans « Actualiser »', async () => {
    goOffline();
    const first = renderHook(() => useDashboardData(oldIndexes));
    await waitFor(() => expect(first.result.current.loadingHero).toBe(false));
    expect(first.result.current.trendingContent).toEqual([]);
    expect(dashboardCache.hasData).toBe(false);
    first.unmount();

    goOnline();
    const second = renderHook(() => useDashboardData(oldIndexes));
    await waitFor(() => expect(ids(second.result.current.trendingContent)).toEqual([1, 3]));
    expect(dashboardCache.hasData).toBe(true);
  });

  it('listes lues mais aucun titre du catalogue (fournisseur sans TMDB) : accueil gardé, sans relecture au retour', async () => {
    const noTmdb = catalogue([[1, 0]]);
    const first = renderHook(() => useDashboardData(noTmdb));
    await waitFor(() => expect(first.result.current.loadingHero).toBe(false));
    expect(first.result.current.trendingContent).toEqual([]);
    expect(dashboardCache.hasData).toBe(true);
    first.unmount();

    const second = renderHook(() => useDashboardData(noTmdb));
    expect(second.result.current.loadingHero).toBe(false);
  });

  it('accueil affiché hors ligne : rempli dès le retour du réseau', async () => {
    goOffline();
    const { result } = renderHook(() => useDashboardData(oldIndexes));
    await waitFor(() => expect(result.current.loadingHero).toBe(false));
    expect(result.current.trendingContent).toEqual([]);

    goOnline();
    act(() => { window.dispatchEvent(new Event('online')); });

    await waitFor(() => expect(ids(result.current.trendingContent)).toEqual([1, 3]));
    expect(ids(result.current.heroMovies)).toEqual([1]);
  });
});

describe('useDashboardData — bannière restée vide (Chromecast)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(async () => {
    const { setCachedList } = await import('../../services/tmdbCacheSqlite');
    vi.mocked(setCachedList).mockImplementation(async (key: string, data: unknown[]) => { cachedLists.set(key, data); });
    vi.mocked(tmdb.getTrending).mockReset().mockResolvedValue({ results: [] } as never);
    vi.restoreAllMocks();
  });

  it('tendances en échec au premier chargement : rangées gardées, le retour sur l\'accueil remplit la bannière', async () => {
    cachedLists.delete('trending');
    vi.mocked(tmdb.getTrending).mockRejectedValueOnce(new Error('Failed to fetch'));
    const first = renderHook(() => useDashboardData(oldIndexes));
    await waitFor(() => expect(first.result.current.loadingHero).toBe(false));
    expect(first.result.current.heroMovies).toEqual([]);
    expect(ids(first.result.current.nowPlayingContent)).toEqual([1]);
    expect(dashboardCache.baseFor).toBeNull();
    first.unmount();

    vi.mocked(tmdb.getTrending).mockResolvedValue({ results: [tmdbMovie(10), tmdbMovie(20), tmdbShow(30)] } as never);
    const second = renderHook(() => useDashboardData(oldIndexes));
    // Rangées déjà là au retour, sans état « chargement » ; la bannière arrive avec la liste
    expect(second.result.current.loadingHero).toBe(false);
    expect(ids(second.result.current.nowPlayingContent)).toEqual([1]);
    await waitFor(() => expect(ids(second.result.current.heroMovies)).toEqual([1]));
    expect(dashboardCache.baseFor).not.toBeNull();
  });

  it('tendances téléchargées mais pas mises en cache : la bannière est quand même remplie', async () => {
    const { setCachedList } = await import('../../services/tmdbCacheSqlite');
    cachedLists.delete('trending');
    vi.mocked(setCachedList).mockImplementation(async (key: string, data: unknown[]) => {
      if (key !== 'trending') cachedLists.set(key, data);
    });
    vi.mocked(tmdb.getTrending).mockResolvedValue({ results: [tmdbMovie(10), tmdbMovie(20), tmdbShow(30)] } as never);
    const { result } = renderHook(() => useDashboardData(oldIndexes));
    await waitFor(() => expect(result.current.loadingHero).toBe(false));
    expect(ids(result.current.trendingContent)).toEqual([1, 3]);
    expect(ids(result.current.heroMovies)).toEqual([1]);
  });
});

describe('useDashboardData — rangées « genres »', () => {
  beforeEach(() => {
    enabledGenres = [28];
    cachedLists.set('genre_28', [tmdbMovie(20), tmdbMovie(10)]);
  });

  it('catalogue neuf : rangées « genres » recalculées depuis le cache, sans réseau', async () => {
    const { result, rerender } = renderHook(({ indexes }) => useDashboardData(indexes), {
      initialProps: { indexes: oldIndexes },
    });
    await waitFor(() => expect(ids(result.current.genreCarousels.get(28) ?? [])).toEqual([1]));

    rerender({ indexes: NEW() });

    await waitFor(() => expect(ids(result.current.genreCarousels.get(28) ?? [])).toEqual([5, 99]));
    expect(tmdb.getByGenre).not.toHaveBeenCalled();
  });

  it('retour sur l\'accueil avec le même catalogue : pas de recalcul', async () => {
    const indexes = oldIndexes;
    const first = renderHook(() => useDashboardData(indexes));
    await waitFor(() => expect(first.result.current.genreCarousels.get(28)).toBeDefined());
    first.unmount();
    const before = dashboardCache.genreCarousels;

    const second = renderHook(() => useDashboardData(indexes));
    await act(async () => { await Promise.resolve(); });
    expect(second.result.current.genreCarousels).toBe(before);
  });

  it('genre activé pendant que l\'accueil est démonté : il apparaît au retour', async () => {
    const indexes = oldIndexes;
    const first = renderHook(() => useDashboardData(indexes));
    await waitFor(() => expect(first.result.current.genreCarousels.get(28)).toBeDefined());
    first.unmount();

    enabledGenres = [28, 35];
    cachedLists.set('genre_35', [tmdbMovie(10)]);

    const second = renderHook(() => useDashboardData(indexes));
    await waitFor(() => expect(ids(second.result.current.genreCarousels.get(35) ?? [])).toEqual([1]));
  });

  it('genres désactivés : une installation ultérieure ne remet pas d\'anciens genres', async () => {
    const indexes = oldIndexes;
    const first = renderHook(() => useDashboardData(indexes));
    await waitFor(() => expect(first.result.current.genreCarousels.get(28)).toBeDefined());
    first.unmount();

    enabledGenres = [];
    const second = renderHook(() => useDashboardData(indexes));
    await waitFor(() => expect(second.result.current.genreCarousels.size).toBe(0));

    const rematch = await computeDashboardRematch(NEW());
    act(() => { installDashboardRematch(rematch); });
    expect(second.result.current.genreCarousels.size).toBe(0);
  });
});

describe('useDashboardData — sans compte ni clé TMDB (invité)', () => {
  beforeEach(() => {
    mockIsTmdbAvailable.mockResolvedValue(false);
    vi.mocked(tmdb.getTrending).mockClear();
    vi.mocked(tmdb.getNowPlaying).mockClear();
  });
  afterEach(() => {
    mockIsTmdbAvailable.mockResolvedValue(true);
  });

  it('aucune demande à TMDB : rangées TMDB vides, accueil prêt, et rien n\'est gardé comme « chargé »', async () => {
    const { result } = renderHook(() => useDashboardData(oldIndexes));
    await waitFor(() => expect(result.current.loadingHero).toBe(false));

    expect(tmdb.getTrending).not.toHaveBeenCalled();
    expect(tmdb.getNowPlaying).not.toHaveBeenCalled();
    expect(result.current.trendingContent).toEqual([]);
    expect(result.current.heroMovies).toEqual([]);
    expect(result.current.nowPlayingContent).toEqual([]);
    expect(dashboardCache.hasData).toBe(false);
  });

  it('les nouveautés de la semaine, qui viennent du fournisseur, restent calculées', async () => {
    const { result } = renderHook(() => useDashboardData(oldIndexes));
    await waitFor(() => expect(result.current.loadingHero).toBe(false));
    expect(Array.isArray(result.current.thisWeekMovies)).toBe(true);
  });
});

describe('useDashboardData — fournisseur sans numéro TMDB', () => {
  it('liens par le titre retentés tant que rien n\'est relié, cartes grises en attendant', async () => {
    const saved = { ...TITLE_LINKS_TIMING, retryMs: [...TITLE_LINKS_TIMING.retryMs] };
    TITLE_LINKS_TIMING.firstMs = 300;
    TITLE_LINKS_TIMING.retryMs = [5, 5];
    try {
      // Aucun numéro TMDB au catalogue
      const noIds = catalogue([[1, 0], [2, 0], [3, 0], [4, 0]]);
      // Premier essai : les listes TMDB n'étaient pas encore en cache (0 lien) ; deuxième : 3 liens
      mockLinkTitles.mockResolvedValueOnce(0).mockResolvedValueOnce(3);
      const { result } = renderHook(() => useDashboardData(noIds));
      await waitFor(() => expect(result.current.loadingHero).toBe(false));
      await waitFor(() => expect(result.current.linkingTitles).toBe(true));
      await waitFor(() => expect(mockLinkTitles).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(result.current.linkingTitles).toBe(false));
      // Relié au deuxième essai : plus d'essai ensuite
      await new Promise((r) => setTimeout(r, 30));
      expect(mockLinkTitles).toHaveBeenCalledTimes(2);
    } finally {
      TITLE_LINKS_TIMING.firstMs = saved.firstMs;
      TITLE_LINKS_TIMING.retryMs = saved.retryMs;
      mockLinkTitles.mockReset();
      mockLinkTitles.mockResolvedValue(0);
    }
  });

  it('retour sur l\'accueil après des essais finis : pas de nouvelles cartes grises', async () => {
    const saved = { ...TITLE_LINKS_TIMING, retryMs: [...TITLE_LINKS_TIMING.retryMs] };
    TITLE_LINKS_TIMING.firstMs = 5;
    TITLE_LINKS_TIMING.retryMs = [5];
    try {
      mockLinkTitles.mockResolvedValue(0);
      const noIds = catalogue([[1, 0], [2, 0], [3, 0], [4, 0]]);
      const first = renderHook(() => useDashboardData(noIds));
      await waitFor(() => expect(mockLinkTitles).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(first.result.current.linkingTitles).toBe(false));
      first.unmount();
      // L'accueil revient (changement d'onglet) avec le même catalogue : aucune carte grise
      const second = renderHook(() => useDashboardData(noIds));
      await waitFor(() => expect(second.result.current.loadingHero).toBe(false));
      expect(second.result.current.linkingTitles).toBe(false);
    } finally {
      TITLE_LINKS_TIMING.firstMs = saved.firstMs;
      TITLE_LINKS_TIMING.retryMs = saved.retryMs;
      mockLinkTitles.mockReset();
      mockLinkTitles.mockResolvedValue(0);
    }
  });

  it('catalogue relié par le fournisseur : jamais de cartes grises ni de nouvel essai inutile', async () => {
    const saved = { ...TITLE_LINKS_TIMING, retryMs: [...TITLE_LINKS_TIMING.retryMs] };
    TITLE_LINKS_TIMING.firstMs = 5;
    TITLE_LINKS_TIMING.retryMs = [5, 5];
    try {
      mockLinkTitles.mockResolvedValue(0);
      const withIds = catalogue([[1, 10], [2, 20]]);
      const { result } = renderHook(() => useDashboardData(withIds));
      await waitFor(() => expect(result.current.loadingHero).toBe(false));
      await waitFor(() => expect(mockLinkTitles).toHaveBeenCalledTimes(1));
      await new Promise((r) => setTimeout(r, 30));
      expect(result.current.linkingTitles).toBe(false);
      expect(mockLinkTitles).toHaveBeenCalledTimes(1);
    } finally {
      TITLE_LINKS_TIMING.firstMs = saved.firstMs;
      TITLE_LINKS_TIMING.retryMs = saved.retryMs;
      mockLinkTitles.mockReset();
      mockLinkTitles.mockResolvedValue(0);
    }
  });
});
