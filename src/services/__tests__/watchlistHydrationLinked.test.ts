/**
 * Ma liste : une ligne sans numéro TMDB dont le titre a été relié par son nom (fournisseur sans numéro TMDB)
 * prend le nom et l'affiche TMDB au numéro du lien, pas ceux du fournisseur.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LightIndexes } from '../../types/lightIndex';

const requestMissing = vi.fn();
let watchlistRows: Array<Record<string, unknown>> = [];
let cacheRows: Array<Record<string, unknown>> = [];
let origins = new Map<string, string>();

vi.mock('../dbCore', () => ({
  getDatabase: vi.fn(() => Promise.resolve({
    select: vi.fn((sql: string) => Promise.resolve(sql.includes('FROM watchlist w') || sql.includes('FROM watchlist') ? watchlistRows : cacheRows)),
    execute: vi.fn(() => Promise.resolve()),
  })),
  getDatabaseFileName: vi.fn(() => 'test.db'),
}));
vi.mock('../tmdbApi', () => ({ default: { imageUrl: vi.fn((path: string) => `https://img.example/${path}`) } }));
vi.mock('../syncService', () => ({ pushWatchlistUpsertToCloud: vi.fn(), pushWatchlistDeleteToCloud: vi.fn() }));
vi.mock('../watchlistDetailsFill', () => ({ requestMissingWatchlistDetails: (refs: unknown) => requestMissing(refs) }));
vi.mock('../watchlistAvailability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../watchlistAvailability')>()),
  readWatchlistOrigins: vi.fn(() => Promise.resolve(origins)),
  deviceProviderHash: vi.fn(() => Promise.resolve('hash')),
}));

import { getHydratedWatchlist, isInWatchlist, invalidateWatchlistCache } from '../watchlistHydration';
import { rememberCurrentCatalog } from '../titleTmdbLinkStore';
import { watchlistRowKey } from '../watchlistAvailability';

const indexesWith = (tmdbId: number): LightIndexes => ({
  movies: new Map([[10, { id: 10, name: 'FR - Nom du fournisseur', tmdbId, icon: '', categoryId: 1 }]]),
  series: new Map(),
  moviesByTmdb: new Map(),
  seriesByTmdb: new Map(),
  iconPrefixes: [],
} as unknown as LightIndexes);

/** Fiches demandées à TMDB, tous appels confondus */
const requested = () => requestMissing.mock.calls.flatMap(([refs]) => refs as unknown[]);

describe('Ma liste : titre relié par son nom', () => {
  beforeEach(() => {
    requestMissing.mockClear();
    origins = new Map();
    watchlistRows = [{ stream_id: 10, tmdb_id: 0, type: 'movie', added_at: 1, display_name: null, poster_path: null }];
  });

  it('prend le nom et l\'affiche TMDB de la fiche en cache au numéro du lien', async () => {
    cacheRows = [{ tmdb_id: 603, type: 'movie', display_name: 'Matrix', poster_path: '/matrix.jpg' }];
    const [item] = await getHydratedWatchlist(indexesWith(603));
    expect(item.name).toBe('Matrix');
    expect(item.posterUrl).toBe('https://img.example//matrix.jpg');
    expect(requested()).toEqual([]);
  });

  it('fiche pas encore en cache : demandée à TMDB par le numéro du lien', async () => {
    cacheRows = [];
    await getHydratedWatchlist(indexesWith(603));
    expect(requested()).toEqual([{ tmdb_id: 603, type: 'movie' }]);
  });

  it('titre noté comme venant d\'un autre fournisseur : jamais le nom ni l\'affiche de l\'entrée qui a repris son numéro', async () => {
    cacheRows = [{ tmdb_id: 603, type: 'movie', display_name: 'Matrix', poster_path: '/matrix.jpg' }];
    origins = new Map([[watchlistRowKey(10, 'movie'), 'autre-fournisseur']]);
    const [item] = await getHydratedWatchlist(indexesWith(603));
    expect(item.name).not.toBe('Matrix');
    expect(requested()).toEqual([]);
  });

  it('titre sans lien : le nom du fournisseur reste, rien n\'est demandé', async () => {
    cacheRows = [];
    const [item] = await getHydratedWatchlist(indexesWith(0));
    expect(item.name).toBe('FR - Nom du fournisseur');
    expect(requested()).toEqual([]);
  });
});

describe('Ma liste : doublons et bouton pour un titre relié par son nom', () => {
  const twoVersions = (): LightIndexes => ({
    movies: new Map([
      [100, { id: 100, name: 'Dune', tmdbId: 438631, icon: '', categoryId: 1 }],
      [200, { id: 200, name: 'Dune 4K', tmdbId: 438631, icon: '', categoryId: 1 }],
    ]),
    series: new Map(),
    moviesByTmdb: new Map(),
    seriesByTmdb: new Map(),
    iconPrefixes: [],
  } as unknown as LightIndexes);

  beforeEach(() => {
    requestMissing.mockClear();
    origins = new Map();
    cacheRows = [{ tmdb_id: 438631, type: 'movie', display_name: 'Dune', poster_path: '/dune.jpg' }];
    invalidateWatchlistCache();
  });

  it('une ligne ajoutée avant le lien et celle de sa version 4K ne font qu\'une carte', async () => {
    watchlistRows = [
      { stream_id: 200, tmdb_id: 438631, type: 'movie', added_at: 2, display_name: 'Dune', poster_path: '/dune.jpg' },
      { stream_id: 100, tmdb_id: 0, type: 'movie', added_at: 1, display_name: null, poster_path: null },
    ];
    const items = await getHydratedWatchlist(twoVersions());
    expect(items).toHaveLength(1);
    expect(items[0].stream_id).toBe(200);
  });

  it("le bouton ne se dit « dans la liste » que s'il peut retirer le titre (ligne sans numéro : pas de clé TMDB)", async () => {
    rememberCurrentCatalog(twoVersions());
    watchlistRows = [{ stream_id: 100, tmdb_id: 0, type: 'movie', added_at: 1, display_name: null, poster_path: null }];
    // Fiche ouverte sur la version 4K : numéro de source 200, numéro TMDB du lien
    expect(await isInWatchlist(200, 438631, 'movie')).toBe(false);
    expect(await isInWatchlist(100, 0, 'movie')).toBe(true);
    expect(await isInWatchlist(300, 999, 'movie')).toBe(false);
  });
});
