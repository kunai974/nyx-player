/**
 * syncPurge.ts — Purge cloud + fetch provider hash
 */

import { supabase } from '../supabaseClient';
import { getCurrentSyncUserId } from './syncState';
import { getMeta, setMeta } from '../dbCore';
import { isSameAccount, clearBaselines } from './syncBaseline';
import { PROVIDER_DATA_SCOPES, providerTablesOn, cloudTable, type CloudDataKind } from './cloudScope';
import { devLog } from '../../utils/devLog';
import { createLogger } from '../../utils/logger';

const log = createLogger('Sync');
const providerLog = createLogger('Provider');

/** Tables effacées par « Supprimer aussi mes données cloud » */
export const CLOUD_PURGE_TABLES = ['user_preferences', 'user_watchlist', 'user_playback_progress', 'user_livetv_bookmarks', 'user_hidden_categories'] as const;

const PROVIDER_KINDS: CloudDataKind[] = ['watchlist', 'playback', 'livetv', 'hidden'];

/**
 * Tables à vider pour « Supprimer aussi mes données cloud ». Tables par fournisseur allumées : aussi
 * les tables `…_v2`, car un retrait dans les anciennes n'y est recopié que pour les lignes écrites
 * par une ancienne version ; ce que la nouvelle version y a écrit resterait.
 */
function cloudPurgeTables(): string[] {
  const tables: string[] = [...CLOUD_PURGE_TABLES];
  if (providerTablesOn()) tables.push(...PROVIDER_KINDS.map((kind) => cloudTable(kind, true)));
  return tables;
}

/**
 * Purge toutes les données cloud du user connecté (5 tables, 9 avec les tables par fournisseur).
 * Appelé par performFullReset quand l'option purgeCloud est cochée.
 * Retourne les tables qui n'ont pas pu être vidées (vide si tout est effacé) : un échec n'est plus
 * seulement journalisé, l'appelant prévient l'utilisateur.
 */
export async function purgeCloudData(): Promise<string[]> {
  const currentUserId = getCurrentSyncUserId();
  if (!currentUserId) {
    log.warn('purgeCloudData: no user connected, nothing purged');
    return cloudPurgeTables();
  }

  const failed: string[] = [];
  for (const table of cloudPurgeTables()) {
    try {
      const { error } = await supabase
        .from(table)
        .delete()
        .eq('user_id', currentUserId);

      if (error) {
        failed.push(table);
        log.warn(`Purge ${table} failed:`, error.message);
      } else {
        devLog('sync', `Purged ${table} for user ${currentUserId}`);
      }
    } catch (err) {
      failed.push(table);
      log.warn(`Purge ${table} failed:`, err);
    }
  }
  return failed;
}

// ============================================================================
// CHANGEMENT DE FOURNISSEUR
// ============================================================================

/** Tables du cloud dont les numéros (flux, catégories) n'ont de sens que pour un fournisseur */
export const PROVIDER_SCOPED_TABLES = ['user_playback_progress', 'user_livetv_bookmarks', 'user_hidden_categories'] as const;

/**
 * Marque, dans la base du compte, d'un effacement du cloud pas encore réussi : l'empreinte du
 * fournisseur à garder, ou '1' (ancienne marque, ou empreinte inconnue : tout effacer).
 * '0' ou absente : rien en attente.
 */
const PENDING_PURGE_KEY = 'provider_purge_pending';

/** Empreinte de fournisseur valide (SHA-256 en hexadécimal), seule acceptée dans le filtre */
const PROVIDER_HASH_PATTERN = /^[0-9a-f]{64}$/;
const validHash = (hash: string | null | undefined): string | null =>
  hash && PROVIDER_HASH_PATTERN.test(hash) ? hash : null;

/**
 * Retire du cloud, pour ce compte seulement, les positions de lecture, favoris TV et catégories
 * masquées de l'ancien fournisseur (mêmes effacements qu'avant, désormais attendus). L'effacement
 * est noté avant de commencer et oublié seulement une fois réussi : tant qu'il ne l'est pas (hors
 * ligne, app fermée au milieu), chaque synchro le retente d'abord et, s'il échoue encore, ne
 * synchronise pas ces trois types (sinon elle ramènerait les données de l'ancien fournisseur).
 *
 * `keepProviderHash` : empreinte du NOUVEAU fournisseur. Les lignes qu'elle marque (envoyées
 * par un autre appareil déjà passé à ce fournisseur) sont gardées ; seules partent les lignes d'un
 * autre fournisseur ou sans empreinte (0.7.6, lignes anciennes). Elle est notée dans la marque pour
 * que la reprise tardive garde la même. Sans empreinte valide : tout est effacé, comme avant.
 * Retourne true si les trois tables sont vidées pour ce compte.
 */
export async function purgeProviderCloudData(userId: string, keepProviderHash?: string | null): Promise<boolean> {
  if (!isSameAccount(userId)) return false;
  // Tables par fournisseur : chaque fournisseur garde ses données dans le cloud, rien n'est effacé.
  // Les anciennes tables ne sont plus touchées : un retrait y serait recopié dans les nouvelles.
  // Un effacement resté en attente d'avant n'a plus lieu d'être.
  if (providerTablesOn()) {
    await setMeta(PENDING_PURGE_KEY, '0');
    return true;
  }
  const keep = validHash(keepProviderHash);
  await setMeta(PENDING_PURGE_KEY, keep ?? '1');
  let purged = true;
  for (const table of PROVIDER_SCOPED_TABLES) {
    try {
      let query = supabase.from(table).delete().eq('user_id', userId);
      if (keep) query = query.or(`provider_hash.is.null,provider_hash.neq.${keep}`);
      const { error } = await query;
      if (error) {
        purged = false;
        providerLog.warn(`Cloud purge ${table} failed:`, error.message);
      }
    } catch (err) {
      purged = false;
      providerLog.warn(`Cloud purge ${table} failed:`, err);
    }
  }
  // Marque oubliée dans la base de ce compte seulement (le compte a pu changer pendant l'attente).
  // Dernier accord de ces trois types oublié d'abord : un élément envoyé au cloud pendant l'attente
  // (position, favori) vient d'être effacé avec le reste ; oublié, il est renvoyé à la synchro
  // suivante au lieu d'être pris pour un retrait fait ailleurs et effacé de l'appareil.
  if (purged && isSameAccount(userId)) {
    await clearBaselines(userId, PROVIDER_DATA_SCOPES);
    await setMeta(PENDING_PURGE_KEY, '0');
  }
  devLog('sync', purged ? 'Provider-scoped cloud data purged' : 'Provider-scoped cloud purge pending');
  return purged;
}

/**
 * À appeler avant de synchroniser les données propres au fournisseur : retente un effacement resté
 * en attente. Retourne true si ces données peuvent être synchronisées.
 */
export async function settlePendingProviderPurge(userId: string): Promise<boolean> {
  try {
    if (!isSameAccount(userId)) return false;
    const pending = await getMeta(PENDING_PURGE_KEY);
    if (!pending || pending === '0') return true;
    // Même empreinte gardée qu'au premier essai ; '1' (ancienne marque) ou marque illisible : tout
    // effacer plutôt qu'abandonner l'effacement
    return await purgeProviderCloudData(userId, validHash(pending));
  } catch (err) {
    providerLog.warn('Pending cloud purge not settled:', err);
    return false;
  }
}

/**
 * Fetch the cloud-stored provider hash for a given user.
 * Lightweight query (1 row, 1 column) — safe to await before syncOnLogin.
 * Used for multi-device provider change detection (Phase 2B).
 * Returns null if no hash stored or if offline/error.
 */
export async function fetchCloudProviderHash(userId: string): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from('user_preferences')
      .select('value')
      .eq('user_id', userId)
      .eq('key', 'last_provider_hash')
      .maybeSingle();

    if (error) {
      log.warn('fetchCloudProviderHash failed:', error.message);
      return null;
    }
    return data?.value ?? null;
  } catch (e) {
    log.warn('fetchCloudProviderHash error:', e);
    return null;
  }
}
