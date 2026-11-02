/**
 * episodeNavigation.ts — Logique unifiée de navigation épisodes
 *
 * Fusionne l'ancienne findAdjacentEpisode (PlayerContext) et
 * findNextEpisodeInSeries (App.tsx) en une implémentation unique,
 * canonique, qui gère next ET prev avec tri par episode_num.
 */

import type { XtreamEpisode } from '../types/xtream';

/** Résultat de la recherche d'épisode adjacent */
interface AdjacentEpisodeResult {
  episode: XtreamEpisode;
  seasonNumber: number;
}

/**
 * Trouve le numéro de saison d'un épisode donné.
 * Utilisé pour résoudre la saison avant d'appeler findAdjacentEpisode.
 *
 * @param episodes - Map saison→épisodes
 * @param episodeId - ID de l'épisode à chercher
 * @returns Le numéro de saison, ou null si non trouvé
 */
export function findEpisodeSeason(
  episodes: Record<number, XtreamEpisode[]>,
  episodeId: string
): number | null {
  for (const [seasonNum, eps] of Object.entries(episodes)) {
    // Numéro en nombre ou en texte selon le fournisseur
    if (eps.some(ep => String(ep.id) === String(episodeId))) {
      return Number(seasonNum);
    }
  }
  return null;
}

/**
 * Trouve l'épisode adjacent (suivant ou précédent) dans une série.
 * Gère les transitions de saison automatiquement.
 *
 * @param episodes - Map saison→épisodes de la série
 * @param currentSeason - Numéro de saison courant
 * @param currentEpisodeNum - Numéro d'épisode courant
 * @param direction - 'next' ou 'prev'
 * @returns L'épisode trouvé + sa saison, ou null si aucun
 */
export function findAdjacentEpisode(
  episodes: Record<number, XtreamEpisode[]>,
  currentSeason: number,
  currentEpisodeNum: number,
  direction: 'next' | 'prev'
): AdjacentEpisodeResult | null {
  if (!episodes) return null;

  const seasonNums = Object.keys(episodes)
    .map(Number)
    .sort((a, b) => a - b);

  const currentSeasonEps = episodes[currentSeason] || [];

  // Toujours trier par episode_num pour un ordre fiable
  const sortedEps = [...currentSeasonEps].sort((a, b) => a.episode_num - b.episode_num);

  // Trouver l'index de l'épisode courant
  const currentIdx = sortedEps.findIndex(ep => ep.episode_num === currentEpisodeNum);
  if (currentIdx === -1) return null;

  if (direction === 'next') {
    // Épisode suivant dans la même saison
    if (currentIdx < sortedEps.length - 1) {
      return {
        episode: sortedEps[currentIdx + 1],
        seasonNumber: currentSeason,
      };
    }

    // Premier épisode de la saison suivante
    const currentSeasonIdx = seasonNums.indexOf(currentSeason);
    if (currentSeasonIdx >= 0 && currentSeasonIdx < seasonNums.length - 1) {
      const nextSeasonNum = seasonNums[currentSeasonIdx + 1];
      const nextSeasonEps = episodes[nextSeasonNum] || [];
      if (nextSeasonEps.length > 0) {
        const sorted = [...nextSeasonEps].sort((a, b) => a.episode_num - b.episode_num);
        return {
          episode: sorted[0],
          seasonNumber: nextSeasonNum,
        };
      }
    }
  } else {
    // Épisode précédent dans la même saison
    if (currentIdx > 0) {
      return {
        episode: sortedEps[currentIdx - 1],
        seasonNumber: currentSeason,
      };
    }

    // Dernier épisode de la saison précédente
    const currentSeasonIdx = seasonNums.indexOf(currentSeason);
    if (currentSeasonIdx > 0) {
      const prevSeasonNum = seasonNums[currentSeasonIdx - 1];
      const prevSeasonEps = episodes[prevSeasonNum] || [];
      if (prevSeasonEps.length > 0) {
        const sorted = [...prevSeasonEps].sort((a, b) => a.episode_num - b.episode_num);
        return {
          episode: sorted[sorted.length - 1],
          seasonNumber: prevSeasonNum,
        };
      }
    }
  }

  return null;
}
