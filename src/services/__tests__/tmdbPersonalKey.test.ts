/**
 * Clé TMDB personnelle : formes acceptées, appel direct à TMDB, clé gardée par espace.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let databaseName: string | null = 'nyxplayer_a.db';
const meta = new Map<string, Map<string, string>>();
const getMeta = vi.fn(async (key: string) => meta.get(databaseName ?? '')?.get(key) ?? null);
const setMeta = vi.fn(async (key: string, value: string) => {
    const name = databaseName ?? '';
    if (!meta.has(name)) meta.set(name, new Map());
    meta.get(name)!.set(key, value);
});
vi.mock('../dbCore', () => ({
    getMeta: (key: string) => getMeta(key),
    setMeta: (key: string, value: string) => setMeta(key, value),
    getDatabaseFileName: () => databaseName,
}));

import {
    parsePersonalTmdbKey, directTmdbRequest, checkPersonalTmdbKey,
    getPersonalTmdbKey, savePersonalTmdbKey, clearPersonalTmdbKey, resetPersonalTmdbKeyCache,
    TMDB_PERSONAL_KEY_META,
} from '../tmdbPersonalKey';

const API_KEY = '0123456789abcdef0123456789ABCDEF';
const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiJ4In0.c2lnbmF0dXJl';

describe('clé TMDB personnelle : formes', () => {
    it('accepte la clé d\'API et le jeton de lecture, tels que collés (espaces, retours à la ligne)', () => {
        expect(parsePersonalTmdbKey(`  ${API_KEY}\n`)).toEqual({ kind: 'api-key', value: API_KEY.toLowerCase() });
        expect(parsePersonalTmdbKey(` ${TOKEN.slice(0, 20)}\n${TOKEN.slice(20)} `)).toEqual({ kind: 'read-token', value: TOKEN });
    });

    it('refuse tout le reste', () => {
        for (const bad of ['', 'abc', `${API_KEY}0`, 'g'.repeat(32), 'eyJ.pas-un-jeton', `eyJ${'a'.repeat(2100)}.b.c`, 'Bearer ' + 'x']) {
            expect(parsePersonalTmdbKey(bad)).toBeNull();
        }
    });
});

describe('clé TMDB personnelle : appel direct', () => {
    it('la clé d\'API part dans l\'adresse, sans en-tête d\'autorisation', () => {
        const { url, headers } = directTmdbRequest('/movie/42', { language: 'fr-FR', empty: '' }, { kind: 'api-key', value: 'k' });
        const parsed = new URL(url);
        expect(parsed.origin + parsed.pathname).toBe('https://api.themoviedb.org/3/movie/42');
        expect(parsed.searchParams.get('api_key')).toBe('k');
        expect(parsed.searchParams.get('language')).toBe('fr-FR');
        expect(parsed.searchParams.has('empty')).toBe(false);
        expect(headers.Authorization).toBeUndefined();
    });

    it('le jeton de lecture part dans l\'en-tête, jamais dans l\'adresse', () => {
        const { url, headers } = directTmdbRequest('/search/movie', { query: 'x' }, { kind: 'read-token', value: TOKEN });
        expect(url).not.toContain(TOKEN);
        expect(new URL(url).searchParams.has('api_key')).toBe(false);
        expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
    });

    it('refuse un chemin qui sortirait des routes de TMDB (numéro abîmé venu du fournisseur)', () => {
        const key = { kind: 'api-key', value: 'k' } as const;
        for (const bad of ['/movie/1/../../x', '/movie/1?x=1', '/movie/1#x', '//evil.example/x', 'movie/1', '/movie/ 1', '/movie/%2e%2e']) {
            expect(() => directTmdbRequest(bad, {}, key)).toThrow();
        }
        expect(() => directTmdbRequest('/tv/42/season/3', {}, key)).not.toThrow();
        expect(() => directTmdbRequest('/movie/now_playing', {}, key)).not.toThrow();
    });

    it('essai de la clé : acceptée, refusée par TMDB, ou TMDB injoignable', async () => {
        const key = { kind: 'api-key', value: 'k' } as const;
        const answer = (status: number) => vi.fn(async () => ({ ok: status < 300, status }) as Response);
        expect(await checkPersonalTmdbKey(key, answer(200))).toBe('ok');
        expect(await checkPersonalTmdbKey(key, answer(401))).toBe('refused');
        expect(await checkPersonalTmdbKey(key, answer(503))).toBe('unreachable');
        expect(await checkPersonalTmdbKey(key, vi.fn(async () => { throw new TypeError('offline'); }))).toBe('unreachable');
    });
});

describe('clé TMDB personnelle : gardée par espace', () => {
    beforeEach(() => {
        meta.clear();
        databaseName = 'nyxplayer_a.db';
        resetPersonalTmdbKeyCache();
        vi.clearAllMocks();
    });

    it('enregistrée dans l\'espace ouvert, relue sans nouvel accès à la base', async () => {
        await savePersonalTmdbKey(API_KEY);
        expect(setMeta).toHaveBeenCalledWith(TMDB_PERSONAL_KEY_META, API_KEY.toLowerCase());
        expect(await getPersonalTmdbKey()).toEqual({ kind: 'api-key', value: API_KEY.toLowerCase() });
        expect(getMeta).not.toHaveBeenCalled();
    });

    it('un autre espace ne voit pas la clé du premier', async () => {
        await savePersonalTmdbKey(API_KEY);
        databaseName = 'nyxplayer_b.db';
        expect(await getPersonalTmdbKey()).toBeNull();
        databaseName = 'nyxplayer_a.db';
        expect(await getPersonalTmdbKey()).not.toBeNull();
    });

    it('retirée, elle n\'est plus utilisée', async () => {
        await savePersonalTmdbKey(TOKEN);
        await clearPersonalTmdbKey();
        expect(await getPersonalTmdbKey()).toBeNull();
        resetPersonalTmdbKeyCache();
        expect(await getPersonalTmdbKey()).toBeNull();
    });

    it('refuse d\'enregistrer ce qui n\'est pas une clé, ou sans espace ouvert', async () => {
        await expect(savePersonalTmdbKey('pas une clé')).rejects.toThrow();
        databaseName = null;
        await expect(savePersonalTmdbKey(API_KEY)).rejects.toThrow();
        expect(setMeta).not.toHaveBeenCalled();
        expect(await getPersonalTmdbKey()).toBeNull();
    });

    it('une valeur abîmée dans la base n\'est pas prise pour une clé', async () => {
        meta.set('nyxplayer_a.db', new Map([[TMDB_PERSONAL_KEY_META, 'abîmée']]));
        expect(await getPersonalTmdbKey()).toBeNull();
    });

    it('si l\'espace change pendant la lecture, sa clé n\'est pas gardée pour le suivant', async () => {
        meta.set('nyxplayer_a.db', new Map([[TMDB_PERSONAL_KEY_META, API_KEY]]));
        getMeta.mockImplementationOnce(async (key: string) => {
            const value = meta.get('nyxplayer_a.db')?.get(key) ?? null;
            databaseName = 'nyxplayer_b.db';
            return value;
        });
        await getPersonalTmdbKey();
        expect(await getPersonalTmdbKey()).toBeNull();
    });

    it('une lecture commencée avant l\'enregistrement ne remet pas l\'ancienne valeur en mémoire', async () => {
        let release: () => void = () => {};
        getMeta.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve(null); }));
        const slowRead = getPersonalTmdbKey(); // lit « aucune clé », lentement
        await savePersonalTmdbKey(API_KEY);
        release();
        await slowRead;
        expect(await getPersonalTmdbKey()).toEqual({ kind: 'api-key', value: API_KEY.toLowerCase() });
    });

    it('base illisible : pas de clé, sans erreur', async () => {
        getMeta.mockRejectedValueOnce(new Error('locked'));
        expect(await getPersonalTmdbKey()).toBeNull();
    });
});
