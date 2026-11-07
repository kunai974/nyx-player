/**
 * GuestAccountSection — Réglages > Compte pour quelqu'un qui utilise Nyx sans compte.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('react-i18next', () => ({
    useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'fr' } }),
}));
let pausedUntil: number | null = null;
vi.mock('../../../services/guestRelay', () => ({ guestRelayPausedUntil: () => pausedUntil }));
vi.mock('../../Common/NyxButton.css', () => ({}));
import GuestAccountSection from '../GuestAccountSection';

describe('GuestAccountSection', () => {
    it('dit qu\'on utilise Nyx sans compte, sans aucun réglage de compte (e-mail, mot de passe, suppression)', () => {
        render(<GuestAccountSection onLeaveGuest={vi.fn()} onEraseDeviceData={vi.fn()} />);
        expect(screen.getByTestId('guest-card-title')).toHaveTextContent('guest_card_title');
        expect(screen.queryByTestId('settings-email-change')).not.toBeInTheDocument();
        expect(screen.queryByTestId('settings-password-change')).not.toBeInTheDocument();
        expect(screen.queryByTestId('settings-account-delete')).not.toBeInTheDocument();
        // Plus de champ de clé TMDB personnelle : le relais de Nyx suffit
        expect(screen.queryByTestId('guest-tmdb-input')).not.toBeInTheDocument();
    });

    it('« Créer un compte » et « Se connecter » quittent l\'espace invité avec la bonne intention', () => {
        const onLeaveGuest = vi.fn();
        render(<GuestAccountSection onLeaveGuest={onLeaveGuest} onEraseDeviceData={vi.fn()} />);
        fireEvent.click(screen.getByTestId('guest-create-account'));
        fireEvent.click(screen.getByTestId('guest-sign-in'));
        expect(onLeaveGuest.mock.calls).toEqual([['register'], ['login']]);
    });

    it('« Effacer les données » ouvre la remise à zéro complète', () => {
        const onEraseDeviceData = vi.fn();
        render(<GuestAccountSection onLeaveGuest={vi.fn()} onEraseDeviceData={onEraseDeviceData} />);
        fireEvent.click(screen.getByTestId('guest-erase-data'));
        expect(onEraseDeviceData).toHaveBeenCalledTimes(1);
    });

    it('cartes séparées par un filet : aucune carte collée à la suivante (elles se chevauchaient)', () => {
        const { container } = render(<GuestAccountSection onLeaveGuest={vi.fn()} onEraseDeviceData={vi.fn()} />);
        const card = screen.getByTestId('guest-card-title').closest('.setting-item');
        expect(screen.getByTestId('guest-create-account').closest('.setting-item')).toBe(card);
        const section = container.querySelector('[data-testid="guest-account-section"]')!;
        for (const item of Array.from(section.children)) {
            if (!item.classList.contains('setting-item')) continue;
            expect(item.previousElementSibling?.classList.contains('setting-item')).not.toBe(true);
        }
    });

    it('dit quand les fiches TMDB reviennent si le relais est en pause, et rien sinon', () => {
        pausedUntil = null;
        const { unmount } = render(<GuestAccountSection onLeaveGuest={vi.fn()} onEraseDeviceData={vi.fn()} />);
        expect(screen.queryByTestId('guest-tmdb-paused')).not.toBeInTheDocument();
        unmount();
        pausedUntil = Date.UTC(2026, 10, 3, 0, 0);
        render(<GuestAccountSection onLeaveGuest={vi.fn()} onEraseDeviceData={vi.fn()} />);
        expect(screen.getByTestId('guest-tmdb-paused')).toHaveTextContent('guest_tmdb_paused');
        pausedUntil = null;
    });
});
