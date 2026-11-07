/**
 * Recherche limitée par type : avec 200 films, 200 séries et 150 chaînes trouvés (550 au total, aucun
 * type tronqué), une lettre de plus qui ne garde rien doit afficher « aucun résultat » tout de suite,
 * pas les anciens résultats en attendant la recherche.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { LightIndexes, LightMovie, LightSeries, LightLive } from '../../types/lightIndex';

const searchContent = vi.fn();
vi.mock('../../services/searchIndex', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/searchIndex')>();
  return { ...actual, searchContent: (...args: unknown[]) => searchContent(...args) };
});
vi.mock('../../services/dbCore', () => ({ getDatabase: vi.fn() }));

import { useGlobalSearch } from '../useGlobalSearch';

const range = (from: number, n: number) => Array.from({ length: n }, (_, i) => from + i);
const movies = range(1, 200).map((id): LightMovie => ({ id, name: `Alpha ${id}`, tmdbId: id, iconPrefixId: -1, iconSuffix: '', categoryId: '1', added: 0, containerExt: '' }));
const series = range(1001, 200).map((id): LightSeries => ({ id, name: `Alpha ${id}`, tmdbId: id, iconPrefixId: -1, iconSuffix: '', categoryId: '2', added: 0 }));
const live = range(5001, 150).map((id): LightLive => ({ id, name: `Alpha ${id}`, iconPrefixId: -1, iconSuffix: '', categoryId: '3' }));

const indexes = {
  movies: new Map(movies.map((m) => [m.id, m])),
  series: new Map(series.map((s) => [s.id, s])),
  live: new Map(live.map((l) => [l.id, l])),
  moviesByTmdb: new Map(movies.map((m) => [m.tmdbId, m])),
  seriesByTmdb: new Map(series.map((s) => [s.tmdbId, s])),
  iconPrefixes: [],
} as unknown as LightIndexes;

describe('useGlobalSearch — limite par type', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    searchContent.mockReset();
    searchContent.mockImplementation(async (q: string) => (q === 'alpha'
      ? [
          ...movies.map((m) => ({ id: m.id, name: m.name, type: 'movie' })),
          ...series.map((s) => ({ id: s.id, name: s.name, type: 'series' })),
          ...live.map((l) => ({ id: l.id, name: l.name, type: 'live' })),
        ]
      : []));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('550 résultats sans type tronqué : une lettre qui ne garde rien vide l\'affichage aussitôt', async () => {
    const { result, rerender } = renderHook(({ q }) => useGlobalSearch(indexes, q, 300, 1000), { initialProps: { q: 'alpha' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(350); });
    expect(result.current.results.total).toBe(550);

    rerender({ q: 'alphaz' });
    expect(result.current.results.total).toBe(0);
  });
});
