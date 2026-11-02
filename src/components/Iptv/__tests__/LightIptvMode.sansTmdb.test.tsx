/**
 * Accueil Films / Séries d'un fournisseur qui ne donne aucun numéro TMDB (des dizaines de milliers de films
 * et de séries chargés, onglets vides). Ses catégories gardent tous leurs titres, affiches d'abord. Un catalogue
 * avec des numéros TMDB garde l'accueil d'avant (titres avec fiche et affiche seulement).
 */

import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { RailSource } from '../rail/rail';
import type { LightIndexes } from '../../../types/lightIndex';
import { OTHER_CATEGORY_ID, groupItemsByCategory } from '../categoryRows';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }), initReactI18next: { type: '3rdParty', init: () => {} } }));
vi.mock('../IptvMode.css', () => ({}));
vi.mock('../../../services/hiddenCategoriesService', () => ({ isHidden: () => false }));
vi.mock('../../../hooks/useHiddenCategoriesVersion', () => ({ useHiddenCategoriesVersion: () => 0 }));

const railProps = vi.hoisted(() => ({ rows: [] as readonly string[], source: null as RailSource | null }));
vi.mock('../rail/RecycledRail', () => ({
  default: (props: { rows: readonly string[]; source: RailSource }) => {
    railProps.rows = props.rows;
    railProps.source = props.source;
    return null;
  },
}));
vi.mock('../rail/rail', () => ({ isRailOn: () => true }));

import LightIptvMode from '../LightIptvMode';

type Opts = { tmdbId?: number; icon?: boolean };
const film = (id: number, categoryId: string, { tmdbId = 0, icon = true }: Opts = {}) => ({
  id, name: `Film ${id}`, tmdbId, categoryId, iconPrefixId: icon ? 0 : -1, iconSuffix: icon ? `${id}.jpg` : '', added: 0, containerExt: 'mp4',
});

function indexesOf(movies: ReturnType<typeof film>[], series: ReturnType<typeof film>[] = []): LightIndexes {
  const linked = (list: ReturnType<typeof film>[]) => new Map(list.filter((m) => m.tmdbId > 0).map((m) => [m.tmdbId, m]));
  return {
    movies: new Map(movies.map((m) => [m.id, m])),
    series: new Map(series.map((s) => [s.id, s])),
    live: new Map(),
    categories: new Map([
      ['10', { id: '10', name: 'Films FR', type: 'movie' }],
      ['11', { id: '11', name: 'XXX', type: 'movie' }],
      ['20', { id: '20', name: 'Séries FR', type: 'series' }],
    ]),
    moviesByTmdb: linked(movies),
    seriesByTmdb: linked(series),
    iconPrefixes: ['http://fournisseur.example/images/'],
  } as unknown as LightIndexes;
}

const noop = () => {};

describe('Accueil Films / Séries sans numéro TMDB', () => {
  it('films sans numéro TMDB : la catégorie s\'affiche avec tous ses titres, affiches d\'abord', () => {
    const lightIndexes = indexesOf([film(1, '10'), film(2, '10', { icon: false }), film(3, '10')]);
    const { container } = render(<LightIptvMode type="movies" lightIndexes={lightIndexes} onItemClick={noop} onSeeAll={noop} />);
    expect(container.textContent).not.toContain('no_categories_available');
    expect(railProps.rows).toEqual(['10']);
    expect(railProps.source!('10')!.items.map((item) => item.title)).toEqual(['Film 1', 'Film 3', 'Film 2']);
  });

  it('séries sans numéro TMDB : même chose', () => {
    const lightIndexes = indexesOf([], [film(5, '20')]);
    render(<LightIptvMode type="series" lightIndexes={lightIndexes} onItemClick={noop} onSeeAll={noop} />);
    expect(railProps.rows).toEqual(['20']);
    expect(railProps.source!('20')!.items.map((item) => item.title)).toEqual(['Film 5']);
  });

  it('sans numéro TMDB, « Voir tout » après les 10 premiers titres', () => {
    const movies = Array.from({ length: 12 }, (_, i) => film(100 + i, '10'));
    render(<LightIptvMode type="movies" lightIndexes={indexesOf(movies)} onItemClick={noop} onSeeAll={noop} />);
    const items = railProps.source!('10')!.items;
    expect(items).toHaveLength(11);
    expect(items[10].isActionButton).toBe(true);
  });

  it('titres rangés dans une catégorie que le fournisseur ne liste pas : rangée « Autres » en dernier', () => {
    const movies = [film(1, '10', { tmdbId: 101 }), film(2, '99', { tmdbId: 102 }), film(3, '', { tmdbId: 103 })];
    render(<LightIptvMode type="movies" lightIndexes={indexesOf(movies)} onItemClick={noop} onSeeAll={noop} />);
    expect(railProps.rows).toEqual(['10', OTHER_CATEGORY_ID]);
    const other = railProps.source!(OTHER_CATEGORY_ID)!;
    expect(other.title).toBe('other_category');
    expect(other.items.map((item) => item.title)).toEqual(['Film 2', 'Film 3']);
  });

  it('catalogue avec des numéros TMDB : accueil inchangé (catégorie sans fiche TMDB cachée)', () => {
    const movies = [film(1, '10', { tmdbId: 101 }), film(2, '10'), film(3, '10', { tmdbId: 103, icon: false }), film(4, '11')];
    render(<LightIptvMode type="movies" lightIndexes={indexesOf(movies)} onItemClick={noop} onSeeAll={noop} />);
    expect(railProps.rows).toEqual(['10']);
    expect(railProps.source!('10')!.items.map((item) => item.title)).toEqual(['Film 1']);
  });
});

describe('groupItemsByCategory', () => {
  const items = [
    film(1, 'a'),
    film(2, 'a', { icon: false }),
    film(3, 'a', { tmdbId: 30 }),
    film(4, 'b', { tmdbId: 40, icon: false }),
    film(5, 'a', { tmdbId: 50 }),
    film(6, 'c'),
  ];

  it('catalogue sans TMDB : tous les titres, affiches d\'abord, ordre du fournisseur', () => {
    const grouped = groupItemsByCategory(items, false, new Set(['a', 'b', 'c']));
    expect(grouped.get('a')!.map((item) => item.id)).toEqual([1, 3, 5, 2]);
    expect(grouped.get('b')!.map((item) => item.id)).toEqual([4]);
    expect(grouped.get('c')!.map((item) => item.id)).toEqual([6]);
  });

  it('catégorie que le fournisseur ne liste pas, ou aucune : rangée « Autres »', () => {
    const grouped = groupItemsByCategory([...items, film(7, ''), film(8, 'z', { tmdbId: 80 })], false, new Set(['a', 'b']));
    expect(grouped.get(OTHER_CATEGORY_ID)!.map((item) => item.id)).toEqual([6, 7, 8]);
    expect(grouped.has('c')).toBe(false);
  });

  it('catalogue avec TMDB : seulement fiche TMDB et affiche, comme avant', () => {
    const grouped = groupItemsByCategory(items, true, new Set(['a', 'b', 'c']));
    expect(grouped.get('a')!.map((item) => item.id)).toEqual([3, 5]);
    expect(grouped.has('b')).toBe(false);
    expect(grouped.has('c')).toBe(false);
  });
});
