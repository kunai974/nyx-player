/**
 * Ouverture d'un titre par navigateToContent : un numéro de source repris par un
 * autre titre n'ouvre jamais ce dernier ; le titre est alors cherché par son numéro TMDB.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { LightIndexes, LightMovie, LightSeries } from '../../types/lightIndex';

const navigateToMovie = vi.fn();
const navigateToSeries = vi.fn();
let lightIndexes: LightIndexes | null = null;
let details = new Map<string, Record<string, unknown>>();

vi.mock('../../contexts/NavigationContext', () => ({
    useNavigation: () => ({ navigateToMovie, navigateToSeries }),
}));

vi.mock('../../contexts/SessionContext', () => ({
    useSession: () => ({ lightIndexes }),
}));

vi.mock('../../services/detailFetcher', () => ({
    getMovieDetail: vi.fn(async (id: number) => details.get(`movie:${id}`) ?? null),
    getSeriesDetail: vi.fn(async (id: number) => details.get(`series:${id}`) ?? null),
}));

vi.mock('../../services/contentPreferencesService', () => ({
    getPreferredSource: vi.fn(async () => null),
}));

vi.mock('../../utils/devLog', () => ({ devLog: vi.fn() }));

const lookup = vi.hoisted(() => ({ within: vi.fn(async (): Promise<number> => 0) }));
vi.mock('../../services/titleTmdbLookup', () => ({ findTitleTmdbIdWithin: lookup.within }));

import { useContentNavigation, cancelPendingOpen } from '../useContentNavigation';

function movie(id: number, tmdbId: number): LightMovie {
    return { id, name: `Film ${id}`, iconPrefixId: 0, iconSuffix: '', tmdbId, categoryId: '1', added: 0, containerExt: 'mkv' };
}

function series(id: number, tmdbId: number): LightSeries {
    return { id, name: `Série ${id}`, iconPrefixId: 0, iconSuffix: '', tmdbId, categoryId: '1', added: 0 } as LightSeries;
}

function catalog(movies: LightMovie[], seriesList: LightSeries[] = []): LightIndexes {
    return {
        movies: new Map(movies.map((m) => [m.id, m])),
        series: new Map(seriesList.map((s) => [s.id, s])),
        live: new Map(),
        categories: new Map(),
        moviesByTmdb: new Map(movies.filter((m) => m.tmdbId > 0).map((m) => [m.tmdbId, m])),
        seriesByTmdb: new Map(seriesList.filter((s) => s.tmdbId > 0).map((s) => [s.tmdbId, s])),
        iconPrefixes: [],
    };
}

function addMovieDetail(id: number, tmdb: number) {
    details.set(`movie:${id}`, { stream_id: id, name: `Film ${id}`, tmdb });
}

async function open(type: 'movie' | 'series', identifier: { tmdbId: number; streamId?: number; seriesId?: number }) {
    const { result } = renderHook(() => useContentNavigation());
    await act(async () => {
        await result.current.navigateToContent(type, identifier);
    });
}

/** Numéros des versions passées à la page du film ouverte */
const openedMovieIds = () =>
    (navigateToMovie.mock.calls[0][1] as { stream_id: number }[]).map((v) => Number(v.stream_id));

beforeEach(() => {
    navigateToMovie.mockClear();
    navigateToSeries.mockClear();
    details = new Map();
    lightIndexes = null;
    lookup.within.mockReset().mockResolvedValue(0);
});

describe('navigateToContent', () => {
    it('opens the movie at its source number when it is the same TMDB title', async () => {
        lightIndexes = catalog([movie(100, 42)]);
        addMovieDetail(100, 42);
        await open('movie', { tmdbId: 42, streamId: 100 });
        expect(navigateToMovie).toHaveBeenCalledWith(42, expect.any(Array));
        expect(openedMovieIds()).toEqual([100]);
    });

    it('never opens another title that took the source number, and finds it by TMDB instead', async () => {
        lightIndexes = catalog([movie(100, 99), movie(500, 42)]);
        addMovieDetail(100, 99); // autre film au même numéro
        addMovieDetail(500, 42);
        await open('movie', { tmdbId: 42, streamId: 100 });
        expect(navigateToMovie).toHaveBeenCalledTimes(1);
        expect(navigateToMovie.mock.calls[0][0]).toBe(42);
        expect(openedMovieIds()).toEqual([500]);
    });

    it('finds the title by TMDB when its source number no longer exists', async () => {
        lightIndexes = catalog([movie(500, 42)]);
        addMovieDetail(500, 42);
        await open('movie', { tmdbId: 42, streamId: 100 });
        expect(openedMovieIds()).toEqual([500]);
    });

    it('opens nothing when the title is not in the catalog', async () => {
        lightIndexes = catalog([movie(100, 99)]);
        addMovieDetail(100, 99);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        await open('movie', { tmdbId: 42, streamId: 100 });
        expect(navigateToMovie).not.toHaveBeenCalled();
        warn.mockRestore();
    });

    it('still opens a title without TMDB id by its source number', async () => {
        lightIndexes = catalog([movie(100, 0)]);
        addMovieDetail(100, 0);
        await open('movie', { tmdbId: 0, streamId: 100 });
        expect(navigateToMovie).toHaveBeenCalledWith(0, [expect.objectContaining({ stream_id: 100 })]);
    });

    it('does the same for series', async () => {
        lightIndexes = catalog([], [series(100, 99), series(700, 77)]);
        details.set('series:100', { series_id: 100, name: 'Autre série', tmdb: 99 });
        details.set('series:700', { series_id: 700, name: 'La série', tmdb: 77 });
        await open('series', { tmdbId: 77, seriesId: 100 });
        expect(navigateToSeries).toHaveBeenCalledTimes(1);
        expect(navigateToSeries.mock.calls[0][0]).toMatchObject({ series_id: 700, tmdb: 77 });
    });
});

describe('titles linked to TMDB by their name (provider without TMDB ids)', () => {
    it('opens a title linked by its name with its TMDB card and all its versions', async () => {
        // Base du fournisseur sans numéro ; lien trouvé par le titre, posé en mémoire seulement
        lightIndexes = catalog([movie(100, 42), movie(101, 42), movie(102, 0)]);
        addMovieDetail(100, 0);
        await open('movie', { tmdbId: 0, streamId: 100 });
        expect(navigateToMovie.mock.calls[0][0]).toBe(42);
        expect(openedMovieIds()).toEqual([100, 101]);
        expect(lookup.within).not.toHaveBeenCalled();
    });

    it('looks the TMDB id up at opening when nothing is known yet, then groups the versions', async () => {
        lightIndexes = catalog([movie(100, 0), movie(101, 0)]);
        addMovieDetail(100, 0);
        lookup.within.mockImplementationOnce(async () => {
            lightIndexes!.movies.get(100)!.tmdbId = 42;
            lightIndexes!.movies.get(101)!.tmdbId = 42;
            return 42;
        });
        await open('movie', { tmdbId: 0, streamId: 100 });
        expect(lookup.within).toHaveBeenCalledWith('movie', 100, lightIndexes, expect.any(Number));
        expect(navigateToMovie.mock.calls[0][0]).toBe(42);
        expect(openedMovieIds()).toEqual([100, 101]);
    });

    it('gives the series card the TMDB id found by its name', async () => {
        lightIndexes = catalog([], [series(700, 77)]);
        details.set('series:700', { series_id: 700, name: 'La série', tmdb: null });
        await open('series', { tmdbId: 0, seriesId: 700 });
        expect(navigateToSeries.mock.calls[0][0]).toMatchObject({ series_id: 700, tmdb: 77 });
    });
});

describe('carte regroupée sans numéro du fournisseur', () => {
    it('series: the grouped card is looked up like a single one and the page receives the TMDB id found', async () => {
        lightIndexes = catalog([], [series(700, 0), series(701, 0)]);
        lookup.within.mockImplementationOnce(async () => 77);
        const versions = [{ series_id: 700, name: 'A', tmdb: 0 }, { series_id: 701, name: 'B', tmdb: 0 }];
        const { result } = renderHook(() => useContentNavigation());
        await act(async () => {
            await result.current.openSeries(versions[0] as never, versions as never);
        });
        expect(lookup.within).toHaveBeenCalledWith('series', 700, lightIndexes, expect.any(Number));
        expect(navigateToSeries.mock.calls[0][0]).toMatchObject({ series_id: 700, tmdb: 77 });
        expect(navigateToSeries.mock.calls[0][0].groupedVersions).toHaveLength(2);
    });
});

describe('deux cartes pressées très vite', () => {
    it('la dernière carte pressée gagne, même si la base répond d\'abord pour elle', async () => {
        lightIndexes = catalog([movie(1, 11), movie(2, 22)]);
        addMovieDetail(2, 22);
        let releaseFirst!: () => void;
        const { getMovieDetail } = await import('../../services/detailFetcher');
        vi.mocked(getMovieDetail).mockImplementationOnce(
            (id: number) => new Promise((resolve) => {
                releaseFirst = () => resolve({ stream_id: id, name: `Film ${id}`, tmdb: 11 } as never);
            }),
        );
        const { result } = renderHook(() => useContentNavigation());

        await act(async () => {
            const first = result.current.openMovie({ stream_id: 1, name: 'Film 1', tmdb: 11 } as never);
            const second = result.current.openMovie({ stream_id: 2, name: 'Film 2', tmdb: 22 } as never);
            await second;
            releaseFirst();
            await first;
        });

        expect(navigateToMovie).toHaveBeenCalledTimes(1);
        expect(navigateToMovie.mock.calls[0][0]).toBe(22);
    });

    it('pareil entre une série et un film', async () => {
        lightIndexes = catalog([movie(2, 22)], [series(7, 77)]);
        addMovieDetail(2, 22);
        let releaseSeries!: () => void;
        const { getSeriesDetail } = await import('../../services/detailFetcher');
        vi.mocked(getSeriesDetail).mockImplementationOnce(
            (id: number) => new Promise((resolve) => {
                releaseSeries = () => resolve({ series_id: id, name: `Série ${id}`, tmdb: 77 } as never);
            }),
        );
        const { result } = renderHook(() => useContentNavigation());

        await act(async () => {
            const first = result.current.openSeries({ series_id: 7, name: 'Série 7', tmdb: 77 } as never);
            const second = result.current.openMovie({ stream_id: 2, name: 'Film 2', tmdb: 22 } as never);
            await second;
            releaseSeries();
            await first;
        });

        expect(navigateToSeries).not.toHaveBeenCalled();
        expect(navigateToMovie).toHaveBeenCalledTimes(1);
    });

    it('retour arrière pendant l\'attente : la fiche demandée ne s\'ouvre plus', async () => {
        lightIndexes = catalog([movie(1, 11)]);
        let release!: () => void;
        const { getMovieDetail } = await import('../../services/detailFetcher');
        vi.mocked(getMovieDetail).mockImplementationOnce(
            (id: number) => new Promise((resolve) => {
                release = () => resolve({ stream_id: id, name: `Film ${id}`, tmdb: 11 } as never);
            }),
        );
        const { result } = renderHook(() => useContentNavigation());

        await act(async () => {
            const opening = result.current.openMovie({ stream_id: 1, name: 'Film 1', tmdb: 11 } as never);
            await Promise.resolve();
            cancelPendingOpen();
            release();
            await opening;
        });

        expect(navigateToMovie).not.toHaveBeenCalled();
    });
});
