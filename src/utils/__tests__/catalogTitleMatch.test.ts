import { describe, it, expect } from 'vitest';
import { normalizeTitle, catalogYear, findCatalogTitle } from '../catalogTitleMatch';
import type { LightIndexes } from '../../types/lightIndex';

const light = (movies: Array<[number, string]>, series: Array<[number, string]> = []) => ({
  movies: new Map(movies.map(([id, name]) => [id, { id, name, tmdbId: 0 }])),
  series: new Map(series.map(([id, name]) => [id, { id, name, tmdbId: 0 }])),
}) as unknown as LightIndexes;

describe('catalogTitleMatch', () => {
  it('normalizes tags, year, accents and punctuation', () => {
    expect(normalizeTitle('EN - Amélie (2001) [4K]')).toBe('amelie');
    expect(normalizeTitle('Dune: Part Two')).toBe('dune part two');
  });
  it('reads the provider year', () => {
    expect(catalogYear('Savage Mountain (2026)')).toBe(2026);
    expect(catalogYear('Savage Mountain')).toBeUndefined();
  });
  it('finds a movie by name', () => {
    expect(findCatalogTitle(light([[7, 'Savage Mountain (2026)']]), 'Savage Mountain', 'movie', 2026)).toEqual({ type: 'movie', id: 7, tmdbId: 0 });
  });
  it('rejects a same-name film from another year', () => {
    expect(findCatalogTitle(light([[7, 'Savage Mountain (1990)']]), 'Savage Mountain', 'movie', 2026)).toBeNull();
  });
  it('looks in series for TV titles', () => {
    expect(findCatalogTitle(light([], [[3, 'Dark Winds']]), 'Dark Winds', 'tv')).toEqual({ type: 'series', id: 3, tmdbId: 0 });
  });
});
