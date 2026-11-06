/**
 * Tests pour useTmdbMovie.ts
 *
 * Régression : quand l'API TMDB répond avant MIN_LOADING_DISPLAY_MS, la transition
 * différée vers 'ready' ne doit pas être annulée par le re-render causé par setDetails.
 * Aussi : langue changée pendant un chargement, fiche en cache hors ligne.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { XtreamMovie } from '../../types/xtream';

const details = { id: 42, title: 'Film', images: { backdrops: [] } };

vi.mock('../../services/tmdbApi', () => ({
  default: { getMovieDetails: vi.fn(), searchMovie: vi.fn(async () => ({ results: [] })) },
}));

vi.mock('../../services/tmdbCacheSqlite', () => ({
  getCachedDetails: vi.fn().mockResolvedValue(null),
  cacheMovieDetails: vi.fn().mockResolvedValue(undefined),
}));

let language: 'fr-FR' | 'en-US' = 'fr-FR';
vi.mock('../../utils/tmdbLanguage', () => ({
  getTmdbLanguage: () => language,
}));

import tmdb from '../../services/tmdbApi';
import { getCachedDetails } from '../../services/tmdbCacheSqlite';
import { TMDB_LANGUAGE_EVENT } from '../../services/eventConstants';
import { useTmdbMovie } from '../useTmdbMovie';

/** Promesse résolue quand le test le décide */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const movie = { stream_id: 1, name: 'Film', tmdb: 42 } as unknown as XtreamMovie;

describe('useTmdbMovie', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    language = 'fr-FR';
    vi.mocked(getCachedDetails).mockResolvedValue(null);
  });

  it('passe à ready quand l’API répond plus vite que le délai minimal du squelette', async () => {
    vi.mocked(tmdb.getMovieDetails).mockResolvedValue(details as never);

    const { result } = renderHook(() => useTmdbMovie(movie));

    expect(result.current.loadingState).toBe('loading');
    await waitFor(() => expect(result.current.details).not.toBeNull());
    await waitFor(() => expect(result.current.loadingState).toBe('ready'), { timeout: 2000 });
  });

  it('bascule en fallback sans tmdb_id quand la recherche par titre ne trouve rien', async () => {
    const { result } = renderHook(() => useTmdbMovie({ ...movie, tmdb: 0 } as unknown as XtreamMovie));
    await waitFor(() => expect(result.current.loadingState).toBe('fallback'), { timeout: 2000 });
    expect(tmdb.getMovieDetails).not.toHaveBeenCalled();
  });

  it('bascule en fallback quand l’API échoue', async () => {
    vi.mocked(tmdb.getMovieDetails).mockRejectedValue(new Error('boom'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const { result } = renderHook(() => useTmdbMovie(movie));

    await waitFor(() => expect(result.current.loadingState).toBe('fallback'), { timeout: 2000 });
  });

  it('langue changée pendant le chargement, la fiche est rechargée dans la nouvelle langue', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const first = deferred<unknown>();
    vi.mocked(tmdb.getMovieDetails)
      .mockReturnValueOnce(first.promise as never)
      .mockResolvedValueOnce({ ...details, title: 'Movie' } as never);

    const { result } = renderHook(() => useTmdbMovie(movie));
    await waitFor(() => expect(tmdb.getMovieDetails).toHaveBeenCalledTimes(1));

    // Réglage de la langue changé pendant l'appel : réponse française jetée
    language = 'en-US';
    act(() => { window.dispatchEvent(new Event(TMDB_LANGUAGE_EVENT)); });
    await act(async () => { first.resolve(details); await first.promise; });

    await waitFor(() => expect(result.current.details?.title).toBe('Movie'));
    await waitFor(() => expect(result.current.loadingState).toBe('ready'), { timeout: 2000 });
    expect(tmdb.getMovieDetails).toHaveBeenCalledTimes(2);
  });

  it('hors ligne, la fiche en cache sans photo de fond est affichée au lieu de celle du fournisseur', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(getCachedDetails).mockResolvedValue({ id: 42, title: 'Titre TMDB', overview: 'Résumé', images: { backdrops: [] } });
    vi.mocked(tmdb.getMovieDetails).mockRejectedValue(new Error('hors ligne'));

    const { result } = renderHook(() => useTmdbMovie(movie));

    await waitFor(() => expect(result.current.loadingState).toBe('ready'), { timeout: 2000 });
    expect(result.current.details?.title).toBe('Titre TMDB');
  });

  // Cache TMDB illisible (base occupée ou en cours de fermeture au changement de compte) : la lecture
  // rejetait hors du try, la fiche restait en squelette sans jamais réessayer
  it('cache SQLite illisible : passe par l’API au lieu de rester en squelette', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(getCachedDetails).mockRejectedValue(new Error('database is locked'));
    vi.mocked(tmdb.getMovieDetails).mockResolvedValue(details as never);

    const { result } = renderHook(() => useTmdbMovie(movie));

    await waitFor(() => expect(result.current.loadingState).toBe('ready'), { timeout: 2000 });
    expect(result.current.details).toEqual(details);
  });
});
