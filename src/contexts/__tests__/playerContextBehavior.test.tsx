/**
 * Tests de caractérisation de PlayerContext : figent le comportement du lecteur avant
 * son découpage en modules. Complètent playerContextLaunch (lancement, zap) et playerContextRetry
 * (relances) : adresse du flux par type de contenu, enregistrement du début de lecture, épisodes
 * suivant / précédent, effets sur la page (classe player-active, fond de la fenêtre, travaux de
 * fond), connexion au moteur, plein écran Android et actions sur le message d'erreur.
 */

import React, { useEffect } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';

const {
    mpvPlay, mpvSwitchChannel, mpvStop, startPlayback, getProgressByStreamId, invoke,
    setFullscreen, enterPlayerMode, exitPlayerMode, purgeInPlayerMode, platform, connection,
} = vi.hoisted(() => ({
    mpvPlay: vi.fn(),
    mpvSwitchChannel: vi.fn(),
    mpvStop: vi.fn(),
    startPlayback: vi.fn(),
    getProgressByStreamId: vi.fn(),
    invoke: vi.fn(),
    setFullscreen: vi.fn(),
    enterPlayerMode: vi.fn(),
    exitPlayerMode: vi.fn(),
    purgeInPlayerMode: vi.fn(),
    platform: { android: false },
    connection: { listener: null as ((state: string) => void) | null, unsubscribe: vi.fn() },
}));

vi.mock('../../services/mpvBridge', () => ({
    mpvPlay,
    mpvSwitchChannel,
    mpvStop,
    onMpvConnectionChange: (listener: (state: string) => void) => {
        connection.listener = listener;
        return connection.unsubscribe;
    },
}));
vi.mock('../../services/storage', () => ({
    StorageService: {
        getCredentials: vi.fn(),
    },
}));
vi.mock('../../services/xtreamApi', () => ({
    XtreamApiService: class {
        preferredLiveExtension() { return undefined; }
        getStreamUrl(type: string, id: number, ext?: string) { return `http://test.invalid/${type}/${id}.${ext ?? 'defaut'}`; }
    },
}));
vi.mock('../../services/playbackProgressService', () => ({
    startPlayback,
    getProgressByStreamId,
}));
vi.mock('../../services/memoryService', () => ({
    enterPlayerMode,
    exitPlayerMode,
    purgeInPlayerMode,
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('../../utils/platform', () => ({ isAndroid: () => platform.android }));
vi.mock('../../services/player/androidPlayer', () => ({ setFullscreen }));

import { PlayerProvider, usePlayer } from '../PlayerContext';
import type { PlayableItem } from '../../types/player';
import type { AppSeriesInfo, XtreamEpisode } from '../../types/xtream';
import { StorageService } from '../../services/storage';
import { isPlaybackBusy } from '../../services/playbackActivity';
import { emitPlaybackError } from '../../services/player/playbackErrors';

const creds = { host: 'http://test.invalid', username: 'u', password: 'p' };
const channel = (id: number, ext?: string) => (
    { stream_id: id, stream_type: 'live', name: `Chaîne ${id}`, category_id: '1', ...(ext ? { container_extension: ext } : {}) }
) as unknown as PlayableItem;

const episode = (id: string, num: number) => ({ id, episode_num: num, title: `Épisode ${num}`, container_extension: 'mkv' }) as unknown as XtreamEpisode;
const series = {
    series_id: 55,
    name: 'Série',
    cover: 'http://test.invalid/cover.jpg',
    tmdb: 1234,
    episodes: {
        '1': [episode('101', 1), episode('102', 2)],
        '2': [episode('201', 1)],
    },
} as unknown as AppSeriesInfo;

type Ctx = ReturnType<typeof usePlayer>;
let ctx: Ctx;

const Harness: React.FC = () => {
    const player = usePlayer();
    useEffect(() => { ctx = player; });
    return null;
};

const advance = async (ms: number) => {
    await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
};

/** Lance une lecture et attend la fin du fondu et du chargement */
const playAndSettle = async (...args: Parameters<Ctx['play']>) => {
    await act(async () => { void ctx.play(...args); });
    await advance(1000);
};

describe('PlayerContext — comportement figé avant découpage', () => {
    let consoleError: ReturnType<typeof vi.spyOn>;
    let consoleWarn: ReturnType<typeof vi.spyOn>;
    let unmount: () => void;
    beforeEach(() => {
        vi.useFakeTimers();
        platform.android = false;
        connection.listener = null;
        connection.unsubscribe.mockReset();
        for (const fn of [mpvPlay, mpvSwitchChannel, mpvStop, startPlayback, invoke, setFullscreen]) {
            fn.mockReset().mockResolvedValue(undefined);
        }
        enterPlayerMode.mockReset();
        exitPlayerMode.mockReset();
        purgeInPlayerMode.mockReset();
        getProgressByStreamId.mockReset().mockResolvedValue(null);
        vi.mocked(StorageService.getCredentials).mockReset().mockResolvedValue(creds);
        consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        ({ unmount } = render(<PlayerProvider><Harness /></PlayerProvider>));
    });
    afterEach(() => {
        unmount();
        consoleError.mockRestore();
        consoleWarn.mockRestore();
        vi.useRealTimers();
    });

    describe('adresse du flux selon le contenu', () => {
        it('chaîne en direct sans format : adresse live, format fourni par l\'API, mode direct', async () => {
            await playAndSettle(channel(3));
            expect(mpvPlay).toHaveBeenCalledWith('http://test.invalid/live/3.defaut', undefined, { live: true });
        });

        it('chaîne en direct avec format (m3u8) : le format du fournisseur est demandé', async () => {
            await playAndSettle(channel(3, 'm3u8'));
            expect(mpvPlay).toHaveBeenCalledWith('http://test.invalid/live/3.m3u8', undefined, { live: true });
        });

        it('film avec extension : adresse movie avec l\'extension', async () => {
            await playAndSettle({ stream_id: 7, name: 'Film', container_extension: 'mkv' } as unknown as PlayableItem);
            expect(mpvPlay).toHaveBeenCalledWith('http://test.invalid/movie/7.mkv', undefined, { live: false });
        });

        it('film sans extension : adresse movie sans extension (format laissé à l\'API)', async () => {
            await playAndSettle({ stream_id: 8, name: 'Film' } as unknown as PlayableItem);
            expect(mpvPlay).toHaveBeenCalledWith('http://test.invalid/movie/8.defaut', undefined, { live: false });
        });

        it('épisode avec extension : adresse series avec l\'extension', async () => {
            await playAndSettle(episode('101', 1) as unknown as PlayableItem, series);
            expect(mpvPlay).toHaveBeenCalledWith('http://test.invalid/series/101.mkv', undefined, { live: false });
        });

        it('épisode sans extension : adresse series en ts', async () => {
            await playAndSettle({ id: '150', episode_num: 4, title: 'Épisode 4' } as unknown as PlayableItem);
            expect(mpvPlay).toHaveBeenCalledWith('http://test.invalid/series/150.ts', undefined, { live: false });
        });

        it('item sans identifiant : message « flux invalide », rien n\'est chargé', async () => {
            await playAndSettle({ name: 'Rien' } as unknown as PlayableItem);
            expect(mpvPlay).not.toHaveBeenCalled();
            expect(ctx.playbackError).toEqual({ kind: 'invalid_stream' });
            expect(ctx.isTransitioningToPlayer).toBe(false);
        });
    });

    describe('enregistrement du début de lecture', () => {
        it('film : type movie, titre TMDB et affiche des options prioritaires', async () => {
            await playAndSettle(
                { stream_id: 7, name: 'Film brut', container_extension: 'mkv' } as unknown as PlayableItem,
                undefined,
                undefined,
                { tmdbTitle: 'Film propre', tmdbId: 99, posterUrl: 'http://test.invalid/p.jpg' },
            );
            expect(startPlayback).toHaveBeenCalledWith({
                streamId: 7,
                contentType: 'movie',
                title: 'Film propre',
                titleFromTmdb: true,
                tmdbId: 99,
                posterUrl: 'http://test.invalid/p.jpg',
                containerExtension: 'mkv',
                seriesId: undefined,
                seasonNumber: undefined,
                episodeNumber: undefined,
            });
        });

        it('épisode : type episode, saison retrouvée, identifiants et affiche de la série', async () => {
            await playAndSettle(episode('102', 2) as unknown as PlayableItem, series);
            expect(startPlayback).toHaveBeenCalledWith({
                streamId: 102,
                contentType: 'episode',
                title: 'Épisode 2',
                titleFromTmdb: false,
                tmdbId: 1234,
                posterUrl: 'http://test.invalid/cover.jpg',
                containerExtension: 'mkv',
                seriesId: 55,
                seasonNumber: 1,
                episodeNumber: 2,
            });
        });

        it('chaîne en direct : rien n\'est enregistré', async () => {
            await playAndSettle(channel(3));
            expect(startPlayback).not.toHaveBeenCalled();
        });

        it('échec de l\'enregistrement : la lecture continue', async () => {
            startPlayback.mockRejectedValue(new Error('sqlite'));
            await playAndSettle({ stream_id: 7, name: 'Film', container_extension: 'mkv' } as unknown as PlayableItem);
            expect((ctx.currentlyPlaying as { stream_id: number }).stream_id).toBe(7);
            expect(ctx.playbackError).toBeNull();
        });
    });

    describe('épisodes suivant et précédent', () => {
        it('suivant : titre officiel de la série enregistré, jamais le nom brut du fournisseur', async () => {
            const official = { ...series, tmdbTitle: 'Série officielle' } as AppSeriesInfo;
            await playAndSettle(episode('101', 1) as unknown as PlayableItem, official);
            startPlayback.mockClear();

            await act(async () => { void ctx.playNextEpisode(); });
            await advance(1000);

            expect(startPlayback).toHaveBeenCalledWith(expect.objectContaining({ streamId: 102, title: 'Série officielle', titleFromTmdb: true }));
        });

        it('suivant : épisode d\'après dans la même saison, avec tmdbId et affiche de la série', async () => {
            await playAndSettle(episode('101', 1) as unknown as PlayableItem, series);
            mpvPlay.mockClear();
            startPlayback.mockClear();

            await act(async () => { void ctx.playNextEpisode(); });
            await advance(1000);

            expect(mpvPlay).toHaveBeenCalledWith('http://test.invalid/series/102.mkv', undefined, { live: false });
            expect((ctx.currentlyPlaying as { id: string }).id).toBe('102');
            expect(startPlayback).toHaveBeenCalledWith(expect.objectContaining({ tmdbId: 1234, posterUrl: 'http://test.invalid/cover.jpg' }));
        });

        it('suivant en fin de saison : premier épisode de la saison suivante', async () => {
            await playAndSettle(episode('102', 2) as unknown as PlayableItem, series);
            await act(async () => { void ctx.playNextEpisode(); });
            await advance(1000);
            expect((ctx.currentlyPlaying as { id: string }).id).toBe('201');
        });

        it('précédent en début de saison : dernier épisode de la saison d\'avant', async () => {
            await playAndSettle(episode('201', 1) as unknown as PlayableItem, series);
            await act(async () => { void ctx.playPreviousEpisode(); });
            await advance(1000);
            expect((ctx.currentlyPlaying as { id: string }).id).toBe('102');
        });

        it('dernier épisode de la série : « suivant » ne fait rien', async () => {
            await playAndSettle(episode('201', 1) as unknown as PlayableItem, series);
            mpvPlay.mockClear();
            await act(async () => { void ctx.playNextEpisode(); });
            await advance(1000);
            expect(mpvPlay).not.toHaveBeenCalled();
            expect((ctx.currentlyPlaying as { id: string }).id).toBe('201');
        });

        it('sans série connue : rien ne se passe', async () => {
            await playAndSettle(episode('101', 1) as unknown as PlayableItem);
            mpvPlay.mockClear();
            await act(async () => { void ctx.playNextEpisode(); void ctx.playPreviousEpisode(); });
            await advance(1000);
            expect(mpvPlay).not.toHaveBeenCalled();
        });

        it('setCurrentSeries fournit la série utilisée par les épisodes suivants', async () => {
            await playAndSettle(episode('101', 1) as unknown as PlayableItem);
            act(() => { ctx.setCurrentSeries(series); });
            expect(ctx.currentSeries).toBe(series);
            await act(async () => { void ctx.playNextEpisode(); });
            await advance(1000);
            expect((ctx.currentlyPlaying as { id: string }).id).toBe('102');
        });

        it('l\'arrêt oublie la série', async () => {
            await playAndSettle(episode('101', 1) as unknown as PlayableItem, series);
            expect(ctx.currentSeries).toBe(series);
            await act(async () => { void ctx.stop(); });
            await advance(1000);
            expect(ctx.currentSeries).toBeNull();
        });
    });

    describe('effets sur la page et l\'application', () => {
        it('lecture : classe player-active sur html et body, fenêtre transparente ; arrêt : l\'inverse', async () => {
            expect(invoke).toHaveBeenCalledWith('set_webview_opaque');
            expect(document.body.classList.contains('player-active')).toBe(false);

            await playAndSettle(channel(3));
            expect(document.documentElement.classList.contains('player-active')).toBe(true);
            expect(document.body.classList.contains('player-active')).toBe(true);
            expect(invoke).toHaveBeenLastCalledWith('set_webview_transparent');
            expect(enterPlayerMode).toHaveBeenCalledTimes(1);

            await act(async () => { void ctx.stop(); });
            await advance(1000);
            expect(document.documentElement.classList.contains('player-active')).toBe(false);
            expect(document.body.classList.contains('player-active')).toBe(false);
            expect(invoke).toHaveBeenLastCalledWith('set_webview_opaque');
            expect(exitPlayerMode).toHaveBeenCalledTimes(1);
        });

        it('travaux de fond suspendus dès le fondu d\'ouverture et jusqu\'à la fin de l\'arrêt', async () => {
            expect(isPlaybackBusy()).toBe(false);
            await act(async () => { void ctx.play(channel(3)); });
            expect(isPlaybackBusy()).toBe(true);
            await advance(1000);
            expect(isPlaybackBusy()).toBe(true);

            await act(async () => { void ctx.stop(); });
            await advance(100);
            expect(isPlaybackBusy()).toBe(true);
            await advance(1000);
            expect(isPlaybackBusy()).toBe(false);
        });

        it('connexion au moteur suivie, abonnement retiré au démontage', () => {
            expect(ctx.mpvConnected).toBe(false);
            act(() => { connection.listener?.('connected'); });
            expect(ctx.mpvConnected).toBe(true);
            act(() => { connection.listener?.('disconnected'); });
            expect(ctx.mpvConnected).toBe(false);
            unmount();
            expect(connection.unsubscribe).toHaveBeenCalledTimes(1);
            unmount = () => {};
        });

        it('lecteur démonté dans la demi-seconde : la purge mémoire différée ne part pas', async () => {
            await act(async () => { void ctx.play(channel(3)); });
            await advance(310); // lecture lancée, purge programmée à +500 ms
            expect(ctx.currentlyPlaying).not.toBeNull();
            unmount();
            unmount = () => {};
            await advance(2000);
            expect(purgeInPlayerMode).not.toHaveBeenCalled();
        });

        it('Android : plein écran demandé une fois la vidéo chargée', async () => {
            platform.android = true;
            await playAndSettle(channel(3));
            expect(setFullscreen).toHaveBeenCalledWith(true);
        });

        it('hors Android (Windows) : pas de plein écran Android', async () => {
            await playAndSettle(channel(3));
            expect(setFullscreen).not.toHaveBeenCalled();
        });
    });

    describe('message d\'erreur de lecture', () => {
        it('erreur signalée sans lecture demandée : ignorée', () => {
            act(() => { emitPlaybackError({ kind: 'access_denied', httpStatus: 403 }); });
            expect(ctx.playbackError).toBeNull();
        });

        it('« Continuer quand même » (appareil trop lent) ferme le message sans arrêter la lecture', async () => {
            await playAndSettle(channel(3));
            act(() => { emitPlaybackError({ kind: 'device_too_slow', continuable: true }); });
            expect(ctx.playbackError).toEqual({ kind: 'device_too_slow', continuable: true });

            act(() => { ctx.dismissPlaybackError(); });
            expect(ctx.playbackError).toBeNull();
            expect(ctx.currentlyPlaying).not.toBeNull();
            expect(mpvStop).not.toHaveBeenCalled();
        });

        it('lecture rétablie : compteur de relances remis à zéro', async () => {
            await playAndSettle(channel(3));
            act(() => { emitPlaybackError({ kind: 'unknown' }); });
            await act(async () => { void ctx.retryPlayback(); });
            await advance(1000);
            expect(ctx.retryAttempt).toBe(1);
            act(() => { ctx.confirmPlaybackRecovered(); });
            expect(ctx.retryAttempt).toBe(0);
        });

        it('échec du chargement : message « unknown », pas de lecteur ouvert', async () => {
            mpvPlay.mockRejectedValue(new Error('load failed'));
            await playAndSettle(channel(3));
            expect(ctx.playbackError).toEqual({ kind: 'unknown' });
            expect(ctx.currentlyPlaying).toBeNull();
            expect(ctx.isTransitioningToPlayer).toBe(false);
        });
    });
});

describe('usePlayer hors du PlayerProvider', () => {
    it('lève une erreur explicite', () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        const Orphan: React.FC = () => { usePlayer(); return null; };
        expect(() => render(<Orphan />)).toThrow('usePlayer must be used within a PlayerProvider');
        consoleError.mockRestore();
    });
});
