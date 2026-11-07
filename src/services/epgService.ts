/**
 * EPG Service — Orchestration de la synchronisation EPG XMLTV
 *
 * Responsabilités :
 * - Appeler le backend Rust pour download + parse + insert EPG
 * - Gérer l'état de sync (module-level, survit au démontage composant)
 * - Fournir les programmes "now" pour les cartes Live TV
 * - Purger les données EPG (toggle OFF)
 * - Auto-sync au boot (checkAndAutoSync)
 *
 * Isolation stricte : ZÉRO import depuis catalogIngestion.ts
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { getDatabase, getDatabaseFileName, refreshConnection, setMeta } from './dbCore';
import { getDnsProvider, isEpgEnabled, isEpgWifiOnly } from './preferencesService';
import { getNetworkStatus } from './networkStatus';
import { EPG_UPDATED_EVENT } from './eventConstants';
import { devLog } from '../utils/devLog';
import { StorageService } from './storage';
import { prises } from './outilsTest';

// ============================================================================
// CONSTANTS
// ============================================================================

const EPG_URL = 'https://epgshare01.online/epgshare01/epg_ripper_ALL_SOURCES1.xml.gz';

/**
 * Synchros interrompues de suite (état « syncing » retrouvé au lancement) au-delà desquelles la
 * reprise automatique s'arrête : un guide qui fait tomber l'app la ferait sinon retomber à chaque
 * lancement. Une ou deux fermetures pendant une synchro restent reprises comme avant.
 */
export const MAX_INTERRUPTED_SYNCS = 3;
/** Durée de la pause de la synchro automatique après ces interruptions (la synchro manuelle reste permise). */
export const AUTO_SYNC_PAUSE_MS = 24 * 3600 * 1000;

/**
 * Adresse du guide à télécharger : la source publique. Seules les versions du banc de tests
 * (VITE_BANC=1, que le garde-fou de publication refuse hors des scripts d'audit) lisent le guide du
 * faux fournisseur qui leur sert de source ; dans une version normale, la branche disparaît
 * à la compilation.
 */
export async function epgSourceUrl(): Promise<string> {
  if (import.meta.env.VITE_BANC === '1' && prises.guideBanc) {
    const guide = prises.guideBanc(await StorageService.getCredentials().catch(() => null));
    if (guide) return guide;
  }
  return EPG_URL;
}

// ============================================================================
// TYPES
// ============================================================================

/** Payload des events `epg-progress` émis par Rust */
export interface EpgProgressEvent {
  phase: 'download' | 'parse' | 'insert' | 'mapping' | 'done';
  progress: number;  // 0-100
  count: number;     // programmes insérés
}

/** Résultat retourné par le Rust `fetch_and_parse_epg` */
interface EpgIngestResult {
  programs_count: number;
  channels_count: number;
  duration_ms: number;
  filtered_out: number;
}

/** Résultat public de syncEpg */
export interface EpgSyncResult {
  programsCount: number;
  channelsCount: number;
  durationMs: number;
}

/** Info EPG "programme en cours" pour une chaîne */
export interface EpgNowInfo {
  title: string;
  description?: string; // Description du programme (peut être vide)
  startTs: number;   // epoch seconds
  stopTs: number;    // epoch seconds
  progress: number;  // 0-100
}

/** Données EPG brutes pour la timeline du guide TV (sans progress ni description) */
export interface EpgProgram {
  channelId: string;
  title: string;
  startTs: number; // epoch seconds
  stopTs: number;  // epoch seconds
}

// ============================================================================
// MODULE-LEVEL STATE (survit au démontage composant)
// ============================================================================

let syncInProgress = false;
let syncAbortRequested = false;
/** Arrêt pour changement de session : le guide déjà en place n'est pas effacé */
let keepGuideOnAbort = false;
/** Fin de la sync en cours (réussie ou non), attendue avant d'en lancer une autre */
let currentSync: Promise<unknown> | null = null;

/** Vérifie si une sync EPG est en cours */
export function isSyncing(): boolean {
  return syncInProgress;
}

/** Attend la fin de la sync en cours, s'il y en a une (jamais d'erreur). */
export async function waitForSyncEnd(): Promise<void> {
  await currentSync?.catch(() => {});
}

// ============================================================================
// SYNC EPG
// ============================================================================

/**
 * Lance la synchronisation EPG complète :
 * 1. Download gzipped XMLTV (~50MB)
 * 2. Décompresse + parse XML SAX
 * 3. INSERT batch dans epg_programs
 *
 * @param onProgress — Callback optionnel pour feedback UI (phase + %)
 * @returns EpgSyncResult avec compteurs
 * @throws Si le download ou le parsing échoue
 */
export function syncEpg(
  onProgress?: (event: EpgProgressEvent) => void
): Promise<EpgSyncResult> {
  // Guard: pas de double sync
  if (syncInProgress) {
    return Promise.reject(new Error('[EPG] Sync already in progress'));
  }

  syncInProgress = true;
  syncAbortRequested = false;
  keepGuideOnAbort = false;
  const run = runSync(onProgress);
  currentSync = run;
  return run;
}

async function runSync(
  onProgress?: (event: EpgProgressEvent) => void
): Promise<EpgSyncResult> {
  // Base de la session qui lance la sync : après un changement de compte pendant la sync, rien
  // n'est écrit dans la base du compte suivant
  const dbName = getDatabaseFileName();
  const sameDatabase = () => getDatabaseFileName() === dbName;

  // Écouter les events de progression si callback fourni
  let unlisten: UnlistenFn | null = null;
  if (onProgress) {
    unlisten = await listen<EpgProgressEvent>('epg-progress', (e) => {
      onProgress(e.payload);
    });
  }

  try {
    if (!dbName) {
      throw new Error('[EPG] No database name — user not logged in');
    }

    // Mark sync as in-progress (survives app restart). Compte changé pendant la mise en route :
    // rien n'est écrit dans la base du compte suivant
    if (!sameDatabase()) throw new Error('[EPG] Account changed before the sync started');
    await setMeta('epg_sync_status', 'syncing');

    const epgUrl = await epgSourceUrl();

    // Arrêt demandé avant l'appel au Rust (déconnexion aussitôt après le lancement) : le Rust
    // remettrait son drapeau d'arrêt à zéro en démarrant et irait jusqu'au bout
    if (syncAbortRequested) throw new Error('EPG sync aborted by user');

    const result = await invoke<EpgIngestResult>('fetch_and_parse_epg', {
      epgUrl,
      dbName,
      dnsProvider: getDnsProvider(),
    });

    // Compte changé pendant la sync : rien à écrire dans la base du compte suivant
    if (!sameDatabase()) {
      return { programsCount: 0, channelsCount: 0, durationMs: result.duration_ms };
    }
    // Si le user a demandé l'arrêt pendant la sync (guide désactivé) → purge silencieuse.
    // Arrêt pour changement de session arrivé trop tard : le guide complet est en place, gardé.
    if (syncAbortRequested && !keepGuideOnAbort) {
      await purgeEpgData();
      return { programsCount: 0, channelsCount: 0, durationMs: result.duration_ms };
    }

    // Date de la sync et état « complete » : écrits par le Rust dans la transaction qui met le
    // nouveau guide en place (jamais dans la base d'un autre compte)

    // Recycler la connexion pour voir les nouvelles données
    await refreshConnection();

    // Notifier les composants UI (useGridEpg etc.)
    window.dispatchEvent(new Event(EPG_UPDATED_EVENT));

    // Purge des programmes expirés (fire-and-forget)
    purgeExpiredPrograms().catch(() => {});

    return {
      programsCount: result.programs_count,
      channelsCount: result.channels_count,
      durationMs: result.duration_ms,
    };
  } catch (error) {
    // If abort was requested and Rust returned an error (abort path),
    // clean up partial data immediately instead of waiting for boot recovery.
    if (!sameDatabase() || keepGuideOnAbort) {
      // Changement de session : la base de départ garde son guide (le Rust ne l'a pas remplacé)
      // et son état « syncing », qui relance la sync à la prochaine ouverture de ce compte
    } else if (syncAbortRequested) {
      await purgeEpgData().catch(() => {});
    } else {
      // Non-abort error (network, parse, etc.) — reset sync status
      // so checkAndAutoSync doesn't think we're still syncing.
      await setMeta('epg_sync_status', 'error').catch(() => {});
    }
    throw error;
  } finally {
    // Toujours nettoyer, même en cas d'erreur
    if (unlisten) unlisten();
    syncInProgress = false;
  }
}

/**
 * Demande l'arrêt immédiat de la sync Rust.
 * Le flag AtomicBool côté Rust stoppe les boucles download/parse/insert
 * à la prochaine itération (< 1 seconde de latence).
 */
export function requestSyncAbort(): void {
  if (syncInProgress) {
    syncAbortRequested = true;
    // Signal the Rust side to stop ASAP
    invoke('abort_epg_sync').catch(() => {});
  }
}

/**
 * Arrête la sync en cours sans effacer le guide : déconnexion, changement de compte ou de
 * fournisseur. La sync ne déborde plus sur la session suivante, et le guide déjà en
 * place reste intact (le Rust ne remplace l'ancien guide qu'en fin de synchro réussie).
 */
export function stopSyncForSessionChange(): void {
  if (syncInProgress) {
    syncAbortRequested = true;
    keepGuideOnAbort = true;
    invoke('abort_epg_sync').catch(() => {});
  }
}

/**
 * Annule un abort demandé (user re-active EPG avant que Rust finisse).
 * Reset les deux côtés (JS + Rust) pour laisser la sync continuer.
 */
export function cancelAbort(): void {
  syncAbortRequested = false;
  keepGuideOnAbort = false;
  invoke('cancel_epg_abort').catch(() => {});
}

// ============================================================================
// AUTO-SYNC (BOOT)
// ============================================================================

/**
 * Vérifie la fraîcheur des données EPG et lance une sync si nécessaire.
 * Fire-and-forget — ne bloque pas le boot, ne notifie pas l'user en cas d'échec.
 *
 * Conditions de sync :
 * - EPG activé (user preference)
 * - Pas de données OU MAX(stop_ts) < now + 2 jours
 */
export async function checkAndAutoSync(): Promise<void> {
  if (!isEpgEnabled()) return;

  // Sync d'une session précédente en train de s'arrêter : attendre sa fin avant de lire l'état du
  // guide (elle écrivait « syncing », ce qui déclenchait une purge du guide)
  if (isSyncing()) await waitForSyncEnd();

  // Environ 205 Mo : jamais en tâche de fond sur des données mobiles (réglage « Wi-Fi uniquement »)
  if (isEpgWifiOnly()) {
    const network = await getNetworkStatus();
    if (network.metered) {
      devLog('epg', `Synchro automatique reportee : connexion limitee (${network.type})`);
      return;
    }
  }

  try {
    const db = await getDatabase();
    const readMeta = async (key: string): Promise<string | undefined> => {
      const rows = await db.select<{ value: string }[]>(`SELECT value FROM meta WHERE key = '${key}'`);
      return rows[0]?.value;
    };

    // Check for interrupted sync (app was closed during previous sync)
    const syncStatus = await readMeta('epg_sync_status');
    const interrupted = Number(await readMeta('epg_sync_interrupted')) || 0;
    const pausedUntil = Number(await readMeta('epg_auto_sync_paused_until')) || 0;
    // Pause en cours après des synchros qui ne finissaient jamais : rien de lancé tout seul
    if (syncStatus !== 'complete' && Date.now() < pausedUntil) {
      devLog('epg', 'Synchro automatique en pause : les dernieres synchros se sont interrompues');
      return;
    }
    if (syncStatus === 'syncing') {
      // Sync précédente interrompue (app fermée, déconnexion, ou app tombée pendant la synchro) :
      // relancer. Plus de purge : le Rust n'a pas touché à l'ancien guide, qui reste affiché d'ici
      // là. Après plusieurs interruptions de suite, l'app tombe sans doute à
      // cause de ce guide : pause au lieu de la faire retomber à chaque lancement. Le compteur
      // n'est remis à zéro que par une synchro qui va au bout (succès ou erreur) : à la fin de la
      // pause, une seule nouvelle interruption suffit à la reprendre.
      const count = interrupted + 1;
      await setMeta('epg_sync_interrupted', String(count));
      if (count >= MAX_INTERRUPTED_SYNCS) {
        await setMeta('epg_auto_sync_paused_until', String(Date.now() + AUTO_SYNC_PAUSE_MS));
        await setMeta('epg_sync_status', 'paused');
        devLog('epg', `Synchro automatique mise en pause apres ${count} synchros interrompues`);
        return;
      }
      syncEpg().catch(() => {});
      return;
    }
    // La dernière synchro est allée au bout : les interruptions passées ne comptent plus
    if (interrupted > 0 && syncStatus !== 'paused') await setMeta('epg_sync_interrupted', '0');

    // Guide gardé pour les seules chaînes de l'utilisateur, et de nouvelles chaînes liées depuis
    // (catalogue actualisé, autre fournisseur) sans programmes : le recharger (epg_parser.rs, remap_epg)
    const resyncRows = await db.select<{ value: string }[]>(
      "SELECT value FROM meta WHERE key = 'epg_needs_resync'"
    );
    if (resyncRows[0]?.value === '1') {
      syncEpg().catch(() => {});
      return;
    }

    const result = await db.select<{ max_stop: number | null }[]>(
      'SELECT MAX(stop_ts) as max_stop FROM epg_programs'
    );
    const maxStop = result[0]?.max_stop;
    const now = Math.floor(Date.now() / 1000);
    const threshold = now + 172800; // +2 jours en secondes

    if (!maxStop || maxStop < threshold) {
      // Données périmées ou absentes → sync silencieuse
      syncEpg().catch(() => {
        // Silencieux — retry au prochain boot
      });
    }
  } catch {
    // Silencieux — table peut ne pas exister si première utilisation
  }
}

// ============================================================================
// BATCH QUERY — "Now Playing"
// ============================================================================

/**
 * Récupère les programmes "en cours" pour un lot de channel_ids.
 * Utilisé par useGridEpg pour alimenter les cartes ChannelCard.
 *
 * @param epgChannelIds — Liste des epg_channel_id à rechercher
 * @returns Map<channel_id, EpgNowInfo>
 */
export async function getBatchNowPrograms(
  epgChannelIds: string[]
): Promise<Map<string, EpgNowInfo>> {
  const map = new Map<string, EpgNowInfo>();
  if (epgChannelIds.length === 0) return map;

  const db = await getDatabase();
  const now = Math.floor(Date.now() / 1000);

  // SQLite SQLITE_MAX_VARIABLE_NUMBER = 999 par défaut.
  // On batch par 500 (+ 2 params now → 502 max par query, safe).
  const BATCH_SIZE = 500;

  interface EpgRow {
    channel_id: string;
    title: string;
    start_ts: number;
    stop_ts: number;
  }

  try {
    for (let i = 0; i < epgChannelIds.length; i += BATCH_SIZE) {
      const chunk = epgChannelIds.slice(i, i + BATCH_SIZE);
      const placeholders = chunk.map(() => '?').join(',');
      const query = `
        SELECT channel_id, title, start_ts, stop_ts
        FROM epg_programs
        WHERE channel_id IN (${placeholders})
          AND start_ts <= ?
          AND stop_ts > ?
        ORDER BY start_ts ASC
      `;

      const params = [...chunk, now, now];
      const rows = await db.select<EpgRow[]>(query, params);

      for (const row of rows) {
        // Ne garder que le premier programme par channel (le "current")
        if (map.has(row.channel_id)) continue;

        map.set(row.channel_id, {
          title: row.title,
          startTs: row.start_ts,
          stopTs: row.stop_ts,
          progress: computeEpgProgress(row.start_ts, row.stop_ts, now),
        });
      }
    }
  } catch {
    // Table peut ne pas exister — retourner map vide
  }

  return map;
}

// ============================================================================
// DAY QUERY — Guide TV Timeline
// ============================================================================

/**
 * Charge les programmes EPG d'une journée pour un ensemble de chaînes.
 * Retourne une Map channelId → programmes triés par startTs ASC.
 * Gère le chunking (500 IDs max) et les programmes chevauchant minuit.
 *
 * @param channelEpgIds — Liste des epg_channel_id à rechercher
 * @param dayMidnightTs — Timestamp epoch (secondes) du minuit UTC du jour à charger
 * @returns Map<channelId, EpgProgram[]> triée par startTs
 */
export async function getDayPrograms(
  channelEpgIds: string[],
  dayMidnightTs: number
): Promise<Map<string, EpgProgram[]>> {
  const map = new Map<string, EpgProgram[]>();
  if (channelEpgIds.length === 0) return map;

  const db = await getDatabase();
  const dayStart = dayMidnightTs;
  const dayEnd = dayMidnightTs + 86400; // +24h

  const BATCH_SIZE = 500;

  interface EpgRow {
    channel_id: string;
    title: string;
    start_ts: number;
    stop_ts: number;
  }

  try {
    for (let i = 0; i < channelEpgIds.length; i += BATCH_SIZE) {
      const chunk = channelEpgIds.slice(i, i + BATCH_SIZE);
      const placeholders = chunk.map(() => '?').join(',');
      const query = `
        SELECT channel_id, title, start_ts, stop_ts
        FROM epg_programs
        WHERE channel_id IN (${placeholders})
          AND start_ts < ?
          AND stop_ts > ?
        ORDER BY channel_id, start_ts ASC
      `;

      const params = [...chunk, dayEnd, dayStart];
      const rows = await db.select<EpgRow[]>(query, params);

      for (const row of rows) {
        let list = map.get(row.channel_id);
        if (!list) {
          list = [];
          map.set(row.channel_id, list);
        }
        list.push({
          channelId: row.channel_id,
          title: row.title,
          startTs: row.start_ts,
          stopTs: row.stop_ts,
        });
      }
    }
  } catch {
    // Table peut ne pas exister — retourner map vide
  }

  return map;
}

// ============================================================================
// SINGLE QUERY — "Now + Next" (Player Overlay)
// ============================================================================

/**
 * Récupère le programme en cours et le suivant pour UNE chaîne.
 * Utilisé par usePlayerEpg pour l'overlay bandeau dans le player Live TV.
 *
 * @param epgChannelId — ID EPG de la chaîne
 * @returns { now, next } — null si aucun programme trouvé
 */
export async function getNowAndNextProgram(
  epgChannelId: string
): Promise<{ now: EpgNowInfo | null; next: EpgNowInfo | null }> {
  const result = { now: null as EpgNowInfo | null, next: null as EpgNowInfo | null };
  if (!epgChannelId) return result;

  interface EpgRow {
    channel_id: string;
    title: string;
    description: string | null;
    start_ts: number;
    stop_ts: number;
  }

  try {
    const db = await getDatabase();
    const now = Math.floor(Date.now() / 1000);

    // Programme en cours
    const currentRows = await db.select<EpgRow[]>(
      `SELECT channel_id, title, description, start_ts, stop_ts
       FROM epg_programs
       WHERE channel_id = ? AND start_ts <= ? AND stop_ts > ?
       ORDER BY start_ts DESC LIMIT 1`,
      [epgChannelId, now, now]
    );

    if (currentRows.length > 0) {
      const row = currentRows[0];
      result.now = {
        title: row.title,
        description: row.description || undefined,
        startTs: row.start_ts,
        stopTs: row.stop_ts,
        progress: computeEpgProgress(row.start_ts, row.stop_ts, now),
      };
    }

    // Programme suivant (le plus proche dans le futur)
    const nextRows = await db.select<EpgRow[]>(
      `SELECT channel_id, title, description, start_ts, stop_ts
       FROM epg_programs
       WHERE channel_id = ? AND start_ts > ?
       ORDER BY start_ts ASC LIMIT 1`,
      [epgChannelId, now]
    );

    if (nextRows.length > 0) {
      const row = nextRows[0];
      result.next = {
        title: row.title,
        description: row.description || undefined,
        startTs: row.start_ts,
        stopTs: row.stop_ts,
        progress: 0,
      };
    }
  } catch {
    // Table peut ne pas exister — retourner résultat vide
  }

  return result;
}

// ============================================================================
// PURGE
// ============================================================================

/**
 * Purge les programmes expirés (stop_ts < maintenant).
 * Fire-and-forget — appelée au boot et après chaque sync.
 */
export async function purgeExpiredPrograms(): Promise<void> {
  try {
    const db = await getDatabase();
    const now = Math.floor(Date.now() / 1000);
    await db.execute('DELETE FROM epg_programs WHERE stop_ts < ?', [now]);
  } catch {
    // Table peut ne pas exister — ignore
  }
}

/**
 * Purge toutes les données EPG.
 * Appelée au toggle OFF (après confirmation) et au requestSyncAbort.
 */
export async function purgeEpgData(): Promise<void> {
  try {
    const db = await getDatabase();
    await db.execute('DELETE FROM epg_programs');
    await db.execute('DELETE FROM epg_channels');
    await db.execute("DELETE FROM meta WHERE key IN ('last_epg_sync', 'epg_sync_status', 'epg_sync_interrupted', 'epg_auto_sync_paused_until')");
  } catch {
    // Table peut ne pas exister — ignore
  }

  window.dispatchEvent(new Event(EPG_UPDATED_EVENT));
}

// ============================================================================
// UTILITY — Pure function (exportée pour test)
// ============================================================================

/**
 * Calcule le pourcentage de progression d'un programme EPG.
 *
 * @param startTs — Epoch seconds du début
 * @param stopTs — Epoch seconds de la fin
 * @param now — Epoch seconds actuel
 * @returns Pourcentage 0-100, clampé
 */
export function computeEpgProgress(startTs: number, stopTs: number, now: number): number {
  const duration = stopTs - startTs;
  if (duration <= 0) return 0;

  const elapsed = now - startTs;
  const raw = (elapsed / duration) * 100;

  // Clamp between 0 and 100
  return Math.max(0, Math.min(100, Math.round(raw)));
}
