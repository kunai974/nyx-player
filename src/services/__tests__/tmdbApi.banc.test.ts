/**
 * tmdbApi — relais TMDB. Une version du banc de tests (VITE_BANC=1) demande au faux relais du faux
 * fournisseur qui lui sert de source, JAMAIS au relais de production (le banc y faisait des milliers
 * d'appels par jour, dans le quota de Supabase). Une version normale va toujours au relais de Nyx.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../supabaseClient', () => ({
    supabase: { auth: { getSession: vi.fn(async () => ({ data: { session: { access_token: 'jeton-du-compte' } } })) } },
}));
vi.mock('../../utils/tmdbLanguage', () => ({ getTmdbLanguage: () => 'fr-FR' }));
vi.mock('../tmdbCacheSqlite', () => ({ getCachedDetails: vi.fn(async () => null), cacheSeasonDetails: vi.fn(async () => {}) }));
vi.mock('../tmdbPersonalKey', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../tmdbPersonalKey')>()),
    getPersonalTmdbKey: vi.fn(async () => null),
}));
vi.mock('../guestRelay', () => ({
    isGuestRelayAvailable: () => false,
    isGuestRelayStopped: () => false,
    takeGuestRelayToken: vi.fn(async () => null),
    noteGuestRelayResponse: vi.fn(async () => {}),
}));

const source = vi.hoisted(() => ({ creds: null as null | { host: string; username: string; password: string } }));
vi.mock('../storage', () => ({ StorageService: { getCredentials: vi.fn(async () => source.creds) } }));

import tmdb, { TmdbUnavailableError } from '../tmdbApi';
import { brancherOutilsTest } from '../outilsTest';
import { adresseRelaisTmdbBanc } from '../../dev/bancAdresses';

// Branché comme le fait src/dev/prisesBanc.ts dans une version du banc ; la condition VITE_BANC=1 de
// tmdbApi décide seule s'il sert.
brancherOutilsTest({ relaisTmdbBanc: adresseRelaisTmdbBanc });

const FAUX = { host: 'http://127.0.0.1:8765', username: 'banc', password: 'banc' };
const PRODUCTION = 'https://test.supabase.co/functions/v1/tmdb-proxy';
const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true, status: 200, statusText: 'OK', json: async () => ({ results: [] }) }));

describe('relais TMDB selon la version', () => {
    beforeEach(() => {
        source.creds = null;
        vi.clearAllMocks();
        vi.stubGlobal('fetch', fetchMock);
        vi.stubEnv('VITE_SUPABASE_URL', 'https://test.supabase.co');
    });
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
    });

    it('version normale : le relais de Nyx, même avec un faux fournisseur pour source', async () => {
        vi.stubEnv('VITE_BANC', '');
        source.creds = FAUX;
        await tmdb.getPopular();
        const url = fetchMock.mock.calls[0][0];
        expect(url.startsWith('https://')).toBe(true);
        expect(url).toContain('/functions/v1/tmdb-proxy/movie/popular');
    });

    it('version du banc, faux fournisseur pour source : le faux relais, jamais le relais de production', async () => {
        vi.stubEnv('VITE_BANC', '1');
        source.creds = FAUX;
        await tmdb.getPopular();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const url = fetchMock.mock.calls[0][0];
        expect(url.startsWith('http://127.0.0.1:8765/__tmdb/movie/popular')).toBe(true);
        expect(url).not.toContain(PRODUCTION);
    });

    it.each([
        ['aucune source', null],
        ['vraie source IPTV', { host: 'http://fournisseur.example:8080', username: 'u', password: 'p' }],
    ])('version du banc, %s : aucune demande, surtout pas au relais de production', async (_nom, creds) => {
        vi.stubEnv('VITE_BANC', '1');
        source.creds = creds;
        await expect(tmdb.getPopular()).rejects.toBeInstanceOf(TmdbUnavailableError);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('version du banc : le fond fictif est l\'image locale du faux relais, l\'affiche garde l\'adresse TMDB', async () => {
        vi.stubEnv('VITE_BANC', '1');
        source.creds = FAUX;
        await tmdb.getPopular(); // le faux relais est connu après une première demande
        expect(tmdb.imageUrl('/banc-fond-278.jpg', 'w1280')).toBe('http://127.0.0.1:8765/__tmdb/img/fond.png');
        expect(tmdb.imageUrl('/banc-278.jpg', 'w342')).toBe('https://image.tmdb.org/t/p/w342/banc-278.jpg');
    });

    it('version normale : toujours l\'adresse TMDB', async () => {
        vi.stubEnv('VITE_BANC', '');
        expect(tmdb.imageUrl('/banc-fond-278.jpg', 'w1280')).toBe('https://image.tmdb.org/t/p/w1280/banc-fond-278.jpg');
    });

    it('version du banc : prepareBancImages fait connaître le faux relais sans demande à TMDB (liste venue du cache)', async () => {
        vi.stubEnv('VITE_BANC', '1');
        source.creds = FAUX;
        vi.resetModules();
        (await import('../outilsTest')).brancherOutilsTest({ relaisTmdbBanc: adresseRelaisTmdbBanc });
        const neuf = (await import('../tmdbApi')).default;
        expect(neuf.imageUrl('/banc-fond-278.jpg', 'w1280')).toBe('https://image.tmdb.org/t/p/w1280/banc-fond-278.jpg');
        await neuf.prepareBancImages();
        expect(fetchMock).not.toHaveBeenCalled();
        expect(neuf.imageUrl('/banc-fond-278.jpg', 'w1280')).toBe('http://127.0.0.1:8765/__tmdb/img/fond.png');
    });
});
