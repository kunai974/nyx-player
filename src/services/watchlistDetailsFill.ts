/**
 * watchlistDetailsFill.ts — Nom et affiche TMDB des titres de Ma liste qui n'en ont pas.
 *
 * Ma liste prend le nom et l'affiche d'un titre dans le cache TMDB local (`tmdb_details_cache`),
 * rempli quand on ouvre sa fiche, sinon chez le fournisseur. Sur un nouvel appareil, un titre
 * « introuvable » chez le fournisseur actuel n'a ni l'un ni l'autre : sa fiche ne s'ouvre pas
 * (fenêtre Rechercher / Retirer), le cache n'est jamais rempli et la carte restait « Titre inconnu »,
 * sans affiche, alors que son numéro TMDB est connu (il revient du cloud).
 *
 * Ce module demande sa fiche à TMDB (relais tmdb-proxy) et la range dans le cache local ; le cache
 * prévient les écrans (`onDetailsUpdate`), qui relisent Ma liste. Rien n'est écrit dans le cloud.
 * Une demande à la fois ; un échec (hors ligne, TMDB injoignable) est retenté au plus tôt après
 * RETRY_AFTER_MS, pour ne pas relancer TMDB à chaque relecture de Ma liste.
 */

import tmdb from './tmdbApi';
import { guestRelayAllowsBackground } from './guestRelay';
import { cacheMovieDetails, cacheSeriesDetails } from './tmdbCacheSqlite';
import { getDatabaseFileName } from './dbCore';
import { createLogger } from '../utils/logger';

const log = createLogger('watchlist');

export interface MissingDetailsRef {
  tmdb_id: number;
  type: 'movie' | 'series';
}

/** Délai avant de redemander une fiche dont la demande a échoué */
export const RETRY_AFTER_MS = 10 * 60 * 1000;

/**
 * Dernière demande de chaque fiche (clé base du compte:type:numéro TMDB → heure) : chaque compte a sa
 * base, donc son cache ; une fiche demandée pour un compte l'est encore pour le suivant
 */
const attempts = new Map<string, number>();
/** Fiches à demander, dans l'ordre */
const queue: MissingDetailsRef[] = [];
let draining = false;

const refKey = (ref: MissingDetailsRef): string => `${ref.type}:${ref.tmdb_id}`;

async function fetchAndCache(ref: MissingDetailsRef): Promise<void> {
  if (ref.type === 'movie') await cacheMovieDetails(ref.tmdb_id, await tmdb.getMovieDetails(ref.tmdb_id));
  else await cacheSeriesDetails(ref.tmdb_id, await tmdb.getTvDetails(ref.tmdb_id));
}

async function drain(): Promise<void> {
  draining = true;
  try {
    for (let ref = queue.shift(); ref; ref = queue.shift()) {
      // Invité : le relais garde ses dernières demandes du jour pour les fiches ouvertes à l'écran
      if (!guestRelayAllowsBackground()) {
        queue.length = 0;
        break;
      }
      try {
        await fetchAndCache(ref);
      } catch (err) {
        log.warn(`Fiche TMDB ${refKey(ref)} indisponible pour Ma liste :`, err);
      }
    }
  } finally {
    draining = false;
  }
}

/**
 * Demande à TMDB la fiche des titres donnés (sans attendre la réponse). Un titre déjà demandé
 * récemment ou sans numéro TMDB est ignoré.
 */
export function requestMissingWatchlistDetails(refs: readonly MissingDetailsRef[], now = Date.now()): void {
  for (const ref of refs) {
    if (ref.tmdb_id <= 0) continue;
    const key = `${getDatabaseFileName() ?? ''}:${refKey(ref)}`;
    const last = attempts.get(key);
    if (last !== undefined && now - last < RETRY_AFTER_MS) continue;
    attempts.set(key, now);
    queue.push({ tmdb_id: ref.tmdb_id, type: ref.type });
  }
  if (!draining && queue.length > 0) void drain();
}

/** Tests : oublie les demandes faites */
export function resetMissingWatchlistDetails(): void {
  attempts.clear();
  queue.length = 0;
}
