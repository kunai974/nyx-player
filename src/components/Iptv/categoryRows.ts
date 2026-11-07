/**
 * categoryRows.ts — Titres des rangées de l'accueil Films / Séries, par catégorie.
 */

import type { LightCategory, LightMovie, LightSeries } from '../../types/lightIndex';
import { hasValidTmdbId } from '../../utils/normalizeTmdb';
import { hasGivenPoster } from '../../services/titleTmdbLinkStore';

type LightItem = LightMovie | LightSeries;

import { OTHER_CATEGORY_ID } from '../../utils/otherCategory';

/** Rangée « Autres » de l'accueil (voir otherCategory.ts) */
export { OTHER_CATEGORY_ID };

/** Numéros des catégories que le fournisseur liste pour ce type */
export function knownCategoryIds(categories: Map<string, LightCategory>, type: LightCategory['type']): Set<string> {
    const ids = new Set<string>();
    categories.forEach((category) => {
        if (category.type === type) ids.add(category.id);
    });
    return ids;
}

/** Rangée d'un titre : sa catégorie si le fournisseur la liste, sinon « Autres » */
export function rowCategoryOf(item: LightItem, known: ReadonlySet<string>): string {
    return known.has(item.categoryId) ? item.categoryId : OTHER_CATEGORY_ID;
}

/** Image donnée par le fournisseur (une affiche TMDB posée après coup ne déplace jamais une carte) */
function hasIcon(item: LightItem): boolean {
    return item.iconPrefixId >= 0 && item.iconSuffix !== '' && !hasGivenPoster(item);
}

/**
 * Titres de chaque catégorie pour les rangées de l'accueil, dans l'ordre du fournisseur. Ceux d'une
 * catégorie inconnue (`known`) vont dans `OTHER_CATEGORY_ID`. Aucun titre n'est écarté.
 *
 * - Catalogue avec des numéros TMDB (`catalogHasTmdb`) : dans chaque rangée, d'abord les titres qui ont
 *   une fiche TMDB et une affiche (l'accueil d'avant), puis ceux qui ont une affiche, puis les autres.
 *   Une catégorie sans aucune fiche TMDB n'est plus cachée : elle passe en bas de la page
 *   (`isTmdbRow`, `orderRows`). Avant, ses titres n'apparaissaient nulle part sur l'accueil.
 * - Catalogue sans aucun numéro TMDB : tous les titres, ceux qui ont une affiche d'abord.
 */
export function groupItemsByCategory(
    items: Iterable<LightItem>,
    catalogHasTmdb: boolean,
    known: ReadonlySet<string>,
): Map<string, LightItem[]> {
    const buckets = new Map<string, [LightItem[], LightItem[], LightItem[]]>();
    for (const item of items) {
        const icon = hasIcon(item);
        const rank = catalogHasTmdb && icon && hasValidTmdbId(item.tmdbId) ? 0 : icon ? 1 : 2;
        const categoryId = rowCategoryOf(item, known);
        let bucket = buckets.get(categoryId);
        if (!bucket) {
            bucket = [[], [], []];
            buckets.set(categoryId, bucket);
        }
        bucket[rank].push(item);
    }
    const map = new Map<string, LightItem[]>();
    buckets.forEach(([linked, withIcon, bare], categoryId) => {
        map.set(categoryId, linked.concat(withIcon, bare));
    });
    return map;
}

/** Rangée qui commence par un titre avec fiche TMDB et affiche (catalogue avec TMDB : ils passent en tête) */
export function isTmdbRow(list: readonly LightItem[] | undefined): boolean {
    const first = list?.[0];
    return first !== undefined && hasIcon(first) && hasValidTmdbId(first.tmdbId);
}

/**
 * Ordre des rangées : celles qui ont des fiches TMDB, puis les catégories sans fiche (en bas de la
 * page), chacune dans l'ordre du fournisseur. Un catalogue sans TMDB garde l'ordre du fournisseur.
 */
export function orderRows<C extends { id: string }>(
    categories: readonly C[],
    grouped: ReadonlyMap<string, LightItem[]>,
    catalogHasTmdb: boolean,
): C[] {
    const withTmdb: C[] = [];
    const without: C[] = [];
    for (const category of categories) {
        const list = grouped.get(category.id);
        if (!list || list.length === 0) continue;
        (catalogHasTmdb && isTmdbRow(list) ? withTmdb : without).push(category);
    }
    return withTmdb.concat(without);
}
