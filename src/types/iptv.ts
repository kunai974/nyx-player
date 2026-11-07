import type { TmdbId } from './common';

export interface XtreamCredentials {
  host: string;
  username: string;
  password: string;
  /**
   * Source de la session qui est une liste M3U (pas un abonnement Xtream) : adresse complète de la
   * liste, jamais journalisée. `host` vaut alors « m3u: » + hôte, et les identifiants sont vides
   * (services/sources/m3uListCredentials.ts).
   */
  m3u?: { url: string; epgUrl?: string };
}

export interface IptvCategory {
  category_id: string;
  category_name: string;
  parent_id: number;
}

export interface IptvStream {
  num: number;
  name: string;
  stream_type: 'live' | 'movie' | 'series';
  stream_id: number | string;
  stream_icon: string;
  epg_channel_id?: string;
  matched_epg_id?: string;
  match_method?: string;
  added: string;
  category_id: string;
  container_extension?: string;
  rating?: string;
  year?: string;
  /**
   * TMDB ID normalisé.
   * ⚠️ ATTENTION: Ce champ est normalisé à la réception via normalizeTmdbId().
   * - Toujours un number
   * - 0 = pas d'ID TMDB (utiliser hasValidTmdbId() pour vérifier)
   * @see utils/normalizeTmdb.ts
   */
  tmdb: TmdbId;
  backdrop_path?: string[]; // Array of backdrop URLs (fourni par Xtream)
}

export interface IptvSeries {
  num: number;
  name: string;
  series_id: number;
  cover: string;
  plot: string;
  cast: string;
  director: string;
  genre: string;
  releaseDate: string;
  last_modified: string;
  rating: string;
  category_id: string;
  /**
   * TMDB ID normalisé.
   * ⚠️ ATTENTION: Ce champ est normalisé à la réception via normalizeTmdbId().
   * - Toujours un number
   * - 0 = pas d'ID TMDB (utiliser hasValidTmdbId() pour vérifier)
   * @see utils/normalizeTmdb.ts
   */
  tmdb: TmdbId;
  backdrop_path?: string[]; // Array of backdrop URLs (fourni par Xtream)
}
