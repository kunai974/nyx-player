/**
 * Fiche série TMDB : cache d'abord, appel TMDB sinon, repli sur les
 * données du fournisseur, et rien de mis en cache après un démontage ou un changement de langue.
 *
 * TMDB et le cache SQLite sont simulés ; aucun appel réseau.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { IptvSeries } from '../../types/iptv';

let language: 'fr-FR' | 'en-US' = 'fr-FR';
vi.mock('../../utils/tmdbLanguage', () => ({ getTmdbLanguage: () => language }));
vi.mock('../../services/tmdbApi', () => ({
  default: { getTvDetails: vi.fn(), getSeasonDetailsWithFallback: vi.fn(), searchTv: vi.fn(async () => ({ results: [] })) },
}));
vi.mock('../../services/tmdbCacheSqlite', () => ({
  getCachedDetails: vi.fn(),
  cacheSeriesDetails: vi.fn(),
}));

import tmdb from '../../services/tmdbApi';
import { getCachedDetails, cacheSeriesDetails } from '../../services/tmdbCacheSqlite';
import { TMDB_LANGUAGE_EVENT } from '../../services/eventConstants';
import { useTmdbSeries } from '../useTmdbSeries';

const details = { id: 77, name: 'La Série', number_of_seasons: 2 };
const series = (tmdb_id: number | string) => ({ series_id: 5, name: 'FR| La.Serie', tmdb_id }) as unknown as IptvSeries;

/** Promesse résolue quand le test le décide */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('useTmdbSeries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    language = 'fr-FR';
    vi.mocked(getCachedDetails).mockResolvedValue(null);
    vi.mocked(cacheSeriesDetails).mockResolvedValue(undefined);
    vi.mocked(tmdb.getSeasonDetailsWithFallback).mockResolvedValue({ episodes: [] } as never);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fiche en cache : prête sans appel TMDB', async () => {
    vi.mocked(getCachedDetails).mockResolvedValue(details);

    const { result } = renderHook(() => useTmdbSeries(series(77), 1));

    await waitFor(() => expect(result.current.loadingState).toBe('ready'));
    expect(result.current.details).toEqual(details);
    expect(result.current.tmdbId).toBe(77);
    expect(getCachedDetails).toHaveBeenCalledWith(77, 'series');
    expect(tmdb.getTvDetails).not.toHaveBeenCalled();
    expect(cacheSeriesDetails).not.toHaveBeenCalled();
  });

  it('sans numéro TMDB chez le fournisseur : recherche par titre, rien trouvé = données du fournisseur', async () => {
    const { result } = renderHook(() => useTmdbSeries(series(0), 1));

    await waitFor(() => expect(result.current.loadingState).toBe('fallback'), { timeout: 2000 });
    expect(result.current.tmdbId).toBeNull();
    expect(getCachedDetails).not.toHaveBeenCalled();
    expect(tmdb.getTvDetails).not.toHaveBeenCalled();
  });

  it('cache vide : appel TMDB, fiche mise en cache puis prête', async () => {
    vi.mocked(tmdb.getTvDetails).mockResolvedValue(details as never);

    const { result } = renderHook(() => useTmdbSeries(series('77'), 1));

    await waitFor(() => expect(result.current.details).toEqual(details));
    await waitFor(() => expect(result.current.loadingState).toBe('ready'), { timeout: 2000 });
    expect(tmdb.getTvDetails).toHaveBeenCalledWith(77);
    expect(cacheSeriesDetails).toHaveBeenCalledWith(77, details);
  });

  it('TMDB en échec : repli sur les données du fournisseur, rien mis en cache', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(tmdb.getTvDetails).mockRejectedValue(new Error('réseau coupé'));

    const { result } = renderHook(() => useTmdbSeries(series(77), 1));

    await waitFor(() => expect(result.current.loadingState).toBe('fallback'), { timeout: 2000 });
    expect(result.current.details).toBeNull();
    expect(cacheSeriesDetails).not.toHaveBeenCalled();
  });

  it('fiche fermée avant la réponse : rien mis en cache', async () => {
    const answer = deferred<unknown>();
    vi.mocked(tmdb.getTvDetails).mockReturnValue(answer.promise as never);

    const { unmount } = renderHook(() => useTmdbSeries(series(77), 1));
    await waitFor(() => expect(tmdb.getTvDetails).toHaveBeenCalled());
    unmount();
    answer.resolve(details);
    await answer.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(cacheSeriesDetails).not.toHaveBeenCalled();
  });

  it('langue changée pendant l\'appel : la réponse n\'est pas mise en cache', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const answer = deferred<unknown>();
    vi.mocked(tmdb.getTvDetails).mockReturnValue(answer.promise as never);

    const { result } = renderHook(() => useTmdbSeries(series(77), 1));
    await waitFor(() => expect(tmdb.getTvDetails).toHaveBeenCalled());
    language = 'en-US';
    answer.resolve(details);
    await answer.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(cacheSeriesDetails).not.toHaveBeenCalled();
    expect(result.current.details).toBeNull();
  });

  it('épisodes de la saison choisie rangés par numéro d\'épisode', async () => {
    vi.mocked(getCachedDetails).mockResolvedValue(details);
    vi.mocked(tmdb.getSeasonDetailsWithFallback).mockResolvedValue({
      episodes: [{ episode_number: 1, name: 'Un' }, { episode_number: 3, name: 'Trois' }],
    } as never);

    const { result } = renderHook(() => useTmdbSeries(series(77), 2));

    await waitFor(() => expect(result.current.currentSeasonEpisodes[3]?.name).toBe('Trois'));
    expect(result.current.currentSeasonEpisodes[1]?.name).toBe('Un');
    expect(result.current.isSeasonLoading).toBe(false);
    expect(tmdb.getSeasonDetailsWithFallback).toHaveBeenCalledWith(77, 2);
  });

  it('saison introuvable sur TMDB : aucun épisode TMDB, le fournisseur prend le relais', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(getCachedDetails).mockResolvedValue(details);
    vi.mocked(tmdb.getSeasonDetailsWithFallback).mockRejectedValue(new Error('404'));

    const { result } = renderHook(() => useTmdbSeries(series(77), 9));

    await waitFor(() => expect(tmdb.getSeasonDetailsWithFallback).toHaveBeenCalledWith(77, 9));
    await waitFor(() => expect(result.current.isSeasonLoading).toBe(false));
    expect(result.current.currentSeasonEpisodes).toEqual([]);
  });

  it('langue changée pendant l\'appel, la fiche est redemandée dans la nouvelle langue', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const first = deferred<unknown>();
    vi.mocked(tmdb.getTvDetails)
      .mockReturnValueOnce(first.promise as never)
      .mockResolvedValueOnce({ ...details, name: 'The Series' } as never);

    const { result } = renderHook(() => useTmdbSeries(series(77), 1));
    await waitFor(() => expect(tmdb.getTvDetails).toHaveBeenCalledTimes(1));
    language = 'en-US';
    act(() => { window.dispatchEvent(new Event(TMDB_LANGUAGE_EVENT)); });
    await act(async () => { first.resolve(details); await first.promise; });

    await waitFor(() => expect(result.current.details?.name).toBe('The Series'));
    await waitFor(() => expect(result.current.loadingState).toBe('ready'), { timeout: 2000 });
  });

  it('fiche prête puis langue changée, fiche et épisodes sont rechargés (plus de squelette bloqué)', async () => {
    vi.mocked(getCachedDetails).mockResolvedValueOnce(details).mockResolvedValue(null);
    vi.mocked(tmdb.getTvDetails).mockResolvedValue({ ...details, name: 'The Series' } as never);
    vi.mocked(tmdb.getSeasonDetailsWithFallback).mockResolvedValue({
      episodes: [{ episode_number: 1, name: 'Un' }],
    } as never);

    const { result } = renderHook(() => useTmdbSeries(series(77), 1));
    await waitFor(() => expect(result.current.currentSeasonEpisodes[1]?.name).toBe('Un'));
    expect(result.current.details?.name).toBe('La Série');

    vi.mocked(tmdb.getSeasonDetailsWithFallback).mockResolvedValue({
      episodes: [{ episode_number: 1, name: 'One' }],
    } as never);
    language = 'en-US';
    act(() => { window.dispatchEvent(new Event(TMDB_LANGUAGE_EVENT)); });

    await waitFor(() => expect(result.current.details?.name).toBe('The Series'));
    await waitFor(() => expect(result.current.loadingState).toBe('ready'), { timeout: 2000 });
    await waitFor(() => expect(result.current.currentSeasonEpisodes[1]?.name).toBe('One'));
  });

  it("Saison rendue sans liste d'épisodes, le chargement de la saison se termine (repli fournisseur)", async () => {
    vi.mocked(getCachedDetails).mockResolvedValue(details);
    // Corps d'erreur TMDB rendu en 200 (relais) ou vieil objet du cache : pas de liste d'épisodes
    vi.mocked(tmdb.getSeasonDetailsWithFallback).mockResolvedValue({ success: false, status_code: 34 } as never);

    const { result } = renderHook(() => useTmdbSeries(series(77), 1));

    await waitFor(() => expect(tmdb.getSeasonDetailsWithFallback).toHaveBeenCalledWith(77, 1));
    await waitFor(() => expect(result.current.isSeasonLoading).toBe(false));
    expect(result.current.currentSeasonEpisodes).toEqual([]);
  });
});
