import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const find = vi.fn();
vi.mock('../titleTmdbLookup', () => ({ findTitleTmdbId: (...a: unknown[]) => find(...a) }));
vi.mock('../preferencesService', () => ({ isTmdbTitleSearchEnabled: () => true, getEnabledGenres: () => [] }));
const apply = vi.fn(() => true);
vi.mock('../titleTmdbLinkStore', () => ({ applyLinkInMemory: (...a: unknown[]) => (apply as (...x: unknown[]) => boolean)(...a) }));
vi.mock('../dashboardRematch', () => ({ computeDashboardRematch: vi.fn() }));
vi.mock('../dashboardCache', () => ({ installDashboardRematch: vi.fn() }));
vi.mock('../tmdbService', () => ({ tmdb: {} }));
let storedRows: unknown[] = [];
vi.mock('../dbCore', () => ({
  getDatabase: async () => ({ execute: vi.fn(), select: async () => storedRows }),
  getDatabaseFileName: () => 'a.db',
  getMeta: vi.fn(),
  setMeta: vi.fn(),
}));

import { linkRecentByTitle, linkTitlesByName, RECENT_LINK_LIMIT, RECENT_SEARCH_PER_LAUNCH } from '../titleTmdbLinks';
import type { LightIndexes } from '../../types/lightIndex';

const now = Math.floor(Date.now() / 1000);
function catalog(): LightIndexes {
  const movies = new Map<number, unknown>();
  for (let i = 1; i <= 30; i++) movies.set(i, { id: i, name: `Film ${i}`, tmdbId: 0, added: now - i * 60 });
  movies.set(99, { id: 99, name: 'Vieux', tmdbId: 0, added: now - 30 * 24 * 3600 });
  movies.set(98, { id: 98, name: 'Relié', tmdbId: 5, added: now - 10 });
  return { movies, series: new Map(), moviesByTmdb: new Map(), seriesByTmdb: new Map() } as unknown as LightIndexes;
}

function run(c: LightIndexes, still?: () => boolean) {
  const p = linkRecentByTitle(c, still);
  return vi.runAllTimersAsync().then(() => p);
}

/** find qui relie l'entrée comme le ferait la vraie recherche */
function linkOnCall(c: LightIndexes) {
  find.mockImplementation(async (_kind: string, id: number) => {
    (c.movies.get(id) as { tmdbId: number }).tmdbId = 7;
    return 7;
  });
}

describe('linkRecentByTitle', () => {
  beforeEach(() => { find.mockReset(); vi.useFakeTimers(); });
  afterEach(() => vi.useRealTimers());

  it('au plus 12 recherches par lancement, jamais les anciennes ni les déjà reliées, la suite au lancement suivant', async () => {
    const c = catalog();
    linkOnCall(c);
    expect(await run(c)).toBe(RECENT_SEARCH_PER_LAUNCH);
    const ids = find.mock.calls.map((call) => call[1]);
    expect(ids).toHaveLength(RECENT_SEARCH_PER_LAUNCH);
    expect(ids).not.toContain(99);
    expect(ids).not.toContain(98);
    // (la fenêtre compte les 20 plus récents, dont un déjà relié) Lancement suivant : repart là où il s'est arrêté, sans refaire les 12 premiers
    find.mockClear();
    expect(await run(c)).toBe(RECENT_LINK_LIMIT - 1 - RECENT_SEARCH_PER_LAUNCH);
    expect(find).toHaveBeenCalledTimes(RECENT_LINK_LIMIT - 1 - RECENT_SEARCH_PER_LAUNCH);
    // Tout est fait : plus rien
    find.mockClear();
    expect(await run(c)).toBe(0);
    expect(find).not.toHaveBeenCalled();
  });

  it('les versions d\'un même film (préfixe, qualité) ne coûtent qu\'une recherche', async () => {
    const movies = new Map<number, unknown>([
      [1, { id: 1, name: 'EN - Dune (2021)', tmdbId: 0, added: now - 10 }],
      [2, { id: 2, name: 'FR - Dune (2021)', tmdbId: 0, added: now - 20 }],
      [3, { id: 3, name: 'Dune 4K (2021)', tmdbId: 0, added: now - 30 }],
      [4, { id: 4, name: 'Dune (1984)', tmdbId: 0, added: now - 40 }],
    ]);
    const c = { movies, series: new Map(), moviesByTmdb: new Map(), seriesByTmdb: new Map() } as unknown as LightIndexes;
    find.mockResolvedValue(0);
    await run(c);
    const ids = find.mock.calls.map((call) => call[1]).sort();
    // Une recherche pour Dune 2021, une pour Dune 1984 (autre film)
    expect(ids).toHaveLength(2);
    expect(ids).toContain(4);
  });

  it('un titre déjà décidé en base (lien, ou « pas trouvé » récent) n\'est pas recherché de nouveau', async () => {
    const movies = new Map<number, unknown>([
      [1, { id: 1, name: 'Film A (2024)', tmdbId: 0, added: now - 10 }],
      [2, { id: 2, name: 'Film B (2024)', tmdbId: 0, added: now - 20 }],
      [3, { id: 3, name: 'Film C (2024)', tmdbId: 0, added: now - 30 }],
      [4, { id: 4, name: 'Film D (2024)', tmdbId: 0, added: now - 40 }],
    ]);
    const c = { movies, series: new Map(), moviesByTmdb: new Map(), seriesByTmdb: new Map() } as unknown as LightIndexes;
    const day = 24 * 3600 * 1000;
    storedRows = [
      { kind: 'movie', id: 1, name: 'Film A (2024)', tmdb_id: 55, checked_at: Date.now() - 90 * day }, // lien : jamais refait
      { kind: 'movie', id: 2, name: 'Film B (2024)', tmdb_id: 0, checked_at: Date.now() - 2 * day }, // pas trouvé récent
      { kind: 'movie', id: 3, name: 'Film C (2024)', tmdb_id: 0, checked_at: Date.now() - 40 * day }, // pas trouvé ancien : refait
      // Film D : nom changé depuis, la ligne ne compte plus
    ];
    find.mockResolvedValue(0);
    try { await run(c); } finally { storedRows = []; }
    expect(find.mock.calls.map((call) => call[1]).sort()).toEqual([3, 4]);
  });

  it('écran quitté en route : reprise possible au prochain passage', async () => {
    find.mockResolvedValue(0);
    const c = catalog();
    await run(c, () => false);
    expect(find).not.toHaveBeenCalled();
    await run(c);
    expect(find).toHaveBeenCalledTimes(RECENT_SEARCH_PER_LAUNCH);
  });

  it('deux appels en même temps ne font qu\'une série de recherches', async () => {
    const c = catalog();
    linkOnCall(c);
    const both = Promise.all([linkRecentByTitle(c), linkRecentByTitle(c)]);
    await vi.runAllTimersAsync();
    const [a, b] = await both;
    expect(a).toBe(RECENT_SEARCH_PER_LAUNCH);
    expect(b).toBe(RECENT_SEARCH_PER_LAUNCH);
    expect(find).toHaveBeenCalledTimes(RECENT_SEARCH_PER_LAUNCH);
  });
});

describe('linkTitlesByName', () => {
  beforeEach(() => apply.mockClear());

  it('relie un titre au nom exact et à la même année, jamais un autre film du même nom', async () => {
    const movies = new Map<number, unknown>([
      [1, { id: 1, name: 'Dune (2021)', tmdbId: 0, added: 0 }],
      [2, { id: 2, name: 'Dune (1984)', tmdbId: 0, added: 0 }],
      [3, { id: 3, name: 'Autre film', tmdbId: 0, added: 0 }],
    ]);
    const c = { movies, series: new Map(), moviesByTmdb: new Map(), seriesByTmdb: new Map() } as unknown as LightIndexes;
    const n = await linkTitlesByName(c, [{ kind: 'movie', tmdbId: 438631, titles: ['Dune'], year: 2021 }]);
    expect(n).toBe(1);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith(c, 'movie', 1, 438631);
  });

  it('un nom sans année et une série ne sont jamais reliés ici', async () => {
    const movies = new Map<number, unknown>([[1, { id: 1, name: 'Dune', tmdbId: 0, added: 0 }]]);
    const series = new Map<number, unknown>([[2, { id: 2, name: 'Dark (2017)', tmdbId: 0, added: 0 }]]);
    const c = { movies, series, moviesByTmdb: new Map(), seriesByTmdb: new Map() } as unknown as LightIndexes;
    expect(await linkTitlesByName(c, [{ kind: 'movie', tmdbId: 438631, titles: ['Dune'], year: 2021 }])).toBe(0);
    expect(await linkTitlesByName(c, [{ kind: 'series', tmdbId: 70523, titles: ['Dark'], year: 2017 }])).toBe(0);
    expect(apply).not.toHaveBeenCalled();
  });

  it('écran quitté pendant la comparaison : rien n\'est écrit, et la suite reste possible', async () => {
    const movies = new Map<number, unknown>([[1, { id: 1, name: 'Dune (2021)', tmdbId: 0, added: 0 }]]);
    const c = { movies, series: new Map(), moviesByTmdb: new Map(), seriesByTmdb: new Map() } as unknown as LightIndexes;
    const dune = [{ kind: 'movie' as const, tmdbId: 438631, titles: ['Dune'], year: 2021 }];
    expect(await linkTitlesByName(c, dune, () => false)).toBe(0);
    expect(apply).not.toHaveBeenCalled();
    expect(await linkTitlesByName(c, dune)).toBe(1);
  });

  it('les mêmes titres ne reparcourent pas le catalogue (fiche rouverte)', async () => {
    const movies = new Map<number, unknown>([[1, { id: 1, name: 'Dune (2021)', tmdbId: 0, added: 0 }]]);
    const c = { movies, series: new Map(), moviesByTmdb: new Map(), seriesByTmdb: new Map() } as unknown as LightIndexes;
    const dune = [{ kind: 'movie' as const, tmdbId: 438631, titles: ['Dune'], year: 2021 }];
    expect(await linkTitlesByName(c, dune)).toBe(1);
    apply.mockClear();
    expect(await linkTitlesByName(c, dune)).toBe(0);
    expect(apply).not.toHaveBeenCalled();
  });

  it('aucun titre donné : rien à faire', async () => {
    const c = { movies: new Map(), series: new Map(), moviesByTmdb: new Map(), seriesByTmdb: new Map() } as unknown as LightIndexes;
    expect(await linkTitlesByName(c, [])).toBe(0);
    expect(apply).not.toHaveBeenCalled();
  });
});
