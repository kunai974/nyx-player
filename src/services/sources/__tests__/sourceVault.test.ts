/**
 * Coffre des sources : une entrée par source, noms acceptés par Rust, lecture des entrées de la
 * 0.8.0, limite du coffre Windows, aucun secret dans les journaux.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const { invoke, platform } = vi.hoisted(() => ({ invoke: vi.fn(), platform: { android: false } }));

vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock('../../../utils/platform', () => ({ isAndroid: () => platform.android }));
vi.mock('../../dbCore', () => ({ clearAllData: vi.fn(), hasContent: vi.fn() }));

import {
  sourceVaultKey, parseSourceSecret, serializeSourceSecret, writeSourceSecret, readSourceSecret,
  deleteSourceSecret, SourceVaultError, MAX_DESKTOP_ENTRY_LENGTH,
} from '../sourceVault';

const UID = '0f8b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d';
const SOURCE = '6a1e5c3b-9d2f-4e7a-b8c1-0d2e4f6a8b9c';
const KEY = `iptv_source_${UID}_${SOURCE}`;
const xtream = { kind: 'xtream' as const, host: 'http://provider.example:8080', username: 'jean', password: 'secret-pass' };
const m3u = { kind: 'm3u' as const, url: 'https://cdn.example/get.php?username=jean&password=secret-pass&type=m3u_plus' };

beforeEach(() => {
  invoke.mockReset();
  platform.android = false;
});

describe('nom de l\'entrée', () => {
  it('espace (compte ou invité, un uuid), puis la source', () => {
    expect(sourceVaultKey(UID, SOURCE)).toBe(KEY);
  });

  it('refuse tout ce que Rust refuserait', () => {
    for (const [space, source] of [
      ['', SOURCE], [UID, ''], [UID.toUpperCase(), SOURCE], [`${UID}.x`, SOURCE], ['../x', SOURCE],
      [UID, `${SOURCE}_${SOURCE}`], [`guest_${UID}`, SOURCE], [`guest-${UID}`, SOURCE],
    ]) {
      expect(() => sourceVaultKey(space, source), `${space} / ${source}`).toThrow(SourceVaultError);
    }
  });

  it('même motif que la garde Rust (secret_vault.rs)', () => {
    const rust = readFileSync(resolve(__dirname, '../../../../src-tauri/src/secret_vault.rs'), 'utf8');
    expect(rust).toContain('iptv_source_{UUID}_{UUID}');
  });
});

describe('décodage', () => {
  it('une entrée de la 0.8.0, sans type, est une source Xtream', () => {
    const legacy = JSON.stringify({ host: xtream.host, username: 'jean', password: 'secret-pass' });
    expect(parseSourceSecret(legacy)).toEqual(xtream);
  });

  it('M3U avec guide externe', () => {
    expect(parseSourceSecret(JSON.stringify({ ...m3u, epgUrl: 'https://epg.example/x.xml' })))
      .toEqual({ ...m3u, epgUrl: 'https://epg.example/x.xml' });
  });

  it('entrée illisible, incomplète ou d\'un type inconnu : null, jamais à moitié remplie', () => {
    for (const raw of ['', 'pas du json', 'null', '[]', '"texte"',
      JSON.stringify({ host: 'h', username: 'u' }),
      JSON.stringify({ kind: 'm3u' }),
      JSON.stringify({ kind: 'm3u', url: '   ' }),
      JSON.stringify({ kind: 'stalker', url: 'http://x' }),
      JSON.stringify({ host: 'h', username: 'u', password: 42 })]) {
      expect(parseSourceSecret(raw), raw).toBeNull();
    }
  });

  it('écriture : seulement les champs connus', () => {
    const withExtra = { ...xtream, note: 'champ inconnu', epgUrl: '' } as unknown as typeof xtream;
    expect(JSON.parse(serializeSourceSecret(withExtra))).toEqual(xtream);
    expect(() => serializeSourceSecret({ kind: 'm3u', url: '' })).toThrow(SourceVaultError);
  });
});

describe('lecture et écriture', () => {
  it('ordinateur : une entrée par source par nyx_secret_*', async () => {
    invoke.mockResolvedValue(undefined);
    await writeSourceSecret(UID, SOURCE, xtream);
    expect(invoke).toHaveBeenLastCalledWith('nyx_secret_set', { user: KEY, value: JSON.stringify(xtream) });

    invoke.mockResolvedValueOnce(JSON.stringify(m3u));
    expect(await readSourceSecret(UID, SOURCE)).toEqual(m3u);
    expect(invoke).toHaveBeenLastCalledWith('nyx_secret_get', { user: KEY });
  });

  it('Android : même nom d\'entrée, préfixé par le service, dans le Keystore', async () => {
    platform.android = true;
    invoke.mockResolvedValue(undefined);
    await writeSourceSecret(UID, SOURCE, m3u);
    expect(invoke).toHaveBeenLastCalledWith('plugin:nyx-android|secure_set', { key: `nyxplayer::${KEY}`, value: JSON.stringify(m3u) });
  });

  it('ordinateur : une entrée trop longue pour le coffre Windows est refusée avant d\'écrire', async () => {
    const long = { kind: 'm3u' as const, url: `https://cdn.example/${'a'.repeat(MAX_DESKTOP_ENTRY_LENGTH)}` };
    await expect(writeSourceSecret(UID, SOURCE, long)).rejects.toMatchObject({ code: 'too_long' });
    expect(invoke).not.toHaveBeenCalled();
    platform.android = true;
    invoke.mockResolvedValue(undefined);
    await writeSourceSecret(UID, SOURCE, long);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('coffre en panne ou entrée illisible : null, et le journal ne cite aucun secret', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    invoke.mockRejectedValueOnce(new Error('panne http://provider.example/live/jean/secret-pass/1.ts'));
    expect(await readSourceSecret(UID, SOURCE)).toBeNull();
    invoke.mockResolvedValueOnce('{"host":"http://h","username":"jean","password":');
    expect(await readSourceSecret(UID, SOURCE)).toBeNull();
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain('secret-pass');
    expect(logged).not.toContain('jean');
    warn.mockRestore();
  });

  it('effacement : directement, et un coffre en panne remonte (le secret ne reste pas en silence)', async () => {
    invoke.mockResolvedValueOnce(undefined);
    await deleteSourceSecret(UID, SOURCE);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenLastCalledWith('nyx_secret_delete', { user: KEY });

    invoke.mockReset();
    invoke.mockRejectedValueOnce(new Error('coffre verrouillé'));
    await expect(deleteSourceSecret(UID, SOURCE)).rejects.toThrow('coffre verrouillé');
  });

  it('la garde Rust traite une entrée absente comme effacée, et seulement elle', () => {
    const rust = readFileSync(resolve(__dirname, '../../../../src-tauri/src/secret_vault.rs'), 'utf8');
    expect(rust).toMatch(/deletion_outcome\(entry\(&user\)\?\.delete_credential\(\)\)/);
    expect(rust).toMatch(/Ok\(\(\)\) \| Err\(keyring::Error::NoEntry\) => Ok\(\(\)\)/);
  });
});
