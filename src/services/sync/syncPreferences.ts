/**
 * syncPreferences.ts — Sync LWW des préférences au login
 */

import { supabase } from '../supabaseClient';
import { getDatabase } from '../dbCore';
import { refreshPreferencesCache } from '../preferencesService';
import type { SyncResult, CloudPref } from './syncTypes';
import { isoToMs } from './syncTypes';
import { isSameAccount } from './syncBaseline';
import { cloudWriteError } from './cloudRefusal';
import { providerTablesOn } from './cloudScope';

/**
 * Préférence du fournisseur partagée par le compte. Tables par fournisseur : ni envoyée ni reçue,
 * chaque appareil garde le sien (preferencesService.setLastProviderHash).
 */
const SHARED_PROVIDER_KEY = 'last_provider_hash';

export async function syncPreferences(userId: string, result: SyncResult): Promise<void> {
  const db = await getDatabase();

  // 1. Pull cloud
  const { data: cloudPrefs, error } = await supabase
    .from('user_preferences')
    .select('*')
    .eq('user_id', userId);

  if (error) throw new Error(`Supabase fetch prefs: ${error.message}`);

  const skipProviderKey = providerTablesOn();
  const cloudMap = new Map<string, CloudPref>();
  for (const row of (cloudPrefs || [])) {
    if (skipProviderKey && row.key === SHARED_PROVIDER_KEY) continue;
    cloudMap.set(row.key, row);
  }

  // 2. Pull local
  const localRows = await db.select<{ key: string; value: string; updated_at: number }[]>(
    'SELECT key, value, updated_at FROM user_preferences'
  );

  const localMap = new Map<string, { value: string; updated_at: number }>();
  for (const row of localRows) {
    if (skipProviderKey && row.key === SHARED_PROVIDER_KEY) continue;
    localMap.set(row.key, { value: row.value, updated_at: row.updated_at });
  }

  // 3. Merge LWW
  const toPushCloud: { key: string; value: string; updated_at: number }[] = [];
  const toUpdateLocal: { key: string; value: string; updated_at: number }[] = [];

  // Items in both or cloud-only
  for (const [key, cloudRow] of cloudMap) {
    const local = localMap.get(key);
    const cloudMs = isoToMs(cloudRow.updated_at);

    if (!local) {
      // Cloud-only → insert local
      toUpdateLocal.push({ key, value: cloudRow.value, updated_at: cloudMs });
    } else if (cloudMs > local.updated_at) {
      // Cloud plus récent → update local
      toUpdateLocal.push({ key, value: cloudRow.value, updated_at: cloudMs });
    } else if (local.updated_at > cloudMs) {
      // Local plus récent → push cloud
      toPushCloud.push({ key, value: local.value, updated_at: local.updated_at });
    }
    // Si égal → rien à faire
  }

  // Local-only → push cloud
  for (const [key, local] of localMap) {
    if (!cloudMap.has(key)) {
      toPushCloud.push({ key, value: local.value, updated_at: local.updated_at });
    }
  }

  // Plus rien n'est écrit si le compte a changé pendant la lecture du cloud
  if (!isSameAccount(userId)) return;

  // 4. Apply local updates
  for (const item of toUpdateLocal) {
    await db.execute(
      `INSERT INTO user_preferences (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [item.key, item.value, item.updated_at]
    );
    result.preferences.pulled++;
  }

  // 4b. Rafraîchir le cache mémoire pour que les getters synchrones
  // (getLanguage, getDashboardDefaultMode, etc.) retournent les valeurs pullées
  if (toUpdateLocal.length > 0) {
    await refreshPreferencesCache();
  }

  // 5. Push to cloud
  if (toPushCloud.length > 0) {
    const rows = toPushCloud.map((item) => ({
      user_id: userId,
      key: item.key,
      value: item.value,
      updated_at: new Date(item.updated_at).toISOString(),
    }));

    const { error: upsertErr } = await supabase
      .from('user_preferences')
      .upsert(rows, { onConflict: 'user_id,key' });

    if (upsertErr) throw cloudWriteError('Supabase upsert prefs', upsertErr);
    result.preferences.pushed = toPushCloud.length;
  }
}
