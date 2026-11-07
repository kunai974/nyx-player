/**
 * liveTvBookmarksService.ts — Favoris TV + Catégories épinglées
 *
 * Architecture :
 * - Cache mémoire (Set) pour lectures synchrones
 * - SQLite pour persistance (async)
 * - Connexion via getDatabase() (singleton dbCore.ts)
 * - Event 'liveTvBookmarksUpdated' pour sync cross-composant
 */

import { getDatabase } from './dbCore';
import { pushLiveTvBookmarkDeleteToCloud, pushLiveTvBookmarkUpsertToCloud } from './syncService';
import { LIVE_TV_BOOKMARKS_EVENT } from './eventConstants';
import { createLogger } from '../utils/logger';

const log = createLogger('LiveTvBookmarks');

// ============================================================================
// CACHE MÉMOIRE
// ============================================================================

let favoriteIds: Set<number> = new Set();
let pinnedCategoryIds: Set<string> = new Set();
let initialized = false;

// ============================================================================
// INIT (appelé au boot)
// ============================================================================

/**
 * Charge les favoris et catégories épinglées depuis SQLite dans le cache mémoire.
 * Utilise getDatabase() pour la connexion centralisée.
 */
export async function initLiveTvBookmarks(): Promise<void> {
  if (initialized) return;

  try {
    const db = await getDatabase();

    // Charger favorites
    const favRows = await db.select<{ stream_id: number }[]>(
      'SELECT stream_id FROM live_tv_favorites'
    );
    favoriteIds = new Set(favRows.map(r => r.stream_id));

    // Charger pinned categories
    const pinRows = await db.select<{ category_id: string }[]>(
      'SELECT category_id FROM live_tv_pinned_categories'
    );
    pinnedCategoryIds = new Set(pinRows.map(r => r.category_id));

    initialized = true;

    // Notifier les hooks React déjà montés (useLiveTvCategories dans App.tsx)
    window.dispatchEvent(new CustomEvent(LIVE_TV_BOOKMARKS_EVENT, { detail: { type: 'init' } }));
  } catch (error) {
    log.error('Init failed:', error);
  }
}

/**
 * Reset le cache mémoire des bookmarks Live TV.
 * Appelé au SIGNED_OUT pour éviter que le prochain user hérite des données en mémoire.
 */
export function resetLiveTvBookmarksCache(): void {
  favoriteIds.clear();
  pinnedCategoryIds.clear();
  initialized = false;
  // Notifier les hooks React (useLiveTvCategories est monté dans App, jamais démonté)
  window.dispatchEvent(new CustomEvent(LIVE_TV_BOOKMARKS_EVENT, { detail: { type: 'reset' } }));
}

/**
 * Recharge les favoris et catégories épinglées depuis SQLite dans le cache mémoire.
 * Appelé par syncService après un pull cloud pour mettre à jour les getters synchrones.
 */
export async function reloadLiveTvFromDb(): Promise<void> {
  try {
    const db = await getDatabase();

    const favRows = await db.select<{ stream_id: number }[]>(
      'SELECT stream_id FROM live_tv_favorites'
    );
    favoriteIds = new Set(favRows.map(r => r.stream_id));

    const pinRows = await db.select<{ category_id: string }[]>(
      'SELECT category_id FROM live_tv_pinned_categories'
    );
    pinnedCategoryIds = new Set(pinRows.map(r => r.category_id));

    window.dispatchEvent(new CustomEvent(LIVE_TV_BOOKMARKS_EVENT, { detail: { type: 'reload' } }));
  } catch (error) {
    log.error('reloadFromDb failed:', error);
  }
}

// ============================================================================
// API SYNCHRONE (lecture cache)
// ============================================================================

/** Retourne l'ensemble des stream_ids favoris */
export function getFavorites(): Set<number> {
  return new Set(favoriteIds); // Copie défensive
}

/** Retourne l'ensemble des category_ids épinglés */
export function getPinnedCategories(): Set<string> {
  return new Set(pinnedCategoryIds); // Copie défensive
}

// ============================================================================
// API ASYNC (écriture SQLite + cache)
// ============================================================================

/**
 * Toggle un favori TV. Retourne true si ajouté, false si retiré (l'état réel si l'écriture échoue).
 */
export async function toggleFavorite(streamId: number): Promise<boolean> {
  const wasPresent = favoriteIds.has(streamId);

  if (wasPresent) {
    favoriteIds.delete(streamId);
  } else {
    favoriteIds.add(streamId);
  }

  // Dispatch event pour sync UI
  window.dispatchEvent(new CustomEvent(LIVE_TV_BOOKMARKS_EVENT, { detail: { type: 'favorite', streamId } }));

  // Persist to SQLite (fire-and-forget safe)
  try {
    const db = await getDatabase();
    if (wasPresent) {
      await db.execute('DELETE FROM live_tv_favorites WHERE stream_id = ?', [streamId]);
      pushLiveTvBookmarkDeleteToCloud('favorite', String(streamId));
    } else {
      await db.execute(
        'INSERT OR IGNORE INTO live_tv_favorites (stream_id, added_at) VALUES (?, ?)',
        [streamId, Date.now()]
      );
      // Fire-and-forget : propager l'ajout vers Supabase immédiatement
      pushLiveTvBookmarkUpsertToCloud('favorite', String(streamId));
    }
  } catch (error) {
    log.error(`Failed to toggle favorite ${streamId}:`, error);
    // Rollback cache, puis l'affichage revient en arrière lui aussi
    if (wasPresent) {
      favoriteIds.add(streamId);
    } else {
      favoriteIds.delete(streamId);
    }
    window.dispatchEvent(new CustomEvent(LIVE_TV_BOOKMARKS_EVENT, { detail: { type: 'favorite', streamId } }));
    return wasPresent; // état réel : rien n'a changé
  }

  return !wasPresent; // true = ajouté, false = retiré
}

/**
 * Toggle une catégorie épinglée. Retourne true si ajoutée, false si retirée (l'état réel si l'écriture échoue).
 */
export async function togglePinnedCategory(categoryId: string): Promise<boolean> {
  const wasPresent = pinnedCategoryIds.has(categoryId);

  if (wasPresent) {
    pinnedCategoryIds.delete(categoryId);
  } else {
    pinnedCategoryIds.add(categoryId);
  }

  // Dispatch event pour sync UI
  window.dispatchEvent(new CustomEvent(LIVE_TV_BOOKMARKS_EVENT, { detail: { type: 'pinned', categoryId } }));

  // Persist to SQLite
  try {
    const db = await getDatabase();
    if (wasPresent) {
      await db.execute('DELETE FROM live_tv_pinned_categories WHERE category_id = ?', [categoryId]);
      pushLiveTvBookmarkDeleteToCloud('pinned_category', categoryId);
    } else {
      await db.execute(
        'INSERT OR IGNORE INTO live_tv_pinned_categories (category_id, added_at) VALUES (?, ?)',
        [categoryId, Date.now()]
      );
      // Fire-and-forget : propager l'ajout vers Supabase immédiatement
      pushLiveTvBookmarkUpsertToCloud('pinned_category', categoryId);
    }
  } catch (error) {
    log.error(`Failed to toggle pinned category ${categoryId}:`, error);
    // Rollback cache, puis l'affichage revient en arrière lui aussi
    if (wasPresent) {
      pinnedCategoryIds.add(categoryId);
    } else {
      pinnedCategoryIds.delete(categoryId);
    }
    window.dispatchEvent(new CustomEvent(LIVE_TV_BOOKMARKS_EVENT, { detail: { type: 'pinned', categoryId } }));
    return wasPresent; // état réel : rien n'a changé
  }

  return !wasPresent;
}

