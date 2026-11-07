/**
 * Recherche mise à jour après une actualisation en arrière-plan : ligne à ligne pour les
 * numéros notés par Rust, reconstruction complète pour « all », note effacée seulement si
 * l'actualisation n'en a pas ajouté pendant le travail.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

let notes: Record<string, string> = {};
const executed: { sql: string; params: unknown[] }[] = [];
const names: Record<string, { id: number; name: string }[]> = { movies: [], series: [], live: [] };

const fakeDb = {
  select: vi.fn(async (sql: string, params: unknown[] = []): Promise<unknown[]> => {
    if (sql.includes('FROM meta')) {
      return Object.entries(notes).map(([key, value]) => ({ key, value }));
    }
    if (sql.includes('ORDER BY rowid DESC')) return [{ rowid: 50 }];
    if (sql.includes('FROM search_index')) {
      return (params.slice(1) as number[]).map((id) => ({ rowid: 1000 + id }));
    }
    const table = /FROM (movies|series|live)/.exec(sql)?.[1];
    if (table) return params.length > 0 ? names[table].filter((r) => params.includes(r.id)) : names[table];
    return [];
  }),
  execute: vi.fn(defaultExecute),
};
async function defaultExecute(sql: string, params: unknown[] = []) {
  executed.push({ sql, params });
  return { rowsAffected: 1 };
}
vi.mock('../dbCore', () => ({ getDatabase: vi.fn(async () => fakeDb) }));

import { applyPendingSearchChanges, rebuildSearchIndex, searchContent, SEARCH_NORM_VERSION } from '../searchIndex';

/** Index déjà fait avec la règle de normalisation actuelle (sinon il est refait en entier) */
const norm = { search_norm: SEARCH_NORM_VERSION };

beforeEach(() => {
  vi.clearAllMocks();
  fakeDb.execute.mockImplementation(defaultExecute);
  notes = {};
  executed.length = 0;
  names.movies = [];
  names.series = [];
  names.live = [];
});

describe('applyPendingSearchChanges', () => {
  it('sans note : rien à faire', async () => {
    notes = { ...norm };
    expect(await applyPendingSearchChanges()).toBe('none');
    expect(executed).toHaveLength(0);
  });

  it('ligne à ligne : supprime les lignes notées et réinsère les noms actuels (titre retiré non réinséré)', async () => {
    notes = { ...norm, search_dirty: '1', search_seq: '4', search_pending: JSON.stringify({ movie: [1, 2], live: [7] }) };
    names.movies = [{ id: 1, name: 'Été indien' }];
    names.live = [{ id: 7, name: 'TF1 HD' }];

    expect(await applyPendingSearchChanges()).toBe('delta');

    const deletes = executed.filter((e) => e.sql.startsWith('DELETE FROM search_index'));
    expect(deletes.map((d) => d.params)).toEqual([[1001, 1002], [1007]]);
    const inserts = executed.filter((e) => e.sql.startsWith('INSERT INTO search_index'));
    expect(inserts.map((i) => i.params)).toEqual([
      ['Été indien', 'ete indien', 'movie', 1],
      ['TF1 HD', 'tf1 hd', 'live', 7],
    ]);
    // Note effacée seulement si le compteur n'a pas bougé
    const clear = executed[executed.length - 1];
    expect(clear.sql).toContain("DELETE FROM meta WHERE key IN ('search_dirty', 'search_pending')");
    expect(clear.params).toEqual(['4']);
  });

  it('« all » : reconstruction complète sans jamais vider la recherche', async () => {
    notes = { ...norm, search_dirty: '1', search_seq: '9', search_pending: 'all' };
    names.series = [{ id: 3, name: 'Série' }];
    expect(await applyPendingSearchChanges()).toBe('rebuilt');
    // Nouvelles lignes d'abord, puis retrait des anciennes (numéros ≤ 50) d'un seul coup
    expect(executed.map((e) => e.sql.split(' (')[0])).toEqual([
      'INSERT INTO search_index',
      'DELETE FROM search_index WHERE rowid <= ?',
      'DELETE FROM meta WHERE key IN',
    ]);
    expect(executed[0].params).toEqual(['Série', 'serie', 'series', 3]);
    expect(executed[1].params).toEqual([50]);
    expect(executed[2].params).toEqual(['9']);
  });

  it('« all » arrêtée par une vidéo : rien n\'est effacé pendant la lecture, la note reste', async () => {
    notes = { ...norm, search_dirty: '1', search_seq: '9', search_pending: 'all' };
    names.movies = [{ id: 1, name: 'Film' }];
    let calls = 0;
    expect(await applyPendingSearchChanges(() => ++calls > 2)).toBe('stopped');
    // Les lignes ajoutées restent (doublons, un seul résultat par titre) : la reconstruction suivante
    // les compte parmi les anciennes et les retire avec elles
    expect(executed.map((e) => e.sql)).toEqual([expect.stringContaining('INSERT INTO search_index')]);
  });

  it('ligne à ligne arrêtée : la note reste pour le passage suivant', async () => {
    notes = { ...norm, search_dirty: '1', search_seq: '4', search_pending: JSON.stringify({ movie: [1] }) };
    expect(await applyPendingSearchChanges(() => true)).toBe('stopped');
    expect(executed).toHaveLength(0);
  });

  it('une reconstruction complète (connexion, « Rafraîchir ») efface les notes qu\'elle couvre', async () => {
    notes = { search_seq: '6' };
    await rebuildSearchIndex({ movies: [], series: [], live: [] });
    const clear = executed[executed.length - 1];
    expect(clear.sql).toContain("DELETE FROM meta WHERE key IN ('search_dirty', 'search_pending')");
  });

  it('app tuée pendant une reconstruction complète, la recherche est refaite au passage suivant', async () => {
    // Base simulée qui garde ses notes : l'écriture du 2e paquet de films n'aboutit jamais (app tuée)
    notes = { search_seq: '6' };
    let searchInserts = 0;
    fakeDb.execute.mockImplementation(async (sql: string, params: unknown[] = []) => {
      executed.push({ sql, params });
      if (sql.startsWith('INSERT OR REPLACE INTO meta')) {
        for (const [, key, value] of sql.matchAll(/\('(\w+)', '([^']*)'\)/g)) notes[key] = value;
      } else if (sql.startsWith('DELETE FROM meta')) {
        if (notes.search_seq === params[0]) { delete notes.search_dirty; delete notes.search_pending; }
      } else if (sql.startsWith('INSERT INTO search_index') && ++searchInserts === 2) {
        throw new Error('app tuée');
      }
      return { rowsAffected: 1 };
    });
    const movies = Array.from({ length: 600 }, (_, i) => ({ id: i + 1, name: `Film ${i + 1}` }));
    await expect(rebuildSearchIndex({ movies, series: [], live: [] })).rejects.toThrow('app tuée');

    // La note de reconstruction complète reste en base, au format lu par le Rust (« all » brut)
    expect(notes).toMatchObject({ search_dirty: '1', search_pending: 'all' });

    // Vérification suivante de l'actualisation automatique : index refait, note effacée
    names.movies = movies;
    expect(await applyPendingSearchChanges()).toBe('rebuilt');
    expect(notes.search_dirty).toBeUndefined();
  });

  it('une reconstruction complète terminée ne laisse aucune note', async () => {
    notes = { search_seq: '6' };
    await rebuildSearchIndex({ movies: [{ id: 1, name: 'Film' }], series: [], live: [] });
    expect(executed[0].sql).toContain("INSERT OR REPLACE INTO meta");
    expect(executed[0].sql).toContain("('search_pending', 'all')");
    // La note est posée avant de vider l'index, et effacée en dernier
    expect(executed[1].sql).toBe('DELETE FROM search_index');
    expect(executed[executed.length - 1].sql).toContain("DELETE FROM meta WHERE key IN ('search_dirty', 'search_pending')");
    // Juste avant : la marque de la règle de normalisation (posée avant d'effacer la note)
    expect(executed[executed.length - 2].params).toEqual([SEARCH_NORM_VERSION]);
  });

  it('un titre présent deux fois dans l\'index n\'apparaît qu\'une fois', async () => {
    fakeDb.select.mockResolvedValueOnce([
      { content_id: 1, name: 'Film', content_type: 'movie' },
      { content_id: 1, name: 'Film', content_type: 'movie' },
      { content_id: 1, name: 'Chaîne', content_type: 'live' },
    ]);
    expect(await searchContent('fi')).toEqual([
      { id: 1, name: 'Film', type: 'movie' },
      { id: 1, name: 'Chaîne', type: 'live' },
    ]);
  });
});
