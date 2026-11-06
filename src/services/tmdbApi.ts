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
import { createLogger } from '../utils/logger';

const log = createLogger('TMDB');

const TMDB_IMAGE_BASE_URL = 'https://image.tmdb.org/t/p';

// Proxy URL — calls go through Supabase Edge Function (TMDB key is server-side)
const PROXY_BASE_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/tmdb-proxy`;

// ⚠ TESTING ONLY — NOT FOR PRODUCTION ⚠
// A TMDB read token in .env (VITE_TMDB_TOKEN) makes the app call TMDB directly, without the Supabase
// proxy. Vite bundles every VITE_ variable into the app, so the token would be readable by anyone
// holding the build. It is therefore only honoured in development (`import.meta.env.DEV`): a
// release build ignores it and always goes through the proxy, which keeps the real token server-side.
const DIRECT_TMDB_TOKEN = import.meta.env.DEV
  ? (import.meta.env.VITE_TMDB_TOKEN as string | undefined) || undefined
  : undefined;
if (DIRECT_TMDB_TOKEN) {
  log.warn('TESTING ONLY: calling TMDB directly with VITE_TMDB_TOKEN (the Supabase proxy is bypassed)');
}
const DIRECT_TMDB_BASE_URL = 'https://api.themoviedb.org/3';

// Fetch helper routed through Supabase proxy with JWT auth (or straight to TMDB, see above)
const tmdbFetch = async <T>(endpoint: string, params: Record<string, string> = {}): Promise<T> => {
  // Get current Supabase session for JWT
  const session = DIRECT_TMDB_TOKEN ? null : (await supabase.auth.getSession()).data.session;
  if (!DIRECT_TMDB_TOKEN && !session?.access_token) throw new Error('Not authenticated — Supabase session required');

  const url = new URL(`${DIRECT_TMDB_TOKEN ? DIRECT_TMDB_BASE_URL : PROXY_BASE_URL}${endpoint}`);

  // Add default language based on current i18n setting
  params.language = params.language || getTmdbLanguage();

  Object.entries(params).forEach(([key, value]) => {
    if (value) url.searchParams.append(key, value);
  });

  // Execute through rate limiter (client-side safety net)
  return tmdbRateLimiter.execute(async () => {
    const response = await fetch(url.toString(), {
      headers: DIRECT_TMDB_TOKEN
        ? { Authorization: `Bearer ${DIRECT_TMDB_TOKEN}`, 'Content-Type': 'application/json' }
        : {
            Authorization: `Bearer ${session?.access_token}`,
            apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
            'Content-Type': 'application/json',
          },
    });

    if (!response.ok) {
      const error = new Error(
        `TMDB Proxy error: ${response.status} ${response.statusText}`
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
  return `${TMDB_IMAGE_BASE_URL}/${size}${path}`;
};

/**
 * Search for movies
 */
const searchMovie = async (
  query: string,
  year?: string
): Promise<TmdbSearchResponse<TmdbMovieSearchResult>> => {
  const params: Record<string, string> = { query };
  if (year) params.year = year;

  return tmdbFetch<TmdbSearchResponse<TmdbMovieSearchResult>>('/search/movie', params);
};

/**
 * Search for TV shows
 */
const searchTv = async (
  query: string,
  year?: string
): Promise<TmdbSearchResponse<TmdbTvSearchResult>> => {
  const params: Record<string, string> = { query };
  if (year) params.first_air_date_year = year;

  return tmdbFetch<TmdbSearchResponse<TmdbTvSearchResult>>('/search/tv', params);
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
  getMovieDetails,
  getMovieRecommendations,
  getTvDetails,
  getSeasonDetails,
  getSeasonDetailsWithFallback,
  imageUrl: tmdbImageUrl,
  getTrending,
  getNowPlaying,
  getOnTheAir,
  getTopRated,
  getPopular,
  getByGenre,
};

export default tmdb;
