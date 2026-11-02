/**
 * useMpvObserver.ts — Observation des propriétés MPV
 *
 * Écoute les 13 propriétés du lecteur vidéo (pause, time-pos, duration,
 * volume, mute, seeking, aid, sid, speed, paused-for-cache, sub-scale, eof-reached, track-list)
 * et expose l'état résultant.
 *
 * Gère aussi :
 * - La détection de fin de seek (via progression time-pos)
 * - Le Binge Mode (countdown + auto-play épisode suivant)
 * - Le polling des Geek Stats (résolution, codec, FPS, bitrate...)
 *
 * La position (`time-pos`) arrive à chaque image sous Windows (25 à 60 fois par seconde) : l'état
 * React n'est mis à jour qu'environ 4 fois par seconde. La valeur exacte reste lisible
 * dans `currentTimeRef`, pour les sauts et raccourcis.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { getProperty, observeProperties } from '../services/player/mpvApi';
import { warnOnReject } from '../utils/warnOnReject';
import { isBingeModeEnabled, getBingeCountdown } from '../services/preferencesService';
import type { GeekStats } from '../types/player';
import type { SeriesMetadata } from '../types/player';
import { createLogger } from '../utils/logger';

const log = createLogger('useMpvObserver');

// ============================================================================
// TYPES
// ============================================================================

interface MpvObserverState {
  isPaused: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  isMuted: boolean;
  isLoading: boolean;
  isSeeking: boolean;
  isBuffering: boolean;
  /** Fin du flux atteinte (keep-open : mpv reste en pause sur la dernière image) */
  isEndOfFile: boolean;
  currentAudioId: number;
  currentSubId: number;
  playbackSpeed: number;
  subtitleScale: number;
  /** Binge Mode */
  showBingePopup: boolean;
  bingeCountdown: number;
  /** Geek Stats */
  geekStats: GeekStats;
  /** Incrémenté à chaque changement de la liste des pistes (usePlayerPreferences relit les pistes) */
  trackListRevision: number;
  /** Setters exposés pour les interactions UI */
  setIsSeeking: (v: boolean) => void;
  setCurrentTime: (v: number) => void;
  setVolumeState: React.Dispatch<React.SetStateAction<number>>;
  setIsMuted: React.Dispatch<React.SetStateAction<boolean>>;
  /** Binge Mode actions */
  handleBingePlayNow: () => void;
  handleBingeCancel: () => void;
  /** Re-sync state from MPV (after external setProperty calls) */
  syncFromMpv: () => Promise<void>;
  /** Refs exposées pour les handlers UI */
  seekTimeoutRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
  timePosUpdatesRef: React.MutableRefObject<number>;
  volumeRef: React.MutableRefObject<number>;
  /** Position et durée exactes, sans attendre la prochaine mise à jour de l'affichage */
  currentTimeRef: React.MutableRefObject<number>;
  durationRef: React.MutableRefObject<number>;
  bingeIntervalRef: React.MutableRefObject<ReturnType<typeof setInterval> | null>;
}

/**
 * Intervalle minimal entre deux mises à jour de la position affichée. Sous 250 ms : Android envoie
 * déjà la position toutes les 250 ms (MpvEngine), un seuil égal en sauterait une sur deux.
 */
export const TIME_POS_UI_INTERVAL_MS = 200;
/** Écart de position traité comme un saut (seek, nouveau flux) : affiché sans attendre */
const TIME_POS_JUMP_S = 1;
/** Relevé des statistiques du lecteur */
export const GEEK_STATS_INTERVAL_MS = 2000;

// ============================================================================
// HELPERS
// ============================================================================

/** Format audio channel count to human-readable label */
const formatChannelCount = (count: number): string => {
  switch (count) {
    case 1: return 'Mono';
    case 2: return 'Stereo';
    case 6: return '5.1';
    case 8: return '7.1';
    default: return count > 0 ? `${count}ch` : 'N/A';
  }
};

// ============================================================================
// HOOK
// ============================================================================

export function useMpvObserver(
  isConnected: boolean,
  seriesMetadata: SeriesMetadata | undefined,
  onNextEpisode: (() => Promise<void>) | undefined,
  showGeekStats: boolean,
): MpvObserverState {
  // ---- State ----
  const [isPaused, setIsPaused] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolumeState] = useState(100);
  const [isMuted, setIsMuted] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const isLoadingRef = useRef(true);
  const [isSeeking, setIsSeekingState] = useState(false);
  /** Même valeur que isSeeking, lisible dans l'écouteur : pas de mise à jour d'état à chaque position */
  const isSeekingRef = useRef(false);
  const setIsSeeking = useCallback((v: boolean) => {
    isSeekingRef.current = v;
    setIsSeekingState(v);
  }, []);
  const [isBuffering, setIsBuffering] = useState(false);
  const [isEndOfFile, setIsEndOfFile] = useState(false);
  const [currentAudioId, setCurrentAudioId] = useState<number>(1);
  const [currentSubId, setCurrentSubId] = useState<number>(0);
  const [playbackSpeed, setPlaybackSpeed] = useState(1.0);
  const [subtitleScale, setSubtitleScale] = useState(1);
  const [trackListRevision, setTrackListRevision] = useState(0);

  // Binge Mode state
  const [showBingePopup, setShowBingePopup] = useState(false);
  const [bingeCountdown, setBingeCountdown] = useState(0);
  const bingeIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const bingeTriggeredRef = useRef(false);
  /** Secondes restantes du décompte : gardées pendant la pause pour reprendre au même point */
  const bingeRemainingRef = useRef(0);
  /** Lecture en pause, lisible dans l'écouteur et le décompte */
  const isPausedRef = useRef(false);

  // Geek Stats state
  const [geekStats, setGeekStats] = useState<GeekStats>({
    width: 0, height: 0, videoCodec: '', audioCodec: '',
    fps: 0, videoBitrate: 0, audioBitrate: 0, dropFrames: 0, bufferSeconds: 0,
    hwdec: '', pixelFormat: '', audioChannels: '',
  });

  // ---- Refs (anti-stale closures pour observeProperties) ----
  const durationRef = useRef(0);
  const showBingePopupRef = useRef(false);
  const seriesMetadataRef = useRef(seriesMetadata);
  const seekTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTimePosRef = useRef<number>(0);
  /** Une position est arrivée par l'abonnement (sinon elle est relue au démarrage, voir syncInitialFromMpv) */
  const timePosReceivedRef = useRef(false);
  const timePosUpdatesRef = useRef<number>(0);
  const volumeRef = useRef<number>(100);
  const currentTimeRef = useRef(0);
  /** Dernière position envoyée à l'affichage, et quand */
  const shownTimeRef = useRef({ at: 0, pos: 0 });
  const onNextEpisodeRef = useRef(onNextEpisode);

  // ---- Sync refs when props change ----
  useEffect(() => {
    seriesMetadataRef.current = seriesMetadata;
  }, [seriesMetadata]);

  useEffect(() => {
    onNextEpisodeRef.current = onNextEpisode;
  }, [onNextEpisode]);

  /** Position affichée tout de suite (saut demandé par l'interface) */
  const showCurrentTime = useCallback((pos: number) => {
    currentTimeRef.current = pos;
    shownTimeRef.current = { at: Date.now(), pos };
    setCurrentTime(pos);
  }, []);

  // ---- Binge Mode handlers ----
  const stopBingeTicker = useCallback(() => {
    if (bingeIntervalRef.current) {
      clearInterval(bingeIntervalRef.current);
      bingeIntervalRef.current = null;
    }
  }, []);

  /**
   * Décompte de l'épisode suivant, une seconde à la fois depuis bingeRemainingRef. Arrêté pendant la
   * pause et relancé à la reprise : sinon l'épisode suivant partait alors que l'utilisateur avait mis
   * en pause. Lancer l'épisode suivant hors d'une fonction de mise à jour d'état : React rejoue
   * ces fonctions sous StrictMode, l'épisode partait deux fois en mode développement.
   */
  const startBingeTicker = useCallback(() => {
    if (bingeIntervalRef.current || !showBingePopupRef.current || isPausedRef.current) return;
    bingeIntervalRef.current = setInterval(() => {
      bingeRemainingRef.current -= 1;
      if (bingeRemainingRef.current > 0) {
        setBingeCountdown(bingeRemainingRef.current);
        return;
      }
      if (bingeIntervalRef.current) {
        clearInterval(bingeIntervalRef.current);
        bingeIntervalRef.current = null;
      }
      showBingePopupRef.current = false;
      setShowBingePopup(false);
      setBingeCountdown(0);
      void onNextEpisodeRef.current?.();
    }, 1000);
  }, []);

  const handleBingePlayNow = useCallback(() => {
    stopBingeTicker();
    showBingePopupRef.current = false;
    setShowBingePopup(false);
    void onNextEpisodeRef.current?.();
  }, [stopBingeTicker]);

  const handleBingeCancel = useCallback(() => {
    stopBingeTicker();
    showBingePopupRef.current = false;
    setShowBingePopup(false);
    // Garde bingeTriggeredRef à true pour éviter le re-trigger immédiat
  }, [stopBingeTicker]);

  // ---- Re-sync state from MPV (for values set by usePlayerPreferences) ----
  const syncFromMpv = useCallback(async () => {
    try {
      const [speed, aid, sid] = await Promise.all([
        getProperty('speed').catch(() => null),
        getProperty('aid').catch(() => null),
        getProperty('sid').catch(() => null),
      ]);
      if (typeof speed === 'number') setPlaybackSpeed(speed);
      if (typeof aid === 'number') setCurrentAudioId(aid);
      if (typeof sid === 'number') setCurrentSubId(sid);
    } catch (e) {
      log.warn('syncFromMpv failed:', e);
    }
  }, []);

  /**
   * Volume, sourdine, durée et position relus dans mpv : l'affichage part de l'état réel, pas des
   * valeurs par défaut. La durée n'est envoyée qu'une fois, au chargement du fichier : un abonnement
   * pris juste après la perdait (durée 0 : position jamais enregistrée ni reprise, vu au banc).
   * La position aussi : sans elle, le lecteur affichait 0:00 (et son attente) jusqu'à la position
   * suivante, pour toujours si la lecture était en pause (vu au banc, lecteur simulé fidèle).
   */
  const syncInitialFromMpv = useCallback(async (isDisposed: () => boolean) => {
    const [mute, vol, dur, pos] = await Promise.all([
      getProperty('mute').catch(() => null),
      getProperty('volume').catch(() => null),
      getProperty('duration').catch(() => null),
      getProperty('time-pos').catch(() => null),
    ]);
    if (isDisposed()) return;
    // Une position déjà reçue par l'abonnement (plus récente) n'est jamais remplacée
    if (typeof pos === 'number' && pos >= 0 && !timePosReceivedRef.current) {
      lastTimePosRef.current = pos;
      showCurrentTime(pos);
      if (pos > 0 && isLoadingRef.current) {
        isLoadingRef.current = false;
        setIsLoading(false);
      }
    }
    // Une durée déjà reçue par l'abonnement (plus récente) n'est jamais remplacée
    if (typeof dur === 'number' && dur > 0 && durationRef.current === 0) {
      durationRef.current = dur;
      setDuration(dur);
    }
    if (typeof mute === 'boolean') setIsMuted(mute);
    if (typeof vol === 'number') {
      volumeRef.current = vol;
      setVolumeState(vol);
    }
  }, [showCurrentTime]);

  // ---- observeProperties ----
  useEffect(() => {
    if (!isConnected) return;

    // Démonté (ou déconnecté) avant la fin de l'abonnement : l'écouteur est retiré dès son arrivée,
    // sinon ouvrir et fermer vite le lecteur accumulait des écouteurs
    let disposed = false;
    let unlisten: UnlistenFn | null = null;

    observeProperties(
      [
        'pause', 'time-pos', 'duration', 'volume', 'mute',
        'seeking', 'aid', 'sid', 'speed', 'paused-for-cache', 'sub-scale', 'eof-reached', 'track-list',
      ],
      ({ name, data }) => {
        if (disposed) return;
        switch (name) {
          case 'pause':
            isPausedRef.current = data === true;
            setIsPaused(data as boolean);
            // Position exacte à l'arrêt : la dernière valeur a pu être retenue par la limite d'affichage
            if (data === true) showCurrentTime(currentTimeRef.current);
            // Décompte de l'épisode suivant figé pendant la pause, repris au même point ensuite
            if (isPausedRef.current) stopBingeTicker();
            else startBingeTicker();
            break;

          case 'time-pos': {
            timePosReceivedRef.current = true;
            const pos = (data as number) || 0;
            currentTimeRef.current = pos;
            const now = Date.now();
            const shown = shownTimeRef.current;
            if (
              pos === 0 ||
              Math.abs(pos - shown.pos) >= TIME_POS_JUMP_S ||
              now - shown.at >= TIME_POS_UI_INTERVAL_MS
            ) {
              shownTimeRef.current = { at: now, pos };
              setCurrentTime(pos);
            }

            // Initial loading (une seule mise à jour : pas de rendu à chaque position)
            if (pos > 0 && isLoadingRef.current) {
              isLoadingRef.current = false;
              setIsLoading(false);
            }

            // Detect playback progression to clear seeking state
            if (pos > 0) {
              const delta = pos - lastTimePosRef.current;
              if (delta > 0 && delta < 2) {
                timePosUpdatesRef.current++;
                if (timePosUpdatesRef.current >= 2) {
                  if (seekTimeoutRef.current) {
                    clearTimeout(seekTimeoutRef.current);
                    seekTimeoutRef.current = null;
                  }
                  if (isSeekingRef.current) setIsSeeking(false);
                  timePosUpdatesRef.current = 0;
                }
              }
            }

            // ---- BINGE MODE: Trigger popup before end ----
            const bingeCountdownSeconds = getBingeCountdown();
            const triggerTime = durationRef.current - bingeCountdownSeconds;

            if (
              isBingeModeEnabled() &&
              seriesMetadataRef.current?.nextEpisode &&
              durationRef.current > 0 &&
              pos >= triggerTime &&
              !bingeTriggeredRef.current &&
              !showBingePopupRef.current
            ) {
              bingeTriggeredRef.current = true;
              showBingePopupRef.current = true;
              setShowBingePopup(true);
              setBingeCountdown(bingeCountdownSeconds);
              bingeRemainingRef.current = bingeCountdownSeconds;
              // Ne démarre pas si la lecture est en pause : il partira à la reprise
              startBingeTicker();
            }

            lastTimePosRef.current = pos;
            break;
          }

          case 'duration': {
            const dur = (data as number) || 0;
            setDuration(dur);
            durationRef.current = dur;
            break;
          }

          case 'volume': {
            const vol = (data as number) ?? 100;
            volumeRef.current = vol;
            setVolumeState(vol);
            break;
          }

          case 'mute':
            setIsMuted(data as boolean);
            break;

          case 'seeking': {
            const isMpvSeeking = data as boolean;
            if (!isMpvSeeking) {
              if (seekTimeoutRef.current) {
                clearTimeout(seekTimeoutRef.current);
                seekTimeoutRef.current = null;
              }
              setIsSeeking(false);
            }
            break;
          }

          case 'paused-for-cache':
            setIsBuffering(data as boolean);
            break;

          case 'eof-reached':
            // Indisponible (null) pendant le chargement d'un nouveau flux = pas en fin (desktop et Android)
            setIsEndOfFile(data === true);
            break;

          case 'aid':
            setCurrentAudioId((data as number) || 1);
            break;

          case 'sid':
            setCurrentSubId((data as number) || 0);
            break;

          case 'speed':
            setPlaybackSpeed((data as number) || 1);
            break;

          case 'sub-scale':
            setSubtitleScale((data as number) ?? 1);
            break;

          case 'track-list':
            // Android signale le changement sans la liste : usePlayerPreferences la relit dans tous les cas
            setTrackListRevision((r) => r + 1);
            break;
        }
      }
    ).then((fn) => {
      if (disposed) {
        fn();
        return;
      }
      unlisten = fn;
      // Sous Windows, mpv.exe survit à la fermeture du lecteur et l'abonnement ne renvoie que les
      // changements : sans cette lecture, un son coupé au lecteur précédent restait coupé alors que
      // l'icône le montrait actif, et ni la sourdine ni la barre ne le rétablissaient
      return syncInitialFromMpv(() => disposed);
    }).catch(warnOnReject('MpvObserver'));

    return () => {
      disposed = true;
      unlisten?.();
      unlisten = null;
    };
  }, [isConnected, showCurrentTime, setIsSeeking, syncInitialFromMpv, startBingeTicker, stopBingeTicker]);

  // ---- Geek Stats polling ----
  useEffect(() => {
    if (!isConnected || !showGeekStats) return;

    // Un relevé à la fois : le suivant n'est programmé qu'une fois le précédent terminé. Avec un
    // intervalle fixe, un mpv lent faisait se chevaucher les relevés, affichés dans le désordre
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const fetchStats = async () => {
      try {
        const [
          videoParams, videoCodec, audioCodec, fps,
          videoBitrate, audioBitrate, dropFrames, cacheState,
          hwdecCurrent, audioParams,
        ] = await Promise.all([
          getProperty('video-params').catch(() => null),
          getProperty('video-codec').catch(() => null),
          getProperty('audio-codec-name').catch(() => null),
          getProperty('container-fps').catch(() => null),
          getProperty('video-bitrate').catch(() => null),
          getProperty('audio-bitrate').catch(() => null),
          // mpv 0.41 : `drop-frame-count` n'existe plus → images perdues au rendu + au décodage
          Promise.all([
            getProperty('frame-drop-count').catch(() => null),
            getProperty('decoder-frame-drop-count').catch(() => null),
          ]).then(([vo, decoder]) => (Number(vo) || 0) + (Number(decoder) || 0)),
          getProperty('demuxer-cache-state').catch(() => null),
          getProperty('hwdec-current').catch(() => null),
          getProperty('audio-params').catch(() => null),
        ]);

        const vp = videoParams as { w?: number; h?: number; pixelformat?: string } | null;
        const cache = cacheState as { 'cache-duration'?: number } | null;
        const ap = audioParams as { 'channel-count'?: number } | null;

        if (stopped) return;
        setGeekStats({
          width: vp?.w || 0,
          height: vp?.h || 0,
          videoCodec: (videoCodec as string) || '',
          audioCodec: (audioCodec as string) || '',
          fps: (fps as number) || 0,
          videoBitrate: (videoBitrate as number) || 0,
          audioBitrate: (audioBitrate as number) || 0,
          dropFrames: (dropFrames as number) || 0,
          bufferSeconds: cache?.['cache-duration'] || 0,
          hwdec: (hwdecCurrent as string) || 'sw',
          pixelFormat: vp?.pixelformat || '',
          audioChannels: formatChannelCount(ap?.['channel-count'] || 0),
        });
      } catch (e) {
        log.error('Failed to fetch geek stats:', e);
      }
    };

    const poll = async () => {
      await fetchStats();
      if (!stopped) timer = setTimeout(() => { void poll(); }, GEEK_STATS_INTERVAL_MS);
    };
    void poll();

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [isConnected, showGeekStats]);

  // ---- Cleanup binge interval on unmount ----
  useEffect(() => stopBingeTicker, [stopBingeTicker]);

  return {
    isPaused, currentTime, duration, volume, isMuted,
    isLoading, isSeeking, isBuffering, isEndOfFile,
    currentAudioId, currentSubId, playbackSpeed, subtitleScale,
    showBingePopup, bingeCountdown, geekStats, trackListRevision,
    setIsSeeking, setCurrentTime: showCurrentTime, setVolumeState, setIsMuted,
    handleBingePlayNow, handleBingeCancel, syncFromMpv,
    seekTimeoutRef, timePosUpdatesRef, volumeRef, currentTimeRef, durationRef, bingeIntervalRef,
  };
}
