/**
 * WelcomePage — accueil de la TV sans compte : deux tuiles, « Se connecter » et « Continuer sans compte ».
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('react-i18next', () => ({
    useTranslation: () => ({
        t: (key: string) => key,
        i18n: { resolvedLanguage: 'fr', changeLanguage: vi.fn() },
    }),
}));
vi.mock('../WelcomePage.css', () => ({}));

import WelcomePage from '../WelcomePage';

describe('WelcomePage', () => {
    it('montre les deux tuiles, « Se connecter » en premier', () => {
        render(<WelcomePage onSignIn={vi.fn()} onContinueAsGuest={vi.fn()} />);
        const tiles = [...document.querySelectorAll('.welcome-tile')].map((el) => el.getAttribute('data-testid'));
        expect(tiles).toEqual(['welcome-signin', 'welcome-guest']);
    });

    it('« Se connecter » ouvre la connexion, sans ouvrir l\'espace invité', () => {
        const onSignIn = vi.fn();
        const onContinueAsGuest = vi.fn();
        render(<WelcomePage onSignIn={onSignIn} onContinueAsGuest={onContinueAsGuest} />);
        fireEvent.click(screen.getByTestId('welcome-signin'));
        expect(onSignIn).toHaveBeenCalledTimes(1);
        expect(onContinueAsGuest).not.toHaveBeenCalled();
    });

    it('« Continuer sans compte » ouvre l\'espace invité', () => {
        const onSignIn = vi.fn();
        const onContinueAsGuest = vi.fn();
        render(<WelcomePage onSignIn={onSignIn} onContinueAsGuest={onContinueAsGuest} />);
        fireEvent.click(screen.getByTestId('welcome-guest'));
        expect(onContinueAsGuest).toHaveBeenCalledTimes(1);
        expect(onSignIn).not.toHaveBeenCalled();
    });

    it('« Avec mon téléphone » (QR code) entre les deux, et ouvre la connexion par le téléphone', () => {
        const onSignIn = vi.fn();
        const onSignInWithPhone = vi.fn();
        render(<WelcomePage onSignIn={onSignIn} onSignInWithPhone={onSignInWithPhone} onContinueAsGuest={vi.fn()} />);
        const tiles = [...document.querySelectorAll('.welcome-tile')].map((el) => el.getAttribute('data-testid'));
        expect(tiles).toEqual(['welcome-signin', 'welcome-phone', 'welcome-guest']);
        fireEvent.click(screen.getByTestId('welcome-phone'));
        expect(onSignInWithPhone).toHaveBeenCalledTimes(1);
        expect(onSignIn).not.toHaveBeenCalled();
    });
});
