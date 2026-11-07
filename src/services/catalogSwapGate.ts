/**
 * catalogSwapGate.ts — « Catalogue en attente » après une actualisation en arrière-plan.
 *
 * L'actualisation (catalogAutoRefresh.ts) écrit le nouveau catalogue en base, mais l'écran garde
 * l'ancien jusqu'à la FIN de l'actualisation, puis jusqu'à un moment calme :
 * 1. `preparePendingCatalog()`, hors lecture, prépare tout ce qui prend du temps sans rien afficher :
 *    catalogue relu, Ma liste re-liée en base, rangées de l'accueil recalculées (cache seulement,
 *    aucun appel réseau) — `prepareRefreshedCatalog` (catalogReconcile.ts) ;
 * 2. `installPendingCatalog()`, synchrone, installe tout d'un coup au moment calme :
 *    - au **changement d'onglet** (calmMoments.ts), partout ;
 *    - après **2 minutes sans geste**, sauf sur TV, où la sélection à la télécommande pourrait se
 *      perdre si la carte choisie disparaît : la TV attend le changement d'onglet (ou le démarrage
 *      suivant, qui lit la base déjà à jour).
 *    Jamais pendant une lecture.
 *
 * Le compteur `meta.catalog_changes_seq`, augmenté par Rust à chaque paquet écrit, dit si la base
 * contient des changements pas encore affichés (`installedSeq`), même après un passage interrompu.
 * Une préparation est abandonnée (mémoire rendue) au début d'une lecture ou au bout de 15 minutes ;
 * elle est jetée si la session a changé entre-temps (déconnexion, autre compte, « Actualiser »).
 */

import type { LightIndexes } from '../types/lightIndex';
import { loadLightIndexes } from './catalogLight';
import { applyRefreshedCatalog, prepareRefreshedCatalog } from './catalogReconcile';
import type { PreparedCatalog } from './catalogReconcile';
import { onTabChange } from './calmMoments';
import { getDatabase, getDatabaseFileName } from './dbCore';
import { isPlaybackBusy, onPlaybackBusyChange } from './playbackActivity';
import { getCurrentSyncUserId } from './syncService';
import { isTv } from '../utils/platform';
import { devLog } from '../utils/devLog';
import { createLogger } from '../utils/logger';

const log = createLogger('CatalogGate');

/** Préparation gardée au plus 15 minutes sans installation (mémoire rendue ensuite) */
export const PREPARED_MAX_AGE_MS = 15 * 60_000;
/** Installation après 2 minutes sans touche, clic ni geste (hors TV) */
export const IDLE_INSTALL_MS = 2 * 60_000;
/** Nouvelle préparation, une fois la vidéo arrêtée, si un catalogue attend encore */
export const PREPARE_AFTER_PLAYBACK_MS = 20_000;
const IDLE_CHECK_MS = 15_000;

interface Prepared {
  catalog: PreparedCatalog;
  /** Compteur lu juste avant la relecture du catalogue */
  seq: number;
  epoch: number;
  marker: string;
  timer: ReturnType<typeof setTimeout>;
}

let installer: ((indexes: LightIndexes) => void) | null = null;
let installedSeq = 0;
let pending = false;
/** Augmenté à chaque vidage : une préparation commencée avant ne garde pas son résultat */
let epoch = 0;
let prepared: Prepared | null = null;
let preparing: Promise<void> | null = null;
let lastActivityAt = Date.now();
let idleTimer: ReturnType<typeof setInterval> | null = null;
let afterPlaybackTimer: ReturnType<typeof setTimeout> | null = null;

/** Base et compte Supabase de la session : un travail préparé pour une autre session est jeté */
function sessionMarker(): string | null {
  const dbName = getDatabaseFileName();
  return dbName ? `${dbName}|${getCurrentSyncUserId() ?? ''}` : null;
}

export async function readChangesSeq(): Promise<number> {
  const db = await getDatabase();
  const rows = await db.select<{ value: string | null }[]>(
    "SELECT value FROM meta WHERE key = 'catalog_changes_seq'"
  );
  const value = Number.parseInt(rows[0]?.value ?? '0', 10);
  return Number.isFinite(value) ? value : 0;
}

/** La session inscrit ici sa fonction d'installation du catalogue (setLightIndexes) */
export function registerCatalogInstaller(fn: ((indexes: LightIndexes) => void) | null): void {
  installer = fn;
}

export function hasPendingCatalog(): boolean {
  return pending;
}

function dropPrepared(why: string): void {
  if (!prepared) return;
  clearTimeout(prepared.timer);
  prepared = null;
  devLog('data', `⏏ Catalogue préparé abandonné : ${why}`);
}

/**
 * La session vient d'installer un catalogue entier relu depuis la base (connexion, reprise,
 * « Actualiser ») : `seq` est la valeur du compteur lue juste AVANT cette relecture.
 */
export function markInstalledFromDb(seq: number): void {
  installedSeq = seq;
  pending = false;
  dropPrepared('catalogue relu par la session');
  stopIdleWatch();
}

/**
 * Le catalogue en base a changé autrement (liens du guide TV recalculés) : une préparation faite
 * ou en cours avant ce changement est jetée, et refaite. Le catalogue reste en attente.
 */
export function invalidatePreparedCatalog(why: string): void {
  epoch++;
  dropPrepared(why);
  if (pending && !preparing) void preparePendingCatalog();
}

/** Préparation en cours (à attendre avant de supprimer la base) */
export function waitForCatalogPreparation(): Promise<void> {
  return preparing ?? Promise.resolve();
}

/** Connexion, déconnexion, « Actualiser », remise à zéro : l'attente n'a plus lieu d'être */
export function clearPendingCatalog(): void {
  epoch++;
  pending = false;
  dropPrepared('session remplacée');
  stopIdleWatch();
  if (afterPlaybackTimer) {
    clearTimeout(afterPlaybackTimer);
    afterPlaybackTimer = null;
  }
}

/**
 * Après chaque passage de l'actualisation (quel que soit son statut : des paquets ont pu être
 * écrits avant un arrêt) : y a-t-il des changements pas encore affichés ? Si oui, la préparation
 * est lancée (hors lecture).
 */
export async function checkForPendingCatalog(): Promise<boolean> {
  const startEpoch = epoch;
  const seq = await readChangesSeq();
  if (startEpoch !== epoch) return false;
  if (seq > installedSeq) {
    pending = true;
    startIdleWatch();
    void preparePendingCatalog();
  }
  return pending;
}

/** Prépare le catalogue en attente, sans rien afficher. Sans effet pendant une lecture. */
export function preparePendingCatalog(): Promise<void> {
  if (preparing) return preparing;
  if (!pending || prepared || !installer || isPlaybackBusy()) return Promise.resolve();
  const startEpoch = epoch;
  const marker = sessionMarker();
  if (!marker) return Promise.resolve();
  const stillCurrent = () => epoch === startEpoch && sessionMarker() === marker;

  preparing = (async () => {
    const seq = await readChangesSeq();
    const indexes = await loadLightIndexes({ remember: false });
    if (!stillCurrent() || isPlaybackBusy()) return;
    const catalog = await prepareRefreshedCatalog(indexes, { allowNetwork: false, isStillCurrent: stillCurrent });
    if (!stillCurrent() || isPlaybackBusy()) return;
    const timer = setTimeout(() => dropPrepared('non installé au bout de 15 minutes'), PREPARED_MAX_AGE_MS);
    prepared = { catalog, seq, epoch: startEpoch, marker, timer };
    devLog('data', '📦 Catalogue neuf préparé, installé au prochain moment calme');
  })()
    .catch((e) => log.warn('Préparation impossible, nouvel essai au prochain moment calme', e))
    .finally(() => {
      preparing = null;
      // Jetée en route par invalidatePreparedCatalog : on recommence (pas après un vidage)
      if (epoch !== startEpoch && pending) void preparePendingCatalog();
    });
  return preparing;
}

/**
 * Installe le catalogue préparé (synchrone). Si rien n'est prêt, lance la préparation : il sera
 * installé au moment calme suivant. Renvoie vrai si un catalogue a été installé.
 */
export function installPendingCatalog(reason: string): boolean {
  if (!pending || isPlaybackBusy()) return false;
  const ready = prepared;
  if (!ready || !installer || ready.epoch !== epoch || ready.marker !== sessionMarker() || ready.seq < installedSeq) {
    if (ready) dropPrepared('préparation périmée');
    void preparePendingCatalog();
    return false;
  }
  clearTimeout(ready.timer);
  prepared = null;
  applyRefreshedCatalog(ready.catalog, installer);
  installedSeq = Math.max(installedSeq, ready.seq);
  pending = false;
  stopIdleWatch();
  devLog('data', `✅ Catalogue neuf installé (${reason})`);
  // Des paquets écrits pendant la préparation restent en attente
  void checkForPendingCatalog().catch(() => {});
  return true;
}

// ---------------------------------------------------------------------------------------------
// Moments calmes
// ---------------------------------------------------------------------------------------------

function noteActivity(): void {
  lastActivityAt = Date.now();
}

const ACTIVITY_EVENTS = ['keydown', 'keyup', 'pointerdown', 'wheel', 'touchstart', 'focusin'] as const;

function startIdleWatch(): void {
  if (idleTimer || isTv() || typeof window === 'undefined') return;
  lastActivityAt = Date.now();
  // Phase de capture : la navigation à la télécommande arrête la propagation de OK/Entrée
  for (const type of ACTIVITY_EVENTS) window.addEventListener(type, noteActivity, { capture: true, passive: true });
  idleTimer = setInterval(() => {
    if (Date.now() - lastActivityAt >= IDLE_INSTALL_MS) installPendingCatalog('2 minutes sans geste');
  }, IDLE_CHECK_MS);
}

function stopIdleWatch(): void {
  if (!idleTimer) return;
  clearInterval(idleTimer);
  idleTimer = null;
  for (const type of ACTIVITY_EVENTS) window.removeEventListener(type, noteActivity, { capture: true });
}

onTabChange(() => {
  installPendingCatalog("changement d'onglet");
});

onPlaybackBusyChange((busy) => {
  if (afterPlaybackTimer) {
    clearTimeout(afterPlaybackTimer);
    afterPlaybackTimer = null;
  }
  if (busy) {
    // La mémoire va au lecteur ; la re-liaison de Ma liste, déjà écrite en base, reste valable
    dropPrepared('lecture lancée');
  } else if (pending) {
    afterPlaybackTimer = setTimeout(() => {
      afterPlaybackTimer = null;
      void preparePendingCatalog();
    }, PREPARE_AFTER_PLAYBACK_MS);
  }
});

/** Tests seulement : état initial */
export function __resetCatalogGateForTests(): void {
  clearPendingCatalog();
  installer = null;
  installedSeq = 0;
  epoch = 0;
  preparing = null;
}
