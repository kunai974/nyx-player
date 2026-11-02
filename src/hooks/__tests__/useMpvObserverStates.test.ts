/**
 * useMpvObserver : états d'erreur et de fin de lecture.
 * Fin de flux, flux coupé (mise en tampon), moteur qui ne répond pas, valeurs absentes, épisode
 * suivant. Le moteur est imité : aucun flux réel n'est lu.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StrictMode } from 'react';
import { renderHook, act } from '@testing-library/react';
import type { SeriesMetadata } from '../../types/player';

type PropertyEvent = { name: string; data?: unknown };

const { observeProperties, getProperty, observer, prefs } = vi.hoisted(() => ({
  observeProperties: vi.fn(),
  getProperty: vi.fn(),
  observer: { callback: null as ((event: PropertyEvent) => void) | null },
  prefs: { binge: true, countdown: 10 },
}));

vi.mock('../../services/player/mpvApi', () => ({ observeProperties, getProperty }));
vi.mock('../../services/preferencesService', () => ({
  isBingeModeEnabled: () => prefs.binge,
  getBingeCountdown: () => prefs.countdown,
}));

import { useMpvObserver, GEEK_STATS_INTERVAL_MS } from '../useMpvObserver';

const emit = (name: string, data: unknown) => act(() => { observer.callback?.({ name, data }); });

const series = (nextEpisode: SeriesMetadata['nextEpisode']): SeriesMetadata => ({
  seriesId: 1, seriesName: 'Série test', seasonNumber: 1, episodeNumber: 1,
  episodeTitle: 'Pilote', episodeId: '11', containerExtension: 'mkv', nextEpisode,
});
const NEXT = { episodeId: '12', seasonNumber: 1, episodeNumber: 2 };

async function mount(
  meta?: SeriesMetadata,
  onNext?: () => Promise<void>,
  opts: { connected?: boolean; stats?: boolean } = {},
) {
  const hook = renderHook(() => useMpvObserver(opts.connected ?? true, meta, onNext, opts.stats ?? false));
  await act(async () => { await Promise.resolve(); });
  return hook;
}

describe('useMpvObserver : états du flux', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    prefs.binge = true;
    prefs.countdown = 10;
    observer.callback = null;
    observeProperties.mockReset().mockImplementation(async (_p: string[], cb: (e: PropertyEvent) => void) => {
      observer.callback = cb;
      return () => {};
    });
    getProperty.mockReset().mockResolvedValue(null);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('lecteur pas encore relié au moteur : aucun abonnement', async () => {
    await mount(undefined, undefined, { connected: false });
    expect(observeProperties).not.toHaveBeenCalled();
  });

  it('abonnement refusé par le moteur : pas de plantage, le lecteur reste en chargement', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    observeProperties.mockRejectedValue(new Error('mpv absent'));
    const { result } = await mount();
    expect(result.current.isLoading).toBe(true);
    expect(warn).toHaveBeenCalled();
  });

  it('fin du flux : signalée, et effacée quand un nouveau flux se charge (valeur absente)', async () => {
    const { result } = await mount();
    emit('eof-reached', true);
    expect(result.current.isEndOfFile).toBe(true);
    emit('eof-reached', null);
    expect(result.current.isEndOfFile).toBe(false);
  });

  it('flux coupé : mise en tampon signalée puis levée', async () => {
    const { result } = await mount();
    emit('paused-for-cache', true);
    expect(result.current.isBuffering).toBe(true);
    emit('paused-for-cache', false);
    expect(result.current.isBuffering).toBe(false);
  });

  it('chargement terminé à la première position non nulle', async () => {
    const { result } = await mount();
    emit('time-pos', 0);
    expect(result.current.isLoading).toBe(true);
    emit('time-pos', 0.5);
    expect(result.current.isLoading).toBe(false);
  });

  it('déplacement : fini quand le moteur le dit, ou quand la lecture progresse deux fois', async () => {
    const { result } = await mount();
    act(() => { result.current.setIsSeeking(true); });
    emit('seeking', true);
    expect(result.current.isSeeking).toBe(true);
    emit('seeking', false);
    expect(result.current.isSeeking).toBe(false);

    act(() => { result.current.setIsSeeking(true); });
    emit('time-pos', 10);
    emit('time-pos', 10.5);
    expect(result.current.isSeeking).toBe(true);
    emit('time-pos', 11);
    expect(result.current.isSeeking).toBe(false);
  });

  it('valeurs absentes : repli sur des valeurs sûres (piste 1, sans sous-titres, vitesse 1, volume 100)', async () => {
    const { result } = await mount();
    emit('aid', 3);
    emit('aid', null);
    emit('sid', null);
    emit('speed', null);
    emit('sub-scale', null);
    emit('volume', null);
    emit('duration', null);
    expect(result.current.currentAudioId).toBe(1);
    expect(result.current.currentSubId).toBe(0);
    expect(result.current.playbackSpeed).toBe(1);
    expect(result.current.subtitleScale).toBe(1);
    expect(result.current.volume).toBe(100);
    expect(result.current.duration).toBe(0);
  });

  it('volume et sourdine relus au démarrage : un son coupé par le lecteur précédent reste affiché coupé', async () => {
    getProperty.mockImplementation(async (name: string) => (name === 'mute' ? true : name === 'volume' ? 40 : null));
    const { result } = await mount();
    await act(async () => { await Promise.resolve(); });
    expect(result.current.isMuted).toBe(true);
    expect(result.current.volume).toBe(40);
    expect(result.current.volumeRef.current).toBe(40);
  });

  it('durée relue au démarrage : l\'abonnement pris après le chargement du fichier ne la reçoit jamais', async () => {
    getProperty.mockImplementation(async (name: string) => (name === 'duration' ? 300 : null));
    const { result } = await mount();
    await act(async () => { await Promise.resolve(); });
    expect(result.current.duration).toBe(300);
    expect(result.current.durationRef.current).toBe(300);
  });

  it('durée relue au démarrage : jamais à la place d\'une durée déjà reçue, ni d\'une valeur illisible', async () => {
    let repondre: (v: unknown) => void = () => {};
    getProperty.mockImplementation((name: string) => (name === 'duration' ? new Promise((r) => { repondre = r; }) : Promise.resolve(null)));
    const { result } = await mount();
    emit('duration', 120);
    await act(async () => { repondre(300); await Promise.resolve(); });
    expect(result.current.duration).toBe(120);
    getProperty.mockImplementation(async (name: string) => (name === 'duration' ? 'n/a' : null));
    const autre = await mount();
    await act(async () => { await Promise.resolve(); });
    expect(autre.result.current.duration).toBe(0);
  });

  it('position relue au démarrage : l\'abonnement pris après le chargement ne la reçoit pas (lecture en pause)', async () => {
    getProperty.mockImplementation(async (name: string) => (name === 'time-pos' ? 120 : name === 'duration' ? 600 : null));
    const { result } = await mount();
    await act(async () => { await Promise.resolve(); });
    expect(result.current.currentTime).toBe(120);
    expect(result.current.isLoading).toBe(false);
  });

  it('position relue au démarrage : jamais à la place d\'une position déjà reçue', async () => {
    let repondre: (v: unknown) => void = () => {};
    getProperty.mockImplementation((name: string) => (name === 'time-pos' ? new Promise((r) => { repondre = r; }) : Promise.resolve(null)));
    const { result } = await mount();
    emit('time-pos', 130);
    await act(async () => { repondre(120); await Promise.resolve(); });
    expect(result.current.currentTime).toBe(130);
  });

  it('relecture après un réglage : ignore les réponses illisibles', async () => {
    getProperty.mockImplementation(async (name: string) => {
      if (name === 'speed') return 1.5;
      if (name === 'aid') throw new Error('refus');
      return 'n/a';
    });
    const { result } = await mount();
    await act(async () => { await result.current.syncFromMpv(); });
    expect(result.current.playbackSpeed).toBe(1.5);
    expect(result.current.currentAudioId).toBe(1);
    expect(result.current.currentSubId).toBe(0);
  });

  describe('épisode suivant (Binge)', () => {
    it('s\'affiche avant la fin, décompte, puis lance l\'épisode suivant', async () => {
      const onNext = vi.fn().mockResolvedValue(undefined);
      const { result } = await mount(series(NEXT), onNext);
      emit('duration', 100);
      emit('time-pos', 89);
      expect(result.current.showBingePopup).toBe(false);
      emit('time-pos', 90);
      expect(result.current.showBingePopup).toBe(true);
      expect(result.current.bingeCountdown).toBe(10);

      act(() => { vi.advanceTimersByTime(3000); });
      expect(result.current.bingeCountdown).toBe(7);
      act(() => { vi.advanceTimersByTime(7000); });
      expect(result.current.showBingePopup).toBe(false);
      expect(onNext).toHaveBeenCalledTimes(1);
    });

    it('fin du décompte en mode développement (StrictMode) : l\'épisode suivant n\'est lancé qu\'une fois', async () => {
      // React rejoue deux fois les fonctions de mise à jour d'état en mode développement :
      // l'épisode suivant ne doit pas être lancé depuis l'une d'elles.
      const onNext = vi.fn().mockResolvedValue(undefined);
      const { result } = renderHook(() => useMpvObserver(true, series(NEXT), onNext, false), { wrapper: StrictMode });
      await act(async () => { await Promise.resolve(); });
      emit('duration', 100);
      emit('time-pos', 90);
      expect(result.current.showBingePopup).toBe(true);
      act(() => { vi.advanceTimersByTime(10_000); });
      expect(result.current.showBingePopup).toBe(false);
      expect(result.current.bingeCountdown).toBe(0);
      expect(onNext).toHaveBeenCalledTimes(1);
      act(() => { vi.advanceTimersByTime(5_000); });
      expect(onNext).toHaveBeenCalledTimes(1);
    });

    it('pause pendant le décompte : il s\'arrête, puis reprend à la reprise de la lecture', async () => {
      const onNext = vi.fn().mockResolvedValue(undefined);
      const { result } = await mount(series(NEXT), onNext);
      emit('duration', 100);
      emit('time-pos', 90);
      act(() => { vi.advanceTimersByTime(3000); });
      expect(result.current.bingeCountdown).toBe(7);

      emit('pause', true);
      act(() => { vi.advanceTimersByTime(60_000); });
      expect(result.current.bingeCountdown).toBe(7);
      expect(result.current.showBingePopup).toBe(true);
      expect(onNext).not.toHaveBeenCalled();

      emit('pause', false);
      act(() => { vi.advanceTimersByTime(6000); });
      expect(result.current.bingeCountdown).toBe(1);
      expect(onNext).not.toHaveBeenCalled();
      act(() => { vi.advanceTimersByTime(1000); });
      expect(result.current.showBingePopup).toBe(false);
      expect(onNext).toHaveBeenCalledTimes(1);
    });

    it('fenêtre ouverte alors que la lecture est déjà en pause : le décompte attend la reprise', async () => {
      const onNext = vi.fn().mockResolvedValue(undefined);
      const { result } = await mount(series(NEXT), onNext);
      emit('duration', 100);
      emit('pause', true);
      emit('time-pos', 92);
      expect(result.current.showBingePopup).toBe(true);
      act(() => { vi.advanceTimersByTime(30_000); });
      expect(result.current.bingeCountdown).toBe(10);
      expect(onNext).not.toHaveBeenCalled();
      emit('pause', false);
      act(() => { vi.advanceTimersByTime(10_000); });
      expect(onNext).toHaveBeenCalledTimes(1);
    });

    it('Annuler pendant la pause, puis reprise : le décompte ne repart pas', async () => {
      const onNext = vi.fn();
      const { result } = await mount(series(NEXT), onNext);
      emit('duration', 100);
      emit('time-pos', 90);
      emit('pause', true);
      act(() => { result.current.handleBingeCancel(); });
      emit('pause', false);
      emit('pause', false);
      act(() => { vi.advanceTimersByTime(20_000); });
      expect(result.current.showBingePopup).toBe(false);
      expect(onNext).not.toHaveBeenCalled();
    });

    it('Annuler : plus de décompte, et la fenêtre ne revient pas pour cet épisode', async () => {
      const onNext = vi.fn();
      const { result } = await mount(series(NEXT), onNext);
      emit('duration', 100);
      emit('time-pos', 95);
      act(() => { result.current.handleBingeCancel(); });
      expect(result.current.showBingePopup).toBe(false);
      act(() => { vi.advanceTimersByTime(20_000); });
      emit('time-pos', 97);
      expect(result.current.showBingePopup).toBe(false);
      expect(onNext).not.toHaveBeenCalled();
    });

    it('Lire maintenant : lance l\'épisode suivant une seule fois', async () => {
      const onNext = vi.fn();
      const { result } = await mount(series(NEXT), onNext);
      emit('duration', 100);
      emit('time-pos', 95);
      act(() => { result.current.handleBingePlayNow(); });
      act(() => { vi.advanceTimersByTime(20_000); });
      expect(onNext).toHaveBeenCalledTimes(1);
      expect(result.current.showBingePopup).toBe(false);
    });

    it('dernier épisode de la série, direct (durée inconnue) ou option désactivée : jamais de fenêtre', async () => {
      const last = await mount(series(null as unknown as SeriesMetadata['nextEpisode']), vi.fn());
      emit('duration', 100);
      emit('time-pos', 99);
      expect(last.result.current.showBingePopup).toBe(false);
      last.unmount();

      const live = await mount(series(NEXT), vi.fn());
      emit('time-pos', 5000);
      expect(live.result.current.showBingePopup).toBe(false);
      live.unmount();

      prefs.binge = false;
      const off = await mount(series(NEXT), vi.fn());
      emit('duration', 100);
      emit('time-pos', 99);
      expect(off.result.current.showBingePopup).toBe(false);
    });

    it('lecteur fermé pendant le décompte : l\'épisode suivant ne part pas', async () => {
      const onNext = vi.fn();
      const { unmount } = await mount(series(NEXT), onNext);
      emit('duration', 100);
      emit('time-pos', 95);
      unmount();
      act(() => { vi.advanceTimersByTime(20_000); });
      expect(onNext).not.toHaveBeenCalled();
    });
  });

  describe('statistiques', () => {
    it('met en forme les valeurs du moteur (image, son 5.1, images perdues additionnées)', async () => {
      const values: Record<string, unknown> = {
        'video-params': { w: 1920, h: 1080, pixelformat: 'yuv420p' },
        'video-codec': 'h264', 'audio-codec-name': 'aac', 'container-fps': 25,
        'video-bitrate': 4_000_000, 'audio-bitrate': 128_000,
        'frame-drop-count': 2, 'decoder-frame-drop-count': 3,
        'demuxer-cache-state': { 'cache-duration': 12 },
        'audio-params': { 'channel-count': 6 },
      };
      getProperty.mockImplementation(async (name: string) => values[name] ?? null);
      const { result } = await mount(undefined, undefined, { stats: true });
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(result.current.geekStats).toMatchObject({
        width: 1920, height: 1080, videoCodec: 'h264', fps: 25, dropFrames: 5,
        bufferSeconds: 12, hwdec: 'sw', pixelFormat: 'yuv420p', audioChannels: '5.1',
      });
    });

    it('moteur muet : statistiques vides, pas de plantage, nouveau relevé 2 s plus tard', async () => {
      getProperty.mockRejectedValue(new Error('timeout'));
      const { result } = await mount(undefined, undefined, { stats: true });
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(result.current.geekStats).toMatchObject({ width: 0, audioChannels: 'N/A', hwdec: 'sw' });
      const calls = getProperty.mock.calls.length;
      await act(async () => { await vi.advanceTimersByTimeAsync(GEEK_STATS_INTERVAL_MS); });
      expect(getProperty.mock.calls.length).toBeGreaterThan(calls);
    });

    it.each([[1, 'Mono'], [2, 'Stereo'], [8, '7.1'], [4, '4ch']])('%i canaux → %s', async (count, label) => {
      getProperty.mockImplementation(async (name: string) => (name === 'audio-params' ? { 'channel-count': count } : null));
      const { result } = await mount(undefined, undefined, { stats: true });
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(result.current.geekStats.audioChannels).toBe(label);
    });
  });
});
