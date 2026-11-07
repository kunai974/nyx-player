/**
 * Recherche dans toutes les langues : un nom en arabe, en russe, en grec ou en chinois doit rester
 * cherchable, et les lettres sans accent séparable (œ, ß, ı, ł, ø…) ne doivent pas disparaître.
 * Avant, la normalisation ne gardait que a-z et 0-9 : « مسلسل » devenait vide, « Cœur » devenait
 * « cur », et ces titres étaient introuvables.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let notes: Record<string, string> = {};
const executed: { sql: string; params: unknown[] }[] = [];
const indexRows: { content_id: number; name: string; content_type: string }[] = [];

const fakeDb = {
  select: vi.fn(async (sql: string, params: unknown[] = []): Promise<unknown[]> => {
    if (sql.includes('FROM meta')) return Object.entries(notes).map(([key, value]) => ({ key, value }));
    if (sql.includes('ORDER BY rowid DESC')) return [{ rowid: 10 }];
    if (sql.includes('MATCH')) {
      // Les `limit` premiers de chaque type (PARTITION BY content_type), films, séries puis chaînes
      const limit = params[1] as number;
      return ['movie', 'series', 'live'].flatMap((type) => indexRows.filter((r) => r.content_type === type).slice(0, limit));
    }
    return [];
  }),
  execute: vi.fn(async (sql: string, params: unknown[] = []) => {
    executed.push({ sql, params });
    const set = /INSERT OR REPLACE INTO meta \(key, value\) VALUES \('search_norm', \?\)/.test(sql);
    if (set) notes.search_norm = String(params[0]);
    return { rowsAffected: 1 };
  }),
};
vi.mock('../dbCore', () => ({ getDatabase: vi.fn(async () => fakeDb) }));

import { normalizeName, matchesSearch, searchContent, applyPendingSearchChanges, rebuildSearchIndex, SEARCH_NORM_VERSION } from '../searchIndex';

beforeEach(() => {
  vi.clearAllMocks();
  notes = {};
  executed.length = 0;
  indexRows.length = 0;
});

describe('normalizeName — toutes les écritures', () => {
  it('garde les lettres arabes, cyrilliques, grecques et chinoises', () => {
    expect(normalizeName('مسلسل الهيبة')).toBe('مسلسل الهيبة');
    expect(normalizeName('Кино 2024')).toBe('кино 2024');
    expect(normalizeName('Ελληνικά')).toBe('ελληνικα');
    expect(normalizeName('東京')).toBe('東京');
  });

  it('traduit les lettres sans accent séparable au lieu de les retirer', () => {
    expect(normalizeName('Cœur de pirate')).toBe('coeur de pirate');
    expect(normalizeName('Straße')).toBe('strasse');
    expect(normalizeName('Kırmızı Oda')).toBe('kirmizi oda');
    expect(normalizeName('Łódź')).toBe('lodz');
    expect(normalizeName('Søren Ærø')).toBe('soren aero');
    expect(normalizeName('İstanbul')).toBe('istanbul');
  });

  it('formes de compatibilité et sigma final : se tapent normalement', () => {
    expect(normalizeName('Ｔｏｋｙｏ')).toBe('tokyo');
    expect(normalizeName('TF1 ᴴᴰ')).toBe('tf1 hd');
    expect(normalizeName('𝐅𝐫𝐚𝐧𝐜𝐞 24')).toBe('france 24');
    expect(normalizeName('ﬁlm')).toBe('film');
    expect(normalizeName('ΟΔΥΣΣΕΑΣ')).toBe('οδυσσεασ');
    expect(matchesSearch('Οδυσσέας', 'οδυσσεας')).toBe(true);
  });

  it('garde la règle d\'avant pour l\'alphabet latin', () => {
    expect(normalizeName('Spider-Man')).toBe('spiderman');
    expect(normalizeName('Amélie Poulain')).toBe('amelie poulain');
    expect(normalizeName("L'Été  2  ")).toBe('lete 2');
    expect(normalizeName('|FR| TF1 ★ HD')).toBe('fr tf1 hd');
  });

  it('la recherche trouve ces titres comme on les tape', () => {
    expect(matchesSearch('مسلسل الهيبة', 'الهيبة')).toBe(true);
    expect(matchesSearch('Кино 2024', 'кин')).toBe(true);
    expect(matchesSearch('Cœur de pirate', 'coeur')).toBe(true);
    expect(matchesSearch('Cœur de pirate', 'cœur')).toBe(true);
    expect(matchesSearch('Kırmızı Oda', 'kirmizi')).toBe(true);
  });
});

describe('searchContent — une limite par type', () => {
  it('beaucoup de chaînes trouvées ne cachent pas les films', async () => {
    for (let i = 1; i <= 30; i++) indexRows.push({ content_id: i, name: `France ${i}`, content_type: 'live' });
    indexRows.push({ content_id: 100, name: 'France, une histoire', content_type: 'movie' });
    indexRows.push({ content_id: 200, name: 'France Série', content_type: 'series' });

    const results = await searchContent('france', 10);
    expect(results.filter((r) => r.type === 'live')).toHaveLength(10);
    expect(results.filter((r) => r.type === 'movie').map((r) => r.id)).toEqual([100]);
    expect(results.filter((r) => r.type === 'series').map((r) => r.id)).toEqual([200]);
  });

  it('cherche un nom en arabe', async () => {
    indexRows.push({ content_id: 7, name: 'مسلسل الهيبة', content_type: 'series' });
    const results = await searchContent('الهيبة');
    expect(results).toEqual([{ id: 7, name: 'مسلسل الهيبة', type: 'series' }]);
    const match = fakeDb.select.mock.calls.find(([sql]) => String(sql).includes('MATCH'));
    expect(match?.[1]).toEqual(['الهيبة*', 100]);
  });
});

describe('index de recherche fait avec l\'ancienne règle : refait une fois', () => {
  it('sans marque de version : reconstruction complète, puis marque posée', async () => {
    expect(await applyPendingSearchChanges()).toBe('rebuilt');
    expect(notes.search_norm).toBe(SEARCH_NORM_VERSION);
    expect(executed.some((e) => e.sql === 'DELETE FROM search_index WHERE rowid <= ?')).toBe(true);
  });

  it('marque à jour et aucune note : rien à faire', async () => {
    notes = { search_norm: SEARCH_NORM_VERSION };
    expect(await applyPendingSearchChanges()).toBe('none');
    expect(executed).toHaveLength(0);
  });

  it('une note ligne à ligne sur un ancien index : reconstruction complète quand même', async () => {
    notes = { search_dirty: '1', search_seq: '3', search_pending: JSON.stringify({ movie: [1] }) };
    expect(await applyPendingSearchChanges()).toBe('rebuilt');
    expect(notes.search_norm).toBe(SEARCH_NORM_VERSION);
  });

  it('arrêtée en route : la marque n\'est pas posée et rien n\'est effacé pendant la lecture', async () => {
    expect(await applyPendingSearchChanges(() => true)).toBe('stopped');
    expect(notes.search_norm).toBeUndefined();
    expect(executed.filter((e) => e.sql.startsWith('DELETE'))).toHaveLength(0);
  });

  it('arrêtée juste avant le retrait de l\'ancien index : rien n\'est effacé', async () => {
    let checks = 0;
    // 3 vérifications avant chaque type, celle des paquets (aucun ici), puis celle d'avant le retrait
    expect(await applyPendingSearchChanges(() => ++checks > 3)).toBe('stopped');
    expect(executed.filter((e) => e.sql.startsWith('DELETE'))).toHaveLength(0);
  });

  it('la reconstruction de la connexion pose la marque', async () => {
    await rebuildSearchIndex({ movies: [{ id: 1, name: 'Кино' }], series: [], live: [] });
    expect(notes.search_norm).toBe(SEARCH_NORM_VERSION);
    const insert = executed.find((e) => e.sql.startsWith('INSERT INTO search_index'));
    expect(insert?.params).toEqual(['Кино', 'кино', 'movie', 1]);
  });
});
