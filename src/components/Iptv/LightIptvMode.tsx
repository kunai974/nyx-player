import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import VirtualContentCarousel from '../Lists/VirtualContentCarousel';
import { CarouselItem } from '../Lists/ContentCarousel';
import LazyCategory from './LazyCategory';
import RecycledRail from './rail/RecycledRail';
import { isRailOn, type RailSource } from './rail/rail';
import { createRailRowCache } from './rail/railRowCache';
import type { LightMovie, LightSeries, LightCategory, LightIndexes } from '../../types/lightIndex';
import { getIconUrl } from '../../types/lightIndex';
import { OTHER_CATEGORY_ID, groupItemsByCategory, knownCategoryIds, orderRows } from './categoryRows';
import { isHidden } from '../../services/hiddenCategoriesService';
import { useHiddenCategoriesVersion } from '../../hooks/useHiddenCategoriesVersion';
import { categoryPostersVersion, providerTmdbCount, subscribeTitlePosters, titlePostersVersion } from '../../services/titleTmdbLinkStore';
import { requestShownM3uTitles } from '../../services/m3uTmdbLinks';
import './IptvMode.css';

const MAX_ITEMS_PER_ROW = 10;

// Union type for light items
type LightItem = LightMovie | LightSeries;

/**
 * Cartes d'une rangée affichée encore sans fiche TMDB : cherchées par leur titre (listes M3U, demandes
 * groupées par le relais, une fois par titre). Le reste du catalogue n'est cherché qu'à l'ouverture d'une fiche.
 */
function searchShownCards(type: 'movies' | 'series', items: readonly LightItem[]): void {
    const kind = type === 'movies' ? 'movie' : 'series';
    const missing = items.slice(0, MAX_ITEMS_PER_ROW).filter((item) => item.tmdbId <= 0).map((item) => ({ kind, id: item.id } as const));
    requestShownM3uTitles(missing);
}

/** Cartes d'une catégorie : ses premiers titres, puis « Voir tout » s'il en reste. */
function buildCategoryItems(
    category: LightCategory,
    categoryItems: LightItem[],
    type: 'movies' | 'series',
    iconPrefixes: string[],
    onItemClick: (id: number, tmdbId: number) => void,
    onSeeAll: (categoryId: string, categoryName: string) => void,
    seeAllLabel: string,
): CarouselItem[] {
    const limitedItems = categoryItems.slice(0, MAX_ITEMS_PER_ROW);
    const hasMore = categoryItems.length > MAX_ITEMS_PER_ROW;

    const items: CarouselItem[] = limitedItems.map((item) => {
        const itemType = type === 'movies' ? 'movie' : 'series';
        const posterUrl = getIconUrl(item, iconPrefixes);

        return {
            id: item.id,
            title: item.name,
            image: posterUrl,
            onClick: () => onItemClick(item.id, item.tmdbId),
            mediaType: itemType,
            // Async watchlist: provide tmdbId and streamId
            // ContentCarousel handles the toggle via its built-in async system
            tmdbId: item.tmdbId > 0 ? item.tmdbId : undefined,
            streamId: item.id,
        };
    });

    if (hasMore) {
        items.push({
            id: `see-all-${category.id}`,
            title: seeAllLabel,
            image: '', // No image for action buttons
            onClick: () => onSeeAll(category.id, category.name),
            isActionButton: true, // Disables hover behaviors, uses button styling
        });
    }

    return items;
}

// =============================================================================
// LightCategoryRow - Composant qui fait le calcul SEULEMENT quand monté
// =============================================================================
interface LightCategoryRowProps {
    category: LightCategory;
    categoryItems: LightItem[];
    type: 'movies' | 'series';
    iconPrefixes: string[];
    onItemClick: (id: number, tmdbId: number) => void;
    onSeeAll: (categoryId: string, categoryName: string) => void;
    gap?: number;
    /** Change quand des cartes de la rangée reçoivent ou perdent une affiche TMDB */
    postersVersion: number;
}

const LightCategoryRow: React.FC<LightCategoryRowProps> = React.memo(({
    category,
    categoryItems,
    type,
    iconPrefixes,
    onItemClick,
    onSeeAll,
    gap,
    postersVersion,
}) => {
    const { t } = useTranslation('dashboard');

    const carouselItems = useMemo(
        () => buildCategoryItems(category, categoryItems, type, iconPrefixes, onItemClick, onSeeAll, t('see_all' as 'loading')), // Cast: key exists but types not regenerated
        // postersVersion n'est pas lu : les images des cartes ont changé en place, il force le recalcul
        // eslint-disable-next-line react-hooks/exhaustive-deps -- dépendance voulue, voir ci-dessus
        [categoryItems, type, iconPrefixes, onItemClick, onSeeAll, category, t, postersVersion],
    );

    useEffect(() => searchShownCards(type, categoryItems), [type, categoryItems]);

    if (carouselItems.length === 0) return null;

    return (
        // data-see-all : la rangée finit par « Voir tout » (repère du banc de test)
        // TV : Haut/Bas d'une catégorie à l'autre arrive sur la carte dans l'axe (spatialNavigation), comme les rangées des suggestions
        <div className="iptv-category-section" data-testid="iptv-category" data-see-all={categoryItems.length > MAX_ITEMS_PER_ROW} data-nav-align="">
            <div className="iptv-category-header">
                <h3 className="iptv-category-title">{category.name}</h3>
            </div>
            <VirtualContentCarousel
                title=""
                items={carouselItems}
                gap={gap}
            />
        </div>
    );
});

LightCategoryRow.displayName = 'LightCategoryRow';

// =============================================================================
// LightIptvMode - Composant principal (RAM optimized)
// =============================================================================
interface LightIptvModeProps {
    type: 'movies' | 'series';
    lightIndexes: LightIndexes;
    onItemClick: (id: number, tmdbId: number) => void;
    onSeeAll: (categoryId: string, categoryName: string) => void;
    /** DevPanel: force aucune catégorie (état vide) */
    forceNoCategories?: boolean;
    gap?: number;
    /** Accueil caché par une fiche ou par le lecteur (rail TV) */
    covered?: boolean;
}

const LightIptvMode: React.FC<LightIptvModeProps> = ({
    type,
    lightIndexes,
    onItemClick,
    onSeeAll,
    forceNoCategories = false,
    gap,
    covered = false,
}) => {
    const { t } = useTranslation('dashboard');

    // Get items map based on type
    const itemsMap = type === 'movies' ? lightIndexes.movies : lightIndexes.series;
    const iconPrefixes = lightIndexes.iconPrefixes;

    // Get categories for this type (re-filtered when hidden categories change via sync)
    const hiddenVersion = useHiddenCategoriesVersion();
    const categories = useMemo(() => {
        const catType = type === 'movies' ? 'movie' : 'series';
        const cats: LightCategory[] = [];
        lightIndexes.categories.forEach((cat) => {
            if (cat.type === catType && !isHidden(cat.id, catType)) {
                cats.push(cat);
            }
        });
        return cats;
        // hiddenVersion n'est pas lu : il change quand isHidden() change (synchro) et force le recalcul
        // eslint-disable-next-line react-hooks/exhaustive-deps -- dépendance voulue, voir ci-dessus
    }, [lightIndexes.categories, type, hiddenVersion]);

    // Titres rangés par catégorie (groupItemsByCategory) : tous ; ceux qui ont une fiche TMDB d'abord si le
    // fournisseur en donne (ceux trouvés par le titre ne comptent pas : titleTmdbLinkStore.ts)
    const byTmdb = type === 'movies' ? lightIndexes.moviesByTmdb : lightIndexes.seriesByTmdb;
    const catalogHasTmdb = providerTmdbCount(byTmdb) > 0;
    const catType = type === 'movies' ? 'movie' : 'series';
    const itemsByCategory = useMemo(
        () => groupItemsByCategory(itemsMap.values(), catalogHasTmdb, knownCategoryIds(lightIndexes.categories, catType)),
        [itemsMap, catalogHasTmdb, lightIndexes.categories, catType],
    );
    // Affiches TMDB posées sur des titres sans image (trouvés par le titre) : seules les rangées touchées se
    // refont, sans changer d'ordre (« Autres » mêle plusieurs catégories : elle suit toutes les affiches)
    const postersVersion = useSyncExternalStore(subscribeTitlePosters, titlePostersVersion);
    const rowPostersVersion = (categoryId: string) =>
        (categoryId === OTHER_CATEGORY_ID ? postersVersion : categoryPostersVersion(categoryId));

    // Filter categories that have items, then « Autres » (titres d'une catégorie que le fournisseur ne liste pas)
    const otherLabel = t('other_category' as 'loading'); // Cast: key exists but types not regenerated
    const categoriesWithItems = useMemo(() => {
        // Catégories sans fiche TMDB en bas de la page, puis « Autres »
        const withItems = orderRows(categories, itemsByCategory, catalogHasTmdb);
        if (itemsByCategory.has(OTHER_CATEGORY_ID)) {
            withItems.push({ id: OTHER_CATEGORY_ID, name: otherLabel, type: catType });
        }
        return withItems;
    }, [categories, itemsByCategory, catalogHasTmdb, otherLabel, catType]);

    // TV : rangées du rail recyclé (rail/rail.ts), écrites sans React. Les gestes passent par la dernière version des
    // rappels : sans quoi chaque rendu de l'accueil (qui les recrée) ferait remplir de nouveau les rangées montées
    const rail = isRailOn();
    const clickRef = useRef(onItemClick);
    const seeAllRef = useRef(onSeeAll);
    useLayoutEffect(() => {
        clickRef.current = onItemClick;
        seeAllRef.current = onSeeAll;
    });
    const openItem = useCallback((id: number, tmdbId: number) => clickRef.current(id, tmdbId), []);
    const openSeeAll = useCallback((categoryId: string, categoryName: string) => seeAllRef.current(categoryId, categoryName), []);
    const railRows = useMemo(() => categoriesWithItems.map((category) => category.id), [categoriesWithItems]);
    // Une catégorie dont rien n'a changé garde ses données : le rail ne la remplit pas de nouveau
    const [railCache] = useState(createRailRowCache);
    const railSource = useMemo((): RailSource => {
        const byId = new Map(categoriesWithItems.map((category) => [category.id, category]));
        const seeAll = t('see_all' as 'loading'); // Cast: key exists but types not regenerated
        const watchlistLabel = t('add_to_watchlist' as 'loading', { ns: 'common' });
        return (key) => {
            const category = byId.get(key);
            if (!category) return null;
            const list = itemsByCategory.get(category.id);
            return railCache.get(key, [category, list, type, iconPrefixes, seeAll, watchlistLabel, rowPostersVersion(key)], () => {
                searchShownCards(type, list || []);
                return {
                    title: category.name,
                    items: buildCategoryItems(category, list || [], type, iconPrefixes, openItem, openSeeAll, seeAll),
                    watchlistLabel,
                };
            });
        };
        // postersVersion : la source se refait, le cache garde les rangées dont aucune carte n'a changé
        // eslint-disable-next-line react-hooks/exhaustive-deps -- rowPostersVersion lit postersVersion
    }, [categoriesWithItems, itemsByCategory, type, iconPrefixes, openItem, openSeeAll, t, railCache, postersVersion]);

    if (forceNoCategories || categoriesWithItems.length === 0) {
        return (
            <div className="iptv-mode-empty">
                <p>{t('no_categories_available')}</p>
            </div>
        );
    }

    if (rail) return <RecycledRail rows={railRows} source={railSource} gap={gap} covered={covered} />;

    return (
        <div className="iptv-mode">
            {categoriesWithItems.map((category) => {
                const categoryItems = itemsByCategory.get(category.id) || [];

                if (categoryItems.length === 0) return null;

                return (
                    <LazyCategory key={category.id}>
                        <LightCategoryRow
                            category={category}
                            categoryItems={categoryItems}
                            postersVersion={rowPostersVersion(category.id)}
                            type={type}
                            iconPrefixes={iconPrefixes}
                            onItemClick={onItemClick}
                            onSeeAll={onSeeAll}
                            gap={gap}
                        />
                    </LazyCategory>
                );
            })}
        </div>
    );
};

export default React.memo(LightIptvMode);
