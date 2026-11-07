/**
 * Watchlist Hydration Service
 * 
 * Hydrates watchlist items with name/poster from:
 * 1. TMDB Cache SQLite (via LEFT JOIN) - high quality, official posters
 * 2. LightIndexes (fallback, Xtream data), seulement si la fiche au même numéro est bien ce titre
 * 
 * Phase C2: Uses SQL JOIN instead of N sync calls
 */

import type { LightIndexes } from '../types/lightIndex';
import { getIconUrl } from '../types/lightIndex';
import tmdb from './tmdbApi';
import { getDatabase, getDatabaseFileName } from './dbCore';
import type { EpisodeProgressInfo } from './playbackProgressService';
import { pushWatchlistUpsertToCloud, pushWatchlistDeleteToCloud } from './syncService';
import { WATCHLIST_EVENT } from './eventConstants';
import {
  catalogItemAt,
  catalogItemMatchesRow,
  deviceProviderHash,
  foreignWatchlistRows,
  isWatchlistRowAvailable,
  readWatchlistOrigins,
  updateWatchlistOrigins,
  watchlistRowKey,
} from './watchlistAvailability';
import { requestMissingWatchlistDetails } from './watchlistDetailsFill';
import { relinkWatchlistOrphansByTitle } from './watchlistTitleRelink';
import { createLogger } from '../utils/logger';

const log = createLogger('Watchlist');

// ============================================================================
// TYPES
// ============================================================================


export interface HydratedWatchlistItem {
  stream_id: number;
  tmdb_id: number;
  type: 'movie' | 'series';
  added_at: number;
  name: string;
  posterUrl: string;
  /**
   * Introuvable chez le fournisseur actuel : ni son numéro TMDB ni son numéro de source ne mènent à
   * ce titre dans le catalogue (après un changement de fournisseur, par exemple)
   */
  isOrphan: boolean;
}

/** Result from SQL JOIN watchlist + tmdb_details_cache */
interface WatchlistJoinRow {
  stream_id: number;
  tmdb_id: number;
  type: 'movie' | 'series';
  added_at: number;
  display_name: string | null;
  poster_path: string | null;
}

// ============================================================================
// EVENT BUS - Synchronisation temps réel (CustomEvent unifié)
// ============================================================================

// Event constant imported from eventConstants.ts

/**
 * Subscribe to watchlist changes.
 * Returns unsubscribe function.
 * Utilise CustomEvent pour cohérence avec les autres services (liveTvBookmarks, preferences).
 */
export function onWatchlistChange(callback: () => void): () => void {
  const handler = () => callback();
  window.addEventListener(WATCHLIST_EVENT, handler);
  return () => window.removeEventListener(WATCHLIST_EVENT, handler);
}

// ============================================================================
// CORE FUNCTIONS
// ============================================================================

/**
 * Get fully hydrated watchlist items using SQL JOIN
 * Main entry point for WatchlistPage and Dashboard carousel
 * 
 * Phase C2: Single SQL query replaces N sync localStorage calls
 */
/** Nom du titre dans le catalogue actuel par son numéro TMDB (titre resté à un autre numéro) */
function byTmdbName(row: { tmdb_id: number; type: 'movie' | 'series' }, indexes: LightIndexes): string {
  if (row.tmdb_id <= 0) return '';
  const byTmdb = row.type === 'movie' ? indexes.moviesByTmdb : indexes.seriesByTmdb;
  return byTmdb.get(row.tmdb_id)?.name ?? '';
}

export async function getHydratedWatchlist(
  lightIndexes: LightIndexes
): Promise<HydratedWatchlistItem[]> {
  const db = await getDatabase();
  
  // SQL JOIN: Get watchlist items with TMDB data in one query
  const rows = await db.select<WatchlistJoinRow[]>(`
    SELECT 
      w.stream_id, 
      w.tmdb_id, 
      w.type, 
      w.added_at,
      t.display_name,
      t.poster_path
    FROM watchlist w
    LEFT JOIN tmdb_details_cache t 
      ON w.tmdb_id = t.tmdb_id 
      AND w.type = t.type 
      AND t.season_number = 0
    ORDER BY w.added_at DESC
  `);

  // Ligne sans numéro TMDB dont le titre a été relié par son nom (fournisseur sans numéro) : le nom et
  // l'affiche TMDB se lisent au numéro du lien, comme pour une ligne qui a son numéro
  const linkedIds = new Map<number, number>();
  // Titre noté comme venant d'un autre fournisseur : jamais le nom ni l'affiche de l'entrée qui a repris son numéro
  const foreign = foreignWatchlistRows(await readWatchlistOrigins(), await deviceProviderHash());
  /** Numéro TMDB trouvé par le titre pour l'entrée d'une ligne qui n'a pas de numéro, sinon 0 */
  const catalogLinked = (row: WatchlistJoinRow): number => {
    if (row.tmdb_id > 0) return 0;
    const item = catalogItemAt(row, lightIndexes);
    return item && catalogItemMatchesRow(row, item, foreign) ? Math.max(item.tmdbId, 0) : 0;
  };
  const linkedFor = (row: WatchlistJoinRow): number => (row.display_name ? 0 : catalogLinked(row));
  for (const row of rows) {
    const id = linkedFor(row);
    if (id > 0) linkedIds.set(row.stream_id * 2 + (row.type === 'movie' ? 0 : 1), id);
  }
  if (linkedIds.size > 0) {
    const ids = [...new Set(linkedIds.values())];
    const cached = await db.select<Array<{ tmdb_id: number; type: 'movie' | 'series'; display_name: string | null; poster_path: string | null }>>(
      `SELECT tmdb_id, type, display_name, poster_path FROM tmdb_details_cache WHERE season_number = 0 AND tmdb_id IN (${ids.map(() => '?').join(',')})`,
      ids,
    );
    for (const row of rows) {
      const id = linkedIds.get(row.stream_id * 2 + (row.type === 'movie' ? 0 : 1));
      const hit = id ? cached.find((c) => c.tmdb_id === id && c.type === row.type) : undefined;
      if (hit) { row.display_name = hit.display_name; row.poster_path = hit.poster_path; }
    }
    // Fiche pas encore en cache : demandée à TMDB, Ma liste se relit quand elle arrive
    requestMissingWatchlistDetails(rows
      .filter((row) => linkedIds.has(row.stream_id * 2 + (row.type === 'movie' ? 0 : 1)) && !row.display_name)
      .map((row) => ({ tmdb_id: linkedIds.get(row.stream_id * 2 + (row.type === 'movie' ? 0 : 1)) ?? 0, type: row.type })));
  }

  // Safety net: deduplicate by (tmdb_id, type) — keep first occurrence (most recent, since ORDER BY added_at DESC)
  // Items with tmdb_id=0 are never deduped (different stream_id = different item), sauf ceux dont le titre a
  // été relié par son nom : ils se comptent au numéro du lien, comme une ligne qui l'aurait déjà
  // (« Dune » ajouté avant le lien, puis sa version 4K ajoutée après : une seule carte)
  const seen = new Set<string>();
  const dedupedRows = rows.filter(row => {
    const effectiveId = row.tmdb_id > 0 ? row.tmdb_id : catalogLinked(row);
    if (effectiveId <= 0) return true;
    const key = `${effectiveId}:${row.type}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Titres introuvables chez le fournisseur actuel (watchlistAvailability.ts) : jamais le nom ni
  // l'affiche de la fiche qui a repris leur numéro, et marqués pour ne pas ouvrir un autre titre
  const items = dedupedRows.map((row): HydratedWatchlistItem => {
    const ref = { stream_id: row.stream_id, tmdb_id: row.tmdb_id, type: row.type };
    const atNumber = catalogItemAt(ref, lightIndexes);
    const lightItem = catalogItemMatchesRow(ref, atNumber, foreign) ? atNumber : undefined;
    const tmdbPoster = row.poster_path ? tmdb.imageUrl(row.poster_path, 'w342') || '' : '';

    return {
      stream_id: row.stream_id,
      tmdb_id: row.tmdb_id,
      type: row.type,
      added_at: row.added_at,
      // Nom TMDB d'abord, sinon celui du fournisseur ; vide si inconnu (la page affiche « Titre inconnu »)
      name: row.display_name || lightItem?.name || byTmdbName(ref, lightIndexes),
      posterUrl: tmdbPoster || (lightItem ? getIconUrl(lightItem, lightIndexes.iconPrefixes) : ''),
      isOrphan: !isWatchlistRowAvailable(ref, lightIndexes, foreign),
    };
  });

  // Titre sans fiche TMDB en cache et sans nom ou affiche (typiquement « introuvable » sur un nouvel
  // appareil) : sa fiche est demandée à TMDB par son numéro ; Ma liste se relit quand elle arrive
  requestMissingWatchlistDetails(dedupedRows.filter((row, i) =>
    row.tmdb_id > 0 && !row.display_name && (!items[i].name || !items[i].posterUrl)));

  // Titre introuvable dont la liste a peut-être une entrée du même nom sans numéro TMDB (liste M3U) :
  // rattaché en local par son titre et son année ; Ma liste se relit quand un lien est posé
  const orphans = items.filter((item) => item.isOrphan && item.tmdb_id > 0);
  if (orphans.length > 0) void relinkWatchlistOrphansByTitle(lightIndexes, orphans);

  return items;
}

// ============================================================================
// MÉMOIRE — « Ma liste » lue une fois, pas à chaque carte
// ============================================================================

/**
 * Identifiants de « Ma liste » en mémoire (chaque carte
 * interrogeait la base, jusqu'à 250 requêtes pendant une recherche). Deux clés par ligne, une
 * pour son numéro de source et une pour son numéro TMDB, rangées à part : un numéro de source égal
 * au numéro TMDB d'un autre film ne fait plus croire qu'il est dans Ma liste
 * (l'ancienne requête `stream_id = ? OR tmdb_id = ?` les mélangeait).
 *
 * Liée à la connexion de la base : un changement de compte ou une réouverture (nouvelle connexion)
 * recharge la liste. Toute écriture dans la table doit appeler `invalidateWatchlistCache()` ou
 * émettre WATCHLIST_EVENT (qui l'invalide aussi).
 */
let memo: { db: unknown; keys: Promise<Set<string>> } | null = null;

type WatchlistIdKind = 'stream' | 'tmdb';
const watchlistKey = (kind: WatchlistIdKind, type: string, id: number): string => `${kind}:${type}:${id}`;

/** Oublie « Ma liste » en mémoire : la prochaine lecture la recharge depuis la base. */
export function invalidateWatchlistCache(): void {
  memo = null;
  shown = null;
}

/**
 * Dernière « Ma liste » affichée par la page, gardée entre deux visites (Chromecast) : sans
 * elle, chaque arrivée sur la page montrait des cartes fantômes ≈ 0,2 s puis remplaçait tout d'un
 * coup, en plein fondu d'arrivée (qui passait inaperçu). La page affiche d'abord ce souvenir puis
 * relit toujours la base ; le souvenir ne sert qu'en attendant.
 *
 * Lié au fichier de base du compte et au catalogue en mémoire : un autre compte ou un autre catalogue
 * n'en reçoit rien. Oublié à chaque écriture dans la table (`invalidateWatchlistCache`) : après un
 * ajout ou un retrait, la visite suivante repart de la base.
 */
export interface ShownWatchlist {
  items: HydratedWatchlistItem[];
  progress: Map<number, EpisodeProgressInfo>;
}

let shown: (ShownWatchlist & { dbFile: string | null; indexes: LightIndexes }) | null = null;

export function rememberShownWatchlist(indexes: LightIndexes, list: ShownWatchlist): void {
  shown = { ...list, dbFile: getDatabaseFileName(), indexes };
}

export function getShownWatchlist(indexes: LightIndexes): ShownWatchlist | null {
  if (!shown || shown.indexes !== indexes || shown.dbFile !== getDatabaseFileName()) return null;
  return { items: shown.items, progress: shown.progress };
}

// Écouteur posé au chargement du module, donc avant ceux des cartes (qui importent ce module) :
// la mémoire est oubliée avant qu'elles ne reposent la question.
if (typeof window !== 'undefined') {
  window.addEventListener(WATCHLIST_EVENT, invalidateWatchlistCache);
}

/** Clés de tous les titres de Ma liste, lues une fois puis gardées en mémoire (oubliées à chaque écriture). */
export async function watchlistKeys(): Promise<Set<string>> {
  const db = await getDatabase();
  if (!memo || memo.db !== db) {
    const keys = db
      .select<{ stream_id: number; tmdb_id: number; type: string }[]>('SELECT stream_id, tmdb_id, type FROM watchlist')
      .then((rows) => {
        const set = new Set<string>();
        for (const row of rows) {
          set.add(watchlistKey('stream', row.type, row.stream_id));
          if (row.tmdb_id > 0) set.add(watchlistKey('tmdb', row.type, row.tmdb_id));
        }
        return set;
      });
    const entry = { db, keys };
    memo = entry;
    // Lecture en échec : ne pas garder l'échec en mémoire, la suivante réessaiera.
    keys.catch(() => { if (memo === entry) memo = null; });
  }
  return memo.keys;
}

/**
 * Le titre est-il dans Ma liste ? Par son numéro TMDB s'il en a un, sinon par son numéro de source
 * (même règle que `toggleWatchlist`). Les deux numéros ne sont jamais comparés entre eux.
 */
export async function isInWatchlist(
  streamId: number,
  tmdbId: number,
  type: 'movie' | 'series'
): Promise<boolean> {
  const key = watchlistItemKey(streamId, tmdbId, type);
  return key !== null && (await watchlistKeys()).has(key);
}

/** Clé d'un titre parmi celles de `watchlistKeys` (règle de `isInWatchlist`), ou null s'il n'a aucun numéro. */
export function watchlistItemKey(streamId: number, tmdbId: number, type: 'movie' | 'series'): string | null {
  if (tmdbId <= 0 && streamId <= 0) return null;
  return tmdbId > 0 ? watchlistKey('tmdb', type, tmdbId) : watchlistKey('stream', type, streamId);
}

/**
 * Add item to watchlist
 */
async function addToWatchlist(
  streamId: number,
  tmdbId: number,
  type: 'movie' | 'series'
): Promise<void> {
  const db = await getDatabase();
  const now = Date.now();
  // Remove any existing entry with the same tmdb_id but different stream_id
  // (can happen after provider change — old stream_id is stale)
  if (tmdbId > 0) {
    await db.execute(
      'DELETE FROM watchlist WHERE tmdb_id = ? AND type = ? AND stream_id != ?',
      [tmdbId, type, streamId]
    );
  }
  // Numéro déjà pris par un autre titre TMDB (typiquement un titre « Introuvable » de l'ancien
  // fournisseur) : ce titre passe sur un numéro provisoire négatif au lieu d'être remplacé, sinon
  // la synchro prendrait sa disparition pour un retrait et l'enlèverait partout.
  // La re-liaison le remet à un vrai numéro si le catalogue retrouve son titre. Une
  // ligne sans TMDB ne désigne que « le titre à ce numéro » : elle est remplacée, comme avant.
  const rows = await db.select<{ stream_id: number; tmdb_id: number; type: string }[]>(
    'SELECT stream_id, tmdb_id, type FROM watchlist'
  );
  const occupant = rows.find((row) => row.stream_id === streamId && row.type === type);
  if (occupant && occupant.tmdb_id > 0 && occupant.tmdb_id !== tmdbId) {
    const provisional = rows.reduce((min, row) => Math.min(min, row.stream_id), 0) - 1;
    await db.execute(
      'UPDATE watchlist SET stream_id = ? WHERE stream_id = ? AND type = ? AND tmdb_id = ?',
      [provisional, streamId, type, occupant.tmdb_id]
    );
  }
  await db.execute(`
    INSERT OR REPLACE INTO watchlist (stream_id, tmdb_id, type, added_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `, [streamId, tmdbId || 0, type, now, now]);
  // Numéro pris dans le catalogue actuel : la ligne est du fournisseur actuel
  await updateWatchlistOrigins([[watchlistRowKey(streamId, type), null]]);
  window.dispatchEvent(new CustomEvent(WATCHLIST_EVENT));
  // Fire-and-forget : propager l'ajout vers Supabase immédiatement
  pushWatchlistUpsertToCloud(streamId, tmdbId || 0, type);
}

/**
 * Remove item from watchlist
 * Priority: tmdb_id > stream_id (same rule as isInWatchlist)
 */
export async function removeFromWatchlist(
  streamId: number,
  tmdbId: number,
  type: 'movie' | 'series'
): Promise<void> {
  const db = await getDatabase();
  
  // Delete by tmdb_id if available, otherwise by stream_id
  if (tmdbId > 0) {
    await db.execute(`
      DELETE FROM watchlist WHERE tmdb_id = ? AND type = ?
    `, [tmdbId, type]);
  } else if (streamId > 0) {
    await db.execute(`
      DELETE FROM watchlist WHERE stream_id = ? AND type = ?
    `, [streamId, type]);
  }
  window.dispatchEvent(new CustomEvent(WATCHLIST_EVENT));
  // Fire-and-forget : propager la suppression vers Supabase immédiatement
  pushWatchlistDeleteToCloud(streamId, type, tmdbId || 0);
}

/**
 * Toggle watchlist status, returns new state
 * Uses tmdb_id for check/remove if available, otherwise stream_id
 */
export async function toggleWatchlist(
  streamId: number,
  tmdbId: number,
  type: 'movie' | 'series'
): Promise<boolean> {
  if (tmdbId <= 0 && streamId <= 0) {
    log.warn('toggleWatchlist called with no valid ID');
    return false;
  }

  const isIn = await isInWatchlist(streamId, tmdbId, type);
  if (isIn) {
    await removeFromWatchlist(streamId, tmdbId, type);
    return false;
  } else {
    await addToWatchlist(streamId, tmdbId, type);
    return true;
  }
}
