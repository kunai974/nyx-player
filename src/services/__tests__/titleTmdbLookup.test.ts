/**
 * Numéro TMDB d'un titre ouvert sans numéro du fournisseur : détail du fournisseur d'abord, puis
 * recherche par le titre (lien sûr ou rien), réponse gardée (même résultat à chaque ouverture),
 * autres versions du même titre réunies, rien dans la colonne du fournisseur.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LightIndexes, LightMovie } from '../../types/lightIndex';

interface Row { name: string; tmdb_id: number | null; data: string | null }
interface Link { name: string; tmdb_id: number; checked_at: number }
const movies = new Map<number, Row>();
const links = new Map<string, Link>();
const select = vi.fn(async (sql: string, params: unknown[]) => {
    if (sql.startsWith('SELECT name, tmdb_id, data FROM')) {
        const row = movies.get(Number(params[0]));
        return row ? [{ ...row }] : [];
    }
    if (sql.startsWith('SELECT name, tmdb_id, checked_at FROM m3u_tmdb_links')) {
        const link = links.get(`${String(params[0])}:${String(params[1])}`);
        return link ? [link] : [];
    }
    if (sql.startsWith('SELECT id, name FROM movies')) {
        const [exclude, like] = params as [number, string];
        const anchor = like.slice(1, -1).toLowerCase();
        return [...movies.entries()]
            .filter(([id, row]) => id !== exclude && !(row.tmdb_id && row.tmdb_id > 0) && row.name.toLowerCase().includes(anchor)
                && !((links.get(`movie:${id}`)?.tmdb_id ?? 0) > 0))
            .map(([id, row]) => ({ id, name: row.name }));
    }
    throw new Error(`lecture inattendue : ${sql}`);
});
const execute = vi.fn(async (sql: string, params: unknown[]) => {
    if (!sql.startsWith('INSERT INTO m3u_tmdb_links')) throw new Error(`écriture inattendue : ${sql}`);
    for (let i = 0; i < params.length; i += 5) {
        const [kind, id, name, tmdbId, checkedAt] = params.slice(i, i + 5) as [string, number, string, number, number];
        // Même condition que la requête : un « pas trouvé » n'écrase pas un lien du même nom
        const current = links.get(`${kind}:${id}`);
        if (sql.includes('ON CONFLICT') && current && tmdbId <= 0 && current.tmdb_id > 0 && current.name === name) continue;
        links.set(`${kind}:${id}`, { name, tmdb_id: tmdbId, checked_at: checkedAt });
    }
});
const db = vi.hoisted(() => ({ name: 'nyxplayer_a.db' as string | null }));
vi.mock('../dbCore', () => ({
    getDatabase: async () => ({ select, execute }),
    getDatabaseFileName: () => db.name,
}));

const prefs = vi.hoisted(() => ({ titleSearch: true }));
vi.mock('../preferencesService', () => ({ isTmdbTitleSearchEnabled: () => prefs.titleSearch }));

const tmdbMock = vi.hoisted(() => ({ access: 'proxy' as 'proxy' | 'direct' | null, searchMovie: vi.fn(), searchTv: vi.fn() }));
vi.mock('../tmdbApi', () => ({
    default: { searchMovie: tmdbMock.searchMovie, searchTv: tmdbMock.searchTv },
    getTmdbAccessKind: async () => tmdbMock.access,
}));

const provider = vi.hoisted(() => ({ creds: { host: 'http://p.example', username: 'u', password: 'p' } as { host: string } | null, getVodInfo: vi.fn() }));
vi.mock('../storage', () => ({ StorageService: { getCredentials: async () => provider.creds } }));
vi.mock('../xtreamApi', () => ({
    XtreamApiService: class { getVodInfo = provider.getVodInfo; },
}));

const m3u = vi.hoisted(() => ({ find: vi.fn(async () => 0) }));
vi.mock('../m3uTmdbLinks', () => ({ findM3uTmdbId: m3u.find }));

import { rememberCurrentCatalog } from '../titleTmdbLinkStore';
import { findTitleTmdbId, findTitleTmdbIdWithin, forgetTitleLookupSession, NOT_FOUND_RETRY_MS } from '../titleTmdbLookup';

const light = (id: number, name: string, tmdbId = 0): LightMovie => ({
    id, name, tmdbId, iconPrefixId: -1, iconSuffix: '', categoryId: '1', added: 0, containerExt: 'mkv',
});
function catalog(): LightIndexes {
    const map = new Map<number, LightMovie>();
    for (const [id, row] of movies) map.set(id, light(id, row.name, row.tmdb_id ?? 0));
    return {
        movies: map, series: new Map(), live: new Map(), categories: new Map(),
        moviesByTmdb: new Map([...map.values()].filter((m) => m.tmdbId > 0).map((m) => [m.tmdbId, m])),
        seriesByTmdb: new Map(), iconPrefixes: [],
    };
}
const result = (id: number, title: string, date: string) => ({ id, title, original_title: title, release_date: date });
const search = (...results: ReturnType<typeof result>[]) => ({ page: 1, total_pages: 1, total_results: results.length, results });

beforeEach(() => {
    forgetTitleLookupSession();
    movies.clear();
    links.clear();
    db.name = 'nyxplayer_a.db';
    prefs.titleSearch = true;
    tmdbMock.access = 'proxy';
    tmdbMock.searchMovie.mockReset().mockResolvedValue(search());
    tmdbMock.searchTv.mockReset();
    provider.creds = { host: 'http://p.example' };
    // Détail lisible, sans numéro TMDB ni année
    provider.getVodInfo.mockReset().mockResolvedValue({ info: {} });
    m3u.find.mockClear();
    execute.mockClear();
    select.mockClear();
    // Catalogue retenu d'un test précédent : remplacé par un catalogue vide
    rememberCurrentCatalog(catalog());
});

describe('findTitleTmdbId', () => {
    it('takes the TMDB id of the provider movie details first, and joins the other versions', async () => {
        movies.set(1, { name: 'Dune (2021)', tmdb_id: null, data: '{}' });
        movies.set(2, { name: 'FR | Dune (2021) 4K', tmdb_id: null, data: '{}' });
        movies.set(3, { name: 'Dune (1984)', tmdb_id: null, data: '{}' });
        provider.getVodInfo.mockResolvedValue({ info: { tmdb_id: '438631', year: '2021' } });
        const indexes = catalog();

        expect(await findTitleTmdbId('movie', 1, indexes)).toBe(438631);

        expect(tmdbMock.searchMovie).not.toHaveBeenCalled();
        expect(indexes.movies.get(1)!.tmdbId).toBe(438631);
        expect(indexes.movies.get(2)!.tmdbId).toBe(438631);
        // Autre film du même nom : jamais réuni
        expect(indexes.movies.get(3)!.tmdbId).toBe(0);
        // Jamais dans la colonne du fournisseur
        expect(movies.get(1)!.tmdb_id).toBeNull();
        expect(links.get('movie:2')).toMatchObject({ tmdb_id: 438631 });
    });

    it('searches by title and year when the provider gives nothing', async () => {
        movies.set(1, { name: 'Dune (2021)', tmdb_id: null, data: '{}' });
        movies.set(2, { name: 'Dune', tmdb_id: null, data: '{}' });
        tmdbMock.searchMovie.mockResolvedValue(search(result(438631, 'Dune', '2021-09-15'), result(841, 'Dune', '1984-12-14')));
        const indexes = catalog();

        expect(await findTitleTmdbId('movie', 1, indexes)).toBe(438631);
        expect(tmdbMock.searchMovie).toHaveBeenCalledWith('Dune');
        // « Dune » sans année peut être celui de 1984 : pas réuni
        expect(indexes.movies.get(2)!.tmdbId).toBe(0);
    });

    it('uses the year of the provider details for a name without year', async () => {
        movies.set(1, { name: 'Dune', tmdb_id: null, data: '{}' });
        provider.getVodInfo.mockResolvedValue({ info: { releasedate: '2021-09-15' } });
        tmdbMock.searchMovie.mockResolvedValue(search(result(438631, 'Dune', '2021-09-15'), result(841, 'Dune', '1984-12-14')));
        expect(await findTitleTmdbId('movie', 1, catalog())).toBe(438631);
    });

    it('joins versions without year only when TMDB has a single title of that name', async () => {
        movies.set(1, { name: 'Elf', tmdb_id: null, data: '{}' });
        movies.set(2, { name: 'Elf MULTI 1080p', tmdb_id: null, data: '{}' });
        movies.set(3, { name: 'Elf (1980)', tmdb_id: null, data: '{}' });
        tmdbMock.searchMovie.mockResolvedValue(search(result(10719, 'Elf', '2003-10-09')));
        const indexes = catalog();
        expect(await findTitleTmdbId('movie', 1, indexes)).toBe(10719);
        expect(indexes.movies.get(2)!.tmdbId).toBe(10719);
        expect(indexes.movies.get(3)!.tmdbId).toBe(0);
    });

    it('gives the same answer at every opening, without asking again', async () => {
        movies.set(1, { name: 'Elf (2003)', tmdb_id: null, data: '{}' });
        tmdbMock.searchMovie.mockResolvedValue(search(result(10719, 'Elf', '2003-10-09')));
        expect(await findTitleTmdbId('movie', 1)).toBe(10719);
        expect(await findTitleTmdbId('movie', 1)).toBe(10719);
        expect(await findTitleTmdbId('movie', 1, catalog())).toBe(10719);
        expect(tmdbMock.searchMovie).toHaveBeenCalledTimes(1);
        expect(provider.getVodInfo).toHaveBeenCalledTimes(1);
    });

    it('keeps « not found » for 30 days, then asks again', async () => {
        movies.set(1, { name: 'Inconnu (2020)', tmdb_id: null, data: '{}' });
        const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
        expect(await findTitleTmdbId('movie', 1)).toBe(0);
        expect(links.get('movie:1')).toMatchObject({ tmdb_id: 0 });
        expect(await findTitleTmdbId('movie', 1)).toBe(0);
        expect(tmdbMock.searchMovie).toHaveBeenCalledTimes(1);
        now.mockReturnValue(1_000_000 + NOT_FOUND_RETRY_MS + 1);
        await findTitleTmdbId('movie', 1);
        expect(tmdbMock.searchMovie).toHaveBeenCalledTimes(2);
        now.mockRestore();
    });

    it('searches again when the provider renames the title', async () => {
        movies.set(1, { name: 'Inconnu (2020)', tmdb_id: null, data: '{}' });
        await findTitleTmdbId('movie', 1);
        movies.set(1, { name: 'Elf (2003)', tmdb_id: null, data: '{}' });
        tmdbMock.searchMovie.mockResolvedValue(search(result(10719, 'Elf', '2003-10-09')));
        expect(await findTitleTmdbId('movie', 1)).toBe(10719);
    });

    it('never gives a reused number the TMDB id read for the title it had before', async () => {
        // Le fournisseur réutilise le numéro 1 dans la même session : « Dune » devient « Avatar »
        movies.set(1, { name: 'Dune (2021)', tmdb_id: null, data: '{}' });
        provider.getVodInfo.mockResolvedValueOnce({ info: { tmdb_id: '438631', year: '2021' } });
        expect(await findTitleTmdbId('movie', 1)).toBe(438631);
        movies.set(1, { name: 'Avatar (2009)', tmdb_id: null, data: '{}' });
        provider.getVodInfo.mockResolvedValueOnce({ info: { tmdb_id: '19995', year: '2009' } });
        expect(await findTitleTmdbId('movie', 1)).toBe(19995);
        expect(links.get('movie:1')).toMatchObject({ name: 'Avatar (2009)', tmdb_id: 19995 });
    });

    it('returns the id already known without any request', async () => {
        movies.set(1, { name: 'Elf', tmdb_id: 55, data: '{}' });
        expect(await findTitleTmdbId('movie', 1, catalog())).toBe(55);
        expect(select).not.toHaveBeenCalledWith(expect.stringContaining('m3u_tmdb_links'), expect.anything());
        expect(provider.getVodInfo).not.toHaveBeenCalled();
    });

    it('leaves an M3U entry to its own search', async () => {
        movies.set(1, { name: 'Elf', tmdb_id: null, data: JSON.stringify({ source: 'm3u' }) });
        m3u.find.mockResolvedValueOnce(10719);
        expect(await findTitleTmdbId('movie', 1)).toBe(10719);
        expect(m3u.find).toHaveBeenCalledWith('movie', 1);
        expect(provider.getVodInfo).not.toHaveBeenCalled();
    });

    it('asks nothing when the setting is off or TMDB is out of reach', async () => {
        movies.set(1, { name: 'Elf (2003)', tmdb_id: null, data: '{}' });
        prefs.titleSearch = false;
        expect(await findTitleTmdbId('movie', 1)).toBe(0);
        prefs.titleSearch = true;
        tmdbMock.access = null;
        expect(await findTitleTmdbId('movie', 1)).toBe(0);
        expect(tmdbMock.searchMovie).not.toHaveBeenCalled();
        expect(links.size).toBe(0);
    });

    it('writes nothing when the account changed during the search', async () => {
        movies.set(1, { name: 'Elf (2003)', tmdb_id: null, data: '{}' });
        tmdbMock.searchMovie.mockImplementation(async () => {
            db.name = 'nyxplayer_b.db';
            return search(result(10719, 'Elf', '2003-10-09'));
        });
        expect(await findTitleTmdbId('movie', 1)).toBe(0);
        expect(links.size).toBe(0);
    });

    it('never throws', async () => {
        movies.set(1, { name: 'Elf (2003)', tmdb_id: null, data: '{}' });
        tmdbMock.searchMovie.mockRejectedValue(new Error('réseau coupé'));
        provider.getVodInfo.mockRejectedValue(new Error('fournisseur injoignable'));
        expect(await findTitleTmdbId('movie', 1)).toBe(0);
    });
});

describe('after review', () => {
    it('reads the provider details once per session', async () => {
        movies.set(1, { name: 'Elf (2003)', tmdb_id: null, data: '{}' });
        tmdbMock.access = null;
        await findTitleTmdbId('movie', 1);
        await findTitleTmdbId('movie', 1);
        expect(provider.getVodInfo).toHaveBeenCalledTimes(1);
    });

    it('does not keep « not found » when the provider details could not be read', async () => {
        movies.set(1, { name: 'Dune', tmdb_id: null, data: '{}' });
        provider.getVodInfo.mockRejectedValueOnce(new Error('fournisseur injoignable'));
        tmdbMock.searchMovie.mockResolvedValue(search(result(438631, 'Dune', '2021-09-15'), result(841, 'Dune', '1984-12-14')));
        expect(await findTitleTmdbId('movie', 1)).toBe(0);
        expect(links.size).toBe(0);
        // Ouverture suivante : le détail répond, avec l'année
        provider.getVodInfo.mockResolvedValueOnce({ info: { year: '2021' } });
        expect(await findTitleTmdbId('movie', 1)).toBe(438631);
    });

    it('never overwrites the link a version already has', async () => {
        movies.set(1, { name: 'Elf (2003)', tmdb_id: null, data: '{}' });
        movies.set(2, { name: 'Elf (2003) 4K', tmdb_id: null, data: '{}' });
        links.set('movie:2', { name: 'Elf (2003) 4K', tmdb_id: 777, checked_at: 1 });
        tmdbMock.searchMovie.mockResolvedValue(search(result(10719, 'Elf', '2003-10-09')));
        expect(await findTitleTmdbId('movie', 1, catalog())).toBe(10719);
        expect(links.get('movie:2')!.tmdb_id).toBe(777);
    });

    it('keeps the link for the session when the database refuses to write it', async () => {
        movies.set(1, { name: 'Elf (2003)', tmdb_id: null, data: '{}' });
        tmdbMock.searchMovie.mockResolvedValue(search(result(10719, 'Elf', '2003-10-09')));
        execute.mockRejectedValueOnce(new Error('base occupée'));
        expect(await findTitleTmdbId('movie', 1)).toBe(10719);
        expect(await findTitleTmdbId('movie', 1)).toBe(10719);
        expect(tmdbMock.searchMovie).toHaveBeenCalledTimes(1);
    });

    it('links the other versions in the session catalogue even when the caller does not give it', async () => {
        movies.set(1, { name: 'Elf (2003)', tmdb_id: null, data: '{}' });
        movies.set(2, { name: 'FR | Elf (2003)', tmdb_id: null, data: '{}' });
        const indexes = catalog();
        rememberCurrentCatalog(indexes);
        tmdbMock.searchMovie.mockResolvedValue(search(result(10719, 'Elf', '2003-10-09')));
        expect(await findTitleTmdbId('movie', 1)).toBe(10719);
        expect(indexes.movies.get(2)!.tmdbId).toBe(10719);
        // Autre compte : le catalogue retenu n'est plus le sien
        db.name = 'nyxplayer_b.db';
        movies.set(3, { name: 'Lost (2004)', tmdb_id: null, data: '{}' });
        tmdbMock.searchMovie.mockResolvedValue(search(result(4607, 'Lost', '2004-09-22')));
        expect(await findTitleTmdbId('movie', 3)).toBe(4607);
        expect(indexes.movies.get(3)).toBeUndefined();
    });
});

describe('after second review', () => {
    it('treats an empty provider answer like an error: nothing kept, asked again next time', async () => {
        movies.set(1, { name: 'Dune', tmdb_id: null, data: '{}' });
        provider.getVodInfo.mockResolvedValueOnce(null);
        tmdbMock.searchMovie.mockResolvedValue(search(result(438631, 'Dune', '2021-09-15'), result(841, 'Dune', '1984-12-14')));
        expect(await findTitleTmdbId('movie', 1)).toBe(0);
        expect(links.size).toBe(0);
        provider.getVodInfo.mockResolvedValueOnce({ info: { year: '2021' } });
        expect(await findTitleTmdbId('movie', 1)).toBe(438631);
        expect(provider.getVodInfo).toHaveBeenCalledTimes(2);
    });

    it('never replaces a link found meanwhile by another version with « not found »', async () => {
        movies.set(1, { name: 'Dune (2021) 4K', tmdb_id: null, data: '{}' });
        movies.set(2, { name: 'FR | Dune (2021)', tmdb_id: null, data: '{}' });
        // Deux recherches en cours en même temps, réponses données dans l'ordre voulu
        const answers: Array<(value: unknown) => void> = [];
        tmdbMock.searchMovie.mockImplementation(() => new Promise((r) => { answers.push(r); }));
        const first = findTitleTmdbId('movie', 1);
        const second = findTitleTmdbId('movie', 2);
        await vi.waitFor(() => expect(answers).toHaveLength(2));
        answers[0](search(result(438631, 'Dune', '2021-09-15')));
        expect(await first).toBe(438631);
        expect(links.get('movie:2')).toMatchObject({ tmdb_id: 438631 });
        answers[1](search());
        await second;
        expect(links.get('movie:2')).toMatchObject({ tmdb_id: 438631 });
    });

    it('looks for the other versions by a meaningful word, not an article', async () => {
        movies.set(1, { name: 'The Man (2020)', tmdb_id: null, data: '{}' });
        tmdbMock.searchMovie.mockResolvedValue(search(result(99, 'The Man', '2020-01-01')));
        await findTitleTmdbId('movie', 1);
        expect(select).toHaveBeenCalledWith(expect.stringContaining('SELECT id, name FROM movies'), expect.arrayContaining(['%man%']));
    });

    it('writes the other versions in batches when there are many', async () => {
        movies.set(1, { name: 'Elf (2003)', tmdb_id: null, data: '{}' });
        for (let i = 2; i <= 181; i++) movies.set(i, { name: `Elf (2003) [${i}]`, tmdb_id: null, data: '{}' });
        tmdbMock.searchMovie.mockResolvedValue(search(result(10719, 'Elf', '2003-10-09')));
        expect(await findTitleTmdbId('movie', 1)).toBe(10719);
        const inserts = execute.mock.calls.filter(([sql]) => sql.startsWith('INSERT'));
        expect(inserts.every(([, params]) => params.length <= 999)).toBe(true);
        expect(links.get('movie:181')).toMatchObject({ tmdb_id: 10719 });
    });
});

describe('findTitleTmdbIdWithin', () => {
    it('stops waiting after the delay while the search goes on', async () => {
        vi.useFakeTimers();
        movies.set(1, { name: 'Elf (2003)', tmdb_id: null, data: '{}' });
        let answer: (value: unknown) => void = () => {};
        tmdbMock.searchMovie.mockReturnValue(new Promise((r) => { answer = r; }));
        const waited = findTitleTmdbIdWithin('movie', 1, null, 1200);
        await vi.advanceTimersByTimeAsync(1200);
        expect(await waited).toBe(0);
        answer(search(result(10719, 'Elf', '2003-10-09')));
        vi.useRealTimers();
        await vi.waitFor(() => expect(links.get('movie:1')).toMatchObject({ tmdb_id: 10719 }));
    });
});
