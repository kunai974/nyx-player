/**
 * Tests pour Login.tsx — Phase 1 Multi-User
 *
 * Vérifie :
 * - Le rendu du bouton de déconnexion Supabase
 * - L'appel de signOut au clic
 * - Le bouton est désactivé pendant le chargement
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import type { XtreamCredentials } from '../../types/iptv';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';

// ============================================================================
// MOCKS
// ============================================================================

const { i18n, xtreamPage } = vi.hoisted(() => ({
    i18n: { resolvedLanguage: 'en', changeLanguage: vi.fn() },
    xtreamPage: {} as Record<string, unknown>,
}));

vi.mock('react-i18next', () => ({
    useTranslation: () => ({
        t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key} ${JSON.stringify(opts)}` : key),
        i18n,
    }),
}));

const mockSignOut = vi.fn();

vi.mock('../../contexts/SupabaseAuthContext', () => ({
    useSupabaseAuth: () => ({
        signOut: mockSignOut,
    }),
}));

vi.mock('../../contexts/DevOverrideContext', () => ({
    useDevOverrides: () => ({
        overrides: {
            xtreamPage: {
                forceLoading: false,
                forceProgress: null,
                forceError: null,
                forceMode: null,
                ...xtreamPage,
            },
        },
    }),
}));

const dbHealth = vi.hoisted(() => ({ damaged: false }));
vi.mock('../../services/localDatabaseHealth', () => ({ useLocalDatabaseDamaged: () => dbHealth.damaged }));
const performFullReset = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../../services/fullResetService', () => ({ performFullReset }));

// ============================================================================
// IMPORT AFTER MOCKS
// ============================================================================

import Login from '../Login';

// ============================================================================
// TESTS
// ============================================================================

describe('Login — Bouton Supabase Logout', () => {
    const defaultProps = {
        onLogin: vi.fn(),
        isLoading: false,
        progress: 0,
    };

    beforeEach(() => {
        mockSignOut.mockReset();
    });

    it('affiche le bouton de déconnexion Supabase', () => {
        render(<Login {...defaultProps} />);
        const btn = screen.getByText('btn_supabase_logout');
        expect(btn).toBeInTheDocument();
        expect(btn.tagName).toBe('BUTTON');
        expect(btn).toHaveClass('supabase-logout-link');
    });

    it('appelle signOut() au clic sur le bouton', () => {
        render(<Login {...defaultProps} />);
        const btn = screen.getByText('btn_supabase_logout');
        fireEvent.click(btn);
        expect(mockSignOut).toHaveBeenCalledOnce();
    });

    it('le bouton est désactivé pendant le chargement (isLoading)', () => {
        render(<Login {...defaultProps} isLoading={true} />);
        const btn = screen.getByText('btn_supabase_logout');
        expect(btn).toBeDisabled();
    });

    it('le bouton est actif quand pas en chargement', () => {
        render(<Login {...defaultProps} isLoading={false} />);
        const btn = screen.getByText('btn_supabase_logout');
        expect(btn).not.toBeDisabled();
    });

    it('ne déclenche PAS signOut si isLoading et clic (disabled empêche le clic)', () => {
        render(<Login {...defaultProps} isLoading={true} />);
        const btn = screen.getByText('btn_supabase_logout');
        fireEvent.click(btn);
        expect(mockSignOut).not.toHaveBeenCalled();
    });
});

// ============================================================================
// PREMIER LANCEMENT : SAISIE DES IDENTIFIANTS DU FOURNISSEUR (lot C de l'audit de couverture)
// Identifiants factices uniquement : la connexion elle-même est simulée par `onLogin`.
// ============================================================================

describe('Login — saisie des identifiants du fournisseur', () => {
    let onLogin: Mock<(creds: XtreamCredentials) => void>;

    beforeEach(() => {
        onLogin = vi.fn();
        i18n.resolvedLanguage = 'en';
        i18n.changeLanguage.mockReset();
        for (const key of Object.keys(xtreamPage)) delete xtreamPage[key];
    });

    const renderLogin = (props: Partial<React.ComponentProps<typeof Login>> = {}) =>
        render(<Login onLogin={onLogin} isLoading={false} progress={0} {...props} />);
    const fields = () => document.querySelectorAll<HTMLInputElement>('.form-group input');
    const type = (el: HTMLInputElement | HTMLTextAreaElement, value: string) =>
        fireEvent.change(el, { target: { value } });
    const submit = () => fireEvent.click(screen.getByText('btn_login').closest('button')!);
    const fillXtream = (host: string, user: string, pass: string) => {
        const [h, u, p] = fields();
        type(h, host);
        type(u, user);
        type(p, pass);
    };

    it('Xtream Codes complet : les trois identifiants sont transmis', () => {
        renderLogin();
        fillXtream('http://fournisseur.invalid:8080', 'jean', 'secret-factice');
        submit();
        expect(onLogin).toHaveBeenCalledWith({ host: 'http://fournisseur.invalid:8080', username: 'jean', password: 'secret-factice' });
    });

    it('Xtream Codes incomplet : rien n\'est envoyé', () => {
        renderLogin();
        fillXtream('http://fournisseur.invalid', 'jean', '');
        submit();
        expect(onLogin).not.toHaveBeenCalled();
        expect(screen.getByText('error_missing_fields')).toBeInTheDocument();
    });

    it('Xtream Codes : le message « champ manquant » disparaît au nouvel essai complet', () => {
        renderLogin();
        fillXtream('', 'jean', 'secret-factice');
        submit();
        expect(screen.getByText('error_missing_fields')).toBeInTheDocument();
        fillXtream('http://fournisseur.invalid', 'jean', 'secret-factice');
        submit();
        expect(screen.queryByText('error_missing_fields')).toBeNull();
        expect(onLogin).toHaveBeenCalledTimes(1);
    });

    it('l\'œil affiche puis masque le mot de passe', () => {
        renderLogin();
        const password = fields()[2];
        expect(password.type).toBe('password');
        fireEvent.click(screen.getByLabelText('common:password_show'));
        expect(password.type).toBe('text');
        fireEvent.click(screen.getByLabelText('common:password_hide'));
        expect(password.type).toBe('password');
    });

    describe('lien Xtream (M3U)', () => {
        const openLink = () => fireEvent.click(screen.getByText('tab_m3u'));
        const link = () => document.querySelector('textarea')!;

        it('lien complet : serveur, utilisateur et mot de passe en sont tirés', () => {
            renderLogin();
            openLink();
            expect(screen.getByText('tab_m3u')).toHaveClass('active');
            type(link(), 'https://lien.invalid:8443/get.php?username=ana&password=p%40ss&type=m3u_plus');
            submit();
            expect(onLogin).toHaveBeenCalledWith({ host: 'https://lien.invalid:8443', username: 'ana', password: 'p@ss' });
        });

        it('« + » dans les identifiants gardé tel quel', () => {
            renderLogin();
            openLink();
            type(link(), 'http://lien.invalid/get.php?username=a+b&password=c+d');
            submit();
            expect(onLogin).toHaveBeenCalledWith({ host: 'http://lien.invalid', username: 'a+b', password: 'c+d' });
        });

        it('lien sans mot de passe : message « informations manquantes »', () => {
            renderLogin();
            openLink();
            type(link(), 'http://lien.invalid/get.php?username=ana');
            submit();
            expect(screen.getByText('error_m3u_missing_info')).toBeInTheDocument();
            expect(onLogin).not.toHaveBeenCalled();
        });

        it('texte qui n\'est pas un lien : message « lien invalide », effacé au nouvel essai réussi', () => {
            renderLogin();
            openLink();
            type(link(), 'pas un lien');
            submit();
            expect(screen.getByText('error_m3u_invalid')).toBeInTheDocument();

            type(link(), 'http://lien.invalid/get.php?username=a&password=b');
            submit();
            expect(screen.queryByText('error_m3u_invalid')).toBeNull();
            expect(onLogin).toHaveBeenCalledTimes(1);
        });

        it('retour à l\'onglet Xtream Codes : les champs réapparaissent', () => {
            renderLogin();
            openLink();
            fireEvent.click(screen.getByText('tab_xtream'));
            expect(fields()).toHaveLength(3);
        });
    });

    it('connexion en cours : champs et onglets bloqués, progression affichée', () => {
        renderLogin({ isLoading: true, progress: 37 });
        expect([...fields()].every((f) => f.disabled)).toBe(true);
        expect(screen.getByText('tab_m3u')).toBeDisabled();
        expect(screen.getByText('common:loading').closest('button')).toBeDisabled();
        expect(screen.getByText('sync_progress {"progress":37}')).toBeInTheDocument();
        expect((document.querySelector('.progress-bar-fill') as HTMLElement).style.width).toBe('37%');
    });

    it('retour aux profils : bouton présent seulement si prévu, et bloqué pendant la connexion', () => {
        const onBackToProfiles = vi.fn();
        const { unmount } = renderLogin();
        expect(screen.queryByText(/btn_back_to_profiles/)).toBeNull();
        unmount();

        const view = renderLogin({ onBackToProfiles });
        fireEvent.click(screen.getByText(/btn_back_to_profiles/));
        expect(onBackToProfiles).toHaveBeenCalledTimes(1);
        view.rerender(<Login onLogin={onLogin} isLoading progress={0} onBackToProfiles={onBackToProfiles} />);
        expect(screen.getByText(/btn_back_to_profiles/)).toBeDisabled();
    });

    it('bouton de langue : passe de l\'anglais au français et inversement', () => {
        const { unmount } = renderLogin();
        fireEvent.click(screen.getByLabelText('common:toggle_language'));
        expect(i18n.changeLanguage).toHaveBeenLastCalledWith('fr');
        unmount();

        i18n.resolvedLanguage = 'fr';
        renderLogin();
        expect(screen.getByLabelText('common:toggle_language').textContent).toContain('FR');
        fireEvent.click(screen.getByLabelText('common:toggle_language'));
        expect(i18n.changeLanguage).toHaveBeenLastCalledWith('en');
    });

    it('panneau de développement : chargement, erreur et onglet forcés', () => {
        Object.assign(xtreamPage, { forceLoading: true, forceProgress: 80, forceError: 'error_m3u_invalid', forceMode: 'm3u' });
        renderLogin();
        expect(screen.getByText('error_m3u_invalid')).toBeInTheDocument();
        expect(screen.getByText('sync_progress {"progress":80}')).toBeInTheDocument();
        expect(screen.getByText('tab_m3u')).toHaveClass('active');
    });
});

// ============================================================================
// BASE DE L'APPAREIL ABÎMÉE
// ============================================================================

describe('Login — base de l\'appareil abîmée', () => {
    beforeEach(() => {
        dbHealth.damaged = false;
        performFullReset.mockClear();
        for (const key of Object.keys(xtreamPage)) delete xtreamPage[key];
    });

    it('base saine : rien de plus sur l\'écran', () => {
        render(<Login onLogin={vi.fn()} isLoading={false} progress={0} />);
        expect(screen.queryByTestId('provider-db-damaged')).toBeNull();
    });

    it('base abîmée : réinitialisation proposée ici, après confirmation, et ce qui revient du compte est dit', async () => {
        dbHealth.damaged = true;
        render(<Login onLogin={vi.fn()} isLoading={false} progress={0} />);

        expect(screen.getByTestId('provider-db-damaged')).toHaveTextContent('common:local_db_damaged_message');
        fireEvent.click(screen.getByTestId('provider-db-reset'));
        expect(performFullReset).not.toHaveBeenCalled();
        expect(screen.getByText('common:local_db_reset_confirm')).toBeInTheDocument();

        const buttons = screen.getAllByText('common:local_db_reset_button');
        fireEvent.click(buttons[buttons.length - 1]);
        await vi.waitFor(() => expect(performFullReset).toHaveBeenCalledTimes(1));
        // Réinitialisation de cet appareil seulement : ni le cloud ni le compte
        expect(performFullReset).toHaveBeenCalledWith();
    });
});

// ============================================================================
// ADRESSE NETTOYÉE
// ============================================================================

describe('Login — adresse du serveur nettoyée', () => {
    it('« / » final, espaces et majuscule du clavier retirés avant la connexion', () => {
        const onLogin = vi.fn();
        render(<Login onLogin={onLogin} isLoading={false} progress={0} />);
        const [h, u, p] = document.querySelectorAll<HTMLInputElement>('.form-group input');
        fireEvent.change(h, { target: { value: ' Http://Fournisseur.invalid:8080/ ' } });
        fireEvent.change(u, { target: { value: 'jean' } });
        fireEvent.change(p, { target: { value: 'secret-factice' } });
        fireEvent.click(screen.getByText('btn_login').closest('button')!);
        expect(onLogin).toHaveBeenCalledWith({ host: 'http://fournisseur.invalid:8080', username: 'jean', password: 'secret-factice' });
    });

    const loginWith = (host: string, user: string, pass: string) => {
        const onLogin = vi.fn();
        render(<Login onLogin={onLogin} isLoading={false} progress={0} />);
        const [h, u, p] = document.querySelectorAll<HTMLInputElement>('.form-group input');
        fireEvent.change(h, { target: { value: host } });
        fireEvent.change(u, { target: { value: user } });
        fireEvent.change(p, { target: { value: pass } });
        fireEvent.click(screen.getByText('btn_login').closest('button')!);
        return onLogin;
    };

    it('adresse player_api.php complète collée, champs vides : serveur et identifiants en sont tirés', () => {
        const onLogin = loginWith('http://fournisseur.invalid:8080/player_api.php?username=jean&password=secret-factice', '', '');
        expect(onLogin).toHaveBeenCalledWith({ host: 'http://fournisseur.invalid:8080', username: 'jean', password: 'secret-factice' });
    });

    it('adresse collée et identifiants saisis : ceux saisis l\'emportent', () => {
        const onLogin = loginWith('http://fournisseur.invalid/get.php?username=ancien&password=ancien', 'jean', 'secret-factice');
        expect(onLogin).toHaveBeenCalledWith({ host: 'http://fournisseur.invalid', username: 'jean', password: 'secret-factice' });
    });
});
