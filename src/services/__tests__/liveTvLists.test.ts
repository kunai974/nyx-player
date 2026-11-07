/**
 * liveTvLists — listes de Live TV construites une fois par catalogue (le lecteur les
 * réutilise au lieu de reconstruire toutes les chaînes à chaque changement de chaîne).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LightIndexes } from '../../types/lightIndex';

const hidden = new Set<string>();
vi.mock('../hiddenCategoriesService', () => ({
  isHidden: (id: string, type: string) => hidden.has(`${id}::${type}`),
}));

import { liveCategoryOf, liveTvLists, visibleLiveCategories } from '../liveTvLists';
import { OTHER_CATEGORY_ID } from '../../utils/otherCategory';
import i18n from '../../i18n/config';

function makeIndexes(): LightIndexes {
  return {
    movies: new Map(),
    series: new Map(),
    live: new Map([
      [1, { id: 1, name: 'TF1', iconPrefixId: 0, iconSuffix: 'tf1.png', categoryId: '10', epgChannelId: 'tf1.fr' }],
      [2, { id: 2, name: 'France 2', iconPrefixId: 0, iconSuffix: 'f2.png', categoryId: '11' }],
    ]),
    categories: new Map([
      ['10', { id: '10', name: 'Généralistes', type: 'live' as const }],
      ['11', { id: '11', name: 'Service public', type: 'live' as const }],
      ['20', { id: '20', name: 'Films', type: 'movie' as const }],
    ]),
    moviesByTmdb: new Map(),
    seriesByTmdb: new Map(),
    iconPrefixes: ['http://provider.test/logos/'],
  };
}

describe('liveTvLists', () => {
  beforeEach(() => hidden.clear());

  it('construit les chaînes et les catégories live du catalogue', () => {
    const lists = liveTvLists(makeIndexes());
    expect(lists.categories.map(c => c.category_id)).toEqual(['10', '11']);
    expect(lists.streams).toHaveLength(2);
    expect(lists.streams[0]).toMatchObject({
      stream_id: 1,
      name: 'TF1',
      stream_type: 'live',
      category_id: '10',
      epg_channel_id: 'tf1.fr',
      stream_icon: 'http://provider.test/logos/tf1.png',
    });
  });

  it('rend les mêmes listes pour le même catalogue (rien reconstruit au zap)', () => {
    const indexes = makeIndexes();
    const first = liveTvLists(indexes);
    expect(liveTvLists(indexes)).toBe(first);
    expect(liveTvLists(indexes).streams).toBe(first.streams);
  });

  it('un catalogue actualisé reçoit ses propres listes', () => {
    expect(liveTvLists(makeIndexes())).not.toBe(liveTvLists(makeIndexes()));
  });

  it('visibleLiveCategories écarte les catégories masquées', () => {
    const indexes = makeIndexes();
    expect(visibleLiveCategories(indexes).map(c => c.category_id)).toEqual(['10', '11']);
    hidden.add('11::live');
    expect(visibleLiveCategories(indexes).map(c => c.category_id)).toEqual(['10']);
    // Le cache complet garde toutes les catégories
    expect(liveTvLists(indexes).categories).toHaveLength(2);
  });

  it('chaîne sans catégorie ou dans une catégorie que le fournisseur ne liste pas : catégorie « Autres », en dernier', async () => {
    await i18n.changeLanguage('fr');
    const indexes = makeIndexes();
    indexes.live.set(3, { id: 3, name: 'Sans catégorie', iconPrefixId: -1, iconSuffix: '', categoryId: '' });
    indexes.live.set(4, { id: 4, name: 'Catégorie inconnue', iconPrefixId: -1, iconSuffix: '', categoryId: '99' });
    // Numéro d'une catégorie de films : pas une catégorie live
    indexes.live.set(5, { id: 5, name: 'Mal rangée', iconPrefixId: -1, iconSuffix: '', categoryId: '20' });
    const lists = liveTvLists(indexes);
    expect(lists.categories.map(c => c.category_id)).toEqual(['10', '11', OTHER_CATEGORY_ID]);
    expect(lists.categories[2].category_name).toBe('Autres');
    expect(lists.streams.filter(s => s.category_id === OTHER_CATEGORY_ID).map(s => s.stream_id)).toEqual([3, 4, 5]);
    expect(lists.streams[0].category_id).toBe('10');
    // Zapping : la chaîne en cours est retrouvée dans « Autres »
    expect(liveCategoryOf(indexes, '')).toBe(OTHER_CATEGORY_ID);
    expect(liveCategoryOf(indexes, '11')).toBe('11');
    expect(visibleLiveCategories(indexes).map(c => c.category_id)).toEqual(['10', '11', OTHER_CATEGORY_ID]);
    // Changement de langue : le nom suit, sans nouveau catalogue
    await i18n.changeLanguage('en');
    expect(liveTvLists(indexes).categories[2].category_name).toBe('Other');
    await i18n.changeLanguage('fr');
  });

  it('toutes les chaînes rangées : pas de catégorie « Autres »', () => {
    expect(liveTvLists(makeIndexes()).categories.map(c => c.category_id)).not.toContain(OTHER_CATEGORY_ID);
  });
});
