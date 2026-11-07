/**
 * Favoris TV avec les tables du cloud par fournisseur allumées : le n° 5 du fournisseur A et le
 * n° 5 du fournisseur B sont deux favoris distincts ; la synchro de l'appareil (fournisseur A) ne
 * copie ni ne retire jamais ceux de B ; une ligne sans empreinte (ancienne version) compte pour la
 * première source, et son retrait ne laisse pas de copie qui reviendrait.
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
  localFavs: [] as number[],
  localPins: [] as string[],
  cloud: [] as Record<string, unknown>[],
  executed: [] as { sql: string; params: unknown[] }[],
  deletes: [] as { table: string; eq: Record<string, unknown>; in: Record<string, unknown[]> }[],
  upserts: [] as { table: string; rows: any; options: any }[],
  fetchedTables: [] as string[],
  orders: [] as string[],
}));

vi.mock('../cloudScope', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../cloudScope')>()),
  providerTablesOn: () => true,
}));
vi.mock('../../preferencesService', () => ({
  getDeviceProviderHash: () => state.deviceHash,
  getLastProviderHash: () => 'preference-synchronisee',
}));
vi.mock('../../liveTvBookmarksService', () => ({ reloadLiveTvFromDb: vi.fn(async () => {}) }));
vi.mock('../../dbCore', () => ({
  getMeta: vi.fn(async (key: string) => state.meta.get(key) ?? null),
  setMeta: vi.fn(async (key: string, value: string) => { state.meta.set(key, value); }),
  isDatabaseOf: () => true,
  getDatabase: vi.fn(async () => ({
    select: async (sql: string) => (sql.includes('live_tv_favorites')
      ? state.localFavs.map((stream_id) => ({ stream_id }))
      : state.localPins.map((category_id) => ({ category_id }))),
    execute: async (sql: string, params: unknown[] = []) => { state.executed.push({ sql, params }); },
  })),
}));
vi.mock('../../supabaseClient', () => ({
  supabase: {
    from: (table: string) => ({
      select: () => {
        state.fetchedTables.push(table);
        const chain: any = {
          eq: () => chain,
          order: (column: string) => { state.orders.push(column); return chain; },
          range: async () => ({ data: state.cloud, error: null }),
        };
        return chain;
      },
      delete: () => {
        const entry = { table, eq: {} as Record<string, unknown>, in: {} as Record<string, unknown[]> };
        state.deletes.push(entry);
        const chain: any = {
          eq: (column: string, value: unknown) => { entry.eq[column] = value; return chain; },
          in: (column: string, values: unknown[]) => { entry.in[column] = values; return chain; },
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

import { syncLiveTv } from '../syncLiveTv';
import { pushLiveTvBookmarkDeleteToCloud, pushLiveTvBookmarkUpsertToCloud } from '../push/liveTvPush';
import { setCurrentSyncUserId } from '../syncState';
import type { SyncResult } from '../syncTypes';

const result = () => ({ liveTv: { pulled: 0, pushed: 0 } }) as unknown as SyncResult;
const fav = (hash: string, id: string) => ({ user_id: USER, bookmark_type: 'favorite', item_id: id, provider_hash: hash });
const baseline = () => JSON.parse(state.meta.get('sync_baseline:livetv_v2') ?? '{}') as Record<string, number>;
const inserted = () => state.executed.filter((e) => e.sql.startsWith('INSERT')).map((e) => e.params[0]);

beforeEach(() => {
  state.deviceHash = A;
  state.meta.clear();
  state.localFavs = [];
  state.localPins = [];
  state.cloud = [];
  state.executed = [];
  state.deletes = [];
  state.upserts = [];
  state.fetchedTables = [];
  state.orders = [];
  setCurrentSyncUserId(USER);
});

describe('synchro des favoris TV par fournisseur', () => {
  it('le n° 5 de B n\'est pas le n° 5 de A : ni copié ici, ni pris pour le favori de A', async () => {
    state.cloud = [fav(B, '5')];
    state.localFavs = [5];

    await syncLiveTv(USER, result());

    expect(state.fetchedTables).toEqual(['user_livetv_bookmarks_v2']);
    // Le n° 5 de A part au cloud, rangé chez A ; celui de B reste à B
    expect(state.upserts).toHaveLength(1);
    expect(state.upserts[0].table).toBe('user_livetv_bookmarks_v2');
    expect(state.upserts[0].rows).toEqual([{ user_id: USER, bookmark_type: 'favorite', item_id: '5', provider_hash: A }]);
    expect(state.upserts[0].options).toEqual({ onConflict: 'user_id,provider_hash,bookmark_type,item_id' });
    expect(inserted()).toEqual([]);
    expect(state.deletes).toEqual([]);
    expect(Object.keys(baseline())).toEqual([`${A}|favorite::5`]);
  });

  it('ligne sans empreinte (ancienne version) : comptée pour la première source, copiée ici', async () => {
    state.cloud = [fav('', '7')];

    await syncLiveTv(USER, result());

    expect(inserted()).toEqual([7]);
    expect(state.upserts).toEqual([]);
    expect(baseline()).toEqual({ [`${A}|favorite::7`]: 0 });
  });

  it('retiré ici : retiré du cloud chez A seulement (copie sans empreinte comprise), le dernier accord de B gardé', async () => {
    state.meta.set('sync_baseline:livetv_v2', JSON.stringify({ [`${A}|favorite::5`]: 0, [`${B}|favorite::8`]: 0 }));
    state.cloud = [fav(A, '5'), fav(B, '8')];
    state.localFavs = [];

    await syncLiveTv(USER, result());

    expect(state.deletes).toEqual([{
      table: 'user_livetv_bookmarks_v2',
      eq: { user_id: USER, bookmark_type: 'favorite', item_id: '5' },
      in: { provider_hash: [A, ''] },
    }]);
    expect(baseline()).toEqual({ [`${B}|favorite::8`]: 0 });
  });

  it('retiré sur un autre appareil du même fournisseur : retiré ici, rien d\'autre', async () => {
    state.meta.set('sync_baseline:livetv_v2', JSON.stringify({ [`${A}|favorite::5`]: 0 }));
    state.cloud = [];
    state.localFavs = [5];

    await syncLiveTv(USER, result());

    expect(state.executed.map((e) => e.sql)).toEqual(['DELETE FROM live_tv_favorites WHERE stream_id = ?']);
    expect(state.upserts).toEqual([]);
  });

  it('le dernier accord des anciennes tables n\'est jamais lu : première synchro sans aucun retrait', async () => {
    state.meta.set('sync_baseline:livetv', JSON.stringify({ 'favorite::5': 0, 'favorite::6': 0 }));
    state.cloud = [fav(A, '5')];
    state.localFavs = [6];

    await syncLiveTv(USER, result());

    expect(state.deletes).toEqual([]);
    expect(state.executed.filter((e) => e.sql.startsWith('DELETE'))).toEqual([]);
    expect(inserted()).toEqual([5]);
  });

  it('même favori en double dans le cloud (avec et sans empreinte) : copié une fois, retiré des deux', async () => {
    state.cloud = [fav('', '7'), fav(A, '7')];
    await syncLiveTv(USER, result());
    expect(inserted()).toEqual([7]);

    state.executed = [];
    state.localFavs = [];
    await syncLiveTv(USER, result());
    expect(state.deletes).toEqual([{
      table: 'user_livetv_bookmarks_v2',
      eq: { user_id: USER, bookmark_type: 'favorite', item_id: '7' },
      in: { provider_hash: [A, ''] },
    }]);
  });

  it('ligne à l\'empreinte illisible : ni copiée ici, ni retirée du cloud', async () => {
    state.cloud = [fav('xyz', '4')];
    await syncLiveTv(USER, result());
    expect(inserted()).toEqual([]);
    expect(state.deletes).toEqual([]);
    expect(state.upserts).toEqual([]);
  });

  it('lecture du cloud dans un ordre stable qui comprend le fournisseur (pages complètes)', async () => {
    await syncLiveTv(USER, result());
    expect(state.orders).toEqual(['provider_hash', 'bookmark_type', 'item_id']);
  });

  it('fournisseur de l\'appareil inconnu : rien n\'est lu ni envoyé (jamais rangé chez un autre)', async () => {
    state.deviceHash = null;
    state.localFavs = [5];

    await syncLiveTv(USER, result());

    expect(state.fetchedTables).toEqual([]);
    expect(state.upserts).toEqual([]);
  });
});

describe('envois immédiats des favoris TV par fournisseur', () => {
  it('ajout : rangé chez le fournisseur de l\'appareil, pas celui de la préférence synchronisée', async () => {
    pushLiveTvBookmarkUpsertToCloud('favorite', '5');

    await vi.waitFor(() => expect(baseline()).toEqual({ [`${A}|favorite::5`]: 0 }));
    expect(state.upserts).toEqual([{
      table: 'user_livetv_bookmarks_v2',
      rows: { user_id: USER, bookmark_type: 'favorite', item_id: '5', provider_hash: A },
      options: { onConflict: 'user_id,provider_hash,bookmark_type,item_id' },
    }]);
  });

  it('retrait : ses lignes seulement, copie sans empreinte comprise', async () => {
    state.meta.set('sync_baseline:livetv_v2', JSON.stringify({ [`${A}|favorite::5`]: 0, [`${B}|favorite::5`]: 0 }));
    pushLiveTvBookmarkDeleteToCloud('favorite', '5');

    await vi.waitFor(() => expect(baseline()).toEqual({ [`${B}|favorite::5`]: 0 }));
    expect(state.deletes).toEqual([{
      table: 'user_livetv_bookmarks_v2',
      eq: { user_id: USER, bookmark_type: 'favorite', item_id: '5' },
      in: { provider_hash: [A, ''] },
    }]);
  });

  it('fournisseur de l\'appareil inconnu : rien n\'est envoyé', () => {
    state.deviceHash = null;
    pushLiveTvBookmarkUpsertToCloud('favorite', '5');
    pushLiveTvBookmarkDeleteToCloud('favorite', '5');
    expect(state.upserts).toEqual([]);
    expect(state.deletes).toEqual([]);
  });
});
