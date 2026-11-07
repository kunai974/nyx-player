/**
 * dashboardRematch.ts — Recalcul des rangées de l'accueil pour un catalogue neuf, sans rien afficher.
 * Le résultat s'installe avec `installDashboardRematch` (dashboardCache.ts).
 * Cache TMDB seulement par défaut : aucun appel réseau, aucun état « chargement ».
 */

import tmdb from './tmdbApi';
import type { HeroMovie } from '../types/dashboard';
import type { LightIndexes } from '../types/lightIndex';
import type { TmdbTrendingResult } from '../types/tmdb';
import {
  attachHeroLogos,
  buildHeroCandidates,
  matchTmdbList,
  readTmdbList,
} from './tmdbMatchingService';
import type { DashboardListKey, TmdbListKind, TrendingItem } from './tmdbMatchingService';
import { getEnabledGenres } from './preferencesService';
import { getTmdbLanguage } from '../utils/tmdbLanguage';
import {
  DASHBOARD_HERO_COUNT,
  DASHBOARD_ROW_LIMIT,
  baseKeyFor,
  dashboardCache,
  genreKeyFor,
  getDashboardCacheGeneration,
} from './dashboardCache';
import type { DashboardRematch } from './dashboardCache';
import { createLogger } from '../utils/logger';

const log = createLogger('Dashboard');

/** Clé des genres choisis, identique à celle de l'accueil (`enabledGenresKey`) */
export function currentGenresKey(): string {
  return JSON.stringify(getEnabledGenres());
}

// =============================================================================
// RECALCUL
// =============================================================================

export interface ComputeRematchOptions {
  /**
   * Autorise le réseau pour les listes TMDB expirées et les logos des nouveaux films de la
   * bannière. Faux par défaut : cache seulement (rafraîchissement en arrière-plan, Chromecast).
   * Vrai pour le bouton « Actualiser », où l'on attend de toute façon.
   */
  allowNetwork?: boolean;
}


/** Garde les éléments encore au catalogue, avec leur nouveau numéro */
function remapRow(items: readonly TrendingItem[], indexes: LightIndexes): TrendingItem[] {
  const out: TrendingItem[] = [];
  for (const item of items) {
    const local = item.type === 'movie'
      ? indexes.moviesByTmdb.get(item.tmdbId)
      : indexes.seriesByTmdb.get(item.tmdbId);
    if (!local) continue;
    out.push(local.id === item.id ? item : { ...item, id: local.id });
  }
  return out;
}

function remapHeroes(heroes: readonly HeroMovie[], indexes: LightIndexes): HeroMovie[] {
  const out: HeroMovie[] = [];
  for (const hero of heroes) {
    const local = hero.tmdbId ? indexes.moviesByTmdb.get(hero.tmdbId) : undefined;
    if (!local) continue;
    out.push(local.id === hero.id ? hero : { ...hero, id: local.id });
  }
  return out;
}

async function readListSafe(key: DashboardListKey, allowNetwork: boolean): Promise<TmdbTrendingResult[] | null> {
  try {
    return await readTmdbList(key, allowNetwork);
  } catch (e) {
    log.warn(`Liste TMDB ${key} illisible, rangée actuelle gardée`, e);
    return null;
  }
}

/** Liste en cache → rapprochement complet ; sinon rangée actuelle, renumérotée */
async function rematchRow(
  key: DashboardListKey,
  kind: TmdbListKind,
  current: readonly TrendingItem[],
  indexes: LightIndexes,
  allowNetwork: boolean,
): Promise<{ row: TrendingItem[]; raw: TmdbTrendingResult[] | null }> {
  const raw = await readListSafe(key, allowNetwork);
  return {
    raw,
    row: raw ? matchTmdbList(raw, indexes, kind, DASHBOARD_ROW_LIMIT) : remapRow(current, indexes),
  };
}

async function rematchHeroes(
  trending: TrendingItem[],
  rawTrending: TmdbTrendingResult[] | null,
  current: readonly HeroMovie[],
  indexes: LightIndexes,
  allowNetwork: boolean,
): Promise<HeroMovie[]> {
  if (!rawTrending) return remapHeroes(current, indexes);

  if (import.meta.env.VITE_BANC === '1') await tmdb.prepareBancImages();
  const candidates = buildHeroCandidates(trending, indexes, rawTrending, DASHBOARD_HERO_COUNT);
  // Logos déjà connus repris tels quels : pas d'appel réseau pour les films déjà affichés
  const knownLogos = new Map<number, string>();
  for (const hero of current) {
    if (hero.tmdbId && hero.logoUrl) knownLogos.set(hero.tmdbId, hero.logoUrl);
  }
  const missing = candidates.filter((h) => !knownLogos.has(h.tmdbId));
  const fetched = allowNetwork && missing.length > 0 ? await attachHeroLogos(missing) : missing;
  const fetchedLogos = new Map<number, string>();
  for (const hero of fetched) {
    if (hero.tmdbId && hero.logoUrl) fetchedLogos.set(hero.tmdbId, hero.logoUrl);
  }

  return candidates.map((hero) => {
    const logoUrl = knownLogos.get(hero.tmdbId) ?? fetchedLogos.get(hero.tmdbId);
    return logoUrl ? { ...hero, logoUrl } : hero;
  });
}

/**
 * Rangées de base (bannière, tendances, carrousels) rapprochées du catalogue neuf.
 * Null si l'accueil n'a encore rien calculé, ou dans une autre langue : il se chargera normalement.
 */
export async function computeBaseRematch(
  indexes: LightIndexes,
  options: ComputeRematchOptions = {},
): Promise<DashboardRematch['base']> {
  const lang = getTmdbLanguage();
  if (!dashboardCache.hasData || dashboardCache.baseFor?.lang !== lang) return null;
  const allowNetwork = options.allowNetwork ?? false;
  const current = { ...dashboardCache };

  const [trending, nowPlaying, onTheAir, topRated, popular] = await Promise.all([
    rematchRow('trending', 'mixed', current.trending, indexes, allowNetwork),
    rematchRow('now_playing', 'movie', current.nowPlaying, indexes, allowNetwork),
    rematchRow('on_the_air', 'series', current.onTheAir, indexes, allowNetwork),
    rematchRow('top_rated', 'movie', current.topRated, indexes, allowNetwork),
    rematchRow('popular', 'movie', current.popular, indexes, allowNetwork),
  ]);
  const heroMovies = await rematchHeroes(trending.row, trending.raw, current.heroMovies, indexes, allowNetwork);

  return {
    rows: {
      heroMovies,
      trending: trending.row,
      nowPlaying: nowPlaying.row,
      onTheAir: onTheAir.row,
      topRated: topRated.row,
      popular: popular.row,
    },
    key: baseKeyFor(indexes, lang),
  };
}

/**
 * Rangées « genres » rapprochées du catalogue neuf, pour les genres déjà calculés.
 * Null si elles n'ont jamais été calculées, ou pour d'autres genres ou une autre langue :
 * l'accueil fera alors son calcul normal.
 */
export async function computeGenreRematch(
  indexes: LightIndexes,
  options: ComputeRematchOptions = {},
): Promise<DashboardRematch['genres']> {
  const lang = getTmdbLanguage();
  const genresKey = currentGenresKey();
  const previous = dashboardCache.genreFor;
  if (!previous || previous.lang !== lang || previous.genresKey !== genresKey) return null;
  // Catalogue sans films : l'accueil vide lui-même ses rangées « genres »
  if (indexes.movies.size === 0) return null;
  const allowNetwork = options.allowNetwork ?? false;
  const currentCarousels = dashboardCache.genreCarousels;

  const carousels = new Map<number, TrendingItem[]>();
  const genreIds = getEnabledGenres();
  const rows = await Promise.all(genreIds.map((genreId) =>
    rematchRow(`genre_${genreId}`, 'movie', currentCarousels.get(genreId) ?? [], indexes, allowNetwork)
  ));
  genreIds.forEach((genreId, i) => carousels.set(genreId, rows[i].row));

  return { carousels, key: genreKeyFor(indexes, genresKey, lang) };
}

/**
 * Prépare les rangées de l'accueil pour un catalogue neuf, sans rien afficher.
 * Cache TMDB seulement par défaut (aucun appel réseau).
 */
export async function computeDashboardRematch(
  indexes: LightIndexes,
  options: ComputeRematchOptions = {},
): Promise<DashboardRematch> {
  const generation = getDashboardCacheGeneration();
  const [base, genres] = await Promise.all([
    computeBaseRematch(indexes, options),
    computeGenreRematch(indexes, options),
  ]);
  return { generation, base, genres };
}
