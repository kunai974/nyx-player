/**
 * Lancement et zap : demandes dépassées, lancement impossible
 * affiché, purge mémoire annulée, position de reprise passée au chargement.
 */

import React, { useEffect } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';

const { mpvPlay, mpvSwitchChannel, mpvStop, purgeInPlayerMode, getProgressByStreamId } = vi.hoisted(() => ({
    mpvPlay: vi.fn(),
    mpvSwitchChannel: vi.fn(),
    mpvStop: vi.fn(),
    purgeInPlayerMode: vi.fn(),
    getProgressByStreamId: vi.fn(),
}));

vi.mock('../../services/mpvBridge', () => ({
    mpvPlay,
    mpvSwitchChannel,
    mpvStop,
    onMpvConnectionChange: vi.fn().mockReturnValue(() => {}),
}));
vi.mock('../../services/storage', () => ({
    StorageService: {
        getCredentials: vi.fn(),
    },
}));
vi.mock('../../services/xtreamApi', () => ({
    XtreamApiService: class {
        preferredLiveExtension() { return undefined; }
        getStreamUrl(type: string, id: number) { return Number.isNaN(id) ? '' : `http://test.invalid/${type}/${id}.ts`; }
    },
}));
vi.mock('../../services/playbackProgressService', () => ({
    startPlayback: vi.fn().mockResolvedValue(undefined),
    getProgressByStreamId,
}));
vi.mock('../../services/memoryService', () => ({
    enterPlayerMode: vi.fn(),
    exitPlayerMode: vi.fn(),
    purgeInPlayerMode,
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../utils/platform', () => ({ isAndroid: () => false }));
vi.mock('../../services/player/androidPlayer', () => ({ setFullscreen: vi.fn().mockResolvedValue(undefined) }));

import { PlayerProvider, usePlayer } from '../PlayerContext';
import type { PlayableItem } from '../../types/player';
import { StorageService } from '../../services/storage';

const creds = { host: 'http://test.invalid', username: 'u', password: 'p' };
const channel = (id: number) => ({ stream_id: id, stream_type: 'live', name: `Chaîne ${id}`, category_id: '1' }) as unknown as PlayableItem;
const movie = { stream_id: 7, name: 'Film', container_extension: 'mkv' } as unknown as PlayableItem;

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

describe('PlayerContext — lancement et zap', () => {
    let consoleError: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
        vi.useFakeTimers();
        mpvPlay.mockReset().mockResolvedValue(undefined);
        mpvSwitchChannel.mockReset().mockResolvedValue(undefined);
        mpvStop.mockReset().mockResolvedValue(undefined);
        purgeInPlayerMode.mockReset();
        getProgressByStreamId.mockReset().mockResolvedValue(null);
        vi.mocked(StorageService.getCredentials).mockReset().mockResolvedValue(creds);
        consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        render(<PlayerProvider><Harness /></PlayerProvider>);
    });
    afterEach(() => {
        consoleError.mockRestore();
        vi.useRealTimers();
    });

    it('Retour juste après Lecture : le lecteur ne s\'ouvre pas une fois le chargement fini', async () => {
        let finishLoad: () => void = () => {};
        mpvPlay.mockImplementation(() => new Promise<void>((resolve) => { finishLoad = resolve; }));

        await act(async () => { void ctx.play(channel(1)); });
        await advance(350); // fondu passé, chargement en cours
        expect(mpvPlay).toHaveBeenCalledTimes(1);

        await act(async () => { void ctx.stop(); });
        await advance(350);
        await act(async () => { finishLoad(); });
        await advance(1000);

        expect(ctx.currentlyPlaying).toBeNull();
        expect(ctx.isTransitioningToPlayer).toBe(false);
        expect(mpvStop).toHaveBeenCalledTimes(1);
    });

    it('Retour pendant le fondu d\'ouverture : rien n\'est chargé', async () => {
        await act(async () => { void ctx.play(channel(1)); });
        await advance(100);
        await act(async () => { void ctx.stop(); });
        await advance(1000);

        expect(mpvPlay).not.toHaveBeenCalled();
        expect(ctx.currentlyPlaying).toBeNull();
        expect(ctx.isTransitioningToPlayer).toBe(false);
    });

    it('trois zaps rapides terminés dans le désordre : l\'écran montre la dernière chaîne demandée', async () => {
        await act(async () => { void ctx.play(channel(1)); });
        await advance(1000);

        const pending: Array<() => void> = [];
        mpvSwitchChannel.mockImplementation(() => new Promise<void>((resolve) => { pending.push(resolve); }));
        // Chaque zap atteint le moteur avant que le suivant parte
        for (const id of [2, 3, 4]) {
            await act(async () => { void ctx.switchChannel(channel(id)); });
            await advance(0);
        }
        expect(pending).toHaveLength(3);

        // Le dernier zap répond d'abord, les deux autres arrivent en retard
        await act(async () => { pending[2](); });
        await act(async () => { pending[0](); pending[1](); });
        await advance(0);

        expect((ctx.currentlyPlaying as { stream_id: number }).stream_id).toBe(4);
    });

    it('identifiants introuvables : un message s\'affiche au lieu de ne rien faire', async () => {
        vi.mocked(StorageService.getCredentials).mockResolvedValue(null);
        await act(async () => { void ctx.play(movie); });
        await advance(1000);

        expect(mpvPlay).not.toHaveBeenCalled();
        expect(ctx.playbackError).toEqual({ kind: 'missing_credentials' });
        expect(ctx.isTransitioningToPlayer).toBe(false);
        expect(ctx.currentlyPlaying).toBeNull();

        // « Fermer » : plus rien n'est demandé au lecteur
        act(() => ctx.cancelFailedLaunch());
        expect(ctx.playbackError).toBeNull();
    });

    it('adresse du flux impossible à construire : message affiché', async () => {
        const broken = { stream_id: 'abc', stream_type: 'live', name: 'Cassée' } as unknown as PlayableItem;
        await act(async () => { void ctx.play(broken); });
        await advance(1000);

        expect(mpvPlay).not.toHaveBeenCalled();
        expect(ctx.playbackError).toEqual({ kind: 'invalid_stream' });
        expect(ctx.isTransitioningToPlayer).toBe(false);
    });

    it('zap sans identifiants : message dans le lecteur, chaîne précédente gardée', async () => {
        await act(async () => { void ctx.play(channel(1)); });
        await advance(1000);
        vi.mocked(StorageService.getCredentials).mockResolvedValue(null);

        await act(async () => { await ctx.switchChannel(channel(2)); });
        expect(ctx.playbackError).toEqual({ kind: 'missing_credentials' });
        expect((ctx.currentlyPlaying as { stream_id: number }).stream_id).toBe(1);
    });

    it('lecteur fermé dans la demi-seconde : la purge mémoire différée ne part pas', async () => {
        await act(async () => { void ctx.play(channel(1)); });
        await advance(310); // lecture lancée, purge programmée à +500 ms
        expect(ctx.currentlyPlaying).not.toBeNull();

        await act(async () => { void ctx.stop(); });
        await advance(2000);
        expect(purgeInPlayerMode).not.toHaveBeenCalled();
    });

    it('sans fermeture, la purge différée part toujours', async () => {
        await act(async () => { void ctx.play(channel(1)); });
        await advance(1000);
        expect(purgeInPlayerMode).toHaveBeenCalledTimes(1);
    });

    it('film déjà commencé : la position enregistrée est donnée au chargement', async () => {
        getProgressByStreamId.mockResolvedValue({ timeSeconds: 1200, durationSeconds: 5400, progressPercent: 22 });
        await act(async () => { void ctx.play(movie); });
        await advance(1000);
        expect(mpvPlay).toHaveBeenCalledWith('http://test.invalid/movie/7.ts', 1200, { live: false });
    });

    it('« Reprendre » avec une position fournie : elle est utilisée telle quelle', async () => {
        await act(async () => { void ctx.play(movie, undefined, 845); });
        await advance(1000);
        expect(getProgressByStreamId).not.toHaveBeenCalled();
        expect(mpvPlay.mock.calls[0][1]).toBe(845);
    });

    it('film vu à 95 %, ou fin toute proche : ouverture au début (règles d\'avant)', async () => {
        getProgressByStreamId.mockResolvedValueOnce({ timeSeconds: 5200, durationSeconds: 5400, progressPercent: 96 });
        await act(async () => { void ctx.play(movie); });
        await advance(1000);
        expect(mpvPlay.mock.calls[0][1]).toBeUndefined();

        getProgressByStreamId.mockResolvedValueOnce({ timeSeconds: 100, durationSeconds: 120, progressPercent: 83 });
        await act(async () => { void ctx.play(movie); });
        await advance(1000);
        expect(mpvPlay.mock.calls[1][1]).toBeUndefined();
    });

    it('une chaîne en direct n\'a jamais de position de départ', async () => {
        await act(async () => { void ctx.play(channel(1)); });
        await advance(1000);
        expect(getProgressByStreamId).not.toHaveBeenCalled();
        expect(mpvPlay.mock.calls[0][1]).toBeUndefined();
    });

    it('Retour puis zap pendant le fondu d\'arrêt : pas de voile noir resté sur la chaîne', async () => {
        await act(async () => { void ctx.play(channel(1)); });
        await advance(1000);
        await act(async () => { void ctx.stop(); });
        await advance(100);
        await act(async () => { await ctx.switchChannel(channel(2)); });
        await advance(1000);

        expect(ctx.isTransitioningToPlayer).toBe(false);
        expect((ctx.currentlyPlaying as { stream_id: number }).stream_id).toBe(2);
    });

    it('relance d\'un film lancé depuis « Reprendre » : repart de la position enregistrée, pas du point de départ', async () => {
        await act(async () => { void ctx.play(movie, undefined, 600); });
        await advance(1000);
        // 40 min plus tard, la sauvegarde périodique a enregistré 50:00, puis le flux tombe
        getProgressByStreamId.mockResolvedValue({ timeSeconds: 3000, durationSeconds: 5400, progressPercent: 55 });
        await act(async () => { void ctx.retryPlayback(); });
        await advance(1000);
        expect(mpvPlay.mock.calls[1][1]).toBe(3000);
    });

    it('« Fermer » après un lancement raté : le moteur est arrêté s\'il avait chargé quand même', async () => {
        mpvPlay.mockRejectedValue(new Error('IPC timeout'));
        await act(async () => { void ctx.play(movie); });
        await advance(1000);
        expect(ctx.playbackError).toEqual({ kind: 'unknown' });
        act(() => ctx.cancelFailedLaunch());
        expect(mpvStop).toHaveBeenCalled();
    });
});
