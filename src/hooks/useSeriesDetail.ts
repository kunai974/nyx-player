import { useState, useEffect } from 'react';
import type { XtreamEpisode, AppSeriesInfo } from '../types/xtream';
import { XtreamApiService } from '../services/xtreamApi';
import { StorageService } from '../services/storage';
import { getM3uSeriesEpisodes } from '../services/m3uCatalog';
import {
  getProgressByStreamIds,
  EpisodeProgressInfo,
} from '../services/playbackProgressService';
import {
  getLastSeason,
  setLastSeason,
} from '../services/contentPreferencesService';
import { PLAYBACK_EVENT } from '../services/eventConstants';
import { warnOnReject } from '../utils/warnOnReject';
import { createLogger } from '../utils/logger';

const log = createLogger('useSeriesDetail');

interface UseSeriesDetailParams {
  series: AppSeriesInfo;
}

/**
 * Hook regroupant le chargement des données série :
 * - Episodes (Xtream API async)
 * - Season state (restore SQLite + update)
 * - Progress batch (SQLite + events)
 */
export function useSeriesDetail({ series }: UseSeriesDetailParams) {
  // =========================================================================
  // EPISODE LOADING
  // =========================================================================
  const [localEpisodes, setLocalEpisodes] = useState<Record<string, XtreamEpisode[]> | null>(
    series.episodes || null,
  );
  const [isEpisodesLoading, setIsEpisodesLoading] = useState(!series.episodes);

  useEffect(() => {
    if (series.episodes) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- épisodes fournis par la fiche : pas de chargement chez le fournisseur
      setLocalEpisodes(series.episodes);
      setIsEpisodesLoading(false);
      return;
    }

    let mounted = true;

    const loadEpisodes = async () => {
      try {
        // Série venue d'une liste M3U : ses épisodes sont dans le catalogue, rien à demander au fournisseur
        const m3uEpisodes = await getM3uSeriesEpisodes(Number(series.series_id));
        if (m3uEpisodes) {
          if (mounted) setLocalEpisodes(m3uEpisodes);
          return;
        }

        const creds = await StorageService.getCredentials();
        if (!creds) {
          setIsEpisodesLoading(false);
          return;
        }

        const api = new XtreamApiService(creds);
        const details = await api.getSeriesInfo(series.series_id);

        if (mounted && details) {
          setLocalEpisodes(details.episodes as Record<string, XtreamEpisode[]>);
        }
      } catch (e) {
        log.error('Failed to load episodes:', e);
        // Set empty object to exit skeleton state — UI will show "no episodes"
        // instead of infinite loading spinner.
        if (mounted) setLocalEpisodes({});
      } finally {
        if (mounted) setIsEpisodesLoading(false);
      }
    };

    void loadEpisodes();
    return () => { mounted = false; };
  }, [series.series_id, series.episodes, series.xtreamInfo]);

  // =========================================================================
  // SEASON STATE
  // =========================================================================
  const [selectedSeason, setSelectedSeason] = useState<number>(() => {
    const eps = series.episodes || localEpisodes;
    if (eps) {
      const seasons = Object.keys(eps).map(Number).sort((a, b) => a - b);
      if (seasons.length > 0) return seasons[0];
    }
    return 1;
  });

  // Restore from SQLite
  useEffect(() => {
    const identifier = series.tmdb
      ? `tmdb_${series.tmdb}`
      : String(series.series_id);
    getLastSeason(identifier).then(saved => {
      if (saved !== null && saved > 0) {
        setSelectedSeason(saved);
      }
    }).catch(warnOnReject('SeriesDetail'));
  }, [series.tmdb, series.series_id]);

  // Update when episodes arrive
  useEffect(() => {
    if (localEpisodes && !series.episodes) {
      const seasons = Object.keys(localEpisodes).map(Number).sort((a, b) => a - b);
      if (seasons.length > 0 && !seasons.includes(selectedSeason)) {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- saison retenue absente des épisodes arrivés : retour à la première
        setSelectedSeason(seasons[0]);
      }
    }
  }, [localEpisodes, series.episodes, selectedSeason]);

  /** Persist season change to SQLite */
  const handleSeasonChange = (num: number) => {
    setSelectedSeason(num);
    const identifier = series.tmdb
      ? `tmdb_${series.tmdb}`
      : String(series.series_id);
    void setLastSeason(identifier, num);
  };

  // =========================================================================
  // PROGRESS MANAGEMENT
  // =========================================================================
  const [episodeProgress, setEpisodeProgress] = useState<Map<number, EpisodeProgressInfo>>(new Map());
  const [resetKey, setResetKey] = useState(0);

  useEffect(() => {
    let cancelled = false;

    const loadProgress = async () => {
      const episodes = localEpisodes?.[selectedSeason] || [];
      if (episodes.length === 0) return;

      const streamIds = episodes
        .map(ep => ep.id)
        .filter(Boolean)
        .map(id => Number(id));

      if (streamIds.length > 0) {
        const progressMap = await getProgressByStreamIds(streamIds);
        if (!cancelled) {
          setEpisodeProgress(progressMap);
        }
      }
    };

    loadProgress().catch(warnOnReject('SeriesDetail'));

    const handleProgressUpdate = () => {
      if (!cancelled) loadProgress().catch(warnOnReject('SeriesDetail'));
    };
    window.addEventListener(PLAYBACK_EVENT, handleProgressUpdate);

    return () => {
      cancelled = true;
      window.removeEventListener(PLAYBACK_EVENT, handleProgressUpdate);
    };
  }, [localEpisodes, selectedSeason, resetKey]);

  return {
    localEpisodes,
    isEpisodesLoading,
    selectedSeason,
    setSelectedSeason: handleSeasonChange,
    episodeProgress,
    resetKey,
    setResetKey,
  };
}
