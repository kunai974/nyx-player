/**
 * Tests pour SupabaseAuthPage — Audit Supabase Phase A (Étape 3)
 *
 * Couvre : rendu login/register, validation inputs, gestion erreurs,
 * switch de mode, soumission du formulaire, états loading.
 *
 * i18n est mocké → t(key) retourne la clé brute.
 * Les assertions vérifient les clés i18n, pas les traductions.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// ============================================================================
// MOCKS
// ============================================================================

const mockSignIn = vi.fn();
const mockSignUp = vi.fn();
let mockSessionExpired = false;
const mockEnterGuest = vi.fn();

vi.mock('react-i18next', () => ({
    useTranslation: () => ({
        t: (key: string) => key,
        i18n: { resolvedLanguage: 'en', changeLanguage: vi.fn() },
    }),
}));

vi.mock('../../contexts/SupabaseAuthContext', () => ({
    useSupabaseAuth: () => ({
        signIn: mockSignIn,
        signUp: mockSignUp,
        sessionExpired: mockSessionExpired,
        enterGuestMode: mockEnterGuest,
    }),
}));

vi.mock('../../services/supabaseClient', () => ({
    supabase: {
        auth: {
            resend: vi.fn(),
            resetPasswordForEmail: vi.fn(),
        },
    },
}));

vi.mock('@tauri-apps/plugin-opener', () => ({
    openUrl: vi.fn(),
}));

vi.mock('../../utils/emailSuggestions', () => ({
    suggestEmailCorrection: vi.fn(() => null),
}));

vi.mock('../SupabaseAuthPage.css', () => ({}));
vi.mock('../../components/Common/NyxButton.css', () => ({}));

vi.mock('../../contexts/DevOverrideContext', () => {
    const defaults = {
        loginPage: {
            forceMode: null,
            forceError: null,
            forceSuccess: null,
            forceLoadingSubmit: false,
            forceLoadingForgot: false,
            forceLoadingResend: false,
            forceEmailSuggestion: null,
            forceSignupCooldown: null,
            forceResendCooldown: false,
            forceAcceptTerms: null,
            forceLastRegisteredEmail: null,
            forceLongError: false,
            forceButtonVariant: null,
            forceButtonSize: null,
            forceButtonColor: null,
        },
        xtreamPage: {},
        watchlistPage: {},
        activePage: 'SupabaseAuthPage',
    };
    return {
        useDevOverrides: () => ({
            overrides: defaults,
            setLoginOverride: vi.fn(),
            resetLoginOverrides: vi.fn(),
            setXtreamOverride: vi.fn(),
            resetXtreamOverrides: vi.fn(),
            setWatchlistOverride: vi.fn(),
            resetWatchlistOverrides: vi.fn(),
            resetAll: vi.fn(),
            setActivePage: vi.fn(),
            isDevMode: false,
        }),
    };
});

// ============================================================================
// IMPORT AFTER MOCKS
// ============================================================================

import SupabaseAuthPage from '../SupabaseAuthPage';
import { setTvMode } from '../../utils/platform';

// ============================================================================
// HELPERS
// ============================================================================

/** Render le composant et retourne le container + helpers */
const renderAuth = (props: { initialMode?: 'login' | 'register' } = {}) => {
    const result = render(<SupabaseAuthPage {...props} />);
    return {
        container: result.container,
        unmount: result.unmount,
        fillInput: (label: string, value: string) => {
            fireEvent.change(screen.getByLabelText(label), { target: { value } });
        },
        submitForm: () => {
            const form = result.container.querySelector('form') as HTMLFormElement;
            fireEvent.submit(form);
        },
        getSubmitBtn: () => result.container.querySelector('button[type="submit"]') as HTMLButtonElement,
        acceptTerms: () => {
            const checkbox = result.container.querySelector('.supabase-auth__terms-checkbox input[type="checkbox"]') as HTMLInputElement;
            if (checkbox) fireEvent.click(checkbox);
        },
    };
};

// ============================================================================
// TESTS
// ============================================================================

describe('SupabaseAuthPage', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockSignIn.mockResolvedValue({ error: null });
        mockSignUp.mockResolvedValue({ error: null });
        localStorage.clear();
        mockSessionExpired = false;
    });

    // --- Télécommande : premier focus sur le champ e-mail ---

    it('TV : le focus arrive sur le champ e-mail, sans clavier tant que OK n\'est pas pressé', () => {
        setTvMode(true);
        try {
            renderAuth();
            const email = screen.getByLabelText('supabase_label_email') as HTMLInputElement;
            expect(document.activeElement).toBe(email);
            expect(email.readOnly).toBe(true);
        } finally {
            setTvMode(false);
        }
    });

    it('hors TV : le champ e-mail reste modifiable et sans focus d\'office', () => {
        renderAuth();
        const email = screen.getByLabelText('supabase_label_email') as HTMLInputElement;
        expect(document.activeElement).not.toBe(email);
        expect(email.readOnly).toBe(false);
    });

    // --- Session expirée (jeton de renouvellement refusé par Supabase) ---

    it('session perdue sans déconnexion demandée : message « session expirée »', () => {
        mockSessionExpired = true;
        renderAuth();
        expect(screen.getByText('supabase_session_expired')).toBeInTheDocument();
    });

    it('arrivée normale sur la page : pas de message', () => {
        renderAuth();
        expect(screen.queryByText('supabase_session_expired')).not.toBeInTheDocument();
    });

    it('le message « session expirée » disparaît dès la tentative de connexion', async () => {
        mockSessionExpired = true;
        const { fillInput, submitForm } = renderAuth();
        fillInput('supabase_label_email', 'test@test.com');
        fillInput('supabase_label_password', 'password123');
        submitForm();
        await waitFor(() => expect(mockSignIn).toHaveBeenCalled());
        expect(screen.queryByText('supabase_session_expired')).not.toBeInTheDocument();
    });

    // --- Compte supprimé depuis un autre appareil ---

    it('compte supprimé ailleurs puis appareil nettoyé : message dédié, une seule fois', () => {
        localStorage.setItem('nyx_account_deleted_elsewhere', '1');
        const { unmount } = renderAuth();
        expect(screen.getByText('supabase_account_deleted_elsewhere')).toBeInTheDocument();
        expect(localStorage.getItem('nyx_account_deleted_elsewhere')).toBeNull();
        unmount();
        renderAuth();
        expect(screen.queryByText('supabase_account_deleted_elsewhere')).not.toBeInTheDocument();
    });

    // --- Rendu initial (mode login) ---

    it('affiche le formulaire de login par défaut', () => {
        renderAuth();
        expect(screen.getByText('supabase_subtitle_login')).toBeInTheDocument();
        expect(screen.getByLabelText('supabase_label_email')).toBeInTheDocument();
        expect(screen.getByLabelText('supabase_label_password')).toBeInTheDocument();
        expect(screen.queryByLabelText('supabase_label_confirm_password')).not.toBeInTheDocument();
    });

    it('affiche le bouton submit en mode login', () => {
        const { getSubmitBtn } = renderAuth();
        const btn = getSubmitBtn();
        expect(btn).toBeInTheDocument();
        expect(btn.textContent).toContain('supabase_btn_signin');
    });

    it('a les tabs Sign In et Register', () => {
        const { container } = renderAuth();
        const tabs = container.querySelectorAll('button[type="button"]');
        const tabTexts = Array.from(tabs).map(b => b.textContent?.trim());
        expect(tabTexts).toContain('supabase_tab_signin');
        expect(tabTexts).toContain('supabase_tab_register');
    });

    // --- Switch de mode ---

    it('passe en mode register quand on clique sur Register', () => {
        renderAuth();
        fireEvent.click(screen.getByText('supabase_tab_register'));

        expect(screen.getByText('supabase_subtitle_register')).toBeInTheDocument();
        expect(screen.getByLabelText('supabase_label_confirm_password')).toBeInTheDocument();
    });

    it('nettoie les erreurs au changement de mode', async () => {
        mockSignIn.mockResolvedValue({ error: 'Invalid login', errorKey: 'auth_error_invalid_credentials' });
        const { fillInput, submitForm } = renderAuth();

        fillInput('supabase_label_email', 'test@test.com');
        fillInput('supabase_label_password', 'password123');
        submitForm();

        await waitFor(() => {
            expect(screen.getByText('auth_error_invalid_credentials')).toBeInTheDocument();
        });

        fireEvent.click(screen.getByText('supabase_tab_register'));
        expect(screen.queryByText('auth_error_invalid_credentials')).not.toBeInTheDocument();
    });

    // --- Validation ---

    it('affiche une erreur si email vide', async () => {
        const { fillInput, submitForm } = renderAuth();
        fillInput('supabase_label_password', 'password123');
        submitForm();

        await waitFor(() => {
            expect(screen.getByText('supabase_error_required')).toBeInTheDocument();
        });
        expect(mockSignIn).not.toHaveBeenCalled();
    });

    it('affiche une erreur si password vide', async () => {
        const { fillInput, submitForm } = renderAuth();
        fillInput('supabase_label_email', 'test@test.com');
        submitForm();

        await waitFor(() => {
            expect(screen.getByText('supabase_error_required')).toBeInTheDocument();
        });
        expect(mockSignIn).not.toHaveBeenCalled();
    });

    it('affiche une erreur si password < 10 chars en mode register', async () => {
        const { fillInput, submitForm } = renderAuth();
        fireEvent.click(screen.getByText('supabase_tab_register'));

        fillInput('supabase_label_email', 'test@test.com');
        fillInput('supabase_label_password', '123456789');
        fillInput('supabase_label_confirm_password', '123456789');
        submitForm();

        await waitFor(() => {
            expect(screen.getByText('supabase_error_password_length')).toBeInTheDocument();
        });
        expect(mockSignUp).not.toHaveBeenCalled();
    });

    it('affiche une erreur si passwords ne matchent pas', async () => {
        const { fillInput, submitForm } = renderAuth();
        fireEvent.click(screen.getByText('supabase_tab_register'));

        fillInput('supabase_label_email', 'test@test.com');
        fillInput('supabase_label_password', 'password123');
        fillInput('supabase_label_confirm_password', 'password456');
        submitForm();

        await waitFor(() => {
            expect(screen.getByText('supabase_error_password_mismatch')).toBeInTheDocument();
        });
        expect(mockSignUp).not.toHaveBeenCalled();
    });

    // --- Soumission Login ---

    it('appelle signIn avec email et password', async () => {
        const { fillInput, submitForm } = renderAuth();

        fillInput('supabase_label_email', 'user@test.com');
        fillInput('supabase_label_password', 'securepass');
        submitForm();

        await waitFor(() => {
            expect(mockSignIn).toHaveBeenCalledWith('user@test.com', 'securepass');
        });
    });

    it('échec de connexion : message traduit, jamais le texte anglais de Supabase', async () => {
        mockSignIn.mockResolvedValue({ error: 'Email not confirmed', errorKey: 'auth_error_email_not_confirmed' });
        const { fillInput, submitForm } = renderAuth();

        fillInput('supabase_label_email', 'user@test.com');
        fillInput('supabase_label_password', 'wrongpass');
        submitForm();

        await waitFor(() => {
            expect(screen.getByText('auth_error_email_not_confirmed')).toBeInTheDocument();
        });
        expect(screen.queryByText('Email not confirmed')).toBeNull();
    });

    // --- Soumission Register ---

    it('appelle signUp avec email et password', async () => {
        const { fillInput, submitForm, acceptTerms } = renderAuth();
        fireEvent.click(screen.getByText('supabase_tab_register'));

        fillInput('supabase_label_email', 'new@test.com');
        fillInput('supabase_label_password', 'securepass');
        fillInput('supabase_label_confirm_password', 'securepass');
        acceptTerms();
        submitForm();

        await waitFor(() => {
            expect(mockSignUp).toHaveBeenCalledWith('new@test.com', 'securepass');
        });
    });

    it('affiche le message de succès après inscription', async () => {
        const { fillInput, submitForm, acceptTerms } = renderAuth();
        fireEvent.click(screen.getByText('supabase_tab_register'));

        fillInput('supabase_label_email', 'new@test.com');
        fillInput('supabase_label_password', 'securepass');
        fillInput('supabase_label_confirm_password', 'securepass');
        acceptTerms();
        submitForm();

        await waitFor(() => {
            expect(screen.getByText('supabase_success_registered')).toBeInTheDocument();
        });
    });

    it('échec d\'inscription : message traduit, jamais le texte anglais de Supabase', async () => {
        mockSignUp.mockResolvedValue({ error: 'User already registered', errorKey: 'auth_error_user_exists' });
        const { fillInput, submitForm, acceptTerms } = renderAuth();
        fireEvent.click(screen.getByText('supabase_tab_register'));

        fillInput('supabase_label_email', 'existing@test.com');
        fillInput('supabase_label_password', 'securepass');
        fillInput('supabase_label_confirm_password', 'securepass');
        acceptTerms();
        submitForm();

        await waitFor(() => {
            expect(screen.getByText('auth_error_user_exists')).toBeInTheDocument();
        });
    });

    // --- État disabled pendant soumission ---

    it('désactive le bouton pendant la soumission', async () => {
        mockSignIn.mockImplementation(() => new Promise(() => { }));
        const { fillInput, getSubmitBtn } = renderAuth();

        fillInput('supabase_label_email', 'user@test.com');
        fillInput('supabase_label_password', 'securepass');

        const submitBtn = getSubmitBtn();
        fireEvent.click(submitBtn);

        await waitFor(() => {
            expect(submitBtn).toBeDisabled();
        });
    });
});

describe('SupabaseAuthPage — sans compte', () => {
    it('« Continuer sans compte » est sous le formulaire et ouvre l\'espace invité', () => {
        renderAuth();
        const btn = screen.getByTestId('auth-guest');
        fireEvent.click(btn);
        expect(mockEnterGuest).toHaveBeenCalledTimes(1);
    });

    it('« ou » sépare la connexion du mode invité, qui est un vrai bouton secondaire (pas un texte)', () => {
        renderAuth();
        const btn = screen.getByTestId('auth-guest');
        expect(btn).toHaveClass('nyx-btn', 'nyx-btn--secondary');
        const or = screen.getByRole('separator');
        expect(or).toHaveTextContent('supabase_or');
        // Le « ou » vient avant le bouton invité
        expect(or.compareDocumentPosition(btn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('le bouton ne figure pas sur l\'écran « mot de passe oublié »', () => {
        renderAuth();
        fireEvent.click(screen.getByTestId('auth-forgot'));
        expect(screen.queryByTestId('auth-guest')).not.toBeInTheDocument();
    });

    it('ouverte depuis « Créer un compte » des réglages d\'un invité : l\'onglet de création est ouvert', () => {
        renderAuth({ initialMode: 'register' });
        expect(screen.getByTestId('auth-tab-register').className).toContain('supabase-auth__tab--active');
    });
});
