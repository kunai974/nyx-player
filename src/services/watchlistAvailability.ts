/**
 * watchlistAvailability.ts — Titres de Ma liste introuvables chez le fournisseur actuel
 * (on les garde, grisés « Introuvable »).
 *
 * Une ligne de Ma liste garde le numéro de source du fournisseur chez qui elle a été ajoutée. Après
 * un changement de fournisseur, la re-liaison (watchlistRelinking.ts) la déplace au nouveau numéro
 * quand le catalogue a le même titre TMDB ; sinon elle garde l'ancien numéro, qui chez le nouveau
 * fournisseur n'existe pas ou désigne un autre titre. Ce module dit si une ligne mène vraiment à son
 * titre, pour que l'écran la marque « introuvable » au lieu d'ouvrir le mauvais film.
 *
 * « Origine » d'une ligne : l'empreinte du fournisseur chez qui son numéro a été pris, notée quand
 * elle est connue (titre reçu du cloud, lignes présentes lors d'un changement de fournisseur sur cet
 * appareil). Une ligne dont l'origine n'est pas le fournisseur actuel est « étrangère » : son numéro
 * ne vaut rien ici. Seul moyen de juger une ligne sans numéro TMDB. Gardé dans `meta` de la base du
 * compte, sans toucher au schéma ni au cloud ; une ligne sans origine notée est du fournisseur actuel.
 */

import type { LightIndexes, LightMovie, LightSeries } from '../types/lightIndex';
import { getDatabase, getMeta, isDatabaseOf, setMeta } from './dbCore';
import { computeProviderHash } from './preferencesService';
import { isStaleTitleLink } from '../utils/lightIndexHelpers';
import { createLogger } from '../utils/logger';

const log = createLogger('Watchlist');

export type WatchlistMediaType = 'movie' | 'series';

interface WatchlistRowRef {
  stream_id: number;
  tmdb_id: number;
  type: WatchlistMediaType;
}

const ORIGINS_KEY = 'watchlist_row_origins';

/** Clé d'une ligne de Ma liste : son numéro de source et son type (clé de la table locale) */
export const watchlistRowKey = (streamId: number, type: WatchlistMediaType): string => `${streamId}:${type}`;

/** Fiche du catalogue actuel au numéro de la ligne (peut être un autre titre) */
export function catalogItemAt(
  row: WatchlistRowRef,
  indexes: LightIndexes,
): LightMovie | LightSeries | undefined {
  return row.type === 'movie' ? indexes.movies.get(row.stream_id) : indexes.series.get(row.stream_id);
}

/**
 * La fiche du catalogue au numéro de la ligne est-elle bien le titre de la ligne ?
 * - numéro inconnu du catalogue : non ;
 * - numéro noté comme venant d'un autre fournisseur : seulement si les numéros TMDB concordent ;
 * - sinon : oui, sauf si la fiche porte un autre numéro TMDB que la ligne.
 */
export function catalogItemMatchesRow(
  row: WatchlistRowRef,
  item: LightMovie | LightSeries | undefined,
  foreign: ReadonlySet<string>,
): boolean {
  if (!item) return false;
  const sameTmdb = row.tmdb_id > 0 && item.tmdbId === row.tmdb_id;
  if (foreign.has(watchlistRowKey(row.stream_id, row.type))) return sameTmdb;
  // Entrée sans numéro : acceptée, sauf si elle avait un lien par le titre que son nom actuel ne permet plus de reposer
  return sameTmdb || row.tmdb_id <= 0 || (item.tmdbId <= 0 && !isStaleTitleLink(item));
}

/**
 * Le titre de la ligne peut-il s'ouvrir chez le fournisseur actuel ? Oui si le catalogue a son
 * numéro TMDB (l'ouverture passe alors par TMDB, useContentNavigation.ts), ou si la fiche à son
 * numéro est bien ce titre.
 */
export function isWatchlistRowAvailable(
  row: WatchlistRowRef,
  indexes: LightIndexes,
  foreign: ReadonlySet<string>,
): boolean {
  if (row.tmdb_id > 0) {
    const byTmdb = row.type === 'movie' ? indexes.moviesByTmdb : indexes.seriesByTmdb;
    if (byTmdb.has(row.tmdb_id)) return true;
  }
  return catalogItemMatchesRow(row, catalogItemAt(row, indexes), foreign);
}

// ============================================================================
// ORIGINE DES LIGNES (meta de la base du compte)
// ============================================================================

/** Origine notée de chaque ligne (clé → empreinte du fournisseur) ; vide si la lecture échoue */
export async function readWatchlistOrigins(): Promise<Map<string, string>> {
  try {
    const raw = await getMeta(ORIGINS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    const origins = new Map<string, string>();
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [key, hash] of Object.entries(parsed)) if (typeof hash === 'string') origins.set(key, hash);
    }
    return origins;
  } catch (err) {
    log.warn('Lecture de l\'origine des titres impossible :', err);
    return new Map();
  }
}

/**
 * Empreinte du fournisseur de CET appareil, d'après son adresse gardée en local (`meta.lastProvider`).
 * Pas la préférence `last_provider_hash` : synchronisée entre appareils, elle peut porter le
 * fournisseur d'un autre appareil. Pendant un changement de fournisseur, c'est encore l'ancien
 * (l'adresse est notée après l'effacement des données du fournisseur). null si inconnue.
 */
export async function deviceProviderHash(): Promise<string | null> {
  try {
    const host = await getMeta('lastProvider');
    return host ? await computeProviderHash(host) : null;
  } catch (err) {
    log.warn('Fournisseur de l\'appareil inconnu :', err);
    return null;
  }
}

/** Lignes dont l'origine notée n'est pas le fournisseur actuel */
export function foreignWatchlistRows(origins: ReadonlyMap<string, string>, currentHash: string | null): Set<string> {
  const foreign = new Set<string>();
  if (!currentHash) return foreign;
  for (const [key, hash] of origins) if (hash !== currentHash) foreign.add(key);
  return foreign;
}

/**
 * Note l'origine de lignes : une empreinte, ou `null` pour « fournisseur actuel » (origine oubliée).
 * `onlyMissing` : ne touche pas aux lignes dont l'origine est déjà notée. Sans écriture si rien ne
 * change. Une erreur est journalisée, jamais levée : au pire, une carte n'est pas marquée
 * « introuvable ».
 */
export async function updateWatchlistOrigins(
  entries: Iterable<readonly [string, string | null]>,
  options: {
    onlyMissing?: boolean;
    /** Compte dont c'est la base : rien n'est écrit si la base ouverte est devenue celle d'un autre */
    accountId?: string;
  } = {},
): Promise<void> {
  try {
    const current = await readWatchlistOrigins();
    const next = new Map(current);
    for (const [key, hash] of entries) {
      if (options.onlyMissing && next.has(key)) continue;
      if (hash === null) next.delete(key);
      else next.set(key, hash);
    }
    // Origines des lignes retirées de Ma liste oubliées : la liste ne grossit pas d'un fournisseur à l'autre
    const db = await getDatabase();
    const rows = await db.select<{ stream_id: number; type: WatchlistMediaType }[]>('SELECT stream_id, type FROM watchlist');
    const present = new Set(rows.map((row) => watchlistRowKey(row.stream_id, row.type)));
    for (const key of [...next.keys()]) if (!present.has(key)) next.delete(key);
    const unchanged = next.size === current.size && [...next].every(([key, hash]) => current.get(key) === hash);
    if (unchanged) return;
    if (options.accountId && !isDatabaseOf(options.accountId)) return;
    await setMeta(ORIGINS_KEY, JSON.stringify(Object.fromEntries(next)));
  } catch (err) {
    log.warn('Écriture de l\'origine des titres impossible :', err);
  }
}
