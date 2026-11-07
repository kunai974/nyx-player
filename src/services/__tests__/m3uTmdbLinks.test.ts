/**
 * Fiches TMDB des listes M3U trouvées par le titre : une recherche par entrée, réponse gardée
 * (« pas trouvé » compris), jamais pour une entrée Xtream, réglage et plafonds respectés.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

interface Entry { name: string; tmdb_id: number | null; data: string | null }
interface Link { name: string; tmdb_id: number; checked_at: number }

const tables: Record<string, Map<number, Entry>> = { movies: new Map(), series: new Map() };
const links = new Map<string, Link>();
const meta = new Map<string, string>();
let pending: { kind: 'movie' | 'series'; id: number }[] = [];

const select = vi.fn(async (sql: string, params: unknown[]) => {
    if (sql.includes('UNION ALL')) return pending.slice(0, Number(params[2]));
    if (sql.includes('FROM m3u_tmdb_links')) {
        const link = links.get(`${String(params[0])}:${String(params[1])}`);
        return link ? [link] : [];
    }
    const table = /FROM (movies|series)/.exec(sql)![1];
    const row = tables[table].get(Number(params[0]));
    return row ? [{ ...row }] : [];
});
const execute = vi.fn(async (sql: string, params: unknown[]) => {
    if (/^INSERT (OR REPLACE )?INTO m3u_tmdb_links/.test(sql)) {
        const [kind, id, name, tmdbId, checkedAt] = params as [string, number, string, number, number];
        const old = links.get(`${kind}:${id}`);
        // Règle de l'écriture (ON CONFLICT … WHERE) : « pas trouvé » n'écrase pas un lien noté pour le même nom
        const guarded = sql.includes('ON CONFLICT');
        if (guarded && old && !(tmdbId > 0 || old.tmdb_id <= 0 || old.name !== name)) return;
        links.set(`${kind}:${id}`, { name, tmdb_id: tmdbId, checked_at: checkedAt });
        return;
    }
    // Rien d'autre n'est écrit : le lien n'entre jamais dans la colonne tmdb_id du catalogue
    throw new Error(`écriture inattendue : ${sql}`);
});
vi.mock('../dbCore', () => ({
    getDatabase: async () => ({ select, execute }),
    getMeta: async (key: string) => meta.get(key) ?? null,
    setMeta: async (key: string, value: string) => { meta.set(key, value); },
}));

const prefs = vi.hoisted(() => ({ titleSearch: true }));
vi.mock('../preferencesService', () => ({ isTmdbTitleSearchEnabled: () => prefs.titleSearch }));

const tmdbMock = vi.hoisted(() => ({
    access: 'proxy' as 'proxy' | 'direct' | null,
    personalKey: null as string | null,
    searchMovie: vi.fn(),
    searchTv: vi.fn(),
}));
vi.mock('../tmdbApi', () => ({
    default: { searchMovie: tmdbMock.searchMovie, searchTv: tmdbMock.searchTv },
    getTmdbAccessKind: async () => tmdbMock.access,
}));
vi.mock('../tmdbPersonalKey', () => ({ getPersonalTmdbKey: async () => tmdbMock.personalKey }));

import { findM3uTmdbId, linkM3uTitlesInBackground, NOT_FOUND_RETRY_MS, DAILY_BACKGROUND_LIMIT } from '../m3uTmdbLinks';

const m3u = (extra: Record<string, unknown> = {}) => JSON.stringify({ source: 'm3u', url: 'http://cdn.example/f.mkv', ...extra });
const movieResults = (...results: { id: number; title: string; date: string }[]) => ({
    page: 1, total_pages: 1, total_results: results.length,
    results: results.map((r) => ({ id: r.id, title: r.title, original_title: r.title, release_date: r.date })),
});

beforeEach(() => {
    tables.movies.clear();
    tables.series.clear();
    links.clear();
    meta.clear();
    pending = [];
    prefs.titleSearch = true;
    tmdbMock.access = 'proxy';
    tmdbMock.personalKey = null;
    tmdbMock.searchMovie.mockReset().mockResolvedValue(movieResults());
    tmdbMock.searchTv.mockReset().mockResolvedValue({ page: 1, total_pages: 1, total_results: 0, results: [] });
    select.mockClear();
    execute.mockClear();
});

describe('findM3uTmdbId', () => {
    it('film M3U : cherché par son titre nettoyé, lien sûr gardé à part, jamais écrit dans le catalogue', async () => {
        tables.movies.set(5, { name: 'FR: Inception', tmdb_id: null, data: m3u({ year: 2010 }) });
        tmdbMock.searchMovie.mockResolvedValue(movieResults({ id: 27205, title: 'Inception', date: '2010-07-15' }));

        expect(await findM3uTmdbId('movie', 5)).toBe(27205);
        expect(tmdbMock.searchMovie).toHaveBeenCalledWith('Inception', undefined, { directOnly: false });
        expect(links.get('movie:5')).toMatchObject({ name: 'FR: Inception', tmdb_id: 27205 });
        // Posé en mémoire seulement, tant que le réglage est allumé : couper le réglage l'enlève
        expect(tables.movies.get(5)!.tmdb_id).toBeNull();
    });

    it('deuxième ouverture : aucune nouvelle recherche', async () => {
        tables.movies.set(5, { name: 'Inception (2010)', tmdb_id: null, data: m3u() });
        tmdbMock.searchMovie.mockResolvedValue(movieResults({ id: 27205, title: 'Inception', date: '2010-07-15' }));
        await findM3uTmdbId('movie', 5);
        expect(await findM3uTmdbId('movie', 5)).toBe(27205);
        expect(tmdbMock.searchMovie).toHaveBeenCalledTimes(1);
    });

    it('pas de lien sûr : « pas trouvé » gardé, pas redemandé avant 30 jours', async () => {
        tables.movies.set(6, { name: 'Le Dîner (2017)', tmdb_id: null, data: m3u() });
        tmdbMock.searchMovie.mockResolvedValue(movieResults({ id: 1, title: 'Le Dîner de cons', date: '1998-04-15' }));
        expect(await findM3uTmdbId('movie', 6)).toBe(0);
        expect(await findM3uTmdbId('movie', 6)).toBe(0);
        expect(tmdbMock.searchMovie).toHaveBeenCalledTimes(1);
        expect(tables.movies.get(6)!.tmdb_id).toBeNull();

        links.get('movie:6')!.checked_at = Date.now() - NOT_FOUND_RETRY_MS - 1;
        await findM3uTmdbId('movie', 6);
        expect(tmdbMock.searchMovie).toHaveBeenCalledTimes(2);
    });

    it('lecture de la liste pendant la recherche : le lien n\'est pas posé sur le nouveau nom', async () => {
        tables.movies.set(8, { name: 'Inception (2010)', tmdb_id: null, data: m3u() });
        tmdbMock.searchMovie.mockImplementation(async () => {
            tables.movies.get(8)!.name = 'Autre film';
            return movieResults({ id: 27205, title: 'Inception', date: '2010-07-15' });
        });
        await findM3uTmdbId('movie', 8);
        // Noté sous le nom cherché : il ne sera pas posé sur « Autre film »
        expect(links.get('movie:8')).toMatchObject({ name: 'Inception (2010)', tmdb_id: 27205 });
    });

    it('entrée renommée dans la liste : cherchée de nouveau', async () => {
        tables.movies.set(7, { name: 'Ancien nom', tmdb_id: null, data: m3u() });
        links.set('movie:7', { name: 'Ancien nom', tmdb_id: 0, checked_at: Date.now() });
        tables.movies.get(7)!.name = 'Inception (2010)';
        tmdbMock.searchMovie.mockResolvedValue(movieResults({ id: 27205, title: 'Inception', date: '2010-07-15' }));
        expect(await findM3uTmdbId('movie', 7)).toBe(27205);
    });

    it('série M3U : recherche de série', async () => {
        tables.series.set(9, { name: 'Breaking Bad', tmdb_id: null, data: JSON.stringify({ source: 'm3u', episodes: [] }) });
        tmdbMock.searchTv.mockResolvedValue({ page: 1, total_pages: 1, total_results: 1, results: [{ id: 1396, name: 'Breaking Bad', original_name: 'Breaking Bad', first_air_date: '2008-01-20' }] });
        expect(await findM3uTmdbId('series', 9)).toBe(1396);
        expect(tmdbMock.searchMovie).not.toHaveBeenCalled();
    });

    it('entrée Xtream sans numéro TMDB : jamais cherchée (comme avant)', async () => {
        tables.movies.set(10, { name: 'Inception', tmdb_id: null, data: null });
        tables.movies.set(11, { name: 'Inception', tmdb_id: null, data: JSON.stringify({ plot: 'x' }) });
        expect(await findM3uTmdbId('movie', 10)).toBe(0);
        expect(await findM3uTmdbId('movie', 11)).toBe(0);
        expect(tmdbMock.searchMovie).not.toHaveBeenCalled();
        expect(execute).not.toHaveBeenCalled();
    });

    it('réglage coupé, ou ni compte ni clé : aucun appel', async () => {
        tables.movies.set(5, { name: 'Inception', tmdb_id: null, data: m3u() });
        prefs.titleSearch = false;
        expect(await findM3uTmdbId('movie', 5)).toBe(0);
        prefs.titleSearch = true;
        tmdbMock.access = null;
        expect(await findM3uTmdbId('movie', 5)).toBe(0);
        expect(tmdbMock.searchMovie).not.toHaveBeenCalled();
        // Rien n'est noté : la recherche se fera quand un accès existera
        expect(links.size).toBe(0);
    });

    it('TMDB injoignable : 0, rien de noté (réessayé plus tard), jamais d\'erreur', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        tables.movies.set(5, { name: 'Inception', tmdb_id: null, data: m3u() });
        tmdbMock.searchMovie.mockRejectedValue(new Error('hors ligne'));
        expect(await findM3uTmdbId('movie', 5)).toBe(0);
        expect(links.size).toBe(0);
        warn.mockRestore();
    });

    it('base occupée au moment de noter : la réponse sert encore pendant la session', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        tables.movies.set(12, { name: 'Inception (2010)', tmdb_id: null, data: m3u() });
        tmdbMock.searchMovie.mockResolvedValue(movieResults({ id: 27205, title: 'Inception', date: '2010-07-15' }));
        execute.mockRejectedValueOnce(new Error('database is locked'));
        expect(await findM3uTmdbId('movie', 12)).toBe(27205);
        expect(await findM3uTmdbId('movie', 12)).toBe(27205);
        expect(tmdbMock.searchMovie).toHaveBeenCalledTimes(1);
        warn.mockRestore();
    });

    it('base occupée deux fois de suite : la réponse gardée sert encore', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        tables.movies.set(13, { name: 'Inception (2010)', tmdb_id: null, data: m3u() });
        tmdbMock.searchMovie.mockResolvedValue(movieResults({ id: 27205, title: 'Inception', date: '2010-07-15' }));
        execute.mockRejectedValueOnce(new Error('database is locked')).mockRejectedValueOnce(new Error('database is locked'));
        expect(await findM3uTmdbId('movie', 13)).toBe(27205);
        expect(await findM3uTmdbId('movie', 13)).toBe(27205);
        expect(tmdbMock.searchMovie).toHaveBeenCalledTimes(1);
        warn.mockRestore();
    });

    it('réponse gardée pour un ancien nom : le nouveau nom est cherché', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        tables.movies.set(14, { name: 'Ancien titre', tmdb_id: null, data: m3u() });
        execute.mockRejectedValueOnce(new Error('database is locked'));
        expect(await findM3uTmdbId('movie', 14)).toBe(0);
        tables.movies.get(14)!.name = 'Inception (2010)';
        tmdbMock.searchMovie.mockResolvedValue(movieResults({ id: 27205, title: 'Inception', date: '2010-07-15' }));
        expect(await findM3uTmdbId('movie', 14)).toBe(27205);
        expect(tmdbMock.searchMovie).toHaveBeenCalledTimes(2);
        warn.mockRestore();
    });

    it('« pas trouvé » fini après coup : n\'efface pas un lien noté entre-temps pour le même nom', async () => {
        tables.movies.set(15, { name: 'Inception (2010)', tmdb_id: null, data: m3u() });
        tmdbMock.searchMovie.mockImplementation(async () => {
            // L'autre recherche (catalogue, autre écran) trouve et note le lien pendant celle-ci
            links.set('movie:15', { name: 'Inception (2010)', tmdb_id: 27205, checked_at: 1 });
            return movieResults();
        });
        expect(await findM3uTmdbId('movie', 15)).toBe(0);
        expect(links.get('movie:15')).toMatchObject({ tmdb_id: 27205 });
    });

    it('deux ouvertures en même temps : une seule recherche', async () => {
        tables.movies.set(5, { name: 'Inception (2010)', tmdb_id: null, data: m3u() });
        tmdbMock.searchMovie.mockResolvedValue(movieResults({ id: 27205, title: 'Inception', date: '2010-07-15' }));
        const [a, b] = await Promise.all([findM3uTmdbId('movie', 5), findM3uTmdbId('movie', 5)]);
        expect([a, b]).toEqual([27205, 27205]);
        expect(tmdbMock.searchMovie).toHaveBeenCalledTimes(1);
    });
});

describe('linkM3uTitlesInBackground', () => {
    const fill = (n: number) => {
        for (let i = 1; i <= n; i++) {
            tables.movies.set(i, { name: `Film ${i} (2001)`, tmdb_id: null, data: m3u() });
            pending.push({ kind: 'movie', id: i });
        }
    };

    it('par le relais de Nyx (compte sans clé personnelle) : aucune recherche en arrière-plan', async () => {
        fill(3);
        expect(DAILY_BACKGROUND_LIMIT.proxy).toBe(0);
        expect(await linkM3uTitlesInBackground()).toEqual({ searched: 0, linked: 0 });
        expect(tmdbMock.searchMovie).not.toHaveBeenCalled();
    });

    it('connecté avec une clé personnelle : toujours par la clé, jamais par le relais', async () => {
        tmdbMock.personalKey = 'cle';
        fill(1);
        await linkM3uTitlesInBackground();
        expect(tmdbMock.searchMovie).toHaveBeenCalledWith('Film 1', undefined, { directOnly: true });
    });

    it('avec une clé personnelle : recherches comptées, plafond du jour respecté', async () => {
        tmdbMock.personalKey = 'cle';
        tmdbMock.access = 'direct';
        fill(3);
        tmdbMock.searchMovie.mockImplementation(async (query: string) => movieResults({ id: Number(query.split(' ')[1]) + 100, title: query, date: '2001-01-01' }));
        const day = new Date().toISOString().slice(0, 10);
        meta.set('m3u_tmdb_title_search_day', JSON.stringify({ day, count: DAILY_BACKGROUND_LIMIT.direct - 2 }));

        expect(await linkM3uTitlesInBackground()).toEqual({ searched: 2, linked: 2 });
        expect(links.get('movie:1')?.tmdb_id).toBe(101);
        expect(links.has('movie:3')).toBe(false);
        expect(JSON.parse(meta.get('m3u_tmdb_title_search_day')!)).toEqual({ day, count: DAILY_BACKGROUND_LIMIT.direct });
        // Compteur d'un autre jour : repart de zéro
        meta.set('m3u_tmdb_title_search_day', JSON.stringify({ day: '2000-01-01', count: 999999 }));
        expect((await linkM3uTitlesInBackground()).searched).toBe(1);
    });

    it('compte changé en route : arrêt', async () => {
        tmdbMock.personalKey = 'cle';
        fill(3);
        let calls = 0;
        expect(await linkM3uTitlesInBackground(() => calls++ < 1)).toMatchObject({ searched: 1 });
    });

    it('TMDB injoignable : arrêt sans erreur', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        tmdbMock.personalKey = 'cle';
        fill(3);
        tmdbMock.searchMovie.mockRejectedValue(new Error('hors ligne'));
        expect(await linkM3uTitlesInBackground()).toEqual({ searched: 0, linked: 0 });
        expect(tmdbMock.searchMovie).toHaveBeenCalledTimes(1);
        warn.mockRestore();
    });
});
