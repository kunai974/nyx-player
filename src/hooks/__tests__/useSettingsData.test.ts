/**
 * Tests pour useSettingsData.ts
 * Vérifie : statistiques du cache, remises à zéro films/séries, remise à zéro complète.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { count?: number }) => (opts?.count !== undefined ? `${key}:${opts.count}` : key),
  }),
}));

vi.mock('../../services/tmdbCacheSqlite', () => ({
  getCacheStats: vi.fn(),
  clearCacheByType: vi.fn(),
}));

vi.mock('../../utils/appNotice', () => ({ showAppNotice: vi.fn() }));
vi.mock('../../services/playbackProgressService', () => ({
  clearProgressByType: vi.fn(),
}));

vi.mock('../../services/fullResetService', () => {
  class CloudPurgeError extends Error {
    reason: 'failed' | 'no-session';
    constructor(_tables: string[], reason: 'failed' | 'no-session' = 'failed') {
      super('purge');
      this.reason = reason;
    }
  }
  return { performFullReset: vi.fn(), CloudPurgeError };
});

import { useSettingsData } from '../useSettingsData';
import { getCacheStats, clearCacheByType } from '../../services/tmdbCacheSqlite';
import { showAppNotice } from '../../utils/appNotice';
import { clearProgressByType } from '../../services/playbackProgressService';
import { performFullReset, CloudPurgeError } from '../../services/fullResetService';

const STATS = { movies: 10, series: 4, seasons: 6, total: 20 };

describe('useSettingsData', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCacheStats).mockResolvedValue(STATS as never);
    vi.mocked(clearProgressByType).mockResolvedValue(3);
    vi.mocked(clearCacheByType).mockResolvedValue(undefined as never);
    vi.mocked(performFullReset).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Statistiques du cache', () => {
    // Défaut connu, correction à venir : '20 entrées' et '0 Ko' sont écrits en dur
    // en français dans useSettingsData.ts (lignes 32 et 58), hors i18n.
    it('affiche les statistiques lues au chargement', async () => {
      const { result } = renderHook(() => useSettingsData());
      await waitFor(() => expect(result.current.cacheSize.formatted).toBe('20 entrées'));
      expect(result.current.cacheStats).toEqual({ movies: 10, tv: 4, movieDetails: 10, tvDetails: 10 });
    });

    it('garde l\'affichage lu quand une lecture suivante échoue', async () => {
      const { result } = renderHook(() => useSettingsData());
      await waitFor(() => expect(result.current.cacheSize.formatted).toBe('20 entrées'));
      vi.mocked(getCacheStats).mockRejectedValue(new Error('base indisponible'));
      act(() => result.current.openResetModal('movies'));
      await act(async () => {
        await result.current.handleResetConfirm({ positions: false, cache: true }).catch(() => undefined);
      });
      expect(getCacheStats).toHaveBeenCalledTimes(2);
      expect(result.current.cacheSize.formatted).toBe('20 entrées');
      expect(result.current.cacheStats.movies).toBe(10);
    });
  });

  describe('Remise à zéro des films ou des séries', () => {
    it('ouvre puis ferme la fenêtre de remise à zéro', async () => {
      const { result } = renderHook(() => useSettingsData());
      await waitFor(() => expect(getCacheStats).toHaveBeenCalled());
      act(() => result.current.openResetModal('series'));
      expect(result.current.resetModal).toEqual({ isOpen: true, type: 'series' });
      act(() => result.current.closeResetModal());
      expect(result.current.resetModal.isOpen).toBe(false);
    });

    it('base occupée : message d\'erreur, pas de « réussite » et la fenêtre reste ouverte', async () => {
      vi.mocked(clearProgressByType).mockRejectedValue(new Error('database is locked'));
      const { result } = renderHook(() => useSettingsData());
      await waitFor(() => expect(getCacheStats).toHaveBeenCalled());
      act(() => result.current.openResetModal('movies'));
      await act(async () => {
        await result.current.handleResetConfirm({ positions: true, cache: false });
      });
      expect(showAppNotice).toHaveBeenCalledWith('progress_reset_failed');
      expect(result.current.resetSuccess).toBeNull();
      expect(result.current.resetModal.isOpen).toBe(true);
    });

    it('efface les positions des films et affiche le résultat puis le masque après 3 secondes', async () => {
      const { result } = renderHook(() => useSettingsData());
      await waitFor(() => expect(getCacheStats).toHaveBeenCalled());
      vi.useFakeTimers();
      act(() => result.current.openResetModal('movies'));
      await act(async () => {
        await result.current.handleResetConfirm({ positions: true, cache: false });
      });
      expect(clearProgressByType).toHaveBeenCalledWith('movie');
      expect(clearCacheByType).not.toHaveBeenCalled();
      expect(result.current.resetModal.isOpen).toBe(false);
      expect(result.current.resetSuccess).toBe('reset_movies_success:3');
      act(() => {
        vi.advanceTimersByTime(3000);
      });
      expect(result.current.resetSuccess).toBeNull();
    });

    it('efface les positions des épisodes, vide le cache des séries et relit les statistiques', async () => {
      const { result } = renderHook(() => useSettingsData());
      await waitFor(() => expect(getCacheStats).toHaveBeenCalledTimes(1));
      act(() => result.current.openResetModal('series'));
      await act(async () => {
        await result.current.handleResetConfirm({ positions: true, cache: true });
      });
      expect(clearProgressByType).toHaveBeenCalledWith('episode');
      expect(clearCacheByType).toHaveBeenCalledWith('series');
      expect(getCacheStats).toHaveBeenCalledTimes(2);
      expect(result.current.resetSuccess).toBe('reset_series_success:3');
    });

    it('n\'efface rien quand aucune option n\'est cochée', async () => {
      const { result } = renderHook(() => useSettingsData());
      await waitFor(() => expect(getCacheStats).toHaveBeenCalled());
      act(() => result.current.openResetModal('movies'));
      await act(async () => {
        await result.current.handleResetConfirm({ positions: false, cache: false });
      });
      expect(clearProgressByType).not.toHaveBeenCalled();
      expect(clearCacheByType).not.toHaveBeenCalled();
      expect(result.current.resetSuccess).toBe('reset_movies_success:0');
    });

    it('ne laisse pas de minuterie active après le démontage', async () => {
      const { result, unmount } = renderHook(() => useSettingsData());
      await waitFor(() => expect(getCacheStats).toHaveBeenCalled());
      vi.useFakeTimers();
      await act(async () => {
        await result.current.handleResetConfirm({ positions: false, cache: false });
      });
      unmount();
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe('Remise à zéro complète', () => {
    it('ouvre la fenêtre, puis la referme en décochant la purge du cloud', async () => {
      const { result } = renderHook(() => useSettingsData());
      await waitFor(() => expect(getCacheStats).toHaveBeenCalled());
      act(() => result.current.handleFullResetClick());
      act(() => result.current.setPurgeCloud(true));
      expect(result.current.showFullResetModal).toBe(true);
      act(() => result.current.closeFullResetModal());
      expect(result.current.showFullResetModal).toBe(false);
      expect(result.current.purgeCloud).toBe(false);
    });

    it('lance la remise à zéro locale seule par défaut', async () => {
      const { result } = renderHook(() => useSettingsData());
      await waitFor(() => expect(getCacheStats).toHaveBeenCalled());
      act(() => result.current.handleFullResetClick());
      await act(async () => {
        await result.current.executeFullReset();
      });
      expect(performFullReset).toHaveBeenCalledWith({ purgeCloud: false });
      expect(result.current.showFullResetModal).toBe(false);
    });

    it('demande aussi la purge du cloud quand elle est cochée', async () => {
      const { result } = renderHook(() => useSettingsData());
      await waitFor(() => expect(getCacheStats).toHaveBeenCalled());
      act(() => result.current.setPurgeCloud(true));
      await act(async () => {
        await result.current.executeFullReset();
      });
      expect(performFullReset).toHaveBeenCalledWith({ purgeCloud: true });
    });

    it('prévient l\'utilisateur quand la purge du cloud échoue, puis efface le message', async () => {
      vi.mocked(performFullReset).mockRejectedValue(new CloudPurgeError(['t'], 'failed'));
      const { result } = renderHook(() => useSettingsData());
      await waitFor(() => expect(getCacheStats).toHaveBeenCalled());
      await act(async () => {
        await result.current.executeFullReset();
      });
      expect(result.current.resetError).toBe('reset_cloud_purge_failed');
      act(() => result.current.dismissResetError());
      expect(result.current.resetError).toBeNull();
    });

    it('explique l\'absence de session quand la purge du cloud est impossible', async () => {
      vi.mocked(performFullReset).mockRejectedValue(new CloudPurgeError([], 'no-session'));
      const { result } = renderHook(() => useSettingsData());
      await waitFor(() => expect(getCacheStats).toHaveBeenCalled());
      await act(async () => {
        await result.current.executeFullReset();
      });
      expect(result.current.resetError).toBe('reset_cloud_purge_no_session');
    });

    // Défaut connu, correction à venir : SettingsPage appelle executeFullReset avec
    // `void` ; l'erreur imprévue remonte donc en promesse rejetée non traitée, fenêtre fermée, sans message.
    it('laisse remonter une erreur inattendue (comportement actuel)', async () => {
      vi.mocked(performFullReset).mockRejectedValue(new Error('imprévu'));
      const { result } = renderHook(() => useSettingsData());
      await waitFor(() => expect(getCacheStats).toHaveBeenCalled());
      await expect(act(async () => {
        await result.current.executeFullReset();
      })).rejects.toThrow('imprévu');
    });

    // Défaut connu : le bon comportement est un message d'erreur, sans rejet.
    it.fails('affiche un message d\'erreur au lieu de rejeter sur une erreur inattendue', async () => {
      vi.mocked(performFullReset).mockRejectedValue(new Error('imprévu'));
      const { result } = renderHook(() => useSettingsData());
      await waitFor(() => expect(getCacheStats).toHaveBeenCalled());
      await act(async () => {
        await result.current.executeFullReset();
      });
      expect(result.current.resetError).not.toBeNull();
    });
  });
});
