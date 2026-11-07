/**
 * Ma liste face au cloud : synchro à la connexion (syncWatchlist) et envoi des
 * numéros re-liés (pushWatchlistUpdates).
 *
 * Le cloud est simulé par une petite table en mémoire qui applique la clé de Supabase
 * (user_id, stream_id, media_type) : une mise à jour vers un numéro déjà pris est refusée avec le
 * code PostgreSQL 23505, comme en vrai.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeWatchlistDb } from './fakeWatchlistDb';
import type { FakeWatchlistRow } from './fakeWatchlistDb';

// ============================================================================
// FAUX CLOUD
// ============================================================================

interface CloudRow {
    user_id: string;
    tmdb_id: number;
    media_type: 'movie' | 'series';
    stream_id: number;
    provider_hash: string | null;
    added_at: string;
    updated_at: string;
}

type Filters = [string, unknown][];
interface Call { op: string; payload?: unknown; filters: Filters; returning?: boolean }

const USER = 'user-test';
const HASH = 'hash-actuel';
let cloud: CloudRow[] = [];
let calls: Call[] = [];
/** Erreur imposée aux mises à jour (coupure réseau…) */
let updateError: { message: string; code?: string } | null = null;
/** Erreur imposée aux ajouts (réseau coupé au milieu d'un envoi) */
let insertError: { message: string; code?: string } | null = null;
/** Suppressions refusées sans erreur, comme le fait Supabase quand les règles d'accès les bloquent */
let deleteIgnored = false;
/** Plus de réseau : toute requête échoue */
let networkDown = false;

const matches = (row: CloudRow, filters: Filters) =>
    filters.every(([key, value]) => row[key as keyof CloudRow] === value);

const duplicateKey = () => {
    const seen = new Set<string>();
    for (const row of cloud) {
        const key = `${row.user_id}:${row.stream_id}:${row.media_type}`;
        if (seen.has(key)) return true;
        seen.add(key);
    }
    return false;
};

function execute(call: Call): { data?: unknown; error: { message: string; code?: string } | null } {
    calls.push(call);
    if (networkDown) return { error: { message: 'TypeError: Failed to fetch' } };
    if (call.op === 'select') return { data: cloud.filter((row) => matches(row, call.filters)).map((row) => ({ ...row })), error: null };
    if (call.op === 'delete') {
        if (deleteIgnored) return { data: call.returning ? [] : null, error: null }; // refus silencieux (règles d'accès)
        const removed = cloud.filter((row) => matches(row, call.filters));
        cloud = cloud.filter((row) => !matches(row, call.filters));
        return { data: call.returning ? removed.map((row) => ({ stream_id: row.stream_id })) : null, error: null };
    }
    if (call.op === 'update') {
        if (updateError) return { error: updateError };
        const before = cloud.map((row) => ({ ...row }));
        const touched = cloud.filter((row) => matches(row, call.filters));
        for (const row of touched) Object.assign(row, call.payload);
        if (duplicateKey()) {
            cloud = before;
            return { error: { message: 'duplicate key value violates unique constraint', code: '23505' } };
        }
        return { data: call.returning ? touched.map((row) => ({ stream_id: row.stream_id })) : null, error: null };
    }
    if (call.op === 'insert') {
        if (insertError) return { error: insertError };
        cloud.push({ added_at: '2026-09-28T00:00:00Z', updated_at: '2026-09-28T00:00:00Z', provider_hash: null, ...(call.payload as Partial<CloudRow>) } as CloudRow);
        if (duplicateKey()) {
            cloud.pop();
            return { error: { message: 'duplicate key value violates unique constraint', code: '23505' } };
        }
        return { error: null };
    }
    if (call.op === 'upsert') {
        const list = (Array.isArray(call.payload) ? call.payload : [call.payload]) as Partial<CloudRow>[];
        for (const item of list) {
            const existing = cloud.find((row) => row.user_id === item.user_id && row.stream_id === item.stream_id && row.media_type === item.media_type);
            if (existing) Object.assign(existing, item);
            else cloud.push({ added_at: '2026-09-28T00:00:00Z', updated_at: '2026-09-28T00:00:00Z', provider_hash: null, ...item } as CloudRow);
        }
        return { error: null };
    }
    throw new Error(`faux cloud : opération ${call.op}`);
}

vi.mock('../supabaseClient', () => ({
    supabase: {
        from: () => {
            const call: Call = { op: '', filters: [] };
            const builder = {
                select: () => { if (call.op) call.returning = true; else call.op = 'select'; return builder; },
                insert: (payload: unknown) => { call.op = 'insert'; call.payload = payload; return builder; },
                update: (payload: unknown) => { call.op = 'update'; call.payload = payload; return builder; },
                delete: () => { call.op = 'delete'; return builder; },
                upsert: (payload: unknown) => { call.op = 'upsert'; call.payload = payload; return builder; },
                eq: (key: string, value: unknown) => { call.filters.push([key, value]); return builder; },
                order: () => builder,
                range: () => builder,
                then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
                    Promise.resolve().then(() => execute(call)).then(resolve, reject),
            };
            return builder;
        },
    },
}));

let local = createFakeWatchlistDb([]);
/** Table meta de la base locale (dernier accord avec le cloud, sync/syncBaseline.ts) */
let meta = new Map<string, string>();
vi.mock('../dbCore', () => ({
    getDatabase: vi.fn(async () => local.db),
    getMeta: vi.fn(async (key: string) => meta.get(key) ?? null),
    setMeta: vi.fn(async (key: string, value: string) => { meta.set(key, value); }),
    isDatabaseOf: vi.fn(() => true),
    getDatabaseFileName: vi.fn(() => 'test.db'),
}));

vi.mock('../preferencesService', () => ({
    getLastProviderHash: () => HASH,
    computeProviderHash: async (host: string) => host, // meta.lastProvider = HASH dans ces tests
}));

vi.mock('../../utils/devLog', () => ({ devLog: vi.fn() }));

// ============================================================================
// IMPORT AFTER MOCKS
// ============================================================================

import { syncWatchlist } from '../sync/syncWatchlist';
import { pushWatchlistUpdates, placeWatchlistTitles } from '../sync/syncPush';
import { setCurrentSyncUserId } from '../sync/syncState';
import { pushWatchlistDeleteToCloud, pushWatchlistUpsertToCloud } from '../sync/syncPush';
import { isDatabaseOf } from '../dbCore';
import { toggleWatchlist } from '../watchlistHydration';
import { relinkWatchlistStreamIds } from '../watchlistRelinking';
import type { LightIndexes } from '../../types/lightIndex';
import type { SyncResult } from '../sync/syncTypes';

// ============================================================================
// HELPERS
// ============================================================================

function cloudRow(tmdb_id: number, stream_id: number, extra: Partial<CloudRow> = {}): CloudRow {
    return {
        user_id: USER, tmdb_id, stream_id, media_type: 'movie', provider_hash: HASH,
        added_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', ...extra,
    };
}

const cloudShort = () =>
    cloud.map(({ tmdb_id, stream_id, media_type }) => ({ tmdb_id, stream_id, media_type }))
        .sort((a, b) => a.tmdb_id - b.tmdb_id || a.stream_id - b.stream_id);

function emptyResult(): SyncResult {
    return {
        preferences: { pulled: 0, pushed: 0 },
        watchlist: { pulled: 0, pushed: 0 },
        playback: { pulled: 0, pushed: 0 },
        liveTv: { pulled: 0, pushed: 0 },
        hiddenCategories: { pulled: 0, pushed: 0 },
        errors: [],
        cloudWatchlistItems: [],
    };
}

/** Laisse finir les suppressions « fire-and-forget » */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function useLocal(rows: Partial<FakeWatchlistRow>[]) {
    local = createFakeWatchlistDb(rows);
}

beforeEach(() => {
    cloud = [];
    calls = [];
    updateError = null;
    insertError = null;
    deleteIgnored = false;
    networkDown = false;
    meta = new Map();
    useLocal([]);
    setCurrentSyncUserId(USER);
});

// ============================================================================
// SYNCHRO À LA CONNEXION
// ============================================================================

describe('syncWatchlist', () => {
    it('does not add a title a second time when it is already local under another number', async () => {
        useLocal([{ stream_id: 200, tmdb_id: 1, type: 'movie' }]); // renuméroté ici
        cloud = [cloudRow(1, 100)]; // ancien numéro resté dans le cloud

        await syncWatchlist(USER, emptyResult());
        await flush();

        expect(local.snapshot()).toEqual([{ stream_id: 200, tmdb_id: 1, type: 'movie' }]);
        expect(cloudShort()).toEqual([{ tmdb_id: 1, stream_id: 200, media_type: 'movie' }]);
    });

    it('still brings down a cloud title when the local copy is stuck on a provisional number', async () => {
        useLocal([{ stream_id: -1, tmdb_id: 1, type: 'movie' }]);
        cloud = [cloudRow(1, 100)];

        await syncWatchlist(USER, emptyResult());
        await flush();

        expect(local.snapshot()).toEqual([
            { stream_id: -1, tmdb_id: 1, type: 'movie' },
            { stream_id: 100, tmdb_id: 1, type: 'movie' },
        ]);
        expect(cloudShort()).toEqual([{ tmdb_id: 1, stream_id: 100, media_type: 'movie' }]);
    });

    it('never sends a number of zero or below to the cloud', async () => {
        useLocal([{ stream_id: -1, tmdb_id: 1, type: 'movie' }, { stream_id: 300, tmdb_id: 3, type: 'movie' }]);

        await syncWatchlist(USER, emptyResult());

        expect(cloudShort()).toEqual([{ tmdb_id: 3, stream_id: 300, media_type: 'movie' }]);
    });

    it('keeps both titles in the cloud when an earlier push was interrupted (A 100 → 200, B 200 → 300)', async () => {
        useLocal([{ stream_id: 200, tmdb_id: 1, type: 'movie' }, { stream_id: 300, tmdb_id: 2, type: 'movie' }]);
        cloud = [cloudRow(1, 100), cloudRow(2, 200)]; // l'envoi des numéros re-liés n'a pas abouti

        await syncWatchlist(USER, emptyResult());
        await flush();

        expect(cloudShort()).toEqual([
            { tmdb_id: 1, stream_id: 200, media_type: 'movie' },
            { tmdb_id: 2, stream_id: 300, media_type: 'movie' },
        ]);
        expect(local.snapshot()).toEqual([
            { stream_id: 200, tmdb_id: 1, type: 'movie' },
            { stream_id: 300, tmdb_id: 2, type: 'movie' },
        ]);
    });

    it('keeps both titles in the cloud when another device has not re-linked yet', async () => {
        useLocal([{ stream_id: 100, tmdb_id: 1, type: 'movie' }, { stream_id: 200, tmdb_id: 2, type: 'movie' }]);
        cloud = [cloudRow(1, 200), cloudRow(2, 300)]; // re-liés et envoyés par la TV

        await syncWatchlist(USER, emptyResult());
        await flush();

        // Le cloud suit cet appareil ; sa re-liaison le remettra aux bons numéros
        expect(cloudShort()).toEqual([
            { tmdb_id: 1, stream_id: 100, media_type: 'movie' },
            { tmdb_id: 2, stream_id: 200, media_type: 'movie' },
        ]);
        expect(local.rows).toHaveLength(2);
    });

    it('never overwrites another cloud title with a local title that sits on its number', async () => {
        useLocal([{ stream_id: 200, tmdb_id: 1, type: 'movie' }]);
        cloud = [cloudRow(3, 200)]; // un autre titre, venu d'un autre appareil
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        await syncWatchlist(USER, emptyResult());
        await flush();

        expect(cloudShort()).toEqual([{ tmdb_id: 3, stream_id: 200, media_type: 'movie' }]);
        expect(local.snapshot()).toEqual([{ stream_id: 200, tmdb_id: 1, type: 'movie' }]);
        warn.mockRestore();
    });

    it('sends a local title missing from the cloud', async () => {
        useLocal([{ stream_id: 200, tmdb_id: 1, type: 'movie' }]);

        const result = emptyResult();
        await syncWatchlist(USER, result);

        expect(cloudShort()).toEqual([{ tmdb_id: 1, stream_id: 200, media_type: 'movie' }]);
        expect(result.watchlist.pushed).toBe(1);
    });

    it('removes a cloud duplicate without touching a series that shares its number', async () => {
        cloud = [
            cloudRow(1, 100, { updated_at: '2026-01-01T00:00:00Z' }),
            cloudRow(1, 150, { updated_at: '2026-02-01T00:00:00Z' }),
            cloudRow(9, 100, { media_type: 'series' }),
        ];

        await syncWatchlist(USER, emptyResult());
        await flush();

        expect(cloudShort()).toEqual([
            { tmdb_id: 1, stream_id: 150, media_type: 'movie' },
            { tmdb_id: 9, stream_id: 100, media_type: 'series' },
        ]);
        expect(local.snapshot()).toEqual([
            { stream_id: 150, tmdb_id: 1, type: 'movie' },
            { stream_id: 100, tmdb_id: 9, type: 'series' },
        ]);
    });

    it('notes titles received from another provider, so they are not shown as the title at their number', async () => {
        meta.set('lastProvider', HASH);
        cloud = [
            cloudRow(0, 100, { provider_hash: 'hash-ancien' }), // sans TMDB, ajouté ailleurs chez un autre fournisseur
            cloudRow(0, 200), // sans TMDB, fournisseur actuel
            cloudRow(3, 300, { provider_hash: null }), // fournisseur inconnu
        ];

        await syncWatchlist(USER, emptyResult());

        expect(JSON.parse(meta.get('watchlist_row_origins') ?? '{}')).toEqual({ '100:movie': 'hash-ancien' });
    });
});

// ============================================================================
// ENVOI DES NUMÉROS RE-LIÉS
// ============================================================================

describe('pushWatchlistUpdates', () => {
    const relinked = (tmdb_id: number, stream_id: number) =>
        ({ tmdb_id, media_type: 'movie' as const, stream_id, provider_hash: HASH });

    it('moves both titles when one takes the number the other leaves (A 100 → 200, B 200 → 300)', async () => {
        cloud = [cloudRow(1, 100), cloudRow(2, 200)];

        await pushWatchlistUpdates([relinked(1, 200), relinked(2, 300)]);

        expect(cloudShort()).toEqual([
            { tmdb_id: 1, stream_id: 200, media_type: 'movie' },
            { tmdb_id: 2, stream_id: 300, media_type: 'movie' },
        ]);
    });

    it('moves both titles when they exchange their numbers, keeping the date they were added', async () => {
        cloud = [cloudRow(1, 100, { added_at: '2025-05-05T00:00:00Z' }), cloudRow(2, 200)];

        await pushWatchlistUpdates([relinked(1, 200), relinked(2, 100)]);

        expect(cloudShort()).toEqual([
            { tmdb_id: 1, stream_id: 200, media_type: 'movie' },
            { tmdb_id: 2, stream_id: 100, media_type: 'movie' },
        ]);
        expect(cloud.find((row) => row.tmdb_id === 1)?.added_at).toBe('2025-05-05T00:00:00Z');
    });

    it('keeps the cloud row of a title outside the batch, even when it holds the wanted number', async () => {
        cloud = [cloudRow(1, 100), cloudRow(3, 200)]; // 3 : titre d'un autre appareil, hors du lot
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        await pushWatchlistUpdates([relinked(1, 200)]);

        expect(cloudShort()).toEqual([
            { tmdb_id: 1, stream_id: 100, media_type: 'movie' },
            { tmdb_id: 3, stream_id: 200, media_type: 'movie' },
        ]);
        warn.mockRestore();
    });

    it('adds a re-linked title that is missing from the cloud', async () => {
        cloud = [cloudRow(2, 300)];

        await pushWatchlistUpdates([relinked(1, 200)]);

        expect(cloudShort()).toEqual([
            { tmdb_id: 1, stream_id: 200, media_type: 'movie' },
            { tmdb_id: 2, stream_id: 300, media_type: 'movie' },
        ]);
    });

    it('merges a title stored twice in the cloud into one row at the right number', async () => {
        cloud = [cloudRow(1, 100), cloudRow(1, 150)];

        await pushWatchlistUpdates([relinked(1, 200)]);

        expect(cloudShort()).toEqual([{ tmdb_id: 1, stream_id: 200, media_type: 'movie' }]);
    });

    it('drops the extra row of a title already present at the right number', async () => {
        cloud = [cloudRow(1, 100), cloudRow(1, 200)];

        await pushWatchlistUpdates([relinked(1, 200)]);

        expect(cloudShort()).toEqual([{ tmdb_id: 1, stream_id: 200, media_type: 'movie' }]);
    });

    it('handles a three-way rotation (A → B → C → A)', async () => {
        cloud = [cloudRow(1, 100), cloudRow(2, 200), cloudRow(3, 300)];

        await pushWatchlistUpdates([relinked(1, 200), relinked(2, 300), relinked(3, 100)]);

        expect(cloudShort()).toEqual([
            { tmdb_id: 1, stream_id: 200, media_type: 'movie' },
            { tmdb_id: 2, stream_id: 300, media_type: 'movie' },
            { tmdb_id: 3, stream_id: 100, media_type: 'movie' },
        ]);
    });

    it('never lifts a title when the chain of taken numbers leaves the batch', async () => {
        // E (hors du lot) garde 400 : B ne peut pas bouger, donc A ne doit pas être retiré
        cloud = [cloudRow(1, 100), cloudRow(2, 200), cloudRow(4, 300), cloudRow(5, 400)];
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        await pushWatchlistUpdates([relinked(1, 200), relinked(2, 400), relinked(4, 100)]);

        const titles = cloud.map((row) => row.tmdb_id).sort();
        expect(titles).toEqual([1, 2, 4, 5]);
        warn.mockRestore();
    });

    it('stops when the cloud silently refuses to remove a duplicate', async () => {
        cloud = [cloudRow(1, 100), cloudRow(1, 200)];
        deleteIgnored = true;
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        await pushWatchlistUpdates([relinked(1, 200)]);

        expect(calls.length).toBeLessThan(50);
        expect(cloudShort()).toEqual([
            { tmdb_id: 1, stream_id: 100, media_type: 'movie' },
            { tmdb_id: 1, stream_id: 200, media_type: 'movie' },
        ]);
        warn.mockRestore();
    });

    it('never sends a number of zero or below', async () => {
        cloud = [cloudRow(1, 100)];

        await pushWatchlistUpdates([relinked(1, 0), relinked(1, -4)]);

        expect(calls).toEqual([]);
        expect(cloudShort()).toEqual([{ tmdb_id: 1, stream_id: 100, media_type: 'movie' }]);
    });

    it('removes nothing from the cloud when the network fails', async () => {
        cloud = [cloudRow(1, 100), cloudRow(2, 200)];
        updateError = { message: 'Failed to fetch' };
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        await pushWatchlistUpdates([relinked(1, 200), relinked(2, 100)]);

        expect(calls.filter((c) => c.op === 'delete')).toEqual([]);
        expect(cloudShort()).toEqual([
            { tmdb_id: 1, stream_id: 100, media_type: 'movie' },
            { tmdb_id: 2, stream_id: 200, media_type: 'movie' },
        ]);
        warn.mockRestore();
    });

    it('sends nothing when another account signed in after Ma liste was read', async () => {
        cloud = [cloudRow(1, 100)];
        setCurrentSyncUserId('autre-compte');

        await pushWatchlistUpdates([relinked(1, 200), relinked(7, 700)], USER);

        expect(calls).toEqual([]);
    });

    it('writes nothing once the signed-in account is no longer the one being placed', async () => {
        cloud = [cloudRow(1, 100)];
        setCurrentSyncUserId('autre-compte');
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        await placeWatchlistTitles(USER, [relinked(1, 200)]);

        expect(calls).toEqual([]);
        warn.mockRestore();
    });

    it('sends nothing when nobody is signed in', async () => {
        setCurrentSyncUserId(null);
        cloud = [cloudRow(1, 100)];

        await pushWatchlistUpdates([relinked(1, 200)]);

        expect(calls).toEqual([]);
    });
});

// ============================================================================
// PLUSIEURS APPAREILS, MÊME COMPTE
// ============================================================================

describe('Ma liste sur plusieurs appareils (dernier accord)', () => {
    /** Un appareil : sa base locale (Ma liste + table meta) ; le cloud est commun */
    function device(rows: Partial<FakeWatchlistRow>[] = []) {
        return { db: createFakeWatchlistDb(rows), meta: new Map<string, string>() };
    }
    type Device = ReturnType<typeof device>;
    /** Passe sur cet appareil : tout ce qui suit lit et écrit sa base */
    function on(d: Device) {
        local = d.db;
        meta = d.meta;
    }
    async function syncOn(d: Device) {
        on(d);
        await syncWatchlist(USER, emptyResult());
        await flush();
    }
    const titles = (d: Device) => d.db.snapshot().map((row) => row.tmdb_id);

    it('a title removed on the PC is not brought back by the TV, which then removes it too', async () => {
        const pc = device([{ stream_id: 100, tmdb_id: 1, type: 'movie' }, { stream_id: 200, tmdb_id: 2, type: 'movie' }]);
        const tv = device();
        await syncOn(pc); // le PC envoie ses deux titres
        await syncOn(tv); // la TV les reçoit
        expect(titles(tv)).toEqual([1, 2]);

        // Retrait sur le PC : en local, puis dans le cloud
        on(pc);
        pc.db.rows.splice(pc.db.rows.findIndex((row) => row.tmdb_id === 1), 1);
        pushWatchlistDeleteToCloud(100, 'movie', 1);
        await flush();
        expect(cloudShort().map((row) => row.tmdb_id)).toEqual([2]);

        // Avant : la TV, qui l'avait encore, le renvoyait au cloud et il revenait partout
        await syncOn(tv);
        expect(titles(tv)).toEqual([2]);
        expect(cloudShort().map((row) => row.tmdb_id)).toEqual([2]);
        await syncOn(pc);
        expect(titles(pc)).toEqual([2]);
    });

    it('a removal made offline reaches the cloud at the next sync', async () => {
        const tv = device([{ stream_id: 100, tmdb_id: 1, type: 'movie' }]);
        await syncOn(tv);
        expect(cloudShort()).toHaveLength(1);

        // Retrait hors ligne : l'envoi échoue
        networkDown = true;
        tv.db.rows.splice(0, 1);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        pushWatchlistDeleteToCloud(100, 'movie', 1);
        await flush();
        warn.mockRestore();
        expect(cloudShort()).toHaveLength(1);

        // Réseau revenu : la synchro retire le titre du cloud au lieu de le recopier ici
        networkDown = false;
        await syncOn(tv);
        expect(titles(tv)).toEqual([]);
        expect(cloudShort()).toEqual([]);
    });

    it('an add made offline reaches the cloud at the next sync, and a removal elsewhere still wins after', async () => {
        const tv = device();
        const pc = device();
        await syncOn(tv);

        networkDown = true;
        on(tv);
        tv.db.rows.push({ stream_id: 100, tmdb_id: 1, type: 'movie', added_at: 1, updated_at: 1 });
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        pushWatchlistUpsertToCloud(100, 1, 'movie');
        await flush();
        warn.mockRestore();
        expect(cloudShort()).toEqual([]);

        networkDown = false;
        await syncOn(tv);
        expect(cloudShort().map((row) => row.tmdb_id)).toEqual([1]);

        await syncOn(pc);
        on(pc);
        pc.db.rows.splice(0, 1);
        pushWatchlistDeleteToCloud(100, 'movie', 1);
        await flush();
        await syncOn(tv);
        expect(titles(tv)).toEqual([]);
    });

    it('a title added on another device is copied here, not taken for a removal', async () => {
        const tv = device([{ stream_id: 100, tmdb_id: 1, type: 'movie' }]);
        await syncOn(tv);
        cloud.push(cloudRow(2, 200)); // ajouté sur le PC

        await syncOn(tv);
        expect(titles(tv)).toEqual([1, 2]);
    });

    it('never removes anything at the first sync after the update (no last agreement yet)', async () => {
        const tv = device([{ stream_id: 100, tmdb_id: 1, type: 'movie' }]);
        cloud = [cloudRow(2, 200)];

        await syncOn(tv);

        expect(titles(tv)).toEqual([1, 2]);
        expect(cloudShort().map((row) => row.tmdb_id)).toEqual([1, 2]);
    });

    it('never empties the cloud when the local list was wiped (new login, reinstall)', async () => {
        const tv = device([1, 2, 3, 4, 5].map((n) => ({ stream_id: n * 100, tmdb_id: n, type: 'movie' as const })));
        await syncOn(tv);
        tv.db.rows.splice(0); // vidée sans passer par clearAllData (qui oublie aussi le dernier accord)
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        await syncOn(tv);
        warn.mockRestore();

        expect(cloudShort()).toHaveLength(5);
        expect(titles(tv)).toEqual([1, 2, 3, 4, 5]);
    });

    it('removes by title a title stuck on a provisional number', async () => {
        cloud = [cloudRow(1, 100)];

        pushWatchlistDeleteToCloud(-2, 'movie', 1);
        await flush();

        expect(cloudShort()).toEqual([]);
    });

    it('removes every cloud row of the title, including a duplicate from an older provider', async () => {
        cloud = [cloudRow(1, 100), cloudRow(1, 555, { provider_hash: 'ancien' })];

        pushWatchlistDeleteToCloud(100, 'movie', 1);
        await flush();

        expect(cloudShort()).toEqual([]);
    });

    it('an exchange of numbers interrupted after the provisional removal never loses the title', async () => {
        // A (1) à 100 et B (2) à 200, connus des deux côtés
        const tv = device([{ stream_id: 100, tmdb_id: 1, type: 'movie' }, { stream_id: 200, tmdb_id: 2, type: 'movie' }]);
        await syncOn(tv);
        expect(cloudShort().map((row) => row.stream_id)).toEqual([100, 200]);

        // Le fournisseur échange leurs numéros : la re-liaison locale met A à 200 et B à 100
        tv.db.rows.find((row) => row.tmdb_id === 1)!.stream_id = 200;
        tv.db.rows.find((row) => row.tmdb_id === 2)!.stream_id = 100;

        // Envoi des nouveaux numéros : A est retiré provisoirement du cloud, puis le réseau coupe
        // avant qu'il y revienne
        insertError = { message: 'TypeError: Failed to fetch' };
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        await pushWatchlistUpdates([
            { tmdb_id: 1, media_type: 'movie', stream_id: 200, provider_hash: HASH },
            { tmdb_id: 2, media_type: 'movie', stream_id: 100, provider_hash: HASH },
        ]);
        await flush();
        expect(cloudShort().map((row) => row.tmdb_id)).toEqual([2]); // A n'est plus dans le cloud

        // Réseau revenu : la synchro suivante le remet dans le cloud au lieu de le prendre pour un
        // retrait fait ailleurs (avant : A disparaissait ici et partout)
        insertError = null;
        await syncOn(tv);
        warn.mockRestore();
        expect(titles(tv).sort()).toEqual([1, 2]);
        expect(cloudShort()).toEqual([
            { tmdb_id: 1, stream_id: 200, media_type: 'movie' },
            { tmdb_id: 2, stream_id: 100, media_type: 'movie' },
        ]);

        // Le dernier accord est rétabli : un retrait fait ensuite sur un autre appareil s'applique ici
        cloud = cloud.filter((row) => row.tmdb_id !== 1);
        await syncOn(tv);
        expect(titles(tv)).toEqual([2]);
    });

    it('an exchange interrupted during the sync itself never loses the title, and the sync still records the rest', async () => {
        const tv = device([{ stream_id: 100, tmdb_id: 1, type: 'movie' }, { stream_id: 200, tmdb_id: 2, type: 'movie' }]);
        await syncOn(tv);

        // Numéros échangés en local ; la synchro dénoue l'échange dans le cloud et le réseau coupe
        tv.db.rows.find((row) => row.tmdb_id === 1)!.stream_id = 200;
        tv.db.rows.find((row) => row.tmdb_id === 2)!.stream_id = 100;
        insertError = { message: 'TypeError: Failed to fetch' };
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        await syncOn(tv);
        expect(cloudShort().map((row) => row.tmdb_id)).toEqual([2]);

        // B, toujours dans le dernier accord, est ensuite retiré sur un autre appareil ; réseau revenu
        insertError = null;
        cloud = cloud.filter((row) => row.tmdb_id !== 2);
        await syncOn(tv);
        warn.mockRestore();

        expect(titles(tv)).toEqual([1]); // A gardé et renvoyé, B retiré comme ailleurs
        expect(cloudShort()).toEqual([{ tmdb_id: 1, stream_id: 200, media_type: 'movie' }]);
    });

    // Ajouter un titre dont le numéro est occupé par un autre
    // titre de Ma liste (typiquement un titre « Introuvable » de l'ancien fournisseur) ne remplace
    // plus sa ligne : ce titre passe sur un numéro provisoire négatif, reste ici, et la synchro ne le
    // prend pas pour un retrait (il reste dans le cloud et sur les autres appareils).
    it('adding a title never removes another title that held its number, here or elsewhere', async () => {
        const tv = device([{ stream_id: 100, tmdb_id: 1, type: 'movie' }]);
        const pc = device();
        await syncOn(tv);
        await syncOn(pc);
        expect(titles(pc)).toEqual([1]);

        // Sur la TV, ajout depuis sa fiche du film 2, que le fournisseur range au numéro 100
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        on(tv);
        await toggleWatchlist(100, 2, 'movie');
        await flush();
        await syncOn(tv);
        await syncOn(pc);
        warn.mockRestore();

        expect(tv.db.snapshot()).toEqual([
            { stream_id: -1, tmdb_id: 1, type: 'movie' },
            { stream_id: 100, tmdb_id: 2, type: 'movie' },
        ]);
        expect(cloudShort().map((row) => row.tmdb_id)).toContain(1);
        expect(titles(pc)).toContain(1);
        // Limite connue : le cloud garde le numéro 100 au film 1, le film 2 reste ici
        expect(cloudShort()).toEqual([{ tmdb_id: 1, stream_id: 100, media_type: 'movie' }]);

        // Le film 2 retiré ensuite : le film 1 revient aussi du cloud à son numéro 100 (comme après une
        // re-liaison interrompue) ; la re-liaison suivante garde une seule des deux lignes, et Ma liste
        // n'en montre qu'une en attendant (getHydratedWatchlist)
        on(tv);
        await toggleWatchlist(100, 2, 'movie');
        await flush();
        await syncOn(tv);
        expect(titles(tv)).toEqual([1, 1]);
        expect(cloudShort()).toEqual([{ tmdb_id: 1, stream_id: 100, media_type: 'movie' }]);
    });

    it('adding a title still replaces a row without TMDB on its number (that row only meant « the title at this number »)', async () => {
        const tv = device([{ stream_id: 100, tmdb_id: 0, type: 'movie' }]);
        await syncOn(tv);

        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        on(tv);
        await toggleWatchlist(100, 2, 'movie');
        await flush();
        await syncOn(tv);
        warn.mockRestore();

        expect(tv.db.snapshot()).toEqual([{ stream_id: 100, tmdb_id: 2, type: 'movie' }]);
        expect(cloudShort()).toEqual([{ tmdb_id: 2, stream_id: 100, media_type: 'movie' }]);
    });

    it('a re-link never removes an « Introuvable » title, here or elsewhere', async () => {
        const rows = [{ stream_id: 100, tmdb_id: 1, type: 'movie' as const }, { stream_id: 555, tmdb_id: 2, type: 'movie' as const }];
        const tv = device(rows);
        const pc = device(rows);
        await syncOn(tv);
        await syncOn(pc);

        // Sur la TV, le catalogue n'a plus le film 1 et donne le numéro 100 au film 2
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        on(tv);
        const indexes = {
            movies: new Map(), series: new Map(), live: new Map(), categories: new Map(),
            moviesByTmdb: new Map([[2, { id: 100 }]]), seriesByTmdb: new Map(), iconPrefixes: [],
        } as unknown as LightIndexes;
        const result = await relinkWatchlistStreamIds(indexes, HASH, [], { notify: false });
        await pushWatchlistUpdates(result.relinkedItems);
        await flush();
        await syncOn(tv);
        await syncOn(pc);
        warn.mockRestore();

        expect(tv.db.snapshot()).toEqual([
            { stream_id: -1, tmdb_id: 1, type: 'movie' },
            { stream_id: 100, tmdb_id: 2, type: 'movie' },
        ]);
        expect(titles(pc)).toEqual([1, 2]);
        // Limite connue : le cloud garde le numéro 100 au film 1, le film 2 y reste à 555
        expect(cloudShort()).toEqual([
            { tmdb_id: 1, stream_id: 100, media_type: 'movie' },
            { tmdb_id: 2, stream_id: 555, media_type: 'movie' },
        ]);
    });

    it('writes nothing here when another account took over the local database meanwhile', async () => {
        const tv = device([{ stream_id: 100, tmdb_id: 1, type: 'movie' }]);
        await syncOn(tv);
        cloud = [];
        calls = [];
        vi.mocked(isDatabaseOf).mockReturnValue(false);
        try {
            await syncOn(tv);
        } finally {
            vi.mocked(isDatabaseOf).mockReturnValue(true);
        }
        expect(titles(tv)).toEqual([1]);
        expect(calls.filter((call) => call.op !== 'select')).toHaveLength(0);
    });
});
