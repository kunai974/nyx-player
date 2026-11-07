/**
 * Cartes M3U de l'accueil : cherchées ensemble par le relais (demandes groupées de 20 titres au plus),
 * une seule fois par titre, jamais avec une clé personnelle ni sans accès, plafond du jour respecté.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

interface Entry { name: string; tmdb_id: number | null; data: string | null }
interface Link { name: string; tmdb_id: number; checked_at: number }

const tables: Record<string, Map<number, Entry>> = { movies: new Map(), series: new Map() };
const links = new Map<string, Link>();
const meta = new Map<string, string>();

const select = vi.fn(async (sql: string, params: unknown[]) => {
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
    if (sql.includes('title_tmdb_posters')) return;
    // Rien d'autre n'est écrit : le lien n'entre jamais dans la colonne tmdb_id du catalogue
    throw new Error(`écriture inattendue : ${sql}`);
});
vi.mock('../dbCore', () => ({
    getDatabase: async () => ({ select, execute }),
    getDatabaseFileName: () => 'nyxplayer_a.db',
    getMeta: async (key: string) => meta.get(key) ?? null,
    setMeta: async (key: string, value: string) => { meta.set(key, value); },
}));

const prefs = vi.hoisted(() => ({ titleSearch: true }));
vi.mock('../preferencesService', () => ({ isTmdbTitleSearchEnabled: () => prefs.titleSearch }));

const tmdbMock = vi.hoisted(() => ({
    access: 'proxy' as 'proxy' | 'direct' | null,
    account: true,
    personalKey: null as string | null,
    searchMovie: vi.fn(),
    searchTv: vi.fn(),
    searchTitlesBatch: vi.fn(),
}));
vi.mock('../tmdbApi', () => ({
    default: { searchMovie: tmdbMock.searchMovie, searchTv: tmdbMock.searchTv, searchTitlesBatch: tmdbMock.searchTitlesBatch },
    getTmdbAccessKind: async () => tmdbMock.access,
    isTmdbAccountRelay: async () => tmdbMock.access === 'proxy' && tmdbMock.account,
    titleBatchChunks: real.titleBatchChunks,
}));
const real = vi.hoisted(() => ({
    titleBatchChunks: <T,>(items: readonly T[]): T[][] => {
        const out: T[][] = [];
        for (let i = 0; i < items.length; i += 20) out.push(items.slice(i, i + 20));
        return out;
    },
}));
vi.mock('../tmdbPersonalKey', () => ({ getPersonalTmdbKey: async () => tmdbMock.personalKey }));

import { DAILY_HOME_LIMIT, HOME_GATHER_TIMEOUT_MS, HOME_SEARCH_GATHER_MS, forgetHomeTitleSearches, requestShownM3uTitles, searchShownM3uTitles } from '../m3uTmdbLinks';

const m3u = (extra: Record<string, unknown> = {}) => JSON.stringify({ source: 'm3u', url: 'http://cdn.example/f.mkv', ...extra });

/** Le relais : chaque titre demandé trouve un film du même nom (numéro = position dans `known`) */
const known = ['Inception', 'Dune', 'Sintel'];
function relayAnswers(items: { kind: 'movie' | 'tv'; query: string }[]) {
    return items.map((item) => {
        const n = known.indexOf(item.query);
        return {
            kind: item.kind, query: item.query, status: 'ok',
            results: n < 0 ? [] : [{ id: 1000 + n, title: item.query, original_title: item.query, release_date: '2010-01-01', poster_path: `/p${n}.jpg` }],
        };
    });
}

beforeEach(() => {
    tables.movies.clear();
    tables.series.clear();
    links.clear();
    meta.clear();
    prefs.titleSearch = true;
    tmdbMock.access = 'proxy';
    tmdbMock.account = true;
    tmdbMock.searchMovie.mockReset();
    tmdbMock.searchTv.mockReset();
    tmdbMock.searchTitlesBatch.mockReset().mockImplementation(async (items) => relayAnswers(items));
    forgetHomeTitleSearches();
});

describe('recherche groupée des cartes de l\'accueil', () => {
    it('40 cartes sans fiche : 2 appels groupés au relais, aucune recherche titre par titre', async () => {
        for (let id = 1; id <= 40; id++) tables.movies.set(id, { name: `Film ${id} (2001)`, tmdb_id: null, data: m3u({ year: 2001 }) });
        await searchShownM3uTitles(Array.from({ length: 40 }, (_, i) => ({ kind: 'movie' as const, id: i + 1 })));
        expect(tmdbMock.searchTitlesBatch).toHaveBeenCalledTimes(2);
        expect(tmdbMock.searchTitlesBatch.mock.calls.map(([items]) => items.length)).toEqual([20, 20]);
        expect(tmdbMock.searchMovie).not.toHaveBeenCalled();
        // « Pas trouvé » noté : jamais recherché de nouveau avant 30 jours
        expect(links.get('movie:1')).toMatchObject({ tmdb_id: 0 });
    });

    it('trouvé : lien noté ; titre déjà lié, entrée Xtream ou déjà demandé : rien ne part', async () => {
        tables.movies.set(1, { name: 'Inception (2010)', tmdb_id: null, data: m3u({ year: 2010 }) });
        tables.movies.set(2, { name: 'Dune (2021)', tmdb_id: null, data: m3u({ year: 2021 }) });
        links.set('movie:2', { name: 'Dune (2021)', tmdb_id: 438631, checked_at: 1 });
        tables.movies.set(3, { name: 'Sintel', tmdb_id: null, data: JSON.stringify({ source: 'xtream' }) });
        const found = await searchShownM3uTitles([{ kind: 'movie', id: 1 }, { kind: 'movie', id: 2 }, { kind: 'movie', id: 3 }]);
        expect(tmdbMock.searchTitlesBatch).toHaveBeenCalledTimes(1);
        expect(tmdbMock.searchTitlesBatch.mock.calls[0][0]).toEqual([{ kind: 'movie', query: 'Inception' }]);
        expect(found.get('movie:1')).toBe(1000);
        expect(links.get('movie:1')).toMatchObject({ tmdb_id: 1000 });

        // La même rangée revue : aucun appel
        await searchShownM3uTitles([{ kind: 'movie', id: 1 }]);
        expect(tmdbMock.searchTitlesBatch).toHaveBeenCalledTimes(1);
    });

    it('titre refusé par le relais (limite) ou en erreur : rien n\'est noté, il pourra être cherché plus tard', async () => {
        tables.movies.set(1, { name: 'Inception (2010)', tmdb_id: null, data: m3u({ year: 2010 }) });
        tables.series.set(2, { name: 'Dune', tmdb_id: null, data: m3u() });
        tmdbMock.searchTitlesBatch.mockImplementation(async (items: { kind: 'movie' | 'tv'; query: string }[]) =>
            items.map((item) => ({ kind: item.kind, query: item.query, status: item.kind === 'movie' ? 'limited' : 'error' })));
        await searchShownM3uTitles([{ kind: 'movie', id: 1 }, { kind: 'series', id: 2 }]);
        expect(tmdbMock.searchTitlesBatch.mock.calls[0][0]).toEqual([{ kind: 'movie', query: 'Inception' }, { kind: 'tv', query: 'Dune' }]);
        expect(links.size).toBe(0);
    });

    it('relais injoignable : rien n\'est noté, aucune exception', async () => {
        tables.movies.set(1, { name: 'Inception (2010)', tmdb_id: null, data: m3u({ year: 2010 }) });
        tmdbMock.searchTitlesBatch.mockRejectedValue(new Error('réseau'));
        await expect(searchShownM3uTitles([{ kind: 'movie', id: 1 }])).resolves.toEqual(new Map());
        expect(links.size).toBe(0);
    });

    it('invité, clé personnelle, aucun accès ou réglage coupé : aucun appel', async () => {
        tables.movies.set(1, { name: 'Inception (2010)', tmdb_id: null, data: m3u({ year: 2010 }) });
        const setups = [
            () => { tmdbMock.account = false; },
            () => { tmdbMock.access = 'direct'; },
            () => { tmdbMock.access = null; },
            () => { prefs.titleSearch = false; },
        ];
        for (const setup of setups) {
            forgetHomeTitleSearches();
            tmdbMock.access = 'proxy';
            tmdbMock.account = true;
            prefs.titleSearch = true;
            setup();
            await searchShownM3uTitles([{ kind: 'movie', id: 1 }]);
        }
        expect(tmdbMock.searchTitlesBatch).not.toHaveBeenCalled();
    });

    it(`plafond de ${DAILY_HOME_LIMIT} titres par jour, compté sur l'appareil`, async () => {
        const day = new Date().toISOString().slice(0, 10);
        meta.set('m3u_tmdb_home_search_day', JSON.stringify({ day, count: DAILY_HOME_LIMIT - 3 }));
        for (let id = 1; id <= 10; id++) tables.movies.set(id, { name: `Film ${id} (2001)`, tmdb_id: null, data: m3u({ year: 2001 }) });
        await searchShownM3uTitles(Array.from({ length: 10 }, (_, i) => ({ kind: 'movie' as const, id: i + 1 })));
        expect(tmdbMock.searchTitlesBatch).toHaveBeenCalledTimes(1);
        expect(tmdbMock.searchTitlesBatch.mock.calls[0][0]).toHaveLength(3);
        expect(JSON.parse(meta.get('m3u_tmdb_home_search_day')!)).toEqual({ day, count: DAILY_HOME_LIMIT });
        // Les titres au-delà du plafond ne sont pas notés « pas trouvé »
        expect(links.size).toBe(3);
    });

    it('rangées affichées ensemble : leurs cartes partent dans le même appel groupé', async () => {
        vi.useFakeTimers();
        try {
            for (let id = 1; id <= 12; id++) tables.movies.set(id, { name: `Film ${id} (2001)`, tmdb_id: null, data: m3u({ year: 2001 }) });
            requestShownM3uTitles(Array.from({ length: 6 }, (_, i) => ({ kind: 'movie' as const, id: i + 1 })));
            requestShownM3uTitles(Array.from({ length: 6 }, (_, i) => ({ kind: 'movie' as const, id: i + 7 })));
            expect(tmdbMock.searchTitlesBatch).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(HOME_SEARCH_GATHER_MS);
            await vi.runAllTimersAsync();
        } finally {
            vi.useRealTimers();
        }
        await vi.waitFor(() => expect(tmdbMock.searchTitlesBatch).toHaveBeenCalledTimes(1));
        expect(tmdbMock.searchTitlesBatch.mock.calls[0][0]).toHaveLength(12);
    });

    it("deux recherches lancées ensemble : l'une après l'autre, le plafond du jour tient", async () => {
        const day = new Date().toISOString().slice(0, 10);
        meta.set('m3u_tmdb_home_search_day', JSON.stringify({ day, count: DAILY_HOME_LIMIT - 4 }));
        for (let id = 1; id <= 6; id++) tables.movies.set(id, { name: `Film ${id} (2001)`, tmdb_id: null, data: m3u({ year: 2001 }) });
        await Promise.all([
            searchShownM3uTitles([1, 2, 3].map((id) => ({ kind: 'movie' as const, id }))),
            searchShownM3uTitles([4, 5, 6].map((id) => ({ kind: 'movie' as const, id }))),
        ]);
        const sentTitles = tmdbMock.searchTitlesBatch.mock.calls.reduce((n, [items]) => n + items.length, 0);
        expect(sentTitles).toBe(4);
        expect(JSON.parse(meta.get('m3u_tmdb_home_search_day')!).count).toBe(DAILY_HOME_LIMIT);
    });

    it('une lecture de la base bloquée ne retient pas les autres titres', async () => {
        vi.useFakeTimers();
        try {
            tables.movies.set(1, { name: 'Inception (2010)', tmdb_id: null, data: m3u({ year: 2010 }) });
            tables.movies.set(2, { name: 'Bloqué (2001)', tmdb_id: null, data: m3u({ year: 2001 }) });
            const normal = select.getMockImplementation()!;
            select.mockImplementation(async (sql: string, params: unknown[]) =>
                (/FROM movies/.test(sql) && Number(params[0]) === 2 ? new Promise<never>(() => undefined) : normal(sql, params)));
            const run = searchShownM3uTitles([{ kind: 'movie', id: 1 }, { kind: 'movie', id: 2 }]);
            await vi.advanceTimersByTimeAsync(HOME_GATHER_TIMEOUT_MS * 2 + 10);
            const found = await run;
            select.mockImplementation(normal);
            expect(tmdbMock.searchTitlesBatch).toHaveBeenCalledTimes(1);
            expect(found.get('movie:1')).toBe(1000);
        } finally {
            vi.useRealTimers();
        }
    });
});
