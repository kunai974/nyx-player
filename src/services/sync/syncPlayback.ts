/**
 * syncPlayback.ts — Sync LWW des progressions de lecture au login
 */

import { supabase } from '../supabaseClient';
import { getDatabase } from '../dbCore';
import { getLastProviderHash } from '../preferencesService';
import type { SyncResult, CloudPlaybackRow, LocalPlaybackRow } from './syncTypes';
import { isoToMs } from './syncTypes';
import { PLAYBACK_EVENT } from '../eventConstants';
import { readBaseline, updateBaseline, canStillWrite, runExclusive, isMassRemoval, EMPTY_SIDE_REMOVAL_LIMIT } from './syncBaseline';
import { fetchAllRows } from './syncFetch';
import { cloudPosterUrl } from './cloudPoster';
import { cloudContainerExtension, cloudNextEpisodeId, cloudTitle } from './cloudLimits';
import { cloudWriteError } from './cloudRefusal';
import { providerSyncScope, localKey, cloudKey, baselineForScope, ownedRowHashes } from './providerSync';
import type { ProviderSyncScope } from './providerSync';
import { createLogger } from '../../utils/logger';
import { safeContainerExtension } from '../../utils/xtreamCredentials';

const log = createLogger('Sync');

type Database = Awaited<ReturnType<typeof getDatabase>>;

/** Type de fiche TMDB d'une reprise : un épisode porte le numéro TMDB de sa série */
const tmdbKey = (contentType: string, tmdbId: number) => `${contentType === 'movie' ? 'movie' : 'series'}:${tmdbId}`;

/**
 * Titres officiels (cache TMDB de l'appareil) des reprises reçues du cloud qui remplacent une
 * reprise locale de titre différent, par `tmdbKey`. Lu seulement quand il sert.
 */
async function readOfficialTitles(
  db: Database,
  incoming: CloudPlaybackRow[],
  localMap: Map<number, LocalPlaybackRow>,
): Promise<Map<string, string>> {
  const ids = new Set<number>();
  for (const row of incoming) {
    const local = localMap.get(row.stream_id);
    const localTmdb = local?.tmdb_id ?? 0;
    if (local && local.title !== row.title && localTmdb > 0) ids.add(localTmdb);
  }
  const titles = new Map<string, string>();
  if (ids.size === 0) return titles;
  try {
    const rows = await db.select<{ tmdb_id: number; type: string; display_name: string | null }[]>(
      `SELECT tmdb_id, type, display_name FROM tmdb_details_cache
       WHERE season_number = 0 AND display_name IS NOT NULL AND tmdb_id IN (${[...ids].map(() => '?').join(', ')})`,
      [...ids]
    );
    for (const row of rows) {
      if (row.display_name && (row.type === 'movie' || row.type === 'series')) titles.set(`${row.type}:${row.tmdb_id}`, row.display_name);
    }
  } catch (e) {
    // Sans cache lisible, seule la règle du numéro TMDB protège le titre local
    log.warn('Playback official titles unavailable:', e);
  }
  return titles;
}

/**
 * Numéro TMDB, titre et affiche enregistrés pour une reprise reçue du cloud.
 * Le titre officiel TMDB déjà connu ici n'est jamais remplacé par le nom brut du fournisseur, envoyé
 * par un appareil qui a relancé le titre sans passer par sa fiche (recherche, version 0.7.6…) :
 * - reprise reçue sans numéro TMDB : numéro, titre et affiche locaux gardés (l'affiche reçue
 *   seulement s'il n'y en a pas ici) ;
 * - même numéro TMDB, titre local égal au titre officiel du cache et titre reçu différent, ou titre
 *   reçu vide ou « Unknown » : titre local gardé.
 * Un autre numéro TMDB ou un autre type (numéro de flux passé à un autre titre) : la reprise reçue
 * telle quelle.
 * Une affiche absente ne remplace jamais celle du même titre.
 */
/** Titres de secours sans valeur (lecture enregistrée sans aucun nom) */
const PLACEHOLDER_TITLES = new Set(['', 'Unknown']);

function incomingIdentity(
  cloud: CloudPlaybackRow,
  local: LocalPlaybackRow | undefined,
  officialTitles: Map<string, string>,
): { tmdb_id: number; title: string; poster_url: string | null } {
  const cloudTmdb = cloud.tmdb_id ?? 0;
  const received = { tmdb_id: cloudTmdb, title: cloud.title, poster_url: cloud.poster_url };
  if (!local || local.content_type !== cloud.content_type) return received;
  const localTmdb = local.tmdb_id ?? 0;

  if (cloudTmdb <= 0 && localTmdb > 0) {
    return { tmdb_id: localTmdb, title: local.title, poster_url: local.poster_url ?? cloud.poster_url };
  }
  if (cloudTmdb !== localTmdb) return received;

  const official = cloudTmdb > 0 ? officialTitles.get(tmdbKey(cloud.content_type, cloudTmdb)) : undefined;
  const keepTitle = (official !== undefined && local.title === official && cloud.title !== official)
    || (PLACEHOLDER_TITLES.has(cloud.title) && !PLACEHOLDER_TITLES.has(local.title));
  return {
    tmdb_id: cloudTmdb,
    title: keepTitle ? local.title : cloud.title,
    poster_url: cloud.poster_url ?? local.poster_url,
  };
}

/**
 * Sync des reprises. Tables par fournisseur (sync/providerSync.ts) : seulement les reprises du
 * fournisseur de l'appareil ; une reprise d'un autre fournisseur au même numéro n'est ni reprise ici
 * ni retirée du cloud (pas de reprise d'une source à l'autre).
 */
export function syncPlayback(userId: string, result: SyncResult): Promise<void> {
  const scope = providerSyncScope('playback');
  if (!scope) {
    log.warn('playback: provider of this device unknown, not synced');
    return Promise.resolve();
  }
  return runExclusive(scope.baselineScope, () => syncPlaybackNow(userId, result, scope));
}

async function syncPlaybackNow(userId: string, result: SyncResult, scope: ProviderSyncScope): Promise<void> {
  // Dernier accord lu en premier (avant le cloud et le local), voir syncBaseline.readBaseline
  const baselineRead = await readBaseline(userId, scope.baselineScope);
  const baseline = Object.assign(baselineForScope(scope, baselineRead), { generation: baselineRead.generation, scope: baselineRead.scope });
  const key = (streamId: number) => localKey(scope, String(streamId));
  const db = await getDatabase();

  // 1. Pull cloud
  // Lu en entier, par pages : une réponse tronquée ferait prendre des reprises pour des retraits
  const cloudRows = await fetchAllRows<CloudPlaybackRow>(
    scope.table, userId, scope.on ? ['provider_hash', 'stream_id'] : ['stream_id'], 'playback',
  );

  const cloudMap = new Map<number, CloudPlaybackRow>();
  for (const row of (cloudRows || [])) {
    // Ligne d'un autre fournisseur ou illisible : laissée telle quelle
    if (cloudKey(scope, row.provider_hash, String(row.stream_id)) === null) continue;
    // Même reprise avec et sans empreinte (ancienne version) : la plus récente compte
    const seen = cloudMap.get(row.stream_id);
    if (!seen || isoToMs(row.updated_at) > isoToMs(seen.updated_at)) cloudMap.set(row.stream_id, row);
  }

  // 2. Pull local
  const localRows = await db.select<LocalPlaybackRow[]>(
    `SELECT stream_id, content_type, tmdb_id, title, poster_url,
            series_id, season_number, episode_number,
            next_episode_id, next_season, next_episode_number,
            time_seconds, duration_seconds, container_extension, updated_at
     FROM playback_progress`
  );

  const localMap = new Map<number, LocalPlaybackRow>();
  for (const row of localRows) {
    localMap.set(row.stream_id, row);
  }

  // 3. Merge LWW, avec le dernier accord (sync/syncBaseline.ts) pour les reprises présentes d'un
  //    seul côté : une reprise retirée ailleurs est retirée ici au lieu d'être renvoyée,
  //    un retrait dont l'envoi a échoué est rattrapé. Un côté modifié après le dernier accord
  //    garde la main : une reprise regardée de nouveau n'est jamais perdue.
  const toPushCloud: LocalPlaybackRow[] = [];
  const toInsertLocal: CloudPlaybackRow[] = [];
  let toRemoveLocal: LocalPlaybackRow[] = [];
  let toRemoveCloud: CloudPlaybackRow[] = [];
  const agreed = new Map<string, number>();

  for (const [streamId, cloudRow] of cloudMap) {
    const local = localMap.get(streamId);
    const cloudMs = isoToMs(cloudRow.updated_at);
    const known = baseline.get(key(streamId));

    if (!local) {
      if (known !== undefined && cloudMs <= known) {
        // Retirée ici, le cloud ne l'a pas su : on la retire du cloud
        toRemoveCloud.push(cloudRow);
      } else {
        // Cloud-only → insert local
        toInsertLocal.push(cloudRow);
      }
    } else if (cloudMs > local.updated_at) {
      // Cloud plus récent → update local
      toInsertLocal.push(cloudRow);
    } else if (local.updated_at > cloudMs) {
      // Local plus récent → push cloud
      toPushCloud.push(local);
    } else {
      agreed.set(key(streamId), cloudMs);
    }
  }

  // Local-only → push cloud, sauf si retirée ailleurs depuis le dernier accord
  for (const [streamId, local] of localMap) {
    if (cloudMap.has(streamId)) continue;
    const known = baseline.get(key(streamId));
    if (known !== undefined && local.updated_at <= known) toRemoveLocal.push(local);
    else toPushCloud.push(local);
  }

  // Garde-fous : cloud entièrement vide (retraits locaux) et retraits en masse dans le cloud
  if (cloudMap.size === 0 && toRemoveLocal.length > EMPTY_SIDE_REMOVAL_LIMIT) {
    log.warn(`Cloud empty: ${toRemoveLocal.length} local playback removals skipped`);
    toPushCloud.push(...toRemoveLocal);
    toRemoveLocal = [];
  }
  if (isMassRemoval(toRemoveCloud.length, cloudMap.size)) {
    log.warn(`${toRemoveCloud.length}/${cloudMap.size} cloud playback removals skipped (mass removal)`);
    toInsertLocal.push(...toRemoveCloud);
    toRemoveCloud = [];
  }
  // Plus rien n'est écrit si le compte a changé pendant la lecture du cloud
  if (!canStillWrite(userId, baseline)) return;

  // 4. Apply local inserts/updates
  const officialTitles = await readOfficialTitles(db, toInsertLocal, localMap);
  for (const cloudRow of toInsertLocal) {
    const updatedMs = isoToMs(cloudRow.updated_at);
    const shown = incomingIdentity(cloudRow, localMap.get(cloudRow.stream_id), officialTitles);

    await db.execute(
      `INSERT INTO playback_progress (
        content_type, stream_id, tmdb_id, title, poster_url,
        series_id, season_number, episode_number,
        next_episode_id, next_season, next_episode_number,
        time_seconds, duration_seconds, container_extension, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(stream_id) DO UPDATE SET
        content_type = excluded.content_type,
        tmdb_id = excluded.tmdb_id,
        title = excluded.title,
        poster_url = excluded.poster_url,
        series_id = excluded.series_id,
        season_number = excluded.season_number,
        episode_number = excluded.episode_number,
        next_episode_id = excluded.next_episode_id,
        next_season = excluded.next_season,
        next_episode_number = excluded.next_episode_number,
        time_seconds = excluded.time_seconds,
        duration_seconds = excluded.duration_seconds,
        container_extension = excluded.container_extension,
        updated_at = excluded.updated_at`,
      [
        cloudRow.content_type,
        cloudRow.stream_id,
        shown.tmdb_id,
        shown.title,
        shown.poster_url,
        cloudRow.series_id,
        cloudRow.season_number,
        cloudRow.episode_number,
        cloudRow.next_episode_id,
        cloudRow.next_season,
        cloudRow.next_episode_number,
        cloudRow.time_seconds,
        cloudRow.duration_seconds,
        safeContainerExtension(cloudRow.container_extension) ?? null,
        updatedMs,
      ]
    );
    result.playback.pulled++;
  }

  // 4b. Retirées ailleurs → retirer en local
  for (const local of toRemoveLocal) {
    await db.execute('DELETE FROM playback_progress WHERE stream_id = ?', [local.stream_id]);
    result.playback.pulled++;
  }

  // Retraits dans le cloud : seulement si rien n'a été effacé ni changé de compte entre-temps
  if (!canStillWrite(userId, baseline)) return;

  // 5. Retirées ici sans que le cloud le sache → retirer du cloud
  const removedFromCloud: string[] = [];
  for (const cloudRow of toRemoveCloud) {
    let request = supabase
      .from(scope.table)
      .delete()
      .eq('user_id', userId)
      .eq('stream_id', cloudRow.stream_id);
    // Ses lignes seulement, copie sans empreinte comprise (sync/providerSync.ts)
    if (scope.on) request = request.in('provider_hash', ownedRowHashes(scope));
    const { error: delErr } = await request;
    if (delErr) log.warn('Playback cloud delete failed:', delErr.message);
    else {
      removedFromCloud.push(key(cloudRow.stream_id));
      result.playback.pushed++;
    }
  }

  // 5b. Push to cloud. Empreinte du fournisseur : celle de l'appareil (tables par fournisseur),
  //     sinon sync/syncPurge.ts
  if (toPushCloud.length > 0) {
    const providerHash = scope.on ? scope.deviceHash : getLastProviderHash();
    const rows = toPushCloud.map((local) => ({
      user_id: userId,
      stream_id: local.stream_id,
      content_type: local.content_type,
      tmdb_id: local.tmdb_id ?? 0,
      title: cloudTitle(local.title),
      poster_url: cloudPosterUrl(local.poster_url),
      series_id: local.series_id,
      season_number: local.season_number,
      episode_number: local.episode_number,
      next_episode_id: cloudNextEpisodeId(local.next_episode_id),
      next_season: local.next_season,
      next_episode_number: local.next_episode_number,
      time_seconds: local.time_seconds,
      duration_seconds: local.duration_seconds,
      container_extension: cloudContainerExtension(local.container_extension),
      updated_at: new Date(local.updated_at).toISOString(),
      provider_hash: providerHash,
    }));

    const { error: upsertErr } = await supabase
      .from(scope.table)
      .upsert(rows, { onConflict: scope.on ? 'user_id,provider_hash,stream_id' : 'user_id,stream_id' });

    if (upsertErr) throw cloudWriteError('Supabase upsert playback', upsertErr);
    result.playback.pushed += toPushCloud.length;
  }

  // 6. Dernier accord : version de chaque reprise désormais identique des deux côtés
  const present = new Set([...cloudMap.keys(), ...localMap.keys()].map(key));
  await updateBaseline(userId, scope.baselineScope, {
    generation: baseline.generation,
    set: [
      ...agreed,
      ...toInsertLocal.map((row) => [key(row.stream_id), isoToMs(row.updated_at)] as [string, number]),
      ...toPushCloud.map((row) => [key(row.stream_id), row.updated_at] as [string, number]),
    ],
    remove: [
      ...toRemoveLocal.map((row) => key(row.stream_id)),
      ...removedFromCloud,
      ...[...baseline.keys()].filter((key) => !present.has(key)),
    ],
  });

  // Notify UI si des changements ont eu lieu
  if (result.playback.pulled > 0 || result.playback.pushed > 0) {
    window.dispatchEvent(new CustomEvent(PLAYBACK_EVENT));
  }
}
