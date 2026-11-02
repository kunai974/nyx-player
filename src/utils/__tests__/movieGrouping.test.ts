import { describe, it, expect } from 'vitest';
import { groupByTmdbId } from '../movieGrouping';

describe('movieGrouping', () => {
  describe('groupByTmdbId', () => {
    it('groupe les items par tmdb id', () => {
      const items = [
        { stream_id: 1, name: 'Movie A', tmdb: 123 },
        { stream_id: 2, name: 'Movie A 4K', tmdb: 123 },
        { stream_id: 3, name: 'Movie B', tmdb: 456 },
      ];

      const groups = groupByTmdbId(items);

      expect(groups).toHaveLength(2);
      expect(groups.find((g) => g.groupKey === 'tmdb_123')?.sourceCount).toBe(2);
      expect(groups.find((g) => g.groupKey === 'tmdb_456')?.sourceCount).toBe(1);
    });

    it('gère les tmdb id en string', () => {
      const items = [
        { stream_id: 1, name: 'Movie A', tmdb: '123' },
        { stream_id: 2, name: 'Movie A 4K', tmdb: '123' },
      ];

      const groups = groupByTmdbId(items);

      expect(groups).toHaveLength(1);
      expect(groups[0].sourceCount).toBe(2);
    });

    // Fournisseur qui ne donne aucun numéro TMDB dans ses listes : la recherche ne trouvait rien
    it('garde les items sans tmdb valide sur demande, chacun dans son groupe, dans l\'ordre reçu', () => {
      const items = [
        { stream_id: 1, name: 'Movie A', tmdb: 0 },
        { stream_id: 2, name: 'Movie B', tmdb: undefined },
        { stream_id: 3, name: 'Movie C', tmdb: 123 },
        { stream_id: 4, name: 'Movie C HD', tmdb: '123' },
      ];

      const groups = groupByTmdbId(items, true);

      expect(groups.map((g) => g.groupKey)).toEqual(['item_1', 'item_2', 'tmdb_123']);
      expect(groups[2].sourceCount).toBe(2);
    });

    it('titres légers sans tmdb (id) : un groupe par titre', () => {
      const groups = groupByTmdbId([{ id: 10, tmdbId: 0 }, { id: 11, tmdbId: 0 }], true);
      expect(groups.map((g) => g.groupKey)).toEqual(['item_10', 'item_11']);
    });

    it('sans demande, les items sans tmdb valide restent écartés (catalogue relié à TMDB)', () => {
      const groups = groupByTmdbId([{ id: 10, tmdbId: 0 }, { id: 11, tmdbId: 42 }]);
      expect(groups.map((g) => g.groupKey)).toEqual(['tmdb_42']);
    });

    it('retourne un tableau vide pour un input vide', () => {
      expect(groupByTmdbId([])).toEqual([]);
    });
  });
});
