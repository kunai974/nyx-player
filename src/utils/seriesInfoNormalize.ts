/**
 * seriesInfoNormalize.ts — Réponse `get_series_info` d'un fournisseur Xtream mise dans la forme que
 * l'app attend, quelle que soit la façon dont le panneau l'écrit.
 *
 * Écarts vus chez de vrais fournisseurs :
 * - numéro d'épisode (`id`) en nombre au lieu de texte : l'épisode en cours ou le suivant n'était
 *   pas retrouvé (comparaison stricte avec un texte) ;
 * - `episodes` en tableau de saisons, ou une saison en objet à clés numériques au lieu d'un tableau ;
 * - `seasons` en objet au lieu d'un tableau.
 */

import type { XtreamEpisode, XtreamSeason, XtreamSeriesInfo } from '../types/xtream';

function asList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return Object.values(value);
  return [];
}

function normalizeEpisode(raw: unknown): XtreamEpisode | null {
  if (!raw || typeof raw !== 'object') return null;
  const episode = raw as XtreamEpisode;
  if (episode.id === undefined || episode.id === null || String(episode.id) === '') return null;
  const episodeNum = Number(episode.episode_num);
  return {
    ...episode,
    id: String(episode.id),
    episode_num: Number.isFinite(episodeNum) ? episodeNum : 0,
  };
}

function normalizeEpisodes(raw: unknown): Record<string, XtreamEpisode[]> | undefined {
  if (raw === undefined || raw === null) return undefined;
  const episodes: Record<string, XtreamEpisode[]> = {};
  const add = (seasonKey: string, list: unknown) => {
    const eps = asList(list).map(normalizeEpisode).filter((ep): ep is XtreamEpisode => ep !== null);
    if (eps.length > 0) episodes[seasonKey] = (episodes[seasonKey] ?? []).concat(eps);
  };
  if (Array.isArray(raw)) {
    // Tableau de saisons : la saison écrite dans l'épisode, sinon sa place (à partir de 1)
    raw.forEach((season, index) => {
      const first = asList(season)[0] as { season?: unknown; info?: { season?: unknown } } | undefined;
      const rawSeason = first?.season ?? first?.info?.season;
      const written = rawSeason === '' || rawSeason === null ? NaN : Number(rawSeason);
      // Saison 0 (épisodes spéciaux) gardée à part : prise pour sa place, elle se mêlait à la saison 1
      add(String(Number.isInteger(written) && written >= 0 ? written : index + 1), season);
    });
  } else if (typeof raw === 'object') {
    for (const [seasonKey, list] of Object.entries(raw)) add(seasonKey, list);
  }
  return episodes;
}

/** Copie normalisée ; une réponse déjà conforme ressort avec le même contenu */
export function normalizeSeriesInfo(info: XtreamSeriesInfo): XtreamSeriesInfo {
  const normalized: XtreamSeriesInfo = { ...info };
  if (info.episodes !== undefined) normalized.episodes = normalizeEpisodes(info.episodes);
  if (info.seasons !== undefined) normalized.seasons = asList(info.seasons) as XtreamSeason[];
  return normalized;
}
