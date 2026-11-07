/**
 * Accès à TMDB : avec un compte, toujours le relais de Nyx (comme avant) ; sans compte, TMDB
 * directement avec la clé personnelle ; sans les deux, aucune requête et une erreur reconnaissable.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let session: { access_token: string } | null = null;
vi.mock('../supabaseClient', () => ({
    supabase: { auth: { getSession: vi.fn(async () => ({ data: { session } })) } },
}));
vi.mock('../../utils/tmdbLanguage', () => ({ getTmdbLanguage: () => 'fr-FR' }));
vi.mock('../tmdbCacheSqlite', () => ({ getCachedDetails: vi.fn(async () => null), cacheSeasonDetails: vi.fn(async () => {}) }));
let personalKey: { kind: 'api-key' | 'read-token'; value: string } | null = null;
const getPersonalTmdbKey = vi.fn(async () => personalKey);
vi.mock('../tmdbPersonalKey', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../tmdbPersonalKey')>()),
    getPersonalTmdbKey: () => getPersonalTmdbKey(),
}));

let guestAvailable = false;
let guestToken: string | null = null;
const takeGuestRelayToken = vi.fn(async () => guestToken);
const noteGuestRelayResponse = vi.fn(async (_status: number, _body: unknown) => {});
let guestStopped = false;
vi.mock('../guestRelay', () => ({
    isGuestRelayAvailable: () => guestAvailable,
    isGuestRelayStopped: () => guestStopped,
    takeGuestRelayToken: () => takeGuestRelayToken(),
    noteGuestRelayResponse: (status: number, body: unknown) => noteGuestRelayResponse(status, body),
}));

import tmdb, { TmdbUnavailableError, isTmdbAvailable, getTmdbAccessKind } from '../tmdbApi';

const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true, status: 200, statusText: 'OK', json: async () => ({ results: [] }) }));

describe('accès à TMDB', () => {
    beforeEach(() => {
        session = null;
        personalKey = null;
        guestAvailable = false;
        guestToken = null;
        guestStopped = false;
        vi.clearAllMocks();
        vi.stubGlobal('fetch', fetchMock);
    });
    afterEach(() => vi.unstubAllGlobals());

    it('avec un compte : le relais de Nyx et le jeton du compte, sans lire de clé personnelle', async () => {
        session = { access_token: 'jeton-du-compte' };
        personalKey = { kind: 'api-key', value: 'cle-perso' };
        await tmdb.getPopular();
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toContain('/functions/v1/tmdb-proxy/movie/popular');
        expect(url).not.toContain('cle-perso');
        expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer jeton-du-compte');
        expect((init?.headers as Record<string, string>).apikey).toBe(import.meta.env.VITE_SUPABASE_ANON_KEY);
        expect(new URL(url).searchParams.get('language')).toBe('fr-FR');
        expect(getPersonalTmdbKey).not.toHaveBeenCalled();
    });

    it('sans compte, avec une clé personnelle : TMDB directement, jamais le relais', async () => {
        personalKey = { kind: 'read-token', value: 'eyJa.b.c' };
        await tmdb.searchMovie('Dune', '2021');
        const [url, init] = fetchMock.mock.calls[0];
        const parsed = new URL(url);
        expect(parsed.origin + parsed.pathname).toBe('https://api.themoviedb.org/3/search/movie');
        expect(parsed.searchParams.get('query')).toBe('Dune');
        expect(parsed.searchParams.get('language')).toBe('fr-FR');
        expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer eyJa.b.c');
        expect(await isTmdbAvailable()).toBe(true);
    });

    it('recherche « clé seulement », même connecté : TMDB directement, jamais le relais', async () => {
        session = { access_token: 'jeton-du-compte' };
        personalKey = { kind: 'api-key', value: 'cle-perso' };
        await tmdb.searchTv('Dark', undefined, { directOnly: true });
        const parsed = new URL(fetchMock.mock.calls[0][0]);
        expect(parsed.origin + parsed.pathname).toBe('https://api.themoviedb.org/3/search/tv');

        personalKey = null;
        fetchMock.mockClear();
        await expect(tmdb.searchMovie('Dune', undefined, { directOnly: true })).rejects.toBeInstanceOf(TmdbUnavailableError);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('sans compte ni clé : aucune requête, erreur reconnaissable', async () => {
        await expect(tmdb.getTrending()).rejects.toBeInstanceOf(TmdbUnavailableError);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(await isTmdbAvailable()).toBe(false);
    });

    it('invité sans clé : le relais de Nyx avec le jeton d\'invité', async () => {
        guestAvailable = true;
        guestToken = 'jeton-invite';
        expect(await isTmdbAvailable()).toBe(true);
        expect(await getTmdbAccessKind()).toBe('proxy');
        expect(takeGuestRelayToken).not.toHaveBeenCalled(); // vérifier ne crée ni ne compte rien
        await tmdb.getPopular();
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toContain('/functions/v1/tmdb-proxy/movie/popular');
        expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer jeton-invite');
    });

    it('invité avec sa clé personnelle : TMDB directement, le relais n\'est pas demandé', async () => {
        guestAvailable = true;
        guestToken = 'jeton-invite';
        personalKey = { kind: 'api-key', value: 'cle-perso' };
        await tmdb.getPopular();
        expect(new URL(fetchMock.mock.calls[0][0]).origin).toBe('https://api.themoviedb.org');
        expect(takeGuestRelayToken).not.toHaveBeenCalled();
    });

    it('invité refusé par le relais (limite du jour) : la pause est retenue, erreur reconnaissable', async () => {
        guestAvailable = true;
        guestToken = 'jeton-invite';
        const body = { error: 'Guest limit reached', reason: 'day', retry_at: '2026-11-03T00:00:00Z' };
        fetchMock.mockResolvedValueOnce({ ok: false, status: 429, statusText: 'Too Many Requests', json: async () => body } as never);
        await expect(tmdb.getTrending()).rejects.toBeInstanceOf(TmdbUnavailableError);
        expect(noteGuestRelayResponse).toHaveBeenCalledWith(429, body);
        // jamais réessayé : chaque appel refusé compte dans le quota de Nyx
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('un compte refusé par le relais garde l\'erreur d\'avant (aucune pause d\'invité)', async () => {
        session = { access_token: 'jeton-du-compte' };
        // (un 429 d'un compte est réessayé par le limiteur, comme avant ; un 503 ne l'est pas)
        fetchMock.mockResolvedValueOnce({ ok: false, status: 503, statusText: 'Service Unavailable', json: async () => ({}) } as never);
        await expect(tmdb.getTrending()).rejects.toMatchObject({ status: 503 });
        expect(noteGuestRelayResponse).not.toHaveBeenCalled();
    });

    it('invité dont le relais est en pause : aucune requête', async () => {
        guestAvailable = false;
        await expect(tmdb.getTrending()).rejects.toBeInstanceOf(TmdbUnavailableError);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(await isTmdbAvailable()).toBe(false);
    });

    it('demande d\'invité déjà en file quand le relais refuse : elle ne part pas', async () => {
        guestAvailable = true;
        guestToken = 'jeton-invite';
        guestStopped = true;
        await expect(tmdb.getTopRated('movie')).rejects.toBeInstanceOf(TmdbUnavailableError);
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
