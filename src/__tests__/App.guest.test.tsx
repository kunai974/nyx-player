/**
 * Tests pour App.tsx — mode invité (sans compte)
 *
 * Accueil TV à deux tuiles, bouton « Continuer sans compte », parcours sans écran des profils,
 * quitter l'espace invité.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react';

// ============================================================================
// MOCKS
// ============================================================================

// Mock i18n
vi.mock('react-i18next', () => ({
    // Chargé par i18n/config (via preferencesService → carouselConstants → tmdbLanguage)
    initReactI18next: { type: '3rdParty', init: () => {} },
    useTranslation: () => ({
        t: (key: string) => key,
        i18n: {
            on: vi.fn(),
            off: vi.fn(),
            language: 'fr',
        },
    }),
}));

// Mock CSS
vi.mock('../App.css', () => ({}));
vi.mock('../pages/SupabaseAuthPage.css', () => ({}));
vi.mock('../pages/ProfileSelectorPage.css', () => ({}));

// Mock Supabase Auth — sans compte par défaut, invité ou compte selon le test
const mockAuth = vi.hoisted(() => ({
    session: null as { access_token: string; user: { id: string } } | null,
    isGuest: false,
    sessionExpired: false,
    enterGuestMode: vi.fn(),
    leaveGuestMode: vi.fn(async () => {}),
    signOut: vi.fn(),
}));
vi.mock('../contexts/SupabaseAuthContext', () => ({
    useSupabaseAuth: () => ({
        user: mockAuth.session ? { id: mockAuth.session.user.id } : null,
        session: mockAuth.session,
        loading: false,
        isDbReady: true,
        sessionExpired: mockAuth.sessionExpired,
        isGuest: mockAuth.isGuest,
        enterGuestMode: mockAuth.enterGuestMode,
        leaveGuestMode: mockAuth.leaveGuestMode,
        signIn: vi.fn(),
        signUp: vi.fn(),
        signOut: mockAuth.signOut,
    }),
}));

// Mock SupabaseAuthPage
vi.mock('../pages/SupabaseAuthPage', () => ({
    default: ({ initialMode }: { initialMode?: string }) => <div data-testid="supabase-auth-page" data-initial-mode={initialMode}>SupabaseAuth</div>,
}));
vi.mock('../pages/WelcomePage.css', () => ({}));

// Mock services
vi.mock('../services/initDevTools', () => ({}));
vi.mock('../services/tmdbCacheSqlite', () => ({
    clearAllCache: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../services/detailFetcher', () => ({
    getMovieDetail: vi.fn(),
    getSeriesDetail: vi.fn(),
}));

// Mock profileService
const TEST_PROFILE = {
    id: 'profile-1',
    user_id: 'test-user-id',
    display_name: 'Profile 1',
    avatar_color: '#F4A8A8',
    is_active: true,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
};
const mockEnsureDefaultProfile = vi.fn().mockResolvedValue([TEST_PROFILE]);
const mockSetActiveProfileSupabase = vi.fn().mockResolvedValue(undefined);
vi.mock('../services/profileService', async (importOriginal) => ({
    needsActiveProfileUpdate: (await importOriginal<typeof import('../services/profileService')>()).needsActiveProfileUpdate,
    loadProfiles: async (...args: unknown[]) => ({ profiles: await mockEnsureDefaultProfile(...args), offline: false }),
    setActiveProfile: (...args: unknown[]) => mockSetActiveProfileSupabase(...args),
}));

// Mock SessionContext
const mockSessionValues = {
    isLoggedIn: false,
    isLoading: false,
    isLoadingSavedData: false,
    progress: 0,
    hasSavedSession: false,
    isCheckingSavedSession: false,
    lightIndexes: null,
    iptvStatus: 'ok' as const,
    homeTab: 'dashboard' as const,
    credentials: null,
    accountInfo: null,
    activeProfileId: null,
    sourceChanged: false,
    login: vi.fn(),
    resumeSession: vi.fn(),
    logout: vi.fn(),
    startFresh: vi.fn(),
    refreshSources: vi.fn(),
    updateCredentials: vi.fn(),
    settingsContentCounts: undefined,
    setActiveTabAfterAuth: vi.fn(),
    selectProfile: vi.fn().mockResolvedValue(undefined),
    fullReset: vi.fn(),
    pendingProviderChange: null,
    confirmProviderChange: vi.fn(),
    sessionError: null,
    clearSessionError: vi.fn(),
};

vi.mock('../contexts/SessionContext', () => ({
    useSession: () => mockSessionValues,
}));

// Mock NavigationContext (l'onglet actif et son setter se règlent dans un test)
const mockNavigation = vi.hoisted(() => ({ activeTab: 'dashboard', setActiveTab: vi.fn() }));
vi.mock('../contexts/NavigationContext', () => ({
    useNavigation: () => ({
        activeTab: mockNavigation.activeTab,
        setActiveTab: mockNavigation.setActiveTab,
        selectedMovie: null,
        navigateToMovie: vi.fn(),
        closeMovieDetail: vi.fn(),
        selectedSeries: null,
        closeSeriesDetail: vi.fn(),
        categoryDetail: null,
        navigateToCategory: vi.fn(),
        searchQuery: '',
        setSearchQuery: vi.fn(),
        activeCategoryId: 'all',
        setActiveCategoryId: vi.fn(),
        goBack: vi.fn(),
    }),
}));

// Mock PlayerContext
vi.mock('../contexts/PlayerContext', () => ({
    usePlayer: () => ({
        currentlyPlaying: null,
        mpvConnected: false,
        isTransitioningToPlayer: false,
        stop: vi.fn(),
        play: vi.fn(),
        setCurrentSeries: vi.fn(),
    }),
}));

// Mock hooks
vi.mock('../hooks/useLiveTvCategories', () => ({
    useLiveTvCategories: () => ({
        selectedCategory: 'all',
        setSelectedCategory: vi.fn(),
        pinnedCategories: [],
        togglePin: vi.fn(),
    }),
}));

vi.mock('../hooks/useEpisodeNavigation', () => ({
    useEpisodeNavigation: () => ({
        playerTitle: '',
        contentId: null,
        resolvedTmdbId: undefined,
        onNextEpisode: undefined,
        onPrevEpisode: undefined,
        seriesMetadata: undefined,
    }),
}));

vi.mock('../hooks/useContentNavigation', () => ({
    useContentNavigation: () => ({
        navigateToContent: vi.fn(),
    }),
    cancelPendingOpen: vi.fn(),
}));

// Mock DevOverrideContext
vi.mock('../contexts/DevOverrideContext', () => ({
    useDevOverrides: () => ({
        overrides: {
            loginPage: {},
            xtreamPage: {},
            watchlistPage: {},
            globalSearchPage: {},
            settingsPage: {},
            liveTvPage: { forceLoading: false, forceEmpty: false, forceError: null },
            activePage: 'unknown',
        },
        setActivePage: vi.fn(),
        setLoginOverride: vi.fn(),
        resetLoginOverrides: vi.fn(),
        setXtreamOverride: vi.fn(),
        resetXtreamOverrides: vi.fn(),
        setWatchlistOverride: vi.fn(),
        resetWatchlistOverrides: vi.fn(),
        setGlobalSearchOverride: vi.fn(),
        resetGlobalSearchOverrides: vi.fn(),
        setSettingsOverride: vi.fn(),
        resetSettingsOverrides: vi.fn(),
        setLiveTvOverride: vi.fn(),
        resetLiveTvOverrides: vi.fn(),
        resetAll: vi.fn(),
        isDevMode: false,
    }),
}));

// Mock UpdaterContext
vi.mock('../contexts/UpdaterContext', () => ({
    useUpdater: () => ({
        status: 'idle',
        version: null,
        notes: null,
        progress: 0,
        error: null,
        checkForUpdate: vi.fn(),
        installUpdate: vi.fn(),
        dismiss: vi.fn(),
    }),
}));

vi.mock('../utils/lightIndexHelpers', () => ({
    getAllVersionsByTmdb: vi.fn().mockReturnValue([]),
}));

// Mock child components as stubs
vi.mock('../components/Login', () => ({
    default: ({ guest, onBackToProfiles }: { guest?: boolean; onBackToProfiles?: () => void }) => (
        <div data-testid="login-component" data-guest={guest ? 'true' : 'false'}>
            <button type="button" data-testid="stub-login-back" onClick={onBackToProfiles}>{'back'}</button>
        </div>
    ),
}));

vi.mock('../components/Navigation/Sidebar', () => ({
    default: ({ onLogout }: { onLogout: () => void }) => (
        <div data-testid="sidebar">
            <button type="button" data-testid="stub-sidebar-logout" onClick={onLogout}>{'sidebar-logout'}</button>
        </div>
    ),
}));
vi.mock('../components/Navigation/TvCategoriesSidebar', () => ({
    default: () => <div data-testid="tv-categories-sidebar">TvCategoriesSidebar</div>,
}));
vi.mock('../components/PlayerControls', () => ({
    default: () => <div data-testid="player-controls">PlayerControls</div>,
}));
vi.mock('../components/AppRoutes', () => ({
    default: ({ onLeaveGuest }: { onLeaveGuest?: (intent: 'login' | 'register') => void }) => (
        <div data-testid="app-routes">
            <button type="button" data-testid="stub-leave-register" onClick={() => onLeaveGuest?.('register')}>{'register'}</button>
        </div>
    ),
}));
vi.mock('../pages/MovieDetailPage', () => ({
    default: () => <div data-testid="movie-detail">MovieDetail</div>,
}));
vi.mock('../pages/SeriesDetailPage', () => ({
    default: () => <div data-testid="series-detail">SeriesDetail</div>,
}));

// ============================================================================
// IMPORT AFTER MOCKS
// ============================================================================

import App from '../App';
import { dispatchBack } from '../hooks/useBackHandler';
import { setTvMode } from '../utils/platform';

afterEach(() => {
    setTvMode(false);
    mockAuth.session = null;
    mockAuth.isGuest = false;
    mockAuth.sessionExpired = false;
    Object.assign(mockSessionValues, { isLoggedIn: false, hasSavedSession: false, isCheckingSavedSession: false, lightIndexes: null });
    vi.clearAllMocks();
});

describe('App — sans compte', () => {
    it('TV : l\'accueil à deux tuiles précède la connexion', () => {
        setTvMode(true);
        render(<App />);
        expect(screen.getByTestId('welcome-page')).toBeInTheDocument();
        expect(screen.queryByTestId('supabase-auth-page')).not.toBeInTheDocument();
    });

    it('TV : « Continuer sans compte » ouvre l\'espace invité', async () => {
        setTvMode(true);
        render(<App />);
        await act(async () => { fireEvent.click(screen.getByTestId('welcome-guest')); });
        expect(mockAuth.enterGuestMode).toHaveBeenCalledTimes(1);
    });

    it('TV : « Se connecter » ouvre la connexion, et Retour ramène aux deux tuiles', () => {
        setTvMode(true);
        render(<App />);
        fireEvent.click(screen.getByTestId('welcome-signin'));
        expect(screen.getByTestId('supabase-auth-page')).toBeInTheDocument();
        act(() => { dispatchBack(); });
        expect(screen.getByTestId('welcome-page')).toBeInTheDocument();
    });

    it('TV, session expirée : l\'écran de connexion (avec son message) passe avant l\'accueil', () => {
        setTvMode(true);
        mockAuth.sessionExpired = true;
        render(<App />);
        expect(screen.getByTestId('supabase-auth-page')).toBeInTheDocument();
        expect(screen.queryByTestId('welcome-page')).not.toBeInTheDocument();
    });

    it('téléphone et PC : la connexion s\'ouvre directement (le bouton « sans compte » est sous le formulaire)', () => {
        render(<App />);
        expect(screen.getByTestId('supabase-auth-page')).toBeInTheDocument();
        expect(screen.queryByTestId('welcome-page')).not.toBeInTheDocument();
    });
});

describe('App — espace invité', () => {
    const guest = () => { mockAuth.isGuest = true; };

    it('saute l\'écran des profils : va droit à l\'ajout du fournisseur, sans appeler le serveur des profils', async () => {
        guest();
        await act(async () => { render(<App />); });
        expect(screen.queryByTestId('profile-selector')).not.toBeInTheDocument();
        expect(screen.getByTestId('login-component')).toHaveAttribute('data-guest', 'true');
        expect(mockEnsureDefaultProfile).not.toHaveBeenCalled();
        expect(mockSetActiveProfileSupabase).not.toHaveBeenCalled();
    });

    it('session IPTV sauvegardée : reprise automatique, sans choix de profil', async () => {
        guest();
        mockSessionValues.hasSavedSession = true;
        await act(async () => { render(<App />); });
        await waitFor(() => expect(mockSessionValues.resumeSession).toHaveBeenCalledTimes(1));
        expect(mockSessionValues.selectProfile).not.toHaveBeenCalled();
    });

    it('lecture de la session sauvegardée en cours : écran de chargement, ni profils ni ajout du fournisseur', async () => {
        guest();
        mockSessionValues.isCheckingSavedSession = true;
        await act(async () => { render(<App />); });
        expect(screen.queryByTestId('login-component')).not.toBeInTheDocument();
        expect(mockSessionValues.resumeSession).not.toHaveBeenCalled();
    });

    it('« Retour » de l\'ajout du fournisseur quitte l\'espace invité (les données restent) et ramène à l\'accueil', async () => {
        guest();
        setTvMode(true);
        await act(async () => { render(<App />); });
        await act(async () => { fireEvent.click(screen.getByTestId('stub-login-back')); });
        expect(mockSessionValues.logout).toHaveBeenCalledTimes(1);
        expect(mockAuth.leaveGuestMode).toHaveBeenCalledTimes(1);
        expect(mockAuth.signOut).not.toHaveBeenCalled();
    });

    it('app ouverte : « Se déconnecter » devient « quitter », confirmé, et ne touche jamais au compte Supabase', async () => {
        guest();
        mockSessionValues.isLoggedIn = true;
        await act(async () => { render(<App />); });
        fireEvent.click(screen.getByTestId('stub-sidebar-logout'));
        expect(screen.getByText('common:guest_leave_confirm')).toBeInTheDocument();
        await act(async () => { fireEvent.click(screen.getByTestId('confirm-modal-confirm')); });
        expect(mockAuth.leaveGuestMode).toHaveBeenCalledTimes(1);
        expect(mockAuth.signOut).not.toHaveBeenCalled();
    });

    it('Réglages > Compte : « Créer un compte » quitte l\'espace invité et ouvre la connexion sur l\'onglet de création', async () => {
        guest();
        mockSessionValues.isLoggedIn = true;
        await act(async () => { render(<App />); });
        // Comme les vrais contextes : la session IPTV se ferme, puis l\'espace invité
        mockSessionValues.logout.mockImplementationOnce(async () => { mockSessionValues.isLoggedIn = false; });
        mockAuth.leaveGuestMode.mockImplementationOnce(async () => { mockAuth.isGuest = false; });
        await act(async () => { fireEvent.click(screen.getByTestId('stub-leave-register')); });
        expect(mockAuth.leaveGuestMode).toHaveBeenCalledTimes(1);
        expect(screen.getByTestId('supabase-auth-page')).toHaveAttribute('data-initial-mode', 'register');
    });

    it('touche Retour sur l\'ajout du fournisseur : quitte l\'espace invité au lieu de fermer l\'app', async () => {
        guest();
        await act(async () => { render(<App />); });
        await act(async () => { dispatchBack(); });
        expect(mockAuth.leaveGuestMode).toHaveBeenCalledTimes(1);
    });
});

describe('App — entrer en invité avec une session IPTV restée ouverte', () => {
    it('session expirée puis « Continuer sans compte » : la session IPTV du compte est fermée d\'abord', async () => {
        setTvMode(true);
        render(<App />);
        await act(async () => { fireEvent.click(screen.getByTestId('welcome-guest')); });
        expect(mockSessionValues.logout).toHaveBeenCalledTimes(1);
        expect(mockAuth.enterGuestMode).toHaveBeenCalledTimes(1);
        expect(mockSessionValues.logout.mock.invocationCallOrder[0]).toBeLessThan(mockAuth.enterGuestMode.mock.invocationCallOrder[0]);
    });
});
