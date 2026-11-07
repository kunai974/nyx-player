/**
 * playbackPush.ts — Envois immédiats des progressions de lecture vers le cloud (fire-and-forget)
 */

import { supabase } from '../../supabaseClient';
import { canSync, getCurrentSyncUserId } from '../syncState';
import { getLastProviderHash } from '../../preferencesService';
import { currentGeneration } from '../syncBaseline';
import { afterSend } from './afterSend';
import { sendInBackground } from './sendInBackground';
import { cloudPosterUrl } from '../cloudPoster';
import { cloudContainerExtension, cloudNextEpisodeId, cloudTitle } from '../cloudLimits';
import { serverNow } from '../serverClock';
import { providerSyncScope, localKey, ownedRowHashes } from '../providerSync';

/**
 * Fire-and-forget upsert immédiat d'une progression vers Supabase.
 * Appelé par playbackProgressService.finalizePlayback() après chaque écriture locale.
 */
export function pushPlaybackUpsertToCloud(
  streamId: number,
  contentType: 'movie' | 'episode',
  data: {
    tmdb_id?: number;
    title: string;
    poster_url?: string | null;
    series_id?: number | null;
    season_number?: number | null;
    episode_number?: number | null;
    next_episode_id?: string | null;
    next_season?: number | null;
    next_episode_number?: number | null;
    time_seconds: number;
    duration_seconds: number;
    container_extension?: string | null;
    /** Date locale de la progression (ms) : envoyée pour que le cloud garde la bonne date.
     *  Sans elle, l'heure du serveur (sync/serverClock.ts) */
    updated_at?: number;
  }
): void {
  // Tables par fournisseur et fournisseur de l'appareil inconnu : la synchro suivante s'en charge
  const scope = providerSyncScope('playback');
  if (!canSync() || !scope) return;

  const userId = getCurrentSyncUserId()!;
  const generation = currentGeneration(scope.baselineScope);
  const updatedAt = data.updated_at ?? serverNow();
  sendInBackground(
    supabase
      .from(scope.table)
      .upsert(
        {
          user_id: userId,
          stream_id: streamId,
          content_type: contentType,
          tmdb_id: data.tmdb_id ?? 0,
          title: cloudTitle(data.title),
          poster_url: cloudPosterUrl(data.poster_url),
          series_id: data.series_id ?? null,
          season_number: data.season_number ?? null,
          episode_number: data.episode_number ?? null,
          next_episode_id: cloudNextEpisodeId(data.next_episode_id),
          next_season: data.next_season ?? null,
          next_episode_number: data.next_episode_number ?? null,
          time_seconds: data.time_seconds,
          duration_seconds: data.duration_seconds,
          container_extension: cloudContainerExtension(data.container_extension),
          updated_at: new Date(updatedAt).toISOString(),
          // Fournisseur de l'appareil (tables par fournisseur), sinon sync/syncPurge.ts
          provider_hash: scope.on ? scope.deviceHash : getLastProviderHash(),
        },
        { onConflict: scope.on ? 'user_id,provider_hash,stream_id' : 'user_id,stream_id' }
      ),
    'playback upsert',
    () => afterSend(userId, scope.baselineScope, generation, { set: [[localKey(scope, String(streamId)), updatedAt]] }),
  );
}

/**
 * Fire-and-forget delete immédiat d'une progression vers Supabase.
 * Appelé par playbackProgressService clear functions.
 */
export function pushPlaybackDeleteToCloud(streamId: number): void {
  const scope = providerSyncScope('playback');
  if (!canSync() || !scope) return;

  const userId = getCurrentSyncUserId()!;
  const generation = currentGeneration(scope.baselineScope);
  let request = supabase
    .from(scope.table)
    .delete()
    .eq('user_id', userId)
    .eq('stream_id', streamId);
  // Ses lignes seulement, copie sans empreinte comprise (sync/providerSync.ts)
  if (scope.on) request = request.in('provider_hash', ownedRowHashes(scope));
  sendInBackground(
    request,
    'playback delete',
    () => afterSend(userId, scope.baselineScope, generation, { remove: [localKey(scope, String(streamId))] }),
  );
}
