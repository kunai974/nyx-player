/**
 * Réglages > Sources, formulaire des identifiants du fournisseur (lot C de l'audit de couverture).
 * Identifiants factices uniquement : aucun appel réseau, l'enregistrement est simulé.
 * Vérifie : affichage masqué hors édition, champs manquants, lien Xtream mal formé ou incomplet,
 * enregistrement réussi, refus du fournisseur (identifiants faux ou serveur injoignable), annulation.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import type { XtreamCredentials } from '../../../types/iptv';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'fr' } }),
}));
// networkService lit le DNS choisi dans les réglages : sans objet ici (aucun appel réseau)
vi.mock('../../../services/preferencesService', () => ({ getDnsProvider: () => 'system' }));

import SourceForm from '../SourceForm';

const creds = { host: 'http://fournisseur.invalid:8080', username: 'jean', password: 'secret-factice' };

const inputs = () => document.querySelectorAll<HTMLInputElement>('.edit-fields input');
const textarea = () => document.querySelector<HTMLTextAreaElement>('.edit-fields textarea')!;
const button = (label: string) => screen.getByText(label).closest('button')!;
const type = (el: HTMLInputElement | HTMLTextAreaElement, value: string) =>
  fireEvent.change(el, { target: { value } });

let onEditingChange: Mock<(editing: boolean) => void>;
let onCredentialsChange: Mock<(creds: XtreamCredentials) => Promise<void>>;

beforeEach(() => {
  onEditingChange = vi.fn();
  onCredentialsChange = vi.fn(async () => {});
});

const renderForm = (isEditing = true, withSave = true) =>
  render(
    <SourceForm
      credentials={creds}
      isEditing={isEditing}
      onEditingChange={onEditingChange}
      onCredentialsChange={withSave ? onCredentialsChange : undefined}
    />,
  );

describe('SourceForm — lecture seule', () => {
  it('montre le serveur et l\'utilisateur, jamais le mot de passe', () => {
    renderForm(false);
    expect(screen.getByText(creds.host)).toBeInTheDocument();
    expect(screen.getByText(creds.username)).toBeInTheDocument();
    expect(screen.queryByText(creds.password)).toBeNull();
    expect(screen.getByText('••••••••')).toBeInTheDocument();
    expect(document.querySelector('.edit-source-form')).toBeNull();
  });
});

describe('SourceForm — mode Xtream Codes', () => {
  it('préremplit les champs avec les identifiants actuels, mot de passe caché', () => {
    renderForm();
    const [host, user, pass] = inputs();
    expect(host.value).toBe(creds.host);
    expect(user.value).toBe(creds.username);
    expect(pass.value).toBe(creds.password);
    expect(pass.type).toBe('password');
  });

  it('champ vide : message « remplir tous les champs », rien n\'est envoyé', async () => {
    renderForm();
    type(inputs()[1], '');
    await act(async () => { fireEvent.click(screen.getByText('save')); });
    expect(screen.getByText('error_missing_fields')).toBeInTheDocument();
    expect(onCredentialsChange).not.toHaveBeenCalled();
    expect(onEditingChange).not.toHaveBeenCalled();
  });

  it('enregistrement réussi : nouveaux identifiants envoyés puis formulaire refermé', async () => {
    renderForm();
    type(inputs()[1], 'paul');
    type(inputs()[2], 'autre-factice');
    await act(async () => { fireEvent.click(screen.getByText('save')); });
    expect(onCredentialsChange).toHaveBeenCalledWith({ host: creds.host, username: 'paul', password: 'autre-factice' });
    expect(onEditingChange).toHaveBeenCalledWith(false);
  });

  it('identifiants refusés par le fournisseur : message « mot de passe refusé », formulaire gardé ouvert', async () => {
    onCredentialsChange.mockRejectedValueOnce(new Error('Authentication failed'));
    renderForm();
    await act(async () => { fireEvent.click(screen.getByText('save')); });
    expect(screen.getByText('error_credentials_rejected')).toBeInTheDocument();
    expect(screen.queryByText('error_credentials')).toBeNull();
    expect(screen.queryByText('auth:error_provider_unavailable')).toBeNull();
    expect(onEditingChange).not.toHaveBeenCalled();
    expect(button('save')).not.toBeDisabled();
  });

  it('certificat https refusé : message dédié, pas « serveur injoignable »', async () => {
    onCredentialsChange.mockRejectedValueOnce('provider_certificate_error: invalid peer certificate: UnknownIssuer');
    renderForm();
    await act(async () => { fireEvent.click(screen.getByText('save')); });
    expect(screen.getByText('auth:error_provider_certificate')).toBeInTheDocument();
    expect(screen.queryByText('auth:error_provider_unavailable')).toBeNull();
  });

  it('abonnement expiré ou suspendu chez le fournisseur : message dédié, formulaire gardé ouvert', async () => {
    onCredentialsChange.mockRejectedValueOnce(new Error('provider_account_inactive'));
    renderForm();
    await act(async () => { fireEvent.click(screen.getByText('save')); });
    expect(screen.getByText('auth:error_provider_account_inactive')).toBeInTheDocument();
    expect(screen.queryByText('error_credentials')).toBeNull();
    expect(onEditingChange).not.toHaveBeenCalled();
  });

  it('adresse player_api.php complète collée, identifiants vidés : serveur et identifiants en sont tirés', async () => {
    renderForm();
    type(inputs()[0], 'http://autre.invalid:8080/player_api.php?username=paul&password=autre-factice');
    type(inputs()[1], '');
    type(inputs()[2], '');
    await act(async () => { fireEvent.click(screen.getByText('save')); });
    expect(onCredentialsChange).toHaveBeenCalledWith({ host: 'http://autre.invalid:8080', username: 'paul', password: 'autre-factice' });
  });

  it('autre échec (enregistrement local, erreur inconnue) : message générique, pas « mot de passe refusé »', async () => {
    onCredentialsChange.mockRejectedValueOnce(new Error('database is locked'));
    renderForm();
    await act(async () => { fireEvent.click(screen.getByText('save')); });
    expect(screen.getByText('error_credentials')).toBeInTheDocument();
    expect(screen.queryByText('error_credentials_rejected')).toBeNull();
    expect(onEditingChange).not.toHaveBeenCalled();
  });

  it('fournisseur injoignable : message « serveur injoignable », et le bouton redevient utilisable pour réessayer', async () => {
    onCredentialsChange.mockRejectedValueOnce('provider_server_error: HTTP 503');
    renderForm();
    await act(async () => { fireEvent.click(screen.getByText('save')); });
    expect(screen.getByText('auth:error_provider_unavailable')).toBeInTheDocument();
    expect(screen.queryByText('error_credentials')).toBeNull();
    expect(screen.queryByText('error_credentials_rejected')).toBeNull();

    await act(async () => { fireEvent.click(screen.getByText('save')); });
    expect(onCredentialsChange).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('auth:error_provider_unavailable')).toBeNull();
    expect(onEditingChange).toHaveBeenCalledWith(false);
  });

  it.each([
    ['délai dépassé', 'provider_unreachable: error sending request: operation timed out'],
    ['adresse introuvable (DNS)', 'provider_unreachable: error trying to connect: dns error: no record found'],
  ])('serveur injoignable (%s) : message « serveur injoignable », pas « identifiants faux »', async (_label, failure) => {
    onCredentialsChange.mockRejectedValueOnce(failure);
    renderForm();
    await act(async () => { fireEvent.click(screen.getByText('save')); });
    expect(screen.getByText('auth:error_provider_unavailable')).toBeInTheDocument();
    expect(screen.queryByText('error_credentials')).toBeNull();
    expect(onEditingChange).not.toHaveBeenCalled();
  });

  it('pendant l\'enregistrement : boutons désactivés et libellé « enregistrement »', async () => {
    let finish: () => void = () => {};
    onCredentialsChange.mockImplementationOnce(() => new Promise<void>((r) => { finish = r; }));
    renderForm();
    await act(async () => { fireEvent.click(screen.getByText('save')); });
    expect(button('saving')).toBeDisabled();
    expect(button('cancel')).toBeDisabled();
    await act(async () => { finish(); });
    expect(onEditingChange).toHaveBeenCalledWith(false);
  });

  it('sans fonction d\'enregistrement : le bouton ne fait rien', async () => {
    renderForm(true, false);
    await act(async () => { fireEvent.click(screen.getByText('save')); });
    expect(onEditingChange).not.toHaveBeenCalled();
  });

  it('annuler : formulaire refermé, erreur effacée, saisie remise aux identifiants actuels', async () => {
    const { rerender } = renderForm();
    type(inputs()[0], '');
    await act(async () => { fireEvent.click(screen.getByText('save')); });
    expect(screen.getByText('error_missing_fields')).toBeInTheDocument();

    fireEvent.click(screen.getByText('cancel'));
    expect(onEditingChange).toHaveBeenCalledWith(false);
    expect(screen.queryByText('error_missing_fields')).toBeNull();

    // Réouverture par le parent : les anciennes valeurs sont revenues
    rerender(<SourceForm credentials={creds} isEditing onEditingChange={onEditingChange} onCredentialsChange={onCredentialsChange} />);
    expect(inputs()[0].value).toBe(creds.host);
  });

  it('identifiants changés ailleurs : les champs suivent', () => {
    const { rerender } = renderForm();
    const next = { host: 'http://nouveau.invalid', username: 'luc', password: 'x' };
    rerender(<SourceForm credentials={next} isEditing onEditingChange={onEditingChange} onCredentialsChange={onCredentialsChange} />);
    expect(inputs()[0].value).toBe(next.host);
    expect(inputs()[1].value).toBe('luc');
  });
});

describe('SourceForm — lien Xtream (M3U)', () => {
  const openM3u = () => fireEvent.click(screen.getByText('tab_m3u'));

  it('onglet lien : un seul champ texte et l\'onglet marqué actif', () => {
    renderForm();
    openM3u();
    expect(textarea()).toBeInTheDocument();
    expect(screen.getByText('tab_m3u')).toHaveClass('active');
    expect(screen.getByText('Xtream Codes')).not.toHaveClass('active');
  });

  it('lien complet : serveur, utilisateur et mot de passe en sont tirés', async () => {
    renderForm();
    openM3u();
    type(textarea(), 'http://lien.invalid:8000/get.php?username=ana&password=p%40ss&type=m3u_plus');
    await act(async () => { fireEvent.click(screen.getByText('save')); });
    expect(onCredentialsChange).toHaveBeenCalledWith({ host: 'http://lien.invalid:8000', username: 'ana', password: 'p@ss' });
  });

  it('« + » dans les identifiants gardé tel quel', async () => {
    renderForm();
    openM3u();
    type(textarea(), 'http://lien.invalid/get.php?username=a+b&password=c+d');
    await act(async () => { fireEvent.click(screen.getByText('save')); });
    expect(onCredentialsChange).toHaveBeenCalledWith({ host: 'http://lien.invalid', username: 'a+b', password: 'c+d' });
  });

  it('lien sans mot de passe : message « champs manquants », rien n\'est envoyé', async () => {
    renderForm();
    openM3u();
    type(textarea(), 'http://lien.invalid/get.php?username=ana');
    await act(async () => { fireEvent.click(screen.getByText('save')); });
    expect(screen.getByText('error_missing_fields (username/password)')).toBeInTheDocument();
    expect(onCredentialsChange).not.toHaveBeenCalled();
  });

  it('texte qui n\'est pas un lien : message « lien invalide »', async () => {
    renderForm();
    openM3u();
    type(textarea(), 'pas un lien');
    await act(async () => { fireEvent.click(screen.getByText('save')); });
    expect(screen.getByText('error_invalid_m3u')).toBeInTheDocument();
    expect(onCredentialsChange).not.toHaveBeenCalled();
  });

  it('annuler depuis l\'onglet lien : retour sur l\'onglet Xtream Codes, lien vidé', async () => {
    const { rerender } = renderForm();
    openM3u();
    type(textarea(), 'http://lien.invalid/get.php?username=a&password=b');
    fireEvent.click(screen.getByText('cancel'));
    rerender(<SourceForm credentials={creds} isEditing onEditingChange={onEditingChange} onCredentialsChange={onCredentialsChange} />);
    await waitFor(() => expect(screen.getByText('Xtream Codes')).toHaveClass('active'));
    openM3u();
    expect(textarea().value).toBe('');
  });
});
