import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { getCacheStats, clearCacheByType } from '../services/tmdbCacheSqlite';
import { clearProgressByType } from '../services/playbackProgressService';
import { performFullReset, CloudPurgeError } from '../services/fullResetService';
import type { ResetOptions } from '../types/common';
import { warnOnReject } from '../utils/warnOnReject';
import { showAppNotice } from '../utils/appNotice';

// ============================================================================
// TYPES
// ============================================================================
interface CacheStats {
  movies: number;
  tv: number;
  movieDetails: number;
  tvDetails: number;
}

interface CacheSize {
  bytes: number;
  formatted: string;
}

// ============================================================================
// HOOK
// ============================================================================
export function useSettingsData() {
  const { t } = useTranslation('settings');

  // Cache stats
  const [cacheStats, setCacheStats] = useState<CacheStats>({ movies: 0, tv: 0, movieDetails: 0, tvDetails: 0 });
  const [cacheSize, setCacheSize] = useState<CacheSize>({ bytes: 0, formatted: '0 Ko' });
  const [cacheCleared, _setCacheCleared] = useState(false);

  // Reset modal state
  const [resetModal, setResetModal] = useState<{
    isOpen: boolean;
    type: 'movies' | 'series';
  }>({ isOpen: false, type: 'movies' });
  const [showFullResetModal, setShowFullResetModal] = useState(false);
  const [purgeCloud, setPurgeCloud] = useState(false);
  const [resetSuccess, setResetSuccess] = useState<string | null>(null);
  // Remise à zéro arrêtée : purge du cloud en échec
  const [resetError, setResetError] = useState<string | null>(null);
  // Ref to clear the reset success timer on unmount (prevents memory leak)
  const resetSuccessTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Shared helper: refresh cache stats from SQLite
  const refreshCacheStats = useCallback(async () => {
    const stats = await getCacheStats();
    setCacheStats({
      movies: stats.movies,
      tv: stats.series,
      movieDetails: stats.movies,
      tvDetails: stats.series + stats.seasons,
    });
    setCacheSize({
      bytes: stats.total * 1000,
      formatted: `${stats.total} entrées`,
    });
  }, []);

  // Load stats on mount
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- statistiques lues dans SQLite (asynchrone) : l'état n'est modifié qu'après réponse
    refreshCacheStats().catch(warnOnReject('SettingsData'));
  }, [refreshCacheStats]);

  // =========== HANDLERS ===========
  const handleFullResetClick = useCallback(() => {
    setShowFullResetModal(true);
  }, []);

  const executeFullReset = useCallback(async () => {
    setShowFullResetModal(false);
    setResetError(null);
    try {
      await performFullReset({ purgeCloud });
      // ↑ performFullReset() finit par la relance de l'app (appRestart.ts).
    } catch (err) {
      // Purge du cloud incomplète : rien n'a été effacé sur l'appareil, l'utilisateur est prévenu
      if (err instanceof CloudPurgeError) {
        setResetError(t(err.reason === 'no-session' ? 'reset_cloud_purge_no_session' : 'reset_cloud_purge_failed'));
        return;
      }
      throw err;
    }
  }, [purgeCloud, t]);

  const dismissResetError = useCallback(() => {
    setResetError(null);
  }, []);

  const openResetModal = useCallback((type: 'movies' | 'series') => {
    setResetModal({ isOpen: true, type });
  }, []);

  const handleResetConfirm = useCallback(async (options: ResetOptions) => {
    const type = resetModal.type;
    let count = 0;

    if (options.positions) {
      const targetType = type === 'movies' ? 'movie' : 'episode';
      try {
        count = await clearProgressByType(targetType as 'movie' | 'episode');
      } catch {
        // Base occupée : pas de message de réussite trompeur, la fenêtre reste ouverte pour réessayer.
        showAppNotice('progress_reset_failed');
        return;
      }
    }

    if (options.cache) {
      await clearCacheByType(type);
      await refreshCacheStats();
    }

    setResetModal({ isOpen: false, type: 'movies' });
    const successKey = type === 'movies' ? 'reset_movies_success' : 'reset_series_success';
    setResetSuccess(t(successKey, { count }));
    // Clear any pending timer before setting a new one
    if (resetSuccessTimerRef.current) clearTimeout(resetSuccessTimerRef.current);
    resetSuccessTimerRef.current = setTimeout(() => {
      resetSuccessTimerRef.current = null;
      setResetSuccess(null);
    }, 3000);
  }, [resetModal.type, refreshCacheStats, t]);

  const closeResetModal = useCallback(() => {
    setResetModal({ isOpen: false, type: 'movies' });
  }, []);

  const closeFullResetModal = useCallback(() => {
    setShowFullResetModal(false);
    setPurgeCloud(false);
  }, []);

  // Cleanup reset success timer on unmount
  useEffect(() => {
    return () => {
      if (resetSuccessTimerRef.current) {
        clearTimeout(resetSuccessTimerRef.current);
      }
    };
  }, []);

  return {
    cacheStats,
    cacheSize,
    cacheCleared,
    resetModal,
    showFullResetModal,
    purgeCloud,
    setPurgeCloud,
    resetSuccess,
    resetError,
    dismissResetError,
    handleFullResetClick,
    executeFullReset,
    openResetModal,
    handleResetConfirm,
    closeResetModal,
    closeFullResetModal,
  };
}
