/**
 * Remise en ordre après un catalogue neuf (« Actualiser », rafraîchissement automatique) :
 * Ma liste re-liée sans renvoyer toute la liste au cloud, accueil installé avec le catalogue,
 * mémoire des fiches vidée, jamais d'erreur qui bloquerait l'actualisation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { LightIndexes } from '../../types/lightIndex';

// ============================================================================
// MOCKS
// ============================================================================

interface WatchRow { stream_id: number; tmdb_id: number; type: 'movie' | 'series' }
let watchlist: WatchRow[] = [];
const mockExecute = vi.fn();

vi.mock('../dbCore', () => ({
  getDatabase: vi.fn(async () => ({
    select: async (sql: string) => (sql.includes('stream_id')
      ? watchlist
      : watchlist.map(({ tmdb_id, type }) => ({ tmdb_id, type }))),
    execute: (...args: unknown[]) => mockExecute(...args),
  })),
  getDatabaseFileName: () => 'nyxplayer_a.db',
}));

vi.mock('../../utils/devLog', () => ({ devLog: vi.fn() }));

let providerHash: string | null = 'hash-actuel';
vi.mock('../preferencesService', () => ({
  getLastProviderHash: () => providerHash,
  isTmdbTitleSearchEnabled: () => true,
}));

const mockPush = vi.fn(async () => {});
vi.mock('../syncService', () => ({
  pushWatchlistUpdates: (...args: unknown[]) => mockPush(...(args as [])),
}));

const mockCompute = vi.fn();
const mockInstall = vi.fn();
const mockClearDashboard = vi.fn();
vi.mock('../dashboardRematch', () => ({
  computeDashboardRematch: (...args: unknown[]) => mockCompute(...args),
}));
vi.mock('../dashboardCache', () => ({
  installDashboardRematch: (...args: unknown[]) => mockInstall(...args),
  clearDashboardCache: () => mockClearDashboard(),
  getDashboardCacheGeneration: () => 7,
}));

const mockClearDetail = vi.fn();
vi.mock('../detailFetcher', () => ({
  clearDetailCache: () => mockClearDetail(),
}));

// ============================================================================
// IMPORTS APRÈS LES MOCKS
// ============================================================================

import {
  DASHBOARD_NETWORK_BUDGET_MS,
  applyRefreshedCatalog,
  prepareRefreshedCatalog,
  relinkWatchlistAfterRefresh,
  resetCatalogCaches,
} from '../catalogReconcile';
import { currentCatalogFor } from '../titleTmdbLinkStore';

function indexes(movies: Array<[number, number]>): LightIndexes {
  const byTmdb = new Map(movies.map(([id, tmdbId]) => [tmdbId, { id, tmdbId }]));
  return {
    movies: new Map(),
    series: new Map(),
    live: new Map(),
    categories: new Map(),
    moviesByTmdb: byTmdb as unknown as LightIndexes['moviesByTmdb'],
    seriesByTmdb: new Map(),
    iconPrefixes: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  providerHash = 'hash-actuel';
  watchlist = [];
  mockCompute.mockResolvedValue({ generation: 7, base: null, genres: null });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('relinkWatchlistAfterRefresh', () => {
  it('seuls les titres renumérotés sont réécrits et renvoyés au cloud', async () => {
    watchlist = [
      { stream_id: 1, tmdb_id: 10, type: 'movie' }, // renuméroté 99
      { stream_id: 2, tmdb_id: 20, type: 'movie' }, // inchangé
      { stream_id: 3, tmdb_id: 30, type: 'movie' }, // retiré par le fournisseur
    ];

    const onWatchlist = vi.fn();
    window.addEventListener('watchlistUpdated', onWatchlist);
    await relinkWatchlistAfterRefresh(indexes([[99, 10], [2, 20]]));
    window.removeEventListener('watchlistUpdated', onWatchlist);

    // Écran prévenu seulement à l'installation du catalogue (applyRefreshedCatalog)
    expect(onWatchlist).not.toHaveBeenCalled();
    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith([
      { tmdb_id: 10, media_type: 'movie', stream_id: 99, provider_hash: 'hash-actuel' },
    ]);
    // Aucune suppression de la ligne retirée : seul le titre renuméroté est réécrit, par un numéro
    // provisoire (1 → -1 → 99)
    const updates = mockExecute.mock.calls.filter(([sql]) => String(sql).startsWith('UPDATE'));
    expect(updates.map(([, params]) => params)).toEqual([[-1, 1, 'movie'], [99, -1, 'movie']]);
    expect(mockExecute.mock.calls.some(([sql]) => String(sql).startsWith('DELETE'))).toBe(false);
    expect(mockExecute.mock.calls.some(([, params]) => Array.isArray(params) && params.includes(30))).toBe(false);
  });

  it('session changée : Ma liste ni réécrite ni envoyée au cloud', async () => {
    watchlist = [{ stream_id: 1, tmdb_id: 10, type: 'movie' }];
    await relinkWatchlistAfterRefresh(indexes([[99, 10]]), () => false);
    expect(mockExecute).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('rien ne part au cloud quand aucun numéro n\'a changé', async () => {
    watchlist = [{ stream_id: 2, tmdb_id: 20, type: 'movie' }];
    await relinkWatchlistAfterRefresh(indexes([[2, 20]]));
    expect(mockPush).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('sans fournisseur connu, ne touche à rien', async () => {
    providerHash = null;
    watchlist = [{ stream_id: 1, tmdb_id: 10, type: 'movie' }];
    await relinkWatchlistAfterRefresh(indexes([[99, 10]]));
    expect(mockExecute).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
  });
});

describe('prepareRefreshedCatalog / applyRefreshedCatalog', () => {
  it('prépare l\'accueil avec les options données et garde le catalogue', async () => {
    const fresh = indexes([[99, 10]]);
    const rematch = { generation: 7, base: { rows: {}, key: {} }, genres: null };
    mockCompute.mockResolvedValue(rematch);

    const prepared = await prepareRefreshedCatalog(fresh, { allowNetwork: true });

    expect(mockCompute).toHaveBeenCalledWith(fresh, { allowNetwork: true });
    expect(prepared).toEqual({ indexes: fresh, dashboard: rematch });
  });

  it('TMDB trop lent : au-delà du délai, accueil recalculé depuis le cache seulement', async () => {
    vi.useFakeTimers();
    const fresh = indexes([[99, 10]]);
    const cacheOnly = { generation: 7, base: { rows: {}, key: {} }, genres: null };
    mockCompute.mockImplementation((_idx: unknown, opts: { allowNetwork?: boolean }) =>
      opts.allowNetwork ? new Promise(() => {}) : Promise.resolve(cacheOnly));

    const pending = prepareRefreshedCatalog(fresh, { allowNetwork: true });
    await vi.advanceTimersByTimeAsync(DASHBOARD_NETWORK_BUDGET_MS);
    const prepared = await pending;

    expect(prepared.dashboard).toBe(cacheOnly);
    expect(mockCompute).toHaveBeenLastCalledWith(fresh, { allowNetwork: false });
  });

  it('cache de l\'accueil vidé pendant la préparation : rien à installer', async () => {
    mockCompute.mockResolvedValue({ generation: 8, base: { rows: {}, key: {} }, genres: null });
    const prepared = await prepareRefreshedCatalog(indexes([[99, 10]]));
    expect(prepared.dashboard).toEqual({ generation: 7, base: null, genres: null });
  });

  it('ne lève jamais : un échec du recalcul ou de Ma liste laisse l\'actualisation se terminer', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockCompute.mockRejectedValue(new Error('SQLite occupé'));
    watchlist = [{ stream_id: 1, tmdb_id: 10, type: 'movie' }];
    mockExecute.mockRejectedValue(new Error('verrou'));

    const prepared = await prepareRefreshedCatalog(indexes([[99, 10]]));

    expect(prepared.dashboard).toEqual({ generation: 7, base: null, genres: null });
    warn.mockRestore();
  });

  it('installe catalogue et accueil dans le même geste, puis vide la mémoire des fiches', () => {
    const order: string[] = [];
    const setLightIndexes = vi.fn(() => { order.push('catalogue'); });
    mockInstall.mockImplementation(() => { order.push('accueil'); });
    mockClearDetail.mockImplementation(() => { order.push('fiches'); });
    const fresh = indexes([[99, 10]]);
    const dashboard = { generation: 7, base: null, genres: null };

    const onWatchlist = vi.fn(() => { order.push('ma liste'); });
    window.addEventListener('watchlistUpdated', onWatchlist);

    applyRefreshedCatalog({ indexes: fresh, dashboard }, setLightIndexes);
    window.removeEventListener('watchlistUpdated', onWatchlist);

    expect(setLightIndexes).toHaveBeenCalledWith(fresh);
    expect(mockInstall).toHaveBeenCalledWith(dashboard);
    // Ma liste relue avec le nouveau catalogue, dans le même geste
    expect(order).toEqual(['catalogue', 'accueil', 'ma liste', 'fiches']);
    // Catalogue à l'écran : celui où les fiches trouvées par le titre posent leurs liens
    expect(currentCatalogFor('nyxplayer_a.db')).toBe(fresh);
  });

  it('resetCatalogCaches vide l\'accueil et les fiches', () => {
    resetCatalogCaches();
    expect(mockClearDashboard).toHaveBeenCalledTimes(1);
    expect(mockClearDetail).toHaveBeenCalledTimes(1);
  });
});
