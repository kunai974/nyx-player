/**
 * useProfiles : une réponse lente du compte précédent n'écrase pas les profils du compte suivant.
 */
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { UserProfile } from '../../services/profileService';

const { loadProfiles } = vi.hoisted(() => ({ loadProfiles: vi.fn() }));
vi.mock('../../services/profileService', () => ({
  loadProfiles,
  needsActiveProfileUpdate: vi.fn(() => false),
  setActiveProfile: vi.fn(),
}));

import { useProfiles } from '../useProfiles';

const profil = (id: string, name: string) => ({ id, name }) as unknown as UserProfile;
const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
};

describe('useProfiles — changement de compte pendant le chargement', () => {
  it('garde les profils du second compte quand la réponse du premier arrive en dernier', async () => {
    const a = deferred<{ profiles: UserProfile[] }>();
    const b = deferred<{ profiles: UserProfile[] }>();
    loadProfiles.mockImplementation((id: string) => (id === 'A' ? a.promise : b.promise));

    const { result, rerender } = renderHook(
      ({ userId }: { userId: string }) =>
        useProfiles({ userId, isLoggedIn: false, hasSavedSession: false, selectSessionProfile: vi.fn(), resumeSession: vi.fn() }),
      { initialProps: { userId: 'A' } },
    );
    rerender({ userId: 'B' });

    await act(async () => { b.resolve({ profiles: [profil('pb', 'Profil de B')] }); });
    await act(async () => { a.resolve({ profiles: [profil('pa', 'Profil de A')] }); });

    expect(result.current.profiles.map((p) => p.id)).toEqual(['pb']);
    expect(result.current.profilesInitialized).toBe(true);
  });
});

describe('useProfiles — invité (sans compte)', () => {
  const base = { userId: undefined, isLoggedIn: false, hasSavedSession: false, selectSessionProfile: vi.fn(), resumeSession: vi.fn() };

  it('aucun profil à charger ni à choisir : l\'écran des profils est sauté', () => {
    loadProfiles.mockClear();
    const { result } = renderHook(() => useProfiles({ ...base, guest: true }));
    expect(result.current.profilesInitialized).toBe(true);
    expect(result.current.profileSelected).toBe(true);
    expect(loadProfiles).not.toHaveBeenCalled();
  });

  it('tant que la session sauvegardée est lue, le choix n\'est pas fait (pas de saut vers l\'ajout du fournisseur)', () => {
    const { result } = renderHook(() => useProfiles({ ...base, guest: true, isCheckingSavedSession: true }));
    expect(result.current.profileSelected).toBe(false);
  });

  it('session IPTV sauvegardée : reprise une seule fois, même si le rendu change', () => {
    const resumeSession = vi.fn();
    const { rerender } = renderHook(() => useProfiles({ ...base, guest: true, hasSavedSession: true, resumeSession }));
    rerender();
    rerender();
    expect(resumeSession).toHaveBeenCalledTimes(1);
  });

  it('pas de session sauvegardée : rien à reprendre', () => {
    const resumeSession = vi.fn();
    renderHook(() => useProfiles({ ...base, guest: true, resumeSession }));
    expect(resumeSession).not.toHaveBeenCalled();
  });

  it('avec un compte, rien ne change : les profils restent à choisir', () => {
    const { result } = renderHook(() => useProfiles({ ...base, userId: undefined }));
    expect(result.current.profileSelected).toBe(false);
    expect(result.current.profilesInitialized).toBe(false);
  });
});
