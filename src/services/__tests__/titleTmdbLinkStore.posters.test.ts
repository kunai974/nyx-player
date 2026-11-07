/**
 * Affiches TMDB des titres sans image : un titre relié par son nom reçoit l'affiche du résultat TMDB
 * choisi (aucune demande en plus), seulement s'il n'a pas d'image à lui ; elle part avec le lien quand le
 * réglage est coupé, et revient avec lui.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import type { LightIndexes, LightMovie } from '../../types/lightIndex';
import { getIconUrl } from '../../types/lightIndex';
import { PREFERENCES_EVENT } from '../eventConstants';

const sqlite = vi.hoisted(() => ({ db: null as unknown as DatabaseSync }));
const prefs = vi.hoisted(() => ({ titleSearch: true }));
vi.mock('../dbCore', () => ({
    getDatabase: async () => ({
        select: async (sql: string, params: unknown[] = []) => sqlite.db.prepare(sql).all(...(params as (string | number | null)[])),
        execute: async (sql: string, params: unknown[] = []) => sqlite.db.prepare(sql).run(...(params as (string | number | null)[])),
    }),
    getDatabaseFileName: () => 'nyxplayer_a.db',
}));
vi.mock('../preferencesService', () => ({ isTmdbTitleSearchEnabled: () => prefs.titleSearch }));
vi.mock('../dashboardRematch', () => ({ computeDashboardRematch: vi.fn(async () => ({ rows: [] })) }));
vi.mock('../dashboardCache', () => ({ installDashboardRematch: vi.fn(() => true) }));

import {
    applyLinkInMemory, applyStoredTitleLinks, categoryPostersVersion, hasGivenPoster, noteFoundPoster,
    rememberCurrentCatalog, subscribeTitlePosters, titlePostersVersion,
} from '../titleTmdbLinkStore';
import { groupItemsByCategory } from '../../components/Iptv/categoryRows';

const { DatabaseSync: Sqlite } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');

const light = (id: number, name: string, tmdbId: number, icon = -1, suffix = ''): LightMovie => ({
    id, name, tmdbId, iconPrefixId: icon, iconSuffix: suffix, categoryId: '1', added: 0, containerExt: 'mkv',
});

function catalog(): LightIndexes {
    return {
        movies: new Map([
            [1, light(1, 'Inception (2010)', 0)],
            // Image donnée par la liste : elle reste
            [2, light(2, 'Dune (2021)', 0, 0, '/dune.jpg')],
            [3, light(3, 'Sintel (2010)', 0)],
        ]),
        series: new Map(), live: new Map(), categories: new Map(),
        moviesByTmdb: new Map(), seriesByTmdb: new Map(), iconPrefixes: ['http://images.example/'],
    };
}

const image = (indexes: LightIndexes, id: number) => getIconUrl(indexes.movies.get(id)!, indexes.iconPrefixes);
const turns = async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

beforeEach(() => {
    prefs.titleSearch = true;
    sqlite.db = new Sqlite(':memory:');
    sqlite.db.exec(`
        CREATE TABLE movies (id INTEGER PRIMARY KEY, tmdb_id INTEGER, name TEXT NOT NULL);
        CREATE TABLE series (id INTEGER PRIMARY KEY, tmdb_id INTEGER, name TEXT NOT NULL);
        CREATE TABLE m3u_tmdb_links (kind TEXT NOT NULL, id INTEGER NOT NULL, name TEXT NOT NULL,
            tmdb_id INTEGER NOT NULL, checked_at INTEGER NOT NULL, PRIMARY KEY (kind, id));
        CREATE TABLE tmdb_details_cache (tmdb_id INTEGER NOT NULL, type TEXT NOT NULL, season_number INTEGER NOT NULL DEFAULT 0,
            poster_path TEXT, full_data TEXT NOT NULL, cached_at INTEGER NOT NULL);
        CREATE TABLE title_tmdb_posters (kind TEXT NOT NULL, tmdb_id INTEGER NOT NULL, poster_path TEXT NOT NULL,
            PRIMARY KEY (kind, tmdb_id));
        INSERT INTO movies VALUES (1, NULL, 'Inception (2010)'), (2, NULL, 'Dune (2021)'), (3, NULL, 'Sintel (2010)');
        INSERT INTO m3u_tmdb_links VALUES ('movie', 1, 'Inception (2010)', 27205, 1), ('movie', 2, 'Dune (2021)', 438631, 1);
        INSERT INTO title_tmdb_posters VALUES ('movie', 27205, '/inception.jpg'), ('movie', 438631, '/dune-tmdb.jpg');
    `);
});

describe('affiches TMDB des titres sans image', () => {
    // En premier : le signal aux cartes est groupé sur un délai, les autres cas en laissent un en attente
    it('recherche par le titre : l\'affiche du résultat choisi est notée et posée, les cartes sont prévenues une fois', async () => {
        vi.useFakeTimers();
        try {
            const indexes = catalog();
            rememberCurrentCatalog(indexes);
            const listener = vi.fn();
            const stop = subscribeTitlePosters(listener);
            const before = titlePostersVersion();
            const rowBefore = categoryPostersVersion('1');

            noteFoundPoster('movie', 45745, '/sintel.jpg');
            applyLinkInMemory(indexes, 'movie', 3, 45745);
            // Adresse complète ou chemin bizarre : jamais posé
            noteFoundPoster('movie', 1, 'https://ailleurs.example/x.jpg');
            noteFoundPoster('movie', 2, '/../x.jpg');

            expect(image(indexes, 3)).toBe('https://image.tmdb.org/t/p/w342/sintel.jpg');
            expect(categoryPostersVersion('1')).toBe(rowBefore + 1);
            expect(categoryPostersVersion('autre')).toBe(0);
            await vi.runAllTimersAsync();
            expect(listener).toHaveBeenCalledTimes(1);
            expect(titlePostersVersion()).toBe(before + 1);
            stop();
        } finally {
            vi.useRealTimers();
        }
        await turns();
        expect(sqlite.db.prepare('SELECT kind, tmdb_id, poster_path FROM title_tmdb_posters WHERE tmdb_id IN (45745, 1, 2)').all())
            .toEqual([{ kind: 'movie', tmdb_id: 45745, poster_path: '/sintel.jpg' }]);
    });

    it('au chargement : le titre sans image reçoit l\'affiche notée, celui qui en a une garde la sienne', async () => {
        const indexes = catalog();
        await applyStoredTitleLinks(indexes);
        expect(image(indexes, 1)).toBe('https://image.tmdb.org/t/p/w342/inception.jpg');
        expect(image(indexes, 2)).toBe('http://images.example//dune.jpg');
        expect(image(indexes, 3)).toBe('');
        expect(hasGivenPoster(indexes.movies.get(1)!)).toBe(true);
        expect(hasGivenPoster(indexes.movies.get(2)!)).toBe(false);
    });

    it('une affiche posée ne déplace jamais une carte : le classement suit l\'image du fournisseur', async () => {
        const indexes = catalog();
        await applyStoredTitleLinks(indexes);
        const row = groupItemsByCategory(indexes.movies.values(), false, new Set(['1'])).get('1')!;
        // Dune (image de la liste) d'abord, puis les autres dans l'ordre du catalogue
        expect(row.map((item) => item.id)).toEqual([2, 1, 3]);
    });

    it('reprend aussi l\'affiche d\'une fiche déjà ouverte (cache des fiches)', async () => {
        sqlite.db.exec(`DELETE FROM title_tmdb_posters;
            INSERT INTO tmdb_details_cache VALUES (27205, 'movie', 0, '/fiche.jpg', '{}', 1)`);
        const indexes = catalog();
        await applyStoredTitleLinks(indexes);
        expect(image(indexes, 1)).toBe('https://image.tmdb.org/t/p/w342/fiche.jpg');
    });

    it('réglage coupé : l\'affiche part avec le lien ; rallumé : elle revient', async () => {
        const indexes = catalog();
        rememberCurrentCatalog(indexes);
        await applyStoredTitleLinks(indexes);
        prefs.titleSearch = false;
        window.dispatchEvent(new CustomEvent(PREFERENCES_EVENT, { detail: { key: 'tmdb_title_search', value: 'false' } }));
        await turns();
        expect(image(indexes, 1)).toBe('');
        // Image d'avant rendue telle quelle
        expect(indexes.movies.get(1)).toMatchObject({ iconPrefixId: -1, iconSuffix: '' });
        expect(hasGivenPoster(indexes.movies.get(1)!)).toBe(false);
        expect(image(indexes, 2)).toBe('http://images.example//dune.jpg');

        prefs.titleSearch = true;
        window.dispatchEvent(new CustomEvent(PREFERENCES_EVENT, { detail: { key: 'tmdb_title_search', value: 'true' } }));
        await turns();
        expect(image(indexes, 1)).toBe('https://image.tmdb.org/t/p/w342/inception.jpg');
    });
});
