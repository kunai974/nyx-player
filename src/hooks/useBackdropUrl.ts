import { useMemo } from 'react';
import tmdb from '../services/tmdbApi';
import { backdropImageSize } from '../utils/tmdbImageSize';

/**
 * Interface minimale compatible avec TmdbTvDetails et TmdbMovieDetails.
 * Utilise `Pick`-like pattern pour ne dépendre que des champs nécessaires.
 */
interface TmdbBackdropSource {
  images?: {
    backdrops?: Array<{ file_path: string; iso_639_1?: string | null }>;
  };
  backdrop_path?: string | null;
}

/**
 * Hook partagé pour résoudre l'URL du backdrop.
 * Utilisé par SeriesDetailPage et MovieDetailPage.
 *
 * Priorité :
 * 1. TMDB images.backdrops (filtrés sans texte, max 5)
 * 2. Xtream backdrop_path[] (fallbackBackdrops)
 * 3. TMDB backdrop_path simple
 * 4. Fallback final (cover / stream_icon)
 */
export function useBackdropUrl(
  details: TmdbBackdropSource | null,
  fallbackBackdrops: string[] | undefined,
  fallbackCover: string,
  backdropIndex: number,
): string {
  return useMemo(() => {
    // Priority 1: TMDB images.backdrops (no language overlay, max 5)
    const allTmdbBackdrops = details?.images?.backdrops || [];
    const tmdbBackdrops = allTmdbBackdrops
      .filter((img) => img.iso_639_1 === null)
      .slice(0, 5);

    if (tmdbBackdrops.length > 0) {
      const index = backdropIndex % tmdbBackdrops.length;
      return tmdb.imageUrl(tmdbBackdrops[index].file_path, backdropImageSize()) || '';
    }

    // Priority 2: Xtream backdrop_path array (des fournisseurs y mettent des chaînes vides : écartées,
    // sinon la fiche n'avait aucune image de fond au lieu de l'affiche)
    const xtreamBackdrops = Array.isArray(fallbackBackdrops)
      ? fallbackBackdrops.filter((url) => typeof url === 'string' && url.trim() !== '')
      : [];
    if (xtreamBackdrops.length > 0) {
      const index = backdropIndex % xtreamBackdrops.length;
      return xtreamBackdrops[index];
    }

    // Priority 3: TMDB single backdrop
    if (details?.backdrop_path) {
      return tmdb.imageUrl(details.backdrop_path, backdropImageSize()) || '';
    }

    // Priority 4: Fallback cover/poster
    return fallbackCover;
  }, [details, fallbackBackdrops, fallbackCover, backdropIndex]);
}
