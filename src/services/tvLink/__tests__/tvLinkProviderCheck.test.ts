/**
 * Fournisseur reçu par QR code : essayé auprès de son serveur avant de répondre au téléphone, sauf une
 * liste M3U sans identifiants (trop lourde pour un essai ; elle est chargée ensuite).
 */
import { describe, it, expect, vi } from 'vitest';

const built = vi.hoisted(() => ({ options: [] as unknown[] }));
vi.mock('../../xtreamApi', () => ({
    XtreamApiService: class {
        constructor(_creds: unknown, options?: unknown) { built.options.push(options); }
        authenticate = (): Promise<unknown> => Promise.resolve({});
    },
    isCredentialsRejectedError: (e: unknown) => e instanceof Error && e.message === 'Authentication failed',
    isProviderAccountInactiveError: (e: unknown) => e instanceof Error && e.message === 'provider_account_inactive',
}));

import { checkTvLinkProvider, isLocalNetworkHost } from '../tvLinkProviderCheck';

describe('checkTvLinkProvider', () => {
    it('lien Xtream (get.php) : identifiants essayés auprès du serveur, une seule demande', async () => {
        const authenticate = vi.fn().mockResolvedValue({});
        const check = await checkTvLinkProvider({ type: 'm3u', link: 'http://serveur.example:8080/get.php?username=u&password=p&type=m3u_plus' }, authenticate);
        expect(check).toMatchObject({ ok: true, creds: { host: 'http://serveur.example:8080', username: 'u', password: 'p' } });
        expect(authenticate).toHaveBeenCalledTimes(1);
    });

    it('liste M3U sans identifiants : pas téléchargée ici', async () => {
        const authenticate = vi.fn();
        const check = await checkTvLinkProvider({ type: 'm3u', link: 'https://listes.example/ma-liste.m3u' }, authenticate);
        expect(check.ok).toBe(true);
        expect(authenticate).not.toHaveBeenCalled();
    });

    it.each([
        [new Error('Authentication failed'), 'provider'],
        [new Error('provider_account_inactive'), 'provider-inactive'],
        [new Error('provider_certificate_error: expiré'), 'provider-unreachable'],
    ])('refus du serveur : raison précise pour le téléphone', async (error, reason) => {
        const check = await checkTvLinkProvider({ type: 'xtream', host: 'http://s.example', username: 'u', password: 'p' }, vi.fn().mockRejectedValue(error));
        expect(check).toEqual({ ok: false, reason });
    });

    it('champs incomplets : refus sans appel au serveur', async () => {
        const authenticate = vi.fn();
        expect(await checkTvLinkProvider({ type: 'xtream', host: 'http://s.example', username: '', password: 'p' }, authenticate)).toEqual({ ok: false, reason: 'provider-format' });
        expect(authenticate).not.toHaveBeenCalled();
    });

    it('serveur du réseau local : pas essayé (la TV ne sert pas à sonder la maison), mais accepté', async () => {
        const authenticate = vi.fn();
        for (const host of ['http://192.168.0.10:8080', 'http://127.0.0.1:9191', 'http://[::1]:80', 'http://box.local', 'http://10.0.0.5']) {
            expect(await checkTvLinkProvider({ type: 'xtream', host, username: 'u', password: 'p' }, authenticate)).toMatchObject({ ok: true });
        }
        expect(authenticate).not.toHaveBeenCalled();
    });

    it('serveur public : essayé en « public seulement » (un nom ou une redirection vers la maison est refusé par l\'application)', async () => {
        built.options = [];
        await checkTvLinkProvider({ type: 'xtream', host: 'http://serveur.example', username: 'u', password: 'p' });
        expect(built.options).toEqual([{ publicOnly: true }]);
    });

    it('isLocalNetworkHost : formes détournées d\'une adresse locale reconnues', () => {
        for (const a of ['http://localhost.', 'http://nas.local.', 'http://[::c0a8:1]', 'http://[fec0::1]', 'http://[64:ff9b::c0a8:1]',
            'http://[ff02::1]', 'http://192.0.0.8', 'http://198.18.0.1', 'http://224.0.0.1', 'http://255.255.255.255', 'http://0x7f.1', 'http://2130706433']) {
            expect(isLocalNetworkHost(a), a).toBe(true);
        }
    });

    it('isLocalNetworkHost : adresses privées oui, serveurs publics non', () => {
        for (const a of ['http://localhost:8080', 'http://172.20.1.1', 'http://169.254.1.1', 'http://100.64.0.1', 'http://dispatcharr', 'http://nas.lan', 'http://[fd00::1]', 'http://[fe80::1]']) {
            expect(isLocalNetworkHost(a), a).toBe(true);
        }
        for (const a of ['http://serveur.example:8080', 'http://203.0.113.5', 'http://172.32.0.1', 'https://iptv.example.com', 'pas une adresse']) {
            expect(isLocalNetworkHost(a), a).toBe(false);
        }
    });
});
