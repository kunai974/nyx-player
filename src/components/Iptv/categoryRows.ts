/**
 * categoryRows.ts — Titres des rangées de l'accueil Films / Séries, par catégorie.
 */

import type { LightCategory, LightMovie, LightSeries } from '../../types/lightIndex';
import { hasValidTmdbId } from '../../utils/normalizeTmdb';

type LightItem = LightMovie | LightSeries;

/**
 * Rangée « Autres » : titres rangés par le fournisseur dans une catégorie qu'il ne liste pas (ou sans
 * catégorie). Sans elle, ces films et séries n'apparaissaient nulle part sur l'accueil (des milliers
 * de titres chez certains fournisseurs) ; la recherche seule les trouvait.
 */
export const OTHER_CATEGORY_ID = '__nyx_other__';

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

function hasIcon(item: LightItem): boolean {
    return item.iconPrefixId >= 0 && item.iconSuffix !== '';
}

/**
 * Titres de chaque catégorie pour les rangées de l'accueil, dans l'ordre du fournisseur. Ceux d'une
 * catégorie inconnue (`known`) vont dans `OTHER_CATEGORY_ID`.
 *
 * - Catalogue avec des numéros TMDB (`catalogHasTmdb`) : comme avant, seuls les titres qui ont une
 *   fiche TMDB et une affiche ; une catégorie qui n'en a aucun (adultes, techniques…) reste cachée.
 * - Catalogue sans aucun numéro TMDB : tous les titres, ceux qui ont une affiche d'abord. Avant, ses
 *   onglets Films et Séries restaient vides alors que le catalogue était chargé.
 */
export function groupItemsByCategory(
    items: Iterable<LightItem>,
    catalogHasTmdb: boolean,
    known: ReadonlySet<string>,
): Map<string, LightItem[]> {
    const buckets = new Map<string, [LightItem[], LightItem[]]>();
    for (const item of items) {
        const icon = hasIcon(item);
        if (catalogHasTmdb && (!icon || !hasValidTmdbId(item.tmdbId))) continue;
        const categoryId = rowCategoryOf(item, known);
        let bucket = buckets.get(categoryId);
        if (!bucket) {
            bucket = [[], []];
            buckets.set(categoryId, bucket);
        }
        bucket[icon ? 0 : 1].push(item);
    }
    const map = new Map<string, LightItem[]>();
    buckets.forEach(([withIcon, bare], categoryId) => {
        map.set(categoryId, bare.length === 0 ? withIcon : withIcon.concat(bare));
    });
    return map;
}
