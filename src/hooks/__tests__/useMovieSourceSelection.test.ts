/**
 * Tests pour useMovieSourceSelection.ts
 *
 * Vérifie : init version sync par langue, version switching, JIT load,
 * displayVersions, persist SQLite, re-sync player.
 *
 * Pattern unifié avec useSeriesSourceSelection.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useMovieSourceSelection } from '../useMovieSourceSelection';
import type { XtreamMovie } from '../../types/xtream';

// Mocks
vi.mock('../../services/playbackProgressService', () => ({
  hasProgress: vi.fn().mockResolvedValue(false),
}));

vi.mock('../../services/contentPreferencesService', () => ({
  getPreferredSource: vi.fn().mockResolvedValue(null),
  setPreferredSource: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../services/watchlistHydration', () => ({
  isInWatchlist: vi.fn().mockResolvedValue(false),
}));

vi.mock('../../i18n/config', () => ({
  default: { language: 'fr' },
}));

// Mock PlayerContext — simule currentlyPlaying
let mockCurrentlyPlaying: unknown = null;
vi.mock('../../contexts/PlayerContext', () => ({
  usePlayer: () => ({ currentlyPlaying: mockCurrentlyPlaying }),
}));

import { getPreferredSource, setPreferredSource } from '../../services/contentPreferencesService';

// Helpers
function makeVersion(id: number, name: string): XtreamMovie {
  return {
    stream_id: id,
    name,
    // Propriétés minimales requises par le type
    stream_type: 'movie',
    container_extension: 'mkv',
  } as unknown as XtreamMovie;
}

describe('useMovieSourceSelection', () => {
  const v1 = makeVersion(100, 'Source A');
  const v2 = makeVersion(200, 'Source B');

  beforeEach(() => {
    vi.clearAllMocks();
    mockCurrentlyPlaying = null;
  });

  // === INIT SYNC ===

  it('initialise avec la première version si une seule', () => {
    const { result } = renderHook(() =>
      useMovieSourceSelection({
        initialVersions: [v1],
        resolvedTmdbId: 42,
      }),
    );

    expect(result.current.selectedVersion).toBe(v1);
    expect(result.current.versions).toHaveLength(1);
  });

  it('retourne null si initialVersions est vide', () => {
    const { result } = renderHook(() =>
      useMovieSourceSelection({
        initialVersions: [],
        resolvedTmdbId: 42,
      }),
    );

    expect(result.current.selectedVersion).toBeNull();
  });

  it('sélection langue SYNC: choisit FR à l\'init avec 2 versions', () => {
    const vEN = makeVersion(100, 'Film XYZ [EN]');
    const vFR = makeVersion(101, 'Film XYZ [FR]');

    const { result } = renderHook(() =>
      useMovieSourceSelection({
        initialVersions: [vEN, vFR],
        resolvedTmdbId: 42,
      }),
    );

    // selectBestSourceIndex avec language='fr' → choisit [FR]
    expect(result.current.selectedVersion).toBe(vFR);
  });

  it('sélection langue SYNC: fallback MULTI si pas de FR', () => {
    const vEN = makeVersion(100, 'Film XYZ [EN]');
    const vMULTI = makeVersion(103, 'Film XYZ MULTI');

    const { result } = renderHook(() =>
      useMovieSourceSelection({
        initialVersions: [vEN, vMULTI],
        resolvedTmdbId: 42,
      }),
    );

    expect(result.current.selectedVersion).toBe(vMULTI);
  });

  // === VERSION SWITCHING ===

  it('handleVersionSelect change la version existante', async () => {
    const { result } = renderHook(() =>
      useMovieSourceSelection({
        initialVersions: [v1, v2],
        resolvedTmdbId: 42,
      }),
    );

    await act(async () => {
      await result.current.handleVersionSelect({ id: 200, name: 'Source B' });
    });

    expect(result.current.selectedVersion).toBe(v2);
  });

  it('handleVersionSelect appelle onLoadVersion pour une version inconnue', async () => {
    const v3 = makeVersion(300, 'Source C');
    const onLoadVersion = vi.fn().mockResolvedValue(v3);

    const { result } = renderHook(() =>
      useMovieSourceSelection({
        initialVersions: [v1],
        resolvedTmdbId: 42,
        onLoadVersion,
      }),
    );

    await act(async () => {
      await result.current.handleVersionSelect({ id: 300, name: 'Source C' });
    });

    expect(onLoadVersion).toHaveBeenCalledWith(300);
    expect(result.current.selectedVersion).toBe(v3);
  });

  // === DISPLAY VERSIONS ===

  it('displayVersions utilise initialVersions directement', () => {
    const { result } = renderHook(() =>
      useMovieSourceSelection({
        initialVersions: [v1, v2],
        resolvedTmdbId: 42,
      }),
    );

    expect(result.current.displayVersions).toEqual([
      { id: 100, name: 'Source A' },
      { id: 200, name: 'Source B' },
    ]);
  });

  // === PERSIST ===

  it('persist appelle setPreferredSource après changement utilisateur', async () => {
    const { result } = renderHook(() =>
      useMovieSourceSelection({
        initialVersions: [v1, v2],
        resolvedTmdbId: 42,
      }),
    );

    await act(async () => {
      await result.current.handleVersionSelect({ id: 200, name: 'Source B' });
    });

    await waitFor(() => {
      expect(setPreferredSource).toHaveBeenCalledWith('movie', 42, 200);
    });
  });

  it('auto-persist: persiste la sélection langue sans changement user', async () => {
    const vEN = makeVersion(100, 'Film XYZ [EN]');
    const vFR = makeVersion(101, 'Film XYZ [FR]');

    renderHook(() =>
      useMovieSourceSelection({
        initialVersions: [vEN, vFR],
        resolvedTmdbId: 42,
      }),
    );

    // Auto-persist au premier mount (sélection FR par langue)
    await waitFor(() => {
      expect(setPreferredSource).toHaveBeenCalledWith('movie', 42, 101);
    });
  });

  it('auto-persist: ne fait rien si cache SQLite existe', async () => {
    vi.mocked(getPreferredSource).mockResolvedValueOnce(999);

    renderHook(() =>
      useMovieSourceSelection({
        initialVersions: [makeVersion(100, 'Film XYZ [EN]'), makeVersion(101, 'Film XYZ [FR]')],
        resolvedTmdbId: 42,
      }),
    );

    await waitFor(() => {
      expect(getPreferredSource).toHaveBeenCalledWith('movie', 42);
    });

    // Pas de persist car cache existe
    expect(setPreferredSource).not.toHaveBeenCalled();
  });

  it('auto-persist: ne fait rien si une seule version', async () => {
    renderHook(() =>
      useMovieSourceSelection({
        initialVersions: [v1],
        resolvedTmdbId: 42,
      }),
    );

    // Pas de persist car une seule version
    expect(setPreferredSource).not.toHaveBeenCalled();
  });

  // Film sans numéro TMDB déjà dans Ma liste : le bouton de la fiche restait sur « + »
  it('watchlist : sans numéro TMDB, état lu par le numéro de source de la première version', async () => {
    const { isInWatchlist } = await import('../../services/watchlistHydration');
    vi.mocked(isInWatchlist).mockResolvedValueOnce(true);
    const { result } = renderHook(() =>
      useMovieSourceSelection({
        initialVersions: [v1],
        resolvedTmdbId: 0,
      }),
    );
    await waitFor(() => {
      expect(result.current.inWatchlist).toBe(true);
    });
    expect(isInWatchlist).toHaveBeenCalledWith(100, 0, 'movie');
  });

  it('watchlist : avec numéro TMDB, état lu par ce numéro', async () => {
    const { isInWatchlist } = await import('../../services/watchlistHydration');
    renderHook(() => useMovieSourceSelection({ initialVersions: [v1], resolvedTmdbId: 42 }));
    await waitFor(() => {
      expect(isInWatchlist).toHaveBeenCalledWith(0, 42, 'movie');
    });
  });
});
