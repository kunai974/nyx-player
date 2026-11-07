/**
 * Light Index Helpers
 * 
 * Utilitaires pour manipuler les LightIndexes :
 * - getThisWeekMovies / getThisWeekSeries (carrousels "Nouveau cette semaine")
 * - getAllVersionsByTmdb (sélecteur de source multi-version)
 */

import type { 
  LightIndexes, 
  LightMovie, 
  LightSeries, 
} from '../types/lightIndex';
import { isExoticName } from './contentFilters';

// ============================================================================
// INTERNAL ARRAY CONVERTERS
// ============================================================================

function getLightMoviesArray(indexes: LightIndexes): LightMovie[] {
  return Array.from(indexes.movies.values());
}

function getLightSeriesArray(indexes: LightIndexes): LightSeries[] {
  return Array.from(indexes.series.values());
}

// ============================================================================
// TMDB MULTI-VERSION LOOKUP
// ============================================================================

/**
 * Récupère TOUS les items partageant le même TMDB ID
 * Utilisé pour le sélecteur de source (multiples versions d'un même contenu)
 * O(n) - scan linéaire, acceptable pour un appel unique au clic
 * 
 * OPTIMISATION: Retourne les objets légers (déjà en RAM) pour afficher
 * les noms dans le dropdown sans charger les objets complets depuis SQLite.
 * 
 * @param indexes - LightIndexes
 * @param tmdbId - TMDB ID à rechercher
 * @param type - Type de contenu ('movie' | 'series')
 * @returns Array d'objets légers partageant ce TMDB
 */
export function getAllVersionsByTmdb(
  indexes: LightIndexes,
  tmdbId: number,
  type: 'movie'
): LightMovie[];
export function getAllVersionsByTmdb(
  indexes: LightIndexes,
  tmdbId: number,
  type: 'series'
): LightSeries[];
export function getAllVersionsByTmdb(
  indexes: LightIndexes,
  tmdbId: number,
  type: 'movie' | 'series'
): LightMovie[] | LightSeries[] {
  if (!tmdbId || tmdbId === 0) return [];
  
  if (type === 'movie') {
    const results: LightMovie[] = [];
    for (const item of indexes.movies.values()) {
      if (item.tmdbId === tmdbId) {
        results.push(item);
      }
    }
    return results;
  } else {
    const results: LightSeries[] = [];
    for (const item of indexes.series.values()) {
      if (item.tmdbId === tmdbId) {
        results.push(item);
      }
    }
    return results;
  }
}

// ============================================================================
// THIS WEEK HELPERS (pour carrousels Xtream "Nouveau cette semaine")
// ============================================================================

const ONE_WEEK_SECONDS = 7 * 24 * 60 * 60;

/**
 * Récupère les films ajoutés cette semaine (7 derniers jours)
 * Triés par date d'ajout (plus récent en premier)
 * @param indexes - LightIndexes
 * @param limit - Nombre max de résultats
 * @returns Array de LightMovie avec TMDB ID valide
 */
export function getThisWeekMovies(
  indexes: LightIndexes,
  limit: number = 20,
  exoticFilterEnabled: boolean = false
): LightMovie[] {
  const now = Math.floor(Date.now() / 1000);
  const oneWeekAgo = now - ONE_WEEK_SECONDS;
  const seenTmdb = new Set<number>();

  return getLightMoviesArray(indexes)
    .filter(m => {
      // Must have valid added date
      if (!m.added || m.added === 0) return false;
      // Must be added in last 7 days
      if (m.added < oneWeekAgo) return false;
      // Must have TMDB ID
      if (!m.tmdbId || m.tmdbId === 0) return false;
      // Filter exotic scripts if enabled
      if (isExoticName(m.name, exoticFilterEnabled)) return false;
      // Deduplicate by TMDB ID
      if (seenTmdb.has(m.tmdbId)) return false;
      seenTmdb.add(m.tmdbId);
      return true;
    })
    .sort((a, b) => b.added - a.added) // Most recent first
    .slice(0, limit);
}

/**
 * Récupère les séries modifiées cette semaine (7 derniers jours)
 * Triées par date de modification (plus récent en premier)
 * @param indexes - LightIndexes
 * @param limit - Nombre max de résultats
 * @returns Array de LightSeries avec TMDB ID valide
 */
export function getThisWeekSeries(
  indexes: LightIndexes,
  limit: number = 20,
  exoticFilterEnabled: boolean = false
): LightSeries[] {
  const now = Math.floor(Date.now() / 1000);
  const oneWeekAgo = now - ONE_WEEK_SECONDS;
  const seenTmdb = new Set<number>();

  return getLightSeriesArray(indexes)
    .filter(s => {
      // Must have valid added date
      if (!s.added || s.added === 0) return false;
      // Must be added in last 7 days
      if (s.added < oneWeekAgo) return false;
      // Must have TMDB ID
      if (!s.tmdbId || s.tmdbId === 0) return false;
      // Filter exotic scripts if enabled
      if (isExoticName(s.name, exoticFilterEnabled)) return false;
      // Deduplicate by TMDB ID
      if (seenTmdb.has(s.tmdbId)) return false;
      seenTmdb.add(s.tmdbId);
      return true;
    })
    .sort((a, b) => b.added - a.added) // Most recent first
    .slice(0, limit);
}

/**
 * Nombre de titres différents à montrer à la place du total : les fiches TMDB différentes (plusieurs versions
 * d'un film, FR, VOSTFR, 4K, n'en font qu'une), plus les titres sans fiche, comptés chacun. Seulement si la
 * plupart des titres ont un numéro TMDB ; sinon (fournisseur sans numéro, titres reliés au compte-gouttes par
 * leur nom) : 0, et l'affichage prend le total.
 */
export function uniqueTitleCount(uniqueTmdb: number, withTmdb: number, total: number): number {
    return total > 0 && withTmdb * 2 >= total ? uniqueTmdb + Math.max(0, total - withTmdb) : 0;
}

/**
 * Entrées qui avaient un lien trouvé par le titre mais dont le nom a changé depuis (le fournisseur a
 * réutilisé le numéro pour un autre titre, ou renommé le sien) : le lien n'est pas reposé, et rien ne dit
 * que l'entrée est encore le titre d'une reprise ou d'une ligne de Ma liste notée avec ce numéro TMDB.
 */
const staleLinkEntries = new WeakSet<object>();

/** Marque une entrée dont le lien par le titre ne peut plus être reposé (nom changé) */
export function markStaleTitleLink(entry: object): void {
    staleLinkEntries.add(entry);
}

/** L'entrée avait un lien par le titre que son nom actuel ne permet plus de reposer */
export function isStaleTitleLink(entry: object | undefined): boolean {
    return !!entry && staleLinkEntries.has(entry);
}
