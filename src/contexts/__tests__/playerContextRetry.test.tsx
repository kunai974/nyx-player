/**
 * Reconnexion automatique de bout en bout : PlayerContext + écran d'erreur (usePlaybackRetry).
 *
 * Défauts constatés : relances sans fin sur un flux bloqué en mise en tampon, et
 * échec de relance muet (l'écran « réessayer » disparaissait sur une image figée).
 */

import React, { useEffect } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';

const { mpvPlay, mpvSwitchChannel } = vi.hoisted(() => ({
    mpvPlay: vi.fn(),
    mpvSwitchChannel: vi.fn(),
}));

vi.mock('../../services/mpvBridge', () => ({
    mpvPlay,
    mpvSwitchChannel,
    mpvStop: vi.fn().mockResolvedValue(undefined),
    onMpvConnectionChange: vi.fn().mockReturnValue(() => {}),
}));
vi.mock('../../services/storage', () => ({
    StorageService: {
        getCredentials: vi.fn().mockResolvedValue({ host: 'http://test.invalid', username: 'u', password: 'p' }),
    },
}));
vi.mock('../../services/xtreamApi', () => ({
    XtreamApiService: class {
        preferredLiveExtension() { return undefined; }
        getStreamUrl(type: string, id: number) { return `http://test.invalid/${type}/${id}.ts`; }
    },
}));
vi.mock('../../services/playbackProgressService', () => ({ startPlayback: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../services/memoryService', () => ({
    enterPlayerMode: vi.fn(),
    exitPlayerMode: vi.fn(),
    purgeInPlayerMode: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../utils/platform', () => ({ isAndroid: () => false }));
vi.mock('../../services/player/androidPlayer', () => ({ setFullscreen: vi.fn().mockResolvedValue(undefined) }));

import { PlayerProvider, usePlayer } from '../PlayerContext';
import { usePlaybackRetry, type PlaybackRetryState } from '../../hooks/usePlaybackRetry';
import { emitPlaybackError, RETRY_DELAYS_S, type PlaybackError } from '../../services/player/playbackErrors';
import { STALL_TIMEOUT_MS } from '../../hooks/useStallWatchdog';
import type { PlayableItem } from '../../types/player';
import { StorageService } from '../../services/storage';

const channel = { stream_id: 42, stream_type: 'live', name: 'Chaîne test', category_id: '1' } as unknown as PlayableItem;
const otherChannel = { stream_id: 43, stream_type: 'live', name: 'Autre chaîne', category_id: '1' } as unknown as PlayableItem;

type Ctx = ReturnType<typeof usePlayer>;
let ctx: Ctx;
let overlay: PlaybackRetryState | null;

/** Même montage que PlaybackErrorOverlay : présent seulement pendant une erreur */
const Overlay: React.FC<{ error: PlaybackError; attempt: number; retry: () => Promise<void> }> = ({ error, attempt, retry }) => {
    const state = usePlaybackRetry(error, attempt, retry);
    useEffect(() => { overlay = state; });
    return null;
};

const Harness: React.FC = () => {
    const player = usePlayer();
    useEffect(() => { ctx = player; });
    return player.playbackError
        ? <Overlay error={player.playbackError} attempt={player.retryAttempt} retry={player.retryPlayback} />
        : null;
};

const advance = async (ms: number) => {
    await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
};

describe('PlayerContext — reconnexion automatique', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        overlay = null;
        mpvPlay.mockReset();
        mpvSwitchChannel.mockReset();
    });
    afterEach(() => vi.useRealTimers());

    it('flux bloqué en mise en tampon après chaque relance : 4 relances puis abandon, plus aucune requête', async () => {
        // Chaque ouverture « réussit » puis reste en tampon : le chien de garde signale une erreur 25 s plus tard
        mpvPlay.mockImplementation(async () => {
            setTimeout(() => emitPlaybackError({ kind: 'network', engine: 'mpv' }), STALL_TIMEOUT_MS);
        });
        render(<PlayerProvider><Harness /></PlayerProvider>);

        await act(async () => { void ctx.play(channel); });
        // Toute une nuit de TV allumée
        for (let i = 0; i < 8 * 60; i++) await advance(60_000);

        expect(mpvPlay).toHaveBeenCalledTimes(1 + RETRY_DELAYS_S.length);
        // Chaîne : vitesse et pistes remises à zéro à chaque lancement (mpvBridge)
        expect(mpvPlay.mock.calls[0][2]).toEqual({ live: true });
        expect(ctx.retryAttempt).toBe(RETRY_DELAYS_S.length);
        expect(ctx.playbackError?.kind).toBe('network');
        expect(overlay?.exhausted).toBe(true);
        expect(overlay?.secondsLeft).toBeNull();
    });

    it('relance réussie : le compteur reste en place tant que la lecture n\'a pas vraiment repris', async () => {
        mpvPlay.mockResolvedValue(undefined);
        render(<PlayerProvider><Harness /></PlayerProvider>);

        await act(async () => { void ctx.play(channel); });
        await advance(1000);
        act(() => emitPlaybackError({ kind: 'network' }));
        await advance(RETRY_DELAYS_S[0] * 1000 + 1000);

        expect(mpvPlay).toHaveBeenCalledTimes(2);
        expect(ctx.playbackError).toBeNull();
        expect(ctx.retryAttempt).toBe(1);

        // Plus de remise à zéro au bout d'un simple délai sans erreur
        await advance(10 * 60_000);
        expect(ctx.retryAttempt).toBe(1);

        // L'image défile de nouveau (usePlaybackRecovery) : compteur à zéro
        act(() => ctx.confirmPlaybackRecovered());
        expect(ctx.retryAttempt).toBe(0);
    });

    it('une relance dont le lancement échoue affiche une erreur au lieu de laisser une image figée', async () => {
        mpvPlay.mockResolvedValueOnce(undefined).mockRejectedValue(new Error('IPC closed'));
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        render(<PlayerProvider><Harness /></PlayerProvider>);

        await act(async () => { void ctx.play(channel); });
        await advance(1000);
        act(() => emitPlaybackError({ kind: 'network' }));
        await advance(RETRY_DELAYS_S[0] * 1000 + 1000);

        expect(mpvPlay).toHaveBeenCalledTimes(2);
        expect(ctx.playbackError).toEqual({ kind: 'unknown' });
        // Erreur inconnue : pas de relance automatique en boucle, l'utilisateur choisit
        await advance(30 * 60_000);
        expect(mpvPlay).toHaveBeenCalledTimes(2);
        consoleError.mockRestore();
    });

    it('une relance qui lève (trousseau illisible) affiche une erreur et retire le fondu noir', async () => {
        mpvPlay.mockResolvedValue(undefined);
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        render(<PlayerProvider><Harness /></PlayerProvider>);

        await act(async () => { void ctx.play(channel); });
        await advance(1000);
        act(() => emitPlaybackError({ kind: 'network' }));
        vi.mocked(StorageService.getCredentials).mockRejectedValueOnce(new Error('keyring locked'));
        await advance(RETRY_DELAYS_S[0] * 1000 + 1000);

        expect(mpvPlay).toHaveBeenCalledTimes(1);
        expect(ctx.playbackError).toEqual({ kind: 'unknown' });
        expect(ctx.isTransitioningToPlayer).toBe(false);
        consoleError.mockRestore();
    });

    it('la même erreur signalée deux fois ne relance pas le compte à rebours', async () => {
        mpvPlay.mockResolvedValue(undefined);
        render(<PlayerProvider><Harness /></PlayerProvider>);

        await act(async () => { void ctx.play(channel); });
        await advance(1000);
        act(() => emitPlaybackError({ kind: 'network', engine: 'mpv' }));
        await advance(10_000);
        const first = ctx.playbackError;
        // Tampon bloqué puis fin du flux : deux signalements de la même panne
        act(() => emitPlaybackError({ kind: 'network', engine: 'mpv' }));
        expect(ctx.playbackError).toBe(first);
        await advance((RETRY_DELAYS_S[0] - 10) * 1000 + 1000);
        expect(mpvPlay).toHaveBeenCalledTimes(2);
    });

    it('un zap qui échoue affiche une erreur et garde la chaîne précédente', async () => {
        mpvPlay.mockResolvedValue(undefined);
        mpvSwitchChannel.mockRejectedValue(new Error('IPC closed'));
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        render(<PlayerProvider><Harness /></PlayerProvider>);

        await act(async () => { void ctx.play(channel); });
        await advance(1000);
        expect(ctx.currentlyPlaying).toBe(channel);

        await act(async () => { await ctx.switchChannel(otherChannel); });
        expect(ctx.playbackError).toEqual({ kind: 'unknown' });
        expect(ctx.currentlyPlaying).toBe(channel);
        consoleError.mockRestore();
    });

    it('un échec arrivé après l\'arrêt du lecteur n\'affiche rien', async () => {
        let rejectPlay: (e: Error) => void = () => {};
        mpvPlay.mockImplementation(() => new Promise<void>((_, reject) => { rejectPlay = reject; }));
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        render(<PlayerProvider><Harness /></PlayerProvider>);

        await act(async () => { void ctx.play(channel); });
        await advance(500);
        await act(async () => { void ctx.stop(); });
        await act(async () => { rejectPlay(new Error('late')); });
        await advance(1000);

        expect(ctx.playbackError).toBeNull();
        consoleError.mockRestore();
    });
});
