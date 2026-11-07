/**
 * Movie Grouping - Simple Approach
 *
 * 1. Normalize titles (remove IPTV prefixes + special chars)
 * 2. Block by first 5 chars
 * 3. Fuzzy match within blocks (Dice coefficient)
 * 4. Background verification via tmdb_id (optional)
 */

import { normalizeTmdbId, hasValidTmdbId } from './normalizeTmdb';

export interface GroupedItem<T> {
  representative: T;
  items: T[];
  sourceCount: number;
  groupKey: string;
}

// ============ TMDB GROUPING (Instant, O(n)) ============

/**
 * Groupe les items par TMDB ID (instant, O(n)), dans l'ordre où ils arrivent (rang de la recherche).
 *
 * - Les versions d'un même titre (même numéro TMDB) forment un seul groupe (`tmdb_<id>`).
 * - Un titre sans numéro TMDB forme son propre groupe (`item_<id>`) quand `keepOrphans` est vrai
 *   (la recherche : sinon un titre sans fiche n'y serait jamais trouvé) ; écarté sinon.
 * - Utilise normalizeTmdbId() pour gérer les cas string "0", null, undefined.
 *
 * @example
 * groupByTmdbId([
 *   { name: "Film (4K)", tmdb: 12345 },
 *   { name: "Sans fiche", tmdb: 0, stream_id: 7 },
 *   { name: "Film (HD)", tmdb: 12345 },
 * ])
 * // → [{ groupKey: "tmdb_12345", sourceCount: 2 }, { groupKey: "item_7", sourceCount: 1 }]
 */
export function groupByTmdbId<T extends { tmdb?: number | string; tmdbId?: number; stream_id?: number | string; id?: number }>(
  items: T[],
  keepOrphans = false
): GroupedItem<T>[] {
  const groups = new Map<string, T[]>();

  items.forEach((item, index) => {
    // Support both tmdb (IptvStream) and tmdbId (LightMovie/LightSeries)
    const rawTmdb = 'tmdbId' in item ? item.tmdbId : item.tmdb;
    const tmdbId = normalizeTmdbId(rawTmdb);
    if (!hasValidTmdbId(tmdbId) && !keepOrphans) return;
    const ownId = item.id ?? item.stream_id;
    const key = hasValidTmdbId(tmdbId)
      ? `tmdb_${tmdbId}`
      : `item_${ownId !== undefined && ownId !== null && ownId !== '' ? ownId : `index_${index}`}`;
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  });

  const result: GroupedItem<T>[] = [];
  for (const [groupKey, group] of groups) {
    result.push({
      representative: group[0],
      items: group,
      sourceCount: group.length,
      groupKey,
    });
  }
  return result;
}


