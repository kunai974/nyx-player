/**
 * Reprises avec les tables du cloud par fournisseur allumées : la reprise n° 5 du fournisseur A et
 * la n° 5 du fournisseur B sont deux reprises distinctes (pas de reprise d'une source à l'autre) ;
 * l'appareil (fournisseur A) ne copie ni ne retire jamais celles de B ; une ligne sans empreinte
 * (ancienne version) compte pour la première source, et son retrait ne laisse pas de copie.
 * Base, cloud et préférences simulés.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

/* eslint-disable @typescript-eslint/no-explicit-any -- faux client Supabase : requêtes de forme libre */

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const USER = 'compte-a';
const T1 = '2026-11-01T10:00:00.000Z';
const T2 = '2026-11-02T10:00:00.000Z';

const state = vi.hoisted(() => ({
  deviceHash: null as string | null,
  meta: new Map<string, string>(),
  local: [] as Record<string, unknown>[],
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
vi.mock('../../dbCore', () => ({
  getMeta: vi.fn(async (key: string) => state.meta.get(key) ?? null),
  setMeta: vi.fn(async (key: string, value: string) => { state.meta.set(key, value); }),
  isDatabaseOf: () => true,
  getDatabase: vi.fn(async () => ({
    select: async (sql: string) => (sql.includes('FROM playback_progress') ? state.local : []),
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

import { syncPlayback } from '../syncPlayback';
import { pushPlaybackUpsertToCloud, pushPlaybackDeleteToCloud } from '../push/playbackPush';
import { setCurrentSyncUserId } from '../syncState';
import type { SyncResult } from '../syncTypes';

const result = () => ({ playback: { pulled: 0, pushed: 0 } }) as unknown as SyncResult;
const fields = (streamId: number, updatedAt: string, time = 600) => ({
  stream_id: streamId, content_type: 'movie', tmdb_id: 0, title: `Film ${streamId}`, poster_url: null,
  series_id: null, season_number: null, episode_number: null, next_episode_id: null, next_season: null,
  next_episode_number: null, time_seconds: time, duration_seconds: 6000, container_extension: null,
  updated_at: updatedAt,
});
const cloudRow = (hash: string, streamId: number, updatedAt = T1, time = 600) => (
  { user_id: USER, ...fields(streamId, updatedAt, time), provider_hash: hash }
);
const localRow = (streamId: number, updatedAt: string) => ({ ...fields(streamId, updatedAt), updated_at: Date.parse(updatedAt) });
const baseline = () => JSON.parse(state.meta.get('sync_baseline:playback_v2') ?? '{}') as Record<string, number>;
/** Reprises écrites dans la base de l'appareil : [numéro, position] */
const inserted = () => state.executed.filter((e) => e.sql.includes('INSERT INTO playback_progress'))
  .map((e) => [e.params[1], e.params[11]]);
const ON_CONFLICT = { onConflict: 'user_id,provider_hash,stream_id' };

beforeEach(() => {
  state.deviceHash = A;
  state.meta.clear();
  state.local = [];
  state.cloud = [];
  state.executed = [];
  state.deletes = [];
  state.upserts = [];
  state.fetchedTables = [];
  state.orders = [];
  setCurrentSyncUserId(USER);
  vi.stubGlobal('window', { dispatchEvent: vi.fn() });
});

describe('synchro des reprises par fournisseur', () => {
  it('la reprise n° 5 de B n\'est pas celle de A : ni reprise ici, ni prise pour celle de A', async () => {
    state.cloud = [cloudRow(B, 5, T2, 4000)];
    state.local = [localRow(5, T1)];

    await syncPlayback(USER, result());

    expect(state.fetchedTables).toEqual(['user_playback_progress_v2']);
    // La position de B, plus récente, n'écrase pas celle de A
    expect(inserted()).toEqual([]);
    expect(state.upserts).toHaveLength(1);
    expect(state.upserts[0].table).toBe('user_playback_progress_v2');
    expect(state.upserts[0].rows.map((r: any) => [r.stream_id, r.provider_hash])).toEqual([[5, A]]);
    expect(state.upserts[0].options).toEqual(ON_CONFLICT);
    expect(state.deletes).toEqual([]);
    expect(baseline()).toEqual({ [`${A}|5`]: Date.parse(T1) });
  });

  it('ligne sans empreinte (ancienne version) : comptée pour la première source, reprise ici', async () => {
    state.cloud = [cloudRow('', 7, T1, 1200)];

    await syncPlayback(USER, result());

    expect(inserted()).toEqual([[7, 1200]]);
    expect(state.upserts).toEqual([]);
    expect(baseline()).toEqual({ [`${A}|7`]: Date.parse(T1) });
  });

  it('même reprise avec et sans empreinte : la plus récente compte, retirée des deux ensuite', async () => {
    state.cloud = [cloudRow(A, 7, T2, 3000), cloudRow('', 7, T1, 1200)];
    await syncPlayback(USER, result());
    expect(inserted()).toEqual([[7, 3000]]);

    state.executed = [];
    await syncPlayback(USER, result());
    expect(state.deletes).toEqual([{
      table: 'user_playback_progress_v2',
      eq: { user_id: USER, stream_id: 7 },
      in: { provider_hash: [A, ''] },
    }]);
  });

  it('même reprise, la ligne sans empreinte plus récente : c\'est elle qui compte', async () => {
    state.cloud = [cloudRow(A, 7, T1, 1200), cloudRow('', 7, T2, 3000)];
    await syncPlayback(USER, result());
    expect(inserted()).toEqual([[7, 3000]]);
  });

  it('dernier accord d\'un autre fournisseur absent du cloud et d\'ici : gardé tel quel', async () => {
    state.meta.set('sync_baseline:playback_v2', JSON.stringify({ [`${B}|9`]: Date.parse(T1) }));
    state.cloud = [cloudRow(A, 5)];
    await syncPlayback(USER, result());
    expect(baseline()).toEqual({ [`${A}|5`]: Date.parse(T1), [`${B}|9`]: Date.parse(T1) });
  });

  it('retirée ici : retirée du cloud chez A seulement (copie sans empreinte comprise), B gardé', async () => {
    state.meta.set('sync_baseline:playback_v2', JSON.stringify({ [`${A}|5`]: Date.parse(T1), [`${B}|8`]: Date.parse(T1) }));
    state.cloud = [cloudRow(A, 5), cloudRow(B, 8)];

    await syncPlayback(USER, result());

    expect(state.deletes).toEqual([{
      table: 'user_playback_progress_v2',
      eq: { user_id: USER, stream_id: 5 },
      in: { provider_hash: [A, ''] },
    }]);
    expect(baseline()).toEqual({ [`${B}|8`]: Date.parse(T1) });
  });

  it('retirée sur un autre appareil du même fournisseur : retirée ici, rien d\'autre', async () => {
    state.meta.set('sync_baseline:playback_v2', JSON.stringify({ [`${A}|5`]: Date.parse(T1) }));
    state.local = [localRow(5, T1)];

    await syncPlayback(USER, result());

    expect(state.executed.map((e) => e.sql)).toEqual(['DELETE FROM playback_progress WHERE stream_id = ?']);
    expect(state.upserts).toEqual([]);
    expect(baseline()).toEqual({});
  });

  it('le dernier accord des anciennes tables n\'est jamais lu : première synchro sans aucun retrait', async () => {
    state.meta.set('sync_baseline:playback', JSON.stringify({ 5: Date.parse(T1), 6: Date.parse(T1) }));
    state.cloud = [cloudRow(A, 5)];
    state.local = [localRow(6, T1)];

    await syncPlayback(USER, result());

    expect(state.deletes).toEqual([]);
    expect(state.executed.filter((e) => e.sql.startsWith('DELETE'))).toEqual([]);
    expect(inserted()).toEqual([[5, 600]]);
    expect(state.upserts[0].rows.map((r: any) => r.stream_id)).toEqual([6]);
  });

  it('ligne à l\'empreinte illisible : ni reprise ici, ni retirée du cloud', async () => {
    state.cloud = [cloudRow('xyz', 4)];
    await syncPlayback(USER, result());
    expect(inserted()).toEqual([]);
    expect(state.deletes).toEqual([]);
    expect(state.upserts).toEqual([]);
  });

  it('lecture du cloud dans un ordre stable qui comprend le fournisseur (pages complètes)', async () => {
    await syncPlayback(USER, result());
    expect(state.orders).toEqual(['provider_hash', 'stream_id']);
  });

  it('fournisseur de l\'appareil inconnu : rien n\'est lu ni envoyé (jamais rangé chez un autre)', async () => {
    state.deviceHash = null;
    state.local = [localRow(5, T1)];

    await syncPlayback(USER, result());

    expect(state.fetchedTables).toEqual([]);
    expect(state.upserts).toEqual([]);
  });
});

describe('envois immédiats des reprises par fournisseur', () => {
  it('position enregistrée : rangée chez le fournisseur de l\'appareil', async () => {
    const at = Date.parse(T2);
    pushPlaybackUpsertToCloud(5, 'movie', { title: 'Film 5', time_seconds: 60, duration_seconds: 6000, updated_at: at });

    await vi.waitFor(() => expect(baseline()).toEqual({ [`${A}|5`]: at }));
    expect(state.upserts[0].table).toBe('user_playback_progress_v2');
    expect(state.upserts[0].rows.provider_hash).toBe(A);
    expect(state.upserts[0].options).toEqual(ON_CONFLICT);
  });

  it('reprise effacée : ses lignes seulement, copie sans empreinte comprise', async () => {
    state.meta.set('sync_baseline:playback_v2', JSON.stringify({ [`${A}|5`]: 1, [`${B}|5`]: 1 }));
    pushPlaybackDeleteToCloud(5);

    await vi.waitFor(() => expect(baseline()).toEqual({ [`${B}|5`]: 1 }));
    expect(state.deletes).toEqual([{
      table: 'user_playback_progress_v2',
      eq: { user_id: USER, stream_id: 5 },
      in: { provider_hash: [A, ''] },
    }]);
  });

  it('fournisseur de l\'appareil inconnu : rien n\'est envoyé', () => {
    state.deviceHash = null;
    pushPlaybackUpsertToCloud(5, 'movie', { title: 'Film 5', time_seconds: 60, duration_seconds: 6000 });
    pushPlaybackDeleteToCloud(5);
    expect(state.upserts).toEqual([]);
    expect(state.deletes).toEqual([]);
  });
});
