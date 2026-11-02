/**
 * Xtream Codes API Types
 *
 * Type definitions exhaustives pour les réponses de l'API Xtream Codes.
 * Basées sur l'analyse des usages réels dans le code.
 *
 * NOTE: Les providers Xtream ont des structures de réponse variables.
 * Ces types couvrent tous les emplacements possibles des champs.
 */

import type { IptvSeries } from './iptv';

// ============= Authentication =============

export interface XtreamUserInfo {
  username: string;
  password: string;
  message: string;
  /** Nombre ou texte selon le panneau (« 0 » = refusé) */
  auth: 0 | 1 | '0' | '1';
  status: string;
  exp_date: string;
  is_trial: string;
  active_cons: string;
  created_at: string;
  max_connections: string;
  allowed_output_formats: string[];
}

export interface XtreamServerInfo {
  url: string;
  port: string;
  https_port: string;
  server_protocol: string;
  rtmp_port: string;
  timezone: string;
  timestamp_now: number;
  time_now: string;
}

export interface XtreamAuthResponse {
  user_info: XtreamUserInfo;
  server_info: XtreamServerInfo;
}

// ============= VOD Stream (Movie) =============

/**
 * Movie stream item from Xtream API
 * Utilisé dans les pages de détail et le dashboard.
 */
export interface XtreamMovie {
  stream_id: number | string;
  name: string;
  stream_icon?: string;
  backdrop_path?: string[]; // Array of backdrop URLs from Xtream
  tmdb?: number | string; // TMDB ID (may be present in get_vod_streams response)
  container_extension?: string; // Extension du fichier (mp4, mkv, avi...) — critique pour l'URL
}

// ============= VOD (Movies) Info =============

/**
 * Réponse de get_vod_info
 * Les providers placent tmdb_id à différents endroits
 */
export interface XtreamVodInfo {
  // Champs racine (certains providers)
  tmdb_id?: number | string;
  tmdb?: number | string;

  // Bloc info (structure standard)
  info?: {
    tmdb_id?: number | string;
    tmdb?: number | string;
    name?: string;
    title?: string;
    o_name?: string;
    year?: string;
    cover?: string;
    cover_big?: string;
    movie_image?: string;
    plot?: string;
    cast?: string;
    director?: string;
    genre?: string;
    release_date?: string;
    releasedate?: string;
    duration?: string;
    duration_secs?: number;
    bitrate?: number;
    rating?: string | number;
    rating_5based?: number;
    backdrop_path?: string[];
    youtube_trailer?: string;
    video?: {
      width?: number;
      height?: number;
      codec?: string;
    };
    audio?: {
      codec?: string;
      channels?: number;
    };
    container_extension?: string;
  };

  // Bloc movie_data (certains providers)
  movie_data?: {
    stream_id: number;
    name: string;
    tmdb_id?: number | string;
    added?: string;
    category_id?: string;
    category_ids?: number[];
    container_extension?: string;
    custom_sid?: string;
    direct_source?: string;
  };
}

// ============= Series Info =============

/**
 * Épisode d'une série Xtream
 */
export interface XtreamEpisode {
  id: string;
  episode_num: number;
  title: string;
  container_extension: string;
  info?: {
    tmdb_id?: number | string;
    name?: string;
    plot?: string;
    duration?: string;
    duration_secs?: number;
    bitrate?: number;
    releasedate?: string;
    movie_image?: string;
    rating?: number | string;
    season?: number;
    video?: {
      width?: number;
      height?: number;
      codec?: string;
    };
    video_width?: number; // Some providers put it here
    container_extension?: string; // Some providers duplicate it here
    audio?: {
      codec?: string;
      channels?: number;
    };
  };
  custom_sid?: string;
  added?: string;
  direct_source?: string;
  duration?: string | number;
}

/**
 * Saison d'une série Xtream
 */
export interface XtreamSeason {
  season_number: number;
  name: string;
  episode_count?: number;
  overview?: string;
  cover?: string;
  cover_big?: string;
  air_date?: string;
}

/**
 * Détails d'une série dans le bloc info
 */
export interface XtreamSeriesDetails {
  name: string;
  series_id?: number;
  cover?: string;
  plot?: string;
  cast?: string;
  director?: string;
  genre?: string;
  release_date?: string;
  releasedate?: string;
  last_modified?: string;
  rating?: string | number;
  rating_5based?: number;
  backdrop_path?: string[];
  youtube_trailer?: string;
  tmdb_id?: number | string;
  tmdb?: number | string;
  episode_run_time?: string;
  category_id?: string;
  category_ids?: number[];
}

/**
 * Réponse de get_series_info
 * Les providers placent tmdb_id à différents endroits
 */
export interface XtreamSeriesInfo {
  // Champs racine (certains providers)
  tmdb_id?: number | string;
  tmdb?: number | string;

  // Bloc info (structure standard)
  info?: XtreamSeriesDetails;

  // Bloc series_data (certains providers)
  series_data?: {
    tmdb_id?: number | string;
    tmdb?: number | string;
    name?: string;
    series_id?: number;
    cover?: string;
  };

  // Saisons
  seasons?: XtreamSeason[];

  // Épisodes groupés par numéro de saison
  episodes?: Record<string, XtreamEpisode[]>;
}

// ============= App Level Types =============

/**
 * Objet série complet transmis aux pages de détail.
 * Combine IptvSeries (from list) + Fetched Details (episodes, info)
 */

export interface AppSeriesInfo extends IptvSeries {
  // Episodes grouped by season number (from XtreamSeriesInfo.episodes)
  episodes?: Record<string, XtreamEpisode[]>;

  // Full info object from XtreamSeriesInfo.info
  // Contains tmdb_id, detailed plot, cast, etc.
  xtreamInfo?: XtreamSeriesDetails;

  // Versions grouped by TMDB ID (for multi-source handling)
  groupedVersions?: IptvSeries[];

  // Titre TMDB propre (passé depuis SeriesDetailPage)
  tmdbTitle?: string;
}
