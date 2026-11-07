/**
 * Ma liste après un changement de fournisseur : un titre dont le numéro de source
 * ne mène plus à lui est marqué « introuvable », sans prendre le nom ni l'affiche du titre qui a
 * repris son numéro (watchlistAvailability.ts, getHydratedWatchlist).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LightIndexes, LightMovie, LightSeries } from '../../types/lightIndex';

// ============================================================================
// MOCKS
// ============================================================================

interface JoinRow {
    stream_id: number;
    tmdb_id: number;
    type: 'movie' | 'series';
    added_at: number;
    display_name: string | null;
    poster_path: string | null;
}

let meta = new Map<string, string>();
let joinRows: JoinRow[] = [];
/** Lignes de la table watchlist (clés) quand on ne passe pas par la jointure */
let present: { stream_id: number; type: 'movie' | 'series' }[] = [];

vi.mock('../dbCore', () => ({
    getDatabase: vi.fn(async () => ({
        select: vi.fn(async (sql: string) => (sql.includes('JOIN')
            ? joinRows.map((row) => ({ ...row }))
            : (present.length > 0 ? present : joinRows).map(({ stream_id, type }) => ({ stream_id, type })))),
        execute: vi.fn(async () => ({ rowsAffected: 0 })),
    })),
    getDatabaseFileName: vi.fn(() => 'nyxplayer_test.db'),
    isDatabaseOf: vi.fn((uid: string) => uid === 'compte-ouvert'),
    getMeta: vi.fn(async (key: string) => meta.get(key) ?? null),
    setMeta: vi.fn(async (key: string, value: string) => { meta.set(key, value); }),
}));

// Empreinte = adresse, pour lire les tests ; le fournisseur de l'appareil est `meta.lastProvider`
vi.mock('../preferencesService', () => ({
    computeProviderHash: async (host: string) => host,
    getLastProviderHash: () => 'préférence-synchronisée-autre-appareil',
}));

vi.mock('../syncService', () => ({
    pushWatchlistUpsertToCloud: vi.fn(),
    pushWatchlistDeleteToCloud: vi.fn(),
}));

vi.mock('../tmdbApi', () => ({
    default: { imageUrl: (path: string) => `https://image.tmdb.org/t/p/w342${path}` },
}));

vi.mock('../watchlistDetailsFill', () => ({
    requestMissingWatchlistDetails: vi.fn(),
}));

// ============================================================================
// IMPORT AFTER MOCKS
// ============================================================================

import {
    catalogItemMatchesRow,
    foreignWatchlistRows,
    isWatchlistRowAvailable,
    readWatchlistOrigins,
    updateWatchlistOrigins,
    watchlistRowKey,
} from '../watchlistAvailability';
import { markStaleTitleLink } from '../../utils/lightIndexHelpers';
import { getHydratedWatchlist } from '../watchlistHydration';
import { setMeta } from '../dbCore';
import { requestMissingWatchlistDetails } from '../watchlistDetailsFill';

// ============================================================================
// HELPERS
// ============================================================================

function movie(id: number, tmdbId: number, name = `Film ${id}`): LightMovie {
    return { id, name, iconPrefixId: 0, iconSuffix: `${id}.jpg`, tmdbId, categoryId: '1', added: 0, containerExt: 'mkv' };
}

function series(id: number, tmdbId: number, name = `Série ${id}`): LightSeries {
    return { id, name, iconPrefixId: 0, iconSuffix: `${id}.jpg`, tmdbId, categoryId: '1', added: 0 } as LightSeries;
}

function catalog(movies: LightMovie[], seriesList: LightSeries[] = []): LightIndexes {
    return {
        movies: new Map(movies.map((m) => [m.id, m])),
        series: new Map(seriesList.map((s) => [s.id, s])),
        live: new Map(),
        categories: new Map(),
        moviesByTmdb: new Map(movies.filter((m) => m.tmdbId > 0).map((m) => [m.tmdbId, m])),
        seriesByTmdb: new Map(seriesList.filter((s) => s.tmdbId > 0).map((s) => [s.tmdbId, s])),
        iconPrefixes: ['http://fournisseur.test/images/'],
    };
}

const NONE = new Set<string>();

beforeEach(() => {
    meta = new Map();
    joinRows = [];
    present = [];
    meta.set('lastProvider', 'hash-actuel');
    vi.mocked(setMeta).mockClear();
    vi.mocked(requestMissingWatchlistDetails).mockClear();
});

// ============================================================================
// DISPONIBILITÉ D'UNE LIGNE
// ============================================================================

describe('isWatchlistRowAvailable', () => {
    it('is available when the catalog has the TMDB title, even under another number', () => {
        const indexes = catalog([movie(500, 42)]);
        expect(isWatchlistRowAvailable({ stream_id: 100, tmdb_id: 42, type: 'movie' }, indexes, NONE)).toBe(true);
    });

    it('is not available when its number now belongs to another TMDB title', () => {
        const indexes = catalog([movie(100, 99)]);
        expect(isWatchlistRowAvailable({ stream_id: 100, tmdb_id: 42, type: 'movie' }, indexes, NONE)).toBe(false);
    });

    it('is not available when neither its TMDB title nor its number is in the catalog', () => {
        const indexes = catalog([movie(300, 7)]);
        expect(isWatchlistRowAvailable({ stream_id: 100, tmdb_id: 42, type: 'movie' }, indexes, NONE)).toBe(false);
    });

    it('trusts a number of the current provider when the catalog entry has lost its TMDB id', () => {
        const indexes = catalog([movie(100, 0)]);
        expect(isWatchlistRowAvailable({ stream_id: 100, tmdb_id: 42, type: 'movie' }, indexes, NONE)).toBe(true);
    });

    it('does not trust a number from another provider without a matching TMDB id', () => {
        const indexes = catalog([movie(100, 0)]);
        const foreign = new Set([watchlistRowKey(100, 'movie')]);
        expect(isWatchlistRowAvailable({ stream_id: 100, tmdb_id: 42, type: 'movie' }, indexes, foreign)).toBe(false);
        expect(isWatchlistRowAvailable({ stream_id: 100, tmdb_id: 0, type: 'movie' }, indexes, foreign)).toBe(false);
    });

    it('keeps a title without TMDB id of the current provider', () => {
        const indexes = catalog([movie(100, 0)]);
        expect(isWatchlistRowAvailable({ stream_id: 100, tmdb_id: 0, type: 'movie' }, indexes, NONE)).toBe(true);
    });

    it('accepts a foreign number that the same TMDB title still uses', () => {
        const indexes = catalog([movie(100, 42)]);
        const foreign = new Set([watchlistRowKey(100, 'movie')]);
        expect(isWatchlistRowAvailable({ stream_id: 100, tmdb_id: 42, type: 'movie' }, indexes, foreign)).toBe(true);
    });

    it('handles series with their own indexes', () => {
        const indexes = catalog([movie(100, 42)], [series(100, 77)]);
        expect(isWatchlistRowAvailable({ stream_id: 100, tmdb_id: 42, type: 'series' }, indexes, NONE)).toBe(false);
        expect(isWatchlistRowAvailable({ stream_id: 5, tmdb_id: 77, type: 'series' }, indexes, NONE)).toBe(true);
    });

    it('catalogItemMatchesRow refuses an entry whose title link was lost to a name change (number reused by another title)', () => {
        const entry = { id: 1, name: 'Barbie (2023)', tmdbId: 0 } as unknown as LightMovie;
        markStaleTitleLink(entry);
        expect(catalogItemMatchesRow({ stream_id: 1, tmdb_id: 603, type: 'movie' }, entry, NONE)).toBe(false);
        // Ligne sans numéro TMDB : rien à comparer
        expect(catalogItemMatchesRow({ stream_id: 1, tmdb_id: 0, type: 'movie' }, entry, NONE)).toBe(true);
        // Entrée jamais reliée : acceptée comme avant
        expect(catalogItemMatchesRow({ stream_id: 1, tmdb_id: 603, type: 'movie' }, { id: 1, name: 'Dune', tmdbId: 0 } as unknown as LightMovie, NONE)).toBe(true);
    });

    it('catalogItemMatchesRow refuses a missing catalog entry', () => {
        expect(catalogItemMatchesRow({ stream_id: 1, tmdb_id: 0, type: 'movie' }, undefined, NONE)).toBe(false);
    });
});

// ============================================================================
// ORIGINE DES LIGNES
// ============================================================================

describe('watchlist row origins', () => {
    it('lists as foreign only the rows noted with another provider', () => {
        const origins = new Map([['1:movie', 'hash-actuel'], ['2:movie', 'hash-ancien']]);
        expect([...foreignWatchlistRows(origins, 'hash-actuel')]).toEqual(['2:movie']);
        expect(foreignWatchlistRows(origins, null).size).toBe(0);
    });

    it('notes, keeps and forgets origins', async () => {
        present = [1, 2, 3].map((stream_id) => ({ stream_id, type: 'movie' as const }));
        await updateWatchlistOrigins([['1:movie', 'hash-ancien'], ['2:movie', 'hash-ancien']]);
        await updateWatchlistOrigins([['1:movie', 'autre'], ['3:movie', 'hash-ancien']], { onlyMissing: true });
        await updateWatchlistOrigins([['2:movie', null]]);
        expect(Object.fromEntries(await readWatchlistOrigins())).toEqual({ '1:movie': 'hash-ancien', '3:movie': 'hash-ancien' });
    });

    it('forgets the origins of titles no longer in Ma liste', async () => {
        present = [{ stream_id: 1, type: 'movie' }];
        await updateWatchlistOrigins([['1:movie', 'hash-ancien'], ['9:movie', 'hash-ancien']]);
        expect(Object.fromEntries(await readWatchlistOrigins())).toEqual({ '1:movie': 'hash-ancien' });
    });

    it('writes nothing once the open database belongs to another account', async () => {
        present = [{ stream_id: 1, type: 'movie' }];
        await updateWatchlistOrigins([['1:movie', 'hash-ancien']], { accountId: 'compte-precedent' });
        expect(setMeta).not.toHaveBeenCalled();
        await updateWatchlistOrigins([['1:movie', 'hash-ancien']], { accountId: 'compte-ouvert' });
        expect(setMeta).toHaveBeenCalledTimes(1);
    });

    it('does not write when nothing changes', async () => {
        await updateWatchlistOrigins([['1:movie', null]]);
        expect(setMeta).not.toHaveBeenCalled();
    });

    it('survives unreadable stored origins', async () => {
        meta.set('watchlist_row_origins', 'pas du json');
        expect((await readWatchlistOrigins()).size).toBe(0);
    });
});

// ============================================================================
// MA LISTE AFFICHÉE
// ============================================================================

describe('getHydratedWatchlist after a provider change', () => {
    it('marks a title with a TMDB poster as not found when its number is gone', async () => {
        joinRows = [{ stream_id: 100, tmdb_id: 42, type: 'movie', added_at: 1, display_name: 'Le Film', poster_path: '/p.jpg' }];
        const [item] = await getHydratedWatchlist(catalog([movie(300, 7)]));
        expect(item).toMatchObject({ name: 'Le Film', isOrphan: true, posterUrl: 'https://image.tmdb.org/t/p/w342/p.jpg' });
    });

    it('never shows the name of the title that took its number', async () => {
        joinRows = [{ stream_id: 100, tmdb_id: 42, type: 'movie', added_at: 1, display_name: null, poster_path: null }];
        const [item] = await getHydratedWatchlist(catalog([movie(100, 99, 'Autre film')]));
        expect(item.isOrphan).toBe(true);
        expect(item.name).toBe('');
        expect(item.posterUrl).toBe('');
    });

    // Sur un nouvel appareil, la fiche TMDB d'un titre « introuvable » n'est pas en cache
    it('asks TMDB for the details of a not-found title without name or poster', async () => {
        joinRows = [
            { stream_id: 100, tmdb_id: 42, type: 'movie', added_at: 3, display_name: null, poster_path: null },
            { stream_id: 200, tmdb_id: 43, type: 'movie', added_at: 2, display_name: 'Déjà en cache', poster_path: '/c.jpg' },
            { stream_id: 500, tmdb_id: 44, type: 'movie', added_at: 1, display_name: null, poster_path: null },
        ];
        await getHydratedWatchlist(catalog([movie(500, 44, 'Chez le fournisseur')]));
        expect(requestMissingWatchlistDetails).toHaveBeenCalledWith([expect.objectContaining({ tmdb_id: 42, type: 'movie' })]);
    });

    it('marks a title without TMDB id from another provider as not found', async () => {
        meta.set('watchlist_row_origins', JSON.stringify({ '100:movie': 'hash-ancien' }));
        joinRows = [{ stream_id: 100, tmdb_id: 0, type: 'movie', added_at: 1, display_name: null, poster_path: null }];
        const [item] = await getHydratedWatchlist(catalog([movie(100, 0, 'Autre film')]));
        expect(item).toMatchObject({ name: '', isOrphan: true });
    });

    it('judges origins against this device\'s provider, not the synced preference', async () => {
        meta.set('watchlist_row_origins', JSON.stringify({ '100:movie': 'hash-actuel' }));
        joinRows = [{ stream_id: 100, tmdb_id: 0, type: 'movie', added_at: 1, display_name: null, poster_path: null }];
        const [item] = await getHydratedWatchlist(catalog([movie(100, 0, 'Sans TMDB')]));
        expect(item).toMatchObject({ name: 'Sans TMDB', isOrphan: false });
    });

    it('takes the name of a title found under another number from the catalog', async () => {
        joinRows = [{ stream_id: 100, tmdb_id: 42, type: 'movie', added_at: 1, display_name: null, poster_path: null }];
        const [item] = await getHydratedWatchlist(catalog([movie(100, 99, 'Autre film'), movie(500, 42, 'Le Film')]));
        expect(item).toMatchObject({ name: 'Le Film', isOrphan: false });
    });

    it('shows a title found at the current provider normally', async () => {
        joinRows = [
            { stream_id: 500, tmdb_id: 42, type: 'movie', added_at: 2, display_name: null, poster_path: null },
            { stream_id: 100, tmdb_id: 0, type: 'movie', added_at: 1, display_name: null, poster_path: null },
        ];
        const items = await getHydratedWatchlist(catalog([movie(500, 42, 'Le Film'), movie(100, 0, 'Sans TMDB')]));
        expect(items.map(({ name, isOrphan }) => ({ name, isOrphan }))).toEqual([
            { name: 'Le Film', isOrphan: false },
            { name: 'Sans TMDB', isOrphan: false },
        ]);
        expect(items[0].posterUrl).toBe('http://fournisseur.test/images/500.jpg');
    });
});
