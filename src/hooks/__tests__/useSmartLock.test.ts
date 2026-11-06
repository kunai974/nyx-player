/**
 * Tests pour useSmartLock.ts
 *
 * Vérifie : lock/unlock, auto-hide après 3s, menu empêche auto-hide,
 * gestion du curseur.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSmartLock } from '../useSmartLock';

describe('useSmartLock', () => {
  const defaultMenu = {
    showAudioSubMenu: false,
    showVolumeSlider: false,
    showSpeedMenu: false,
  };

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.style.cursor = 'default';
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('est visible et non verrouillé à l\'init', () => {
    const { result } = renderHook(() => useSmartLock(defaultMenu));

    expect(result.current.isVisible).toBe(true);
    expect(result.current.isLocked).toBe(false);
    expect(result.current.isLockVisible).toBe(false);
  });

  it('handleLock masque les contrôles et affiche le bouton lock', () => {
    const { result } = renderHook(() => useSmartLock(defaultMenu));

    act(() => { result.current.handleLock(); });

    expect(result.current.isVisible).toBe(false);
    expect(result.current.isLocked).toBe(true);
    expect(result.current.isLockVisible).toBe(true);
  });

  it('le bouton lock disparaît après 3s en mode verrouillé', () => {
    const { result } = renderHook(() => useSmartLock(defaultMenu));

    act(() => { result.current.handleLock(); });
    expect(result.current.isLockVisible).toBe(true);

    act(() => { vi.advanceTimersByTime(3000); });
    expect(result.current.isLockVisible).toBe(false);
  });

  it('handleUnlock restaure la visibilité', () => {
    const { result } = renderHook(() => useSmartLock(defaultMenu));

    act(() => { result.current.handleLock(); });
    act(() => { result.current.handleUnlock(); });

    expect(result.current.isVisible).toBe(true);
    expect(result.current.isLocked).toBe(false);
    expect(result.current.isLockVisible).toBe(false);
  });

  it('auto-hide des contrôles après 3s d\'inactivité', () => {
    const { result } = renderHook(() => useSmartLock(defaultMenu));

    expect(result.current.isVisible).toBe(true);

    act(() => { vi.advanceTimersByTime(3000); });
    expect(result.current.isVisible).toBe(false);
  });

  it('un menu ouvert empêche l\'auto-hide', () => {
    const menuOpen = { ...defaultMenu, showSpeedMenu: true };
    const { result } = renderHook(() => useSmartLock(menuOpen));

    act(() => { result.current.resetHideTimer(); });
    act(() => { vi.advanceTimersByTime(5000); });

    expect(result.current.isVisible).toBe(true);
  });

  it('statistiques ouvertes (TV) : les contrôles restent affichés', () => {
    const { result } = renderHook(() => useSmartLock({ ...defaultMenu, statsOpen: true }));

    act(() => { result.current.resetHideTimer(); });
    act(() => { vi.advanceTimersByTime(5000); });

    expect(result.current.isVisible).toBe(true);
  });

  it('un menu ouvert après le démarrage du timer empêche aussi l\'auto-hide (tap tactile)', () => {
    const { result, rerender } = renderHook(({ menu }) => useSmartLock(menu), {
      initialProps: { menu: defaultMenu },
    });

    act(() => { result.current.resetHideTimer(); });
    // Le tap ouvre le menu vitesse sans nouveau pointermove
    rerender({ menu: { ...defaultMenu, showSpeedMenu: true } });
    act(() => { vi.advanceTimersByTime(5000); });

    expect(result.current.isVisible).toBe(true);
  });

  it('un menu fermé après l\'échéance du timer : les contrôles se masquent ensuite d\'eux-mêmes', () => {
    const { result, rerender } = renderHook(({ menu }) => useSmartLock(menu), {
      initialProps: { menu: { ...defaultMenu, showSpeedMenu: true } },
    });

    // Le timer échoit menu ouvert : les contrôles restent
    act(() => { vi.advanceTimersByTime(3000); });
    expect(result.current.isVisible).toBe(true);

    // Le menu se ferme sans mouvement de souris : avant, les contrôles restaient affichés pour toujours
    rerender({ menu: defaultMenu });
    act(() => { vi.advanceTimersByTime(3000); });
    expect(result.current.isVisible).toBe(false);
  });

  it('restaure le curseur au unmount', () => {
    const { unmount } = renderHook(() => useSmartLock(defaultMenu));

    act(() => { vi.advanceTimersByTime(3000); });
    expect(document.body.style.cursor).toBe('none');

    unmount();
    expect(document.body.style.cursor).toBe('default');
  });
});
