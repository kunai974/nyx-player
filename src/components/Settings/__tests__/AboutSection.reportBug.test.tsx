/**
 * Réglages > À propos > « Signaler un problème » : le texte était coupé à 500 caractères, et une
 * liste de demandes (retour Sentry du 02/11) est arrivée tronquée au milieu d'une phrase. La limite
 * est maintenant de 2 000 caractères, et le retour envoyé garde tout le texte.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

const sentry = vi.hoisted(() => ({ captureFeedback: vi.fn() }));

vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }));
vi.mock('@tauri-apps/api/app', () => ({ getVersion: vi.fn(async () => '9.9.9') }));
vi.mock('@sentry/react', () => sentry);
vi.mock('../../../contexts/UpdaterContext', () => ({
  useUpdater: () => ({ status: 'idle', version: null, checkForUpdate: vi.fn() }),
}));
vi.mock('../../../contexts/DevOverrideContext', () => ({
  useDevOverrides: () => ({ overrides: { settingsPage: {} } }),
}));
vi.mock('../ThirdPartyLicensesModal', () => ({ default: () => null }));

import { i18nReady } from '../../../i18n/config';
import AboutSection from '../AboutSection';

async function ouvrirFormulaire(): Promise<HTMLTextAreaElement> {
  await act(async () => { render(<AboutSection />); });
  fireEvent.click(screen.getByTestId('settings-report-bug'));
  return screen.getByTestId('settings-report-bug-text') as HTMLTextAreaElement;
}

describe('À propos : signaler un problème', () => {
  beforeAll(async () => { await i18nReady; });

  it('accepte jusqu’à 2 000 caractères', async () => {
    const zone = await ouvrirFormulaire();
    expect(zone.maxLength).toBe(2000);
    fireEvent.change(zone, { target: { value: 'a'.repeat(1500) } });
    expect(zone.value).toHaveLength(1500);
    fireEvent.change(zone, { target: { value: 'b'.repeat(2500) } });
    expect(zone.value).toHaveLength(2000);
  });

  it('envoie le texte entier, précédé de la version', async () => {
    sentry.captureFeedback.mockClear();
    const zone = await ouvrirFormulaire();
    const texte = 'x'.repeat(1200);
    fireEvent.change(zone, { target: { value: texte } });
    await act(async () => { fireEvent.click(screen.getByTestId('settings-report-bug-send')); });
    expect(sentry.captureFeedback).toHaveBeenCalledWith({ message: `[v9.9.9] ${texte}`, name: 'Testeur' });
  });
});
