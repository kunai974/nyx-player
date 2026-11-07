/**
 * Réglage « fiches TMDB par le titre » : coupé, les fiches trouvées par le titre quittent tout de suite
 * le catalogue en mémoire (les numéros du fournisseur restent) ; rallumé, elles reviennent sans
 * nouvelle recherche, depuis les liens gardés dans la base.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import type { LightIndexes, LightMovie } from '../../types/lightIndex';
import { PREFERENCES_EVENT } from '../eventConstants';

const sqlite = vi.hoisted(() => ({ db: null as unknown as DatabaseSync }));
const prefs = vi.hoisted(() => ({ titleSearch: true }));
vi.mock('../dbCore', () => ({
    getDatabase: async () => ({
        select: async (sql: string, params: unknown[] = []) => sqlite.db.prepare(sql).all(...(params as (string | number | null)[])),
    }),
    getDatabaseFileName: () => 'nyxplayer_a.db',
}));
vi.mock('../preferencesService', () => ({ isTmdbTitleSearchEnabled: () => prefs.titleSearch }));
const home = vi.hoisted(() => ({ compute: vi.fn(async () => ({ rows: 'recalculées' })), install: vi.fn(() => true) }));
vi.mock('../dashboardRematch', () => ({ computeDashboardRematch: home.compute }));
vi.mock('../dashboardCache', () => ({ installDashboardRematch: home.install }));

import { applyStoredTitleLinks, rememberCurrentCatalog, titleLinkedEntryCounts } from '../titleTmdbLinkStore';

const { DatabaseSync: Sqlite } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');

const light = (id: number, name: string, tmdbId: number): LightMovie => ({
    id, name, tmdbId, iconPrefixId: -1, iconSuffix: '', categoryId: '1', added: 0, containerExt: 'mkv',
});

function catalog(): LightIndexes {
    const fromList = light(1, 'Inception (2010)', 0);
    const fromProvider = light(2, 'Dune (2021)', 438631);
    return {
        movies: new Map([[1, fromList], [2, fromProvider]]),
        series: new Map(), live: new Map(), categories: new Map(),
        moviesByTmdb: new Map([[438631, fromProvider]]), seriesByTmdb: new Map(), iconPrefixes: [],
    };
}

const changeSetting = async (on: boolean) => {
    prefs.titleSearch = on;
    window.dispatchEvent(new CustomEvent(PREFERENCES_EVENT, { detail: { key: 'tmdb_title_search', value: String(on) } }));
    // Le retour des liens relit la base : quelques tours pour finir
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

beforeEach(() => {
    prefs.titleSearch = true;
    home.compute.mockClear();
    home.install.mockClear();
    sqlite.db = new Sqlite(':memory:');
    sqlite.db.exec(`
        CREATE TABLE movies (id INTEGER PRIMARY KEY, tmdb_id INTEGER, name TEXT NOT NULL);
        CREATE TABLE series (id INTEGER PRIMARY KEY, tmdb_id INTEGER, name TEXT NOT NULL);
        CREATE TABLE m3u_tmdb_links (kind TEXT NOT NULL, id INTEGER NOT NULL, name TEXT NOT NULL,
            tmdb_id INTEGER NOT NULL, checked_at INTEGER NOT NULL, PRIMARY KEY (kind, id));
        INSERT INTO movies VALUES (1, NULL, 'Inception (2010)'), (2, 438631, 'Dune (2021)');
        INSERT INTO m3u_tmdb_links VALUES ('movie', 1, 'Inception (2010)', 27205, 1);
    `);
});

describe('réglage des fiches TMDB par le titre', () => {
    it('coupé : la fiche trouvée par le titre disparaît, celle du fournisseur reste ; rallumé : elle revient', async () => {
        const indexes = catalog();
        rememberCurrentCatalog(indexes);
        await applyStoredTitleLinks(indexes);
        expect(indexes.movies.get(1)!.tmdbId).toBe(27205);
        expect(indexes.moviesByTmdb.get(27205)).toBe(indexes.movies.get(1));

        await changeSetting(false);
        expect(indexes.movies.get(1)!.tmdbId).toBe(0);
        expect(indexes.moviesByTmdb.has(27205)).toBe(false);
        expect(indexes.movies.get(2)!.tmdbId).toBe(438631);
        expect(indexes.moviesByTmdb.get(438631)).toBe(indexes.movies.get(2));
        expect(titleLinkedEntryCounts(indexes)).toEqual({ movies: 0, series: 0 });
        // Le lien reste noté dans la base, pour le retour
        expect(sqlite.db.prepare('SELECT COUNT(*) AS n FROM m3u_tmdb_links').get()).toEqual({ n: 1 });

        await changeSetting(true);
        expect(indexes.movies.get(1)!.tmdbId).toBe(27205);
        expect(indexes.moviesByTmdb.get(27205)).toBe(indexes.movies.get(1));
    });

    it('l\'accueil est recalculé à chaque changement, sans attendre un nouveau chargement', async () => {
        const indexes = catalog();
        rememberCurrentCatalog(indexes);
        await applyStoredTitleLinks(indexes);
        await changeSetting(false);
        expect(home.compute).toHaveBeenCalledWith(indexes);
        expect(home.install).toHaveBeenCalledTimes(1);
        await changeSetting(true);
        expect(home.install).toHaveBeenCalledTimes(2);
    });

    it('réglage coupé pendant la relecture de la base : aucun lien posé', async () => {
        const indexes = catalog();
        rememberCurrentCatalog(indexes);
        const reading = applyStoredTitleLinks(indexes);
        prefs.titleSearch = false;
        await reading;
        expect(indexes.movies.get(1)!.tmdbId).toBe(0);
    });

    it('une autre préférence changée : rien ne bouge', async () => {
        const indexes = catalog();
        rememberCurrentCatalog(indexes);
        await applyStoredTitleLinks(indexes);
        window.dispatchEvent(new CustomEvent(PREFERENCES_EVENT, { detail: { key: 'language', value: 'fr' } }));
        await new Promise((r) => setTimeout(r, 0));
        expect(indexes.movies.get(1)!.tmdbId).toBe(27205);
    });
});
