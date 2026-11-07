/**
 * Tables du cloud par fournisseur allumées : la préférence du fournisseur partagée par le compte
 * (`last_provider_hash`) n'est plus jamais écrite, ni sur l'appareil ni dans le cloud. Les appareils
 * restés sur une ancienne version la comparent à leur fournisseur et effaceraient leurs données
 * si elle changeait. Un changement de fournisseur n'efface plus rien dans le cloud : chaque
 * fournisseur y garde ses données. « Supprimer aussi mes données cloud » vide aussi les nouvelles tables.
 * Base, cloud et interrupteur simulés.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

/* eslint-disable @typescript-eslint/no-explicit-any -- faux client Supabase : requêtes de forme libre */

const USER = 'compte-a';

const state = vi.hoisted(() => ({
  meta: new Map<string, string>(),
  localPrefs: [] as { key: string; value: string; updated_at: number }[],
  cloudPrefs: [] as { key: string; value: string; updated_at: string }[],
  executed: [] as { sql: string; params: unknown[] }[],
  upserts: [] as { table: string; rows: any }[],
  deletes: [] as string[],
  selects: [] as string[],
}));

vi.mock('../sync/cloudScope', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../sync/cloudScope')>()),
  providerTablesOn: () => true,
}));
vi.mock('../syncService', () => ({ pushPreferenceToCloud: vi.fn() }));
vi.mock('../dbCore', () => ({
  getMeta: vi.fn(async (key: string) => state.meta.get(key) ?? null),
  setMeta: vi.fn(async (key: string, value: string) => { state.meta.set(key, value); }),
  isDatabaseOf: () => true,
  getDatabase: vi.fn(async () => ({
    select: async (sql: string) => (sql.includes('FROM user_preferences') ? state.localPrefs : []),
    execute: async (sql: string, params: unknown[] = []) => { state.executed.push({ sql, params }); },
  })),
}));
vi.mock('../supabaseClient', () => ({
  supabase: {
    from: (table: string) => ({
      select: () => {
        state.selects.push(table);
        const chain: any = {
          eq: () => chain,
          maybeSingle: async () => ({ data: { value: 'f'.repeat(64) }, error: null }),
          then: (resolve: (r: unknown) => unknown) => resolve({ data: state.cloudPrefs, error: null }),
        };
        return chain;
      },
      delete: () => {
        state.deletes.push(table);
        const chain: any = {
          eq: () => chain,
          or: () => chain,
          then: (resolve: (r: unknown) => unknown) => resolve({ error: null }),
        };
        return chain;
      },
      upsert: (rows: any) => {
        state.upserts.push({ table, rows });
        return { then: (resolve: (r: unknown) => unknown) => resolve({ error: null }) };
      },
    }),
  },
}));

import { setLastProviderHash, getDeviceProviderHash, computeProviderHash, resetPreferencesCache } from '../preferencesService';
import { pushPreferenceToCloud } from '../syncService';
import { syncPreferences } from '../sync/syncPreferences';
import { purgeCloudData, purgeProviderCloudData, settlePendingProviderPurge, fetchCloudProviderHash } from '../sync/syncPurge';
import { setCurrentSyncUserId } from '../sync/syncState';
import type { SyncResult } from '../sync/syncTypes';

const result = () => ({ preferences: { pulled: 0, pushed: 0 } }) as unknown as SyncResult;
const T1 = '2026-11-01T10:00:00.000Z';
const T2 = '2026-11-02T10:00:00.000Z';

beforeEach(() => {
  state.meta.clear();
  state.localPrefs = [];
  state.cloudPrefs = [];
  state.executed = [];
  state.upserts = [];
  state.deletes = [];
  state.selects = [];
  vi.mocked(pushPreferenceToCloud).mockClear();
  vi.stubGlobal('window', { dispatchEvent: vi.fn() });
  resetPreferencesCache();
  setCurrentSyncUserId(USER);
});

describe('préférence du fournisseur partagée, tables par fournisseur allumées', () => {
  it('fournisseur noté : sur l\'appareil seulement, rien dans la base ni dans le cloud', async () => {
    await setLastProviderHash('provider-c.example');

    expect(getDeviceProviderHash()).toBe(await computeProviderHash('provider-c.example'));
    expect(state.executed).toEqual([]);
    expect(pushPreferenceToCloud).not.toHaveBeenCalled();
  });

  it('synchro des préférences : celle du fournisseur ni envoyée ni reçue, les autres oui', async () => {
    state.localPrefs = [
      { key: 'last_provider_hash', value: 'c'.repeat(64), updated_at: Date.parse(T2) },
      { key: 'language', value: 'fr', updated_at: Date.parse(T2) },
    ];
    state.cloudPrefs = [{ key: 'last_provider_hash', value: 'a'.repeat(64), updated_at: T1 }];
    await syncPreferences(USER, result());
    expect(state.upserts).toHaveLength(1);
    expect(state.upserts[0].rows.map((r: any) => r.key)).toEqual(['language']);

    state.upserts = [];
    state.localPrefs = [{ key: 'last_provider_hash', value: 'c'.repeat(64), updated_at: Date.parse(T1) }];
    state.cloudPrefs = [
      { key: 'last_provider_hash', value: 'a'.repeat(64), updated_at: T2 },
      { key: 'language', value: 'en', updated_at: T2 },
    ];
    await syncPreferences(USER, result());
    expect(state.executed.map((e) => e.params[0])).toEqual(['language']);
    expect(state.upserts).toEqual([]);
  });

  it('changement de fournisseur : rien n\'est effacé du cloud, effacement en attente abandonné', async () => {
    expect(await purgeProviderCloudData(USER, 'c'.repeat(64))).toBe(true);
    expect(state.deletes).toEqual([]);

    state.meta.set('provider_purge_pending', '1');
    expect(await settlePendingProviderPurge(USER)).toBe(true);
    expect(state.deletes).toEqual([]);
    expect(state.meta.get('provider_purge_pending')).toBe('0');
  });

  it('« Supprimer aussi mes données cloud » : anciennes tables et tables par fournisseur vidées', async () => {
    expect(await purgeCloudData()).toEqual([]);
    expect(state.deletes).toEqual([
      'user_preferences', 'user_watchlist', 'user_playback_progress', 'user_livetv_bookmarks', 'user_hidden_categories',
      'user_watchlist_v2', 'user_playback_progress_v2', 'user_livetv_bookmarks_v2', 'user_hidden_categories_v2',
    ]);
  });

  it('« Supprimer aussi mes données cloud » sans compte connecté : les 9 tables rendues comme non vidées', async () => {
    setCurrentSyncUserId(null);
    expect(await purgeCloudData()).toHaveLength(9);
    expect(state.deletes).toEqual([]);
  });

  it('préférence du cloud toujours lue (écriture déjà connue du même serveur)', async () => {
    expect(await fetchCloudProviderHash(USER)).toBe('f'.repeat(64));
  });
});
