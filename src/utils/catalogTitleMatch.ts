import type { LightIndexes } from '../types/lightIndex';

export interface CatalogMatch {
  type: 'movie' | 'series';
  id: number;
  tmdbId: number;
}

interface Entry {
  id: number;
  tmdbId: number;
  year?: number;
}

/** "EN - Dune: Part Two (2024) [4K]" and "Dune Part Two" -> "dune part two" */
export function normalizeTitle(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/^[a-z]{2,3}\s*[-:|]\s+/, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Year written in the provider's name: "Savage Mountain (2026)" -> 2026 */
export function catalogYear(raw: string): number | undefined {
  const m = raw.match(/[([]((?:19|20)\d{2})[)\]]/);
  return m ? Number(m[1]) : undefined;
}

type Index = { movie: Map<string, Entry[]>; series: Map<string, Entry[]> };
const INDEXES = new WeakMap<LightIndexes, Index>();

function buildIndex(light: LightIndexes): Index {
  const add = (map: Map<string, Entry[]>, name: string, entry: Omit<Entry, 'year'>) => {
    const key = normalizeTitle(name);
    if (!key) return;
    const list = map.get(key);
    const full = { ...entry, year: catalogYear(name) };
    if (list) list.push(full); else map.set(key, [full]);
  };
  const index: Index = { movie: new Map(), series: new Map() };
  light.movies.forEach((m) => add(index.movie, m.name, { id: m.id, tmdbId: m.tmdbId }));
  light.series.forEach((s) => add(index.series, s.name, { id: s.id, tmdbId: s.tmdbId }));
  return index;
}

/** Finds a TMDB title (movie or TV show) in the provider's catalogue by name, and year when both have one */
export function findCatalogTitle(light: LightIndexes, title: string, kind: 'movie' | 'tv', year?: number): CatalogMatch | null {
  let index = INDEXES.get(light);
  if (!index) {
    index = buildIndex(light);
    INDEXES.set(light, index);
  }
  const type = kind === 'movie' ? 'movie' : 'series';
  const candidates = index[type].get(normalizeTitle(title));
  if (!candidates?.length) return null;
  // Closest year first; a provider year more than 1 off is another film with the same name
  const fits = candidates
    .filter((c) => !year || !c.year || Math.abs(c.year - year) <= 1)
    .sort((a, b) => Math.abs((a.year ?? year ?? 0) - (year ?? 0)) - Math.abs((b.year ?? year ?? 0) - (year ?? 0)));
  const best = fits[0];
  return best ? { type, id: best.id, tmdbId: best.tmdbId } : null;
}
