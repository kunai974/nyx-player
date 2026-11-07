/**
 * liveTvPush.ts — Envois immédiats des favoris et catégories épinglées Live TV (fire-and-forget)
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
 * Hard DELETE immédiat d'un bookmark Live TV de Supabase (fire-and-forget).
 * Appelé par liveTvBookmarksService quand on retire un favori ou une catégorie épinglée.
 * Si offline ou erreur, la synchro suivante retire l'élément du cloud (dernier accord, syncBaseline.ts).
 */
export function pushLiveTvBookmarkDeleteToCloud(
  bookmarkType: 'favorite' | 'pinned_category',
  itemId: string
): void {
  // Tables par fournisseur et fournisseur de l'appareil inconnu : la synchro suivante s'en charge
  const scope = providerSyncScope('livetv');
  if (!canSync() || !scope) return;

  const userId = getCurrentSyncUserId()!;
  const generation = currentGeneration(scope.baselineScope);
  let request = supabase
    .from(scope.table)
    .delete()
    .eq('user_id', userId)
    .eq('bookmark_type', bookmarkType)
    .eq('item_id', itemId);
  // Ses lignes seulement, copie sans empreinte comprise (sync/providerSync.ts)
  if (scope.on) request = request.in('provider_hash', ownedRowHashes(scope));
  sendInBackground(
    request,
    'liveTv bookmark delete',
    () => afterSend(userId, scope.baselineScope, generation, { remove: [localKey(scope, `${bookmarkType}::${itemId}`)] }),
  );
}

/**
 * Fire-and-forget upsert immédiat d'un bookmark Live TV vers Supabase.
 * Appelé par liveTvBookmarksService.toggleFavorite() / togglePinnedCategory() après chaque ajout.
 */
export function pushLiveTvBookmarkUpsertToCloud(
  bookmarkType: 'favorite' | 'pinned_category',
  itemId: string
): void {
  const scope = providerSyncScope('livetv');
  // Numéro démesuré : gardé sur l'appareil, jamais envoyé (la base le refuserait)
  if (!canSync() || !scope || !fitsCloudProviderId(itemId)) return;

  const userId = getCurrentSyncUserId()!;
  const generation = currentGeneration(scope.baselineScope);
  sendInBackground(
    supabase
      .from(scope.table)
      .upsert(
        {
          user_id: userId, bookmark_type: bookmarkType, item_id: itemId,
          provider_hash: scope.on ? scope.deviceHash : getLastProviderHash(),
        },
        { onConflict: scope.on ? 'user_id,provider_hash,bookmark_type,item_id' : 'user_id,bookmark_type,item_id' }
      ),
    'liveTv bookmark upsert',
    () => afterSend(userId, scope.baselineScope, generation, { set: [[localKey(scope, `${bookmarkType}::${itemId}`), 0]] }),
  );
}
