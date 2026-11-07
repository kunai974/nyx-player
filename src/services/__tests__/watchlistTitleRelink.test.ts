/**
 * Ma liste après le passage à une liste M3U (sans numéros TMDB) : un titre gardé avec son numéro TMDB
 * était « introuvable » tant que sa fiche n'avait pas été ouverte. Il est maintenant rattaché en local à
 * l'entrée de même titre et de même année, sans aucune demande à TMDB, et jamais à un homonyme incertain.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import type { LightIndexes, LightMovie, LightSeries } from '../../types/lightIndex';

const sqlite = vi.hoisted(() => ({ db: null as unknown as DatabaseSync }));
const prefs = vi.hoisted(() => ({ titleSearch: true }));
const meta = vi.hoisted(() => new Map<string, string>());
const tmdbCalls = vi.hoisted(() => ({ count: 0 }));

vi.mock('../dbCore', () => ({
    getDatabase: async () => ({
        select: async (sql: string, params: unknown[] = []) => sqlite.db.prepare(sql).all(...(params as (string | number | null)[])),
        execute: async (sql: string, params: unknown[] = []) => sqlite.db.prepare(sql).run(...(params as (string | number | null)[])),
    }),
    getDatabaseFileName: () => 'nyxplayer_a.db',
    isDatabaseOf: () => true,
    getMeta: async (key: string) => meta.get(key) ?? null,
    setMeta: async (key: string, value: string) => { meta.set(key, value); },
}));
vi.mock('../preferencesService', () => ({
    isTmdbTitleSearchEnabled: () => prefs.titleSearch,
    computeProviderHash: async (host: string) => host,
}));
vi.mock('../syncService', () => ({ pushWatchlistUpsertToCloud: vi.fn(), pushWatchlistDeleteToCloud: vi.fn() }));
vi.mock('../watchlistDetailsFill', () => ({ requestMissingWatchlistDetails: vi.fn() }));
vi.mock('../dashboardRematch', () => ({ computeDashboardRematch: vi.fn(async () => ({ rows: [] })) }));
vi.mock('../dashboardCache', () => ({ installDashboardRematch: vi.fn(() => true) }));
// Aucune demande à TMDB : toute recherche compterait ici
vi.mock('../tmdbApi', () => {
    const fail = () => { tmdbCalls.count++; throw new Error('pas de réseau dans ce test'); };
    return {
        default: { imageUrl: (path: string) => `https://image.tmdb.org/t/p/w342${path}`, searchMovie: fail, searchTv: fail, searchTitlesBatch: fail },
        getTmdbAccessKind: fail,
        isTmdbAccountRelay: fail,
        titleBatchChunks: fail,
    };
});

import { getHydratedWatchlist } from '../watchlistHydration';
import { relinkWatchlistOrphansByTitle, titleFactsOf } from '../watchlistTitleRelink';
import { rememberCurrentCatalog } from '../titleTmdbLinkStore';

const { DatabaseSync: Sqlite } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');

const movie = (id: number, name: string, tmdbId = 0): LightMovie => ({
    id, name, tmdbId, iconPrefixId: -1, iconSuffix: '', categoryId: '1', added: 0, containerExt: 'mkv',
});
const series = (id: number, name: string): LightSeries => ({
    id, name, tmdbId: 0, iconPrefixId: -1, iconSuffix: '', categoryId: '2', added: 0,
} as unknown as LightSeries);

/** Catalogue affiché (retenu comme celui de la base ouverte) */
function catalog(): LightIndexes {
    const indexes = rawCatalog();
    rememberCurrentCatalog(indexes);
    return indexes;
}

function rawCatalog(): LightIndexes {
    return {
        movies: new Map([
            [11, movie(11, 'FR | Crocodile Swarm (2025) 4K')],
            [12, movie(12, 'Crocodile Swarm (2025) MULTI')],
            // Même titre, autre film (écart de plus d'un an)
            [13, movie(13, 'Mayday (2005)')],
            // Sans année : jamais relié, il pourrait être n'importe quel film du nom
            [14, movie(14, 'Stepfather')],
            // Entrée Xtream (sans données M3U) : jamais touchée
            [15, movie(15, 'Kung Fu Panda 3 (2016)')],
            // Nombre final pris pour l'année : 1999 contre une fiche de 1975, jamais relié
            [16, movie(16, 'Space 1999')],
        ]),
        series: new Map([[21, series(21, 'Lanterns (2026)')]]),
        live: new Map(), categories: new Map(),
        moviesByTmdb: new Map(), seriesByTmdb: new Map(), iconPrefixes: [],
    };
}

const m3u = JSON.stringify({ source: 'm3u', url: 'http://192.0.2.10/v.mkv' });
const details = (tmdbId: number, type: 'movie' | 'series', fields: Record<string, string>) =>
    `(${tmdbId}, '${type}', 0, '${(fields.title ?? fields.name).replace(/'/g, "''")}', '/p${tmdbId}.jpg', '${JSON.stringify(fields).replace(/'/g, "''")}', 1)`;

beforeEach(() => {
    prefs.titleSearch = true;
    meta.clear();
    tmdbCalls.count = 0;
    sqlite.db = new Sqlite(':memory:');
    sqlite.db.exec(`
        CREATE TABLE movies (id INTEGER PRIMARY KEY, tmdb_id INTEGER, name TEXT NOT NULL, data TEXT);
        CREATE TABLE series (id INTEGER PRIMARY KEY, tmdb_id INTEGER, name TEXT NOT NULL, data TEXT);
        CREATE TABLE m3u_tmdb_links (kind TEXT NOT NULL, id INTEGER NOT NULL, name TEXT NOT NULL,
            tmdb_id INTEGER NOT NULL, checked_at INTEGER NOT NULL, PRIMARY KEY (kind, id));
        CREATE TABLE title_tmdb_posters (kind TEXT NOT NULL, tmdb_id INTEGER NOT NULL, poster_path TEXT NOT NULL,
            PRIMARY KEY (kind, tmdb_id));
        CREATE TABLE tmdb_details_cache (tmdb_id INTEGER NOT NULL, type TEXT NOT NULL, season_number INTEGER NOT NULL DEFAULT 0,
            display_name TEXT, poster_path TEXT, full_data TEXT NOT NULL, cached_at INTEGER NOT NULL);
        CREATE TABLE watchlist (stream_id INTEGER NOT NULL, tmdb_id INTEGER DEFAULT 0, type TEXT NOT NULL,
            added_at INTEGER NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (stream_id, type));
    `);
    const insert = sqlite.db.prepare('INSERT INTO movies VALUES (?, NULL, ?, ?)');
    for (const entry of rawCatalog().movies.values()) insert.run(entry.id, entry.name, entry.id === 15 ? null : m3u);
    sqlite.db.prepare('INSERT INTO series VALUES (21, NULL, ?, ?)').run('Lanterns (2026)', m3u);
    sqlite.db.exec(`
        INSERT INTO tmdb_details_cache VALUES
            ${details(1001, 'movie', { title: 'Crocodile Swarm', original_title: 'Crocodile Swarm', release_date: '2025-06-01' })},
            ${details(1002, 'movie', { title: 'Mayday', original_title: 'Mayday', release_date: '2025-10-03' })},
            ${details(1003, 'movie', { title: 'Stepfather', original_title: 'Stepfather', release_date: '2025-01-01' })},
            ${details(1004, 'movie', { title: 'Kung Fu Panda 3', original_title: 'Kung Fu Panda 3', release_date: '2016-01-29' })},
            ${details(1005, 'movie', { title: 'Space 1999', original_title: 'Space 1999', release_date: '1975-09-04' })},
            ${details(2001, 'series', { name: 'Lanterns', original_name: 'Lanterns', first_air_date: '2026-08-16' })};
        -- Lignes venues de l'ancien fournisseur : leurs numéros de source n'existent pas ici
        INSERT INTO watchlist (stream_id, tmdb_id, type, added_at) VALUES
            (9001, 1001, 'movie', 5), (9002, 1002, 'movie', 4), (9003, 1003, 'movie', 3), (9004, 1004, 'movie', 2), (9005, 2001, 'series', 1), (9006, 1005, 'movie', 0);
    `);
});

const orphanNames = (items: Awaited<ReturnType<typeof getHydratedWatchlist>>) =>
    items.filter((item) => item.isOrphan).map((item) => item.name).sort();
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };

describe('Ma liste rattachée par le titre après un passage à une liste M3U', () => {
    it('le titre de même nom et de même année redevient disponible, sans aucune demande à TMDB', async () => {
        const indexes = catalog();
        const before = await getHydratedWatchlist(indexes);
        expect(orphanNames(before)).toEqual(['Crocodile Swarm', 'Kung Fu Panda 3', 'Lanterns', 'Mayday', 'Space 1999', 'Stepfather']);

        await relinkWatchlistOrphansByTitle(indexes, before);
        await settle();
        const after = await getHydratedWatchlist(indexes);
        // Mayday (2005 ≠ 2025), Stepfather (sans année), Space 1999 (1999 ≠ 1975) et l'entrée Xtream restent introuvables
        expect(orphanNames(after)).toEqual(['Kung Fu Panda 3', 'Mayday', 'Space 1999', 'Stepfather']);
        // Les deux versions de Crocodile Swarm sont reliées ; le lien est gardé pour le lancement suivant
        expect(indexes.movies.get(11)!.tmdbId).toBe(1001);
        expect(indexes.movies.get(12)!.tmdbId).toBe(1001);
        expect(indexes.series.get(21)!.tmdbId).toBe(2001);
        expect(sqlite.db.prepare('SELECT kind, id, tmdb_id FROM m3u_tmdb_links ORDER BY kind, id').all())
            .toEqual([{ kind: 'movie', id: 11, tmdb_id: 1001 }, { kind: 'movie', id: 12, tmdb_id: 1001 }, { kind: 'series', id: 21, tmdb_id: 2001 }]);
        // La colonne du fournisseur n'est jamais écrite
        expect(sqlite.db.prepare('SELECT COUNT(*) AS n FROM movies WHERE tmdb_id IS NOT NULL').get()).toEqual({ n: 0 });
        expect(tmdbCalls.count).toBe(0);
    });

    it('la lecture de Ma liste lance le rattachement d\'elle-même', async () => {
        const indexes = catalog();
        await getHydratedWatchlist(indexes);
        await settle();
        expect(indexes.movies.get(11)!.tmdbId).toBe(1001);
    });

    it('réglage « Chercher les fiches TMDB par le titre » coupé : rien n\'est relié', async () => {
        prefs.titleSearch = false;
        const indexes = catalog();
        await relinkWatchlistOrphansByTitle(indexes, [{ tmdb_id: 1001, type: 'movie' }]);
        expect(indexes.movies.get(11)!.tmdbId).toBe(0);
        expect(sqlite.db.prepare('SELECT COUNT(*) AS n FROM m3u_tmdb_links').get()).toEqual({ n: 0 });
    });

    it('réglage coupé ou compte changé pendant la passe : rien n\'est gardé', async () => {
        const indexes = catalog();
        const run = relinkWatchlistOrphansByTitle(indexes, [{ tmdb_id: 1001, type: 'movie' }]);
        prefs.titleSearch = false;
        await run;
        prefs.titleSearch = true;
        const other = catalog();
        const second = relinkWatchlistOrphansByTitle(indexes, [{ tmdb_id: 2001, type: 'series' }]);
        expect(other).not.toBe(indexes);
        await second;
        await settle();
        expect(sqlite.db.prepare('SELECT COUNT(*) AS n FROM m3u_tmdb_links').get()).toEqual({ n: 0 });
        expect(indexes.movies.get(11)!.tmdbId).toBe(0);
    });

    it('demande arrivée pendant une passe : faite à la fin, pas oubliée', async () => {
        const indexes = catalog();
        const first = relinkWatchlistOrphansByTitle(indexes, [{ tmdb_id: 1001, type: 'movie' }]);
        const second = relinkWatchlistOrphansByTitle(indexes, [{ tmdb_id: 2001, type: 'series' }]);
        await Promise.all([first, second]);
        await settle();
        expect(indexes.movies.get(11)!.tmdbId).toBe(1001);
        expect(indexes.series.get(21)!.tmdbId).toBe(2001);
    });

    it('catalogue sans entrée M3U (fournisseur Xtream) : rien n\'est fait', async () => {
        sqlite.db.exec('UPDATE movies SET data = NULL; UPDATE series SET data = NULL');
        const indexes = catalog();
        expect(await relinkWatchlistOrphansByTitle(indexes, [{ tmdb_id: 1001, type: 'movie' }])).toBe(0);
        expect(indexes.movies.get(11)!.tmdbId).toBe(0);
    });

    it('fiche sans année ni titre : pas de lien possible', () => {
        expect(titleFactsOf('movie', JSON.stringify({ title: 'Elf' }), null)).toBeNull();
        expect(titleFactsOf('series', JSON.stringify({ first_air_date: '2004-09-22' }), null)).toBeNull();
        expect(titleFactsOf('movie', 'pas du json', null)).toBeNull();
        expect(titleFactsOf('series', JSON.stringify({ name: 'Lost', original_name: 'Lost', first_air_date: '2004-09-22' }), '/l.jpg'))
            .toEqual({ titles: ['Lost', 'Lost'], year: 2004, poster: '/l.jpg' });
    });
});
