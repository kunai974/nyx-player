/**
 * liveTvLists.ts — Catégories et chaînes de Live TV tirées du catalogue en mémoire.
 *
 * Construites une fois par catalogue (Chromecast) : elles étaient reconstruites à chaque
 * changement de catégorie (toutes les chaînes du fournisseur, ≈ 80 ms plus le nettoyage mémoire sur
 * le Chromecast, pendant l'ouverture de la catégorie), et la page refiltrait tout puisque la liste
 * était neuve. Le lecteur (liste de zap) reprend les mêmes listes au lieu de tout reconstruire à
 * chaque changement de chaîne. Un catalogue actualisé est un nouvel objet (jamais
 * modifié sur place) : il reçoit ses propres listes.
 */

import type { IptvCategory, IptvStream } from '../types/iptv';
import type { LightIndexes } from '../types/lightIndex';
import { getIconUrl } from '../types/lightIndex';
import { isHidden } from './hiddenCategoriesService';
import i18n from '../i18n/config';
import { OTHER_CATEGORY_ID } from '../utils/otherCategory';

export interface LiveTvLists {
  categories: IptvCategory[];
  streams: IptvStream[];
}

const liveTvCache = new WeakMap<LightIndexes, LiveTvLists>();
const knownLiveCache = new WeakMap<LightIndexes, Set<string>>();

function knownLiveCategories(indexes: LightIndexes): Set<string> {
  let known = knownLiveCache.get(indexes);
  if (!known) {
    known = new Set();
    for (const c of indexes.categories.values()) if (c.type === 'live') known.add(c.id);
    knownLiveCache.set(indexes, known);
  }
  return known;
}

/**
 * Catégorie de Live TV d'une chaîne : la sienne si le fournisseur la liste, sinon « Autres ». Une chaîne sans
 * catégorie (champ vide chez certains fournisseurs, des centaines de chaînes) ou rangée dans une catégorie
 * absente de la liste n'apparaissait dans aucune catégorie : ni sur la page, ni au zapping, ni dans le guide.
 */
export function liveCategoryOf(indexes: LightIndexes, categoryId: string): string {
  return knownLiveCategories(indexes).has(categoryId) ? categoryId : OTHER_CATEGORY_ID;
}

/**
 * Toutes les catégories live (masquées comprises), plus « Autres » en dernier si des chaînes y vont, et toutes
 * les chaînes, une fois par catalogue.
 */
export function liveTvLists(indexes: LightIndexes): LiveTvLists {
  let lists = liveTvCache.get(indexes);
  if (!lists) {
    const categories: IptvCategory[] = Array.from(indexes.categories.values())
      .filter(c => c.type === 'live')
      .map(c => ({
        category_id: c.id,
        category_name: c.name,
        parent_id: 0,
      }));
    let hasOther = false;
    const streams = Array.from(indexes.live.values()).map(ch => {
      const categoryId = liveCategoryOf(indexes, ch.categoryId);
      if (categoryId === OTHER_CATEGORY_ID) hasOther = true;
      return {
        num: 0,
        name: ch.name,
        stream_type: 'live' as const,
        stream_id: ch.id,
        stream_icon: getIconUrl(ch, indexes.iconPrefixes),
        epg_channel_id: ch.epgChannelId,
        matched_epg_id: ch.matchedEpgId,
        match_method: ch.matchMethod,
        added: '',
        category_id: categoryId,
        tmdb: 0,
      };
    });
    if (hasOther) {
      // Nom lu à chaque affichage : il suit un changement de langue sans attendre le catalogue suivant
      const other = { category_id: OTHER_CATEGORY_ID, parent_id: 0 } as IptvCategory;
      Object.defineProperty(other, 'category_name', { get: () => i18n.t('dashboard:other_category'), enumerable: true });
      categories.push(other);
    }
    lists = { categories, streams };
    liveTvCache.set(indexes, lists);
  }
  return lists;
}

/**
 * Catégories live non masquées, dans l'ordre du catalogue. Liste courte (quelques centaines au
 * plus) : à recalculer quand les catégories masquées changent (useHiddenCategoriesVersion).
 */
export function visibleLiveCategories(indexes: LightIndexes): IptvCategory[] {
  return liveTvLists(indexes).categories.filter(c => !isHidden(c.category_id, 'live'));
}
