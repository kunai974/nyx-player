/**
 * syncLiveTv.ts — Sync ensembliste des favoris Live TV au login
 */

import { supabase } from '../supabaseClient';
import { getDatabase } from '../dbCore';
import { getLastProviderHash } from '../preferencesService';
import { reloadLiveTvFromDb } from '../liveTvBookmarksService';
import type { SyncResult, CloudLiveTvBookmark } from './syncTypes';
import { fetchAllRows } from './syncFetch';
import { readBaseline, updateBaseline, planMerge, canStillWrite, runExclusive } from './syncBaseline';
import { fitsCloudProviderId } from './cloudLimits';
import { cloudWriteError } from './cloudRefusal';
import { providerSyncScope, localKey, cloudKey, itemKeyOf, baselineForScope, ownedRowHashes } from './providerSync';
import type { ProviderSyncScope } from './providerSync';
import { createLogger } from '../../utils/logger';

const log = createLogger('Sync');

/**
 * Sync Live TV bookmarks : fusion à trois (local, cloud, dernier accord, sync/syncBaseline.ts).
 * Un favori retiré sur un autre appareil est retiré ici au lieu d'être renvoyé, et un
 * retrait ou un ajout dont l'envoi a échoué est rattrapé.
 * Tables par fournisseur (sync/providerSync.ts) : seulement les favoris du fournisseur de l'appareil.
 */
export function syncLiveTv(userId: string, result: SyncResult): Promise<void> {
  const scope = providerSyncScope('livetv');
  if (!scope) {
    log.warn('liveTv: provider of this device unknown, not synced');
    return Promise.resolve();
  }
  return runExclusive(scope.baselineScope, () => syncLiveTvNow(userId, result, scope));
}

async function syncLiveTvNow(userId: string, result: SyncResult, scope: ProviderSyncScope): Promise<void> {
  // Dernier accord lu en premier (avant le cloud et le local), voir syncBaseline.readBaseline
  const baselineRead = await readBaseline(userId, scope.baselineScope);
  const baseline = Object.assign(baselineForScope(scope, baselineRead), { generation: baselineRead.generation, scope: baselineRead.scope });
  const db = await getDatabase();

  // 1. Pull cloud
  // Lu en entier, par pages : une réponse tronquée ferait prendre des favoris pour des retraits
  const cloudBookmarks = await fetchAllRows<CloudLiveTvBookmark>(
    scope.table, userId, scope.on ? ['provider_hash', 'bookmark_type', 'item_id'] : ['bookmark_type', 'item_id'], 'liveTv',
  );

  const cloudSet = new Set<string>();
  for (const row of (cloudBookmarks || []) as CloudLiveTvBookmark[]) {
    const key = cloudKey(scope, row.provider_hash, `${row.bookmark_type}::${row.item_id}`);
    if (key !== null) cloudSet.add(key);
  }

  // 2. Pull local
  const localFavs = await db.select<{ stream_id: number }[]>(
    'SELECT stream_id FROM live_tv_favorites'
  );
  const localPins = await db.select<{ category_id: string }[]>(
    'SELECT category_id FROM live_tv_pinned_categories'
  );

  const localSet = new Set<string>();
  for (const row of localFavs) {
    localSet.add(localKey(scope, `favorite::${row.stream_id}`));
  }
  // Catégorie au numéro démesuré : gardée ici, jamais envoyée (la base la refuserait)
  for (const row of localPins) {
    if (fitsCloudProviderId(row.category_id)) localSet.add(localKey(scope, `pinned_category::${row.category_id}`));
  }

  // 3. Fusion à trois ; plus rien n'est écrit si le compte a changé pendant la lecture du cloud
  const plan = planMerge(localSet, cloudSet, baseline);
  if (!canStillWrite(userId, baseline)) return;
  const split = (key: string) => {
    // Clés de cette portée seulement (fusion faite sur le fournisseur de l'appareil)
    const item = itemKeyOf(scope, key)!;
    const at = item.indexOf('::');
    return { type: item.slice(0, at) as 'favorite' | 'pinned_category', id: item.slice(at + 2) };
  };

  // 4. Ajoutés ailleurs → insérer en local
  for (const key of plan.pullToLocal) {
    const { type, id } = split(key);
    if (type === 'favorite') {
      await db.execute(
        'INSERT OR IGNORE INTO live_tv_favorites (stream_id, added_at) VALUES (?, ?)',
        [Number(id), Date.now()]
      );
    } else {
      await db.execute(
        'INSERT OR IGNORE INTO live_tv_pinned_categories (category_id, added_at) VALUES (?, ?)',
        [id, Date.now()]
      );
    }
    result.liveTv.pulled++;
  }

  // 5. Retirés ailleurs → retirer en local
  for (const key of plan.removeLocal) {
    const { type, id } = split(key);
    if (type === 'favorite') {
      await db.execute('DELETE FROM live_tv_favorites WHERE stream_id = ?', [Number(id)]);
    } else {
      await db.execute('DELETE FROM live_tv_pinned_categories WHERE category_id = ?', [id]);
    }
    result.liveTv.pulled++;
  }

  // Retraits dans le cloud : seulement si rien n'a été effacé ni changé de compte entre-temps
  if (!canStillWrite(userId, baseline)) return;

  // 6. Retirés ici sans que le cloud le sache → retirer du cloud
  const removedFromCloud: string[] = [];
  for (const key of plan.removeCloud) {
    const { type, id } = split(key);
    let request = supabase
      .from(scope.table)
      .delete()
      .eq('user_id', userId)
      .eq('bookmark_type', type)
      .eq('item_id', id);
    if (scope.on) request = request.in('provider_hash', ownedRowHashes(scope));
    const { error: delErr } = await request;
    if (delErr) log.warn('LiveTV cloud delete failed:', delErr.message);
    else {
      removedFromCloud.push(key);
      result.liveTv.pushed++;
    }
  }

  // 7. Ajoutés ici → push cloud
  if (plan.pushToCloud.length > 0) {
    // Empreinte du fournisseur : celle de l'appareil (tables par fournisseur), sinon sync/syncPurge.ts
    const providerHash = scope.on ? scope.deviceHash : getLastProviderHash();
    const rows = plan.pushToCloud.map((key) => {
      const { type, id } = split(key);
      return { user_id: userId, bookmark_type: type, item_id: id, provider_hash: providerHash };
    });

    const { error: upsertErr } = await supabase
      .from(scope.table)
      .upsert(rows, { onConflict: scope.on ? 'user_id,provider_hash,bookmark_type,item_id' : 'user_id,bookmark_type,item_id' });

    if (upsertErr) throw cloudWriteError('Supabase upsert liveTv', upsertErr);
    result.liveTv.pushed += plan.pushToCloud.length;
  }

  // 8. Dernier accord : ce qui est désormais des deux côtés, et ce qui n'est plus nulle part
  await updateBaseline(userId, scope.baselineScope, {
    generation: baseline.generation,
    set: [...plan.inBoth, ...plan.pullToLocal, ...plan.pushToCloud].map((key) => [key, 0] as [string, number]),
    remove: [...plan.removeLocal, ...removedFromCloud, ...plan.stale],
  });

  // 9. Reload in-memory cache
  if (plan.pullToLocal.length > 0 || plan.removeLocal.length > 0) {
    await reloadLiveTvFromDb();
  }
}
