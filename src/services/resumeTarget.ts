/**
 * resumeTarget.ts — Ce que lance une carte « Reprendre ».
 *
 * Une reprise est rangée par numéro du fournisseur. Si le fournisseur a donné ce numéro à un autre
 * titre, le lancer ferait jouer ce titre à l'ancienne position. On compare donc le numéro TMDB
 * enregistré avec celui du catalogue actuel, comme pour Ma liste :
 * - même titre (ou rien à comparer) : lecture comme avant ;
 * - le titre est ailleurs dans le catalogue : lecture sous son nouveau numéro (re-liaison) ;
 * - le numéro désigne un autre titre et le titre n'est plus au catalogue : « Introuvable ».
 *
 * Une reprise de film n'est jamais effacée par une lecture du catalogue : un film dont le
 * numéro a disparu du catalogue, sans autre trace du titre, est lui aussi « Introuvable ». Avec un
 * catalogue de films vide (liste pas encore reçue), rien ne permet d'en juger : lecture comme avant.
 */

import type { LightIndexes } from '../types/lightIndex';
import type { PlaybackProgressItem } from './smartContinue';
import { isStaleTitleLink } from '../utils/lightIndexHelpers';

export type ResumeTarget =
  /** Le numéro enregistré mène toujours à ce titre (ou rien ne permet d'en douter) */
  | { kind: 'as-saved' }
  /** Le titre est au catalogue sous un autre numéro (film, ou série pour un épisode) */
  | { kind: 'relinked'; id: number }
  /** Le titre n'est plus au catalogue (son numéro a disparu ou désigne un autre titre) */
  | { kind: 'unavailable' };

const AS_SAVED: ResumeTarget = { kind: 'as-saved' };

/**
 * Même titre TMDB ? Une entrée du catalogue sans numéro TMDB est acceptée (rien à comparer), sauf si elle
 * avait un lien trouvé par le titre et que son nom a changé : le fournisseur a pu réutiliser ce numéro pour un autre titre.
 */
const sameTitle = (current: { tmdbId: number }, tmdbId: number) =>
  current.tmdbId > 0 ? current.tmdbId === tmdbId : !isStaleTitleLink(current);

export function resolveResumeTarget(
  item: Pick<PlaybackProgressItem, 'id' | 'type' | 'tmdbId' | 'seriesId'>,
  indexes: LightIndexes | undefined,
): ResumeTarget {
  const tmdbId = item.tmdbId ?? 0;
  if (!indexes) return AS_SAVED;

  // Film : la reprise est au numéro du film. Épisode : on vérifie la série (son numéro TMDB est
  // celui enregistré avec l'épisode).
  const isMovie = item.type === 'movie';
  const sourceId = isMovie ? Number(item.id) : item.seriesId;
  if (!sourceId) return AS_SAVED;

  const current = isMovie ? indexes.movies.get(sourceId) : indexes.series.get(sourceId);
  // Film disparu du catalogue (reprise gardée au lieu d'être effacée) : « Introuvable », sauf si le
  // titre est ailleurs. Catalogue de films vide : rien ne permet d'en juger.
  const movieGone = isMovie && !current && indexes.movies.size > 0;
  if (tmdbId <= 0) return movieGone ? { kind: 'unavailable' } : AS_SAVED;
  if (current && sameTitle(current, tmdbId)) return AS_SAVED;

  const elsewhere = isMovie ? indexes.moviesByTmdb.get(tmdbId) : indexes.seriesByTmdb.get(tmdbId);
  if (elsewhere && elsewhere.id !== sourceId) return { kind: 'relinked', id: elsewhere.id };

  return current || movieGone ? { kind: 'unavailable' } : AS_SAVED;
}
