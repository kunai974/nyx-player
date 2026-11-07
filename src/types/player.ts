/**
 * player.ts — Types liés au lecteur vidéo
 *
 * Centralise les types partagés entre PlayerContext (Z6),
 * PlayerControls (Z7), seriesMetadataBuilder (Z10),
 * DashboardPage (Z8), et les services de playback.
 */

import type { XtreamEpisode, XtreamMovie } from './xtream';
import type { IptvStream } from './iptv';

/** Adresse de lecture d'une entrée de liste M3U, prise dans le catalogue (pas d'identifiants Xtream) */
export interface M3uStream {
  url: string;
  /** En-têtes demandés par la liste pour ce flux (gardés pour un usage futur du lecteur) */
  userAgent?: string;
  referrer?: string;
}

// ============================================================================
// PLAYABLE ITEM TYPES
// ============================================================================

/**
 * Union de tous les types de contenu jouables.
 * Utilisé par PlayerContext.play() et PlayerControls.
 */
export type PlayableItem = XtreamEpisode | IptvStream | XtreamMovie;

/**
 * Type minimal pour lecture directe depuis "Reprendre la lecture".
 * Compatible avec le dispatch de play() via les checks 'in' operator.
 */
export interface DirectPlayableItem {
  /** Pour films: stream_id + container_extension */
  stream_id?: number;
  /** Pour épisodes: id + container_extension */
  id?: string | number;
  /** Optionnel mais utilisé pour logs */
  name?: string;
  title?: string;
  episode_num?: number;
  /** Extension vidéo (optionnel — PlayerContext gère le fallback) */
  container_extension?: string;
  /** TMDB ID pour titre officiel, poster, déduplication (optionnel) */
  tmdb?: number;
}

/**
 * Options supplémentaires pour play().
 * Permet aux callers de fournir des métadonnées TMDB riches.
 */
export interface PlayOptions {
  tmdbTitle?: string;
  tmdbId?: number;
  posterUrl?: string;
  seriesId?: number;
}

// ============================================================================
// MPV TRACK
// ============================================================================

/** Piste audio/sous-titre/vidéo retournée par MPV (track-list) */
export interface Track {
  id: number;
  type: 'audio' | 'sub' | 'video';
  title?: string;
  lang?: string;
  selected?: boolean;
}

// ============================================================================
// SERIES METADATA
// ============================================================================

/** Métadonnées pour identifier un épisode dans "Reprendre la lecture" */
export interface SeriesMetadata {
  seriesId: number;        // series_id Xtream
  tmdbId?: number;         // TMDB ID de la série
  seriesName: string;      // Nom de la série (Xtream)
  seriesNameTmdb?: string; // Nom de la série (TMDB propre)
  seriesCover?: string;    // Image de la série
  seasonNumber: number;    // Numéro de saison
  episodeNumber: number;   // Numéro d'épisode
  episodeTitle: string;    // Titre de l'épisode
  episodeId: string;       // ID de l'épisode (pour lecture directe)
  containerExtension: string; // Format vidéo (mkv, mp4, etc.) pour construire l'URL
  /**
   * Lien vers l'épisode suivant (calculé au lancement).
   * - Object avec episodeId/season/episode si un épisode suivant existe
   * - null si c'est le dernier épisode de la série
   * - undefined si pas encore calculé
   */
  nextEpisode?: {
    episodeId: string;
    seasonNumber: number;
    episodeNumber: number;
    episodeTitle?: string;       // Titre de l'épisode suivant (Xtream)
    episodeCover?: string;       // Image de l'épisode suivant (Xtream)
    containerExtension?: string; // Format vidéo du prochain épisode
  } | null;
}

// ============================================================================
// GEEK STATS
// ============================================================================

/** Stats techniques du player (résolution, codec, FPS, bitrate, buffer...) */
export interface GeekStats {
  /** Video width in pixels */
  width: number;
  /** Video height in pixels */
  height: number;
  /** Video codec (h264, hevc, etc.) */
  videoCodec: string;
  /** Audio codec (aac, ac3, etc.) */
  audioCodec: string;
  /** Framerate */
  fps: number;
  /** Video bitrate in bps (0 if unavailable) */
  videoBitrate: number;
  /** Audio bitrate in bps (0 if unavailable) */
  audioBitrate: number;
  /** Number of dropped frames */
  dropFrames: number;
  /** Buffer duration in seconds */
  bufferSeconds: number;
  /** Hardware decoding method (d3d11va, nvdec, vaapi...) or 'sw' */
  hwdec: string;
  /** Pixel format (yuv420p, yuv420p10le...) */
  pixelFormat: string;
  /** Audio channel layout (Stereo, 5.1, 7.1...) */
  audioChannels: string;
}

