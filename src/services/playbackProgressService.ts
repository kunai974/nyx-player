/**
 * playbackProgressService.ts — CRUD des progressions de lecture
 *
 * Ce service gère le stockage et la récupération des positions de lecture
 * depuis SQLite (local-first).
 *
 * Flux: startPlayback() → [lecture MPV] → finalizePlayback()
 *
 * Fonctionnalités:
 * - startPlayback: Créer une entrée "pending" au clic Play
 * - updateProgress: Sauvegarde périodique (toutes les 30s)
 * - finalizePlayback: Mettre à jour progression à la fermeture
 * - getProgressByStreamId / getProgressByStreamIds: Lire les progressions
 * - clearProgress / clearMultipleProgress / clearProgressByType: Supprimer
 * - clearUnavailableResume: Retirer une carte « Introuvable » de « Reprendre »
 * - hasProgress: Vérifier si une progression existe
 *
 * Modules extraits:
 * - smartContinue.ts: getContinueWatching (carrousel Dashboard)
 * - progressRelink.ts: pushRelinkedProgress (reprises re-liées à un nouveau numéro, le cloud suit)
 */

import { getDatabase } from './dbCore';
import { pushPlaybackUpsertToCloud, pushPlaybackDeleteToCloud } from './syncService';
import { readBaseline } from './sync/syncBaseline';
import { providerSyncScope, localKey } from './sync/providerSync';
import { getCurrentSyncUserId } from './sync/syncState';
import { serverNow } from './sync/serverClock';
import { PLAYBACK_EVENT } from './eventConstants';

// Ré-exports pour rétro-compatibilité des importeurs existants
export { getContinueWatching, type PlaybackProgressItem } from './smartContinue';

// ============================================================================
// TYPES (usage interne CRUD)
// ============================================================================

import type { PlaybackProgressRow } from '../types/playbackProgress';
import { createLogger } from '../utils/logger';

const log = createLogger('PlaybackProgress');

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Récupère la progression d'un stream spécifique.
 */
export async function getProgressByStreamId(streamId: number): Promise<{
  timeSeconds: number;
  durationSeconds: number;
  progressPercent: number;
} | null> {
  const db = await getDatabase();
  
  try {
    const rows = await db.select<PlaybackProgressRow[]>(
      `SELECT time_seconds, duration_seconds FROM playback_progress WHERE stream_id = ?`,
      [streamId]
    );
    
    if (rows.length === 0) return null;
    
    const row = rows[0];
    const progressPercent = row.duration_seconds > 0
      ? (row.time_seconds / row.duration_seconds) * 100
      : 0;
    
    return {
      timeSeconds: row.time_seconds,
      durationSeconds: row.duration_seconds,
      progressPercent: Math.round(progressPercent),
    };
  } catch (error) {
    log.error('getProgressByStreamId error:', error);
    return null;
  }
}

/**
 * Progress info pour un épisode
 */
export interface EpisodeProgressInfo {
  timeSeconds: number;
  durationSeconds: number;
  progressPercent: number;
}

/**
 * Récupère la progression de plusieurs streams en une seule requête.
 * Utilisé pour afficher les barres de progression dans SeriesDetailPage.
 */
export async function getProgressByStreamIds(
  streamIds: (number | string)[]
): Promise<Map<number, EpisodeProgressInfo>> {
  const result = new Map<number, EpisodeProgressInfo>();
  
  if (streamIds.length === 0) return result;
  
  const db = await getDatabase();
  
  try {
    const placeholders = streamIds.map(() => '?').join(', ');
    const rows = await db.select<PlaybackProgressRow[]>(
      `SELECT stream_id, time_seconds, duration_seconds 
       FROM playback_progress 
       WHERE stream_id IN (${placeholders})`,
      streamIds.map(id => Number(id))
    );
    
    for (const row of rows) {
      const progressPercent = row.duration_seconds > 0
        ? (row.time_seconds / row.duration_seconds) * 100
        : 0;
      
      result.set(row.stream_id, {
        timeSeconds: row.time_seconds,
        durationSeconds: row.duration_seconds,
        progressPercent: Math.round(progressPercent),
      });
    }
  } catch (error) {
    log.error('getProgressByStreamIds error:', error);
  }
  
  return result;
}

/**
 * Récupère la progression la plus récente par tmdb_id (multi-source safe).
 * Pour chaque tmdb_id, retourne l'entrée avec le updated_at le plus récent,
 * indépendamment du stream_id (= source IPTV).
 *
 * Utilisé par WatchlistPage pour afficher les barres de progression
 * même si le film a été regardé sur une autre source IPTV.
 *
 * Ignore les entrées avec tmdb_id = 0 (non identifiées TMDB).
 */
export async function getProgressByTmdbIds(
  tmdbIds: number[]
): Promise<Map<number, EpisodeProgressInfo>> {
  const result = new Map<number, EpisodeProgressInfo>();

  // Filtrer les tmdb_id invalides (0 ou négatifs)
  const validIds = tmdbIds.filter(id => id > 0);
  if (validIds.length === 0) return result;

  const db = await getDatabase();

  try {
    const placeholders = validIds.map(() => '?').join(', ');
    const rows = await db.select<(PlaybackProgressRow & { tmdb_id: number })[]>(
      `SELECT tmdb_id, time_seconds, duration_seconds, updated_at
       FROM playback_progress
       WHERE tmdb_id IN (${placeholders})
         AND tmdb_id > 0
         AND content_type = 'movie'
       ORDER BY tmdb_id, updated_at DESC`,
      validIds
    );

    // Dédup : la première ligne par tmdb_id est la plus récente (ORDER BY updated_at DESC)
    for (const row of rows) {
      if (result.has(row.tmdb_id)) continue; // Déjà vu = plus récent déjà pris

      const progressPercent = row.duration_seconds > 0
        ? (row.time_seconds / row.duration_seconds) * 100
        : 0;

      result.set(row.tmdb_id, {
        timeSeconds: row.time_seconds,
        durationSeconds: row.duration_seconds,
        progressPercent: Math.round(progressPercent),
      });
    }
  } catch (error) {
    log.error('getProgressByTmdbIds error:', error);
  }

  return result;
}

/**
 * Supprime la progression d'un stream.
 */
export async function clearProgress(streamId: number | string): Promise<void> {
  const db = await getDatabase();
  const numId = Number(streamId);
  
  try {
    await db.execute(
      `DELETE FROM playback_progress WHERE stream_id = ?`,
      [numId]
    );
    window.dispatchEvent(new CustomEvent(PLAYBACK_EVENT));
    // Fire-and-forget : propager la suppression vers Supabase immédiatement
    pushPlaybackDeleteToCloud(numId);
  } catch (error) {
    log.error('clearProgress error:', error);
    throw error; // l'écran ne doit pas annoncer une réussite
  }
}

/**
 * Vérifie si une progression existe pour un stream.
 */
export async function hasProgress(streamId: number | string): Promise<boolean> {
  const db = await getDatabase();
  
  try {
    const rows = await db.select<{ count: number }[]>(
      `SELECT COUNT(*) as count FROM playback_progress WHERE stream_id = ?`,
      [Number(streamId)]
    );
    return (rows[0]?.count ?? 0) > 0;
  } catch (error) {
    log.error('hasProgress error:', error);
    return false;
  }
}

/**
 * Supprime plusieurs progressions d'un coup.
 */
export async function clearMultipleProgress(streamIds: (number | string)[]): Promise<void> {
  if (streamIds.length === 0) return;
  
  const db = await getDatabase();
  const numIds = streamIds.map(id => Number(id));
  
  try {
    const placeholders = numIds.map(() => '?').join(', ');
    await db.execute(
      `DELETE FROM playback_progress WHERE stream_id IN (${placeholders})`,
      numIds
    );
    window.dispatchEvent(new CustomEvent(PLAYBACK_EVENT));
    // Fire-and-forget : propager chaque suppression vers Supabase
    for (const id of numIds) {
      pushPlaybackDeleteToCloud(id);
    }
  } catch (error) {
    log.error('clearMultipleProgress error:', error);
    throw error;
  }
}

/** Carte « Introuvable » de « Reprendre » à retirer (champs de `PlaybackProgressItem`) */
export interface UnavailableResume {
  /** Numéro affiché : celui du film ; pour une série, un épisode (parfois l'épisode suivant) */
  id: number;
  type: 'movie' | 'series';
  tmdbId: number | null;
  seriesId?: number;
  /** Date de la reprise affichée (la plus récente du titre) */
  lastWatched?: number;
}

/**
 * Retire de « Reprendre » le titre d'une carte « Introuvable », en local et dans le cloud.
 *
 * Une carte regroupe toutes les reprises du même titre TMDB (`smartContinue.ts`) : elles partent
 * toutes, sinon une reprise plus ancienne du même titre reprendrait aussitôt la place. Le titre est
 * reconnu à son numéro TMDB, jamais au numéro du fournisseur : ce numéro désigne désormais un autre
 * titre, dont les reprises restent. Un film sans numéro TMDB ne retire que sa propre reprise.
 * Une série sans numéro TMDB n'est jamais « Introuvable » (`resumeTarget.ts`) : rien n'est retiré.
 * Les épisodes du même numéro de série enregistrés sans numéro TMDB (passage à l'épisode suivant)
 * partent aussi s'ils ne sont pas plus récents que la carte : ils datent d'avant la réattribution du
 * numéro, donc de ce titre, et reprendraient sinon la place de la carte, lançables.
 * @returns Le nombre de reprises retirées
 */
export async function clearUnavailableResume(card: UnavailableResume): Promise<number> {
  const tmdbId = card.tmdbId ?? 0;
  let query: string;
  let params: number[];
  if (card.type === 'movie') {
    query = tmdbId > 0
      ? `SELECT stream_id FROM playback_progress WHERE content_type = 'movie' AND (stream_id = ? OR tmdb_id = ?)`
      : `SELECT stream_id FROM playback_progress WHERE content_type = 'movie' AND stream_id = ?`;
    params = tmdbId > 0 ? [Number(card.id), tmdbId] : [Number(card.id)];
  } else {
    if (tmdbId <= 0) return 0;
    const untagged = card.seriesId && card.lastWatched
      ? ` OR (series_id = ? AND COALESCE(tmdb_id, 0) <= 0 AND updated_at <= ?)`
      : '';
    query = `SELECT stream_id FROM playback_progress WHERE content_type = 'episode' AND (tmdb_id = ?${untagged})`;
    params = untagged ? [tmdbId, card.seriesId!, card.lastWatched!] : [tmdbId];
  }

  try {
    const db = await getDatabase();
    const rows = await db.select<{ stream_id: number }[]>(query, params);
    const ids = rows.map((row) => row.stream_id);
    // Mêmes effets que les autres retraits : rangée rafraîchie, suppressions envoyées au cloud
    await clearMultipleProgress(ids);
    return ids.length;
  } catch (error) {
    log.error('clearUnavailableResume error:', error);
    return 0;
  }
}

// Reprises de films renumérotés : re-liées par le Rust, jamais effacées (progressRelink.ts)

/**
 * Supprime les progressions par type (movie ou episode).
 * Utilisé par SettingsPage pour reset sélectif.
 * @returns Le nombre d'entrées supprimées
 */
export async function clearProgressByType(contentType: 'movie' | 'episode'): Promise<number> {
  const db = await getDatabase();
  
  try {
    // Récupérer les stream_ids AVANT suppression pour le fire-and-forget cloud
    const idsResult = await db.select<{ stream_id: number }[]>(
      `SELECT stream_id FROM playback_progress WHERE content_type = ?`,
      [contentType]
    );
    const count = idsResult.length;
    
    // Supprimer
    await db.execute(
      `DELETE FROM playback_progress WHERE content_type = ?`,
      [contentType]
    );
    
    // Dispatch event pour refresh Dashboard
    window.dispatchEvent(new CustomEvent(PLAYBACK_EVENT));
    
    // Fire-and-forget : propager chaque suppression vers Supabase
    for (const row of idsResult) {
      pushPlaybackDeleteToCloud(row.stream_id);
    }
    
    return count;
  } catch (error) {
    log.error('clearProgressByType error:', error);
    throw error; // distinct de « rien à effacer » (0)
  }
}


// ============================================================================
// START PLAYBACK (Called on Play click - fire-and-forget)
// ============================================================================

/** Paramètres pour démarrer une lecture (appelé au clic Play) */
interface StartPlaybackParams {
  streamId: number;
  tmdbId?: number;
  contentType: 'movie' | 'episode';
  title: string;
  /**
   * Titre officiel TMDB (fourni par la fiche) : seul un tel titre remplace celui déjà enregistré.
   * Sinon (nom brut du fournisseur, lecture depuis la recherche…), il ne sert qu'à une première
   * lecture.
   */
  titleFromTmdb?: boolean;
  posterUrl?: string;
  containerExtension?: string;
  // Séries only
  seriesId?: number;
  seasonNumber?: number;
  episodeNumber?: number;
}

/** Reprise telle qu'elle était avant la lecture en cours */
interface ProgressBeforePlayback {
  time_seconds: number;
  duration_seconds: number;
  updated_at: number;
}

/**
 * Reprise d'avant, par flux, gardée en mémoire du début de la lecture à sa fermeture : une lecture
 * arrêtée sous 2 % la remet en place au lieu d'effacer le titre. La position, elle, est
 * écrasée toutes les 30 s pendant la lecture (updateProgress).
 */
const progressBeforePlayback = new Map<number, ProgressBeforePlayback>();

/**
 * Enregistre le début d'une lecture dans SQLite.
 * Appelé au clic Play (fire-and-forget) depuis DetailPage.
 * Crée une entrée "pending" avec progress = 0.
 */
export async function startPlayback(params: StartPlaybackParams): Promise<void> {
  const db = await getDatabase();
  // Les dates d'une reprise règlent les conflits avec les autres appareils : heure du serveur
  const now = serverNow();
  
  try {
    // Une reprise déjà enregistrée (durée connue) est retenue telle quelle, voir finalizePlayback
    const previous = await db.select<ProgressBeforePlayback[]>(
      `SELECT time_seconds, duration_seconds, updated_at FROM playback_progress WHERE stream_id = ?`,
      [params.streamId]
    );
    const prior = Array.isArray(previous) ? previous[0] : undefined;
    if (prior && prior.duration_seconds > 0) progressBeforePlayback.set(params.streamId, prior);
    else progressBeforePlayback.delete(params.streamId);

    // Un titre TMDB déjà enregistré n'est jamais remplacé par le nom brut du fournisseur. Le nom
    // du fournisseur ne remplace qu'un titre vide ou « Unknown », ou celui d'un autre contenu (numéro
    // repris par un autre titre : autre type ou autre numéro TMDB)
    const titleUpdate = params.titleFromTmdb
      ? 'excluded.title'
      : `CASE WHEN playback_progress.title IN ('', 'Unknown')
          OR excluded.content_type <> playback_progress.content_type
          OR (excluded.tmdb_id > 0 AND excluded.tmdb_id <> playback_progress.tmdb_id)
        THEN excluded.title ELSE playback_progress.title END`;
    await db.execute(
      `INSERT INTO playback_progress (
        content_type, stream_id, tmdb_id, title, poster_url,
        series_id, season_number, episode_number,
        next_episode_id, next_season, next_episode_number,
        time_seconds, duration_seconds, container_extension, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(stream_id) DO UPDATE SET
        content_type = excluded.content_type,
        tmdb_id = CASE WHEN excluded.tmdb_id > 0 THEN excluded.tmdb_id ELSE playback_progress.tmdb_id END,
        title = ${titleUpdate},
        poster_url = COALESCE(excluded.poster_url, playback_progress.poster_url),
        series_id = COALESCE(excluded.series_id, playback_progress.series_id),
        season_number = COALESCE(excluded.season_number, playback_progress.season_number),
        episode_number = COALESCE(excluded.episode_number, playback_progress.episode_number),
        container_extension = COALESCE(excluded.container_extension, playback_progress.container_extension),
        updated_at = excluded.updated_at`,
      [
        params.contentType,
        params.streamId,
        params.tmdbId ?? 0,
        params.title,
        params.posterUrl ?? null,
        params.seriesId ?? null,
        params.seasonNumber ?? null,
        params.episodeNumber ?? null,
        null, // next_episode_id (sera set par finalize)
        null, // next_season
        null, // next_episode_number
        0,    // time_seconds = 0 (pending)
        0,    // duration_seconds = 0 (pending)
        params.containerExtension ?? null,
        now,
      ]
    );
  } catch (error) {
    log.error('startPlayback error:', error);
    // Ne pas throw - c'est fire-and-forget
  }
}

// ============================================================================
// UPDATE PROGRESS (Periodic save every 30s — crash-resilient)
// ============================================================================

/**
 * Met à jour la progression en cours de lecture.
 * Appelé toutes les 30s par PlayerControls (fire-and-forget).
 * UPDATE léger : seulement time + duration + updated_at.
 * Ne touche PAS à next_episode, poster_url, etc.
 */
export async function updateProgress(
  streamId: number,
  timeSeconds: number,
  durationSeconds: number
): Promise<void> {
  const db = await getDatabase();
  try {
    await db.execute(
      `UPDATE playback_progress SET time_seconds = ?, duration_seconds = ?, updated_at = ? WHERE stream_id = ?`,
      [timeSeconds, durationSeconds, serverNow(), streamId]
    );
  } catch (error) {
    log.warn('updateProgress error:', error);
    // Ne pas throw - c'est fire-and-forget
  }
  // Les snapshots intermédiaires restent locaux — seul finalizePlayback() push vers le cloud (position finale stable).
}

// ============================================================================
// FINALIZE PLAYBACK (Called on close)
// ============================================================================

/** Paramètres pour finaliser une lecture (appelé à la fermeture) */
interface FinalizePlaybackParams {
  streamId: number;
  timeSeconds: number;
  durationSeconds: number;
  // Smart Continue: infos sur l'épisode suivant
  nextEpisode?: {
    episodeId: string;
    seasonNumber: number;
    episodeNumber: number;
  } | null;
}

/**
 * Envoie au cloud (fire-and-forget) la ligne locale complète d'une reprise, datée de [updatedAt].
 */
async function pushProgressRowToCloud(streamId: number, updatedAt: number): Promise<void> {
  const db = await getDatabase();
  const rows = await db.select<{ content_type: string; tmdb_id: number; title: string; poster_url: string | null; series_id: number | null; season_number: number | null; episode_number: number | null; next_episode_id: string | null; next_season: number | null; next_episode_number: number | null; time_seconds: number; duration_seconds: number; container_extension: string | null }[]>(
    `SELECT content_type, tmdb_id, title, poster_url, series_id, season_number, episode_number, next_episode_id, next_season, next_episode_number, time_seconds, duration_seconds, container_extension FROM playback_progress WHERE stream_id = ?`,
    [streamId]
  );
  if (rows.length > 0) {
    const row = rows[0];
    pushPlaybackUpsertToCloud(streamId, row.content_type as 'movie' | 'episode', {
      tmdb_id: row.tmdb_id,
      title: row.title,
      poster_url: row.poster_url,
      series_id: row.series_id,
      season_number: row.season_number,
      episode_number: row.episode_number,
      next_episode_id: row.next_episode_id,
      next_season: row.next_season,
      next_episode_number: row.next_episode_number,
      time_seconds: row.time_seconds,
      duration_seconds: row.duration_seconds,
      container_extension: row.container_extension,
      updated_at: updatedAt,
    });
  }
}

/**
 * Finalise une lecture dans SQLite.
 * Appelé à la fermeture du lecteur.
 * 
 * Logique :
 * - progress < 2%  → pas vraiment regardé : reprise d'avant remise en place, ou DELETE si le titre
 *   n'en avait pas
 * - 2% ≤ progress ≤ 95% → UPDATE (garde tout)
 * - progress > 95% → UPDATE + poster_url = NULL (économie espace)
 */
export async function finalizePlayback(params: FinalizePlaybackParams): Promise<void> {
  const db = await getDatabase();
  const now = serverNow();
  
  // Calcul du pourcentage
  const progressPercent = params.durationSeconds > 0 
    ? (params.timeSeconds / params.durationSeconds) * 100 
    : 0;
  
  const previous = progressBeforePlayback.get(params.streamId);
  progressBeforePlayback.delete(params.streamId);

   try {
    // < 2% → pas vraiment regardé : comme si rien ne s'était passé
    if (progressPercent < 2) {
      if (previous) {
        // Reprise d'avant remise en place, date comprise : l'appareil reste d'accord avec le cloud,
        // rien n'est envoyé ni retiré. Avant, le titre disparaissait puis revenait du cloud.
        // Exception : une synchro passée pendant la lecture a envoyé une position intermédiaire,
        // plus récente (dernier accord) ; la reprise d'avant est alors redatée et renvoyée, sinon
        // cette position l'emporterait à la synchro suivante.
        // Dernier accord des tables du cloud en service (par fournisseur ou non, sync/providerSync.ts)
        const userId = getCurrentSyncUserId();
        const scope = providerSyncScope('playback');
        const known = userId && scope
          ? (await readBaseline(userId, scope.baselineScope)).get(localKey(scope, String(params.streamId)))
          : undefined;
        const overtaken = known !== undefined && known > previous.updated_at;
        const updatedAt = overtaken ? now : previous.updated_at;
        await db.execute(
          `UPDATE playback_progress SET time_seconds = ?, duration_seconds = ?, updated_at = ? WHERE stream_id = ?`,
          [previous.time_seconds, previous.duration_seconds, updatedAt, params.streamId]
        );
        window.dispatchEvent(new CustomEvent(PLAYBACK_EVENT));
        if (overtaken) await pushProgressRowToCloud(params.streamId, updatedAt);
      } else {
        // Titre neuf : effacé. Jamais envoyé au cloud (startPlayback n'envoie rien)
        await db.execute(
          `DELETE FROM playback_progress WHERE stream_id = ?`,
          [params.streamId]
        );
      }
      return;
    }
    
    // > 95% → Effacer le poster SAUF si Smart Continue actif
    // (le carrousel Dashboard a besoin du poster pour l'épisode suivant)
    const shouldClearPoster = progressPercent > 95 && !params.nextEpisode;
    
    // Valider next_episode_id (éviter NaN)
    const nextEpisodeId = params.nextEpisode?.episodeId;
    const safeNextEpisodeId = nextEpisodeId && !isNaN(Number(nextEpisodeId)) 
      ? nextEpisodeId 
      : null;
    
    // UPDATE unifié avec poster_url conditionnel
    const posterClause = shouldClearPoster ? ', poster_url = NULL' : '';
    await db.execute(
      `UPDATE playback_progress SET
        time_seconds = ?,
        duration_seconds = ?,
        next_episode_id = ?,
        next_season = ?,
        next_episode_number = ?,
        updated_at = ?
        ${posterClause}
      WHERE stream_id = ?`,
      [
        params.timeSeconds,
        params.durationSeconds,
        safeNextEpisodeId,
        params.nextEpisode?.seasonNumber ?? null,
        params.nextEpisode?.episodeNumber ?? null,
        now,
        params.streamId,
      ]
    );
    
    // Purge automatique : garder max 500 entrées. Le retrait reste dans le dernier accord avec le
    // cloud (sync/syncBaseline.ts) : la synchro suivante l'efface du cloud, sauf si un autre appareil
    // a regardé le titre depuis (sa reprise, plus récente, revient alors ici). Avant, il était oublié
    // du dernier accord et revenait du cloud à chaque synchro, qui gardait tout sans limite.
    await db.execute(
      `DELETE FROM playback_progress 
       WHERE id NOT IN (
         SELECT id FROM playback_progress 
         ORDER BY updated_at DESC 
         LIMIT 500
       )`
    );
    // Dispatch event pour notifier le Dashboard
    window.dispatchEvent(new CustomEvent(PLAYBACK_EVENT));
    
    // Fire-and-forget : pusher la progression finale vers Supabase
    await pushProgressRowToCloud(params.streamId, now);
    
  } catch (error) {
    log.error('finalizePlayback error:', error);
    throw error;
  }
}
