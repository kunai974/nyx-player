/**
 * hiddenCategoriesPush.ts — Envois immédiats d'une catégorie masquée (fire-and-forget)
 *
 * L'envoi de toutes les catégories d'un type d'un coup est dans hiddenCategoriesBatch.ts.
 */

import { supabase } from '../../supabaseClient';
import { canSync, getCurrentSyncUserId } from '../syncState';
import { getLastProviderHash } from '../../preferencesService';
import { currentGeneration } from '../syncBaseline';
import { afterSend } from './afterSend';
import { sendInBackground } from './sendInBackground';
import { fitsCloudProviderId } from '../cloudLimits';
import { providerSyncScope, localKey, ownedRowHashes } from '../providerSync';

/**
 * Fire-and-forget upsert immédiat d'une catégorie masquée vers Supabase.
 * Sans appelant dans l'app pour l'instant : l'écran des catégories passe par l'envoi groupé
 * (hiddenCategoriesBatch.ts). Gardé, avec ses tests, pour un envoi d'une seule catégorie.
 */
export function pushHiddenCategoryToCloud(
  categoryId: string,
  categoryType: string
): void {
  // Tables par fournisseur et fournisseur de l'appareil inconnu : la synchro suivante s'en charge
  const scope = providerSyncScope('hidden');
  // Numéro démesuré : gardé sur l'appareil, jamais envoyé (la base le refuserait)
  if (!canSync() || !scope || !fitsCloudProviderId(categoryId)) return;

  const userId = getCurrentSyncUserId()!;
  const generation = currentGeneration(scope.baselineScope);
  sendInBackground(
    supabase
      .from(scope.table)
      .upsert(
        {
          user_id: userId, category_id: categoryId, category_type: categoryType,
          provider_hash: scope.on ? scope.deviceHash : getLastProviderHash(),
        },
        { onConflict: scope.on ? 'user_id,provider_hash,category_id,category_type' : 'user_id,category_id,category_type' }
      ),
    'hidden category upsert',
    () => afterSend(userId, scope.baselineScope, generation, { set: [[localKey(scope, `${categoryId}::${categoryType}`), 0]] }),
  );
}

/**
 * Hard DELETE immédiat d'une catégorie masquée de Supabase (fire-and-forget).
 * Sans appelant dans l'app pour l'instant : l'écran des catégories passe par l'envoi groupé
 * (hiddenCategoriesBatch.ts). Gardé, avec ses tests, pour un envoi d'une seule catégorie.
 * Si offline ou erreur, la synchro suivante retire l'élément du cloud (dernier accord, syncBaseline.ts).
 */
export function pushHiddenCategoryDeleteToCloud(
  categoryId: string,
  categoryType: string
): void {
  const scope = providerSyncScope('hidden');
  if (!canSync() || !scope) return;

  const userId = getCurrentSyncUserId()!;
  const generation = currentGeneration(scope.baselineScope);
  let request = supabase
    .from(scope.table)
    .delete()
    .eq('user_id', userId)
    .eq('category_id', categoryId)
    .eq('category_type', categoryType);
  // Ses lignes seulement, copie sans empreinte comprise (sync/providerSync.ts)
  if (scope.on) request = request.in('provider_hash', ownedRowHashes(scope));
  sendInBackground(
    request,
    'hidden category delete',
    () => afterSend(userId, scope.baselineScope, generation, { remove: [localKey(scope, `${categoryId}::${categoryType}`)] }),
  );
}
