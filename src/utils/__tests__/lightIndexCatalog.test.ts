/**
 * Catalogue compact : la reconstruction depuis les colonnes de
 * `load_light_catalog` doit donner EXACTEMENT le même catalogue que l'ancienne lecture ligne à ligne.
 *
 * `catalogFromRows` reproduit en TypeScript les règles de src-tauri/src/catalog_light.rs (registre des
 * préfixes, découpage des adresses, valeurs brutes) : c'est le contrat entre le cœur natif et
 * l'interface. Les tests Rust vérifient le même contrat de leur côté.
 */
import { describe, it, expect } from 'vitest';
import {
  buildLightIndexesFromCatalog,
  buildLightIndexesFromSQLite,
  countLightIndexDifferences,
  type LightCatalog,
} from '../lightIndexBuilder';
import type { MovieRow, SeriesRow, LiveRow, CategoryRow } from '../../types/repositories';

const prefixOf = (url: string): string | null => {
  if (!url) return null;
  const i = url.lastIndexOf('/');
  return i === -1 ? null : url.slice(0, i + 1);
};

function catalogFromRows(movies: MovieRow[], series: SeriesRow[], live: LiveRow[], categories: CategoryRow[]): LightCatalog {
  const counts = new Map<string, number>();
  for (const url of [...movies.map((m) => m.icon), ...series.map((s) => s.icon), ...live.map((l) => l.icon)]) {
    const p = prefixOf(url || '');
    if (p) counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  const iconPrefixes = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p);
  const ids = new Map(iconPrefixes.map((p, i) => [p, i]));
  const intern = (url: string | null): [number, string] => {
    if (!url) return [-1, ''];
    const p = prefixOf(url);
    return p !== null && ids.has(p) ? [ids.get(p)!, url.slice(p.length)] : [-1, url];
  };
  const col = <T, K extends keyof T>(rows: T[], key: K) => rows.map((r) => r[key]);
  return {
    iconPrefixes,
    movies: {
      id: col(movies, 'id'), name: col(movies, 'name'),
      iconPrefixId: movies.map((m) => intern(m.icon)[0]), iconSuffix: movies.map((m) => intern(m.icon)[1]),
      tmdbId: col(movies, 'tmdb_id'), categoryId: col(movies, 'category_id'), added: col(movies, 'added'),
      containerExtension: col(movies, 'container_extension'),
    },
    series: {
      id: col(series, 'id'), name: col(series, 'name'),
      iconPrefixId: series.map((s) => intern(s.icon)[0]), iconSuffix: series.map((s) => intern(s.icon)[1]),
      tmdbId: col(series, 'tmdb_id'), categoryId: col(series, 'category_id'), added: col(series, 'added'),
    },
    live: {
      id: col(live, 'id'), name: col(live, 'name'),
      iconPrefixId: live.map((l) => intern(l.icon)[0]), iconSuffix: live.map((l) => intern(l.icon)[1]),
      categoryId: col(live, 'category_id'), epgChannelId: col(live, 'epg_channel_id'),
      matchedEpgId: col(live, 'matched_epg_id'), matchMethod: col(live, 'match_method'),
    },
    categories: categories.map((c) => [c.id, c.name, c.type]),
  };
}

const movie = (id: number, name: string, icon: string | null, extra: Partial<MovieRow> = {}): MovieRow => ({
  id, name, icon, tmdb_id: null, category_id: '1', added: null, rating: null, container_extension: 'mkv', data: null, sort_order: 0, ...extra,
});
const serie = (id: number, name: string, icon: string | null, extra: Partial<SeriesRow> = {}): SeriesRow => ({
  id, name, icon, tmdb_id: null, category_id: '2', added: null, rating: null, data: null, sort_order: 0, ...extra,
});
const chaine = (id: number, name: string, icon: string | null, extra: Partial<LiveRow> = {}): LiveRow => ({
  id, name, icon, category_id: '3', epg_channel_id: null, matched_epg_id: null, match_method: null, data: null, sort_order: 0, ...extra,
});

// Catalogue piégé : égalités de fréquence (ordre de première apparition), adresses sans « / »,
// vides ou nulles, identifiants 0 (ignorés pour films et chaînes, pas pour séries), doublons d'id et
// de tmdb (le dernier l'emporte), valeurs nulles, adresse TMDB (réécrite à l'affichage seulement).
const movies = [
  movie(1, 'Matrix', 'http://b.com/img/matrix.jpg', { tmdb_id: 603, added: 1700000000 }),
  movie(2, 'Mask', 'http://a.com/p/mask.jpg', { tmdb_id: 854 }),
  movie(0, 'Fantôme', 'http://a.com/p/ghost.jpg'),
  movie(3, 'Sans barre', 'icone-seule.png', { container_extension: null }),
  movie(4, '', null, { category_id: null }),
  movie(2, 'Mask (doublon)', 'http://b.com/img/mask2.jpg', { tmdb_id: 854 }),
  movie(5, 'Tmdb', 'https://image.tmdb.org/t/p/w600_and_h900_bestv2/x.jpg', { tmdb_id: 603 }),
];
const series = [
  serie(0, 'Série zéro', 'http://a.com/p/s0.jpg', { tmdb_id: 1399 }),
  serie(7, 'GoT', '', { added: 5 }),
];
const live = [
  chaine(9, 'TF1', 'http://c.com/logos/tf1.png', { epg_channel_id: 'tf1.fr', matched_epg_id: 'tf1.fr', match_method: 'P1' }),
  chaine(0, 'Test', 'http://c.com/logos/x.png'),
  chaine(10, 'Sans logo', null, { epg_channel_id: '' }),
];
const categories: CategoryRow[] = [
  { id: '1', name: 'Films', type: 'movie', sort_order: 0 },
  { id: '3', name: 'Chaînes', type: 'live', sort_order: 1 },
  // Même numéro qu'une catégorie de films (fournisseur qui numérote chaque type à part)
  { id: '1', name: 'Chaînes 1', type: 'live', sort_order: 2 },
];

describe('buildLightIndexesFromCatalog — identique à la lecture ligne à ligne', () => {
  const before = buildLightIndexesFromSQLite(movies, series, live, categories);
  const after = buildLightIndexesFromCatalog(catalogFromRows(movies, series, live, categories));

  it('aucune différence (clés, champs, ordre, registre des préfixes)', () => {
    expect(countLightIndexDifferences(after, before)).toBe(0);
  });

  it('même contenu, en détail', () => {
    expect(after.iconPrefixes).toEqual(before.iconPrefixes);
    expect([...after.movies.entries()]).toEqual([...before.movies.entries()]);
    expect([...after.series.entries()]).toEqual([...before.series.entries()]);
    expect([...after.live.entries()]).toEqual([...before.live.entries()]);
    expect([...after.categories.entries()]).toEqual([...before.categories.entries()]);
    expect([...after.moviesByTmdb.keys()]).toEqual([...before.moviesByTmdb.keys()]);
    expect([...after.seriesByTmdb.keys()]).toEqual([...before.seriesByTmdb.keys()]);
  });

  it('numéro partagé entre films et chaînes : les deux catégories restent', () => {
    expect([...after.categories.values()].map((c) => `${c.type} ${c.name}`)).toEqual(['movie Films', 'live Chaînes', 'live Chaînes 1']);
  });

  it('le compteur de différences voit un écart', () => {
    const altered = buildLightIndexesFromCatalog(catalogFromRows(movies.map((m) => (m.id === 3 ? { ...m, name: 'Autre' } : m)), series, live, categories));
    expect(countLightIndexDifferences(altered, before)).toBeGreaterThan(0);
  });
});
