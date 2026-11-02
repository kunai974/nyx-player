/**
 * Bouton Ma liste des cartes (accueil, rangées, rail TV) : un titre sans numéro TMDB passe par le
 * service sous son numéro de source. Avant, le bouton s'affichait chez un fournisseur qui ne relie pas
 * ses titres à TMDB, mais l'appui ne faisait rien.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const toggleWatchlistOrNotify = vi.fn();
vi.mock('../../../services/watchlistActions', () => ({
  toggleWatchlistOrNotify: (...args: unknown[]) => toggleWatchlistOrNotify(...args),
}));

import { cardHasWatchlist, toggleCardWatchlist } from '../cardWatchlist';

describe('toggleCardWatchlist', () => {
  beforeEach(() => {
    toggleWatchlistOrNotify.mockReset();
    toggleWatchlistOrNotify.mockResolvedValue(true);
  });

  it('titre sans numéro TMDB : ajouté sous son numéro de source, nouvel état rendu', async () => {
    const item = { id: 7, title: 'Sans fiche', image: '', mediaType: 'movie' as const, streamId: 7 };
    expect(cardHasWatchlist(item)).toBe(true);
    await expect(toggleCardWatchlist(item)).resolves.toBe(true);
    expect(toggleWatchlistOrNotify).toHaveBeenCalledWith(7, 0, 'movie');
  });

  it('titre avec numéro TMDB : par le service, avec ses deux numéros', async () => {
    const item = { id: 8, title: 'Avec fiche', image: '', mediaType: 'series' as const, streamId: 8, tmdbId: 1399 };
    await toggleCardWatchlist(item);
    expect(toggleWatchlistOrNotify).toHaveBeenCalledWith(8, 1399, 'series');
  });

  it('titre « Introuvable » de Ma liste : son numéro provisoire négatif est gardé', async () => {
    const item = { id: -3, title: 'Introuvable', image: '', mediaType: 'movie' as const, streamId: -3, tmdbId: 42 };
    await toggleCardWatchlist(item);
    expect(toggleWatchlistOrNotify).toHaveBeenCalledWith(-3, 42, 'movie');
  });

  it('carte sans aucun numéro : ancien rappel de la carte, état inconnu', async () => {
    const onAddToList = vi.fn();
    const item = { id: 'x', title: 'Rappel', image: '', onAddToList };
    await expect(toggleCardWatchlist(item)).resolves.toBeNull();
    expect(onAddToList).toHaveBeenCalledTimes(1);
    expect(toggleWatchlistOrNotify).not.toHaveBeenCalled();
  });
});
