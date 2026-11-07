/**
 * Changement de fournisseur : l'effacement du cloud est attendu, limité au
 * compte connecté, et retenté par la synchro tant qu'il n'a pas réussi. Pendant ce temps, positions,
 * favoris TV et catégories masquées ne sont pas synchronisés (ils ramèneraient l'ancien fournisseur).
 * Il ne vise que les lignes d'un AUTRE fournisseur que le nouveau.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const meta = new Map<string, string>();
let sameAccount = true;
/** Une requête d'effacement envoyée : sa table, ses filtres `eq`, son filtre `or` éventuel */
interface DeleteCall { table: string; eq: [string, unknown][]; or?: string }
let deletes: DeleteCall[] = [];
type Response = { error: { message: string } | null };
const respond = vi.fn((_call: DeleteCall): Response => ({ error: null }));
const from = vi.fn((table: string) => ({
  delete: () => {
    const call: DeleteCall = { table, eq: [] };
    deletes.push(call);
    const builder = {
      eq: (key: string, value: unknown) => { call.eq.push([key, value]); return builder; },
      or: (filter: string) => { call.or = filter; return builder; },
      then: (resolve: (v: Response) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve().then(() => respond(call)).then(resolve, reject),
    };
    return builder;
  },
}));

vi.mock('../supabaseClient', () => ({ supabase: { from: (table: string) => from(table) } }));
vi.mock('../dbCore', () => ({
  getMeta: vi.fn(async (key: string) => meta.get(key) ?? null),
  setMeta: vi.fn(async (key: string, value: string) => { meta.set(key, value); }),
}));
const clearBaselines = vi.fn(async () => {});
vi.mock('../sync/syncBaseline', () => ({
  isSameAccount: () => sameAccount,
  clearBaselines: (...args: unknown[]) => clearBaselines(...(args as [])),
}));
vi.mock('../../utils/devLog', () => ({ devLog: vi.fn() }));

import { purgeProviderCloudData, settlePendingProviderPurge, PROVIDER_SCOPED_TABLES } from '../sync/syncPurge';

/** Empreinte (SHA-256 hexadécimal) du nouveau fournisseur */
const NEW_HASH = 'a'.repeat(64);

beforeEach(() => {
  vi.clearAllMocks();
  meta.clear();
  deletes = [];
  sameAccount = true;
  respond.mockImplementation(() => ({ error: null }));
});

describe('purgeProviderCloudData', () => {
  it('vide les trois tables du fournisseur, pour ce compte seulement, puis oublie la marque', async () => {
    await expect(purgeProviderCloudData('compte-a')).resolves.toBe(true);

    expect(deletes.map((c) => c.table)).toEqual([...PROVIDER_SCOPED_TABLES]);
    for (const call of deletes) {
      expect(call.eq).toEqual([['user_id', 'compte-a']]);
      expect(call.or).toBeUndefined(); // empreinte inconnue : tout effacer, comme avant
    }
    expect(meta.get('provider_purge_pending')).toBe('0');
  });

  it('Garde les lignes du nouveau fournisseur : seules partent celles d\'un autre fournisseur ou sans empreinte', async () => {
    await expect(purgeProviderCloudData('compte-a', NEW_HASH)).resolves.toBe(true);

    expect(deletes.map((c) => c.table)).toEqual([...PROVIDER_SCOPED_TABLES]);
    for (const call of deletes) {
      expect(call.eq).toEqual([['user_id', 'compte-a']]);
      expect(call.or).toBe(`provider_hash.is.null,provider_hash.neq.${NEW_HASH}`);
    }
  });

  it('Une empreinte invalide n\'entre jamais dans le filtre (tout est effacé, comme avant)', async () => {
    await purgeProviderCloudData('compte-a', 'x),user_id.neq.compte-a');

    for (const call of deletes) expect(call.or).toBeUndefined();
    expect(meta.get('provider_purge_pending')).toBe('0');
  });

  it('oublie le dernier accord des trois types avant la marque : un envoi fait pendant l\'attente est renvoyé, pas effacé de l\'appareil', async () => {
    const { setMeta } = await import('../dbCore');
    await purgeProviderCloudData('compte-a');

    expect(clearBaselines).toHaveBeenCalledWith('compte-a', ['playback', 'playback_v2', 'livetv', 'livetv_v2', 'hidden', 'hidden_v2']);
    const doneAt = vi.mocked(setMeta).mock.invocationCallOrder[vi.mocked(setMeta).mock.calls.findIndex((c) => c[1] === '0')];
    expect(clearBaselines.mock.invocationCallOrder[0]).toBeLessThan(doneAt);
  });

  it('ne touche jamais à Ma liste, aux préférences ni aux profils', async () => {
    await purgeProviderCloudData('compte-a');
    const tables = from.mock.calls.map((c) => c[0]);
    expect(tables).not.toContain('user_watchlist');
    expect(tables).not.toContain('user_preferences');
    expect(tables).not.toContain('user_profiles');
  });

  it('échec (hors ligne) : la marque reste, pour que la synchro retente', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    respond.mockImplementationOnce(() => ({ error: { message: 'Failed to fetch' } }));

    await expect(purgeProviderCloudData('compte-a')).resolves.toBe(false);

    expect(meta.get('provider_purge_pending')).toBe('1');
    expect(clearBaselines).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('Échec : la marque garde l\'empreinte du nouveau fournisseur', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    respond.mockImplementationOnce(() => ({ error: { message: 'Failed to fetch' } }));

    await expect(purgeProviderCloudData('compte-a', NEW_HASH)).resolves.toBe(false);

    expect(meta.get('provider_purge_pending')).toBe(NEW_HASH);
    warn.mockRestore();
  });

  it('autre compte ouvert : rien n\'est effacé', async () => {
    sameAccount = false;
    await expect(purgeProviderCloudData('compte-a')).resolves.toBe(false);
    expect(from).not.toHaveBeenCalled();
  });
});

describe('settlePendingProviderPurge', () => {
  it('aucun effacement en attente : rien n\'est envoyé, la synchro continue', async () => {
    await expect(settlePendingProviderPurge('compte-a')).resolves.toBe(true);
    meta.set('provider_purge_pending', '0');
    await expect(settlePendingProviderPurge('compte-a')).resolves.toBe(true);
    expect(from).not.toHaveBeenCalled();
  });

  it('effacement en attente (ancienne marque « 1 ») : retenté en entier, et la synchro continue s\'il réussit', async () => {
    meta.set('provider_purge_pending', '1');
    await expect(settlePendingProviderPurge('compte-a')).resolves.toBe(true);
    expect(deletes).toHaveLength(3);
    for (const call of deletes) expect(call.or).toBeUndefined();
    expect(meta.get('provider_purge_pending')).toBe('0');
  });

  it('Reprise tardive : garde toujours les lignes du nouveau fournisseur noté dans la marque', async () => {
    meta.set('provider_purge_pending', NEW_HASH);

    await expect(settlePendingProviderPurge('compte-a')).resolves.toBe(true);

    expect(deletes).toHaveLength(3);
    for (const call of deletes) expect(call.or).toBe(`provider_hash.is.null,provider_hash.neq.${NEW_HASH}`);
    expect(meta.get('provider_purge_pending')).toBe('0');
  });

  it('marque illisible : l\'effacement est retenté en entier au lieu d\'être abandonné', async () => {
    meta.set('provider_purge_pending', 'abc,provider_hash.eq.x');

    await expect(settlePendingProviderPurge('compte-a')).resolves.toBe(true);

    expect(deletes).toHaveLength(3);
    for (const call of deletes) expect(call.or).toBeUndefined();
    expect(meta.get('provider_purge_pending')).toBe('0');
  });

  it('effacement en attente qui échoue encore : les données du fournisseur ne sont pas synchronisées', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    meta.set('provider_purge_pending', '1');
    respond.mockImplementation(() => ({ error: { message: 'Failed to fetch' } }));

    await expect(settlePendingProviderPurge('compte-a')).resolves.toBe(false);
    warn.mockRestore();
  });
});
