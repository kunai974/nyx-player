/**
 * Message bref de l'appli (AppNotice) : un message envoyé par showAppNotice s'affiche, puis
 * s'efface seul après quelques secondes.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, values?: Record<string, string>) => `texte:${key}${values ? JSON.stringify(values) : ''}` }),
}));

import AppNotice from '../AppNotice';
import { showAppNotice, APP_NOTICE_MS } from '../../../utils/appNotice';

afterEach(() => vi.useRealTimers());

describe('AppNotice', () => {
  it('vide tant qu\'aucun message n\'est envoyé', () => {
    render(<AppNotice />);
    const zone = screen.getByTestId('app-notice');
    expect(zone).toHaveAttribute('role', 'status');
    expect(zone).toBeEmptyDOMElement();
    // Sous <body>, hors de #root : au-dessus des panneaux rendus sous <body> (fiche résumé du bas)
    expect(zone.parentElement).toBe(document.body);
  });

  it('affiche le message traduit, puis l\'efface après le délai', () => {
    vi.useFakeTimers();
    render(<AppNotice />);

    act(() => showAppNotice('watchlist_update_failed'));
    expect(screen.getByTestId('app-notice')).toHaveTextContent('texte:watchlist_update_failed');

    act(() => { vi.advanceTimersByTime(APP_NOTICE_MS - 1); });
    expect(screen.getByTestId('app-notice')).toHaveTextContent('texte:watchlist_update_failed');

    act(() => { vi.advanceTimersByTime(1); });
    expect(screen.getByTestId('app-notice')).toBeEmptyDOMElement();
  });

  it('un nouveau message relance le délai', () => {
    vi.useFakeTimers();
    render(<AppNotice />);

    act(() => showAppNotice('watchlist_update_failed'));
    act(() => { vi.advanceTimersByTime(APP_NOTICE_MS - 1000); });
    act(() => showAppNotice('watchlist_update_failed'));
    act(() => { vi.advanceTimersByTime(2000); });
    expect(screen.getByTestId('app-notice')).toHaveTextContent('texte:watchlist_update_failed');
  });

  it('message avec valeurs et durée propre (connexion par QR code : 10 s)', () => {
    vi.useFakeTimers();
    render(<AppNotice />);
    act(() => showAppNotice('tvlink_connected_account', { values: { email: 'a@b.c' }, ms: 10_000 }));
    expect(screen.getByTestId('app-notice')).toHaveTextContent('texte:tvlink_connected_account{"email":"a@b.c"}');
    act(() => { vi.advanceTimersByTime(APP_NOTICE_MS); });
    expect(screen.getByTestId('app-notice')).not.toBeEmptyDOMElement();
    act(() => { vi.advanceTimersByTime(10_000 - APP_NOTICE_MS); });
    expect(screen.getByTestId('app-notice')).toBeEmptyDOMElement();
  });
});
