/**
 * Base locale et compte Supabase : isDatabaseOf dit si la base ouverte est celle du
 * compte, et clearAllData oublie le dernier accord de Ma liste avec le cloud (sync/syncBaseline.ts).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockDb = {
    select: vi.fn(async () => []),
    execute: vi.fn(async () => ({ rowsAffected: 0 })),
    close: vi.fn(async () => {}),
};
const load = vi.fn(async (_name: string) => mockDb);
vi.mock('../nyxDatabase', () => ({ default: { load: (name: string) => load(name) } }));

import { setDatabaseName, resetDatabaseName, isDatabaseOf, getDatabase, clearAllData, clearCatalogData, closeDatabaseConnection } from '../dbCore';
import { readBaseline, updateBaseline, canStillWrite } from '../sync/syncBaseline';
import { setCurrentSyncUserId } from '../sync/syncState';

describe('dbCore et compte', () => {
    beforeEach(async () => {
        await closeDatabaseConnection();
        resetDatabaseName();
        mockDb.execute.mockClear();
    });

    it('reconnaît la base du compte connecté, et seulement elle', async () => {
        expect(isDatabaseOf('a')).toBe(false);
        setDatabaseName('a');
        expect(isDatabaseOf('a')).toBe(true);
        await getDatabase();
        expect(isDatabaseOf('a')).toBe(true);
        expect(isDatabaseOf('b')).toBe(false);
    });

    it('ne prend pas la base encore ouverte du compte précédent pour celle du compte suivant', async () => {
        setDatabaseName('a');
        await getDatabase(); // base de « a » ouverte
        setDatabaseName('b'); // « b » se connecte avant la fermeture de la base de « a »
        expect(isDatabaseOf('b')).toBe(false);
        expect(isDatabaseOf('a')).toBe(false);
    });

    it('clearAllData oublie les deux derniers accords de Ma liste (sinon la synchro viderait Ma liste du cloud)', async () => {
        setDatabaseName('a');
        await clearAllData();
        expect(mockDb.execute).toHaveBeenCalledWith(
            `DELETE FROM meta WHERE key IN ('sync_baseline:watchlist', 'sync_baseline:watchlist_v2')`,
        );
    });

    it('une synchro de Ma liste par fournisseur en cours pendant clearAllData ne peut plus réécrire son dernier accord', async () => {
        setDatabaseName('a');
        setCurrentSyncUserId('a');
        await getDatabase();
        const read = await readBaseline('a', 'watchlist_v2');
        await clearAllData();
        expect(canStillWrite('a', read)).toBe(false);
        setCurrentSyncUserId(null);
    });

    it('une synchro de Ma liste en cours pendant clearAllData ne peut plus réécrire le dernier accord', async () => {
        setDatabaseName('a');
        setCurrentSyncUserId('a');
        await getDatabase();
        const read = await readBaseline('a', 'watchlist'); // synchro commencée avant l'effacement
        await clearAllData();
        mockDb.execute.mockClear();
        vi.spyOn(console, 'warn').mockImplementation(() => {});

        // La synchro termine : elle voudrait noter ses titres dans le dernier accord
        expect(canStillWrite('a', read)).toBe(false);
        await updateBaseline('a', 'watchlist', { generation: read.generation, set: [['t:550:movie', 0]] });

        const writes = mockDb.execute.mock.calls.map((call) => JSON.stringify(call));
        expect(writes.some((call) => call.includes('sync_baseline:watchlist'))).toBe(false);
        setCurrentSyncUserId(null);
        vi.restoreAllMocks();
    });

    it('clearCatalogData vide le catalogue et garde Ma liste avec son dernier accord', async () => {
        setDatabaseName('a');
        await getDatabase(); // schéma créé à l'ouverture, hors du vidage
        mockDb.execute.mockClear();
        await clearCatalogData();
        const statements = mockDb.execute.mock.calls.map((call) => String((call as unknown[])[0]));
        for (const table of ['movies', 'series', 'live', 'categories']) {
            expect(statements).toContain(`DELETE FROM ${table}`);
        }
        expect(statements.some((sql) => /watchlist/.test(sql))).toBe(false);
    });

    it('changement de compte : la base du compte suivant ne reçoit pas celle en cours de fermeture', async () => {
        setDatabaseName('a');
        await getDatabase();
        let finishClose: () => void = () => {};
        mockDb.close.mockImplementationOnce(() => new Promise<void>((resolve) => { finishClose = resolve; }));
        load.mockClear();

        const closing = closeDatabaseConnection(); // non attendue, comme dans onAuthStateChange
        resetDatabaseName();
        setDatabaseName('b');
        await getDatabase(); // accès du compte suivant pendant la fermeture

        expect(load).toHaveBeenCalledWith('sqlite:nyxplayer_b.db');
        expect(isDatabaseOf('b')).toBe(true);
        finishClose();
        await closing;
        expect(isDatabaseOf('b')).toBe(true);
    });

    it('deux premiers accès simultanés : une seule ouverture, la même base pour les deux', async () => {
        setDatabaseName('a');
        load.mockClear();
        const [first, second] = await Promise.all([getDatabase(), getDatabase()]);
        expect(load).toHaveBeenCalledTimes(1);
        expect(first).toBe(second);
    });

    it("fermée pendant son ouverture : la base du compte précédent n'est pas installée", async () => {
        setDatabaseName('a');
        let finishLoad: () => void = () => {};
        const staleDb = { ...mockDb, path: 'sqlite:nyxplayer_a.db', close: vi.fn(async () => {}) };
        load.mockClear();
        load.mockImplementationOnce(() => new Promise((resolve) => { finishLoad = () => resolve(staleDb); }));

        const pending = getDatabase(); // ouverture de la base de « a » en cours
        await Promise.resolve();
        void closeDatabaseConnection(); // changement de compte pendant l'ouverture
        resetDatabaseName();
        setDatabaseName('b');
        finishLoad();

        await expect(pending).rejects.toThrow(/fermée pendant son ouverture/);
        expect(staleDb.close).toHaveBeenCalledWith('sqlite:nyxplayer_a.db');
        expect(isDatabaseOf('b')).toBe(true);
        await getDatabase();
        expect(load).toHaveBeenLastCalledWith('sqlite:nyxplayer_b.db');
    });

    it('fermeture par le nom de la base : celle du compte suivant, déjà ouverte, reste ouverte', async () => {
        // Le Rust ferme la base nommée, ou toutes sans nom : on note ce que chaque fermeture atteint
        const open = new Set<string>();
        const closeInRust = vi.fn(async (name?: string) => {
            if (name === undefined) open.clear(); else open.delete(name);
        });
        const fakeDb = (path: string) => ({ ...mockDb, path, close: closeInRust });
        load.mockImplementationOnce(async (name: string) => { open.add(name); return fakeDb(name); });
        load.mockImplementationOnce(async (name: string) => { open.add(name); return fakeDb(name); });
        setDatabaseName('a');
        await getDatabase();

        let finishClose: () => void = () => {};
        closeInRust.mockImplementationOnce((name?: string) => new Promise<void>((resolve) => {
            finishClose = () => { if (name === undefined) open.clear(); else open.delete(name); resolve(); };
        }));
        const closing = closeDatabaseConnection(); // fermeture de « a » pas encore faite côté Rust
        resetDatabaseName();
        setDatabaseName('b');
        await getDatabase(); // base de « b » ouverte entre-temps
        finishClose();
        await closing;

        expect(open.has('sqlite:nyxplayer_b.db')).toBe(true);
        expect(open.has('sqlite:nyxplayer_a.db')).toBe(false);
    });

    it("fermeture pendant une ouverture : attend que la connexion soit refermée (remise à zéro sous Windows)", async () => {
        setDatabaseName('a');
        let finishLoad: () => void = () => {};
        const staleDb = { ...mockDb, path: 'sqlite:nyxplayer_a.db', close: vi.fn(async () => {}) };
        load.mockImplementationOnce(() => new Promise((resolve) => { finishLoad = () => resolve(staleDb); }));
        const pending = getDatabase().catch(() => {});
        await Promise.resolve();

        let closed = false;
        resetDatabaseName(); // remise à zéro : nom oublié, puis fermeture
        const closing = closeDatabaseConnection().then(() => { closed = true; });
        await Promise.resolve();
        expect(closed).toBe(false);
        finishLoad();
        await closing;
        await pending;
        expect(staleDb.close).toHaveBeenCalledWith('sqlite:nyxplayer_a.db');
    });

    it("autre compte annoncé sans fermeture pendant l'ouverture : la base précédente n'est pas installée", async () => {
        setDatabaseName('a');
        let finishLoad: () => void = () => {};
        const staleDb = { ...mockDb, path: 'sqlite:nyxplayer_a.db', close: vi.fn(async () => {}) };
        load.mockImplementationOnce(() => new Promise((resolve) => { finishLoad = () => resolve(staleDb); }));
        const pending = getDatabase();
        await Promise.resolve();
        setDatabaseName('b'); // SIGNED_IN d'un autre compte sans SIGNED_OUT
        finishLoad();
        await expect(pending).rejects.toThrow(/fermée pendant son ouverture/);
        expect(isDatabaseOf('b')).toBe(true);
    });
});
