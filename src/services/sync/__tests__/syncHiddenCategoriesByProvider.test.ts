/**
 * Catégories masquées avec les tables du cloud par fournisseur allumées : la catégorie 12 du
 * fournisseur A et la catégorie 12 du fournisseur B sont distinctes ; l'appareil (fournisseur A) ne
 * copie ni ne retire jamais celles de B, y compris par l'envoi groupé de l'écran des catégories ;
 * une ligne sans empreinte (ancienne version) compte pour la première source.
 * Base, cloud et préférences simulés.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

/* eslint-disable @typescript-eslint/no-explicit-any -- faux client Supabase : requêtes de forme libre */

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const USER = 'compte-a';

const state = vi.hoisted(() => ({
  deviceHash: null as string | null,
  meta: new Map<string, string>(),
  local: [] as { category_id: string; type: string }[],
  cloud: [] as Record<string, unknown>[],
  executed: [] as { sql: string; params: unknown[] }[],
  deletes: [] as { table: string; eq: Record<string, unknown>; in: Record<string, unknown[]> }[],
  upserts: [] as { table: string; rows: any; options: any }[],
  selects: [] as { table: string; eq: Record<string, unknown>; in: Record<string, unknown[]>; orders: string[] }[],
}));

vi.mock('../cloudScope', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../cloudScope')>()),
  providerTablesOn: () => true,
}));
vi.mock('../../preferencesService', () => ({
  getDeviceProviderHash: () => state.deviceHash,
  getLastProviderHash: () => 'preference-synchronisee',
}));
vi.mock('../../hiddenCategoriesService', () => ({ reloadHiddenCategoriesFromDb: vi.fn(async () => {}) }));
vi.mock('../../dbCore', () => ({
  getMeta: vi.fn(async (key: string) => state.meta.get(key) ?? null),
  setMeta: vi.fn(async (key: string, value: string) => { state.meta.set(key, value); }),
  isDatabaseOf: () => true,
  getDatabase: vi.fn(async () => ({
    select: async () => state.local,
    execute: async (sql: string, params: unknown[] = []) => { state.executed.push({ sql, params }); },
  })),
}));

/** Lignes du cloud qui répondent aux filtres d'une requête (égalité et listes) */
function matching(eq: Record<string, unknown>, inn: Record<string, unknown[]>) {
  return state.cloud.filter((row) => Object.entries(eq).every(([k, v]) => k === 'user_id' || row[k] === v)
    && Object.entries(inn).every(([k, vs]) => vs.includes(row[k])));
}

vi.mock('../../supabaseClient', () => ({
  supabase: {
    from: (table: string) => ({
      select: () => {
        const entry = { table, eq: {} as Record<string, unknown>, in: {} as Record<string, unknown[]>, orders: [] as string[] };
        state.selects.push(entry);
        const chain: any = {
          eq: (c: string, v: unknown) => { entry.eq[c] = v; return chain; },
          in: (c: string, vs: unknown[]) => { entry.in[c] = vs; return chain; },
          order: (c: string) => { entry.orders.push(c); return chain; },
          range: async () => ({ data: matching(entry.eq, entry.in), error: null }),
        };
        return chain;
      },
      delete: () => {
        const entry = { table, eq: {} as Record<string, unknown>, in: {} as Record<string, unknown[]> };
        state.deletes.push(entry);
        const chain: any = {
          eq: (c: string, v: unknown) => { entry.eq[c] = v; return chain; },
          in: (c: string, vs: unknown[]) => { entry.in[c] = vs; return chain; },
          then: (resolve: (r: unknown) => unknown) => resolve({ error: null }),
        };
        return chain;
      },
      upsert: (rows: any, options: any) => {
        state.upserts.push({ table, rows, options });
        return { then: (resolve: (r: unknown) => unknown) => resolve({ error: null }) };
      },
    }),
  },
}));

import { syncHiddenCategories } from '../syncHiddenCategories';
import { batchSyncHiddenCategoriesToCloud } from '../push/hiddenCategoriesBatch';
import { pushHiddenCategoryToCloud, pushHiddenCategoryDeleteToCloud } from '../push/hiddenCategoriesPush';
import { setCurrentSyncUserId } from '../syncState';
import type { SyncResult } from '../syncTypes';

const result = () => ({ hiddenCategories: { pulled: 0, pushed: 0 } }) as unknown as SyncResult;
const row = (hash: string, id: string, type = 'movie') => ({ user_id: USER, category_id: id, category_type: type, provider_hash: hash });
const baseline = () => JSON.parse(state.meta.get('sync_baseline:hidden_v2') ?? '{}') as Record<string, number>;
const inserted = () => state.executed.filter((e) => e.sql.startsWith('INSERT')).map((e) => e.params[0]);
const ON_CONFLICT = { onConflict: 'user_id,provider_hash,category_id,category_type' };

beforeEach(() => {
  state.deviceHash = A;
  state.meta.clear();
  state.local = [];
  state.cloud = [];
  state.executed = [];
  state.deletes = [];
  state.upserts = [];
  state.selects = [];
  setCurrentSyncUserId(USER);
});

describe('synchro des catégories masquées par fournisseur', () => {
  it('la catégorie 12 de B n\'est pas la 12 de A : ni copiée ici, ni prise pour celle de A', async () => {
    state.cloud = [row(B, '12')];
    state.local = [{ category_id: '12', type: 'movie' }];

    await syncHiddenCategories(USER, result());

    expect(state.selects[0].table).toBe('user_hidden_categories_v2');
    expect(state.selects[0].orders).toEqual(['provider_hash', 'category_type', 'category_id']);
    expect(state.upserts).toEqual([{
      table: 'user_hidden_categories_v2',
      rows: [{ user_id: USER, category_id: '12', category_type: 'movie', provider_hash: A }],
      options: ON_CONFLICT,
    }]);
    expect(inserted()).toEqual([]);
    expect(baseline()).toEqual({ [`${A}|12::movie`]: 0 });
  });

  it('ligne sans empreinte (ancienne version) : comptée pour la première source, copiée ici', async () => {
    state.cloud = [row('', '3', 'live')];
    await syncHiddenCategories(USER, result());
    expect(inserted()).toEqual(['3']);
    expect(baseline()).toEqual({ [`${A}|3::live`]: 0 });
  });

  it('réaffichée ici : retirée du cloud chez A seulement (copie sans empreinte comprise), B gardé', async () => {
    state.meta.set('sync_baseline:hidden_v2', JSON.stringify({ [`${A}|12::movie`]: 0, [`${B}|12::movie`]: 0 }));
    state.cloud = [row(A, '12'), row(B, '12')];

    await syncHiddenCategories(USER, result());

    expect(state.deletes).toEqual([{
      table: 'user_hidden_categories_v2',
      eq: { user_id: USER, category_type: 'movie' },
      in: { category_id: ['12'], provider_hash: [A, ''] },
    }]);
    expect(baseline()).toEqual({ [`${B}|12::movie`]: 0 });
  });

  it('le dernier accord des anciennes tables n\'est jamais lu : première synchro sans aucun retrait', async () => {
    state.meta.set('sync_baseline:hidden', JSON.stringify({ '12::movie': 0, '13::movie': 0 }));
    state.cloud = [row(A, '12')];
    state.local = [{ category_id: '13', type: 'movie' }];

    await syncHiddenCategories(USER, result());

    expect(state.deletes).toEqual([]);
    expect(state.executed.filter((e) => e.sql.startsWith('DELETE'))).toEqual([]);
    expect(inserted()).toEqual(['12']);
  });

  it('fournisseur de l\'appareil inconnu : rien n\'est lu ni envoyé', async () => {
    state.deviceHash = null;
    state.local = [{ category_id: '12', type: 'movie' }];
    await syncHiddenCategories(USER, result());
    expect(state.selects).toEqual([]);
    expect(state.upserts).toEqual([]);
  });
});

describe('envoi groupé de l\'écran des catégories, par fournisseur', () => {
  it('ne retire que les catégories de A qui ne sont plus masquées ; celles de B restent', async () => {
    state.cloud = [row(A, '1'), row(A, '2'), row(B, '2'), row(B, '9')];

    expect(await batchSyncHiddenCategoriesToCloud('movie', ['1'])).toBe(true);

    expect(state.upserts).toEqual([{
      table: 'user_hidden_categories_v2',
      rows: [{ user_id: USER, category_id: '1', category_type: 'movie', provider_hash: A }],
      options: ON_CONFLICT,
    }]);
    // Seules les lignes de A (et sans empreinte) sont lues pour chercher les catégories réaffichées
    expect(state.selects[0].in).toEqual({ provider_hash: [A, ''] });
    expect(state.selects[0].orders).toEqual(['provider_hash', 'category_id']);
    expect(state.deletes).toEqual([{
      table: 'user_hidden_categories_v2',
      eq: { user_id: USER, category_type: 'movie' },
      in: { category_id: ['2'], provider_hash: [A, ''] },
    }]);
  });

  it('tout réaffiché : seules les lignes de A sont retirées, le dernier accord de B gardé', async () => {
    state.meta.set('sync_baseline:hidden_v2', JSON.stringify({ [`${A}|1::movie`]: 0, [`${B}|1::movie`]: 0, [`${A}|4::live`]: 0 }));

    expect(await batchSyncHiddenCategoriesToCloud('movie', [])).toBe(true);

    expect(state.deletes).toEqual([{
      table: 'user_hidden_categories_v2',
      eq: { user_id: USER, category_type: 'movie' },
      in: { provider_hash: [A, ''] },
    }]);
    expect(baseline()).toEqual({ [`${B}|1::movie`]: 0, [`${A}|4::live`]: 0 });
  });

  it('fournisseur de l\'appareil inconnu : rien n\'est envoyé, sans erreur affichée', async () => {
    state.deviceHash = null;
    expect(await batchSyncHiddenCategoriesToCloud('movie', ['1'])).toBe(true);
    expect(state.upserts).toEqual([]);
    expect(state.deletes).toEqual([]);
  });
});

describe('envois d\'une seule catégorie, par fournisseur', () => {
  it('masquer : rangée chez le fournisseur de l\'appareil', async () => {
    pushHiddenCategoryToCloud('12', 'movie');
    await vi.waitFor(() => expect(baseline()).toEqual({ [`${A}|12::movie`]: 0 }));
    expect(state.upserts[0].rows).toEqual({ user_id: USER, category_id: '12', category_type: 'movie', provider_hash: A });
    expect(state.upserts[0].options).toEqual(ON_CONFLICT);
  });

  it('réafficher : ses lignes seulement, copie sans empreinte comprise', async () => {
    state.meta.set('sync_baseline:hidden_v2', JSON.stringify({ [`${A}|12::movie`]: 0, [`${B}|12::movie`]: 0 }));
    pushHiddenCategoryDeleteToCloud('12', 'movie');
    await vi.waitFor(() => expect(baseline()).toEqual({ [`${B}|12::movie`]: 0 }));
    expect(state.deletes[0].in).toEqual({ provider_hash: [A, ''] });
  });
});
