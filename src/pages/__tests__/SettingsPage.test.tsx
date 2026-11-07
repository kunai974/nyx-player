/**
 * Tests pour SettingsPage — Phase 6C1
 *
 * Teste le rendu de base, la navigation entre sections,
 * et la présence des modals/toast.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// ============================================================================
// MOCKS
// ============================================================================

// Mock i18n
vi.mock('react-i18next', () => ({
    // Chargé par i18n/config (via preferencesService → carouselConstants → tmdbLanguage)
    initReactI18next: { type: '3rdParty', init: () => {} },
    useTranslation: () => ({
        t: (key: string) => key,
    }),
}));

// Mock CSS
vi.mock('../SettingsPage.css', () => ({}));

// Mock SessionContext
const mockUseSession = vi.fn().mockReturnValue({
    credentials: { host: 'http://test.com', username: 'user', password: 'pass' },
    accountInfo: { username: 'user', status: 'Active' },
    settingsContentCounts: { live: 100, movies: 200, series: 50, uniqueMovies: 180, uniqueSeries: 45, tmdbMovies: 170, tmdbSeries: 40, tmdbMovieRate: 85, tmdbSeriesRate: 80, tmdbMovieTitleRate: 0, tmdbSeriesTitleRate: 0 },
    iptvStatus: 'ok' as const,
    isLoading: false,
    progress: 0,
    refreshSources: vi.fn(),
    logout: vi.fn(),
    updateCredentials: vi.fn(),
});
vi.mock('../../contexts/SessionContext', () => ({
    useSession: () => mockUseSession(),
}));

// Mock SupabaseAuthContext : invité ou compte, choisi par test
const mockAuth = vi.hoisted(() => ({ isGuest: false }));
vi.mock('../../contexts/SupabaseAuthContext', () => ({
    useSupabaseAuth: () => ({ isGuest: mockAuth.isGuest }),
}));

// Variable hoisted pour override mutable du hook useSettingsData par test
const mockSettingsDataOverride = vi.hoisted(() => ({
    value: null as Record<string, unknown> | null,
}));

const defaultSettingsData = {
    cacheStats: { movies: 10, tv: 5, movieDetails: 10, tvDetails: 5 },
    cacheSize: { bytes: 15000, formatted: '15 entrées' },
    cacheCleared: false,
    resetModal: { isOpen: false, type: 'movies' },
    showFullResetModal: false,
    resetSuccess: null as string | null,
    resetError: null as string | null,
    dismissResetError: vi.fn(),
    handleFullResetClick: vi.fn(),
    executeFullReset: vi.fn(),
    openResetModal: vi.fn(),
    handleResetConfirm: vi.fn(),
    closeResetModal: vi.fn(),
    closeFullResetModal: vi.fn(),
};

// Mock hooks
vi.mock('../../hooks/useSettingsData', () => ({
    useSettingsData: () => mockSettingsDataOverride.value ?? defaultSettingsData,
}));

vi.mock('../../hooks/useSettingsPreferences', () => ({
    useSettingsPreferences: () => ({
        homePage: 'dashboard',
        bingeMode: true,
        bingeCountdown: 5,
        geekStats: false,
        dnsProvider: 'auto',
        dashboardDefaultMode: 'suggestions',
        handleHomePageChange: vi.fn(),
        handleBingeModeChange: vi.fn(),
        handleBingeCountdownChange: vi.fn(),
        handleGeekStatsChange: vi.fn(),
        handleDnsProviderChange: vi.fn(),
        handleDashboardDefaultModeChange: vi.fn(),
    }),
}));

// Mock DevOverrideContext
vi.mock('../../contexts/DevOverrideContext', () => ({
    useDevOverrides: () => ({
        overrides: {
            settingsPage: {
                forceIptvStatus: null,
                forceRefreshing: false,
                forceRefreshProgress: null,
                forceEditing: false,
                forceExpiration: null,
                forceCategoryManager: false,
            },
            activePage: 'SettingsPage',
        },
        setActivePage: vi.fn(),
    }),
}));

// Mock sub-components as stubs
vi.mock('../../components/Navigation/SettingsSidebar', () => ({
    SettingsSidebar: ({ activeSection, onSelectSection }: { activeSection: string; onSelectSection: (s: string) => void }) => (
        <div data-testid="settings-sidebar" data-active={activeSection}>
            Sidebar
            <button type="button" data-testid="select-general" onClick={() => onSelectSection('general')} />
            <button type="button" data-testid="select-account" onClick={() => onSelectSection('account')} />
        </div>
    ),
    // Re-export the type (not needed at runtime but keeps TS happy via mock)
}));

vi.mock('../../components/Settings/AccountSection', () => ({
    default: () => <div data-testid="account-section">AccountSection</div>,
}));
vi.mock('../../components/Settings/GuestAccountSection', () => ({
    default: ({ onLeaveGuest }: { onLeaveGuest?: (intent: 'login' | 'register') => void }) => (
        <div data-testid="guest-section">
            <button type="button" data-testid="stub-leave-register" onClick={() => onLeaveGuest?.('register')} />
        </div>
    ),
}));

vi.mock('../../components/Settings/SourcesSection', () => ({
    default: () => <div data-testid="sources-section">SourcesSection</div>,
}));
vi.mock('../../components/Settings/SettingsCarousels', () => ({
    default: () => <div data-testid="settings-carousels">SettingsCarousels</div>,
}));
vi.mock('../../components/Settings/GeneralSection', () => ({
    default: () => <div data-testid="general-section">GeneralSection</div>,
}));
vi.mock('../../components/Settings/DataSection', () => ({
    default: () => <div data-testid="data-section">DataSection</div>,
}));
vi.mock('../../components/Settings/AboutSection', () => ({
    default: () => <div data-testid="about-section">AboutSection</div>,
}));
vi.mock('../../components/Common/ResetOptionsModal', () => ({
    default: ({ isOpen }: { isOpen: boolean }) => (
        isOpen ? <div data-testid="reset-options-modal">ResetOptionsModal</div> : null
    ),
}));
vi.mock('../../components/Common/ConfirmModal', () => ({
    default: ({ isOpen }: { isOpen: boolean }) => (
        isOpen ? <div data-testid="confirm-modal">ConfirmModal</div> : null
    ),
}));

// ============================================================================
// IMPORT AFTER MOCKS
// ============================================================================

import SettingsPage from '../SettingsPage';

// ============================================================================
// TESTS
// ============================================================================

describe('SettingsPage', () => {
    afterEach(() => {
        mockSettingsDataOverride.value = null;
    });

    it('se monte sans crash', () => {
        const { container } = render(<SettingsPage />);
        expect(container.querySelector('.settings-page')).toBeInTheDocument();
    });

    it('affiche la sidebar', () => {
        render(<SettingsPage />);
        expect(screen.getByTestId('settings-sidebar')).toBeInTheDocument();
    });

    it('affiche la section sources par défaut', () => {
        render(<SettingsPage />);
        expect(screen.getByTestId('sources-section')).toBeInTheDocument();
    });

    it('sidebar a la section active = sources par défaut', () => {
        render(<SettingsPage />);
        expect(screen.getByTestId('settings-sidebar')).toHaveAttribute('data-active', 'sources');
    });

    it('changer de rubrique après avoir défilé ouvre la nouvelle page en haut', () => {
        const { container } = render(<SettingsPage />);
        const main = container.querySelector('.settings-main') as HTMLElement;
        main.scrollTop = 400;
        fireEvent.click(screen.getByTestId('select-general'));
        expect(screen.getByTestId('general-section')).toBeInTheDocument();
        expect(main.scrollTop).toBe(0);
    });

    it('n\'affiche PAS les modals quand fermés', () => {
        render(<SettingsPage />);
        expect(screen.queryByTestId('reset-options-modal')).not.toBeInTheDocument();
        expect(screen.queryByTestId('confirm-modal')).not.toBeInTheDocument();
    });

    it('affiche le toast quand resetSuccess est non-null', () => {
        mockSettingsDataOverride.value = {
            ...defaultSettingsData,
            resetSuccess: 'Films réinitialisés avec succès',
        };

        const { container } = render(<SettingsPage />);
        const toast = container.querySelector('.settings-toast.success');
        expect(toast).toBeInTheDocument();
        expect(toast?.textContent).toContain('Films réinitialisés avec succès');
    });

    it('affiche l\'échec de la purge du cloud et permet de le fermer', () => {
        const dismissResetError = vi.fn();
        mockSettingsDataOverride.value = {
            ...defaultSettingsData,
            resetError: 'La suppression de vos données cloud a échoué',
            dismissResetError,
        };

        const { container } = render(<SettingsPage />);
        const toast = container.querySelector('.settings-toast.error');
        expect(toast).toBeInTheDocument();
        expect(toast?.getAttribute('role')).toBe('alert');
        expect(toast?.textContent).toContain('La suppression de vos données cloud a échoué');
        fireEvent.click(toast!.querySelector('button')!);
        expect(dismissResetError).toHaveBeenCalled();
    });

    it('affiche ResetOptionsModal quand resetModal.isOpen = true', () => {
        mockSettingsDataOverride.value = {
            ...defaultSettingsData,
            resetModal: { isOpen: true, type: 'movies' },
        };

        render(<SettingsPage />);
        expect(screen.getByTestId('reset-options-modal')).toBeInTheDocument();
    });

    it('affiche ConfirmModal quand showFullResetModal = true', () => {
        mockSettingsDataOverride.value = {
            ...defaultSettingsData,
            showFullResetModal: true,
        };

        render(<SettingsPage />);
        expect(screen.getByTestId('confirm-modal')).toBeInTheDocument();
    });

    it('compte connecté : la rubrique Compte est celle du compte', () => {
        mockAuth.isGuest = false;
        render(<SettingsPage />);
        fireEvent.click(screen.getByTestId('select-account'));
        expect(screen.getByTestId('account-section')).toBeInTheDocument();
        expect(screen.queryByTestId('guest-section')).not.toBeInTheDocument();
    });

    it('invité : la rubrique Compte est celle de l\'espace invité, et « Créer un compte » prévient l\'app', () => {
        mockAuth.isGuest = true;
        const onLeaveGuest = vi.fn();
        render(<SettingsPage onLeaveGuest={onLeaveGuest} />);
        fireEvent.click(screen.getByTestId('select-account'));
        expect(screen.getByTestId('guest-section')).toBeInTheDocument();
        expect(screen.queryByTestId('account-section')).not.toBeInTheDocument();
        fireEvent.click(screen.getByTestId('stub-leave-register'));
        expect(onLeaveGuest).toHaveBeenCalledWith('register');
        mockAuth.isGuest = false;
    });
});
