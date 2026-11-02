import { useState, useEffect, useRef, useMemo } from 'react';
import type { XtreamMovie } from '../types/xtream';
import { hasProgress } from '../services/playbackProgressService';
import { getPreferredSource, setPreferredSource } from '../services/contentPreferencesService';
import { isInWatchlist } from '../services/watchlistHydration';
import { selectBestSourceIndex } from '../utils/sourceLanguageSelector';
import { usePlayer } from '../contexts/PlayerContext';
import { getAppLanguage } from '../utils/tmdbLanguage';
import { warnOnReject } from '../utils/warnOnReject';

interface UseMovieSourceSelectionParams {
  initialVersions: XtreamMovie[];
  resolvedTmdbId: number;
  onLoadVersion?: (streamId: number) => Promise<XtreamMovie | null>;
}

/**
 * Hook de gestion de la source sélectionnée pour MovieDetailPage.
 *
 * Pattern unifié avec useSeriesSourceSelection :
 * - Init SYNC par langue (selectBestSourceIndex sur initialVersions)
 * - Auto-persist de la sélection langue au premier mount
 * - Re-sync au retour du player (prevPlayingRef)
 * - Versions memo + displayVersions
 * - Watchlist state + sync depuis SQLite
 * - Progress state + sync au changement de version
 * - Source dropdown state + click-outside
 * - Persist preferred source vers SQLite
 * - handleVersionSelect callback pour SourceSelector
 */
export function useMovieSourceSelection({
  initialVersions,
  resolvedTmdbId,
  onLoadVersion,
}: UseMovieSourceSelectionParams) {
  // 1. Versions memo
  const versions = useMemo<XtreamMovie[]>(() => {
    return initialVersions;
  }, [initialVersions]);

  // 2. Selected version — init SYNC par langue (pattern série)
  const [selectedVersion, setSelectedVersion] = useState<XtreamMovie | null>(() => {
    if (initialVersions.length === 0) return null;
    if (initialVersions.length === 1) return initialVersions[0];
    const bestIndex = selectBestSourceIndex(
      initialVersions.map(v => v.name),
      getAppLanguage(),
    );
    return initialVersions[bestIndex] || initialVersions[0];
  });

  // 2b. Refs
  const hasUserChangedSource = useRef(false);

  // 2c. Auto-persist language-based selection (first visit only)
  useEffect(() => {
    if (
      resolvedTmdbId <= 0 ||
      hasUserChangedSource.current ||
      initialVersions.length <= 1
    ) return;

    getPreferredSource('movie', resolvedTmdbId).then(existing => {
      if (existing === null && selectedVersion) {
        void setPreferredSource('movie', resolvedTmdbId, Number(selectedVersion.stream_id));
      }
    }).catch(warnOnReject('MovieSource'));
    // Mount-only: auto-persist language-based selection on first visit.
    // Deps intentionally omitted (resolvedTmdbId, selectedVersion, initialVersions.length)
    // to avoid re-running on subsequent state changes.
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- au premier affichage seulement, voir ci-dessus

  // 2d. Re-sync au retour du player (pattern série — prevPlayingRef)
  const { currentlyPlaying } = usePlayer();
  const prevPlayingRef = useRef(currentlyPlaying);

  useEffect(() => {
    const wasPlaying = prevPlayingRef.current;
    prevPlayingRef.current = currentlyPlaying;

    const playerJustClosed = wasPlaying !== null && currentlyPlaying === null;
    if (!playerJustClosed && hasUserChangedSource.current) return;

    if (resolvedTmdbId <= 0) return;

    getPreferredSource('movie', resolvedTmdbId).then(async (savedId) => {
      if (savedId === null) return;
      if (selectedVersion && Number(selectedVersion.stream_id) === savedId) return;

      const found = versions.find(v => Number(v.stream_id) === savedId);
      if (found && onLoadVersion) {
        const loaded = await onLoadVersion(Number(found.stream_id));
        if (loaded) {
          setSelectedVersion(loaded);
        }
      } else if (found) {
        setSelectedVersion(found);
      }
    }).catch(warnOnReject('MovieSource'));
    // Re-sync on player close or first mount only.
    // Deps intentionally limited to resolvedTmdbId + currentlyPlaying.
    // selectedVersion/versions/onLoadVersion are read but not tracked to avoid loops.
  }, [resolvedTmdbId, currentlyPlaying]); // eslint-disable-line react-hooks/exhaustive-deps -- au retour du lecteur seulement ; suivre la version choisie bouclerait

  // 3. Watchlist (async from SQLite)
  const [inWatchlist, setInWatchlist] = useState(false);

  // Sans numéro TMDB, le film est rangé sous le numéro de source de sa première version (celui que le
  // bouton de la fiche enregistre) : sinon le bouton restait sur « + » pour un film déjà dans Ma liste.
  const firstStreamId = Number(initialVersions[0]?.stream_id) || 0;
  useEffect(() => {
    if (resolvedTmdbId > 0 || firstStreamId > 0) {
      isInWatchlist(resolvedTmdbId > 0 ? 0 : firstStreamId, resolvedTmdbId, 'movie')
        .then(setInWatchlist).catch(warnOnReject('MovieSource'));
    }
  }, [resolvedTmdbId, firstStreamId]);

  // 4. Progress state (async — re-checked on source change + player close)
  const [hasMovieProgress, setHasMovieProgress] = useState(false);

  useEffect(() => {
    if (!selectedVersion) return;
    hasProgress(selectedVersion.stream_id).then(setHasMovieProgress).catch(warnOnReject('MovieSource'));
  }, [selectedVersion, currentlyPlaying]);



  // 6. Persist preferred source (user change only)
  useEffect(() => {
    if (selectedVersion && resolvedTmdbId > 0 && hasUserChangedSource.current) {
      void setPreferredSource('movie', resolvedTmdbId, Number(selectedVersion.stream_id));
    }
  }, [selectedVersion, resolvedTmdbId]);

  // 7. Display versions for SourceSelector (unifié — une seule source)
  const displayVersions = useMemo(() => {
    return versions.map(v => ({ id: Number(v.stream_id), name: v.name }));
  }, [versions]);

  // 8. Handle version select (callback for SourceSelector)
  const handleVersionSelect = async (version: { id: number; name: string }) => {
    hasUserChangedSource.current = true;

    if (selectedVersion && selectedVersion.stream_id === version.id) return;

    const existingVersion = versions.find(ver => ver.stream_id === version.id);
    if (existingVersion) {
      setSelectedVersion(existingVersion);
    } else if (onLoadVersion) {
      const loaded = await onLoadVersion(version.id);
      if (loaded) {
        setSelectedVersion(loaded);
      }
    }
  };

  return {
    selectedVersion,
    setSelectedVersion,
    versions,
    inWatchlist,
    setInWatchlist,
    hasMovieProgress,
    setHasMovieProgress,
    hasUserChangedSource,
    displayVersions,
    handleVersionSelect,
  };
}
