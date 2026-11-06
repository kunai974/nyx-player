/**
 * Navigation Types for Nyx Player
 *
 * Types partagés pour la navigation entre pages.
 * Centralise les signatures de callback pour éviter les incohérences.
 *
 * CONTEXTE:
 * Avant ce refactor, 4 signatures différentes existaient pour naviguer vers un film/série:
 * - Dashboard: onNavigate(type, item)
 * - GlobalSearch: onMovieClick(movie, allVersions?)
 * - Watchlist: onMovieClick(tmdbId, name, posterUrl, streamId?)
 * - CategoryDetail: onItemClick(item)
 *
 * Ce fichier unifie tout en une seule signature: NavigateToContent
 */

import type { TmdbId } from './common';

// ============================================================================
// TAB TYPE
// ============================================================================

/** Tabs de navigation principaux de l'application */
export type TabType = 'dashboard' | 'movies' | 'series' | 'live' | 'watchlist' | 'search' | 'settings';

/**
 * Identifiant pour naviguer vers un contenu.
 *
 * RÈGLES:
 * - Au moins un des IDs doit être fourni
 * - `tmdbId` est préféré pour les lookups TMDB
 * - `streamId`/`seriesId` sont utilisés pour trouver l'item local exact
 */
export interface ContentIdentifier {
  /** TMDB ID (normalisé, 0 = absent) */
  tmdbId: TmdbId;

  /** Stream ID Xtream pour films (optionnel, pour lookup exact) */
  streamId?: number;

  /** Series ID Xtream pour séries (optionnel, pour lookup exact) */
  seriesId?: number;
}

/**
 * Type du contenu vers lequel naviguer.
 */
export type ContentType = 'movie' | 'series';

/**
 * Callback unifié pour naviguer vers une page de détail.
 *
 * USAGE:
 * ```typescript
 * // Depuis Dashboard (item brut)
 * navigateTo('movie', { tmdbId: movie.tmdb, streamId: movie.stream_id });
 *
 * // Depuis Watchlist (IDs seulement)
 * navigateTo('movie', { tmdbId: 123, streamId: 456 });
 *
 * // Depuis Search (avec groupe)
 * navigateTo('series', { tmdbId: series.tmdb, seriesId: series.series_id });
 * ```
 *
 * @param type - 'movie' ou 'series'
 * @param identifier - Identifiants du contenu
 */
export type NavigateToContent = (type: ContentType, identifier: ContentIdentifier) => void;

// ============================================================================
// LIVE TV VIEW MODE
// ============================================================================

/** Mode d'affichage Live TV — utilisé dans App, Sidebar, LiveTvPage */
export type LiveTvViewMode = 'grid' | 'epg';

