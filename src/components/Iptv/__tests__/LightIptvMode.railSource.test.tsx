/**
 * Accueil Films / Séries sur le rail TV : une catégorie dont rien n'a changé garde ses données d'une version de la source
 * à l'autre, pour que le rail ne remplisse de nouveau que les rangées qui ont changé.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import type { RailSource } from '../rail/rail';
import type { LightIndexes } from '../../../types/lightIndex';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }), initReactI18next: { type: '3rdParty', init: () => {} } }));
vi.mock('../IptvMode.css', () => ({}));

const hidden = vi.hoisted(() => ({ ids: new Set<string>(), version: 0 }));
vi.mock('../../../services/hiddenCategoriesService', () => ({ isHidden: (id: string) => hidden.ids.has(id) }));
vi.mock('../../../hooks/useHiddenCategoriesVersion', () => ({ useHiddenCategoriesVersion: () => hidden.version }));

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

const movie = (id: number, categoryId: string) => ({ id, name: `Film ${id}`, tmdbId: id, categoryId, iconPrefixId: 0, iconSuffix: `${id}.jpg` });
const indexes = {
  movies: new Map([[1, movie(1, 'a')], [2, movie(2, 'b')], [3, movie(3, 'c')]]),
  series: new Map(),
  categories: new Map([
    ['a', { id: 'a', name: 'Action', type: 'movie' }],
    ['b', { id: 'b', name: 'Comédie', type: 'movie' }],
    ['c', { id: 'c', name: 'Drame', type: 'movie' }],
  ]),
  moviesByTmdb: new Map([[1, movie(1, 'a')]]),
  seriesByTmdb: new Map(),
  iconPrefixes: ['https://image.tmdb.org/t/p/w342/'],
} as unknown as LightIndexes;

afterEach(() => {
  hidden.ids.clear();
  hidden.version = 0;
});

describe('LightIptvMode sur le rail', () => {
  it('une catégorie masquée par la synchro : les autres gardent leurs données, sans être remplies de nouveau', () => {
    const props = { type: 'movies' as const, lightIndexes: indexes, onItemClick: () => {}, onSeeAll: () => {} };
    const { rerender } = render(<LightIptvMode {...props} />);
    expect(railProps.rows).toEqual(['a', 'b', 'c']);
    const first = railProps.source!;
    const action = first('a');
    const drame = first('c');
    expect(action!.items.map((item) => item.title)).toEqual(['Film 1']);

    hidden.ids.add('b');
    hidden.version += 1;
    // La page recrée ses rappels à chaque rendu : sans effet sur les données des rangées
    rerender(<LightIptvMode {...props} onItemClick={() => {}} onSeeAll={() => {}} />);
    expect(railProps.rows).toEqual(['a', 'c']);
    expect(railProps.source).not.toBe(first);
    expect(railProps.source!('a')).toBe(action);
    expect(railProps.source!('c')).toBe(drame);
    expect(railProps.source!('b')).toBeNull();
  });

  it('catalogue relu : les rangées reçoivent de nouvelles données', () => {
    const props = { type: 'movies' as const, lightIndexes: indexes, onItemClick: () => {}, onSeeAll: () => {} };
    const { rerender } = render(<LightIptvMode {...props} />);
    const action = railProps.source!('a');
    const relu = { ...indexes, movies: new Map(indexes.movies) } as LightIndexes;
    rerender(<LightIptvMode {...props} lightIndexes={relu} />);
    expect(railProps.source!('a')).not.toBe(action);
    expect(railProps.source!('a')!.title).toBe('Action');
  });
});
