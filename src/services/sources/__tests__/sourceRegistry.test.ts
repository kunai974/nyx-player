/**
 * Liste des sources : 5 au plus, jamais de secret dans la base, jamais rangée chez un autre compte,
 * coffre et base toujours d'accord, reprise de la 0.8.0 rejouable après une coupure.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const UID = '0f8b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d';
const OTHER = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

/** Coffre : entrées par nom */
const vault = new Map<string, string>();
const vaultFailures = { write: 0, remove: 0 };
vi.mock('../../storage', () => ({
  describeVaultError: (e: unknown) => String(e),
  secretVault: {
    read: async (key: string) => vault.get(key) ?? null,
    write: async (key: string, value: string) => {
      if (vaultFailures.write > 0) { vaultFailures.write--; throw new Error('coffre en panne'); }
      vault.set(key, value);
    },
    remove: async (key: string) => {
      if (vaultFailures.remove > 0) { vaultFailures.remove--; throw new Error('coffre en panne'); }
      vault.delete(key);
    },
  },
}));
vi.mock('../../../utils/platform', () => ({ isAndroid: () => false }));
/** Commandes natives : seule la suppression du fichier catalogue d'une source passe par ici */
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock('../../supabaseClient', () => ({ supabase: {} }));

/**
 * Base perso imitée : table `iptv_sources` et `meta`, pour les seules requêtes du registre. Les
 * colonnes viennent du vrai schéma (dbCore.ts), contrôlées plus bas.
 */
type Row = Record<string, string | number>;
let rows: Row[] = [];
const meta = new Map<string, string>();
let openSpace = UID;
let insertFailures = 0;
let updateFailures = 0;
let deleteFailures = 0;
const COLUMNS = ['id', 'name', 'kind', 'host_label', 'provider_hash', 'sort_order', 'show_in_catalog', 'created_at', 'updated_at'];

const db = {
  async select(query: string, values: unknown[] = []) {
    const q = query.replace(/\s+/g, ' ').trim();
    if (q.startsWith('SELECT COUNT(*) AS count, COALESCE(MAX(sort_order) + 1, 0) AS next')) {
      return [{ count: rows.length, next: rows.length ? Math.max(...rows.map((r) => Number(r.sort_order))) + 1 : 0 }];
    }
    if (q.startsWith('SELECT COUNT(*) AS count FROM iptv_sources')) return [{ count: rows.length }];
    if (q === 'SELECT id FROM iptv_sources') return rows.map((r) => ({ id: r.id }));
    if (q.endsWith('FROM iptv_sources WHERE id = ?')) return rows.filter((r) => r.id === values[0]).map((r) => ({ ...r }));
    if (q.includes('FROM iptv_sources ORDER BY sort_order ASC, created_at ASC, id ASC')) {
      return [...rows].sort((a, b) => Number(a.sort_order) - Number(b.sort_order) || Number(a.created_at) - Number(b.created_at)).map((r) => ({ ...r }));
    }
    throw new Error(`requête inattendue : ${q}`);
  },
  async execute(query: string, values: unknown[] = []) {
    const q = query.replace(/\s+/g, ' ').trim();
    if (q.startsWith('INSERT INTO iptv_sources')) {
      if (insertFailures > 0) { insertFailures--; throw new Error('base occupée'); }
      if (rows.some((r) => r.id === values[0])) throw new Error('UNIQUE constraint failed');
      rows.push(Object.fromEntries(COLUMNS.map((c, i) => [c, values[i] as string | number])));
    } else if (q.startsWith('UPDATE iptv_sources SET name')) {
      if (updateFailures > 0) { updateFailures--; throw new Error('base occupée'); }
      const row = rows.find((r) => r.id === values[6]);
      if (row) Object.assign(row, { name: values[0], kind: values[1], host_label: values[2], provider_hash: values[3], show_in_catalog: values[4], updated_at: values[5] });
    } else if (q.startsWith('UPDATE iptv_sources SET sort_order')) {
      const row = rows.find((r) => r.id === values[2]);
      if (row) Object.assign(row, { sort_order: values[0], updated_at: values[1] });
    } else if (q.startsWith('DELETE FROM iptv_sources WHERE id = ?')) {
      if (deleteFailures > 0) { deleteFailures--; throw new Error('base occupée'); }
      rows = rows.filter((r) => r.id !== values[0]);
    } else {
      throw new Error(`requête inattendue : ${q}`);
    }
    return { rowsAffected: 1 };
  },
};

vi.mock('../../dbCore', () => ({
  getDatabase: async () => db,
  getMeta: async (key: string) => meta.get(key) ?? null,
  setMeta: async (key: string, value: string) => { meta.set(key, value); },
  isDatabaseOf: (space: string) => space === openSpace,
}));

import {
  listSources, addSource, getSource, updateSource, removeSource, reorderSources, adoptLegacySource,
  MAX_SOURCES, SourceRegistryError,
} from '../sourceRegistry';
import { computeProviderHash } from '../../preferencesService';

const xtream = (n = 1) => ({ kind: 'xtream' as const, host: `http://provider${n}.example:8080`, username: 'jean', password: `secret-pass-${n}` });
const m3u = { kind: 'm3u' as const, url: 'https://cdn.example/get.php?username=jean&password=secret-m3u&type=m3u_plus' };

beforeEach(() => {
  vi.restoreAllMocks();
  rows = [];
  vault.clear();
  meta.clear();
  openSpace = UID;
  insertFailures = 0;
  updateFailures = 0;
  deleteFailures = 0;
  vaultFailures.write = 0;
  vaultFailures.remove = 0;
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
});

describe('schéma', () => {
  it('la table du vrai schéma a exactement les colonnes du registre, et aucune colonne de secret', () => {
    const source = readFileSync(resolve(__dirname, '../../dbCore.ts'), 'utf8');
    const ddl = /CREATE TABLE IF NOT EXISTS iptv_sources \(([\s\S]*?)\n {2}\);/.exec(source)?.[1] ?? '';
    const columns = ddl.split('\n').map((l) => l.trim().split(/\s+/)[0]).filter(Boolean);
    expect(columns).toEqual(COLUMNS);
    expect(ddl).not.toMatch(/password|username|url|secret/i);
  });
});

describe('ajout et lecture', () => {
  it('secret au coffre, partie affichable en base, sans aucun secret', async () => {
    const added = await addSource(UID, { name: '  Mon   fournisseur ', secret: xtream() });
    expect(added).toMatchObject({ name: 'Mon fournisseur', kind: 'xtream', hostLabel: 'provider1.example', sortOrder: 0, showInCatalog: true });
    expect(added.providerHash).toBe(await computeProviderHash('http://provider1.example:8080'));
    expect(vault.get(`iptv_source_${UID}_${added.id}`)).toBe(JSON.stringify(xtream()));
    const stored = JSON.stringify(rows);
    expect(stored).not.toContain('secret-pass');
    expect(stored).not.toContain('jean');
    expect(await getSource(UID, added.id)).toMatchObject({ id: added.id, secret: xtream() });
  });

  it('nom par défaut : le nom d\'hôte ; ordre de priorité dans l\'ordre d\'ajout', async () => {
    const a = await addSource(UID, { secret: xtream(1) });
    const b = await addSource(UID, { secret: m3u, showInCatalog: false });
    expect(a.name).toBe('provider1.example');
    expect(b).toMatchObject({ name: 'cdn.example', kind: 'm3u', sortOrder: 1, showInCatalog: false });
    expect((await listSources(UID)).map((s) => s.id)).toEqual([a.id, b.id]);
  });

  it('deux ajouts lancés ensemble ne dépassent pas la limite', async () => {
    for (let n = 1; n < MAX_SOURCES; n++) await addSource(UID, { secret: xtream(n) });
    const results = await Promise.allSettled([addSource(UID, { secret: xtream(7) }), addSource(UID, { secret: xtream(8) })]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(rows).toHaveLength(MAX_SOURCES);
    expect(new Set(rows.map((r) => r.sort_order)).size).toBe(MAX_SOURCES);
  });

  it('écriture connue d\'un autre serveur : ignorée, chaque source garde sa propre empreinte', async () => {
    const second = await addSource(UID, { secret: xtream(2), knownSpelling: 'http://provider1.example:8080/' });
    expect(second.providerHash).toBe(await computeProviderHash('http://provider2.example:8080'));
  });

  it(`${MAX_SOURCES} sources au plus, sans rien écrire au coffre pour la refusée`, async () => {
    for (let n = 1; n <= MAX_SOURCES; n++) await addSource(UID, { secret: xtream(n) });
    const before = vault.size;
    await expect(addSource(UID, { secret: xtream(9) })).rejects.toMatchObject({ code: 'limit' });
    expect(vault.size).toBe(before);
  });

  it('jamais rangée dans la base d\'un autre compte, même si le compte change pendant l\'ajout', async () => {
    openSpace = OTHER;
    await expect(addSource(UID, { secret: xtream() })).rejects.toMatchObject({ code: 'space_changed' });
    expect(vault.size).toBe(0);
    await expect(listSources('pas-un-espace')).rejects.toBeInstanceOf(SourceRegistryError);

    openSpace = UID;
    const write = vault.set.bind(vault);
    vi.spyOn(vault, 'set').mockImplementationOnce((k, v) => { openSpace = OTHER; return write(k, v); });
    await expect(addSource(UID, { secret: xtream() })).rejects.toMatchObject({ code: 'space_changed' });
    expect(rows).toEqual([]);
    expect(vault.size).toBe(0);
  });

  it('ligne non écrite : l\'entrée du coffre est effacée (pas de secret que rien ne désigne)', async () => {
    insertFailures = 1;
    await expect(addSource(UID, { secret: xtream() })).rejects.toThrow('base occupée');
    expect(vault.size).toBe(0);
    expect(rows).toEqual([]);
  });

  it('secret illisible ou d\'un autre type que la ligne : source introuvable plutôt que fausse', async () => {
    const added = await addSource(UID, { secret: xtream() });
    vault.set(`iptv_source_${UID}_${added.id}`, JSON.stringify(m3u));
    expect(await getSource(UID, added.id)).toBeNull();
    vault.set(`iptv_source_${UID}_${added.id}`, '{');
    expect(await getSource(UID, added.id)).toBeNull();
  });
});

describe('modification', () => {
  it('nouvelle adresse : nouvelle empreinte, et l\'ancienne est rendue à l\'appelant', async () => {
    const added = await addSource(UID, { secret: xtream(1) });
    const { source, previousProviderHash } = await updateSource(UID, added.id, { secret: xtream(2) });
    expect(previousProviderHash).toBe(added.providerHash);
    expect(source.providerHash).not.toBe(added.providerHash);
    expect(source.hostLabel).toBe('provider2.example');
    expect((await getSource(UID, added.id))?.secret).toEqual(xtream(2));
  });

  it('nouveau mot de passe, même serveur écrit autrement : l\'empreinte ne bouge pas (pas de faux changement de fournisseur)', async () => {
    const added = await addSource(UID, { secret: xtream(1), knownSpelling: 'http://provider1.example:8080/' });
    const { source, previousProviderHash } = await updateSource(UID, added.id, {
      secret: { ...xtream(1), host: 'HTTP://Provider1.example:8080', password: 'nouveau' },
    });
    expect(source.providerHash).toBe(added.providerHash);
    expect(previousProviderHash).toBe(added.providerHash);
  });

  it('ancien secret illisible : le même serveur est reconnu par l\'empreinte enregistrée', async () => {
    const added = await addSource(UID, { secret: xtream(1), knownSpelling: 'http://provider1.example:8080/' });
    vault.set(`iptv_source_${UID}_${added.id}`, '{');
    const same = await updateSource(UID, added.id, { secret: { ...xtream(1), password: 'nouveau' } });
    expect(same.source.providerHash).toBe(added.providerHash);
    vault.set(`iptv_source_${UID}_${added.id}`, '{');
    const other = await updateSource(UID, added.id, { secret: xtream(2) });
    expect(other.source.providerHash).not.toBe(added.providerHash);
  });

  it('ligne non modifiée : le coffre reprend l\'ancien secret (coffre et base restent d\'accord)', async () => {
    const added = await addSource(UID, { secret: xtream(1) });
    updateFailures = 1;
    await expect(updateSource(UID, added.id, { secret: m3u })).rejects.toThrow('base occupée');
    expect(await getSource(UID, added.id)).toMatchObject({ kind: 'xtream', secret: xtream(1) });
  });

  it('nom et affichage seuls : le coffre n\'est pas réécrit', async () => {
    const added = await addSource(UID, { secret: xtream(1) });
    const set = vi.spyOn(vault, 'set');
    const { source } = await updateSource(UID, added.id, { name: 'Salon', showInCatalog: false });
    expect(source).toMatchObject({ name: 'Salon', showInCatalog: false, providerHash: added.providerHash });
    expect(set).not.toHaveBeenCalled();
    await expect(updateSource(UID, '6a1e5c3b-9d2f-4e7a-b8c1-0d2e4f6a8b9c', { name: 'x' })).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('suppression et ordre', () => {
  it('coffre puis ligne ; coffre en panne : la source reste, on peut réessayer', async () => {
    const added = await addSource(UID, { secret: xtream() });
    vaultFailures.remove = 1;
    await expect(removeSource(UID, added.id)).rejects.toThrow('coffre en panne');
    expect(rows).toHaveLength(1);
    await removeSource(UID, added.id);
    expect(rows).toEqual([]);
    expect(vault.size).toBe(0);
  });

  it('le fichier catalogue de la source est effacé, et un fichier encore tenu ne retient pas la suppression', async () => {
    const a = await addSource(UID, { secret: xtream(1) });
    const b = await addSource(UID, { secret: xtream(2) });
    await removeSource(UID, a.id);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenLastCalledWith('delete_source_catalog', { dbName: `nyxcat_${UID}_${a.id}.db` });

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    invoke.mockRejectedValueOnce(new Error('Failed to delete after 3 attempts'));
    await removeSource(UID, b.id);
    expect(rows).toEqual([]);
    expect(vault.size).toBe(0);
    warn.mockRestore();
  });

  it('ligne impossible à effacer : la source reste, avec son fichier catalogue', async () => {
    const added = await addSource(UID, { secret: xtream() });
    deleteFailures = 1;
    await expect(removeSource(UID, added.id)).rejects.toThrow('base occupée');
    expect(rows).toHaveLength(1);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('coffre en panne : le fichier catalogue n\'est pas effacé non plus', async () => {
    const added = await addSource(UID, { secret: xtream() });
    vaultFailures.remove = 1;
    await expect(removeSource(UID, added.id)).rejects.toThrow('coffre en panne');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('nouvel ordre : la liste complète, sans doublon ni inconnue', async () => {
    const a = await addSource(UID, { secret: xtream(1) });
    const b = await addSource(UID, { secret: xtream(2) });
    await reorderSources(UID, [b.id, a.id]);
    expect((await listSources(UID)).map((s) => s.id)).toEqual([b.id, a.id]);
    for (const bad of [[a.id], [a.id, a.id], [a.id, b.id, 'x'], [a.id, '6a1e5c3b-9d2f-4e7a-b8c1-0d2e4f6a8b9c']]) {
      await expect(reorderSources(UID, bad)).rejects.toMatchObject({ code: 'invalid_order' });
    }
  });
});

describe('reprise des identifiants de la 0.8.0', () => {
  const legacy = { host: 'http://provider1.example:8080', username: 'jean', password: 'secret-pass-1' };

  it('devient la source 1, avec l\'empreinte déjà connue du compte ; l\'ancienne entrée n\'est pas touchée', async () => {
    vault.set(`iptv_credentials_${UID}`, JSON.stringify(legacy));
    const adopted = await adoptLegacySource(UID, legacy, { knownSpelling: 'http://provider1.example:8080/' });
    expect(adopted).toMatchObject({ kind: 'xtream', sortOrder: 0, name: 'provider1.example' });
    expect(adopted?.providerHash).toBe(await computeProviderHash('http://provider1.example:8080/'));
    expect(vault.get(`iptv_credentials_${UID}`)).toBe(JSON.stringify(legacy));
    expect((await getSource(UID, adopted!.id))?.secret).toEqual(xtream(1));
  });

  it('liste M3U rangée comme source de la session : reprise comme source M3U', async () => {
    const list = { host: 'm3u:cdn.example', username: '', password: '', m3u: { url: 'https://cdn.example/playlist/jeton-factice.m3u' } };
    const adopted = await adoptLegacySource(UID, list);
    expect(adopted).toMatchObject({ kind: 'm3u', sortOrder: 0 });
    expect((await getSource(UID, adopted!.id))?.secret).toEqual({ kind: 'm3u', url: list.m3u.url });
  });

  it('rejouable : deux lancements donnent la même et unique source', async () => {
    const first = await adoptLegacySource(UID, legacy);
    const second = await adoptLegacySource(UID, legacy);
    expect(second?.id).toBe(first?.id);
    expect(rows).toHaveLength(1);
  });

  it('coupure entre le coffre et la ligne : le lancement suivant reprend la même source, sans entrée orpheline', async () => {
    insertFailures = 1;
    await expect(adoptLegacySource(UID, legacy)).rejects.toThrow('base occupée');
    const noted = meta.get('legacy_source_id');
    expect(noted).toBeTruthy();
    const adopted = await adoptLegacySource(UID, legacy);
    expect(adopted?.id).toBe(noted);
    expect([...vault.keys()]).toEqual([`iptv_source_${UID}_${noted}`]);
  });

  it('reprise faite puis source supprimée par la personne : elle ne revient pas au lancement suivant', async () => {
    const adopted = await adoptLegacySource(UID, legacy);
    await removeSource(UID, adopted!.id);
    expect(await adoptLegacySource(UID, legacy)).toBeNull();
    expect(rows).toEqual([]);
  });

  it('l\'espace a déjà d\'autres sources : rien n\'est repris, ni plus tard s\'il les supprime', async () => {
    const other = await addSource(UID, { secret: m3u });
    expect(await adoptLegacySource(UID, legacy)).toBeNull();
    expect(rows).toHaveLength(1);
    await removeSource(UID, other.id);
    expect(await adoptLegacySource(UID, legacy)).toBeNull();
    expect(rows).toEqual([]);
  });
});
