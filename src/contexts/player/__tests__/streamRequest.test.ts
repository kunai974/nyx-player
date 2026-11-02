/**
 * Préparation d'une lecture (streamRequest.ts) : adresse du flux selon le contenu, identifiant de
 * progression, position de départ, enregistrement du début de lecture et épisode en cours.
 * Remplace les anciens tests de playerContext.test.ts, qui recopiaient la logique au lieu de
 * l'appeler (les fonctions n'étaient pas exportées).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { startPlayback, getProgressByStreamId } = vi.hoisted(() => ({
    startPlayback: vi.fn(),
    getProgressByStreamId: vi.fn(),
}));
vi.mock('../../../services/playbackProgressService', () => ({ startPlayback, getProgressByStreamId }));

import {
    buildStreamUrl,
    progressStreamId,
    recordPlaybackStart,
    resolveCurrentEpisodeInfo,
    resolveStartPosition,
} from '../streamRequest';
import type { XtreamApiService } from '../../../services/xtreamApi';
import type { PlayableItem } from '../../../types/player';
import type { AppSeriesInfo, XtreamEpisode } from '../../../types/xtream';

const getStreamUrl = vi.fn((type: string, id: number, ext?: string) => `http://test.invalid/${type}/${id}.${ext ?? 'defaut'}`);
const preferredLiveExtension = vi.fn((): 'm3u8' | undefined => undefined);
const api = { getStreamUrl, preferredLiveExtension } as unknown as XtreamApiService;
const item = (fields: Record<string, unknown>) => fields as unknown as PlayableItem;

const episode = (id: string, num: number) => ({ id, episode_num: num, container_extension: 'mkv' }) as unknown as XtreamEpisode;
const series = {
    series_id: 55,
    cover: 'http://test.invalid/cover.jpg',
    tmdb: 1234,
    episodes: { '1': [episode('101', 1), episode('102', 2)], '3': [episode('301', 7)] },
} as unknown as AppSeriesInfo;

describe('buildStreamUrl', () => {
    beforeEach(() => { getStreamUrl.mockClear(); preferredLiveExtension.mockReset(); preferredLiveExtension.mockReturnValue(undefined); });

    it('compte qui n\'autorise que le HLS : chaîne demandée en m3u8', () => {
        preferredLiveExtension.mockReturnValueOnce('m3u8');
        expect(buildStreamUrl(item({ stream_id: 3, stream_type: 'live' }), api))
            .toEqual({ url: 'http://test.invalid/live/3.m3u8', container: 'm3u8', live: true });
    });

    it('format écrit par le fournisseur sur la chaîne : il l\'emporte sur celui du compte', () => {
        preferredLiveExtension.mockReturnValue('m3u8');
        expect(buildStreamUrl(item({ stream_id: 3, stream_type: 'live', container_extension: 'ts' }), api)?.url)
            .toBe('http://test.invalid/live/3.ts');
    });

    it('chaîne en direct sans format : live, format laissé à l\'API, conteneur ts', () => {
        expect(buildStreamUrl(item({ stream_id: 3, stream_type: 'live' }), api))
            .toEqual({ url: 'http://test.invalid/live/3.defaut', container: 'ts', live: true });
        expect(getStreamUrl).toHaveBeenCalledWith('live', 3, undefined);
    });

    it('chaîne en direct au format m3u8 : format du fournisseur', () => {
        expect(buildStreamUrl(item({ stream_id: 3, stream_type: 'live', container_extension: 'm3u8' }), api))
            .toEqual({ url: 'http://test.invalid/live/3.m3u8', container: 'm3u8', live: true });
    });

    it('film avec extension', () => {
        expect(buildStreamUrl(item({ stream_id: 7, container_extension: 'mkv' }), api))
            .toEqual({ url: 'http://test.invalid/movie/7.mkv', container: 'mkv', live: false });
    });

    it('épisode avec extension (id, pas de stream_id)', () => {
        expect(buildStreamUrl(item({ id: '456', episode_num: 3, container_extension: 'mp4' }), api))
            .toEqual({ url: 'http://test.invalid/series/456.mp4', container: 'mp4', live: false });
    });

    it('film sans extension (fiche film, ou film rechargé depuis SQLite) : conteneur mp4', () => {
        expect(buildStreamUrl(item({ stream_id: 8 }), api))
            .toEqual({ url: 'http://test.invalid/movie/8.defaut', container: 'mp4', live: false });
        expect(buildStreamUrl(item({ stream_id: 9, stream_type: 'movie' }), api))
            .toEqual({ url: 'http://test.invalid/movie/9.defaut', container: 'mp4', live: false });
    });

    it('extension vide : traitée comme absente', () => {
        expect(buildStreamUrl(item({ stream_id: 8, container_extension: '' }), api)?.container).toBe('mp4');
        // Extension qui changerait le chemin du flux : ignorée, comme une extension absente
        expect(buildStreamUrl(item({ stream_id: 9, container_extension: 'mkv/../x' }), api)?.container).toBe('mp4');
    });

    it('épisode sans extension : ts', () => {
        expect(buildStreamUrl(item({ id: '150', episode_num: 4 }), api))
            .toEqual({ url: 'http://test.invalid/series/150.ts', container: 'ts', live: false });
    });

    it('stream_type live sans stream_id : pas traité comme un direct', () => {
        expect(buildStreamUrl(item({ id: '150', stream_type: 'live' }), api)?.live).toBe(false);
    });

    it('item sans identifiant, ou adresse vide renvoyée par l\'API : null', () => {
        expect(buildStreamUrl(item({ name: 'Rien' }), api)).toBeNull();
        getStreamUrl.mockReturnValueOnce('');
        expect(buildStreamUrl(item({ stream_id: 7, container_extension: 'mkv' }), api)).toBeNull();
    });
});

describe('progressStreamId', () => {
    it('film et épisode : leur identifiant', () => {
        expect(progressStreamId(item({ stream_id: 7, container_extension: 'mkv' }))).toBe(7);
        expect(progressStreamId(item({ stream_id: 9, stream_type: 'movie' }))).toBe(9);
        expect(progressStreamId(item({ id: '456', episode_num: 3 }))).toBe(456);
    });

    it('direct, film sans indice de VOD, identifiant invalide : 0', () => {
        expect(progressStreamId(item({ stream_id: 3, stream_type: 'live' }))).toBe(0);
        expect(progressStreamId(item({ stream_id: 8 }))).toBe(0);
        expect(progressStreamId(item({ id: 'abc', episode_num: 1 }))).toBe(0);
    });
});

describe('resolveStartPosition', () => {
    beforeEach(() => { getProgressByStreamId.mockReset(); });
    const movie = item({ stream_id: 7, container_extension: 'mkv' });

    it('position demandée (« Reprendre ») : utilisée sans lire la base', async () => {
        expect(await resolveStartPosition(movie, 120)).toBe(120);
        expect(getProgressByStreamId).not.toHaveBeenCalled();
    });

    it('position enregistrée utilisable : reprise à cette position', async () => {
        getProgressByStreamId.mockResolvedValue({ timeSeconds: 600, progressPercent: 20, durationSeconds: 3000 });
        expect(await resolveStartPosition(movie, undefined)).toBe(600);
        expect(getProgressByStreamId).toHaveBeenCalledWith(7);
    });

    it('10 s ou moins, vu à 95 %, ou dans les 30 dernières secondes : début', async () => {
        for (const saved of [
            { timeSeconds: 10, progressPercent: 1, durationSeconds: 3000 },
            { timeSeconds: 2900, progressPercent: 95, durationSeconds: 3000 },
            { timeSeconds: 2975, progressPercent: 90, durationSeconds: 3000 },
        ]) {
            getProgressByStreamId.mockResolvedValue(saved);
            expect(await resolveStartPosition(movie, undefined)).toBeUndefined();
        }
    });

    it('durée inconnue : seule la règle des 95 % s\'applique', async () => {
        getProgressByStreamId.mockResolvedValue({ timeSeconds: 600, progressPercent: 50, durationSeconds: 0 });
        expect(await resolveStartPosition(movie, undefined)).toBe(600);
    });

    it('rien d\'enregistré, direct, ou lecture de la base en échec : début', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        getProgressByStreamId.mockResolvedValueOnce(null);
        expect(await resolveStartPosition(movie, undefined)).toBeUndefined();
        expect(await resolveStartPosition(item({ stream_id: 3, stream_type: 'live' }), undefined)).toBeUndefined();
        getProgressByStreamId.mockRejectedValueOnce(new Error('sqlite'));
        expect(await resolveStartPosition(movie, undefined)).toBeUndefined();
        warn.mockRestore();
    });
});

describe('recordPlaybackStart', () => {
    beforeEach(() => { startPlayback.mockReset().mockResolvedValue(undefined); });

    it('film : titre TMDB, identifiant et affiche des options avant ceux de l\'item', () => {
        recordPlaybackStart(item({ stream_id: 7, name: 'Nom brut', container_extension: 'mkv' }), undefined,
            { tmdbTitle: 'Titre propre', tmdbId: 42, posterUrl: 'http://test.invalid/p.jpg', seriesId: 9 });
        expect(startPlayback).toHaveBeenCalledWith({
            streamId: 7, contentType: 'movie', title: 'Titre propre', titleFromTmdb: true, tmdbId: 42,
            posterUrl: 'http://test.invalid/p.jpg', containerExtension: 'mkv', seriesId: 9,
            seasonNumber: undefined, episodeNumber: undefined,
        });
    });

    it('film sans options : nom de l\'item, marqué comme non TMDB', () => {
        recordPlaybackStart(item({ stream_id: 7, name: 'Nom brut', stream_type: 'movie' }), undefined, undefined);
        expect(startPlayback).toHaveBeenCalledWith(expect.objectContaining({ title: 'Nom brut', titleFromTmdb: false, contentType: 'movie', containerExtension: undefined }));
    });

    it('épisode : saison retrouvée dans la série, tmdb et affiche de la série', () => {
        recordPlaybackStart(item({ id: '301', episode_num: 7, title: 'Titre épisode', container_extension: 'mkv' }), series, undefined);
        expect(startPlayback).toHaveBeenCalledWith({
            streamId: 301, contentType: 'episode', title: 'Titre épisode', titleFromTmdb: false, tmdbId: 1234,
            posterUrl: 'http://test.invalid/cover.jpg', containerExtension: 'mkv', seriesId: 55,
            seasonNumber: 3, episodeNumber: 7,
        });
    });

    it('direct ou identifiant invalide : rien n\'est enregistré', () => {
        recordPlaybackStart(item({ stream_id: 3, stream_type: 'live' }), undefined, undefined);
        recordPlaybackStart(item({ id: '0', episode_num: 1 }), undefined, undefined);
        expect(startPlayback).not.toHaveBeenCalled();
    });

    it('échec de l\'enregistrement : avalé avec un avertissement', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const failure = new Error('sqlite');
        startPlayback.mockImplementation(() => Promise.reject(failure));
        recordPlaybackStart(item({ stream_id: 7, container_extension: 'mkv' }), undefined, undefined);
        await Promise.resolve();
        // Journal central : l'erreur journalisée est une copie masquée de l'originale
        expect(warn).toHaveBeenCalledWith('[PlayerContext] startPlayback failed:', expect.objectContaining({ message: failure.message }));
        warn.mockRestore();
    });
});

describe('resolveCurrentEpisodeInfo', () => {
    it('épisode de la série : saison et numéro', () => {
        expect(resolveCurrentEpisodeInfo(series, item({ id: '102' }))).toEqual({ season: 1, episodeNum: 2 });
        expect(resolveCurrentEpisodeInfo(series, item({ id: '301' }))).toEqual({ season: 3, episodeNum: 7 });
    });

    // Des fournisseurs écrivent le numéro d'épisode en nombre dans get_series_info
    it('numéro d\'épisode en nombre chez le fournisseur : épisode retrouvé', () => {
        const numeric = {
            ...series,
            episodes: { 1: [{ id: 101, episode_num: 1 }, { id: 102, episode_num: 2 }] },
        } as unknown as AppSeriesInfo;
        expect(resolveCurrentEpisodeInfo(numeric, item({ id: 102 }))).toEqual({ season: 1, episodeNum: 2 });
        expect(resolveCurrentEpisodeInfo(numeric, item({ id: '102' }))).toEqual({ season: 1, episodeNum: 2 });
    });

    it('pas de série, rien en lecture, film ou épisode inconnu : null', () => {
        expect(resolveCurrentEpisodeInfo(null, item({ id: '102' }))).toBeNull();
        expect(resolveCurrentEpisodeInfo(series, null)).toBeNull();
        expect(resolveCurrentEpisodeInfo(series, item({ stream_id: 7 }))).toBeNull();
        expect(resolveCurrentEpisodeInfo(series, item({ id: '999' }))).toBeNull();
    });
});
