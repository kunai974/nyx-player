/**
 * Recherche : les versions d'un même titre sans numéro TMDB (préfixe, qualité) ne font qu'une carte quand le nom
 * donne la même année ; jamais deux films différents, jamais un nom sans année.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { LightIndexes, LightMovie } from '../../types/lightIndex';

const searchContent = vi.fn();
vi.mock('../../services/searchIndex', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/searchIndex')>();
  return { ...actual, searchContent: (...args: unknown[]) => searchContent(...args) };
});
vi.mock('../../services/dbCore', () => ({ getDatabase: vi.fn() }));
const hidden = new Set<string>();
vi.mock('../../services/hiddenCategoriesService', () => ({
  isHidden: (id: string, type: string) => hidden.has(`${id}::${type}`),
}));

import { useGlobalSearch } from '../useGlobalSearch';

const movie = (id: number, name: string, tmdbId = 0, categoryId = '1'): LightMovie => ({
  id, name, tmdbId, iconPrefixId: -1, iconSuffix: '', categoryId, added: 0, containerExt: '',
});

function run(movies: LightMovie[]) {
  const indexes = {
    movies: new Map(movies.map((m) => [m.id, m])),
    series: new Map(),
    live: new Map(),
    moviesByTmdb: new Map(),
    seriesByTmdb: new Map(),
    iconPrefixes: [],
  } as unknown as LightIndexes;
  searchContent.mockResolvedValue(movies.map((m) => ({ id: m.id, name: m.name, type: 'movie' })));
  return renderHook(() => useGlobalSearch(indexes, 'dune', 300, 1000));
}

describe('useGlobalSearch — versions sans numéro TMDB', () => {
  beforeEach(() => { vi.useFakeTimers(); searchContent.mockReset(); hidden.clear(); });
  afterEach(() => vi.useRealTimers());

  it('mêmes nom et année : une carte, trois sources ; un autre film du même nom reste à part', async () => {
    const { result } = run([
      movie(1, 'EN - Dune (2021)'),
      movie(2, 'FR - Dune (2021)'),
      movie(3, 'Dune 4K (2021)'),
      movie(4, 'Dune (1984)'),
    ]);
    await act(async () => { await vi.advanceTimersByTimeAsync(350); });
    const groups = result.current.results.movies;
    expect(groups.map((g) => g.sourceCount).sort()).toEqual([1, 3]);
  });

  it('noms sans année : jamais regroupés', async () => {
    const { result } = run([movie(1, 'Dune'), movie(2, 'FR - Dune')]);
    await act(async () => { await vi.advanceTimersByTimeAsync(350); });
    expect(result.current.results.movies).toHaveLength(2);
  });

  it('une version dans une catégorie masquée ne cache pas la carte des versions visibles', async () => {
    hidden.add('9::movie');
    const { result } = run([movie(1, 'XX - Dune (2021)', 0, '9'), movie(2, 'FR - Dune (2021)'), movie(3, 'Dune 4K (2021)')]);
    await act(async () => { await vi.advanceTimersByTimeAsync(350); });
    const groups = result.current.results.movies;
    expect(groups).toHaveLength(1);
    expect(groups[0].sourceCount).toBe(2);
    expect(groups[0].items.map((m) => m.id).sort()).toEqual([2, 3]);
  });

  it('saisons d\'une série : jamais une seule carte', async () => {
    const { result } = run([movie(1, 'Série (2020) S01'), movie(2, 'Série (2020) S02')]);
    await act(async () => { await vi.advanceTimersByTimeAsync(350); });
    expect(result.current.results.movies).toHaveLength(2);
  });
});
