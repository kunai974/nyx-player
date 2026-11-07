/**
 * Tests pour liveTvBookmarksService.ts : favoris TV et catégories épinglées (cache + SQLite + cloud).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockDb = {
  select: vi.fn<(sql: string, params?: unknown[]) => Promise<unknown[]>>(),
  execute: vi.fn<(sql: string, params?: unknown[]) => Promise<void>>(),
};

vi.mock('../dbCore', () => ({
  getDatabase: vi.fn(() => Promise.resolve(mockDb)),
}));

vi.mock('../syncService', () => ({
  pushLiveTvBookmarkDeleteToCloud: vi.fn(),
  pushLiveTvBookmarkUpsertToCloud: vi.fn(),
}));

import {
  initLiveTvBookmarks,
  resetLiveTvBookmarksCache,
  reloadLiveTvFromDb,
  getFavorites,
  getPinnedCategories,
  toggleFavorite,
  togglePinnedCategory,
} from '../liveTvBookmarksService';
import { getDatabase } from '../dbCore';
import { pushLiveTvBookmarkDeleteToCloud, pushLiveTvBookmarkUpsertToCloud } from '../syncService';
import { LIVE_TV_BOOKMARKS_EVENT } from '../eventConstants';

let events: Array<{ type: string }>;
const listener = (e: Event) => { events.push((e as CustomEvent).detail); };

function seedDb(favs: number[], pins: string[]) {
  mockDb.select.mockImplementation((sql: string) => {
    if (sql.includes('live_tv_favorites')) return Promise.resolve(favs.map(stream_id => ({ stream_id })));
    return Promise.resolve(pins.map(category_id => ({ category_id })));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetLiveTvBookmarksCache();
  mockDb.execute.mockResolvedValue(undefined);
  seedDb([], []);
  events = [];
  window.removeEventListener(LIVE_TV_BOOKMARKS_EVENT, listener);
  window.addEventListener(LIVE_TV_BOOKMARKS_EVENT, listener);
});

describe('liveTvBookmarksService - initialisation', () => {
  it('charge les favoris et les catégories épinglées dans le cache', async () => {
    seedDb([1, 2], ['a']);
    await initLiveTvBookmarks();
    expect(getFavorites()).toEqual(new Set([1, 2]));
    expect(getPinnedCategories()).toEqual(new Set(['a']));
    expect(events).toEqual([{ type: 'init' }]);
  });

  it('ne relit pas la base une seconde fois', async () => {
    await initLiveTvBookmarks();
    mockDb.select.mockClear();
    await initLiveTvBookmarks();
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it('reste muet et permet une nouvelle tentative si la base échoue', async () => {
    vi.mocked(getDatabase).mockRejectedValueOnce(new Error('fermée'));
    await expect(initLiveTvBookmarks()).resolves.toBeUndefined();
    expect(events).toEqual([]);
    seedDb([5], []);
    await initLiveTvBookmarks();
    expect(getFavorites()).toEqual(new Set([5]));
  });

  it('vide le cache et prévient l\'interface à la réinitialisation', async () => {
    seedDb([1], ['a']);
    await initLiveTvBookmarks();
    events = [];
    resetLiveTvBookmarksCache();
    expect(getFavorites().size).toBe(0);
    expect(getPinnedCategories().size).toBe(0);
    expect(events).toEqual([{ type: 'reset' }]);
  });

  it('recharge le cache depuis la base après une synchro cloud', async () => {
    await initLiveTvBookmarks();
    seedDb([9], ['z']);
    events = [];
    await reloadLiveTvFromDb();
    expect(getFavorites()).toEqual(new Set([9]));
    expect(getPinnedCategories()).toEqual(new Set(['z']));
    expect(events).toEqual([{ type: 'reload' }]);
  });

  it('garde l\'ancien cache si le rechargement échoue', async () => {
    seedDb([1], []);
    await initLiveTvBookmarks();
    vi.mocked(getDatabase).mockRejectedValueOnce(new Error('KO'));
    await reloadLiveTvFromDb();
    expect(getFavorites()).toEqual(new Set([1]));
  });

  it('renvoie des copies défensives', async () => {
    seedDb([1], ['a']);
    await initLiveTvBookmarks();
    getFavorites().add(99);
    getPinnedCategories().add('hack');
    expect(getFavorites().has(99)).toBe(false);
    expect(getPinnedCategories().has('hack')).toBe(false);
  });
});

describe('liveTvBookmarksService - favoris', () => {
  it('ajoute un favori : cache, SQL et cloud', async () => {
    const added = await toggleFavorite(42);
    expect(added).toBe(true);
    expect(getFavorites().has(42)).toBe(true);
    const [sql, params] = mockDb.execute.mock.calls[0];
    expect(sql).toContain('INSERT OR IGNORE INTO live_tv_favorites');
    expect(params?.[0]).toBe(42);
    expect(pushLiveTvBookmarkUpsertToCloud).toHaveBeenCalledWith('favorite', '42');
    expect(events).toEqual([{ type: 'favorite', streamId: 42 }]);
  });

  it('retire un favori existant : cache, SQL et cloud', async () => {
    await toggleFavorite(42);
    vi.clearAllMocks();
    const added = await toggleFavorite(42);
    expect(added).toBe(false);
    expect(getFavorites().has(42)).toBe(false);
    expect(mockDb.execute).toHaveBeenCalledWith('DELETE FROM live_tv_favorites WHERE stream_id = ?', [42]);
    expect(pushLiveTvBookmarkDeleteToCloud).toHaveBeenCalledWith('favorite', '42');
    expect(pushLiveTvBookmarkUpsertToCloud).not.toHaveBeenCalled();
  });

  it('annule l\'ajout du cache si l\'écriture SQL échoue', async () => {
    mockDb.execute.mockRejectedValueOnce(new Error('SQL'));
    await toggleFavorite(7);
    expect(getFavorites().has(7)).toBe(false);
    expect(pushLiveTvBookmarkUpsertToCloud).not.toHaveBeenCalled();
  });

  it('renvoie false quand l\'écriture SQL de l\'ajout échoue', async () => {
    mockDb.execute.mockRejectedValueOnce(new Error('SQL'));
    expect(await toggleFavorite(7)).toBe(false);
  });

  it('après un échec SQL, un 2e événement live-tv-bookmarks est émis pour que l\'affichage revienne en arrière', async () => {
    mockDb.execute.mockRejectedValueOnce(new Error('SQL'));
    await toggleFavorite(7);
    expect(events).toHaveLength(2);
  });

  it('remet le favori dans le cache si la suppression SQL échoue', async () => {
    await toggleFavorite(7);
    mockDb.execute.mockRejectedValueOnce(new Error('SQL'));
    await toggleFavorite(7);
    expect(getFavorites().has(7)).toBe(true);
  });
});

describe('liveTvBookmarksService - catégories épinglées', () => {
  it('épingle une catégorie : cache, SQL et cloud', async () => {
    const pinned = await togglePinnedCategory('cat1');
    expect(pinned).toBe(true);
    expect(getPinnedCategories().has('cat1')).toBe(true);
    const [sql, params] = mockDb.execute.mock.calls[0];
    expect(sql).toContain('INSERT OR IGNORE INTO live_tv_pinned_categories');
    expect(params?.[0]).toBe('cat1');
    expect(pushLiveTvBookmarkUpsertToCloud).toHaveBeenCalledWith('pinned_category', 'cat1');
    expect(events).toEqual([{ type: 'pinned', categoryId: 'cat1' }]);
  });

  it('désépingle une catégorie', async () => {
    await togglePinnedCategory('cat1');
    vi.clearAllMocks();
    expect(await togglePinnedCategory('cat1')).toBe(false);
    expect(getPinnedCategories().has('cat1')).toBe(false);
    expect(mockDb.execute).toHaveBeenCalledWith(
      'DELETE FROM live_tv_pinned_categories WHERE category_id = ?',
      ['cat1']
    );
    expect(pushLiveTvBookmarkDeleteToCloud).toHaveBeenCalledWith('pinned_category', 'cat1');
  });

  it('annule le cache si l\'écriture échoue', async () => {
    mockDb.execute.mockRejectedValueOnce(new Error('SQL'));
    await togglePinnedCategory('cat2');
    expect(getPinnedCategories().has('cat2')).toBe(false);
  });

  it('renvoie false quand l\'écriture SQL de l\'épinglage échoue', async () => {
    mockDb.execute.mockRejectedValueOnce(new Error('SQL'));
    expect(await togglePinnedCategory('cat2')).toBe(false);
  });

  it('après un échec SQL, un 2e événement est émis pour que l\'affichage revienne en arrière (épinglage)', async () => {
    mockDb.execute.mockRejectedValueOnce(new Error('SQL'));
    await togglePinnedCategory('cat2');
    expect(events).toHaveLength(2);
  });

  it('rétablit la catégorie si la suppression échoue', async () => {
    await togglePinnedCategory('cat2');
    mockDb.execute.mockRejectedValueOnce(new Error('SQL'));
    await togglePinnedCategory('cat2');
    expect(getPinnedCategories().has('cat2')).toBe(true);
  });
});
