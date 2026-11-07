/**
 * Fiches TMDB retrouvées par le titre pour un fournisseur sans numéro TMDB : listes de l'accueil
 * comparées au catalogue (aucune demande pour un nom avec année), confirmation plafonnée pour un nom
 * sans année, liens gardés à part (jamais dans la colonne du fournisseur), réglage respecté.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LightIndexes, LightMovie, LightSeries } from '../../types/lightIndex';

interface Link { kind: string; id: number; name: string; tmdb_id: number; checked_at: number }
const links = new Map<string, Link>();
const meta = new Map<string, string>();
let storedRows: { kind: string; id: number; tmdb_id: number }[] = [];
/** Liens gardés dont l'entrée a changé de nom depuis */
let movedRows: { kind: string; id: number; name: string; tmdb_id: number }[] = [];
let changedRows: { kind: string; id: number; tmdb_id: number; old_name: string; new_name: string }[] = [];
/** Entrées venues d'une liste M3U (« movie:12 ») */
const m3uEntries = new Set<string>();
const select = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('LIMIT 1') && sql.includes('FROM m3u_tmdb_links l')) return movedRows.length > 0 ? [{ one: 1 }] : [];
    if (sql.includes('WITH gone AS MATERIALIZED')) return movedRows;
    if (sql.includes('m.name <> l.name')) return changedRows;
    if (sql.includes('JOIN movies')) return storedRows;
    if (sql.includes("json_extract(data, '$.source')")) {
        const kind = sql.includes('FROM movies') ? 'movie' : 'series';
        return (params as number[]).filter((id) => m3uEntries.has(`${kind}:${id}`)).map((id) => ({ id }));
    }
    const [kind, ...ids] = params as [string, ...number[]];
    return ids.map((id) => links.get(`${kind}:${id}`)).filter(Boolean);
});
const execute = vi.fn(async (sql: string, params: unknown[]) => {
    if (!/^INSERT (OR REPLACE )?INTO m3u_tmdb_links/.test(sql)) throw new Error(`écriture inattendue : ${sql}`);
    for (let i = 0; i < params.length; i += 5) {
        const [kind, id, name, tmdbId, checkedAt] = params.slice(i, i + 5) as [string, number, string, number, number];
        // Même condition que la requête : un « pas trouvé » n'écrase pas un lien du même nom
        const current = links.get(`${kind}:${id}`);
        if (sql.includes('ON CONFLICT') && current && tmdbId <= 0 && current.tmdb_id > 0 && current.name === name) continue;
        links.set(`${kind}:${id}`, { kind, id, name, tmdb_id: tmdbId, checked_at: checkedAt });
    }
});
const db = vi.hoisted(() => ({ name: 'nyxplayer_a.db' as string | null }));
vi.mock('../dbCore', () => ({
    getDatabase: async () => ({ select, execute }),
    getDatabaseFileName: () => db.name,
    getMeta: async (key: string) => meta.get(key) ?? null,
    setMeta: async (key: string, value: string) => { meta.set(key, value); },
}));

const prefs = vi.hoisted(() => ({ titleSearch: true, genres: [] as number[] }));
vi.mock('../preferencesService', () => ({
    isTmdbTitleSearchEnabled: () => prefs.titleSearch,
    getEnabledGenres: () => prefs.genres,
}));

const lists = vi.hoisted(() => new Map<string, unknown[]>());
vi.mock('../tmdbMatchingService', () => ({
    readTmdbList: async (key: string) => lists.get(key) ?? null,
}));

const tmdbMock = vi.hoisted(() => ({
    access: 'proxy' as 'proxy' | 'direct' | null,
    searchMovie: vi.fn(),
    searchTv: vi.fn(),
}));
vi.mock('../tmdbApi', () => ({
    default: { searchMovie: tmdbMock.searchMovie, searchTv: tmdbMock.searchTv },
    getTmdbAccessKind: async () => tmdbMock.access,
}));

const rematch = vi.hoisted(() => ({ compute: vi.fn(async () => ({ generation: 0, base: null, genres: null })), install: vi.fn() }));
vi.mock('../dashboardRematch', () => ({ computeDashboardRematch: rematch.compute }));
vi.mock('../dashboardCache', () => ({ installDashboardRematch: rematch.install }));

import {
    DAILY_CONFIRM_LIMIT,
    NOT_FOUND_RETRY_MS,
    SCAN_CHUNK,
    linkHomeListsByTitle,
    titleLinksSettled,
    linkHomeTitlesAndRefresh,
    listItemToTitle,
} from '../titleTmdbLinks';
import { applyStoredTitleLinks, providerTmdbCount, titleLinkedEntryCounts } from '../titleTmdbLinkStore';
import { isStaleTitleLink } from '../../utils/lightIndexHelpers';

const movie = (id: number, name: string, tmdbId = 0): LightMovie => ({
    id, name, tmdbId, iconPrefixId: -1, iconSuffix: '', categoryId: '1', added: 0, containerExt: 'mkv',
});
const serie = (id: number, name: string, tmdbId = 0): LightSeries => ({
    id, name, tmdbId, iconPrefixId: -1, iconSuffix: '', categoryId: '2', added: 0,
});
function catalog(movies: LightMovie[], series: LightSeries[] = []): LightIndexes {
    const moviesMap = new Map(movies.map((m) => [m.id, m]));
    const seriesMap = new Map(series.map((s) => [s.id, s]));
    return {
        movies: moviesMap,
        series: seriesMap,
        live: new Map(),
        categories: new Map(),
        moviesByTmdb: new Map(movies.filter((m) => m.tmdbId > 0).map((m) => [m.tmdbId, m])),
        seriesByTmdb: new Map(series.filter((s) => s.tmdbId > 0).map((s) => [s.tmdbId, s])),
        iconPrefixes: [],
    };
}
const tmdbMovie = (id: number, title: string, date: string, extra: Record<string, unknown> = {}) => ({
    id, title, original_title: title, release_date: date, ...extra,
});
const search = (...results: ReturnType<typeof tmdbMovie>[]) => ({ page: 1, total_pages: 1, total_results: results.length, results });

const NOW = Date.UTC(2026, 10, 2, 12);

beforeEach(() => {
    links.clear();
    meta.clear();
    lists.clear();
    storedRows = [];
    changedRows = [];
    movedRows = [];
    m3uEntries.clear();
    db.name = 'nyxplayer_a.db';
    prefs.titleSearch = true;
    prefs.genres = [];
    tmdbMock.access = 'proxy';
    tmdbMock.searchMovie.mockReset().mockResolvedValue(search());
    tmdbMock.searchTv.mockReset().mockResolvedValue({ page: 1, total_pages: 1, total_results: 0, results: [] });
    rematch.compute.mockClear();
    rematch.install.mockClear();
    select.mockClear();
    execute.mockClear();
});

describe('linkHomeListsByTitle', () => {
    it('links a name with a year from the cached home lists, without any TMDB request', async () => {
        lists.set('trending', [tmdbMovie(693134, 'Dune : Deuxième partie', '2024-02-27', { media_type: 'movie', original_title: 'Dune: Part Two' })]);
        const indexes = catalog([movie(7, 'FR | Dune: Part Two (2024) 4K'), movie(8, 'Autre film (2024)')]);

        expect(await linkHomeListsByTitle(indexes, () => true, () => NOW)).toBe(1);

        expect(indexes.movies.get(7)!.tmdbId).toBe(693134);
        expect(indexes.moviesByTmdb.get(693134)!.id).toBe(7);
        expect(indexes.movies.get(8)!.tmdbId).toBe(0);
        expect(links.get('movie:7')).toMatchObject({ name: 'FR | Dune: Part Two (2024) 4K', tmdb_id: 693134 });
        expect(tmdbMock.searchMovie).not.toHaveBeenCalled();
        // Jamais d'écriture dans les tables du fournisseur (garde des numéros TMDB à l'actualisation)
        expect(execute.mock.calls.every(([sql]) => String(sql).startsWith('INSERT INTO m3u_tmdb_links'))).toBe(true);
    });

    it('links series from the series lists and genre lists of movies', async () => {
        prefs.genres = [28];
        lists.set('on_the_air', [{ id: 1396, name: 'Breaking Bad', original_name: 'Breaking Bad', first_air_date: '2008-01-20' }]);
        lists.set('genre_28', [tmdbMovie(155, 'The Dark Knight', '2008-07-16')]);
        const indexes = catalog([movie(1, 'The Dark Knight (2008)')], [serie(2, 'Breaking Bad (2008)')]);

        expect(await linkHomeListsByTitle(indexes, () => true, () => NOW)).toBe(2);
        expect(indexes.seriesByTmdb.get(1396)!.id).toBe(2);
        expect(indexes.moviesByTmdb.get(155)!.id).toBe(1);
    });

    it('leaves entries that already have a provider TMDB id', async () => {
        lists.set('popular', [tmdbMovie(10, 'Elf', '2003-10-09')]);
        const indexes = catalog([movie(1, 'Elf (2003)', 999)]);
        expect(await linkHomeListsByTitle(indexes, () => true, () => NOW)).toBe(0);
        expect(indexes.movies.get(1)!.tmdbId).toBe(999);
        expect(links.size).toBe(0);
    });

    it('confirms a name without year by one search, and keeps the answer', async () => {
        lists.set('popular', [tmdbMovie(426063, 'Nosferatu', '2024-12-25')]);
        tmdbMock.searchMovie.mockResolvedValue(search(tmdbMovie(426063, 'Nosferatu', '2024-12-25')));
        const indexes = catalog([movie(1, 'Nosferatu')]);

        expect(await linkHomeListsByTitle(indexes, () => true, () => NOW)).toBe(1);
        expect(tmdbMock.searchMovie).toHaveBeenCalledWith('Nosferatu');
        expect(indexes.movies.get(1)!.tmdbId).toBe(426063);
    });

    it('never replaces with « not found » a link made meanwhile by opening the title', async () => {
        lists.set('popular', [tmdbMovie(426063, 'Nosferatu', '2024-12-25'), tmdbMovie(10719, 'Elf', '2003-10-09')]);
        const indexes = catalog([movie(1, 'Nosferatu'), movie(2, 'Elf')]);
        tmdbMock.searchMovie.mockImplementation(async () => {
            // Pendant la recherche : la fiche d'Elf est ouverte et reliée par son détail chez le fournisseur
            links.set('movie:2', { kind: 'movie', id: 2, name: 'Elf', tmdb_id: 10719, checked_at: NOW });
            indexes.movies.get(2)!.tmdbId = 10719;
            return search();
        });

        await linkHomeListsByTitle(indexes, () => true, () => NOW);
        expect(links.get('movie:2')).toMatchObject({ tmdb_id: 10719 });
        expect(tmdbMock.searchMovie).toHaveBeenCalledTimes(1);
    });

    it('does not link a remake when the search finds several films of that name', async () => {
        lists.set('popular', [tmdbMovie(426063, 'Nosferatu', '2024-12-25')]);
        tmdbMock.searchMovie.mockResolvedValue(search(
            tmdbMovie(426063, 'Nosferatu', '2024-12-25'),
            tmdbMovie(653, 'Nosferatu', '1922-02-16'),
        ));
        expect(await linkHomeListsByTitle(catalog([movie(1, 'Nosferatu')]), () => true, () => NOW)).toBe(0);
        expect(links.get('movie:1')).toMatchObject({ tmdb_id: 0, checked_at: NOW });

        // Nouveau catalogue en mémoire, même nom : pas de nouvelle recherche avant 30 jours
        tmdbMock.searchMovie.mockClear();
        await linkHomeListsByTitle(catalog([movie(1, 'Nosferatu')]), () => true, () => NOW + 1000);
        expect(tmdbMock.searchMovie).not.toHaveBeenCalled();
        await linkHomeListsByTitle(catalog([movie(1, 'Nosferatu')]), () => true, () => NOW + NOT_FOUND_RETRY_MS + 1);
        expect(tmdbMock.searchMovie).toHaveBeenCalledTimes(1);
    });

    it('keeps confirmations under the daily limit and resumes the next time', async () => {
        const many = Array.from({ length: DAILY_CONFIRM_LIMIT + 5 }, (_, i) => i + 1);
        lists.set('popular', many.map((i) => tmdbMovie(1000 + i, `Film ${'x'.repeat(i)}`, '2020-01-01')));
        tmdbMock.searchMovie.mockResolvedValue(search());
        const indexes = catalog(many.map((i) => movie(i, `Film ${'x'.repeat(i)}`)));

        await linkHomeListsByTitle(indexes, () => true, () => NOW);
        expect(tmdbMock.searchMovie).toHaveBeenCalledTimes(DAILY_CONFIRM_LIMIT);

        // Même jour, même catalogue : la limite est atteinte, aucune nouvelle recherche
        await linkHomeListsByTitle(indexes, () => true, () => NOW + 1000);
        expect(tmdbMock.searchMovie).toHaveBeenCalledTimes(DAILY_CONFIRM_LIMIT);
        // Le lendemain : seulement les noms pas encore vérifiés
        await linkHomeListsByTitle(indexes, () => true, () => NOW + 24 * 3600 * 1000);
        expect(tmdbMock.searchMovie).toHaveBeenCalledTimes(DAILY_CONFIRM_LIMIT + 5);
    });

    it('does nothing when the setting is off', async () => {
        prefs.titleSearch = false;
        lists.set('trending', [tmdbMovie(10, 'Elf', '2003-10-09', { media_type: 'movie' })]);
        const indexes = catalog([movie(1, 'Elf (2003)')]);
        expect(await linkHomeListsByTitle(indexes, () => true, () => NOW)).toBe(0);
        expect(indexes.movies.get(1)!.tmdbId).toBe(0);
    });

    it('does not search without any TMDB access, and tries again later', async () => {
        tmdbMock.access = null;
        lists.set('popular', [tmdbMovie(10, 'Elf', '2003-10-09')]);
        const indexes = catalog([movie(1, 'Elf')]);
        expect(await linkHomeListsByTitle(indexes, () => true, () => NOW)).toBe(0);
        expect(tmdbMock.searchMovie).not.toHaveBeenCalled();
        // Pas de nouveau passage complet à chaque retour sur l'accueil : seulement le lendemain
        tmdbMock.access = 'direct';
        tmdbMock.searchMovie.mockResolvedValue(search(tmdbMovie(10, 'Elf', '2003-10-09')));
        expect(await linkHomeListsByTitle(indexes, () => true, () => NOW + 1000)).toBe(0);
        expect(await linkHomeListsByTitle(indexes, () => true, () => NOW + 24 * 3600 * 1000)).toBe(1);
    });

    it('leaves names without year of an M3U list to its own search with the list year', async () => {
        lists.set('popular', [tmdbMovie(10, 'Elf', '2003-10-09')]);
        m3uEntries.add('movie:1');
        const indexes = catalog([movie(1, 'Elf')]);
        expect(await linkHomeListsByTitle(indexes, () => true, () => NOW)).toBe(0);
        expect(tmdbMock.searchMovie).not.toHaveBeenCalled();
        // Aucun « pas trouvé » noté : m3uTmdbLinks.ts la cherchera à l'ouverture de sa fiche
        expect(links.size).toBe(0);
    });

    it('saves many sure links in a few writes', async () => {
        const many = Array.from({ length: 400 }, (_, i) => i + 1);
        lists.set('popular', many.map((i) => tmdbMovie(5000 + i, `Film ${'y'.repeat(i)}`, '2020-01-01')));
        const indexes = catalog(many.map((i) => movie(i, `Film ${'y'.repeat(i)} (2020)`)));
        expect(await linkHomeListsByTitle(indexes, () => true, () => NOW)).toBe(400);
        expect(execute).toHaveBeenCalledTimes(3);
        expect(links.size).toBe(400);
    });

    it('does not rescan the whole catalogue the same day when the database refuses to write', async () => {
        lists.set('popular', [tmdbMovie(10, 'Elf', '2003-10-09')]);
        const indexes = catalog([movie(1, 'Elf (2003)')]);
        execute.mockRejectedValueOnce(new Error('base occupée'));
        expect(await linkHomeListsByTitle(indexes, () => true, () => NOW)).toBe(0);
        expect(await linkHomeListsByTitle(indexes, () => true, () => NOW + 1000)).toBe(0);
        expect(execute).toHaveBeenCalledTimes(1);
        expect(await linkHomeListsByTitle(indexes, () => true, () => NOW + 24 * 3600 * 1000)).toBe(1);
    });

    it('does not count title links as provider TMDB ids (Movies tab of a provider without ids)', async () => {
        lists.set('popular', [tmdbMovie(10, 'Elf', '2003-10-09')]);
        const indexes = catalog([movie(1, 'Elf (2003)'), movie(2, 'Autre')], [serie(3, 'Lost', 77)]);
        await linkHomeListsByTitle(indexes, () => true, () => NOW);
        expect(indexes.moviesByTmdb.size).toBe(1);
        expect(providerTmdbCount(indexes.moviesByTmdb)).toBe(0);
        expect(providerTmdbCount(indexes.seriesByTmdb)).toBe(1);
    });

    it('counts the titles linked by title, never the ones the provider numbered (Settings split)', async () => {
        lists.set('popular', [tmdbMovie(10, 'Elf', '2003-10-09')]);
        const indexes = catalog([movie(1, 'Elf (2003)'), movie(2, 'Autre')], [serie(3, 'Lost', 77)]);
        expect(titleLinkedEntryCounts(indexes)).toEqual({ movies: 0, series: 0 });
        await linkHomeListsByTitle(indexes, () => true, () => NOW);
        expect(titleLinkedEntryCounts(indexes)).toEqual({ movies: 1, series: 0 });
    });

    it('compares the same lists only once per catalogue', async () => {
        lists.set('popular', [tmdbMovie(10, 'Elf', '2003-10-09')]);
        const indexes = catalog([movie(1, 'Autre (2003)')]);
        await linkHomeListsByTitle(indexes, () => true, () => NOW);
        const nameReads = vi.fn();
        indexes.movies.get(1)!.name = new Proxy({}, { get: nameReads }) as unknown as string;
        await linkHomeListsByTitle(indexes, () => true, () => NOW);
        expect(nameReads).not.toHaveBeenCalled();
    });

    it('reports a catalogue as settled once the cached lists were compared, even with no new link', async () => {
        const indexes = catalog([movie(1, 'Autre (2003)')]);
        // Listes de l'accueil pas encore en cache : rien comparé, un nouvel essai reste utile
        expect(await linkHomeListsByTitle(indexes, () => true, () => NOW)).toBe(0);
        expect(titleLinksSettled(indexes)).toBe(false);
        lists.set('popular', [tmdbMovie(10, 'Elf', '2003-10-09')]);
        expect(await linkHomeListsByTitle(indexes, () => true, () => NOW)).toBe(0);
        expect(titleLinksSettled(indexes)).toBe(true);
    });

    it('stops a long comparison when the catalogue is replaced', async () => {
        lists.set('popular', [tmdbMovie(10, 'Elf', '2003-10-09')]);
        const big = Array.from({ length: SCAN_CHUNK * 2 }, (_, i) => movie(i + 1, i === SCAN_CHUNK * 2 - 1 ? 'Elf (2003)' : `Titre ${i}`));
        const indexes = catalog(big);
        let current = true;
        const run = linkHomeListsByTitle(indexes, () => current, () => NOW);
        current = false;
        expect(await run).toBe(0);
        expect(indexes.movies.get(SCAN_CHUNK * 2)!.tmdbId).toBe(0);
        expect(links.size).toBe(0);
    });

    it('writes nothing when the account changed during the comparison', async () => {
        lists.set('popular', [tmdbMovie(10, 'Elf', '2003-10-09')]);
        const indexes = catalog([...Array.from({ length: SCAN_CHUNK }, (_, i) => movie(i + 2, `Titre ${i}`)), movie(1, 'Elf (2003)')]);
        const run = linkHomeListsByTitle(indexes, () => true, () => NOW);
        db.name = 'nyxplayer_b.db';
        expect(await run).toBe(0);
        expect(links.size).toBe(0);
    });
});

describe('linkHomeTitlesAndRefresh', () => {
    it('recomputes the home rows only when new links were found', async () => {
        lists.set('popular', [tmdbMovie(10, 'Elf', '2003-10-09')]);
        await linkHomeTitlesAndRefresh(catalog([movie(1, 'Autre (2003)')]));
        expect(rematch.install).not.toHaveBeenCalled();
        await linkHomeTitlesAndRefresh(catalog([movie(1, 'Elf (2003)')]));
        expect(rematch.compute).toHaveBeenCalledTimes(1);
        expect(rematch.install).toHaveBeenCalledTimes(1);
    });
});

describe('applyStoredTitleLinks', () => {
    it('puts the stored links back into the catalogue in memory', async () => {
        storedRows = [{ kind: 'movie', id: 1, tmdb_id: 10 }, { kind: 'series', id: 2, tmdb_id: 20 }, { kind: 'movie', id: 99, tmdb_id: 30 }];
        const indexes = catalog([movie(1, 'Elf')], [serie(2, 'Lost')]);
        expect(await applyStoredTitleLinks(indexes)).toBe(2);
        expect(indexes.moviesByTmdb.get(10)!.id).toBe(1);
        expect(indexes.seriesByTmdb.get(20)!.id).toBe(2);
    });

    it('after a renumbering, the same exact name under a new number gets its link back without a search', async () => {
        movedRows = [{ kind: 'movie', id: 501, name: 'Elf (2003)', tmdb_id: 10 }];
        const indexes = catalog([movie(501, 'Elf (2003)')]);
        expect(await applyStoredTitleLinks(indexes)).toBe(1);
        expect(indexes.movies.get(501)!.tmdbId).toBe(10);
    });

    it('after a renumbering, old links of one name that disagree are not used (the search decides)', async () => {
        movedRows = [
            { kind: 'movie', id: 501, name: 'Elf (2003)', tmdb_id: 10 },
            { kind: 'movie', id: 501, name: 'Elf (2003)', tmdb_id: 11 },
        ];
        const indexes = catalog([movie(501, 'Elf (2003)')]);
        expect(await applyStoredTitleLinks(indexes)).toBe(0);
        expect(indexes.movies.get(501)!.tmdbId).toBe(0);
    });

    it('after a renumbering, an old \'not found\' for the same name counts as a disagreement', async () => {
        movedRows = [
            { kind: 'movie', id: 501, name: 'Elf (2003)', tmdb_id: 10 },
            { kind: 'movie', id: 501, name: 'Elf (2003)', tmdb_id: 0 },
        ];
        expect(await applyStoredTitleLinks(catalog([movie(501, 'Elf (2003)')]))).toBe(0);
    });

    it('after a renumbering, two current entries of the same name are never both linked (namesakes)', async () => {
        movedRows = [
            { kind: 'movie', id: 501, name: 'Dune (2021)', tmdb_id: 10 },
            { kind: 'movie', id: 502, name: 'Dune (2021)', tmdb_id: 10 },
        ];
        const indexes = catalog([movie(501, 'Dune (2021)'), movie(502, 'Dune (2021)')]);
        expect(await applyStoredTitleLinks(indexes)).toBe(0);
    });

    it('after a renumbering, a name without a year is never moved', async () => {
        movedRows = [{ kind: 'movie', id: 501, name: 'Dune', tmdb_id: 10 }];
        expect(await applyStoredTitleLinks(catalog([movie(501, 'Dune')]))).toBe(0);
    });

    it('puts a link back when the entry was only renamed (prefix, quality, year)', async () => {
        changedRows = [{ kind: 'movie', id: 1, tmdb_id: 10, old_name: 'Elf (2003)', new_name: 'FR | Elf (2003) 4K' }];
        const indexes = catalog([movie(1, 'FR | Elf (2003) 4K')]);
        expect(await applyStoredTitleLinks(indexes)).toBe(1);
        expect(indexes.movies.get(1)!.tmdbId).toBe(10);
        expect(isStaleTitleLink(indexes.movies.get(1))).toBe(false);
    });

    it.each([
        ['Blade Runner', 'Blade Runner 2049'],
        ['Scream', 'Scream (2022)'],
        ['Dune', 'Dune (1984)'],
        ['Matrix', 'Matrix 2021'],
        ['The Office (UK)', 'The Office (US)'],
        ['Dune (2021)', 'Dune: Part Two (2024)'],
    ])('never gives the link of %s to %s (remake, sequel or namesake)', async (before, after) => {
        changedRows = [{ kind: 'movie', id: 1, tmdb_id: 10, old_name: before, new_name: after }];
        const indexes = catalog([movie(1, after)]);
        expect(await applyStoredTitleLinks(indexes)).toBe(0);
        expect(indexes.movies.get(1)!.tmdbId).toBe(0);
        expect(isStaleTitleLink(indexes.movies.get(1))).toBe(true);
    });

    it('marks an entry whose number now belongs to another title, and never gives it the old link', async () => {
        changedRows = [{ kind: 'movie', id: 1, tmdb_id: 10, old_name: 'Dune (2021)', new_name: 'Barbie (2023)' }];
        const indexes = catalog([movie(1, 'Barbie (2023)')]);
        expect(await applyStoredTitleLinks(indexes)).toBe(0);
        expect(indexes.movies.get(1)!.tmdbId).toBe(0);
        expect(isStaleTitleLink(indexes.movies.get(1))).toBe(true);
    });

    it('never throws and does nothing when the setting is off', async () => {
        prefs.titleSearch = false;
        storedRows = [{ kind: 'movie', id: 1, tmdb_id: 10 }];
        const indexes = catalog([movie(1, 'Elf')]);
        expect(await applyStoredTitleLinks(indexes)).toBe(0);
        prefs.titleSearch = true;
        // Base occupée pour toutes les lectures (affiches connues, puis liens)
        for (let i = 0; i < 3; i++) select.mockRejectedValueOnce(new Error('base occupée'));
        expect(await applyStoredTitleLinks(indexes)).toBe(0);
    });
});

describe('listItemToTitle', () => {
    it('sorts trending items into movies and series like the home rows', () => {
        expect(listItemToTitle({ id: 1, name: 'Lost', original_name: 'Lost', first_air_date: '2004-09-22', media_type: 'tv' } as never, 'mixed'))
            .toEqual({ kind: 'series', tmdbId: 1, titles: ['Lost', 'Lost'], year: 2004 });
        expect(listItemToTitle({ id: 2, name: 'Someone', media_type: 'person' } as never, 'mixed')).toBeNull();
        expect(listItemToTitle(tmdbMovie(3, 'Elf', '') as never, 'movie')).toEqual({ kind: 'movie', tmdbId: 3, titles: ['Elf', 'Elf'] });
    });
});
