/**
 * Full Reset Service — Remise à zéro complète de l'app.
 *
 * Séquence en 5 étapes + relance automatique (appRestart.ts) :
 *
 * 1. Clear OS Keychain (credentials IPTV)
 * 2. Clear localStorage (préserve session Supabase SAUF si deleteAccount)
 * 3. Clear Cache API (browser caches)
 * 4. Close connexion SQLite (libère le handle fichier)
 * 5. Rust: supprime physiquement le .db + .wal + .shm + iptv_data.json
 * 6. Relance de l'app (appRestart.ts) : nouveau processus sur ordinateur, page rechargée sur
 *    Android (la relance de Tauri y plante). Le schéma de la base du compte est recréé à
 *    chaque ouverture (dbCore.ts, CREATE TABLE IF NOT EXISTS).
 */

import { resetPersonalTmdbKeyCache } from './tmdbPersonalKey';
import { invoke } from '@tauri-apps/api/core';
import { restartApp } from './appRestart';
import { StorageService } from './storage';
import { closeDatabaseConnection, getDatabaseFileName, resetDatabaseName } from './dbCore';
import { stopBackgroundWork } from './backgroundWork';
import { stopSyncForSessionChange, waitForSyncEnd } from './epgService';
import { startCloudResync, stopCloudResync, waitForCloudResync } from './sync/syncScheduler';
import { getCurrentSyncUserId } from './sync/syncState';
import { purgeCloudData } from './syncService';
import { purgeDurableAuthSession } from './authStorage';
import { SUPABASE_STORAGE_KEY } from './supabaseClient';
import { devLog } from '../utils/devLog';
import { ACCOUNT_DELETED_NOTICE_KEY, ACCOUNT_DELETION_PENDING_KEY, clearAccountDeletionPending } from './accountDeletion';
import { getOpenLocalSpace, GUEST_SPACE_STORAGE_KEY } from './localSpace';
import { createLogger } from '../utils/logger';

const log = createLogger('FullReset');

/**
 * « Supprimer aussi mes données cloud » : une partie du cloud n'a pas pu être effacée. La remise à
 * zéro s'arrête avant d'effacer quoi que ce soit sur l'appareil, l'utilisateur est prévenu et peut
 * réessayer. Avant, l'échec était seulement journalisé.
 */
export class CloudPurgeError extends Error {
  readonly failedTables: string[];
  /** 'no-session' : aucun compte connecté à la synchro (session expirée), rien n'a été tenté */
  readonly reason: 'failed' | 'no-session';
  constructor(failedTables: string[], reason: 'failed' | 'no-session' = 'failed') {
    super(reason === 'no-session' ? 'Cloud purge impossible: no sync session' : `Cloud purge failed for: ${failedTables.join(', ')}`);
    this.name = 'CloudPurgeError';
    this.failedTables = failedTables;
    this.reason = reason;
  }
}

export async function performFullReset(options?: { purgeCloud?: boolean; deleteAccount?: boolean }): Promise<void> {
  devLog('session', 'Full Reset starting...', options?.deleteAccount ? '(account deletion)' : options?.purgeCloud ? '(+ cloud purge)' : '(local only)');

  // Plus de synchro relancée : celle en cours finit avant la purge, sinon elle renverrait au cloud
  // ce qu'on vient d'y effacer (sync/syncScheduler.ts)
  const syncUserId = getCurrentSyncUserId();
  stopCloudResync();
  await waitForCloudResync();

  // 0. Purge cloud data (si demandé). Échec, même partiel : rien n'est effacé sur l'appareil, les
  // relances de synchro reprennent et l'utilisateur est prévenu (CloudPurgeError)
  if (options?.purgeCloud) {
    if (!syncUserId) throw new CloudPurgeError([], 'no-session');
    const failedTables = await purgeCloudData();
    if (failedTables.length > 0) {
      log.warn(`  [0/6] ⚠ Cloud purge failed for ${failedTables.length} table(s), reset aborted:`, failedTables);
      if (syncUserId) startCloudResync(syncUserId);
      throw new CloudPurgeError(failedTables);
    }
    devLog('session', '[0/6] Cloud data purged');
  }

  // 1. Clear OS Keychain
  try {
    await StorageService.clearCredentials();
    devLog('session', '[1/6] OS Keychain cleared');
  } catch (e) {
    log.warn('  [1/6] ⚠ Keychain clear failed (non-fatal):', e);
  }

  // 2. Clear localStorage (preserve Supabase session)
  // Supabase stores its session token under key: sb-{project-ref}-auth-token
  const supabaseKeys: [string, string][] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith('sb-') && key.endsWith('-auth-token')) {
      supabaseKeys.push([key, localStorage.getItem(key) ?? '']);
    }
  }
  // Suppression du compte : sa marque reste jusqu'à l'effacement de la base (étape 5), pour qu'une
  // app fermée pendant le nettoyage le reprenne au lancement suivant (accountDeletion.ts)
  // (de même que le message d'un compte supprimé depuis un autre appareil, pour l'écran de connexion)
  const keptKeys: string[] = options?.deleteAccount ? [ACCOUNT_DELETION_PENDING_KEY, ACCOUNT_DELETED_NOTICE_KEY] : [];
  // L'espace invité est à part de celui d'un compte : effacer les données d'un compte n'oublie pas
  // l'identifiant de l'espace invité (sa base resterait sur l'appareil, sans plus personne pour la
  // retrouver). Depuis l'espace invité lui-même, tout part avec lui (base, coffre, identifiant).
  if (getOpenLocalSpace()?.kind !== 'guest') keptKeys.push(GUEST_SPACE_STORAGE_KEY);
  const kept = keptKeys.map((key) => [key, localStorage.getItem(key)] as const);
  localStorage.clear();
  for (const [key, value] of kept) if (value !== null) localStorage.setItem(key, value);
  // Restaurer la session Supabase SAUF si le compte est supprimé
  if (!options?.deleteAccount) {
    for (const [key, value] of supabaseKeys) {
      localStorage.setItem(key, value);
    }
  }
  // Android : la session Supabase est dans le coffre (authStorage.ts), pas dans le localStorage
  if (options?.deleteAccount) await purgeDurableAuthSession(SUPABASE_STORAGE_KEY);
  devLog('session', `[2/6] localStorage cleared${options?.deleteAccount ? ' (Supabase session purged)' : ` (${supabaseKeys.length} Supabase key(s) preserved)`}`);

  // 3. Clear browser Cache API
  try {
    const cacheKeys = await caches.keys();
    for (const key of cacheKeys) {
      await caches.delete(key);
    }
    devLog('session', `[3/6] Browser caches cleared (${cacheKeys.length} entries)`);
  } catch (_e) {
    devLog('session', '[3/6] Cache API not available (non-fatal)');
  }

  // Actualisation en arrière-plan et synchro du guide : leur accès à la base doit être rendu avant
  // la suppression (sous Windows, un fichier ouvert par le Rust ne se supprime pas)
  stopSyncForSessionChange();
  await stopBackgroundWork();
  await waitForSyncEnd();

  // 4. Close SQLite connection (releases file handle for step 5)
  // closeDatabaseConnection() also resets the JS singleton (db = null). Le nom de la base est
  // oublié AVANT la fermeture : un accès tardif (minuteur, position de lecture) échoue au lieu de
  // rouvrir le fichier, qui ne se supprimerait plus sous Windows
  const dbFileName = getDatabaseFileName();
  resetDatabaseName();
  resetPersonalTmdbKeyCache(); // une base recréée au même nom n'a plus la clé de l'ancienne
  await closeDatabaseConnection();
  devLog('session', '[4/6] SQLite connection closed + singleton reset');

  // 5. Rust: delete physical .db files (handle is free, safe to delete)
  try {
    await invoke('full_reset', { dbName: dbFileName });
    devLog('session', '[5/6] Physical DB files deleted');
    // Nettoyage du compte supprimé terminé ; en cas d'échec, la marque reste et le lancement
    // suivant réessaie (nombre d'essais borné)
    if (options?.deleteAccount) clearAccountDeletionPending();
  } catch (e) {
    // Fichier tenu (Windows) : le Rust a noté la suppression, terminée au prochain chargement de la base
    log.warn('  [5/6] ⚠ Physical delete failed, retried at next launch:', e);
  }

  // Affiches réduites gardées sur le disque par le Rust : la confirmation promet « Cache »
  try {
    await invoke('poster_cache_clear');
    devLog('session', '[5/6] Poster thumbnails cache cleared');
  } catch (e) {
    log.warn('  [5/6] ⚠ Poster thumbnails cache not cleared (non-fatal):', e);
  }

  // 6. Relance : plus aucun état en mémoire du compte effacé (appRestart.ts)
  devLog('session', '[6/6] Relaunching app...');
  await restartApp();
}

