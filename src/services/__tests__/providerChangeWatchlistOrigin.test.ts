/**
 * Changement de fournisseur : Ma liste est gardée, et chaque titre sans origine notée est noté comme
 * venant du fournisseur précédent, pour ne jamais afficher à sa place le titre qui
 * a repris son numéro chez le nouveau fournisseur.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

let meta = new Map<string, string>();
let previousHost: string | null = 'hash-ancien';
const watchlistRows = [
    { stream_id: 100, type: 'movie' },
    { stream_id: 200, type: 'series' },
];
const executed: string[] = [];

vi.mock('../dbCore', () => ({
    getDatabase: vi.fn(async () => ({
        select: vi.fn(async (sql: string) => (sql.includes('FROM watchlist') ? watchlistRows : [])),
        execute: vi.fn(async (sql: string) => { executed.push(sql); return { rowsAffected: 0 }; }),
    })),
    getMeta: vi.fn(async (key: string) => meta.get(key) ?? null),
    setMeta: vi.fn(async (key: string, value: string) => { meta.set(key, value); }),
    refreshConnection: vi.fn(),
    getDatabaseFileName: vi.fn(() => 'nyxplayer_test.db'),
    isDatabaseOf: vi.fn(() => true),
}));
vi.mock('../preferencesService', () => ({
    initPreferences: vi.fn(),
    getLanguage: vi.fn(() => 'fr'),
    computeProviderHash: vi.fn(async (host: string) => host), // empreinte = adresse, pour lire les tests
    getLastProviderHash: () => 'hash-nouveau', // préférence déjà synchronisée depuis un autre appareil
}));
vi.mock('../syncService', () => ({
    getCurrentSyncUserId: vi.fn(() => null),
    fetchCloudProviderHash: vi.fn(),
    pushWatchlistUpdates: vi.fn(),
    purgeProviderCloudData: vi.fn(),
}));
vi.mock('../liveTvBookmarksService', () => ({ initLiveTvBookmarks: vi.fn(), resetLiveTvBookmarksCache: vi.fn() }));
vi.mock('../hiddenCategoriesService', () => ({ initHiddenCategories: vi.fn(), resetHiddenCategories: vi.fn() }));
vi.mock('../sync/syncBaseline', () => ({ clearBaselines: vi.fn() }));
vi.mock('../supabaseClient', () => ({ supabase: {} }));
vi.mock('../xtreamApi', () => ({ XtreamApiService: vi.fn() }));
vi.mock('../catalogIngestion', () => ({ ingestCatalog: vi.fn() }));
vi.mock('../catalogLight', () => ({ loadLightIndexes: vi.fn() }));
vi.mock('../searchIndex', () => ({ rebuildSearchIndex: vi.fn() }));
vi.mock('../piconCache', () => ({ initPiconCache: vi.fn() }));
vi.mock('../watchlistRelinking', () => ({ relinkWatchlistStreamIds: vi.fn() }));
vi.mock('../catalogAutoRefresh', () => ({ startCatalogAutoRefresh: vi.fn() }));
vi.mock('../catalogSwapGate', () => ({ readChangesSeq: vi.fn() }));
vi.mock('../../utils/devLog', () => ({ devLog: vi.fn() }));

import { wipeProviderSpecificData } from '../sessionSteps';
import { getCurrentSyncUserId } from '../syncService';
import { clearBaselines } from '../sync/syncBaseline';
import { foreignWatchlistRows, readWatchlistOrigins, updateWatchlistOrigins } from '../watchlistAvailability';

const origins = () => JSON.parse(meta.get('watchlist_row_origins') ?? '{}');

beforeEach(() => {
    meta = new Map();
    previousHost = 'hash-ancien';
    meta.set('lastProvider', previousHost);
    executed.length = 0;
});

describe('wipeProviderSpecificData and Ma liste', () => {
    it('keeps Ma liste and notes its titles as coming from this device\'s previous provider', async () => {
        await wipeProviderSpecificData();
        expect(executed.some((sql) => sql.includes('watchlist'))).toBe(false);
        expect(origins()).toEqual({ '100:movie': 'hash-ancien', '200:series': 'hash-ancien' });
    });

    it('keeps an origin already noted (title received from a third provider)', async () => {
        meta.set('watchlist_row_origins', JSON.stringify({ '100:movie': 'hash-autre' }));
        await wipeProviderSpecificData();
        expect(origins()).toEqual({ '100:movie': 'hash-autre', '200:series': 'hash-ancien' });
    });

    it('notes an unknown previous provider when none was recorded', async () => {
        meta.delete('lastProvider');
        await wipeProviderSpecificData();
        expect(origins()['100:movie']).toBe('fournisseur-precedent');
    });

    it('makes titles normal again after going back to the previous provider (A → B → A)', async () => {
        await wipeProviderSpecificData(); // A → B : lignes notées A
        await updateWatchlistOrigins([['300:movie', null]]); // ajout sous B (hors de la table ici : oublié)
        meta.set('lastProvider', 'hash-b');
        await wipeProviderSpecificData(); // B → A : origines déjà notées gardées
        const origins = await readWatchlistOrigins();
        expect(foreignWatchlistRows(origins, 'hash-ancien').size).toBe(0);
        expect(foreignWatchlistRows(origins, 'hash-b')).toEqual(new Set(['100:movie', '200:series']));
    });
});

describe('wipeProviderSpecificData and the last agreement with the cloud', () => {
    it('forgets the last agreement of every list it empties, so even 1 to 3 items are never removed from the cloud', async () => {
        vi.mocked(getCurrentSyncUserId).mockReturnValue('user-test');
        vi.mocked(clearBaselines).mockClear();

        await wipeProviderSpecificData();

        // Tables vidées : reprises, favoris et épinglées de la TV en direct, catégories masquées
        for (const table of ['playback_progress', 'live_tv_favorites', 'live_tv_pinned_categories', 'hidden_categories']) {
            expect(executed).toContain(`DELETE FROM ${table}`);
        }
        expect(clearBaselines).toHaveBeenCalledWith('user-test', ['playback', 'playback_v2', 'livetv', 'livetv_v2', 'hidden', 'hidden_v2']);
        vi.mocked(getCurrentSyncUserId).mockReturnValue(null);
    });
});
