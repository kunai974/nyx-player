/**
 * PlayerControls — surcouche du lecteur vidéo (boutons, barre de progression, menus, fenêtres).
 *
 * Ce fichier réunit les hooks du lecteur et pose les morceaux de l'écran ; les boutons sont
 * dans `Player/controls/`. Les hooks restent appelés ici, dans le même ordre :
 * la pile du bouton Retour (`useBackHandler`) et la télécommande (`usePlayerRemote`) en dépendent.
 */

import React, { useCallback, useEffect, useRef } from 'react';
import { PlayIcon, PauseIcon } from './Player/PlayerIcons';
import ChannelSwitcher from './Tv/ChannelSwitcher';
import EpisodeSwitcher from './Player/EpisodeSwitcher';
import { useEpisodeSwitcher } from '../hooks/useEpisodeSwitcher';
import BingePopup from './Player/BingePopup';
import GeekStatsOverlay from './Player/GeekStatsOverlay';
import PlaybackErrorOverlay from './Player/PlaybackErrorOverlay';
import EpgBanner from './Player/EpgBanner';
import SmartLockButton from './Player/controls/SmartLockButton';
import PlayerTopBar from './Player/controls/PlayerTopBar';
import ProgressBar from './Player/controls/ProgressBar';
import PlaybackButtons from './Player/controls/PlaybackButtons';
import VolumeControl from './Player/controls/VolumeControl';
import SwitcherButton from './Player/controls/SwitcherButton';
import PlayerRightControls from './Player/controls/PlayerRightControls';
import { formatTime } from './Player/controls/formatTime';
import { getBingeCountdown } from '../services/preferencesService';
import { useMpvObserver } from '../hooks/useMpvObserver';
import { useStallWatchdog, useLiveEndWatchdog } from '../hooks/useStallWatchdog';
import { usePlaybackRecovery } from '../hooks/usePlaybackRecovery';
import { usePlayerPreferences } from '../hooks/usePlayerPreferences';
import { usePeriodicSave } from '../hooks/usePeriodicSave';
import { usePlayerKeyboard } from '../hooks/usePlayerKeyboard';
import { useSmartLock } from '../hooks/useSmartLock';
import { usePlayerActions } from '../hooks/usePlayerActions';
import { usePlayerMenus, useCloseMenusOnClickOutside, useCloseMenusOnDialog } from '../hooks/usePlayerMenus';
import { useEpisodeButtons } from '../hooks/useEpisodeButtons';
import { useFlashIcon } from '../hooks/useFlashIcon';
import { useZapChannel } from '../hooks/useZapChannel';
import { useProgressScrub } from '../hooks/useProgressScrub';
import { useDevOverrides } from '../contexts/DevOverrideContext';
import { usePlayer } from '../contexts/PlayerContext';
import { useChannelSwitcher, LiveTvData } from '../hooks/useChannelSwitcher';
import { usePlayerEpg } from '../hooks/usePlayerEpg';
import { useBackHandler } from '../hooks/useBackHandler';
import { usePlayerRemote } from '../hooks/usePlayerRemote';
import { useMediaCommands } from '../hooks/useMediaCommands';
import { isTv } from '../utils/platform';
import type { SeriesMetadata } from '../types/player';
import './PlayerControls.css';

interface PlayerControlsProps {
  title: string;
  onClose: () => void;
  isConnected: boolean;
  contentId?: string;
  tmdbId?: number;
  onNextEpisode?: () => void;
  onPrevEpisode?: () => void;
  seriesMetadata?: SeriesMetadata;
  liveTvData?: LiveTvData;
}

/** Télécommande : les contrôles restent affichés plus longtemps qu'à la souris */
const TV_CONTROLS_HIDE_MS = 5000;

const PlayerControls: React.FC<PlayerControlsProps> = ({
  title,
  onClose,
  isConnected,
  contentId,
  tmdbId,
  onNextEpisode,
  onPrevEpisode,
  seriesMetadata,
  liveTvData,
}) => {
  const { overrides, setActivePage } = useDevOverrides();
  const {
    switchChannel, currentSeries, currentlyPlaying, play,
    playbackError, retryAttempt, retryPlayback, dismissPlaybackError, confirmPlaybackRecovered,
  } = usePlayer();
  // Liste des chaînes : le zapping ne rejette pas ; référence stable (la liste la met en dépendance)
  const handleChannelClick = useCallback((channel: Parameters<typeof switchChannel>[0]) => {
    void switchChannel(channel);
  }, [switchChannel]);
  const pc = overrides.playerControls;
  const tv = isTv();

  // ---- UI-only state : menus (volume, pistes, vitesse, statistiques) ----
  const menus = usePlayerMenus();
  const { showVolumeSlider, showAudioSubMenu, showSpeedMenu, showGeekStats, setShowAudioSubMenu, setShowSpeedMenu, setShowGeekStats } = menus;

  // ---- DevPanel: register active page ----
  useEffect(() => {
    setActivePage('PlayerControls');
  }, [setActivePage]);

  // ---- UI refs ----
  const progressRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // ---- Hooks: episode navigation wrapper (needs savePlaybackPosition) ----
  const { handleNextEpisode, handlePrevEpisode, savePlaybackPositionRef } = useEpisodeButtons(onNextEpisode, onPrevEpisode);

  // ---- Hook 1: MPV Observer ----
  const mpv = useMpvObserver(isConnected, seriesMetadata, handleNextEpisode, showGeekStats);

  // ---- Hook 2: Player Preferences ----
  const prefs = usePlayerPreferences(
    isConnected, contentId, tmdbId,
    mpv.duration, mpv.currentTime, seriesMetadata, mpv.syncFromMpv, mpv.setIsSeeking, mpv.trackListRevision,
  );

  // Sync savePlaybackPosition ref for episode navigation
  useEffect(() => {
    savePlaybackPositionRef.current = prefs.savePlaybackPosition;
  }, [prefs.savePlaybackPosition, savePlaybackPositionRef]);

  // ---- Hook 3: Periodic Save ----
  usePeriodicSave(contentId, isConnected, mpv.duration, mpv.currentTime);

  // ---- Hook 4: Channel Switcher ----
  const channelSwitcher = useChannelSwitcher({ liveTvData });

  // ---- Hook 4.5: Episode Switcher ----
  const episodeSwitcher = useEpisodeSwitcher();

  // ---- Hook 5: Smart Lock ----
  const smartLock = useSmartLock({ 
    showAudioSubMenu, 
    showVolumeSlider, 
    showSpeedMenu, 
    channelSwitcherOpen: channelSwitcher.isOpen,
    episodeSwitcherOpen: episodeSwitcher.isOpen,
    // Télécommande : contrôles masqués, OK les réaffiche au lieu de fermer les statistiques
    statsOpen: tv && showGeekStats,
  }, tv ? TV_CONTROLS_HIDE_MS : undefined);

  // ---- Hook 5.5: Player EPG (Live TV overlay — needs smartLock.isVisible) ----
  const playerEpg = usePlayerEpg(liveTvData?.currentChannel, !!liveTvData, smartLock.isVisible);

  // ---- Hook 5: Player Actions ----
  const actions = usePlayerActions({ mpv, prefs, onClose, progressRef });

  // ---- Bouton retour Android : menus d'abord, puis fermeture du player ----
  // (channel/episode switchers ont leur propre handler, empilé au-dessus quand ouverts)
  useBackHandler(true, () => {
    if (smartLock.isLocked) return;
    if (showAudioSubMenu) { setShowAudioSubMenu(false); return; }
    if (showSpeedMenu) { setShowSpeedMenu(false); return; }
    if (showGeekStats) { setShowGeekStats(false); return; }
    // Télécommande : un premier retour masque les contrôles, le suivant quitte le lecteur
    if (tv && smartLock.isVisible) { smartLock.toggleVisibility(); return; }
    void actions.handleClose();
  });

  // ---- Click outside to close menus ----
  useCloseMenusOnClickOutside(menus);

  // ---- Flash overlay callback ----
  const { flashIcon, flashKey, flashPlayPause } = useFlashIcon(mpv.isPaused);

  // ---- Hook 6: Keyboard shortcuts ----
  usePlayerKeyboard(
    { togglePlayPause: actions.togglePlayPause, skip: actions.skip, toggleMute: actions.toggleMute, toggleFullscreen: actions.toggleFullscreen, setShowGeekStats, onOverlayPlayPause: flashPlayPause, onTouchTap: smartLock.toggleVisibility },
    {
      isLocked: smartLock.isLocked, showAudioSubMenu, showSpeedMenu,
      containerRef: containerRef as React.RefObject<HTMLDivElement>,
      volumeRef: mpv.volumeRef,
      setVolumeState: mpv.setVolumeState,
      setIsMuted: mpv.setIsMuted,
    },
  );

  // ---- Hook 7: Télécommande (Android TV) ----
  const zapChannel = useZapChannel(liveTvData, switchChannel);

  const showBinge = (pc.forceBingePopup || mpv.showBingePopup) && !!seriesMetadata?.nextEpisode;

  // Télécommande : épisode suivant ou erreur de lecture ferment vitesse et pistes (voir le hook)
  const dialogOpen = !!playbackError || showBinge;
  useCloseMenusOnDialog(dialogOpen, tv, menus);

  usePlayerRemote({
    enabled: tv,
    containerRef,
    progressRef,
    controlsVisible: smartLock.isVisible,
    isLocked: smartLock.isLocked,
    isPaused: mpv.isPaused,
    isLive: !!liveTvData,
    dialogOpen,
    switcher: channelSwitcher.isOpen ? 'channels' : episodeSwitcher.isOpen ? 'episodes' : null,
    menu: showSpeedMenu ? 'speed' : showAudioSubMenu ? 'audio' : showGeekStats ? 'stats' : null,
    showControls: smartLock.resetHideTimer,
    togglePlayPause: actions.togglePlayPause,
    skip: actions.skip,
    zap: liveTvData ? zapChannel : undefined,
  });

  // Assistant, casque, télécommande (Android) : chaîne suivante / précédente en direct, contrôles
  // affichés pour montrer la nouvelle chaîne (comme Haut / Bas à la télécommande)
  useMediaCommands(liveTvData ? zapChannel : undefined, smartLock.resetHideTimer);

  // ---- Touch scrubbing on the progress bar (mouse keeps the click-to-seek behaviour) ----
  const scrub = useProgressScrub(progressRef, mpv.duration, smartLock.resetHideTimer, actions.handleSeek);
  const { scrubPercent } = scrub;

  // ---- Derived values ----
  const displayTime = scrubPercent !== null ? (scrubPercent / 100) * mpv.duration : mpv.currentTime;
  const progress = scrubPercent ?? (mpv.duration > 0 ? (mpv.currentTime / mpv.duration) * 100 : 0);
  // Coupure réseau en pleine lecture : mise en tampon qui ne se termine jamais
  useStallWatchdog(mpv.isBuffering, mpv.isPaused, isConnected);
  // Direct fermé par le fournisseur : mpv atteint la fin et reste figé sur la dernière image
  // (même critère que l'URL de direct construite par PlayerContext ; liveTvData peut attraper un film)
  const isLive = !!currentlyPlaying && 'stream_type' in currentlyPlaying && currentlyPlaying.stream_type === 'live';
  // Première coupure : reconnexion immédiate et silencieuse, l'écran d'erreur ne vient qu'ensuite
  // (écran d'erreur déjà affiché : il garde la main avec sa reconnexion espacée)
  useLiveEndWatchdog(mpv.isEndOfFile, isLive, isConnected, retryAttempt, playbackError ? undefined : retryPlayback);
  // Le compteur de relances ne repart à zéro qu'une fois la vidéo repartie pour de bon
  usePlaybackRecovery(mpv.currentTime, retryAttempt, !!playbackError, confirmPlaybackRecovered);

  const showLoadingIndicator = !playbackError && (pc.forceLoading || mpv.isLoading || mpv.isSeeking || (mpv.isBuffering && !mpv.isPaused));
  const seriesMode = !!currentSeries || pc.forceSeriesMode;

  // ---- Render ----
  return (
    <div 
      ref={containerRef} 
      className={`player-overlay ${channelSwitcher.isOpen ? 'channel-switcher--open' : ''}`}
      data-testid="player-overlay"
      data-nav-layer="modal"
      style={{ '--switcher-offset': channelSwitcher.isOpen ? `${channelSwitcher.leftMarginRatio * 100}vw` : '0px' } as React.CSSProperties}
    >
      <div className="player-ui-safe-area">
        {/* Play/Pause flash indicator */}
      {flashIcon && (
        <div className="player-action-flash" key={flashKey}>
          {flashIcon === 'play' ? <PlayIcon /> : <PauseIcon />}
        </div>
      )}

      {/* Loading indicator */}
      {showLoadingIndicator && (
        <div className="player-loading">
          <div className="player-loading-spinner" />
        </div>
      )}

      {/* Échec du flux : explication + reconnexion espacée */}
      {playbackError && (
        <PlaybackErrorOverlay
          error={playbackError}
          retryAttempt={retryAttempt}
          onRetry={retryPlayback}
          onContinue={dismissPlaybackError}
          onClose={() => void actions.handleClose()}
        />
      )}

      {/* Binge Mode Popup */}
      {showBinge && seriesMetadata?.nextEpisode && (
        <BingePopup
          currentSeries={currentSeries || undefined}
          nextEpisode={{
            seasonNumber: seriesMetadata.nextEpisode.seasonNumber,
            episodeNumber: seriesMetadata.nextEpisode.episodeNumber,
            episodeTitle: seriesMetadata.nextEpisode.episodeTitle,
            episodeCover: seriesMetadata.nextEpisode.episodeCover,
          }}
          seriesCover={seriesMetadata.seriesCover}
          seriesName={seriesMetadata.seriesName}
          countdown={mpv.bingeCountdown}
          countdownMax={getBingeCountdown()}
          onPlayNow={mpv.handleBingePlayNow}
          onCancel={mpv.handleBingeCancel}
        />
      )}

      {/* Geek Stats Overlay */}
      {(showGeekStats || pc.forceGeekStats) && (
        <GeekStatsOverlay
          stats={mpv.geekStats}
          onClose={() => setShowGeekStats(false)}
        />
      )}

      {/* EPG Banner (Live TV — above controls) */}
      {liveTvData && (
        <EpgBanner
          channelName={liveTvData.currentChannel.name}
          streamIcon={liveTvData.currentChannel.stream_icon}
          nowProgram={playerEpg.nowProgram}
          nextProgram={playerEpg.nextProgram}
          isVisible={playerEpg.isVisible}
        />
      )}

      {/* Smart Lock */}
      <SmartLockButton
        isLocked={smartLock.isLocked}
        isVisible={smartLock.isLocked ? smartLock.isLockVisible : smartLock.isVisible}
        onUnlock={smartLock.handleUnlock}
        onLock={() => {
          if (channelSwitcher.isOpen) channelSwitcher.close();
          smartLock.handleLock();
        }}
      />

      {/* Controls Layer */}
      <div className={`player-controls-layer ${smartLock.isVisible ? 'visible' : 'hidden'} ${smartLock.isLocked ? 'locked' : ''}`} data-testid="player-controls">
        {/* Top bar */}
        <PlayerTopBar title={title} seriesMetadata={seriesMetadata} onClose={() => void actions.handleClose()} />

        {/* Bottom controls */}
        <div className="player-bottom-bar">
          {/* Progress bar */}
          <ProgressBar
            progressRef={progressRef}
            scrub={scrub}
            progress={progress}
            displayTime={displayTime}
            duration={mpv.duration}
            focusable={tv && !liveTvData}
          />

          {/* Controls row */}
          <div className="player-controls-row">
            {/* Left side */}
            <div className="player-controls-left">
              <PlaybackButtons
                isPaused={mpv.isPaused}
                onTogglePlayPause={() => void actions.togglePlayPause()}
                onSkip={(seconds) => void actions.skip(seconds)}
                onPrevEpisode={(onPrevEpisode || pc.forceSeriesMode) ? (() => void handlePrevEpisode()) : undefined}
                onNextEpisode={(onNextEpisode || pc.forceSeriesMode) ? (() => void handleNextEpisode()) : undefined}
              />

              {/* Volume */}
              <VolumeControl
                volume={mpv.volume}
                isMuted={mpv.isMuted}
                sliderVisible={showVolumeSlider}
                onSliderVisibleChange={menus.setShowVolumeSlider}
                onToggleMute={() => void actions.toggleMute()}
                onVolumeChange={(e) => void actions.handleVolumeChange(e)}
                tv={tv}
              />

              {/* Time */}
              <div className="player-time" data-testid="player-time" data-minute={Math.floor(displayTime / 60)}>
                {formatTime(displayTime)} / {formatTime(mpv.duration)}
              </div>
            </div>

            {/* Center side : épisodes (séries) ou chaînes (direct) */}
            <div className="player-controls-center">
              <SwitcherButton
                seriesMode={seriesMode}
                isLive={!!liveTvData}
                episodeSwitcher={episodeSwitcher}
                channelSwitcher={channelSwitcher}
              />
            </div>

            {/* Right side */}
            <PlayerRightControls
              menus={menus}
              prefs={prefs}
              playbackSpeed={mpv.playbackSpeed}
              currentAudioId={mpv.currentAudioId}
              currentSubId={mpv.currentSubId}
              aspectMode={actions.aspectMode}
              onToggleAspect={() => void actions.toggleAspect()}
              isFullscreen={actions.isFullscreen}
              onToggleFullscreen={() => void actions.toggleFullscreen()}
            />
          </div>
        </div>
      </div>
      </div>

      {/* Channel Switcher (Live TV) - Hors de la safe area pour ne pas être décalé ! */}
      {liveTvData && (
        <ChannelSwitcher
          liveTvData={liveTvData}
          isOpen={channelSwitcher.isOpen}
          selectedCategoryId={channelSwitcher.selectedCategoryId}
          onSelectCategory={channelSwitcher.selectCategory}
          filteredChannels={channelSwitcher.filteredChannels}
          activeChannelId={channelSwitcher.activeChannelId}
          onChannelClick={handleChannelClick}
          onClose={channelSwitcher.close}
        />
      )}

      {/* Episode Switcher (Series) - Hors de la safe area */}
      {seriesMode && (
        <EpisodeSwitcher
           isOpen={episodeSwitcher.isOpen}
           onClose={episodeSwitcher.close}
           currentSeries={currentSeries}
           currentlyPlaying={currentlyPlaying}
           forceSkeletonLoading={pc.forceEpisodeSkeleton}
           onPlayEpisode={async (episode, series) => {
             // Comme les boutons précédent/suivant : on enregistre la position de l'épisode quitté.
             try { await savePlaybackPositionRef.current?.(); } catch { /* sans effet sur le lancement */ }
             await play(episode, series, 0, {
                 seriesId: series.series_id,
                 tmdbId: series.tmdb,
                 tmdbTitle: series.tmdbTitle,
                 posterUrl: series.cover
             });
           }}
        />
      )}
    </div>
  );
};

export default PlayerControls;
