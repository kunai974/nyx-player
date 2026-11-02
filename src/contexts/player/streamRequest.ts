/**
 * Préparation d'une lecture, sans React : adresse du flux, position de départ, enregistrement du
 * début de lecture et épisode en cours. Sorti de PlayerContext pour être testé seul.
 */

import type { XtreamEpisode, AppSeriesInfo } from '../../types/xtream';
import type { XtreamApiService } from '../../services/xtreamApi';
import { startPlayback, getProgressByStreamId } from '../../services/playbackProgressService';
import { findEpisodeSeason } from '../../utils/episodeNavigation';
import type { PlayableItem, DirectPlayableItem, PlayOptions } from '../../types/player';
import { createLogger } from '../../utils/logger';
import { safeContainerExtension } from '../../utils/xtreamCredentials';

const log = createLogger('PlayerContext');
const buildStreamUrlLog = createLogger('buildStreamUrl');

/**
 * Résout la saison et le numéro d'épisode de l'item en cours de lecture.
 * Utilisé en interne pour appeler findAdjacentEpisode avec la bonne signature.
 */
export function resolveCurrentEpisodeInfo(
    series: AppSeriesInfo | null,
    currentlyPlaying: PlayableItem | null
): { season: number; episodeNum: number } | null {
    if (!series?.episodes || !currentlyPlaying) return null;
    if (!('id' in currentlyPlaying)) return null;

    const season = findEpisodeSeason(series.episodes, String(currentlyPlaying.id));
    if (season === null) return null;

    // Trouver le episode_num exact
    const eps = series.episodes[season] || [];
    // Numéro en nombre ou en texte selon le fournisseur
    const found = eps.find((ep: XtreamEpisode) => String(ep.id) === String(currentlyPlaying.id));
    return found ? { season, episodeNum: found.episode_num } : null;
}

/**
 * Construit l'URL de streaming Xtream à partir d'un item jouable.
 *
 * Détermine le type de contenu (film, épisode, live) par duck-typing
 * et génère l'URL correspondante via l'API Xtream.
 *
 * @returns { url, container } ou null si impossible de construire l'URL
 */
export function buildStreamUrl(
    item: PlayableItem | DirectPlayableItem,
    api: XtreamApiService
): { url: string; container: string; live: boolean } | null {
    let streamUrl = '';
    let container = 'ts';

    const streamType = 'stream_type' in item ? item.stream_type : undefined;
    const hasStreamId = 'stream_id' in item && item.stream_id;
    const hasId = 'id' in item && item.id;
    const itemContainerExt = 'container_extension' in item ? safeContainerExtension(item.container_extension) : undefined;

    // Déterminer le type et construire l'URL
    if (streamType === 'live' && hasStreamId) {
        // Live TV explicite. Si le provider renseigne un format (ts, m3u8) on l'utilise ; sinon m3u8
        // quand le compte n'autorise que le HLS (allowed_output_formats), sinon 'ts'.
        const liveExt = itemContainerExt ?? api.preferredLiveExtension();
        container = liveExt || 'ts';
        streamUrl = api.getStreamUrl('live', Number(item.stream_id), liveExt);
    } else if (itemContainerExt) {
        // VOD avec extension - distinguer film (stream_id) vs épisode (id)
        container = itemContainerExt;
        if (hasStreamId) {
            // Film: utilise stream_id avec type 'movie'
            streamUrl = api.getStreamUrl('movie', Number(item.stream_id), container);
        } else if (hasId) {
            // Épisode: utilise id avec type 'series'
            streamUrl = api.getStreamUrl('series', Number(item.id), container);
        }
    } else if (hasStreamId) {
        // Film (par défaut) — XtreamMovie depuis MovieDetailPage n'a pas
        // de container_extension ni stream_type, donc on fallback sur mp4.
        // ⚠️ Ce fallback mp4 peut causer un échec si le serveur exige l'extension exacte
        if (import.meta.env.DEV) {
            buildStreamUrlLog.warn('No container_extension for movie — falling back to mp4.', {
                streamId: item.stream_id,
                name: 'name' in item ? item.name : 'unknown',
            });
        }
        streamUrl = api.getStreamUrl('movie', Number(item.stream_id));
        container = 'mp4';
    } else if (hasId) {
        // Series episode (fallback sans container_extension)
        streamUrl = api.getStreamUrl('series', Number(item.id), container);
    }

    return streamUrl ? { url: streamUrl, container, live: streamType === 'live' && !!hasStreamId } : null;
}

/** Identifiant de progression d'un film ou d'un épisode (0 pour un direct ou un item sans identifiant). */
export function progressStreamId(item: PlayableItem | DirectPlayableItem): number {
    const isVOD = ('container_extension' in item && item.container_extension)
        || ('stream_type' in item && item.stream_type === 'movie')
        || ('episode_num' in item);
    if (!isVOD) return 0;
    const streamId = 'stream_id' in item && item.stream_id
        ? Number(item.stream_id)
        : ('id' in item ? Number(item.id) : 0);
    return streamId > 0 ? streamId : 0;
}

/**
 * Position où ouvrir un film ou un épisode : celle demandée (« Reprendre »), sinon la position
 * enregistrée, avec les règles de usePlayerPreferences (plus de 10 s, pas déjà vu à 95 %, pas dans
 * les 30 dernières secondes). Connue avant le chargement, elle évite d'ouvrir à 0 puis de sauter,
 * soit deux connexions au fournisseur.
 */
export async function resolveStartPosition(
    item: PlayableItem | DirectPlayableItem,
    startPosition: number | undefined,
): Promise<number | undefined> {
    if (startPosition && startPosition > 0) return startPosition;
    const streamId = progressStreamId(item);
    if (!streamId) return undefined;
    try {
        const saved = await getProgressByStreamId(streamId);
        if (!saved || saved.timeSeconds <= 10 || saved.progressPercent >= 95) return undefined;
        if (saved.durationSeconds > 0 && saved.timeSeconds >= saved.durationSeconds - 30) return undefined;
        return saved.timeSeconds;
    } catch (e) {
        // Sans position connue, usePlayerPreferences la restaure après le chargement (comportement d'avant)
        log.warn('resume position lookup failed:', e);
        return undefined;
    }
}

/**
 * Enregistre le début de lecture dans SQLite (fire-and-forget).
 *
 * Crée l'entrée de progression pour que finalizePlayback() puisse
 * calculer la durée totale. Ne s'applique qu'aux VOD (pas au live).
 */
export function recordPlaybackStart(
    item: PlayableItem | DirectPlayableItem,
    series: AppSeriesInfo | undefined,
    options: PlayOptions | undefined
): void {
    const streamId = 'stream_id' in item && item.stream_id
        ? Number(item.stream_id)
        : ('id' in item ? Number(item.id) : 0);

    const isVOD = ('container_extension' in item && item.container_extension)
        || ('stream_type' in item && item.stream_type === 'movie')
        || ('episode_num' in item);

    if (streamId <= 0 || !isVOD) return;

    // Déterminer le type de contenu (movie si stream_id, episode si id)
    const contentType: 'movie' | 'episode' = 'stream_id' in item && item.stream_id ? 'movie' : 'episode';

    // Construire le titre
    const title = 'name' in item ? item.name : ('title' in item ? item.title : 'Unknown');

    // Trouver le numéro de saison (pour épisodes)
    let seasonNumber: number | undefined;
    if ('episode_num' in item && series?.episodes) {
        const s = findEpisodeSeason(series.episodes, String((item as XtreamEpisode).id));
        if (s !== null) seasonNumber = s;
    }

    // Extraire container_extension depuis l'item joué
    const itemContainerExt = 'container_extension' in item ? safeContainerExtension(item.container_extension) : undefined;

    // Fire-and-forget: enregistre dans SQLite
    startPlayback({
        streamId,
        contentType,
        title: options?.tmdbTitle || title || 'Unknown',
        titleFromTmdb: Boolean(options?.tmdbTitle),
        tmdbId: options?.tmdbId || (series?.tmdb ? (typeof series.tmdb === 'number' ? series.tmdb : undefined) : undefined),
        posterUrl: options?.posterUrl || series?.cover || undefined,
        containerExtension: itemContainerExt || undefined,
        seriesId: options?.seriesId || series?.series_id,
        seasonNumber,
        episodeNumber: 'episode_num' in item ? (item as XtreamEpisode).episode_num : undefined,
    }).catch(e => log.warn('startPlayback failed:', e));
}
