/**
 * mpvBridge.ts — Contrôle du lecteur MPV via tauri-plugin-mpv
 *
 * Responsabilités :
 * - Initialiser MPV (lazy, une seule fois ; relancé si mpv.exe s'est arrêté)
 * - Lancer / stopper la lecture
 * - Surveiller l'état de connexion MPV
 */

import {
  init,
  command,
  setProperty,
  listenDesktopEvents,
  isEngineAlive,
  isHttpsVerifiable,
  type MpvConfig,
} from './player/mpvApi';
import { invoke } from '@tauri-apps/api/core';
import { isHardwareAccelerationEnabled } from './appSettingsService';
import { createLogger } from '../utils/logger';
import { describeStreamForLog } from '../utils/sanitizeUrl';
import { isAndroid } from '../utils/platform';
import { classifyHttpStatus, emitPlaybackError } from './player/playbackErrors';
import { scheduleForcedUnpause, cancelForcedUnpause } from './player/forcedUnpause';
import { prises } from './outilsTest';

const log = createLogger('MPV');

// ============================================================================
// LOAD ERRORS (desktop)
// ============================================================================

/** Dernier flux demandé à MPV : permet de sonder le code HTTP quand le chargement échoue. */
let lastStreamUrl: string | null = null;
let loadErrorWatch: Promise<unknown> | null = null;

/**
 * MPV signale un échec de chargement (`end-file`, reason `error`) sans le code HTTP.
 * On sonde alors une seule fois l'URL côté Rust (requête Range 0-0, même User-Agent)
 * pour distinguer limite de connexions (458), accès refusé, contenu absent…
 * Une requête par échec seulement : aucun risque vis-à-vis de l'anti-flood du fournisseur.
 */
const watchDesktopLoadErrors = () => {
  if (isAndroid() || loadErrorWatch) return;
  loadErrorWatch = listenDesktopEvents(async (event) => {
    if (event.event !== 'end-file' || !('reason' in event) || event.reason !== 'error') return;
    const url = lastStreamUrl;
    if (!url) return;
    // Version du banc : jamais de sonde, aucune requête vers un flux, même d'un faux fournisseur (lecteur
    // simulé, dev/lecteurSimule.ts) ; seconde barrière si une adresse avait échappé au verrou de mpvApi
    if (import.meta.env.VITE_BANC === '1') return;
    // Flux HTTPS sans certificats pour le vérifier (export raté) : message clair, sans sonde
    if (/^https:/i.test(url) && !(await isHttpsVerifiable().catch(() => true))) {
      if (url === lastStreamUrl) emitPlaybackError({ kind: 'tls_unavailable', engine: 'mpv' });
      return;
    }
    let httpStatus: number | undefined;
    try {
      httpStatus = await invoke<number>('probe_stream_status', { url });
    } catch {
      httpStatus = undefined; // Serveur injoignable
    }
    // L'utilisateur a pu zapper pendant la sonde : ne pas afficher une erreur périmée
    if (url !== lastStreamUrl) return;
    // Flux HTTPS que le serveur sert bien mais que mpv n'a pas ouvert : certificat refusé par la
    // vérification de mpv (autorité absente du magasin de Windows, chaîne incomplète), à repérer
    // dans les journaux
    if (/^https:/i.test(url) && httpStatus !== undefined && httpStatus < 400) {
      log.warn(`HTTPS stream reachable (${httpStatus}) but not opened by mpv: certificate rejected? ${describeStreamForLog(url)}`);
    }
    emitPlaybackError({ kind: classifyHttpStatus(httpStatus), httpStatus, engine: 'mpv' });
  }).catch((e) => {
    loadErrorWatch = null;
    log.warn('Load error watch failed:', e);
  });
};

// ============================================================================
// CONNECTION STATE
// ============================================================================

let mpvInitialized = false;
let initPromise: Promise<void> | null = null;
let mpvConnectionState: 'disconnected' | 'connecting' | 'connected' | 'error' = 'disconnected';

const connectionListeners: ((state: typeof mpvConnectionState) => void)[] = [];

export const onMpvConnectionChange = (callback: (state: typeof mpvConnectionState) => void) => {
  connectionListeners.push(callback);
  // Immediately notify of current state
  callback(mpvConnectionState);
  return () => {
    const index = connectionListeners.indexOf(callback);
    if (index > -1) connectionListeners.splice(index, 1);
  };
};

const setConnectionState = (state: typeof mpvConnectionState) => {
  mpvConnectionState = state;
  connectionListeners.forEach((cb) => cb(state));
};

// ============================================================================
// MPV CONFIG
// ============================================================================

/** Construit la config à la volée. Le chemin de mpv.exe (ressource bundlée) est fixé côté Rust. */
const getMpvConfig = async (): Promise<MpvConfig> => {
  // Read hardware acceleration setting (pre-boot JSON, not SQLite)
  const hwAccel = await isHardwareAccelerationEnabled();

  return {
    args: [
      hwAccel ? '--vo=gpu-next' : '--vo=gpu-next,gpu', // Fallback VO when GPU disabled
      hwAccel ? '--hwdec=auto-safe' : '--hwdec=no',    // Software decoding when GPU disabled
      '--keep-open=yes',
      '--force-window',
      // User-Agent navigateur pour éviter le rejet par les serveurs IPTV
      '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      // Timeout 30s (évite chargement infini)
      '--network-timeout=30',
      // Force FFmpeg à NE PAS réutiliser les connexions TCP entre flux.
      // Sans ça, FFmpeg tente de réutiliser une connexion keep-alive que le serveur
      // a déjà fermée → bloque indéfiniment au prochain loadfile.
      '--stream-lavf-o=multiple_requests=0',
      // Cache réseau
      '--cache=yes',
      '--demuxer-max-bytes=50MiB',
      '--demuxer-max-back-bytes=25MiB',
      // Désactive youtube-dl hook (inutile pour IPTV)
      '--ytdl=no',

    ],
    observedProperties: [
      'pause',
      'time-pos',
      'duration',
      'filename',
      'seeking', // True when seeking in progress
      'paused-for-cache', // True when buffering/waiting for data
      'eof-reached', // keep-open : fin atteinte, mpv en pause sur la dernière image (direct coupé)
      'core-idle', // Alternative buffering indicator
      'volume',
      'mute',
      'aid', // Current audio track
      'sid', // Current subtitle track
      'speed', // Playback speed
      'sub-scale', // Subtitle scale
      'track-list', // Pistes audio/sous-titres connues : un direct n'a pas de durée pour signaler qu'il est prêt
    ],
    ipcTimeoutMs: 3000,
  };
};

// ============================================================================
// MPV COMMANDS
// ============================================================================

/**
 * Initialise MPV (lazy, une seule fois).
 * Pattern mutex : si un appel est déjà en cours, les appels suivants
 * attendent la même Promise au lieu de relancer une 2e init.
 */
const initMpv = async (): Promise<void> => {
  if (mpvInitialized) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    setConnectionState('connecting');
    try {
      // Android : libmpv intégrée au plugin natif, pas de binaire mpv ni d'arguments CLI
      const config = isAndroid() ? undefined : await getMpvConfig();
      await init(config);
      mpvInitialized = true;
      watchDesktopLoadErrors();
      watchEngineProcess();
      setConnectionState('connected');
    } catch (e) {
      initPromise = null; // Allow retry on failure
      setConnectionState('error');
      log.error('Init failed:', e);
      throw e;
    }
  })();

  return initPromise;
};

/**
 * Erreurs du plugin quand `mpv.exe` ne répond plus (processus arrêté ou planté) : le tube de
 * communication est fermé. Le plugin sait relancer mpv.exe si on lui redemande `init`.
 */
const ENGINE_GONE = /IPC communication error|mpv process failed/i;
/** Délai de réponse dépassé : mpv.exe est vivant mais lent, rien à relancer ni à recharger */
const ENGINE_SLOW = /Timeout/i;

const isEngineGone = (e: unknown): boolean =>
  !isAndroid() && ENGINE_GONE.test(String(e)) && !ENGINE_SLOW.test(String(e));

/**
 * mpv.exe s'est arrêté : l'état « initialisé » est oublié pour que le prochain `initMpv` relance le
 * processus. Le nouveau mpv part de zéro (aucun flux chargé).
 */
const forgetDeadEngine = (reason: unknown) => {
  log.warn('mpv.exe ne répond plus, relance du lecteur :', String(reason));
  stopEngineWatch();
  mpvInitialized = false;
  initPromise = null;
  // Par prudence (processus en fait vivant) : « start » sera remis à « none » au prochain chargement
  startOptionSet = true;
  streamLoaded = false;
  setConnectionState('disconnected');
};

/** Intervalle de vérification du processus mpv.exe (lecture d'un état côté Rust, sans IPC) */
export const ENGINE_WATCH_INTERVAL_MS = 2_000;

let engineWatch: ReturnType<typeof setInterval> | null = null;
let engineCheckPending = false;

const stopEngineWatch = () => {
  if (engineWatch) clearInterval(engineWatch);
  engineWatch = null;
};

/**
 * mpv.exe arrêté pendant une lecture (plantage, arrêt forcé) : le plugin ne le signale pas. Sans
 * cette surveillance, la page du lecteur restait ouverte, transparente et sans message.
 * Flux en cours → écran « Lecture interrompue » (Réessayer / Fermer) ; Réessayer relance mpv.exe.
 * Aucun flux → rien à afficher, mpv.exe sera relancé à la prochaine lecture.
 */
const watchEngineProcess = () => {
  if (isAndroid() || engineWatch) return;
  engineWatch = setInterval(() => {
    if (engineCheckPending) return;
    engineCheckPending = true;
    const sequence = loadSequence;
    Promise.resolve()
      .then(() => isEngineAlive())
      .then((alive) => {
        // Seul un « non » explicite compte (prévisualisation sans Tauri : réponse vide). Arrêt ou
        // relance entre-temps : ce résultat ne concerne plus le processus surveillé
        // Lancement, zap ou arrêt pendant la vérification : ce chargement relance lui-même mpv.exe
        // s'il le faut (sinon l'écran opaque cacherait une chaîne qui joue)
        if (alive !== false || !mpvInitialized || !engineWatch || sequence !== loadSequence) return;
        const wasPlaying = streamLoaded;
        forgetDeadEngine('processus mpv.exe terminé');
        lastStreamUrl = null;
        if (wasPlaying) emitPlaybackError({ kind: 'engine_stopped', engine: 'mpv' });
      })
      .catch((e) => log.warn('Engine check failed:', e))
      .finally(() => {
        engineCheckPending = false;
      });
  }, ENGINE_WATCH_INTERVAL_MS);
};

/** Options d'un lancement de flux */
export interface MpvLoadOptions {
  /** Chaîne en direct : vitesse et pistes repartent de leur valeur par défaut */
  live?: boolean;
}

/**
 * mpv garde vitesse et pistes d'un fichier à l'autre : un film regardé en ×1,5 sur la piste audio 2
 * passait ainsi ses réglages à la chaîne lancée ensuite (piste 2 absente = chaîne muette).
 * On remet donc les valeurs par défaut avant de charger un direct ; usePlayerPreferences applique
 * ensuite la langue ou le choix mémorisé pour la chaîne, dès que ses pistes sont connues. Films et épisodes ne sont pas concernés :
 * leurs choix sont réappliqués par contenu, et les pistes d'un épisode passent au suivant comme avant.
 */
const resetLiveSettings = async (): Promise<void> => {
  const defaults: Array<[string, number | string]> = [['speed', 1], ['aid', 'auto'], ['sid', 'auto']];
  // En parallèle : pas de latence ajoutée au zapping
  await Promise.all(defaults.map(([name, value]) => setProperty(name, value).catch((e) => {
    log.warn(`Could not reset ${name}:`, e);
  })));
};

/**
 * Numéro du dernier chargement demandé. Un lancement ou un zap dépassé par un plus récent (ou par un
 * arrêt) ne charge plus rien après ses attentes : en zappant vite, mpv lisait sinon la chaîne d'une
 * demande arrivée en retard.
 */
let loadSequence = 0;

/** Numéro du dernier chargement : change à chaque lancement, zap, relance ou arrêt (usePlayerPreferences). */
export const getLoadSequence = (): number => loadSequence;

/** Position de départ appliquée au prochain chargement (option `start` de mpv, gardée d'un fichier à l'autre). */
let startOptionSet = false;

/** Un flux a été chargé depuis le dernier arrêt : un second « stop » à la fermeture est inutile. */
let streamLoaded = false;

/**
 * Reprise d'un film : le flux s'ouvre directement à la bonne position (option `start`), au lieu de
 * s'ouvrir à 0 puis de sauter, ce qui faisait deux connexions au fournisseur. L'option
 * reste active pour les fichiers suivants : elle est remise à « none » dès qu'un chargement n'en a pas.
 */
const applyStartPosition = async (startPosition: number | undefined): Promise<void> => {
  const start = startPosition && startPosition > 0 ? startPosition : 0;
  if (!start && !startOptionSet) return;
  // Posé avant l'attente : un zap arrivé entre-temps saura qu'il faut remettre « none »
  startOptionSet = start > 0 || startOptionSet;
  try {
    await setProperty<string>('start', start ? String(start) : 'none');
    startOptionSet = start > 0;
  } catch (e) {
    // Sans l'option, usePlayerPreferences replace la lecture à la bonne position après chargement
    log.warn('Could not set start position:', e);
  }
};

/** Relance la lecture 500 ms après le chargement, sauf pause demandée entre-temps (forcedUnpause). */
const scheduleUnpause = (label: string) => {
  scheduleForcedUnpause(() => {
    setProperty('pause', false).catch((e) => log.warn(`Could not force unpause${label}:`, e));
  }, 500);
};

/**
 * Réglages du flux puis `loadfile`. Si mpv.exe s'est arrêté entre deux lectures, il est relancé et le
 * chargement refait une fois : sans ça, plus rien ne se lisait avant de relancer l'app.
 * Rend `false` si un chargement plus récent (ou un arrêt) a pris la main.
 */
const loadStream = async (
  url: string,
  sequence: number,
  startPosition: number | undefined,
  options: MpvLoadOptions | undefined,
  label: string,
): Promise<boolean> => {
  for (let attempt = 0; ; attempt++) {
    if (options?.live) await resetLiveSettings();
    await applyStartPosition(startPosition);
    if (sequence !== loadSequence) return false;

    log.info(label, describeStreamForLog(url));
    lastStreamUrl = url;
    streamLoaded = true;
    try {
      await command('loadfile', [url, 'replace']);
    } catch (e) {
      // Version du banc : lecture refusée par le verrou du banc (mpvApi). Rien à sonder : la sonde
      // Rust enverrait sinon une vraie requête vers l'adresse refusée au prochain « end-file ».
      if (import.meta.env.VITE_BANC === '1' && prises.bancLecteur?.estLectureRefusee(e)) lastStreamUrl = null;
      if (attempt > 0 || !isEngineGone(e)) throw e;
      forgetDeadEngine(e);
      await initMpv();
      if (sequence !== loadSequence) return false;
      continue;
    }
    return sequence === loadSequence;
  }
};

export const mpvPlay = async (url: string, startPosition?: number, options?: MpvLoadOptions): Promise<void> => {
  const sequence = ++loadSequence;
  cancelForcedUnpause();
  await initMpv();
  if (sequence !== loadSequence) return;

  // Stop le flux précédent (desktop). Android : play remplace déjà le flux en cours, et le stop natif
  // sortirait du plein écran → rotation portrait/paysage à chaque lecture ou nouvelle tentative.
  if (!isAndroid()) {
    try {
      await command('stop');
    } catch (e) {
      // « stop » réussit même sans flux : un échec ici veut dire que mpv.exe s'est arrêté
      if (isEngineGone(e)) {
        forgetDeadEngine(e);
        await initMpv();
        if (sequence !== loadSequence) return;
      }
    }
  }

  if (!(await loadStream(url, sequence, startPosition, options, 'loadfile →'))) return;

  // Force unpause after a small delay to ensure playback starts
  scheduleUnpause('');
};

/**
 * Change le stream MPV à chaud (sans cycle stop/transition).
 * Utilisé par le Channel Switcher pour le zapping live.
 *
 * Différence vs mpvPlay : pas de command('stop') préalable,
 * pas de latence. loadfile 'replace' remplace nativement le flux en cours.
 */
export const mpvSwitchChannel = async (url: string, options?: MpvLoadOptions): Promise<void> => {
  const sequence = ++loadSequence;
  cancelForcedUnpause();
  await initMpv();
  if (sequence !== loadSequence) return;
  if (!(await loadStream(url, sequence, undefined, options, 'switchChannel →'))) return;

  // Force unpause (sécurité — certains flux IPTV démarrent en pause)
  scheduleUnpause(' after switch');
};

/**
 * Arrête la lecture. Appelé par la fermeture du lecteur (PlayerControls) puis par PlayerContext.stop :
 * un seul « stop » part vers le moteur. Android : le stop natif sort aussi du plein écran.
 */
export const mpvStop = async (): Promise<void> => {
  // Un lancement encore en attente ne chargera plus rien, et sa reprise automatique ne partira pas
  loadSequence++;
  cancelForcedUnpause();
  lastStreamUrl = null;
  if (!streamLoaded) return;
  streamLoaded = false;
  try {
    await command('stop');
  } catch (e) {
    // mpv.exe arrêté : plus rien à couper, il sera relancé à la prochaine lecture
    if (!isEngineGone(e)) throw e;
    forgetDeadEngine(e);
  }
};
