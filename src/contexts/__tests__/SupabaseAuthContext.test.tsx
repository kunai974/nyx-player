/**
 * SupabaseAuthContext : retour au premier plan et déconnexion hors ligne.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';

type AuthCallback = (event: string, session: { user: { id: string } } | null) => void;
let emit: AuthCallback = () => {};
const signOutMock = vi.fn();

vi.mock('../../services/supabaseClient', () => ({
    supabase: {
        auth: {
            onAuthStateChange: (cb: AuthCallback) => {
                emit = cb;
                return { data: { subscription: { unsubscribe: vi.fn() } } };
            },
            signOut: (...args: unknown[]) => signOutMock(...args),
        },
    },
}));
const setDatabaseName = vi.fn();
vi.mock('../../services/dbCore', () => ({
    setDatabaseName: (...args: unknown[]) => setDatabaseName(...args),
    resetDatabaseName: vi.fn(),
    closeDatabaseConnection: vi.fn(async () => {}),
}));
const setKeyringUser = vi.fn();
vi.mock('../../services/storage', () => ({
    setKeyringUser: (...args: unknown[]) => setKeyringUser(...args),
    resetKeyringUser: vi.fn(),
}));
const setCurrentSyncUserId = vi.fn();
vi.mock('../../services/syncService', () => ({ setCurrentSyncUserId: (...args: unknown[]) => setCurrentSyncUserId(...args) }));
vi.mock('../../services/sync/syncScheduler', () => ({ stopCloudResync: vi.fn() }));
vi.mock('../../services/preferencesService', () => ({ resetPreferencesCache: vi.fn() }));
vi.mock('../../services/liveTvBookmarksService', () => ({ resetLiveTvBookmarksCache: vi.fn() }));
vi.mock('../../services/catalogCaches', () => ({ resetCatalogCaches: vi.fn() }));
vi.mock('../../services/backgroundWork', () => ({ stopBackgroundWork: vi.fn(async () => {}) }));
const sendHeartbeat = vi.fn();
vi.mock('../../services/heartbeatService', () => ({ sendHeartbeat: (...args: unknown[]) => sendHeartbeat(...args) }));
const forgetSessionOnDevice = vi.fn(async () => {});
vi.mock('../../services/authLocalSignOut', () => ({ forgetSessionOnDevice: () => forgetSessionOnDevice() }));

const scheduleAccountExistenceCheck = vi.fn();
vi.mock('../../services/accountExistenceCheck', () => ({
    scheduleAccountExistenceCheck: (uid: string) => scheduleAccountExistenceCheck(uid),
}));

import { SupabaseAuthProvider, useSupabaseAuth } from '../SupabaseAuthContext';
import { isAccountDeletionPending, markAccountDeletionPending } from '../../services/accountDeletion';

let auth: ReturnType<typeof useSupabaseAuth> | null = null;
function Probe({ onAuth }: { onAuth: (value: ReturnType<typeof useSupabaseAuth>) => void }) {
    onAuth(useSupabaseAuth());
    return null;
}

function mount() {
    render(<SupabaseAuthProvider><Probe onAuth={(value) => { auth = value; }} /></SupabaseAuthProvider>);
}

beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    auth = null;
});

describe('SupabaseAuthContext — retour au premier plan', () => {
    it('deux SIGNED_IN du même compte : une seule préparation de la base et un seul battement de cœur', () => {
        mount();
        act(() => { emit('INITIAL_SESSION', { user: { id: 'a' } }); });
        act(() => { emit('SIGNED_IN', { user: { id: 'a' } }); });
        act(() => { emit('SIGNED_IN', { user: { id: 'a' } }); });

        expect(setDatabaseName).toHaveBeenCalledTimes(1);
        expect(setKeyringUser).toHaveBeenCalledTimes(1);
        expect(setCurrentSyncUserId).toHaveBeenCalledTimes(1);
        expect(sendHeartbeat).toHaveBeenCalledTimes(1);
        expect(auth?.isDbReady).toBe(true);
    });

    it('un autre compte, ou le même après une déconnexion, est préparé à nouveau', () => {
        mount();
        act(() => { emit('SIGNED_IN', { user: { id: 'a' } }); });
        act(() => { emit('SIGNED_IN', { user: { id: 'b' } }); });
        act(() => { emit('SIGNED_OUT', null); });
        act(() => { emit('SIGNED_IN', { user: { id: 'b' } }); });

        expect(setDatabaseName.mock.calls.map((c) => c[0])).toEqual(['a', 'b', 'b']);
        expect(sendHeartbeat).toHaveBeenCalledTimes(3);
    });
});

describe('SupabaseAuthContext — déconnexion hors ligne', () => {
    it('Supabase refuse la déconnexion (hors ligne) : la session est effacée de l\'appareil quand même', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        signOutMock.mockResolvedValueOnce({ error: new Error('Failed to fetch') });
        mount();

        await act(async () => { await auth?.signOut(); });

        expect(signOutMock).toHaveBeenCalledWith({ scope: 'local' });
        expect(forgetSessionOnDevice).toHaveBeenCalledTimes(1);
        warn.mockRestore();
    });

    it('Supabase lève une erreur : même traitement', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        signOutMock.mockRejectedValueOnce(new Error('réseau'));
        mount();

        await act(async () => { await auth?.signOut(); });

        expect(forgetSessionOnDevice).toHaveBeenCalledTimes(1);
        warn.mockRestore();
    });

    it('déconnexion acceptée : rien de plus', async () => {
        signOutMock.mockResolvedValueOnce({ error: null });
        mount();

        await act(async () => { await auth?.signOut(); });

        expect(forgetSessionOnDevice).not.toHaveBeenCalled();
    });
});

describe('SupabaseAuthContext — compte supprimé depuis un autre appareil', () => {
    it('au lancement et à chaque retour au premier plan, le serveur est interrogé sur le compte', () => {
        mount();
        act(() => { emit('INITIAL_SESSION', { user: { id: 'a' } }); });
        act(() => { emit('SIGNED_IN', { user: { id: 'a' } }); });

        expect(scheduleAccountExistenceCheck).toHaveBeenCalledTimes(2);
        expect(scheduleAccountExistenceCheck).toHaveBeenCalledWith('a');
    });

    it('sans session : pas de vérification', () => {
        mount();
        act(() => { emit('INITIAL_SESSION', null); });
        act(() => { emit('SIGNED_OUT', null); });

        expect(scheduleAccountExistenceCheck).not.toHaveBeenCalled();
    });

    it('renouvellement du jeton d\'une session déjà ouverte : pas de nouvelle vérification', () => {
        mount();
        act(() => { emit('INITIAL_SESSION', { user: { id: 'a' } }); });
        act(() => { emit('TOKEN_REFRESHED', { user: { id: 'a' } }); });

        expect(scheduleAccountExistenceCheck).toHaveBeenCalledTimes(1);
        expect(setDatabaseName).toHaveBeenCalledTimes(1);
    });

    it('app restée ouverte : le compte est revérifié toutes les 5 minutes tant que l\'app est affichée', () => {
        vi.useFakeTimers();
        try {
            mount();
            act(() => { emit('INITIAL_SESSION', { user: { id: 'a' } }); });
            expect(scheduleAccountExistenceCheck).toHaveBeenCalledTimes(1);

            act(() => { vi.advanceTimersByTime(5 * 60_000); });
            expect(scheduleAccountExistenceCheck).toHaveBeenCalledTimes(2);
            expect(scheduleAccountExistenceCheck).toHaveBeenLastCalledWith('a');

            // App en arrière-plan : pas de requête ; déconnecté : plus rien
            const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
            act(() => { vi.advanceTimersByTime(5 * 60_000); });
            expect(scheduleAccountExistenceCheck).toHaveBeenCalledTimes(2);
            visibility.mockRestore();
            act(() => { emit('SIGNED_OUT', null); });
            act(() => { vi.advanceTimersByTime(15 * 60_000); });
            expect(scheduleAccountExistenceCheck).toHaveBeenCalledTimes(2);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('SupabaseAuthContext — session revenue après un lancement hors ligne', () => {
    it('INITIAL_SESSION sans session puis TOKEN_REFRESHED : le compte est préparé (base, trousseau, synchro)', () => {
        mount();
        act(() => { emit('INITIAL_SESSION', null); });
        expect(auth?.isDbReady).toBe(false);

        act(() => { emit('TOKEN_REFRESHED', { user: { id: 'a' } }); });

        expect(auth?.session).not.toBeNull();
        expect(setDatabaseName).toHaveBeenCalledWith('a');
        expect(setKeyringUser).toHaveBeenCalledWith('a');
        expect(setCurrentSyncUserId).toHaveBeenCalledWith('a');
        expect(auth?.isDbReady).toBe(true);
        expect(scheduleAccountExistenceCheck).toHaveBeenCalledWith('a');
    });
});

describe('SupabaseAuthContext — suppression de compte interrompue', () => {
    const X = '0b8f2a6e-7c1d-4e5f-9a3b-2c4d6e8f0a1b';
    const Y = '7d3e9b1c-2a4f-4c6e-8b0d-1f3a5c7e9b2d';

    it("un autre compte se connecte : la suppression du compte précédent n'est plus reprise au lancement", () => {
        markAccountDeletionPending(X);
        mount();
        act(() => { emit('SIGNED_IN', { user: { id: Y } }); });
        expect(isAccountDeletionPending()).toBe(false);
    });

    it('le compte dont la suppression attend se reconnecte : la marque reste', () => {
        markAccountDeletionPending(X);
        mount();
        act(() => { emit('INITIAL_SESSION', { user: { id: X } }); });
        act(() => { emit('SIGNED_IN', { user: { id: X } }); });
        expect(isAccountDeletionPending()).toBe(true);
    });

    it('renouvellement du jeton d\'un autre compte : même traitement ; la déconnexion garde la marque', () => {
        markAccountDeletionPending(X);
        mount();
        act(() => { emit('SIGNED_OUT', null); });
        expect(isAccountDeletionPending()).toBe(true);
        act(() => { emit('TOKEN_REFRESHED', { user: { id: Y } }); });
        expect(isAccountDeletionPending()).toBe(false);
    });
});

describe('SupabaseAuthContext — utiliser Nyx sans compte (espace invité)', () => {
    const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

    it('« Continuer sans compte » : l\'espace invité s\'ouvre, rien n\'est noté pour la synchro, pas de battement de cœur', () => {
        mount();
        act(() => { emit('INITIAL_SESSION', null); });
        expect(auth?.isGuest).toBe(false);

        act(() => { auth?.enterGuestMode(); });

        expect(auth?.isGuest).toBe(true);
        expect(auth?.isDbReady).toBe(true);
        expect(setDatabaseName).toHaveBeenCalledTimes(1);
        expect(setDatabaseName.mock.calls[0][0]).toMatch(UUID);
        expect(setKeyringUser).toHaveBeenCalledWith(setDatabaseName.mock.calls[0][0]);
        // Jamais de synchro : l'identifiant noté pour la synchro reste vide
        expect(setCurrentSyncUserId).toHaveBeenLastCalledWith(null);
        expect(sendHeartbeat).not.toHaveBeenCalled();
        expect(localStorage.getItem('nyx_guest_mode')).toBe('1');
    });

    it('au lancement suivant, l\'espace invité se rouvre tout seul, le même', () => {
        mount();
        act(() => { emit('INITIAL_SESSION', null); });
        act(() => { auth?.enterGuestMode(); });
        const first = setDatabaseName.mock.calls[0][0];

        vi.clearAllMocks();
        mount();
        act(() => { emit('INITIAL_SESSION', null); });

        expect(auth?.isGuest).toBe(true);
        expect(setDatabaseName).toHaveBeenCalledWith(first);
    });

    it('sans choix « invité » mémorisé, un lancement sans compte n\'ouvre aucun espace', () => {
        mount();
        act(() => { emit('INITIAL_SESSION', null); });
        expect(auth?.isGuest).toBe(false);
        expect(auth?.isDbReady).toBe(false);
        expect(setDatabaseName).not.toHaveBeenCalled();
    });

    it('quitter l\'espace invité : l\'espace se ferme, ses données et son identifiant restent sur l\'appareil', async () => {
        mount();
        act(() => { emit('INITIAL_SESSION', null); });
        act(() => { auth?.enterGuestMode(); });
        const id = localStorage.getItem('nyx_guest_space_id');
        expect(id).toMatch(UUID);

        await act(async () => { await auth?.leaveGuestMode(); });

        expect(auth?.isGuest).toBe(false);
        expect(auth?.isDbReady).toBe(false);
        expect(localStorage.getItem('nyx_guest_mode')).toBeNull();
        expect(localStorage.getItem('nyx_guest_space_id')).toBe(id);
    });

    it('un compte connecté l\'emporte : le choix « invité » est oublié et l\'espace du compte s\'ouvre', () => {
        localStorage.setItem('nyx_guest_mode', '1');
        mount();
        act(() => { emit('INITIAL_SESSION', { user: { id: 'a' } }); });

        expect(auth?.isGuest).toBe(false);
        expect(localStorage.getItem('nyx_guest_mode')).toBeNull();
        expect(setDatabaseName).toHaveBeenCalledTimes(1);
        expect(setDatabaseName).toHaveBeenCalledWith('a');
    });

    it('se connecter pendant l\'espace invité ferme d\'abord l\'espace invité, puis ouvre celui du compte', () => {
        mount();
        act(() => { emit('INITIAL_SESSION', null); });
        act(() => { auth?.enterGuestMode(); });
        act(() => { emit('SIGNED_IN', { user: { id: 'a' } }); });

        expect(auth?.isGuest).toBe(false);
        expect(setDatabaseName.mock.calls.map((c) => c[0])[1]).toBe('a');
        expect(setCurrentSyncUserId).toHaveBeenLastCalledWith('a');
    });

    it('« Continuer sans compte » est refusé quand un compte est connecté', () => {
        mount();
        act(() => { emit('INITIAL_SESSION', { user: { id: 'a' } }); });
        act(() => { auth?.enterGuestMode(); });
        expect(auth?.isGuest).toBe(false);
        expect(setDatabaseName).toHaveBeenCalledTimes(1);
    });

    it('un SIGNED_OUT venu de Supabase ne ferme pas l\'espace invité et n\'annonce jamais « session expirée »', () => {
        mount();
        act(() => { emit('INITIAL_SESSION', null); });
        act(() => { auth?.enterGuestMode(); });
        act(() => { emit('SIGNED_OUT', null); });

        expect(auth?.isGuest).toBe(true);
        expect(auth?.isDbReady).toBe(true);
        expect(auth?.sessionExpired).toBe(false);
    });

    it('le compte revient pendant l\'espace invité : caches vidés, espace invité fermé et spaceKey change (la session IPTV de l\'invité est refermée)', () => {
        mount();
        act(() => { emit('INITIAL_SESSION', null); });
        act(() => { auth?.enterGuestMode(); });
        const before = auth?.spaceKey;
        act(() => { emit('TOKEN_REFRESHED', { user: { id: 'a' } }); });
        expect(auth?.isGuest).toBe(false);
        expect(auth?.spaceKey).not.toBe(before);
        expect(setDatabaseName).toHaveBeenLastCalledWith('a');
    });

    it('un « session expirée » d\'avant ne reparaît pas après l\'espace invité', async () => {
        mount();
        act(() => { emit('INITIAL_SESSION', null); });
        act(() => { auth?.enterGuestMode(); });
        await act(async () => { await auth?.leaveGuestMode(); });
        expect(auth?.sessionExpired).toBe(false);
    });
});

describe('SupabaseAuthContext — fournisseur reçu par QR code', () => {
    it('déconnexion venue du serveur (session expirée) : le fournisseur en attente est oublié, il ne passe pas au compte suivant', async () => {
        const { setPendingTvLinkProvider, peekPendingTvLinkProvider } = await import('../../services/tvLink/pendingProvider');
        mount();
        act(() => { emit('SIGNED_IN', { user: { id: 'a' } }); });
        setPendingTvLinkProvider({ type: 'xtream', host: 'http://serveur.example', username: 'u', password: 'p' });
        act(() => { emit('SIGNED_OUT', null); });
        expect(peekPendingTvLinkProvider()).toBeNull();
    });
});
