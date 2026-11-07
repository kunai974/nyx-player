/**
 * guestRelay.ts — Fiches TMDB sans compte, par le relais de Nyx.
 *
 * Un invité (« Continuer sans compte ») reçoit, à sa première demande de fiche, un compte anonyme de
 * Supabase : c'est son identité d'appareil auprès du relais, qui compte ses demandes (par minute, par
 * jour, par adresse internet, et pour tous les invités ensemble). Ce compte ne sert qu'au relais :
 *   - il vit dans un SECOND client Supabase, rangé sous sa propre clé, en stockage simple. Le client
 *     principal (connexion, synchro, « session expirée », suppression de compte) ne le voit jamais ;
 *   - la base refuse de toute façon à un compte anonyme toute lecture ou écriture de ses tables.
 *
 * L'app reste sous les limites du relais : au plus 25 demandes par minute (on attend la minute
 * suivante) et 290 par jour. Après un refus du relais (jour, adresse, budget commun, relais coupé),
 * plus aucune demande avant l'heure de reprise qu'il donne, même après un redémarrage : chaque appel
 * refusé compte quand même dans le quota de Nyx. En attendant, les fiches viennent du fournisseur.
 * Rien ici n'est journalisé avec le jeton ni l'identifiant de l'invité.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getOpenLocalSpace } from './localSpace';
import { supabaseStorageKey } from './authStorage';
import { createLogger } from '../utils/logger';

const log = createLogger('TMDB');

/** Clé de rangement de la session de l'invité, distincte de celle d'un compte */
export const GUEST_RELAY_STORAGE_KEY = `${supabaseStorageKey(import.meta.env.VITE_SUPABASE_URL)}-guest-relay`;
/** Pause des demandes au relais (heure de reprise), retenue après un redémarrage */
export const GUEST_RELAY_PAUSE_KEY = 'nyx_guest_relay_pause';
/** Compte du jour (temps universel), pour rester sous la limite du relais */
export const GUEST_RELAY_DAY_KEY = 'nyx_guest_relay_day';
/** Heure de la dernière création d'un invité : une au plus par intervalle, même après un redémarrage */
export const GUEST_RELAY_CREATED_KEY = 'nyx_guest_relay_created';

/** Sous les limites du relais (30 par minute, 300 par jour) */
export const GUEST_MINUTE_LIMIT = 25;
export const GUEST_DAY_LIMIT = 290;
/** Les remplissages en arrière-plan s'arrêtent avant, pour laisser les fiches à l'écran */
export const GUEST_BACKGROUND_LIMIT = Math.floor(GUEST_DAY_LIMIT * 0.8);
/**
 * Connexion anonyme refusée (trop de créations depuis cette adresse, hors ligne), ou invité refusé
 * par le relais : nouvel essai après. C'est aussi l'écart minimal entre deux créations d'invité, pour
 * qu'un relais qui refuserait tous les invités ne fasse pas créer un compte à chaque fiche.
 */
const SIGN_IN_RETRY_MS = 10 * 60 * 1000;
/** Relais injoignable ou limites indisponibles : nouvel essai après */
const UNAVAILABLE_RETRY_MS = 60 * 1000;

let client: SupabaseClient | null = null;
let signingIn: Promise<string | null> | null = null;
let signInFailedAt = 0;
let minuteStart = 0;
let minuteCount = 0;

/** Tests : remplace l'horloge et l'attente */
let now = () => Date.now();
let sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Copie en mémoire : sans stockage, la pause et les compteurs valent au moins pour cette session */
const memory = new Map<string, unknown>();
/** Clés dont la dernière écriture n'a pas pu être rangée (stockage plein) : la mémoire fait foi */
const unsaved = new Set<string>();

function readJson<T>(key: string): T | null {
  if (unsaved.has(key)) return (memory.get(key) as T | undefined) ?? null;
  let raw: string | null;
  try {
    raw = localStorage.getItem(key);
  } catch {
    return (memory.get(key) as T | undefined) ?? null; // stockage indisponible : copie en mémoire
  }
  try {
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  memory.set(key, value);
  try {
    localStorage.setItem(key, JSON.stringify(value));
    unsaved.delete(key);
  } catch {
    unsaved.add(key);
    /* sans stockage : la copie en mémoire suffit pour cette session */
  }
}

const utcDay = (t: number) => new Date(t).toISOString().slice(0, 10);
const nextUtcMidnight = (t: number) => {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
};

function dayCount(): number {
  const stored = readJson<{ day: string; n: number }>(GUEST_RELAY_DAY_KEY);
  return stored && stored.day === utcDay(now()) && Number.isFinite(stored.n) ? stored.n : 0;
}

/** Pause en cours : heure de reprise, et `long` pour une limite du jour (montrée dans Réglages) */
interface Pause { until: number; long: boolean }

function currentPause(): Pause | null {
  const stored = readJson<Pause>(GUEST_RELAY_PAUSE_KEY);
  return stored && typeof stored.until === 'number' && stored.until > now() ? stored : null;
}

function pausedUntil(): number {
  return currentPause()?.until ?? 0;
}

function pause(until: number, long = false): void {
  writeJson(GUEST_RELAY_PAUSE_KEY, { until, long });
}

/** Vrai pendant l'espace invité */
function inGuestSpace(): boolean {
  return getOpenLocalSpace()?.kind === 'guest';
}

/**
 * Vrai si les fiches TMDB de l'invité passent par le relais aujourd'hui, sans rien créer ni envoyer
 * (les rangées TMDB de l'accueil s'affichent alors). Une pause courte (une minute, une connexion
 * anonyme à réessayer) n'y change rien : l'accueil ne se recalcule pas à sa fin.
 */
export function isGuestRelayAvailable(): boolean {
  return inGuestSpace() && !currentPause()?.long && dayCount() < GUEST_DAY_LIMIT;
}

/** Vrai si une demande peut partir maintenant (aucune pause, même courte) */
function canAskNow(): boolean {
  return isGuestRelayAvailable() && pausedUntil() === 0 && now() - signInFailedAt >= SIGN_IN_RETRY_MS;
}

/** Vrai si un remplissage en arrière-plan peut encore utiliser le relais aujourd'hui */
export function guestRelayAllowsBackground(): boolean {
  return !inGuestSpace() || dayCount() < GUEST_BACKGROUND_LIMIT;
}

function guestClient(): SupabaseClient {
  if (!client) {
    client = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_ANON_KEY, {
      auth: {
        storageKey: GUEST_RELAY_STORAGE_KEY,
        storage: localStorage,
        persistSession: true,
        // Pas de renouvellement en arrière-plan (il ferait compter l'appareil comme utilisateur actif
        // chaque mois, même connecté à un compte) : getSession() renouvelle un jeton expiré à la demande
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    });
  }
  return client;
}

async function currentToken(): Promise<string | null> {
  const { data, error: sessionError } = await guestClient().auth.getSession();
  if (data.session?.access_token) return data.session.access_token;
  // Session illisible (renouvellement impossible, hors ligne) : pas de nouvel invité pour autant
  if (sessionError) {
    signInFailedAt = now();
    log.warn('guest relay session unavailable:', sessionError.name);
    return null;
  }
  const lastCreated = readJson<number>(GUEST_RELAY_CREATED_KEY);
  if (typeof lastCreated === 'number' && now() - lastCreated < SIGN_IN_RETRY_MS && lastCreated <= now()) {
    signInFailedAt = lastCreated;
    return null;
  }
  writeJson(GUEST_RELAY_CREATED_KEY, now());
  const { data: created, error } = await guestClient().auth.signInAnonymously();
  if (error || !created.session?.access_token) {
    signInFailedAt = now();
    log.warn('guest relay sign-in failed:', error?.name ?? 'no session');
    return null;
  }
  return created.session.access_token;
}

/** Attend la minute suivante quand l'app a déjà envoyé ses 25 demandes de la minute */
async function waitForMinuteSlot(): Promise<void> {
  for (;;) {
    // Minute calendaire, comme le compteur du relais
    const t = now();
    if (t - minuteStart >= 60_000) {
      minuteStart = Math.floor(t / 60_000) * 60_000;
      minuteCount = 0;
    }
    if (minuteCount < GUEST_MINUTE_LIMIT) {
      minuteCount += 1;
      return;
    }
    await sleep(minuteStart + 60_000 - t);
  }
}

/**
 * Jeton de l'invité pour UNE demande au relais (comptée tout de suite), ou null : pas dans l'espace
 * invité, relais en pause, compte du jour atteint, ou connexion anonyme impossible.
 */
export async function takeGuestRelayToken(): Promise<string | null> {
  if (!canAskNow()) return null;
  // Le créneau d'abord : un jeton pris avant une longue attente pourrait arriver expiré
  await waitForMinuteSlot();
  if (!canAskNow()) return null;
  if (!signingIn) signingIn = currentToken().finally(() => { signingIn = null; });
  let token: string | null;
  try {
    token = await signingIn;
  } catch (err) {
    signInFailedAt = now();
    log.warn('guest relay sign-in failed:', err instanceof Error ? err.name : 'unknown');
    return null;
  }
  if (!token || !inGuestSpace()) return null;
  const n = dayCount();
  if (n >= GUEST_DAY_LIMIT) return null;
  writeJson(GUEST_RELAY_DAY_KEY, { day: utcDay(now()), n: n + 1 });
  return token;
}

/** Vrai si une demande d'invité déjà prise ne doit plus partir (pause demandée, espace quitté) */
export function isGuestRelayStopped(): boolean {
  return !inGuestSpace() || pausedUntil() !== 0;
}

/** Raisons du relais qui valent pour le reste du jour (ou jusqu'à l'heure donnée) */
const LONG_REASONS = new Set(['day', 'address', 'budget', 'off']);

/**
 * Réponse du relais à une demande d'invité : retient la pause qu'il demande. Un 401 : si le jeton
 * refusé est encore celui de l'invité, il est renouvelé une fois ; si l'invité n'existe plus (effacé
 * par la purge de nuit), la session est oubliée et un nouvel invité sera créé, au plus tôt après la
 * pause. `retryAfter` : l'en-tête Retry-After, en secondes, quand la réponse n'a pas de corps lisible.
 */
export async function noteGuestRelayResponse(
  status: number, body: unknown, refusedToken?: string, retryAfter?: string | null,
): Promise<void> {
  if (status === 401) {
    const auth = guestClient().auth;
    let renewed = false;
    try {
      const { data } = await auth.getSession();
      const stored = data.session?.access_token;
      // Une autre demande a déjà renouvelé ou recréé l'invité : rien à oublier
      if (stored && refusedToken && stored !== refusedToken) renewed = true;
      else if (stored) {
        const { data: refreshed, error } = await auth.refreshSession();
        renewed = !error && Boolean(refreshed.session?.access_token);
        // Hors ligne ou serveur d'identité injoignable : l'invité est gardé, nouvel essai après une minute
        if (error?.name === 'AuthRetryableFetchError') {
          pause(now() + UNAVAILABLE_RETRY_MS);
          return;
        }
        if (!renewed) await auth.signOut({ scope: 'local' });
      }
    } catch {
      /* session déjà absente */
    }
    pause(now() + (renewed ? UNAVAILABLE_RETRY_MS : SIGN_IN_RETRY_MS));
    return;
  }
  if (status === 503) {
    pause(now() + UNAVAILABLE_RETRY_MS);
    return;
  }
  if (status !== 429) return;
  const data = (body && typeof body === 'object' ? body : {}) as { reason?: unknown; retry_at?: unknown };
  const retryAt = typeof data.retry_at === 'string' ? Date.parse(data.retry_at) : NaN;
  if (Number.isFinite(retryAt) && retryAt > now()) {
    pause(retryAt, LONG_REASONS.has(String(data.reason)));
    return;
  }
  if (typeof data.reason === 'string' && LONG_REASONS.has(data.reason)) {
    pause(nextUtcMidnight(now()), true);
    return;
  }
  // Minute, ou refus sans raison lisible (passerelle) : l'en-tête Retry-After, sinon une minute
  const seconds = Number(retryAfter);
  pause(now() + (Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 3600) * 1000 : 60_000));
}

/** Heure de reprise quand les fiches TMDB de l'invité sont coupées pour le jour (limite atteinte), sinon null */
export function guestRelayPausedUntil(): number | null {
  if (!inGuestSpace()) return null;
  const current = currentPause();
  if (current?.long) return current.until;
  return dayCount() >= GUEST_DAY_LIMIT ? nextUtcMidnight(now()) : null;
}

/** Tests : remet le module à zéro, avec une horloge et une attente choisies */
export function resetGuestRelayForTests(options: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {}): void {
  client = null;
  memory.clear();
  unsaved.clear();
  signingIn = null;
  signInFailedAt = 0;
  minuteStart = 0;
  minuteCount = 0;
  now = options.now ?? (() => Date.now());
  sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
}
