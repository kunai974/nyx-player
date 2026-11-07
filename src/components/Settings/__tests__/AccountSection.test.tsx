/**
 * Écran Compte des Réglages : le fichier a été découpé en un bloc par réglage
 * (`Settings/account/`). Ces tests fixent le comportement de chaque bloc pour que le découpage
 * ne change rien : vérifications dans le même ordre, mot de passe actuel contrôlé avant toute
 * modification, marque de suppression de compte posée et retirée aux mêmes moments.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { auth, invoke, fullReset, deletion, rename, dev } = vi.hoisted(() => ({
  auth: {
    signInWithPassword: vi.fn(),
    updateUser: vi.fn(),
    getSession: vi.fn(),
    admin: { signOut: vi.fn() },
  },
  invoke: vi.fn(),
  fullReset: vi.fn(),
  deletion: { mark: vi.fn(), clear: vi.fn(), confirm: vi.fn() },
  rename: vi.fn(),
  dev: { settingsPage: {} as Record<string, unknown> },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'fr' } }),
}));
vi.mock('../../../services/supabaseClient', () => ({
  supabase: { auth, functions: { invoke } },
}));
vi.mock('../../../contexts/SupabaseAuthContext', () => ({
  useSupabaseAuth: () => ({ user: { id: 'u1', email: 'moi@test.invalid' } }),
}));
vi.mock('../../../services/fullResetService', () => ({ performFullReset: fullReset }));
vi.mock('../../../services/accountDeletion', () => ({
  markAccountDeletionPending: deletion.mark,
  clearAccountDeletionPending: deletion.clear,
  confirmAccountDeletion: deletion.confirm,
}));
vi.mock('../../../services/profileService', () => ({ updateProfileName: rename }));
vi.mock('../../../contexts/DevOverrideContext', async () => {
  const actual = await vi.importActual<typeof import('../../../contexts/DevOverrideContext')>(
    '../../../contexts/DevOverrideContext',
  );
  return {
    ...actual,
    useDevOverrides: () => ({
      overrides: { settingsPage: { ...actual.SETTINGS_OVERRIDES_DEFAULT, ...dev.settingsPage } },
    }),
  };
});

import AccountSection from '../AccountSection';
import { clearCloudRefusal, noteCloudRefusal } from '../../../services/sync/cloudRefusal';

const type = (placeholder: string, value: string, index = 0) => {
  fireEvent.change(screen.getAllByPlaceholderText(placeholder)[index], { target: { value } });
};
const click = (name: string, index = 0) => fireEvent.click(screen.getAllByText(name)[index]);

beforeEach(() => {
  vi.clearAllMocks();
  dev.settingsPage = {};
  auth.signInWithPassword.mockResolvedValue({ error: null });
  auth.getSession.mockResolvedValue({ data: { session: null }, error: null });
  auth.admin.signOut.mockResolvedValue({ data: null, error: null });
  auth.updateUser.mockResolvedValue({ error: null });
  invoke.mockResolvedValue({ error: null });
  fullReset.mockResolvedValue(undefined);
  rename.mockResolvedValue(undefined);
});

describe('AccountSection — affichage', () => {
  it('montre le profil, l\'adresse et quatre boutons, sans formulaire ouvert', () => {
    render(<AccountSection profileName="Salon" profileId="p1" />);
    expect(screen.getByText('account_section_title')).toBeTruthy();
    expect(screen.getByText('Salon')).toBeTruthy();
    expect(screen.getByText('moi@test.invalid')).toBeTruthy();
    expect(screen.getAllByText('account_change')).toHaveLength(3);
    expect(screen.getByText('account_delete_btn')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(document.querySelectorAll('.settings-separator')).toHaveLength(3);
  });

  // Un envoi refusé par la base (borne dépassée) ne passe plus en silence
  it('signale un envoi refusé par le serveur, et rien sinon', () => {
    clearCloudRefusal();
    const { unmount } = render(<AccountSection profileName="Salon" profileId="p1" />);
    expect(screen.queryByText('account_sync_refused')).toBeNull();
    unmount();
    noteCloudRefusal();
    render(<AccountSection profileName="Salon" profileId="p1" />);
    expect(screen.getByRole('status').textContent).toBe('account_sync_refused');
    clearCloudRefusal();
  });

  it('affiche un tiret sans nom de profil', () => {
    render(<AccountSection />);
    expect(screen.getByText('—')).toBeTruthy();
  });

  it('ouvre les quatre formulaires forcés par le panneau de développement', () => {
    dev.settingsPage = {
      forceProfileRename: true,
      forceEmailForm: true,
      forcePasswordForm: true,
      forceDeleteConfirm: true,
    };
    render(<AccountSection profileName="Salon" profileId="p1" />);
    expect(screen.queryByText('account_change')).toBeNull();
    expect(screen.queryByText('account_delete_btn')).toBeNull();
    expect(screen.getByPlaceholderText('account_new_profile_name')).toBeTruthy();
    expect(screen.getByPlaceholderText('account_new_email')).toBeTruthy();
    expect(screen.getByPlaceholderText('account_new_password')).toBeTruthy();
    expect(screen.getByText('account_delete_warning')).toBeTruthy();
    // Mot de passe actuel : formulaires email, mot de passe et suppression
    expect(screen.getAllByPlaceholderText('account_current_password')).toHaveLength(3);
  });

  it('montre chargement, erreur et succès forcés sur le bon bloc', () => {
    dev.settingsPage = { forcePasswordForm: true, forceAccountLoading: 'password', forceAccountError: 'password' };
    const { unmount } = render(<AccountSection />);
    expect(screen.getByText('Simulated password error')).toBeTruthy();
    expect(screen.getByText('…').closest('button')?.disabled).toBe(true);
    unmount();

    dev.settingsPage = { forceAccountSuccess: 'email' };
    render(<AccountSection />);
    expect(screen.getByText('Email change sent!')).toBeTruthy();
  });

  it('l\'œil montre puis cache le mot de passe', () => {
    render(<AccountSection />);
    click('account_change', 2);
    const input = screen.getByPlaceholderText('account_new_password') as HTMLInputElement;
    expect(input.type).toBe('password');
    const eye = input.parentElement!.querySelector('button')!;
    expect(eye.getAttribute('aria-label')).toBe('password_show');
    expect(eye.tabIndex).toBe(-1);
    fireEvent.click(eye);
    expect(input.type).toBe('text');
    expect(eye.getAttribute('aria-label')).toBe('password_hide');
  });
});

describe('AccountSection — nom du profil', () => {
  it('pré-remplit le nom actuel, refuse un nom vide', () => {
    render(<AccountSection profileName="Salon" profileId="p1" />);
    click('account_change', 0);
    const input = screen.getByPlaceholderText('account_new_profile_name') as HTMLInputElement;
    expect(input.value).toBe('Salon');
    type('account_new_profile_name', '   ');
    click('account_save');
    expect(screen.getByText('account_profile_name_required')).toBeTruthy();
    expect(rename).not.toHaveBeenCalled();
  });

  it('refuse sans identifiant de profil', () => {
    render(<AccountSection profileName="Salon" />);
    click('account_change', 0);
    click('account_save');
    expect(screen.getByText('unexpected_error')).toBeTruthy();
  });

  it('renomme avec le nom sans espaces autour, ferme le formulaire et prévient la page', async () => {
    const onRenamed = vi.fn();
    render(<AccountSection profileName="Salon" profileId="p1" onProfileRenamed={onRenamed} />);
    click('account_change', 0);
    type('account_new_profile_name', '  Chambre ');
    click('account_save');
    await screen.findByText('account_profile_renamed');
    expect(rename).toHaveBeenCalledWith('u1', 'p1', 'Chambre');
    expect(onRenamed).toHaveBeenCalledTimes(1);
    expect(screen.queryByPlaceholderText('account_new_profile_name')).toBeNull();
  });

  it('affiche l\'erreur générique si le renommage échoue', async () => {
    rename.mockRejectedValue(new Error('boom'));
    render(<AccountSection profileName="Salon" profileId="p1" />);
    click('account_change', 0);
    click('account_save');
    await screen.findByText('unexpected_error');
    expect(screen.getByPlaceholderText('account_new_profile_name')).toBeTruthy();
  });

  it('Annuler ferme le formulaire et efface l\'erreur', () => {
    render(<AccountSection profileName="" profileId="p1" />);
    click('account_change', 0);
    click('account_save');
    expect(screen.getByText('account_profile_name_required')).toBeTruthy();
    click('cancel');
    expect(screen.queryByText('account_profile_name_required')).toBeNull();
    click('account_change', 0);
    expect(screen.queryByText('account_profile_name_required')).toBeNull();
  });
});

describe('AccountSection — adresse email', () => {
  const open = () => { render(<AccountSection />); click('account_change', 1); };

  it('demande d\'abord le mot de passe, puis une adresse valide', () => {
    open();
    click('account_confirm');
    expect(screen.getByText('account_current_password_required')).toBeTruthy();
    type('account_current_password', 'secret');
    type('account_new_email', 'sans-arobase');
    click('account_confirm');
    expect(screen.getByText('account_email_invalid')).toBeTruthy();
    expect(auth.signInWithPassword).not.toHaveBeenCalled();
  });

  it('mot de passe faux : rien n\'est modifié', async () => {
    auth.signInWithPassword.mockResolvedValue({ error: { name: 'AuthApiError', status: 400, code: 'invalid_credentials', message: 'Invalid login credentials' } });
    open();
    type('account_current_password', 'faux');
    type('account_new_email', 'nouveau@test.invalid');
    click('account_confirm');
    await screen.findByText('account_current_password_wrong');
    expect(auth.signInWithPassword).toHaveBeenCalledWith({ email: 'moi@test.invalid', password: 'faux' });
    expect(auth.updateUser).not.toHaveBeenCalled();
  });

  it('envoie le changement et ferme le formulaire', async () => {
    open();
    type('account_current_password', 'secret');
    type('account_new_email', 'nouveau@test.invalid');
    click('account_confirm');
    await screen.findByText('account_email_change_sent');
    expect(auth.updateUser).toHaveBeenCalledWith({ email: 'nouveau@test.invalid' });
    expect(screen.queryByPlaceholderText('account_new_email')).toBeNull();
  });

  it('Annuler vide les champs, efface l\'erreur et recache le mot de passe', () => {
    open();
    type('account_current_password', 'secret');
    type('account_new_email', 'x');
    click('account_confirm');
    const eye = screen.getByPlaceholderText('account_current_password').parentElement!.querySelector('button')!;
    fireEvent.click(eye);
    click('cancel');
    click('account_change', 1);
    const pwd = screen.getByPlaceholderText('account_current_password') as HTMLInputElement;
    expect(pwd.value).toBe('');
    expect(pwd.type).toBe('password');
    expect((screen.getByPlaceholderText('account_new_email') as HTMLInputElement).value).toBe('');
    expect(screen.queryByText('account_email_invalid')).toBeNull();
  });

  it('réussite : le mot de passe est recaché à la réouverture', async () => {
    open();
    type('account_current_password', 'secret');
    type('account_new_email', 'nouveau@test.invalid');
    fireEvent.click(screen.getByPlaceholderText('account_current_password').parentElement!.querySelector('button')!);
    click('account_confirm');
    await screen.findByText('account_email_change_sent');
    click('account_change', 1);
    expect((screen.getByPlaceholderText('account_current_password') as HTMLInputElement).type).toBe('password');
  });

  it('refus du serveur : message traduit, jamais le texte anglais de Supabase', async () => {
    auth.updateUser.mockResolvedValue({ error: { name: 'AuthApiError', status: 422, code: 'email_exists', message: 'Email address already registered' } });
    open();
    type('account_current_password', 'secret');
    type('account_new_email', 'nouveau@test.invalid');
    click('account_confirm');
    await screen.findByText('auth_error_user_exists');
    expect(screen.queryByText('Email address already registered')).toBeNull();
  });

  it('hors ligne : la vraie raison, plus « mot de passe actuel incorrect »', async () => {
    auth.signInWithPassword.mockResolvedValue({ error: { name: 'AuthRetryableFetchError', status: 0, message: 'Failed to fetch' } });
    open();
    type('account_current_password', 'secret');
    type('account_new_email', 'nouveau@test.invalid');
    click('account_confirm');
    await screen.findByText('auth_error_offline');
    expect(screen.queryByText('account_current_password_wrong')).toBeNull();
    expect(auth.updateUser).not.toHaveBeenCalled();
  });
});

describe('AccountSection — mot de passe', () => {
  const open = () => { render(<AccountSection />); click('account_change', 2); };

  it('vérifie dans l\'ordre : actuel, longueur, confirmation', () => {
    open();
    click('account_confirm');
    expect(screen.getByText('account_current_password_required')).toBeTruthy();
    type('account_current_password', 'ancien');
    type('account_new_password', 'court');
    click('account_confirm');
    expect(screen.getByText('account_password_min_length')).toBeTruthy();
    type('account_new_password', 'assezlong!');
    type('account_confirm_new_password', 'different');
    click('account_confirm');
    expect(screen.getByText('account_passwords_no_match')).toBeTruthy();
    expect(auth.signInWithPassword).not.toHaveBeenCalled();
  });

  const fill = () => {
    type('account_current_password', 'ancien');
    type('account_new_password', 'assezlong!');
    type('account_confirm_new_password', 'assezlong!');
    click('account_confirm');
  };

  it('mot de passe actuel faux : rien n\'est modifié', async () => {
    auth.signInWithPassword.mockResolvedValue({ error: { name: 'AuthApiError', status: 400, code: 'invalid_credentials', message: 'Invalid login credentials' } });
    open();
    fill();
    await screen.findByText('account_current_password_wrong');
    expect(auth.updateUser).not.toHaveBeenCalled();
  });

  it('change le mot de passe et ferme le formulaire', async () => {
    open();
    fill();
    await screen.findByText('account_password_updated');
    expect(auth.signInWithPassword).toHaveBeenCalledWith({ email: 'moi@test.invalid', password: 'ancien' });
    expect(auth.updateUser).toHaveBeenCalledWith({ password: 'assezlong!', current_password: 'ancien' });
    expect(screen.queryByPlaceholderText('account_new_password')).toBeNull();
    // Rouvert : champs vides, message de réussite retiré
    click('account_change', 2);
    expect((screen.getByPlaceholderText('account_new_password') as HTMLInputElement).value).toBe('');
    expect(screen.queryByText('account_password_updated')).toBeNull();
  });

  it('Annuler vide les trois champs et recache les mots de passe', () => {
    open();
    for (const p of ['account_current_password', 'account_new_password', 'account_confirm_new_password']) {
      type(p, 'quelquechose');
      fireEvent.click(screen.getByPlaceholderText(p).parentElement!.querySelector('button')!);
    }
    click('cancel');
    click('account_change', 2);
    for (const p of ['account_current_password', 'account_new_password', 'account_confirm_new_password']) {
      const input = screen.getByPlaceholderText(p) as HTMLInputElement;
      expect(input.value).toBe('');
      expect(input.type).toBe('password');
    }
  });

  it('réussite : les yeux restent comme ils étaient (seul Annuler les referme)', async () => {
    open();
    fireEvent.click(screen.getByPlaceholderText('account_new_password').parentElement!.querySelector('button')!);
    fill();
    await screen.findByText('account_password_updated');
    click('account_change', 2);
    expect((screen.getByPlaceholderText('account_new_password') as HTMLInputElement).type).toBe('text');
  });

  it('erreur inattendue : message générique traduit', async () => {
    auth.signInWithPassword.mockRejectedValue(new Error('réseau'));
    open();
    fill();
    await screen.findByText('auth_error_generic');
  });

  it('trop d\'essais (429) : la vraie raison, plus « mot de passe actuel incorrect »', async () => {
    auth.signInWithPassword.mockResolvedValue({ error: { name: 'AuthApiError', status: 429, code: 'over_request_rate_limit', message: 'Request rate limit reached' } });
    open();
    fill();
    await screen.findByText('auth_error_rate_limit');
    expect(screen.queryByText('account_current_password_wrong')).toBeNull();
  });
});

describe('AccountSection — suppression du compte', () => {
  const open = () => { render(<AccountSection />); click('account_delete_btn'); };
  const confirm = (pwd = 'secret') => {
    type('account_current_password', pwd);
    click('account_delete_confirm');
  };

  it('demande le mot de passe', () => {
    open();
    click('account_delete_confirm');
    expect(screen.getByText('account_current_password_required')).toBeTruthy();
    expect(deletion.mark).not.toHaveBeenCalled();
  });

  it('mot de passe faux : aucune marque, aucun appel au serveur', async () => {
    auth.signInWithPassword.mockResolvedValue({ error: { name: 'AuthApiError', status: 400, code: 'invalid_credentials', message: 'Invalid login credentials' } });
    open();
    confirm('faux');
    await screen.findByText('account_current_password_wrong');
    expect(deletion.mark).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('pose la marque avant l\'appel, puis réinitialise tout', async () => {
    open();
    confirm();
    await waitFor(() => expect(fullReset).toHaveBeenCalledWith({ deleteAccount: true }));
    expect(invoke).toHaveBeenCalledWith('delete-account', { method: 'POST' });
    expect(deletion.mark.mock.invocationCallOrder[0]).toBeLessThan(invoke.mock.invocationCallOrder[0]);
    expect(deletion.clear).not.toHaveBeenCalled();
    // Suppression confirmée par le serveur, avant le nettoyage
    expect(deletion.confirm).toHaveBeenCalledTimes(1);
    expect(deletion.confirm.mock.invocationCallOrder[0]).toBeLessThan(fullReset.mock.invocationCallOrder[0]);
  });

  it('refus du serveur : marque retirée, message traduit (plus le texte brut du serveur)', async () => {
    invoke.mockResolvedValue({ error: { name: 'FunctionsHttpError', message: 'Edge Function returned a non-2xx status code' } });
    open();
    confirm();
    await screen.findByText('account_delete_error');
    expect(deletion.clear).toHaveBeenCalledTimes(1);
    expect(fullReset).not.toHaveBeenCalled();
  });

  it('réponse perdue (réseau) : la marque reste pour le prochain lancement', async () => {
    invoke.mockResolvedValue({ error: { name: 'FunctionsFetchError', message: '' } });
    open();
    confirm();
    await screen.findByText('account_delete_unconfirmed');
    expect(deletion.clear).not.toHaveBeenCalled();
    // Le compte existe peut-être encore : sa base et ses identifiants ne seront pas visés
    expect(deletion.confirm).not.toHaveBeenCalled();
  });

  it('erreur inattendue : marque retirée, message générique', async () => {
    invoke.mockRejectedValue(new Error('boom'));
    open();
    confirm();
    await screen.findByText('account_delete_error');
    expect(deletion.clear).toHaveBeenCalledTimes(1);
  });

  it('pendant la vérification : bouton désactivé, puis suppression menée une seule fois', async () => {
    let answer: (v: unknown) => void = () => {};
    auth.signInWithPassword.mockImplementationOnce(() => new Promise((r) => { answer = r; }));
    open();
    confirm();
    const busy = screen.getByText('…').closest('button')!;
    expect(busy).toBeDisabled();
    // La session en cours est lue avant la reconnexion : attendre que celle-ci soit partie
    await waitFor(() => expect(auth.signInWithPassword).toHaveBeenCalledTimes(1));
    expect(busy).toBeDisabled();
    answer({ error: null });
    await waitFor(() => expect(fullReset).toHaveBeenCalledTimes(1));
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('l\'œil du mot de passe de suppression le montre puis le recache', () => {
    open();
    const input = screen.getByPlaceholderText('account_current_password') as HTMLInputElement;
    const eye = input.parentElement!.querySelector('button')!;
    fireEvent.click(eye);
    expect(input.type).toBe('text');
    fireEvent.click(eye);
    expect(input.type).toBe('password');
  });

  it('Annuler referme la zone de suppression et vide le mot de passe', () => {
    open();
    expect(screen.getByText('account_delete_warning')).toBeTruthy();
    type('account_current_password', 'secret');
    click('cancel');
    expect(screen.queryByText('account_delete_warning')).toBeNull();
    expect(screen.getByText('account_delete_btn')).toBeTruthy();
    click('account_delete_btn');
    expect((screen.getByPlaceholderText('account_current_password') as HTMLInputElement).value).toBe('');
  });
});
