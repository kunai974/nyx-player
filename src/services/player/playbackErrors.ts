/**
 * playbackErrors.ts — Erreurs de lecture communes à tous les moteurs (mpv.exe desktop, libmpv Android).
 *
 * Chaque moteur remonte ce qu'il sait (code HTTP, code d'erreur natif) ; ce module le traduit
 * en une catégorie compréhensible par l'utilisateur et décide si une reconnexion automatique
 * est permise.
 *
 * Reconnexion volontairement lente : les panels Xtream ont une protection anti-flood
 * (XUI : ~30 requêtes / 10 s par défaut, blocage d'IP possible). 4 tentatives espacées
 * de 15 à 60 s = 5 requêtes en 2 min 30, très loin de ces seuils.
 */

export type PlaybackErrorKind =
  /** HTTP 458 (Xtream), 460, 429, 509 : trop de flux simultanés sur le compte (ou lecteur refusé) */
  | 'connection_limit'
  /** 401 / 403 / 405 / 407 : compte expiré, IP bloquée, accès refusé */
  | 'access_denied'
  /** 404 / 410 : contenu retiré chez le fournisseur */
  | 'not_found'
  /** 5xx */
  | 'server'
  /** Pas de réponse, coupure, délai dépassé */
  | 'network'
  /** Codec / profil non décodable par le moteur de lecture actif */
  | 'unsupported_format'
  /** Décodable mais trop lourd pour l'appareil (Dolby Vision 5 décodé par le processeur) */
  | 'device_too_slow'
  /** Identifiants du fournisseur introuvables dans le coffre de l'appareil (rien n'a été lancé) */
  | 'missing_credentials'
  /** Adresse du flux impossible à construire (contenu sans identifiant exploitable) */
  | 'invalid_stream'
  /** Flux HTTPS refusé : certificats de l'appareil illisibles, connexion impossible à vérifier */
  | 'tls_unavailable'
  /** Le moteur de lecture s'est arrêté pendant la lecture (mpv.exe planté ou fermé, Windows) */
  | 'engine_stopped'
  | 'unknown';

export interface PlaybackError {
  kind: PlaybackErrorKind;
  /** Code HTTP renvoyé par le fournisseur, si connu */
  httpStatus?: number;
  /** Détail technique court, sans URL (ex. « H.264 10 bits (avc1.6E0028) ») */
  detail?: string;
  /** Moteur qui a produit l'erreur (mpv, libmpv) */
  engine?: string;
  /** La lecture continue derrière le message : l'utilisateur peut « Continuer quand même » (appareil trop lent) */
  continuable?: boolean;
  /** Déjà constaté sur cet appareil pour ce format : prévenu dès le début de la lecture */
  known?: boolean;
}

/**
 * Délais (secondes) avant chaque nouvelle tentative automatique : 4 relances sur ~6 min 30.
 * Desktop = 2 requêtes par tentative (MPV + sonde du code HTTP) → ≤ 10 requêtes en 6 min 30,
 * soit plus de 100 fois sous le seuil anti-flood XUI par défaut (30 requêtes / 10 s).
 */
export const RETRY_DELAYS_S: readonly number[] = [30, 60, 120, 180];

/** Intervalle minimal entre deux relances, quelle qu'en soit l'origine (anti-spam du bouton). */
export const RETRY_MIN_INTERVAL_MS = 15_000;

/**
 * Lecture réellement rétablie après une relance : la position doit avoir avancé d'autant de secondes
 * (image qui défile, pas seulement « aucune erreur »). Avant, un simple délai de 20 s sans erreur
 * remettait le compteur à zéro, alors qu'un flux bloqué en mise en tampon ne se signale qu'après 25 s
 * (useStallWatchdog) : le compteur ne montait jamais et les relances ne s'arrêtaient plus.
 */
export const RECOVERY_PLAYBACK_S = 60;

export function classifyHttpStatus(status: number | undefined | null): PlaybackErrorKind {
  if (status === undefined || status === null || status <= 0) return 'network';
  // 460 : code propre à certains fournisseurs, même famille de refus que le 458 (retour Sentry du 01/11)
  if (status === 458 || status === 460 || status === 429 || status === 509) return 'connection_limit';
  if (status === 401 || status === 403 || status === 405 || status === 407) return 'access_denied';
  if (status === 404 || status === 410) return 'not_found';
  if (status >= 500) return 'server';
  if (status >= 200 && status < 400) return 'unknown';
  return 'unknown';
}

/**
 * Codes d'erreur du plugin natif Android (MpvEngine.kt).
 * MPV_LOAD_FAILED sans code HTTP = serveur injoignable / délai dépassé, comme la sonde desktop sans réponse.
 */
export function classifyNativeError(code: string | undefined, httpStatus?: number): PlaybackErrorKind {
  if (httpStatus !== undefined && httpStatus !== null && httpStatus > 0) return classifyHttpStatus(httpStatus);
  if (!code) return 'unknown';
  if (code === 'TLS_CA_UNAVAILABLE') return 'tls_unavailable';
  if (/TOO_SLOW/.test(code)) return 'device_too_slow';
  if (/DECODER|DECODING|FORMAT_UNSUPPORTED|EXCEEDS_CAPABILITIES|TRACK_UNSUPPORTED|NO_DECODER/.test(code)) {
    return 'unsupported_format';
  }
  if (/LOAD_FAILED|NETWORK|TIMEOUT|CONNECTION|UNREACHABLE|STREAM_ENDED/.test(code)) return 'network';
  if (/BAD_HTTP_STATUS/.test(code)) return 'unknown';
  return 'unknown';
}

/** Une reconnexion automatique n'a de sens que si le problème peut disparaître tout seul. */
export function isAutoRetryable(kind: PlaybackErrorKind): boolean {
  return kind === 'connection_limit' || kind === 'server' || kind === 'network';
}

// ---------------------------------------------------------------------------
// Diffusion des erreurs (moteurs → PlayerContext)
// ---------------------------------------------------------------------------

type Listener = (error: PlaybackError) => void;
const listeners = new Set<Listener>();

export function emitPlaybackError(error: PlaybackError): void {
  for (const listener of listeners) listener(error);
}

export function subscribePlaybackErrors(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
