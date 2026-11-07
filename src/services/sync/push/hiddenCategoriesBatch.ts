/**
 * hiddenCategoriesBatch.ts — Envoi groupé des catégories masquées (par paquets, écrire d'abord)
 */

import { supabase } from '../../supabaseClient';
import { canSync, getCurrentSyncUserId } from '../syncState';
import { devLog } from '../../../utils/devLog';
import { getLastProviderHash } from '../../preferencesService';
import { currentGeneration } from '../syncBaseline';
import { afterSend } from './afterSend';
import { createLogger } from '../../../utils/logger';
import { fitsCloudProviderId } from '../cloudLimits';
import { isCloudLimitRefusal, noteCloudRefusal } from '../cloudRefusal';
import { providerSyncScope, localKey, itemKeyOf, ownedRowHashes } from '../providerSync';

const log = createLogger('Sync');

const HIDDEN_SYNC_CHUNK_SIZE = 200;

/**
 * Batch sync: synchronise TOUTES les catégories masquées d'un type vers le cloud.
 * Appelé par setAllHidden (bouton "Valider") au lieu de N fire-and-forget individuels.
 *
 * Stratégie "UPSERT-first, DELETE-after" :
 *   1. UPSERT par chunks de 200 (écrire d'abord — protège les données)
 *   2. DELETE orphelins (ceux qui ne sont plus masqués — nettoyer après)
 *
 * Mode de défaillance :
 *   - Si UPSERT échoue → on abandonne SANS supprimer (le cloud garde l'ancien état)
 *   - Si DELETE orphelins échoue → le cloud a "trop" de masquées (bénin)
 *
 * @returns true si le sync a complètement réussi, false en cas d'échec partiel
 */
export async function batchSyncHiddenCategoriesToCloud(
  categoryType: string,
  allCategoryIds: string[]
): Promise<boolean> {
  if (!canSync()) return true; // pas de sync possible = pas d'erreur
  // Tables par fournisseur et fournisseur de l'appareil inconnu : rien n'est envoyé, la synchro
  // suivante s'en charge (jamais rangé chez un autre fournisseur)
  const scope = providerSyncScope('hidden');
  if (!scope) {
    log.warn(`batchSync hidden categories (${categoryType}): provider of this device unknown, not sent`);
    return true;
  }
  const key = (id: string) => localKey(scope, `${id}::${categoryType}`);
  const onConflict = scope.on ? 'user_id,provider_hash,category_id,category_type' : 'user_id,category_id,category_type';
  // Numéro démesuré : gardé sur l'appareil, jamais envoyé (la base le refuserait et bloquerait tout
  // l'envoi). Il ne compte pas non plus dans l'ensemble voulu côté cloud.
  const categoryIds = allCategoryIds.filter(fitsCloudProviderId);

  const userId = getCurrentSyncUserId()!;
  const generation = currentGeneration(scope.baselineScope);
  const totalChunks = Math.ceil(categoryIds.length / HIDDEN_SYNC_CHUNK_SIZE);
  // Empreinte du fournisseur notée sur chaque ligne : celle de l'appareil (tables par fournisseur),
  // sinon sync/syncPurge.ts
  const providerHash = scope.on ? scope.deviceHash : getLastProviderHash();

  devLog('sync', `batchSync START: type=${categoryType}, total=${categoryIds.length}, chunks=${totalChunks}`);

  try {
    // === PHASE 1 : UPSERT par chunks (écrire d'abord) ===
    for (let i = 0; i < categoryIds.length; i += HIDDEN_SYNC_CHUNK_SIZE) {
      const chunkIndex = Math.floor(i / HIDDEN_SYNC_CHUNK_SIZE) + 1;
      const chunk = categoryIds.slice(i, i + HIDDEN_SYNC_CHUNK_SIZE);
      const rows = chunk.map((catId) => ({
        user_id: userId,
        category_id: catId,
        category_type: categoryType,
        provider_hash: providerHash,
      }));

      devLog('sync', `UPSERT chunk ${chunkIndex}/${totalChunks} (${chunk.length} rows)`);

      let { error } = await supabase
        .from(scope.table)
        .upsert(rows, { onConflict });

      // Retry 1 fois si échec
      if (error) {
        log.warn(`Chunk ${chunkIndex} failed, retrying...`, error.message);
        ({ error } = await supabase
          .from(scope.table)
          .upsert(rows, { onConflict }));

        if (error) {
          if (isCloudLimitRefusal(error)) noteCloudRefusal();
          log.warn(`Chunk ${chunkIndex} FAILED after retry:`, error.message);
          return false; // Abandon — on ne DELETE PAS (safe)
        }
      }
    }

    devLog('sync', `All ${totalChunks} UPSERT chunks succeeded for ${categoryType}`);
    await afterSend(userId, scope.baselineScope, generation, { set: categoryIds.map((id) => [key(id), 0] as [string, number]) });

    // === PHASE 2 : DELETE orphelins (nettoyer après) ===
    if (categoryIds.length === 0) {
      // Tout démasqué → supprimer tout pour ce type
      let request = supabase
        .from(scope.table)
        .delete()
        .eq('user_id', userId)
        .eq('category_type', categoryType);
      // Ses lignes seulement, copie sans empreinte comprise (sync/providerSync.ts)
      if (scope.on) request = request.in('provider_hash', ownedRowHashes(scope));
      const { error } = await request;

      if (error) {
        log.warn(`Delete all hidden (${categoryType}) failed:`, error.message);
      } else {
        await afterSend(userId, scope.baselineScope, generation, {
          removeWhere: (baselineKey) => itemKeyOf(scope, baselineKey)?.endsWith(`::${categoryType}`) ?? false,
        });
      }
    } else {
      // Récupérer TOUS les IDs cloud actuels (pas de limite PostgREST)
      let allCloudIds: string[] = [];
      let from = 0;
      const PAGE_SIZE = 1000;

      // Pagination pour éviter la limite de 1000 rows par défaut de PostgREST
      while (true) {
        let pageQuery = supabase
          .from(scope.table)
          .select('category_id')
          .eq('user_id', userId)
          .eq('category_type', categoryType);
        if (scope.on) pageQuery = pageQuery.in('provider_hash', ownedRowHashes(scope)).order('provider_hash').order('category_id');
        const { data: page, error: selectError } = await pageQuery.range(from, from + PAGE_SIZE - 1);

        if (selectError || !page) break;
        allCloudIds = allCloudIds.concat(page.map((r) => r.category_id as string));
        if (page.length < PAGE_SIZE) break; // dernière page
        from += PAGE_SIZE;
      }

      devLog('sync', `Cloud has ${allCloudIds.length} rows for ${categoryType}, desired=${categoryIds.length}`);

      const desiredSet = new Set(categoryIds);
      const toDelete = allCloudIds.filter((id) => !desiredSet.has(id));

      if (toDelete.length > 0) {
        devLog('sync', `Deleting ${toDelete.length} orphans for ${categoryType}`);
        // DELETE orphelins par chunks (évite les limites URL PostgREST)
        for (let i = 0; i < toDelete.length; i += HIDDEN_SYNC_CHUNK_SIZE) {
          const chunk = toDelete.slice(i, i + HIDDEN_SYNC_CHUNK_SIZE);
          let deleteRequest = supabase
            .from(scope.table)
            .delete()
            .eq('user_id', userId)
            .eq('category_type', categoryType)
            .in('category_id', chunk);
          if (scope.on) deleteRequest = deleteRequest.in('provider_hash', ownedRowHashes(scope));
          const { error: deleteError } = await deleteRequest;
          // Retrait raté : ces catégories restent dans le dernier accord, la synchro suivante les retire
          if (!deleteError) {
            await afterSend(userId, scope.baselineScope, generation, { remove: chunk.map(key) });
          }
        }
      }
    }

    devLog('sync', `Batch synced ${categoryIds.length} hidden categories (${categoryType})`);
    return true;
  } catch (err) {
    log.warn(`batchSync hidden categories (${categoryType}) failed:`, err);
    return false;
  }
}
