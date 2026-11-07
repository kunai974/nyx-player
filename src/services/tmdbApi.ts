import type {
  TmdbSearchResponse,
  TmdbMovieSearchResult,
  TmdbTvSearchResult,
  TmdbMovieDetails,
  TmdbTvDetails,
  TmdbSeasonDetails,
} from '../types/tmdb';
import { tmdbRateLimiter } from './rateLimiter';
import { getTmdbLanguage } from '../utils/tmdbLanguage';
import { supabase } from './supabaseClient';
import { getCachedDetails, cacheSeasonDetails } from './tmdbCacheSqlite';
import { getPersonalTmdbKey, directTmdbRequest, type PersonalTmdbKey } from './tmdbPersonalKey';
import { isGuestRelayAvailable, isGuestRelayStopped, noteGuestRelayResponse, takeGuestRelayToken } from './guestRelay';
import { createLogger } from '../utils/logger';
import { prises } from './outilsTest';

const log = createLogger('TMDB');

const TMDB_IMAGE_BASE_URL = 'https://image.tmdb.org/t/p';

// Proxy URL — calls go through Supabase Edge Function (TMDB key is server-side)
const PROXY_BASE_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/tmdb-proxy`;

/**
 * Fiches TMDB impossibles à demander : ni compte connecté, ni clé TMDB personnelle, ni relais de
 * l'invité disponible (en pause ou limite du jour atteinte). L'app montre alors les images et
 * résumés du fournisseur.
 */
export class TmdbUnavailableError extends Error {
  constructor() {
    super('TMDB unavailable: no account and no personal TMDB key');
    this.name = 'TmdbUnavailableError';
  }
}

/**
 * Accès à TMDB, dans cet ordre : le relais de Nyx avec le jeton du compte ; sinon TMDB directement
 * avec la clé personnelle (rien sur nos serveurs) ; sinon, pour un invité, le relais de Nyx avec son
 * jeton d'invité, dans ses limites.
 */
type TmdbAccess =
  | { kind: 'proxy'; accessToken: string; guest: boolean }
  | { kind: 'direct'; key: PersonalTmdbKey };

type AccessKind = 'proxy' | 'direct' | 'guest';

/** Le chemin qui servirait, sans rien envoyer ni compter (pas de connexion d'invité) */
async function peekTmdbAccess(): Promise<AccessKind | null> {
  const { data: { session } } = await supabase.auth.getSession();
  if (session?.access_token) return 'proxy';
  if (await getPersonalTmdbKey()) return 'direct';
  return isGuestRelayAvailable() ? 'guest' : null;
}

/** Le chemin d'UNE demande : pour un invité, le jeton est pris (et la demande comptée) ici */
async function resolveTmdbAccess(): Promise<TmdbAccess | null> {
  const { data: { session } } = await supabase.auth.getSession();
  if (session?.access_token) return { kind: 'proxy', accessToken: session.access_token, guest: false };
  const key = await getPersonalTmdbKey();
  if (key) return { kind: 'direct', key };
  const guestToken = await takeGuestRelayToken();
  return guestToken ? { kind: 'proxy', accessToken: guestToken, guest: true } : null;
}

/**
 * Chemin des demandes à TMDB : `proxy` (relais de Nyx, compté dans son quota, compte ou invité),
 * `direct` (clé personnelle, sans nos serveurs), ou null si aucune demande n'est possible.
 */
export async function getTmdbAccessKind(): Promise<'proxy' | 'direct' | null> {
  const kind = await peekTmdbAccess();
  return kind === 'guest' ? 'proxy' : kind;
}

/** Vrai si le relais servirait un compte connecté (pas un invité, au quota bien plus petit) */
export async function isTmdbAccountRelay(): Promise<boolean> {
  return (await peekTmdbAccess()) === 'proxy';
}

/** Vrai si l'app peut demander des fiches à TMDB (compte connecté, clé personnelle ou relais de l'invité) */
export async function isTmdbAvailable(): Promise<boolean> {
  return (await peekTmdbAccess()) !== null;
}

/** Version du banc : adresse du faux relais en cours, pour servir ses fonds fictifs (voir tmdbImageUrl). */
let bancRelaisImages: string | null = null;

/**
 * Adresse du relais. Les versions du banc de tests (VITE_BANC=1, que le garde-fou de publication
 * refuse hors des scripts d'audit) demandent au faux relais du faux fournisseur qui leur sert de
 * source, jamais au relais de production (le banc y faisait des milliers d'appels par jour) ; sans
 * faux fournisseur, aucune demande. Dans une version normale, la branche disparaît à la compilation.
 */
async function proxyBaseUrl(): Promise<string> {
  if (import.meta.env.VITE_BANC === '1') {
    const { StorageService } = await import('./storage');
    const faux = prises.relaisTmdbBanc?.(await StorageService.getCredentials().catch(() => null));
    if (!faux) throw new TmdbUnavailableError();
    bancRelaisImages = faux;
    return faux;
  }
  return PROXY_BASE_URL;
}

/**
 * Version du banc : connaît le faux relais avant de fabriquer des adresses d'images, y compris quand les
 * listes viennent du cache (aucune demande à TMDB avant). Sans effet dans une version normale.
 */
async function prepareBancImages(): Promise<void> {
  if (import.meta.env.VITE_BANC === '1') await proxyBaseUrl().catch(() => undefined);
}

function proxyRequest(
  base: string,
  endpoint: string,
  params: Record<string, string>,
  accessToken: string,
  repeated: Record<string, readonly string[]> = {},
): { url: string; headers: Record<string, string> } {
  const url = new URL(`${base}${endpoint}`);
  Object.entries(params).forEach(([key, value]) => {
    if (value) url.searchParams.append(key, value);
  });
  Object.entries(repeated).forEach(([key, values]) => {
    values.forEach((value) => url.searchParams.append(key, value));
  });
  return {
    url: url.toString(),
    headers: {
      Authorization: `Bearer ${accessToken}`,
      apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
      'Content-Type': 'application/json',
    },
  };
}

/** Accès par la clé personnelle seulement (jamais le relais de Nyx), sinon null */
async function resolveDirectAccess(): Promise<TmdbAccess | null> {
  const key = await getPersonalTmdbKey();
  return key ? { kind: 'direct', key } : null;
}

// Fetch helper: Supabase proxy with the account JWT, or TMDB directly with the personal key
/** `directOnly` : jamais par le relais de Nyx (recherches en nombre, hors de son quota commun) */
/** `relayOnly` : paramètres répétés que seul le relais comprend (recherche groupée) ; sans relais, rien ne part */
const tmdbFetch = async <T>(
  endpoint: string,
  params: Record<string, string> = {},
  directOnly = false,
  relayOnly?: Record<string, readonly string[]>,
): Promise<T> => {
  const access = directOnly ? await resolveDirectAccess() : await resolveTmdbAccess();
  if (!access || (relayOnly && access.kind !== 'proxy')) throw new TmdbUnavailableError();

  // Add default language based on current i18n setting
  params.language = params.language || getTmdbLanguage();

  const { url, headers } = access.kind === 'proxy'
    ? proxyRequest(await proxyBaseUrl(), endpoint, params, access.accessToken, relayOnly)
    : directTmdbRequest(endpoint, params, access.key);

  // Execute through rate limiter (client-side safety net)
  return tmdbRateLimiter.execute(async () => {
    // Invité : une demande en file ne part plus après un refus du relais ou hors de l'espace invité
    if (access.kind === 'proxy' && access.guest && isGuestRelayStopped()) throw new TmdbUnavailableError();
    const response = await fetch(url, { headers });

    // Refus du relais pour un invité : la pause demandée est retenue, l'écran passe au fournisseur
    if (access.kind === 'proxy' && access.guest && !response.ok
        && (response.status === 401 || response.status === 429 || response.status === 503)) {
      const body: unknown = await response.json().catch(() => null);
      await noteGuestRelayResponse(response.status, body, access.accessToken, response.headers?.get('Retry-After'));
      throw new TmdbUnavailableError();
    }

    if (!response.ok) {
      const error = new Error(
        `TMDB error (${access.kind}): ${response.status} ${response.statusText}`
      ) as Error & { status: number };
      error.status = response.status;
      throw error;
    }

    return response.json();
  });
};

/**
 * Image URL builder
 */
const tmdbImageUrl = (
  path: string | null,
  size: 'w92' | 'w154' | 'w185' | 'w342' | 'w500' | 'w780' | 'w1280' | 'original' = 'w500'
): string | null => {
  if (!path) return null;
  // Version du banc : le fond fictif du faux relais est une vraie image locale (sinon la bannière attend
  // jusqu'à 12 s une image qui n'existe pas chez TMDB). Les affiches gardent l'adresse TMDB : le cloud
  // ne garde une affiche que si elle en est une.
  if (import.meta.env.VITE_BANC === '1' && bancRelaisImages && path.startsWith('/banc-fond-')) return `${bancRelaisImages}/img/fond.png`;
  return `${TMDB_IMAGE_BASE_URL}/${size}${path}`;
};

/**
 * Search for movies
 */
const searchMovie = async (
  query: string,
  year?: string,
  options?: { directOnly?: boolean },
): Promise<TmdbSearchResponse<TmdbMovieSearchResult>> => {
  const params: Record<string, string> = { query };
  if (year) params.year = year;

  return tmdbFetch<TmdbSearchResponse<TmdbMovieSearchResult>>('/search/movie', params, options?.directOnly);
};

/**
 * Search for TV shows
 */
const searchTv = async (
  query: string,
  year?: string,
  options?: { directOnly?: boolean },
): Promise<TmdbSearchResponse<TmdbTvSearchResult>> => {
  const params: Record<string, string> = { query };
  if (year) params.first_air_date_year = year;

  return tmdbFetch<TmdbSearchResponse<TmdbTvSearchResult>>('/search/tv', params, options?.directOnly);
};

/** Titres au plus par recherche groupée (même plafond que le relais) */
export const TITLE_BATCH_MAX = 20;
/** Longueur au plus des titres d'un appel, une fois dans l'adresse (les passerelles refusent les adresses trop longues) */
export const TITLE_BATCH_MAX_URL_CHARS = 6000;

/** Titres découpés en appels : `TITLE_BATCH_MAX` au plus, et une adresse de taille raisonnable */
export function titleBatchChunks<T extends { query: string }>(items: readonly T[]): T[][] {
  const chunks: T[][] = [];
  let current: T[] = [];
  let chars = 0;
  for (const item of items) {
    const size = encodeURIComponent(item.query).length + 16;
    if (current.length > 0 && (current.length >= TITLE_BATCH_MAX || chars + size > TITLE_BATCH_MAX_URL_CHARS)) {
      chunks.push(current);
      current = [];
      chars = 0;
    }
    current.push(item);
    chars += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** Un titre d'une recherche groupée, et sa réponse : `ok` avec les premiers résultats, sinon pas cherché */
export interface TitleBatchItem { kind: 'movie' | 'tv'; query: string; year?: number }
export interface TitleBatchAnswer {
  kind: 'movie' | 'tv';
  query: string;
  status: 'ok' | 'limited' | 'error';
  results?: Array<Partial<TmdbMovieSearchResult & TmdbTvSearchResult> & { id: number }>;
}

/**
 * Recherche groupée par le relais : jusqu'à `TITLE_BATCH_MAX` titres en un appel (le relais cherche chacun,
 * cache partagé d'abord). Relais seulement : avec la clé personnelle ou sans accès, TmdbUnavailableError.
 */
const searchTitlesBatch = async (items: readonly TitleBatchItem[]): Promise<TitleBatchAnswer[]> => {
  if (items.length === 0 || items.length > TITLE_BATCH_MAX) throw new Error('[TMDB] title batch size out of range');
  const t = items.map((item) => `${item.kind}:${item.year ?? ''}:${item.query}`);
  const answer = await tmdbFetch<{ results?: unknown }>('/search/batch', {}, false, { t });
  return Array.isArray(answer.results) ? answer.results as TitleBatchAnswer[] : [];
};

/**
 * Get movie details with credits, videos, recommendations AND images
 */
const getMovieDetails = async (tmdbId: number): Promise<TmdbMovieDetails> => {
  const result = await tmdbFetch<TmdbMovieDetails>(`/movie/${tmdbId}`, {
    append_to_response: 'credits,videos,recommendations,images',
    include_image_language: 'fr,en,null',
  });
  return result;
};

/**
 * Get movie recommendations from TMDB
 * Returns up to 20 recommended movies based on the given movie
 */
const getMovieRecommendations = async (tmdbId: number): Promise<TmdbMovieSearchResult[]> => {
  const response = await tmdbFetch<TmdbSearchResponse<TmdbMovieSearchResult>>(
    `/movie/${tmdbId}/recommendations`
  );
  return response.results || [];
};

/**
 * Get TV show details with credits, videos AND images
 */
const getTvDetails = async (tmdbId: number): Promise<TmdbTvDetails> => {
  return tmdbFetch<TmdbTvDetails>(`/tv/${tmdbId}`, {
    append_to_response: 'credits,videos,images',
    include_image_language: 'fr,en,null',
  });
};

/**
 * Get TV season details (includes episodes)
 */
const getSeasonDetails = async (
  tmdbId: number,
  seasonNumber: number,
  language?: string
): Promise<TmdbSeasonDetails> => {
  const params: Record<string, string> = {};
  if (language) params.language = language;
  return tmdbFetch<TmdbSeasonDetails>(`/tv/${tmdbId}/season/${seasonNumber}`, params);
};

/**
 * Get Trending content (Movies + TV)
 */
const getTrending = async (
  timeWindow: 'day' | 'week' = 'week'
): Promise<TmdbSearchResponse<TmdbMovieSearchResult | TmdbTvSearchResult>> => {
  return tmdbFetch<TmdbSearchResponse<TmdbMovieSearchResult | TmdbTvSearchResult>>(
    `/trending/all/${timeWindow}`
  );
};

/**
 * Get Now Playing Movies (currently in theaters / recently released)
 */
const getNowPlaying = async (): Promise<TmdbSearchResponse<TmdbMovieSearchResult>> => {
  return tmdbFetch<TmdbSearchResponse<TmdbMovieSearchResult>>('/movie/now_playing');
};

/**
 * Get On The Air TV Shows (currently airing)
 */
const getOnTheAir = async (): Promise<TmdbSearchResponse<TmdbTvSearchResult>> => {
  return tmdbFetch<TmdbSearchResponse<TmdbTvSearchResult>>('/tv/on_the_air');
};

/**
 * Get Top Rated content
 */
const getTopRated = async (
  type: 'movie' | 'tv' = 'movie'
): Promise<TmdbSearchResponse<TmdbMovieSearchResult | TmdbTvSearchResult>> => {
  return tmdbFetch<TmdbSearchResponse<TmdbMovieSearchResult | TmdbTvSearchResult>>(
    `/${type}/top_rated`
  );
};

/**
 * Get Popular Movies (lifetime popularity score)
 * Different from trending: these are movies with sustained long-term popularity
 */
const getPopular = async (): Promise<TmdbSearchResponse<TmdbMovieSearchResult>> => {
  return tmdbFetch<TmdbSearchResponse<TmdbMovieSearchResult>>('/movie/popular');
};

/**
 * Get Movies by Genre using Discover endpoint
 */
const getByGenre = async (
  genreId: number,
  type: 'movie' | 'tv' = 'movie'
): Promise<TmdbSearchResponse<TmdbMovieSearchResult | TmdbTvSearchResult>> => {
  return tmdbFetch<TmdbSearchResponse<TmdbMovieSearchResult | TmdbTvSearchResult>>(
    `/discover/${type}`,
    {
      with_genres: String(genreId),
      sort_by: 'popularity.desc',
    }
  );
};

/**
 * Get TV season details with English fallback for empty overviews
 * 
 * Behavior depends on current language:
 * - If EN: fetch EN directly (no fallback needed, data is complete)
 * - If FR: fetch FR first, then EN for episodes missing synopsis
 * 
 * Uses SQLite cache to avoid repeated API calls (Phase C3)
 */
const getSeasonDetailsWithFallback = async (
  tmdbId: number,
  seasonNumber: number
): Promise<TmdbSeasonDetails> => {
  // Check SQLite cache first
  const cached = await getCachedDetails<TmdbSeasonDetails>(tmdbId, 'season', seasonNumber);
  if (cached) {
    return cached;
  }

  // Get current language from i18n
  const currentLang = getTmdbLanguage();

  // If EN, fetch directly without fallback (EN data is complete)
  if (currentLang === 'en-US') {
    const enData = await getSeasonDetails(tmdbId, seasonNumber, 'en-US');
    await cacheSeasonDetails(tmdbId, seasonNumber, enData);
    return enData;
  }

  // FR: try FR first, fallback to EN if FR fails (404 or other error)
  let frData: TmdbSeasonDetails | null = null;
  try {
    frData = await getSeasonDetails(tmdbId, seasonNumber, 'fr-FR');
  } catch (frError) {
    log.warn(`FR season ${seasonNumber} failed, trying EN fallback:`, frError);
    // FR failed - try EN as complete fallback
    try {
      const enData = await getSeasonDetails(tmdbId, seasonNumber, 'en-US');
      await cacheSeasonDetails(tmdbId, seasonNumber, enData);
      return enData;
    } catch (enError) {
      log.error(`Both FR and EN failed for season ${seasonNumber}:`, enError);
      throw enError; // Re-throw if both fail
    }
  }

  // FR succeeded - check if any episodes are missing overview
  const episodesMissingOverview =
    frData.episodes?.filter((ep) => !ep.overview || ep.overview.trim() === '') || [];

  if (episodesMissingOverview.length === 0) {
    // All episodes have FR synopsis, cache and return
    await cacheSeasonDetails(tmdbId, seasonNumber, frData);
    return frData;
  }

  // Fetch EN data for missing overviews only
  try {
    const enData = await getSeasonDetails(tmdbId, seasonNumber, 'en-US');

    // Merge: use FR data but fill in missing overviews from EN
    if (frData.episodes && enData.episodes) {
      const enEpisodesMap = new Map(enData.episodes.map((ep) => [ep.episode_number, ep]));

      frData.episodes = frData.episodes.map((ep) => {
        if (!ep.overview || ep.overview.trim() === '') {
          const enEp = enEpisodesMap.get(ep.episode_number);
          if (enEp?.overview) {
            return { ...ep, overview: enEp.overview };
          }
        }
        return ep;
      });
    }
  } catch (error) {
    log.warn('Failed to fetch EN fallback for missing overviews:', error);
  }

  // Cache the merged result
  await cacheSeasonDetails(tmdbId, seasonNumber, frData);
  return frData;
};


/**
 * Full TMDB service object
 */
const tmdb = {
  searchMovie,
  searchTv,
  searchTitlesBatch,
  getMovieDetails,
  getMovieRecommendations,
  getTvDetails,
  getSeasonDetails,
  getSeasonDetailsWithFallback,
  imageUrl: tmdbImageUrl,
  prepareBancImages,
  getTrending,
  getNowPlaying,
  getOnTheAir,
  getTopRated,
  getPopular,
  getByGenre,
};

export default tmdb;
