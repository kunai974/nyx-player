/**
 * catalogAutoRefresh.ts — Actualisation automatique des sources toutes les 12 h.
 *
 * Discrète, sans rien afficher : le catalogue est comparé en arrière-plan par le moteur Rust
 * (catalogRefresh.ts, une liste à la fois, seules les différences écrites), et l'écran ne change
 * qu'à la FIN, au moment calme suivant (catalogSwapGate.ts). Pour ne jamais faire ramer le
 * Chromecast ou la TV :
 * - jamais pendant une vidéo : une lecture qui commence arrête l'actualisation, qui reprend
 *   5 minutes après la fin de la lecture ;
 * - jamais en même temps que la mise à jour du guide TV (le moteur s'efface aussi de lui-même devant
 *   une écriture lourde : statut `busy`, nouvel essai 10 minutes plus tard) ;
 * - jamais sur une connexion mobile limitée (téléphone en 4G), le bouton « Actualiser » restant
 *   disponible.
 *
 * Déclencheurs : 1 minute après l'ouverture de la session, puis une vérification toutes les heures,
 * et 30 s après le retour dans l'app. Une vérification ne lance l'actualisation que si la dernière a
 * plus de 12 h (`meta.lastUpdate`, aussi écrite par la connexion et « Actualiser »), ou si des listes
 * ont échoué la fois précédente (retentées seules, 4 essais au plus, espacés de 5, 15 puis 60 min).
 *
 * Réglage « Actualisation automatique » : `meta.catalog_auto_refresh`, propre à l'appareil (les
 * préférences, elles, partent dans le cloud), activé si absent.
 */

import type { XtreamCredentials } from '../types/iptv';
import { abortCatalogRefresh, nextRefreshRunId, refreshCatalogDiff } from './catalogRefresh';
import type { CatalogListName, RefreshSummary } from './catalogRefresh';
import { registerBackgroundStop } from './backgroundWork';
import { checkForPendingCatalog, clearPendingCatalog, waitForCatalogPreparation } from './catalogSwapGate';
import { getDatabase, getDatabaseFileName } from './dbCore';
import { isSyncing } from './epgService';
import { PLAYBACK_EVENT } from './eventConstants';
import { getNetworkStatus } from './networkStatus';
import { isPlaybackBusy, onPlaybackBusyChange } from './playbackActivity';
import { applyPendingSearchChanges } from './searchIndex';
import { getCurrentSyncUserId } from './syncService';
import { pushRelinkedProgress } from './progressRelink';
import { VERSION_MESURE as PERF_ENABLED } from './outilsTest';
import { devLog } from '../utils/devLog';
import { createLogger } from '../utils/logger';

const log = createLogger('AutoRefresh');

export const REFRESH_INTERVAL_MS = 12 * 3600_000;
/**
 * Première vérification après l'ouverture de la session : 1 min ; 10 s dans la version du banc
 * (VITE_BANC=1), qui attendait sinon cette minute pour voir le nouvel essai d'une liste.
 */
export const FIRST_CHECK_DELAY_MS = import.meta.env.VITE_BANC === '1' ? 10_000 : 60_000;
export const CHECK_EVERY_MS = 3600_000;
export const VISIBLE_CHECK_DELAY_MS = 30_000;
export const AFTER_PLAYBACK_DELAY_MS = 5 * 60_000;
export const BUSY_RETRY_MS = 10 * 60_000;
/** Essais pour des listes en échec avant d'attendre la fenêtre de 12 h suivante */
export const MAX_ATTEMPTS = 4;
/**
 * Attente avant l'essai suivant, après le 1er, 2e et 3e échec : de plus en plus longue, pour ne
 * jamais insister auprès d'un fournisseur en panne ou qui limite les requêtes. Au 4e échec, retour
 * au rythme de 12 h : au plus 4 essais par fenêtre de 12 h, donc 8 par jour.
 */
export const RETRY_DELAYS_MS = [5 * 60_000, 15 * 60_000, 60 * 60_000] as const;
const MIN_RATE_LIMIT_WAIT_MS = 3600_000;

const ALL_LISTS: CatalogListName[] = ['categories', 'movies', 'series', 'live'];

export const AUTO_REFRESH_META = {
  enabled: 'catalog_auto_refresh',
  lastUpdate: 'lastUpdate',
  retryLists: 'catalog_retry_lists',
  retryCount: 'catalog_retry_count',
  retryAfter: 'catalog_retry_after',
  lastError: 'catalog_last_error',
  manualAdvised: 'catalog_manual_advised',
} as const;

interface Session {
  creds: XtreamCredentials;
  dbName: string;
  userId: string | null;
}

let session: Session | null = null;
let firstTimer: ReturnType<typeof setTimeout> | null = null;
let laterTimer: ReturnType<typeof setTimeout> | null = null;
let hourly: ReturnType<typeof setInterval> | null = null;
let unsubscribePlayback: (() => void) | null = null;
/** Passage Rust en cours (pour l'arrêter) */
let runningId: number | null = null;
/** Vérification en cours, passage et suites compris */
let activeCheck: Promise<void> | null = null;
let perfForced = false;

declare global {
  interface Window { __nyxAutoRefresh?: (on: boolean) => void }
}

// Version de mesure : désactivée pour ne pas fausser les mesures, sauf demande explicite
if (PERF_ENABLED && typeof window !== 'undefined') {
  window.__nyxAutoRefresh = (on: boolean) => {
    perfForced = on;
    if (on) scheduleCheck(0, 'demande de mesure');
  };
}

// ---------------------------------------------------------------------------------------------
// Base
// ---------------------------------------------------------------------------------------------

async function readMeta(keys: readonly string[]): Promise<Map<string, string>> {
  const db = await getDatabase();
  const rows = await db.select<{ key: string; value: string | null }[]>(
    `SELECT key, value FROM meta WHERE key IN (${keys.map(() => '?').join(', ')})`,
    [...keys]
  );
  return new Map(rows.filter((r) => r.value != null).map((r) => [r.key, r.value as string]));
}

async function writeMeta(values: Record<string, string | null>): Promise<void> {
  const db = await getDatabase();
  for (const [key, value] of Object.entries(values)) {
    if (value === null) await db.execute('DELETE FROM meta WHERE key = ?', [key]);
    else await db.execute('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [key, value]);
  }
}

function parseLists(value: string | undefined): CatalogListName[] {
  try {
    const parsed: unknown = JSON.parse(value ?? '[]');
    return Array.isArray(parsed) ? ALL_LISTS.filter((l) => parsed.includes(l)) : [];
  } catch {
    return [];
  }
}

function sameSession(expected: Session): boolean {
  return session === expected
    && getDatabaseFileName() === expected.dbName
    && getCurrentSyncUserId() === expected.userId;
}

// ---------------------------------------------------------------------------------------------
// Planification
// ---------------------------------------------------------------------------------------------

function scheduleCheck(delayMs: number, reason: string): void {
  if (!session) return;
  if (laterTimer) clearTimeout(laterTimer);
  laterTimer = setTimeout(() => {
    laterTimer = null;
    void runCheck(reason);
  }, delayMs);
}

function onVisibilityChange(): void {
  if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
    scheduleCheck(VISIBLE_CHECK_DELAY_MS, "retour dans l'app");
  }
}

/**
 * Démarre la planification pour la session ouverte (fin de la connexion, de la reprise ou
 * d'« Actualiser »). Ne lance rien tout de suite : première vérification une minute plus tard.
 */
export function startCatalogAutoRefresh(next: Session): void {
  clearSchedule();
  session = next;
  firstTimer = setTimeout(() => {
    firstTimer = null;
    void runCheck('ouverture de la session');
  }, FIRST_CHECK_DELAY_MS);
  hourly = setInterval(() => void runCheck('vérification horaire'), CHECK_EVERY_MS);
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibilityChange);
  unsubscribePlayback = onPlaybackBusyChange((busy) => {
    if (busy) {
      // La vidéo passe avant tout : arrêt immédiat, ce qui est écrit reste valable
      if (runningId !== null) abortCatalogRefresh(runningId).catch(() => {});
    } else {
      scheduleCheck(AFTER_PLAYBACK_DELAY_MS, 'fin de la lecture');
    }
  });
  devLog('data', '🕑 Actualisation automatique planifiée (toutes les 12 h)');
}

/** Même fournisseur, nouveau mot de passe : la copie gardée par le planificateur suit */
export function updateAutoRefreshCredentials(creds: XtreamCredentials): void {
  if (session && session.creds.host === creds.host) session = { ...session, creds };
}

function clearSchedule(): void {
  if (firstTimer) clearTimeout(firstTimer);
  if (laterTimer) clearTimeout(laterTimer);
  if (hourly) clearInterval(hourly);
  firstTimer = laterTimer = hourly = null;
  if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibilityChange);
  unsubscribePlayback?.();
  unsubscribePlayback = null;
}

/**
 * Arrête la planification et le passage en cours. La promesse se résout quand le passage en cours
 * a rendu la main (Rust arrêté, suites de la page faites ou abandonnées) : à attendre avant une
 * connexion, une déconnexion, « Actualiser » ou la suppression de la base. Appels répétés : même
 * attente. Jamais d'attente d'un travail qui dépend de Supabase (envois au cloud sans attente).
 */
export function stopCatalogAutoRefresh(): Promise<void> {
  clearSchedule();
  session = null;
  if (runningId !== null) abortCatalogRefresh(runningId).catch(() => {});
  return activeCheck ?? Promise.resolve();
}

// Déconnexion Supabase et remise à zéro (modules légers, backgroundWork.ts)
registerBackgroundStop(async () => {
  // Préparation en cours : sa lecture de la base se termine avant une suppression de la base
  const preparation = waitForCatalogPreparation();
  clearPendingCatalog();
  await Promise.all([stopCatalogAutoRefresh(), preparation]);
});

// ---------------------------------------------------------------------------------------------
// Vérification et passage
// ---------------------------------------------------------------------------------------------

/**
 * Vérifie les conditions et lance un passage si nécessaire. Exportée pour les tests ; appelée par
 * les minuteries. Une seule vérification à la fois.
 */
export function runCheck(reason: string): Promise<void> {
  if (activeCheck) return activeCheck;
  const current = session;
  if (!current) return Promise.resolve();
  if (PERF_ENABLED && !perfForced) return Promise.resolve();
  if (isPlaybackBusy()) return Promise.resolve(); // reprise planifiée à la fin de la lecture
  const check = checkAndRun(current, reason)
    .catch((e) => log.warn('Vérification impossible', e))
    .finally(() => {
      runningId = null;
      if (activeCheck === check) activeCheck = null;
    });
  activeCheck = check;
  return check;
}

async function checkAndRun(current: Session, reason: string): Promise<void> {
  if (isSyncing()) {
    scheduleCheck(BUSY_RETRY_MS, 'guide en cours de mise à jour');
    return;
  }
  const meta = await readMeta([...Object.values(AUTO_REFRESH_META), 'lastProvider']);
  if (!sameSession(current)) return;

  // Notes restées d'un passage interrompu (app fermée avant la mise à jour de la recherche)
  await applyPendingSearchChanges(searchStop(current)).catch((e) => log.warn('Recherche non mise à jour', e));

  if (meta.get(AUTO_REFRESH_META.enabled) === '0') return;
  const now = Date.now();
  const retryAfter = Number(meta.get(AUTO_REFRESH_META.retryAfter) ?? 0);
  if (retryAfter > now) return;
  const retryLists = parseLists(meta.get(AUTO_REFRESH_META.retryLists));
  const lastUpdate = Date.parse(meta.get(AUTO_REFRESH_META.lastUpdate) ?? '');
  const due = retryLists.length > 0 || !Number.isFinite(lastUpdate) || now - lastUpdate >= REFRESH_INTERVAL_MS;
  if (!due) return;

  const network = await getNetworkStatus();
  if (!network.connected || network.metered) {
    devLog('data', `Actualisation automatique reportée : ${network.connected ? 'connexion limitée' : 'hors ligne'}`);
    return;
  }
  if (!sameSession(current)) return;
  // Base plus ancienne que cette clé : même fournisseur (comme la page), et la clé est écrite
  if (!meta.get('lastProvider')) await writeMeta({ lastProvider: current.creds.host });

  // Les vérifications ci-dessus sont asynchrones : une lecture a pu commencer entre-temps
  if (!sameSession(current) || isPlaybackBusy() || isSyncing()) return;
  const runId = nextRefreshRunId();
  runningId = runId;
  devLog('data', `🔄 Actualisation automatique (${reason}${retryLists.length ? `, listes : ${retryLists.join(', ')}` : ''})`);
  const summary = await refreshCatalogDiff(runId, current.creds, current.dbName, retryLists).catch(
    (e): RefreshSummary => {
      log.warn('Actualisation impossible', e);
      return failedSummary(retryLists.length ? retryLists : ALL_LISTS);
    }
  );
  runningId = null;
  devLog('data', `Actualisation automatique : ${summary.status}`, {
    lists: summary.lists.map((l) => `${l.list}:${l.outcome}(+${l.added} ~${l.changed} -${l.removed})`),
    ms: summary.durationMs,
  });
  if (sameSession(current)) await afterRun(current, summary, retryLists, Number(meta.get(AUTO_REFRESH_META.retryCount) ?? 0));
}

/** Mise à jour de la recherche arrêtée par une vidéo qui démarre ou la fin de la session */
function searchStop(current: Session): () => boolean {
  return () => isPlaybackBusy() || !sameSession(current);
}

function failedSummary(lists: CatalogListName[]): RefreshSummary {
  return {
    status: 'failed', stopReason: null, retryAfterSec: null, lists: [], failedLists: lists,
    progressRelinks: [], epgRelinked: 0, durationMs: 0, bytesDownloaded: 0,
  };
}

/** Suites d'un passage, quel que soit son statut (des paquets ont pu être écrits avant un arrêt) */
async function afterRun(current: Session, summary: RefreshSummary, retryLists: CatalogListName[], retryCount: number): Promise<void> {
  // 1. Recherche : jamais pendant une lecture (la note reste en base, traitée au passage suivant)
  if (!isPlaybackBusy()) {
    await applyPendingSearchChanges(searchStop(current)).catch((e) => log.warn('Recherche non mise à jour', e));
  }

  // 2. Reprises de lecture re-liées à un nouveau numéro : le cloud suit (le cloud les identifie par
  //    leur numéro). Envois sans attente ; un envoi perdu est rattrapé au passage suivant.
  if (summary.progressRelinks.length > 0 && sameSession(current)) {
    await pushRelinkedProgress(summary.progressRelinks, () => sameSession(current));
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(PLAYBACK_EVENT));
  }

  // 3. Date et nouveaux essais
  if (!sameSession(current)) return;
  const nowIso = new Date().toISOString();
  switch (summary.status) {
    case 'done':
    case 'unchanged':
      await writeMeta({
        [AUTO_REFRESH_META.lastUpdate]: nowIso,
        [AUTO_REFRESH_META.retryLists]: null,
        [AUTO_REFRESH_META.retryCount]: null,
        [AUTO_REFRESH_META.lastError]: null,
      });
      break;
    case 'partial':
    case 'failed': {
      const attempts = retryCount + 1;
      const failed = summary.failedLists.length > 0 ? summary.failedLists : (retryLists.length ? retryLists : ALL_LISTS);
      if (attempts >= MAX_ATTEMPTS) {
        // Au 4e échec : on attend la fenêtre de 12 h suivante
        await writeMeta({
          [AUTO_REFRESH_META.lastUpdate]: nowIso,
          [AUTO_REFRESH_META.retryLists]: null,
          [AUTO_REFRESH_META.retryCount]: null,
          [AUTO_REFRESH_META.retryAfter]: null,
          [AUTO_REFRESH_META.lastError]: summary.status,
        });
      } else {
        // Essai suivant de plus en plus tard (5, 15 puis 60 min), jamais avant
        const delay = RETRY_DELAYS_MS[Math.min(attempts, RETRY_DELAYS_MS.length) - 1];
        await writeMeta({
          [AUTO_REFRESH_META.retryLists]: JSON.stringify(failed),
          [AUTO_REFRESH_META.retryCount]: String(attempts),
          [AUTO_REFRESH_META.retryAfter]: String(Date.now() + delay),
          [AUTO_REFRESH_META.lastError]: summary.status,
        });
        // Une seconde de marge : une minuterie en avance d'un rien serait refusée par l'attente
        scheduleCheck(delay + 1000, 'nouvel essai des listes en échec');
      }
      break;
    }
    case 'rate_limited':
      await writeMeta({
        [AUTO_REFRESH_META.retryAfter]: String(Date.now() + Math.max(MIN_RATE_LIMIT_WAIT_MS, (summary.retryAfterSec ?? 0) * 1000)),
        [AUTO_REFRESH_META.lastError]: 'rate_limited',
      });
      break;
    case 'busy':
      scheduleCheck(BUSY_RETRY_MS, 'base occupée');
      break;
    case 'aborted':
      if (summary.stopReason === 'provider_changed') {
        await writeMeta({ [AUTO_REFRESH_META.lastError]: 'provider_changed' });
      }
      break;
  }

  // 4. Changements pas encore affichés : préparés hors lecture, installés au moment calme
  if (sameSession(current)) await checkForPendingCatalog();
}

// ---------------------------------------------------------------------------------------------
// Paramètres
// ---------------------------------------------------------------------------------------------

export interface AutoRefreshInfo {
  enabled: boolean;
  /** Dernière actualisation réussie (automatique, connexion ou « Actualiser »), en ms */
  lastUpdate: number | null;
  /** Dernier échec depuis la dernière réussite */
  lastError: string | null;
  /** Le fournisseur a retiré beaucoup de titres : actualiser à la main pour confirmer */
  manualAdvised: boolean;
}

export async function getAutoRefreshInfo(): Promise<AutoRefreshInfo> {
  const meta = await readMeta(Object.values(AUTO_REFRESH_META));
  const lastUpdate = Date.parse(meta.get(AUTO_REFRESH_META.lastUpdate) ?? '');
  return {
    enabled: meta.get(AUTO_REFRESH_META.enabled) !== '0',
    lastUpdate: Number.isFinite(lastUpdate) ? lastUpdate : null,
    lastError: meta.get(AUTO_REFRESH_META.lastError) ?? null,
    manualAdvised: meta.get(AUTO_REFRESH_META.manualAdvised) === '1',
  };
}

/** Interrupteur des Paramètres (propre à l'appareil) */
export async function setAutoRefreshEnabled(enabled: boolean): Promise<void> {
  await writeMeta({ [AUTO_REFRESH_META.enabled]: enabled ? '1' : '0' });
  if (!enabled && runningId !== null) {
    abortCatalogRefresh(runningId).catch(() => {});
  } else if (enabled) {
    scheduleCheck(FIRST_CHECK_DELAY_MS, 'réactivée');
  }
}

/**
 * « Actualiser » a réussi (écriture complète) : plus d'essai en attente ni de conseil affiché.
 * `meta.lastUpdate` est écrite par l'actualisation elle-même.
 */
export async function clearAutoRefreshNotes(): Promise<void> {
  await writeMeta({
    [AUTO_REFRESH_META.retryLists]: null,
    [AUTO_REFRESH_META.retryCount]: null,
    [AUTO_REFRESH_META.retryAfter]: null,
    [AUTO_REFRESH_META.lastError]: null,
    [AUTO_REFRESH_META.manualAdvised]: null,
  });
}

/**
 * Listes d'une lecture complète (connexion, « Actualiser ») à retenter, d'après les échecs notés par
 * le Rust (`movies`, `movies_guarded`, `live_categories`…). Une liste gardée parce que ses numéros
 * TMDB ont chuté (`*_tmdb_guarded`) n'est pas retentée : le fournisseur l'envoie ainsi. Les catégories
 * sont retentées avec leurs éléments : le Rust garde les anciennes quand il garde les anciens
 * éléments, et un élément rangé dans une catégorie neuve serait sinon invisible.
 */
export function listsToRetry(failedEndpoints: readonly string[]): CatalogListName[] {
  const lists = new Set<CatalogListName>();
  for (const endpoint of failedEndpoints) {
    if (endpoint.endsWith('_tmdb_guarded')) continue;
    if (endpoint.includes('categories')) lists.add('categories');
    else if (endpoint.startsWith('movies')) lists.add('movies');
    else if (endpoint.startsWith('series')) lists.add('series');
    else if (endpoint.startsWith('live')) lists.add('live');
  }
  if (lists.size > 0) lists.add('categories');
  return ALL_LISTS.filter((l) => lists.has(l));
}

/**
 * Après une lecture complète en partie : les listes en échec sont notées pour l'actualisation
 * automatique, qui les retente dès sa première vérification (1 minute après l'ouverture de la
 * session) au lieu d'attendre 12 h. Lecture complète sans aucun
 * échec : les listes encore notées d'un passage précédent sont à jour, leurs notes sont effacées.
 */
export async function noteListsToRetry(failedEndpoints: readonly string[]): Promise<void> {
  if (failedEndpoints.length === 0) {
    await writeMeta({
      [AUTO_REFRESH_META.retryLists]: null,
      [AUTO_REFRESH_META.retryCount]: null,
      [AUTO_REFRESH_META.retryAfter]: null,
    });
    return;
  }
  const lists = listsToRetry(failedEndpoints);
  if (lists.length === 0) return;
  // Le compte d'essais et l'attente en cours sont gardés : se reconnecter ne relance pas une série
  // d'essais auprès d'un fournisseur en panne (plafond de MAX_ATTEMPTS par fenêtre de 12 h)
  await writeMeta({ [AUTO_REFRESH_META.retryLists]: JSON.stringify(lists) });
}

/** Tests seulement */
export function __resetAutoRefreshForTests(): void {
  clearSchedule();
  session = null;
  runningId = null;
  activeCheck = null;
  perfForced = false;
}
