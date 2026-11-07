/**
 * tmdbMatchingService.ts - Logique de matching TMDB avec bibliothèque locale
 *
 * Ce module cross-référence les données TMDB (trending, now playing, etc.)
 * avec le catalogue local IPTV pour afficher uniquement le contenu disponible.
 *
 * ANTI-HALLUCINATION:
 * ⚠️ Toutes les fonctions getTmdb*AndMatch() suivent le même pattern:
 *   1. Vérifier le cache SQLite (getCachedList)
 *   2. Si pas en cache, appeler API TMDB et cacher le résultat
 *   3. Utiliser les index O(1) pour trouver les matches locaux
 *   4. Retourner uniquement le contenu qui existe dans la bibliothèque locale
 *
 * ⚠️ NE JAMAIS appeler TMDB API directement sans passer par le cache
 * ⚠️ TOUJOURS utiliser les ContentIndexes pré-construits quand disponibles
 * ⚠️ Les résultats sont limités par le paramètre `limit` pour les performances
 */

import type { LightIndexes } from '../types/lightIndex';
import { getIconUrl } from '../types/lightIndex';
import type { TmdbMovieDetails, TmdbTrendingResult } from '../types/tmdb';
import tmdb from './tmdbApi';
import { cacheMovieDetails, getCachedDetails, getCachedList, setCachedList } from './tmdbCacheSqlite';
import type { HeroMovie } from '../types/dashboard';
import { getTmdbLanguage } from '../utils/tmdbLanguage';
import { pickBestLogo } from '../utils/tmdbLogoHelper';
import { backdropImageSize } from '../utils/tmdbImageSize';
import { createLogger } from '../utils/logger';

const log = createLogger('TmdbMatching');

// ============================================================================
// TYPES
// ============================================================================

/** Item trending unifié (film ou série) - RAM-optimized Phase 4 */
export interface TrendingItem {
  id: number | string; // stream_id or series_id (pour fetch à la demande)
  tmdbId: number;
  title: string;
  image: string;
  rating: number;
  overview?: string;
  type: 'movie' | 'series';
  // NOTE: Plus de champ 'data' - on fetch via getMovieDetail/getSeriesDetail au clic
}

// ============================================================================
// RAPPROCHEMENT PUR (sans réseau ni base)
// ============================================================================

/** Genre de liste TMDB : films, séries, ou les deux mélangés (tendances) */
export type TmdbListKind = 'mixed' | 'movie' | 'series';

/**
 * Rapproche une liste TMDB du catalogue local, sans réseau ni base.
 *
 * Fonction pure, partagée par les `getTmdb*AndMatch` (premier chargement de l'accueil) et par le
 * recalcul des rangées après une actualisation du catalogue (`computeDashboardRematch`), qui la
 * rappelle sur les listes déjà en cache avec le catalogue neuf.
 *
 * @param items - Liste TMDB brute (telle qu'en cache)
 * @param lightIndexes - Catalogue local (index par tmdbId)
 * @param kind - 'mixed' pour les tendances (media_type distingue film et série)
 * @param limit - Nombre max de résultats
 */
export function matchTmdbList(
  items: readonly TmdbTrendingResult[],
  lightIndexes: LightIndexes,
  kind: TmdbListKind,
  limit: number = 20
): TrendingItem[] {
  const movieIndex = lightIndexes.moviesByTmdb;
  const seriesIndex = lightIndexes.seriesByTmdb;
  const matches: TrendingItem[] = [];
  const seenIds = new Set<number>();

  for (const item of items) {
    if (matches.length >= limit) break;

    const tmdbId = item.id;
    if (!tmdbId || seenIds.has(tmdbId)) continue;

    let isMovie: boolean;
    let title: string;
    if (kind === 'mixed') {
      isMovie = item.media_type === 'movie' || (!item.media_type && 'title' in item && !!item.title);
      if (!isMovie && item.media_type !== 'tv') continue;
      title = (isMovie
        ? ('title' in item ? item.title : item.name)
        : ('name' in item ? item.name : undefined)) || '';
    } else {
      isMovie = kind === 'movie';
      title = (isMovie ? ('title' in item && item.title) || item.name : item.name) || '';
    }

    const local = isMovie ? movieIndex.get(tmdbId) : seriesIndex.get(tmdbId);
    if (!local) continue;

    matches.push({
      id: local.id, // LightMovie.id = stream_id, LightSeries.id = series_id
      tmdbId,
      title,
      image: tmdb.imageUrl(item.poster_path, 'w342') || getIconUrl(local, lightIndexes.iconPrefixes) || '',
      rating: item.vote_average,
      overview: item.overview || '',
      type: isMovie ? 'movie' : 'series',
    });
    seenIds.add(tmdbId);
  }
  return matches;
}

// ============================================================================
// FONCTIONS DE MATCHING (cache SQLite, puis réseau)
// ============================================================================

/** Listes TMDB affichées par l'accueil */
export type DashboardListKey =
  | 'trending'
  | 'now_playing'
  | 'on_the_air'
  | 'top_rated'
  | 'popular'
  | `genre_${number}`;

function fetchTmdbList(key: DashboardListKey): Promise<{ results?: unknown[] }> {
  switch (key) {
    case 'trending': return tmdb.getTrending('week');
    case 'now_playing': return tmdb.getNowPlaying();
    case 'on_the_air': return tmdb.getOnTheAir();
    case 'top_rated': return tmdb.getTopRated('movie');
    case 'popular': return tmdb.getPopular();
    default: return tmdb.getByGenre(Number(key.slice('genre_'.length)), 'movie');
  }
}

/**
 * Lit une liste TMDB de l'accueil dans le cache SQLite (24 h).
 * Si elle n'y est pas (ou a expiré) : la télécharge et la met en cache quand `allowNetwork` est
 * vrai, sinon renvoie null (recalcul discret après une actualisation, sans réseau).
 */
export async function readTmdbList(
  key: DashboardListKey,
  allowNetwork: boolean
): Promise<TmdbTrendingResult[] | null> {
  const cached = await getCachedList<TmdbTrendingResult>(key);
  if (cached) return cached;
  if (!allowNetwork) return null;
  const lang = getTmdbLanguage();
  const res = await fetchTmdbList(key);
  const items = (res.results || []) as TmdbTrendingResult[];
  // Langue changée pendant le téléchargement : ne pas remettre en cache (24 h) une liste dans
  // l'ancienne langue, juste après que le changement de langue a vidé ce cache.
  if (getTmdbLanguage() === lang) await setCachedList(key, items);
  return items;
}

/** Lit une liste TMDB en cache (24 h), sinon la télécharge et la met en cache. */
async function loadTmdbList(key: DashboardListKey): Promise<TmdbTrendingResult[]> {
  return (await readTmdbList(key, true)) ?? [];
}

/**
 * Récupère les contenus Trending TMDB matchés avec la bibliothèque locale
 * @param lightIndexes - Light indexes avec moviesByTmdb/seriesByTmdb
 * @param limit - Nombre max de résultats
 */
export async function getTmdbTrendingAndMatch(
  lightIndexes: LightIndexes,
  limit: number = 20
): Promise<TrendingItem[]> {
  try {
    const items = await loadTmdbList('trending');
    return matchTmdbList(items, lightIndexes, 'mixed', limit);
  } catch (e) {
    log.error('Failed to load TMDB trending matches', e);
    return [];
  }
}

/**
 * Récupère les films "Now Playing" TMDB matchés avec la bibliothèque locale
 */
export async function getTmdbNowPlayingAndMatch(
  lightIndexes: LightIndexes,
  limit: number = 20
): Promise<TrendingItem[]> {
  try {
    const items = await loadTmdbList('now_playing');
    return matchTmdbList(items, lightIndexes, 'movie', limit);
  } catch (e) {
    log.error('Failed to load TMDB now playing matches', e);
    return [];
  }
}

/**
 * Récupère les films "Popular" TMDB matchés avec la bibliothèque locale
 */
export async function getTmdbPopularAndMatch(
  lightIndexes: LightIndexes,
  limit: number = 20
): Promise<TrendingItem[]> {
  try {
    const items = await loadTmdbList('popular');
    return matchTmdbList(items, lightIndexes, 'movie', limit);
  } catch (e) {
    log.error('Failed to load TMDB popular matches', e);
    return [];
  }
}

/**
 * Récupère les séries "On The Air" TMDB matchées avec la bibliothèque locale
 */
export async function getTmdbOnTheAirAndMatch(
  lightIndexes: LightIndexes,
  limit: number = 20
): Promise<TrendingItem[]> {
  try {
    const items = await loadTmdbList('on_the_air');
    return matchTmdbList(items, lightIndexes, 'series', limit);
  } catch (e) {
    log.error('Failed to load TMDB on the air matches', e);
    return [];
  }
}

/**
 * Récupère les films "Top Rated" TMDB matchés avec la bibliothèque locale
 */
export async function getTmdbTopRatedAndMatch(
  lightIndexes: LightIndexes,
  limit: number = 20
): Promise<TrendingItem[]> {
  try {
    const items = await loadTmdbList('top_rated');
    return matchTmdbList(items, lightIndexes, 'movie', limit);
  } catch (e) {
    log.error('Failed to load TMDB top rated matches', e);
    return [];
  }
}

/**
 * Récupère les films par genre TMDB matchés avec la bibliothèque locale
 */
export async function getTmdbByGenreAndMatch(
  lightIndexes: LightIndexes,
  genreId: number,
  limit: number = 20
): Promise<TrendingItem[]> {
  try {
    const items = await loadTmdbList(`genre_${genreId}`);
    return matchTmdbList(items, lightIndexes, 'movie', limit);
  } catch (e) {
    log.error(`Failed to load TMDB genre ${genreId} matches`, e);
    return [];
  }
}

/**
 * Choisit les films de la bannière (sans logo) : films des tendances présents dans le catalogue
 * et qui ont une image de fond TMDB. Fonction pure, sans réseau ni base.
 *
 * @param trendingItems - Tendances déjà rapprochées du catalogue
 * @param lightIndexes - Catalogue local
 * @param rawTrending - Liste TMDB brute des tendances (pour l'image de fond)
 * @param count - Nombre max de films
 */
export function buildHeroCandidates(
  trendingItems: readonly TrendingItem[],
  lightIndexes: LightIndexes,
  rawTrending: readonly TmdbTrendingResult[] | null,
  count: number = 5
): Array<HeroMovie & { tmdbId: number }> {
  const movieByTmdb = lightIndexes.moviesByTmdb;
  // Map pour une recherche O(1) plutôt qu'un .find() à chaque tour
  const trendingById = new Map(rawTrending?.map((t) => [t.id, t]) || []);
  const heroes: Array<HeroMovie & { tmdbId: number }> = [];

  for (const item of trendingItems) {
    if (heroes.length >= count) break;

    // Seulement des films dans la bannière
    if (item.type !== 'movie') continue;

    const catalogMovie = movieByTmdb.get(item.tmdbId);
    if (!catalogMovie) continue;

    const rawTmdbItem = trendingById.get(item.tmdbId);
    if (!rawTmdbItem?.backdrop_path) continue;

    const title = 'title' in rawTmdbItem ? rawTmdbItem.title : ('name' in rawTmdbItem ? rawTmdbItem.name : item.title);
    const releaseDate = 'release_date' in rawTmdbItem ? rawTmdbItem.release_date : ('first_air_date' in rawTmdbItem ? rawTmdbItem.first_air_date : '');

    heroes.push({
      id: catalogMovie.id, // LightMovie.id = stream_id
      tmdbId: item.tmdbId,
      title: title || item.title,
      overview: rawTmdbItem.overview || item.overview || '',
      backdropUrl: tmdb.imageUrl(rawTmdbItem.backdrop_path, backdropImageSize()) || '',
      rating: rawTmdbItem.vote_average || item.rating,
      year: releaseDate?.split('-')[0],
      duration: undefined,
    });
  }
  return heroes;
}

/**
 * Construit les films Hero à partir de données trending existantes.
 * Ajoute les logos officiels TMDB en parallèle (fiches gardées sur l'appareil).
 *
 * @param trendingItems - Données trending déjà fetchées (TrendingItem[])
 * @param lightIndexes - LightIndexes pour lookup O(1)
 * @param count - Nombre max de heroes à retourner
 */
export async function buildHeroFromTrendingItems(
  trendingItems: TrendingItem[],
  lightIndexes: LightIndexes,
  count: number = 5
): Promise<HeroMovie[]> {
  if (!trendingItems || trendingItems.length === 0 || !lightIndexes) {
    return [];
  }

  // Phase 1: films retenus, sans logo
  // Liste téléchargée mais pas mise en cache (écriture SQLite en échec) : relue par le réseau, sinon
  // aucun film n'a d'image de fond et la bannière reste vide alors que la rangée est remplie.
  const cachedTrending = (await getCachedList<TmdbTrendingResult>('trending'))
    ?? (await readTmdbList('trending', true).catch(() => null));
  if (import.meta.env.VITE_BANC === '1') await tmdb.prepareBancImages();
  const preliminary = buildHeroCandidates(trendingItems, lightIndexes, cachedTrending, count);

  // Phase 2: logos
  return attachHeroLogos(preliminary);
}

/**
 * Fiche d'un film de la bannière : celle déjà gardée sur l'appareil si elle a ses images, sinon
 * demandée puis gardée. Sans ce cache, chaque arrivée sur l'accueil redemandait les 5 fiches.
 */
async function heroMovieDetails(tmdbId: number): Promise<TmdbMovieDetails> {
  const cached = await getCachedDetails<TmdbMovieDetails>(tmdbId, 'movie');
  // Sans logo (sortie récente : TMDB l'ajoute plus tard) : redemandée, pour le trouver dès qu'il existe
  if (cached?.images?.logos?.length) return cached;
  const lang = getTmdbLanguage();
  const data = await tmdb.getMovieDetails(tmdbId);
  // Langue changée pendant la demande : ne pas garder une fiche dans l'ancienne langue
  if (getTmdbLanguage() === lang) await cacheMovieDetails(tmdbId, data, { notify: false });
  return data;
}

/**
 * Ajoute le logo officiel TMDB aux films de la bannière, en parallèle (fiche gardée sur l'appareil,
 * sinon réseau). Un échec laisse le film sans logo : le titre s'affiche à la place.
 */
export async function attachHeroLogos(
  heroes: ReadonlyArray<HeroMovie & { tmdbId: number }>
): Promise<HeroMovie[]> {
  const userLang = getTmdbLanguage() === 'fr-FR' ? 'fr' : 'en';
  const logoResults = await Promise.allSettled(
    heroes.map(({ tmdbId }) => heroMovieDetails(tmdbId))
  );

  return heroes.map((hero, i) => {
    const result = logoResults[i];
    if (result.status === 'fulfilled' && result.value.images) {
      const logoUrl = pickBestLogo(result.value.images, userLang as 'fr' | 'en');
      if (logoUrl) {
        return { ...hero, logoUrl };
      }
    }
    return hero;
  });
}
