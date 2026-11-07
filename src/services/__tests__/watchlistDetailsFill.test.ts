/**
 * Un titre « introuvable » de Ma liste sur un nouvel appareil n'a ni nom ni affiche ; sa fiche
 * est demandée à TMDB par son numéro et rangée dans le cache local (watchlistDetailsFill.ts).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../tmdbApi', () => ({
    default: {
        getMovieDetails: vi.fn(async (id: number) => ({ id, title: `Film ${id}` })),
        getTvDetails: vi.fn(async (id: number) => ({ id, name: `Série ${id}` })),
    },
}));

vi.mock('../tmdbCacheSqlite', () => ({
    cacheMovieDetails: vi.fn(async () => {}),
    cacheSeriesDetails: vi.fn(async () => {}),
}));

let backgroundAllowed = true;
vi.mock('../guestRelay', () => ({ guestRelayAllowsBackground: () => backgroundAllowed }));

let dbFile = 'nyxplayer_a.db';
vi.mock('../dbCore', () => ({
    getDatabaseFileName: vi.fn(() => dbFile),
}));

import tmdb from '../tmdbApi';
import { cacheMovieDetails, cacheSeriesDetails } from '../tmdbCacheSqlite';
import { RETRY_AFTER_MS, requestMissingWatchlistDetails, resetMissingWatchlistDetails } from '../watchlistDetailsFill';

/** Laisse la file de demandes se vider */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
    resetMissingWatchlistDetails();
    vi.clearAllMocks();
    dbFile = 'nyxplayer_a.db';
    backgroundAllowed = true;
});

describe('requestMissingWatchlistDetails', () => {
    it('fetches the TMDB details of a movie and a series and caches them', async () => {
        requestMissingWatchlistDetails([{ tmdb_id: 42, type: 'movie' }, { tmdb_id: 7, type: 'series' }]);
        await flush();
        expect(cacheMovieDetails).toHaveBeenCalledWith(42, { id: 42, title: 'Film 42' });
        expect(cacheSeriesDetails).toHaveBeenCalledWith(7, { id: 7, name: 'Série 7' });
    });

    it('ignores rows without a TMDB id', async () => {
        requestMissingWatchlistDetails([{ tmdb_id: 0, type: 'movie' }]);
        await flush();
        expect(tmdb.getMovieDetails).not.toHaveBeenCalled();
    });

    it('asks only once while the list is read again', async () => {
        requestMissingWatchlistDetails([{ tmdb_id: 42, type: 'movie' }], 1000);
        requestMissingWatchlistDetails([{ tmdb_id: 42, type: 'movie' }], 2000);
        await flush();
        expect(tmdb.getMovieDetails).toHaveBeenCalledTimes(1);
    });

    it('retries a failed request only after the delay', async () => {
        vi.mocked(tmdb.getMovieDetails).mockRejectedValueOnce(new Error('hors ligne'));
        requestMissingWatchlistDetails([{ tmdb_id: 42, type: 'movie' }], 0);
        await flush();
        expect(cacheMovieDetails).not.toHaveBeenCalled();
        requestMissingWatchlistDetails([{ tmdb_id: 42, type: 'movie' }], RETRY_AFTER_MS - 1);
        await flush();
        expect(tmdb.getMovieDetails).toHaveBeenCalledTimes(1);
        requestMissingWatchlistDetails([{ tmdb_id: 42, type: 'movie' }], RETRY_AFTER_MS);
        await flush();
        expect(cacheMovieDetails).toHaveBeenCalledWith(42, { id: 42, title: 'Film 42' });
    });

    it('asks again for another account (its own database and cache)', async () => {
        requestMissingWatchlistDetails([{ tmdb_id: 42, type: 'movie' }], 1000);
        await flush();
        dbFile = 'nyxplayer_b.db';
        requestMissingWatchlistDetails([{ tmdb_id: 42, type: 'movie' }], 2000);
        await flush();
        expect(tmdb.getMovieDetails).toHaveBeenCalledTimes(2);
    });

    it('stops when a guest has used most of the day on the shared relay', async () => {
        backgroundAllowed = false;
        requestMissingWatchlistDetails([{ tmdb_id: 42, type: 'movie' }, { tmdb_id: 7, type: 'series' }]);
        await flush();
        expect(tmdb.getMovieDetails).not.toHaveBeenCalled();
        expect(tmdb.getTvDetails).not.toHaveBeenCalled();
    });
});
