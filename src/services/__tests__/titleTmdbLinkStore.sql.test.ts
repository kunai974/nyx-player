/**
 * Liens TMDB par le titre reposés au chargement, sur une vraie base SQLite (node:sqlite) : la reprise
 * après renumérotation retrouve le lien sous le nouveau numéro, et reste rapide quand des titres reliés
 * ont quitté le catalogue (aucune relecture complète du catalogue par lien disparu).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import type { LightIndexes, LightMovie } from '../../types/lightIndex';

const sqlite = vi.hoisted(() => ({ db: null as unknown as DatabaseSync }));
vi.mock('../dbCore', () => ({
    getDatabase: async () => ({
        select: async (sql: string, params: unknown[] = []) => sqlite.db.prepare(sql).all(...(params as (string | number | null)[])),
    }),
    getDatabaseFileName: () => 'nyxplayer_a.db',
}));
vi.mock('../preferencesService', () => ({ isTmdbTitleSearchEnabled: () => true }));

import { applyStoredTitleLinks } from '../titleTmdbLinkStore';

const light = (id: number, name: string): LightMovie => ({
    id, name, tmdbId: 0, iconPrefixId: -1, iconSuffix: '', categoryId: '1', added: 0, containerExt: 'mkv',
});

function catalogFromDb(): LightIndexes {
    const rows = sqlite.db.prepare('SELECT id, name FROM movies').all() as { id: number; name: string }[];
    return {
        movies: new Map(rows.map((r) => [r.id, light(r.id, r.name)])),
        series: new Map(), live: new Map(), categories: new Map(),
        moviesByTmdb: new Map(), seriesByTmdb: new Map(), iconPrefixes: [],
    };
}

/** `count` films sans numéro TMDB, chacun relié par le titre (numéro TMDB = 1000 + id) */
function seed(count: number): void {
    sqlite.db.exec('BEGIN');
    const movie = sqlite.db.prepare('INSERT INTO movies (id, tmdb_id, name) VALUES (?, NULL, ?)');
    const link = sqlite.db.prepare("INSERT INTO m3u_tmdb_links (kind, id, name, tmdb_id, checked_at) VALUES ('movie', ?, ?, ?, 1)");
    for (let id = 1; id <= count; id++) {
        const name = `FR | Film ${id} (${1950 + (id % 70)})`;
        movie.run(id, name);
        link.run(id, name, 1000 + id);
    }
    sqlite.db.exec('COMMIT');
}

/** Le fournisseur retire `count` films reliés et redonne un numéro neuf à un sur deux */
function renumber(count: number, offset: number): void {
    sqlite.db.exec('BEGIN');
    for (let id = 1; id <= count; id++) {
        const { name } = sqlite.db.prepare('SELECT name FROM movies WHERE id = ?').get(id) as { name: string };
        sqlite.db.prepare('DELETE FROM movies WHERE id = ?').run(id);
        if (id % 2 === 0) sqlite.db.prepare('INSERT INTO movies (id, tmdb_id, name) VALUES (?, NULL, ?)').run(offset + id, name);
    }
    sqlite.db.exec('COMMIT');
}

// Module intégré de Node 22, chargé sans passer par le regroupement de Vite (environnement jsdom)
const { DatabaseSync: Sqlite } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');

beforeEach(() => {
    sqlite.db = new Sqlite(':memory:');
    sqlite.db.exec(`
        CREATE TABLE movies (id INTEGER PRIMARY KEY, tmdb_id INTEGER, name TEXT NOT NULL);
        CREATE TABLE series (id INTEGER PRIMARY KEY, tmdb_id INTEGER, name TEXT NOT NULL);
        CREATE TABLE m3u_tmdb_links (kind TEXT NOT NULL, id INTEGER NOT NULL, name TEXT NOT NULL,
            tmdb_id INTEGER NOT NULL, checked_at INTEGER NOT NULL, PRIMARY KEY (kind, id));
    `);
});

describe('applyStoredTitleLinks (vraie base)', () => {
    it('gives a renumbered title its link back under the new number', async () => {
        seed(10);
        renumber(4, 500);
        const indexes = catalogFromDb();

        expect(await applyStoredTitleLinks(indexes)).toBe(6 + 2);
        expect(indexes.movies.get(502)!.tmdbId).toBe(1002);
        expect(indexes.movies.get(504)!.tmdbId).toBe(1004);
        expect(indexes.movies.get(7)!.tmdbId).toBe(1007);
    });

    it('stays fast when hundreds of linked titles left a large catalogue', async () => {
        seed(100_000);
        renumber(1000, 200_000);
        const indexes = catalogFromDb();

        const start = performance.now();
        const applied = await applyStoredTitleLinks(indexes);
        const elapsed = performance.now() - start;

        expect(applied).toBe(100_000 - 1000 + 500);
        expect(indexes.movies.get(200_400)!.tmdbId).toBe(1400);
        // Avant : une relecture des 100 000 films par lien disparu (environ 6 s) ; après : une seule (moins d'une seconde, marge pour une CI chargée)
        expect(elapsed).toBeLessThan(3000);
    }, 30_000);
});
