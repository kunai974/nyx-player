/**
 * Tests unitaires pour lightIndexBuilder.ts
 *
 * Fonction pure — mock uniquement devLog via vi.mock.
 */

import { describe, it, expect, vi } from 'vitest';
import { buildLightIndexesFromSQLite } from '../lightIndexBuilder';
import { categoryKey } from '../../types/lightIndex';
import type { MovieRow, SeriesRow, LiveRow, CategoryRow } from '../../types/repositories';

// ─── Mock devLog ────────────────────────────────────────────────────
vi.mock('../devLog', () => ({
  devLog: vi.fn(),
}));

// ─── Helpers: Fixtures ──────────────────────────────────────────────

/** Crée un MovieRow minimal */
function makeMovie(overrides: Partial<MovieRow> = {}): MovieRow {
  return {
    id: 1,
    tmdb_id: null,
    name: 'Test Movie',
    icon: 'http://provider.com/images/movie_1.jpg',
    category_id: '10',
    added: 1710000000,
    rating: null,
    container_extension: 'mp4',
    data: null,
    sort_order: 0,
    ...overrides,
  };
}

/** Crée un SeriesRow minimal */
function makeSeries(overrides: Partial<SeriesRow> = {}): SeriesRow {
  return {
    id: 1,
    tmdb_id: null,
    name: 'Test Series',
    icon: 'http://provider.com/images/series_1.jpg',
    category_id: '20',
    added: 1710000000,
    rating: null,
    data: null,
    sort_order: 0,
    ...overrides,
  };
}

/** Crée un LiveRow minimal */
function makeLive(overrides: Partial<LiveRow> = {}): LiveRow {
  return {
    id: 1,
    name: 'Test Live',
    icon: 'http://provider.com/images/live_1.jpg',
    category_id: '30',
    epg_channel_id: null,
    matched_epg_id: null,
    match_method: null,
    data: null,
    sort_order: 0,
    ...overrides,
  };
}

/** Crée un CategoryRow minimal */
function makeCategory(overrides: Partial<CategoryRow> = {}): CategoryRow {
  return {
    id: '10',
    name: 'Action',
    type: 'movie',
    sort_order: 0,
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('buildLightIndexesFromSQLite', () => {
  // ── Test 1: Données vides ──
  it('retourne des maps vides sans crash quand toutes les listes sont vides', () => {
    const result = buildLightIndexesFromSQLite([], [], [], []);

    expect(result.movies.size).toBe(0);
    expect(result.series.size).toBe(0);
    expect(result.live.size).toBe(0);
    expect(result.categories.size).toBe(0);
    expect(result.moviesByTmdb.size).toBe(0);
    expect(result.seriesByTmdb.size).toBe(0);
    expect(result.iconPrefixes).toEqual([]);
  });

  // ── Test 2: Movie basique ──
  it('indexe un movie avec icon et attribue un iconPrefixId ≥ 0', () => {
    const movie = makeMovie({ id: 42, name: 'Inception' });
    const result = buildLightIndexesFromSQLite([movie], [], [], []);

    expect(result.movies.size).toBe(1);
    const light = result.movies.get(42);
    expect(light).toBeDefined();
    expect(light!.name).toBe('Inception');
    expect(light!.iconPrefixId).toBeGreaterThanOrEqual(0);
    expect(light!.iconSuffix).toBe('movie_1.jpg');
  });

  // ── Test 3: Series basique ──
  it('indexe une series avec icon et tmdbId correct', () => {
    const series = makeSeries({ id: 7, name: 'Breaking Bad', tmdb_id: 1396 });
    const result = buildLightIndexesFromSQLite([], [series], [], []);

    expect(result.series.size).toBe(1);
    const light = result.series.get(7);
    expect(light).toBeDefined();
    expect(light!.name).toBe('Breaking Bad');
    expect(light!.tmdbId).toBe(1396);
    expect(light!.iconPrefixId).toBeGreaterThanOrEqual(0);
  });

  // ── Test 4: Live basique ──
  it('indexe un live avec icon', () => {
    const live = makeLive({ id: 99, name: 'CNN' });
    const result = buildLightIndexesFromSQLite([], [], [live], []);

    expect(result.live.size).toBe(1);
    const light = result.live.get(99);
    expect(light).toBeDefined();
    expect(light!.name).toBe('CNN');
    expect(light!.iconPrefixId).toBeGreaterThanOrEqual(0);
  });

  // ── Test 5: Category mapping ──
  it('mappe 3 catégories par id correctement', () => {
    const categories: CategoryRow[] = [
      makeCategory({ id: '10', name: 'Action', type: 'movie' }),
      makeCategory({ id: '20', name: 'Drama', type: 'series' }),
      makeCategory({ id: '30', name: 'News', type: 'live' }),
    ];
    const result = buildLightIndexesFromSQLite([], [], [], categories);

    expect(result.categories.size).toBe(3);
    expect(result.categories.get(categoryKey('movie', '10'))).toEqual({ id: '10', name: 'Action', type: 'movie' });
    expect(result.categories.get(categoryKey('series', '20'))).toEqual({ id: '20', name: 'Drama', type: 'series' });
    expect(result.categories.get(categoryKey('live', '30'))).toEqual({ id: '30', name: 'News', type: 'live' });
  });

  // Fournisseur qui numérote chaque type à part (retour Reddit du 02/11 : chaînes visibles, films et séries vides)
  it('même numéro pour un film, une série et une chaîne : les trois catégories restent', () => {
    const categories: CategoryRow[] = [
      makeCategory({ id: '1', name: 'Films FR', type: 'movie' }),
      makeCategory({ id: '1', name: 'Séries FR', type: 'series' }),
      makeCategory({ id: '1', name: 'TNT', type: 'live' }),
    ];
    const result = buildLightIndexesFromSQLite([], [], [], categories);
    expect([...result.categories.values()].map((c) => `${c.type} ${c.name}`)).toEqual(['movie Films FR', 'series Séries FR', 'live TNT']);
  });

  // ── Test 6: TMDB lookup index ──
  it('moviesByTmdb et seriesByTmdb contiennent uniquement les entrées avec tmdbId > 0', () => {
    const movies: MovieRow[] = [
      makeMovie({ id: 1, tmdb_id: 550 }),    // tmdbId > 0 → inclus
      makeMovie({ id: 2, tmdb_id: 680 }),    // tmdbId > 0 → inclus
      makeMovie({ id: 3, tmdb_id: 0 }),      // tmdbId = 0 → exclu
    ];
    const series: SeriesRow[] = [
      makeSeries({ id: 10, tmdb_id: 1396 }), // tmdbId > 0 → inclus
      makeSeries({ id: 11, tmdb_id: null }),  // tmdbId null → 0 → exclu
    ];
    const result = buildLightIndexesFromSQLite(movies, series, [], []);

    expect(result.moviesByTmdb.size).toBe(2);
    expect(result.moviesByTmdb.get(550)).toBeDefined();
    expect(result.moviesByTmdb.get(680)).toBeDefined();
    expect(result.moviesByTmdb.has(0)).toBe(false);

    expect(result.seriesByTmdb.size).toBe(1);
    expect(result.seriesByTmdb.get(1396)).toBeDefined();
  });

  // ── Test 7: String interning — même préfixe → même prefixId ──
  it('partage le même prefixId pour des URLs avec le même préfixe', () => {
    const movies: MovieRow[] = [
      makeMovie({ id: 1, icon: 'http://cdn.example.com/img/movie_a.jpg' }),
      makeMovie({ id: 2, icon: 'http://cdn.example.com/img/movie_b.jpg' }),
      makeMovie({ id: 3, icon: 'http://other.com/pics/movie_c.jpg' }),
    ];
    const result = buildLightIndexesFromSQLite(movies, [], [], []);

    const m1 = result.movies.get(1)!;
    const m2 = result.movies.get(2)!;
    const m3 = result.movies.get(3)!;

    // m1 et m2 partagent le même préfixe
    expect(m1.iconPrefixId).toBe(m2.iconPrefixId);
    // m3 a un préfixe différent
    expect(m1.iconPrefixId).not.toBe(m3.iconPrefixId);
    // Suffixes distincts
    expect(m1.iconSuffix).toBe('movie_a.jpg');
    expect(m2.iconSuffix).toBe('movie_b.jpg');
    expect(m3.iconSuffix).toBe('movie_c.jpg');
  });

  // ── Test 8: Icon URL vide → prefixId = -1 ──
  it('attribue iconPrefixId = -1 et iconSuffix vide quand icon est vide', () => {
    const movie = makeMovie({ id: 5, icon: '' });
    const result = buildLightIndexesFromSQLite([movie], [], [], []);

    const light = result.movies.get(5)!;
    expect(light.iconPrefixId).toBe(-1);
    expect(light.iconSuffix).toBe('');
  });

  // ── Test 9: ID = 0 filtré ──
  it('exclut les movies et live avec id = 0', () => {
    const movies: MovieRow[] = [
      makeMovie({ id: 0, name: 'Ghost Movie' }),
      makeMovie({ id: 1, name: 'Real Movie' }),
    ];
    const live: LiveRow[] = [
      makeLive({ id: 0, name: 'Ghost Live' }),
      makeLive({ id: 1, name: 'Real Live' }),
    ];
    const result = buildLightIndexesFromSQLite(movies, [], live, []);

    expect(result.movies.size).toBe(1);
    expect(result.movies.has(0)).toBe(false);
    expect(result.live.size).toBe(1);
    expect(result.live.has(0)).toBe(false);
  });

  // ── Test 10: Champs null/undefined → fallback '' ou 0 ──
  it('applique les fallback pour les champs null/undefined', () => {
    const movie = makeMovie({
      id: 8,
      name: null as unknown as string,
      icon: null,
      category_id: undefined as unknown as string | null,
      tmdb_id: null,
      added: null,
    });
    const result = buildLightIndexesFromSQLite([movie], [], [], []);

    const light = result.movies.get(8)!;
    expect(light.name).toBe('');
    expect(light.iconPrefixId).toBe(-1);
    expect(light.iconSuffix).toBe('');
    expect(light.categoryId).toBe('');
    expect(light.tmdbId).toBe(0);
    expect(light.added).toBe(0);
  });

  // ── Test 11 (T1e): epgChannelId mappé dans LightLive ──
  it('mappe epg_channel_id vers epgChannelId dans LightLive', () => {
    const live = makeLive({ id: 1, epg_channel_id: 'TF1.fr' });
    const result = buildLightIndexesFromSQLite([], [], [live], []);

    const light = result.live.get(1);
    expect(light).toBeDefined();
    expect(light!.epgChannelId).toBe('TF1.fr');
  });

  // ── Test 12 (T1f): epgChannelId null → undefined ──
  it('coerce epg_channel_id null en undefined dans LightLive', () => {
    const live = makeLive({ id: 2 }); // pas de epg_channel_id → null par défaut
    const result = buildLightIndexesFromSQLite([], [], [live], []);

    const light = result.live.get(2);
    expect(light).toBeDefined();
    expect(light!.epgChannelId).toBeUndefined();
  });
});
