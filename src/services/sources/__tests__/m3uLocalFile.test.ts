// @vitest-environment node
/**
 * Liste M3U ouverte depuis un fichier de l'appareil : adresse gardée, empreinte tirée du nom du
 * fichier (le même fichier sur deux appareils est le même fournisseur), copie par morceaux dans
 * l'ordre, et copie inachevée effacée en cas d'échec. Environnement node : le `Blob` de jsdom n'a pas
 * `arrayBuffer()`, que les WebView de Windows et d'Android ont.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('../../supabaseClient', () => ({ supabase: {} }));

import {
    importLocalM3uFile, isLocalM3uMissingError, isLocalM3uUrl, localM3uId, localM3uFileName,
    LocalM3uFileError, MAX_LOCAL_M3U_BYTES,
} from '../m3uLocalFile';
import { isM3uListCredentials } from '../m3uListCredentials';
import { m3uFingerprintInput, sourceProviderHash, sourceHostLabel } from '../sourceFingerprint';

const ID = '0123456789abcdef0123456789abcdef';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
});

describe('adresse d\'une liste recopiée', () => {
    it('lit le numéro et le nom, refuse un numéro mal formé', () => {
        const url = `nyx-file://${ID}/Ma%20liste%20(2).m3u`;
        expect(isLocalM3uUrl(url)).toBe(true);
        expect(localM3uId(url)).toBe(ID);
        expect(localM3uFileName(url)).toBe('Ma liste (2).m3u');
        expect(isLocalM3uUrl('https://cdn.example/list.m3u')).toBe(false);
        expect(localM3uId('nyx-file://../../etc/passwd')).toBeNull();
        expect(localM3uFileName('nyx-file://../x.m3u')).toBe('');
    });

    it('empreinte : le nom du fichier, pas le numéro de la copie ; jamais confondue avec un serveur', async () => {
        const pc = `nyx-file://${ID}/Ma%20Liste.m3u`;
        const phone = `nyx-file://${'f'.repeat(32)}/ma%20liste.m3u`;
        expect(m3uFingerprintInput(pc)).toBe('m3u:file/ma liste.m3u');
        expect(await sourceProviderHash({ kind: 'm3u', url: pc })).toBe(await sourceProviderHash({ kind: 'm3u', url: phone }));
        expect(await sourceProviderHash({ kind: 'm3u', url: pc })).toBe(sha('m3u:file/ma liste.m3u'));
        expect(m3uFingerprintInput('http://file/ma%20liste.m3u')).toBe('m3u:file');
        // Numéro illisible : pas d'empreinte (ni l'adresse brute)
        expect(m3uFingerprintInput('nyx-file://pas-un-numero/x.m3u')).toBeNull();
        expect(sourceHostLabel({ kind: 'm3u', url: pc })).toBe('Ma Liste.m3u');
    });
});

describe('copie du fichier choisi', () => {
    it('envoie le fichier par morceaux, dans l\'ordre, puis rend une source de session', async () => {
        const size = 2 * 1024 * 1024 + 10;
        const file = new File([new Uint8Array(size).fill(65)], 'C:\\fake\\Films.m3u');
        const progress: number[] = [];
        const creds = await importLocalM3uFile(file, (p) => progress.push(p));

        const writes = invoke.mock.calls.filter(([cmd]) => cmd === 'm3u_file_write');
        expect(writes.map(([, args]) => (args as { offset: number }).offset)).toEqual([0, 2 * 1024 * 1024]);
        const ids = new Set(invoke.mock.calls.map(([, args]) => (args as { id: string }).id));
        expect(ids.size).toBe(1);
        const [id] = ids;
        expect(id).toMatch(/^[0-9a-f]{32}$/);
        expect(atob((writes[1][1] as { data: string }).data)).toBe('A'.repeat(10));
        expect(invoke.mock.calls[invoke.mock.calls.length - 1]).toEqual(['m3u_file_finish', { id }]);
        expect(progress[progress.length - 1]).toBe(1);

        expect(isM3uListCredentials(creds)).toBe(true);
        expect(creds.m3u?.url).toBe(`nyx-file://${id}/Films.m3u`);
        expect(creds.host).toBe('m3u:file/films.m3u');
        expect(creds.username).toBe('');
    });

    it('le même fichier choisi de nouveau garde le même numéro (sa copie est remplacée, pas doublée)', async () => {
        const a = await importLocalM3uFile(new File(['#EXTM3U\n'], 'Liste.m3u'));
        const b = await importLocalM3uFile(new File(['#EXTM3U\n#EXTINF:-1,x\n'], 'liste.M3U'));
        const c = await importLocalM3uFile(new File(['#EXTM3U\n'], 'autre.m3u'));
        expect(localM3uId(a.m3u!.url)).toBe(localM3uId(b.m3u!.url));
        expect(localM3uId(c.m3u!.url)).not.toBe(localM3uId(a.m3u!.url));
    });

    it('nom : invisibles retirés, coupé sans casser un emoji', async () => {
        const name = `\u202Eevil${'🎬'.repeat(70)}.m3u`;
        const creds = await importLocalM3uFile(new File(['#EXTM3U\n'], name));
        const shown = localM3uFileName(creds.m3u!.url);
        expect(shown.startsWith('evil')).toBe(true);
        expect(Array.from(shown)).toHaveLength(60);
        expect(JSON.stringify(creds).length).toBeLessThan(1280);
    });

    it('échec en route : seule la copie en cours est abandonnée', async () => {
        invoke.mockImplementation(async (cmd: string) => {
            if (cmd === 'm3u_file_finish') throw new Error('disk full');
        });
        const file = new File(['#EXTM3U\n'], 'liste.m3u');
        await expect(importLocalM3uFile(file)).rejects.toEqual(new LocalM3uFileError('copy_failed'));
        expect(invoke).toHaveBeenCalledWith('m3u_file_abort', { id: expect.stringMatching(/^[0-9a-f]{32}$/) });
        expect(invoke.mock.calls.some(([cmd]) => cmd === 'm3u_file_delete')).toBe(false);
    });

    it('fichier vide ou trop gros : refusé sans rien copier', async () => {
        await expect(importLocalM3uFile(new File([], 'vide.m3u'))).rejects.toEqual(new LocalM3uFileError('empty'));
        const big = new File(['x'], 'gros.m3u');
        Object.defineProperty(big, 'size', { value: MAX_LOCAL_M3U_BYTES + 1 });
        await expect(importLocalM3uFile(big)).rejects.toEqual(new LocalM3uFileError('too_large'));
        expect(invoke).not.toHaveBeenCalled();
    });

    it('copie disparue : reconnue pour demander de choisir le fichier de nouveau', () => {
        expect(isLocalM3uMissingError('local list missing')).toBe(true);
        expect(isLocalM3uMissingError(new Error('HTTP 404'))).toBe(false);
    });
});
