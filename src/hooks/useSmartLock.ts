/**
 * useSmartLock.ts — Smart Lock & Auto-Hide pour le Player
 *
 * Gère la visibilité des contrôles, le verrouillage de l'interface,
 * l'auto-hide après 3s d'inactivité, et le curseur souris.
 */

import { useState, useRef, useCallback, useEffect } from 'react';

// ============================================================================
// TYPES
// ============================================================================

interface MenuState {
  showAudioSubMenu: boolean;
  showVolumeSlider: boolean;
  showSpeedMenu: boolean;
  channelSwitcherOpen?: boolean;
  episodeSwitcherOpen?: boolean;
  /** Statistiques ouvertes (TV) : leur croix doit rester activable par OK */
  statsOpen?: boolean;
}

interface SmartLockReturn {
  isVisible: boolean;
  isLocked: boolean;
  isLockVisible: boolean;
  resetHideTimer: () => void;
  /** Tactile : un tap sur la vidéo affiche ou masque les contrôles */
  toggleVisibility: () => void;
  handleLock: () => void;
  handleUnlock: () => void;
}

/** Zones où un appui tactile doit garder les contrôles affichés (au lieu de les masquer). */
const INTERACTIVE_SELECTOR =
  'button, input, [role="menu"], .player-top-bar, .player-bottom-bar, .player-smart-lock-fixed, .channel-switcher, .episode-switcher-overlay';

// ============================================================================
// HOOK
// ============================================================================

/** @param hideDelayMs inactivité avant de masquer les contrôles */
export function useSmartLock(menuState: MenuState, hideDelayMs = 3000): SmartLockReturn {
  const [isVisible, setIsVisible] = useState(true);
  const [isLocked, setIsLocked] = useState(false);
  const [isLockVisible, setIsLockVisible] = useState(false);

  const hideTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lockHideTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Latest menu state, read when the hide timer fires: a menu opened after the timer
  // was scheduled (tap on the speed button, no pointermove on touch) must keep controls visible.
  const menuStateRef = useRef(menuState);
  // eslint-disable-next-line react-hooks/refs -- état des menus lu quand le minuteur de masquage se déclenche
  menuStateRef.current = menuState;

  const handleLock = useCallback(() => {
    setIsLocked(true);
    setIsVisible(false);
    setIsLockVisible(true);
    document.body.style.cursor = 'none';
    if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
    lockHideTimeoutRef.current = setTimeout(() => setIsLockVisible(false), 3000);
  }, []);

  const showLockButton = useCallback(() => {
    if (!isLocked) return;
    setIsLockVisible(true);
    document.body.style.cursor = 'default';
    if (lockHideTimeoutRef.current) clearTimeout(lockHideTimeoutRef.current);
    lockHideTimeoutRef.current = setTimeout(() => {
      setIsLockVisible(false);
      document.body.style.cursor = 'none';
    }, 3000);
  }, [isLocked]);

  const resetHideTimer = useCallback(() => {
    if (isLocked) {
      showLockButton();
      return;
    }
    setIsVisible(true);
    document.body.style.cursor = 'default';
    if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
    const tryHide = () => {
      const m = menuStateRef.current;
      if (!m.showAudioSubMenu && !m.showVolumeSlider && !m.showSpeedMenu && !m.channelSwitcherOpen && !m.episodeSwitcherOpen && !m.statsOpen) {
        setIsVisible(false);
        document.body.style.cursor = 'none';
      } else {
        // A menu is open: look again later, so the controls still hide once it closes
        hideTimeoutRef.current = setTimeout(tryHide, hideDelayMs);
      }
    };
    hideTimeoutRef.current = setTimeout(tryHide, hideDelayMs);
  }, [isLocked, showLockButton, hideDelayMs]);

  // Stable ref to always point to latest resetHideTimer (avoids re-running effects)
  const resetHideTimerRef = useRef(resetHideTimer);
  // eslint-disable-next-line react-hooks/refs -- dernière version du minuteur de masquage, sans relancer les effets
  resetHideTimerRef.current = resetHideTimer;

  const handleUnlock = useCallback(() => {
    setIsLocked(false);
    setIsLockVisible(false);
    if (lockHideTimeoutRef.current) clearTimeout(lockHideTimeoutRef.current);
    setIsVisible(true);
    document.body.style.cursor = 'default';
    if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
    hideTimeoutRef.current = setTimeout(() => {
      setIsVisible(false);
      document.body.style.cursor = 'none';
    }, hideDelayMs);
  }, [hideDelayMs]);

  // Restore cursor + cleanup timers on unmount
  useEffect(() => {
    return () => {
      document.body.style.cursor = 'default';
      if (lockHideTimeoutRef.current) clearTimeout(lockHideTimeoutRef.current);
    };
  }, []);

  // Initial hide timer — runs ONCE on mount only
  useEffect(() => {
    resetHideTimerRef.current();
    return () => { if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current); };
  }, []); // Intentionally empty: mount-only

  const isVisibleRef = useRef(isVisible);
  useEffect(() => { isVisibleRef.current = isVisible; }, [isVisible]);

  const toggleVisibility = useCallback(() => {
    if (isLocked) {
      showLockButton();
      return;
    }
    if (!isVisibleRef.current) {
      resetHideTimer();
      return;
    }
    if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
    setIsVisible(false);
  }, [isLocked, showLockButton, resetHideTimer]);

  // Global pointer move listener — uses stable ref.
  // pointermove (et non mousemove) : un tap tactile émet un mousemove de compatibilité
  // qui ré-afficherait les contrôles juste avant que le tap ne les masque.
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') resetHideTimerRef.current();
    };
    const onTouchDown = (e: PointerEvent) => {
      if (e.pointerType === 'touch' && (e.target as HTMLElement).closest?.(INTERACTIVE_SELECTOR)) {
        resetHideTimerRef.current();
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerdown', onTouchDown);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerdown', onTouchDown);
    };
  }, []);

  return { isVisible, isLocked, isLockVisible, resetHideTimer, toggleVisibility, handleLock, handleUnlock };
}
