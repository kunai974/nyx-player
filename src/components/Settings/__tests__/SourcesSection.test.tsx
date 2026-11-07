/**
 * Réglages > Sources (lot C de l'audit de couverture) : boutons Actualiser et Modifier, alerte du
 * fournisseur, barre d'actualisation, changement d'identifiants, actualisation automatique et
 * interrupteur du guide TV (synchro, nouvel essai, échec, désactivation avec effacement).
 * Le guide, la base et le fournisseur sont simulés : aucun réseau, identifiants factices.
 * La fin de synchro annoncée par Rust est couverte à part (SourcesSectionEpgEvents.test.tsx).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import type { AutoRefreshInfo } from '../../../services/catalogAutoRefresh';

const { epg, prefs, autoRefresh, db, platform, rust } = vi.hoisted(() => ({
  epg: {
    syncing: false,
    syncEpg: vi.fn(),
    purgeEpgData: vi.fn(),
    requestSyncAbort: vi.fn(),
    cancelAbort: vi.fn(),
  },
  prefs: { wifiOnly: false, setEpgWifiOnly: vi.fn(), titleSearch: true, setTmdbTitleSearch: vi.fn(async (_enabled: boolean) => {}) },
  autoRefresh: { get: vi.fn(), set: vi.fn() },
  db: { programs: 0, matched: 0, reads: 0, tooLarge: null as string | null },
  platform: { mobile: false },
  rust: { progress: null as ((e: { payload: unknown }) => void) | null },
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((_name: string, handler: (e: { payload: unknown }) => void) => {
    rust.progress = handler;
    return Promise.resolve(() => {});
  }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key} ${JSON.stringify(opts)}` : key),
    i18n: { language: 'fr' },
  }),
}));
vi.mock('../../../services/epgService', () => ({
  syncEpg: epg.syncEpg,
  purgeEpgData: epg.purgeEpgData,
  isSyncing: () => epg.syncing,
  requestSyncAbort: epg.requestSyncAbort,
  cancelAbort: epg.cancelAbort,
}));
vi.mock('../../../services/preferencesService', () => ({
  isEpgWifiOnly: () => prefs.wifiOnly,
  setEpgWifiOnly: prefs.setEpgWifiOnly,
  isTmdbTitleSearchEnabled: () => prefs.titleSearch,
  setTmdbTitleSearch: prefs.setTmdbTitleSearch,
}));
vi.mock('../../../services/catalogAutoRefresh', () => ({
  getAutoRefreshInfo: autoRefresh.get,
  setAutoRefreshEnabled: autoRefresh.set,
}));
vi.mock('../../../services/dbCore', () => ({
  getDatabase: () => Promise.resolve({
    select: (sql: string) => {
      if (sql.includes('epg_programs')) db.reads += 1;
      return Promise.resolve([{ cnt: sql.includes('epg_programs') ? db.programs : db.matched }]);
    },
  }),
  getMeta: (key: string) => Promise.resolve(key === 'lastTooLargeLists' ? db.tooLarge : null),
}));
vi.mock('../../../utils/platform', () => ({ isMobile: () => platform.mobile, isTv: () => false }));
vi.mock('../CategoryManagerModal', () => ({
  default: ({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) =>
    isOpen ? <button aria-label="fermer-categories" onClick={onClose} /> : null,
}));

import SourcesSection from '../SourcesSection';

const credentials = { host: 'http://fournisseur.invalid', username: 'jean', password: 'secret-factice' };
const button = (label: string) => screen.getByText(label).closest('button')!;
const lastCheckbox = () => {
  const boxes = screen.getAllByRole('checkbox');
  return boxes[boxes.length - 1] as HTMLInputElement;
};
const epgToggle = () => lastCheckbox();

type Props = Partial<React.ComponentProps<typeof SourcesSection>>;
const renderSection = (props: Props = {}) =>
  render(<SourcesSection credentials={credentials} accountInfo={null} {...props} />);

/** Laisse passer les promesses en attente (lecture des statistiques, synchro simulée) */
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

beforeEach(() => {
  vi.clearAllMocks();
  epg.syncing = false;
  prefs.wifiOnly = false;
  db.programs = 0;
  db.matched = 0;
  db.reads = 0;
  db.tooLarge = null;
  platform.mobile = false;
  rust.progress = null;
  epg.syncEpg.mockResolvedValue({ programsCount: 10, durationMs: 5 });
  epg.purgeEpgData.mockResolvedValue(undefined);
  prefs.setEpgWifiOnly.mockResolvedValue(undefined);
  autoRefresh.get.mockReturnValue(new Promise(() => {}));
  autoRefresh.set.mockResolvedValue(undefined);
});

describe('SourcesSection — en-tête et alertes', () => {
  it('« Actualiser » et « Modifier » présents, identifiants en lecture seule', () => {
    const onRefreshSources = vi.fn();
    renderSection({ onRefreshSources, onCredentialsChange: vi.fn() });
    fireEvent.click(button('refresh'));
    expect(onRefreshSources).toHaveBeenCalledTimes(1);
    expect(button('edit')).toBeInTheDocument();
    expect(screen.getByText(credentials.host)).toBeInTheDocument();
    expect(screen.queryByText(credentials.password)).toBeNull();
  });

  it('sans actions fournies : ni « Actualiser » ni « Modifier »', () => {
    renderSection();
    expect(screen.queryByText('refresh')).toBeNull();
    expect(screen.queryByText('edit')).toBeNull();
  });

  it('actualisation en cours : bouton désactivé et barre de progression', () => {
    renderSection({ onRefreshSources: vi.fn(), isRefreshing: true, refreshProgress: 40 });
    expect(button('refresh')).toBeDisabled();
    expect(screen.getByText('loading_refresh 40%')).toBeInTheDocument();
    expect((document.querySelector('.refresh-progress-fill') as HTMLElement).style.width).toBe('40%');
  });

  it.each(['warning', 'error'] as const)('fournisseur en difficulté (%s) : alerte affichée', (iptvStatus) => {
    renderSection({ iptvStatus });
    expect(document.querySelector(`.iptv-status-alert--${iptvStatus}`)).not.toBeNull();
    expect(screen.getByText('iptv_status_warning')).toBeInTheDocument();
  });

  it('liste refusée car démesurée au dernier chargement : l\'alerte le dit', async () => {
    db.tooLarge = JSON.stringify(['movies']);
    renderSection({ iptvStatus: 'warning' });
    expect(await screen.findByText('iptv_too_large_desc')).toBeInTheDocument();
    expect(screen.queryByText('iptv_warning_desc')).toBeNull();
  });

  it('aucune liste démesurée : message d\'instabilité habituel', async () => {
    db.tooLarge = '[]';
    renderSection({ iptvStatus: 'warning' });
    await flush();
    expect(screen.getByText('iptv_warning_desc')).toBeInTheDocument();
  });

  it('fournisseur en ordre : pas d\'alerte', () => {
    renderSection();
    expect(document.querySelector('.iptv-status-alert')).toBeNull();
  });
});

describe('SourcesSection — changer d\'identifiants', () => {
  it('« Modifier » ouvre le formulaire et masque les boutons de l\'en-tête', () => {
    renderSection({ onRefreshSources: vi.fn(), onCredentialsChange: vi.fn() });
    fireEvent.click(button('edit'));
    expect(document.querySelector('.edit-source-form')).not.toBeNull();
    expect(screen.queryByText('refresh')).toBeNull();
    expect(screen.queryByText('edit')).toBeNull();
  });

  it('enregistrement réussi : formulaire refermé', async () => {
    const onCredentialsChange = vi.fn().mockResolvedValue(undefined);
    renderSection({ onCredentialsChange });
    fireEvent.click(button('edit'));
    await act(async () => { fireEvent.click(button('save')); });
    expect(onCredentialsChange).toHaveBeenCalledWith(credentials);
    expect(document.querySelector('.edit-source-form')).toBeNull();
    expect(button('edit')).toBeInTheDocument();
  });

  it('identifiants refusés : formulaire gardé ouvert avec le message « mot de passe refusé »', async () => {
    const onCredentialsChange = vi.fn().mockRejectedValue(new Error('Authentication failed'));
    renderSection({ onCredentialsChange });
    fireEvent.click(button('edit'));
    await act(async () => { fireEvent.click(button('save')); });
    expect(screen.getByText('error_credentials_rejected')).toBeInTheDocument();
    expect(document.querySelector('.edit-source-form')).not.toBeNull();
  });

  it('« Annuler » referme le formulaire', () => {
    renderSection({ onCredentialsChange: vi.fn() });
    fireEvent.click(button('edit'));
    fireEvent.click(button('cancel'));
    expect(document.querySelector('.edit-source-form')).toBeNull();
  });
});

describe('SourcesSection — gérer les catégories', () => {
  it('bouton présent seulement avec le catalogue chargé, et ouvre la fenêtre', () => {
    const { unmount } = renderSection();
    expect(screen.queryByText('manage_categories')).toBeNull();
    unmount();

    renderSection({ lightIndexes: {} as never });
    fireEvent.click(button('manage_categories'));
    fireEvent.click(screen.getByLabelText('fermer-categories'));
    expect(screen.queryByLabelText('fermer-categories')).toBeNull();
  });
});

describe('SourcesSection — actualisation automatique', () => {
  const info = (extra: Partial<AutoRefreshInfo> = {}): AutoRefreshInfo => ({
    enabled: true, lastUpdate: null, lastError: null, manualAdvised: false, ...extra,
  });

  it('base pas encore prête : la ligne est masquée', async () => {
    autoRefresh.get.mockRejectedValueOnce(new Error('base fermée'));
    renderSection();
    await flush();
    expect(screen.queryByText('auto_refresh_title', { exact: false })).toBeNull();
  });

  it('jamais actualisé : « jamais » affiché, interrupteur allumé', async () => {
    autoRefresh.get.mockResolvedValueOnce(info());
    renderSection();
    expect(await screen.findByText('auto_refresh_never')).toBeInTheDocument();
    expect((screen.getAllByRole('checkbox')[0] as HTMLInputElement).checked).toBe(true);
  });

  it('dernier essai en échec et beaucoup de titres retirés : les deux avertissements', async () => {
    autoRefresh.get.mockResolvedValueOnce(info({ lastUpdate: Date.now() - 3600_000, lastError: 'HTTP 503', manualAdvised: true }));
    renderSection();
    expect(await screen.findByText('auto_refresh_failed')).toBeInTheDocument();
    expect(screen.getByText('auto_refresh_advice')).toBeInTheDocument();
    expect(screen.getByText(/^auto_refresh_last/)).toBeInTheDocument();
  });

  it('interrupteur : réglage enregistré et affichage mis à jour aussitôt', async () => {
    autoRefresh.get.mockResolvedValueOnce(info());
    renderSection();
    await screen.findByText('auto_refresh_never');
    const toggle = screen.getAllByRole('checkbox')[0] as HTMLInputElement;
    fireEvent.click(toggle);
    expect(autoRefresh.set).toHaveBeenCalledWith(false);
    expect(toggle.checked).toBe(false);
  });

  it('enregistrement du réglage en échec : pas de plantage', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    autoRefresh.get.mockResolvedValueOnce(info());
    autoRefresh.set.mockRejectedValueOnce(new Error('base occupée'));
    renderSection();
    await screen.findByText('auto_refresh_never');
    fireEvent.click(screen.getAllByRole('checkbox')[0]);
    await flush();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('relue après la fin d\'une actualisation manuelle', async () => {
    autoRefresh.get.mockResolvedValue(info());
    const { rerender } = renderSection({ isRefreshing: false });
    await flush();
    rerender(<SourcesSection credentials={credentials} accountInfo={null} isRefreshing />);
    rerender(<SourcesSection credentials={credentials} accountInfo={null} isRefreshing={false} />);
    await flush();
    expect(autoRefresh.get).toHaveBeenCalledTimes(2);
  });
});

describe('SourcesSection — guide TV', () => {
  it('guide éteint : pas de ligne d\'état', () => {
    renderSection();
    expect(epgToggle().checked).toBe(false);
    expect(document.querySelector('.epg-status')).toBeNull();
  });

  it('guide allumé jamais synchronisé : « jamais synchronisé »', async () => {
    renderSection({ epgEnabled: true });
    await flush();
    expect(screen.getByText('epg_never_synced')).toBeInTheDocument();
  });

  it('guide allumé déjà synchronisé : nombre de programmes et de chaînes reliées', async () => {
    db.programs = 125_432;
    db.matched = 80;
    renderSection({ epgEnabled: true });
    expect(await screen.findByText(/epg_sync_done \{"total":"125K"\}/)).toBeInTheDocument();
    expect(screen.getByText(/epg_matched_channels \{"count":80\}/)).toBeInTheDocument();
  });

  it.each([
    [1_234, '1.2K'],
    [2_000_000, '2M'],
    [342, '342'],
  ])('%i programmes affichés « %s »', async (programs, shown) => {
    db.programs = programs;
    renderSection({ epgEnabled: true });
    expect(await screen.findByText(`✓ epg_sync_done {"total":"${shown}"}`)).toBeInTheDocument();
  });

  it('allumer : réglage enregistré puis synchro lancée, avec l\'étape affichée', async () => {
    let finish: (v: unknown) => void = () => {};
    epg.syncEpg.mockImplementationOnce((onProgress: (e: unknown) => void) => {
      onProgress({ phase: 'parse', progress: 30, count: 0 });
      return new Promise((r) => { finish = r; });
    });
    const onEpgEnabledChange = vi.fn();
    const { rerender } = renderSection({ onEpgEnabledChange });
    fireEvent.click(epgToggle());
    expect(onEpgEnabledChange).toHaveBeenCalledWith(true);
    expect(epg.syncEpg).toHaveBeenCalledTimes(1);

    rerender(<SourcesSection credentials={credentials} accountInfo={null} epgEnabled onEpgEnabledChange={onEpgEnabledChange} />);
    expect(screen.getByText(/epg_syncing_parse \{"progress":30\}/)).toBeInTheDocument();
    await act(async () => { finish({ programsCount: 1, durationMs: 1 }); });
  });

  it.each([
    ['download', 'epg_syncing_download {"progress":5}'],
    ['insert', 'epg_syncing_insert {"count":5}'],
    ['mapping', 'epg_syncing_mapping {"progress":5}'],
    ['done', 'epg_syncing'],
  ])('étape « %s » affichée pendant la synchro', async (phase, text) => {
    epg.syncEpg.mockImplementationOnce((onProgress: (e: unknown) => void) => {
      onProgress({ phase, progress: 5, count: 0 });
      return new Promise(() => {});
    });
    const { rerender } = renderSection();
    fireEvent.click(epgToggle());
    rerender(<SourcesSection credentials={credentials} accountInfo={null} epgEnabled />);
    expect(document.querySelector('.epg-status-syncing')?.textContent).toBe(text);
  });

  it('première synchro en échec : un nouvel essai, puis les statistiques', async () => {
    epg.syncEpg.mockRejectedValueOnce(new Error('coupure'));
    db.programs = 500;
    const onEpgEnabledChange = vi.fn();
    const { rerender } = renderSection({ onEpgEnabledChange });
    fireEvent.click(epgToggle());
    rerender(<SourcesSection credentials={credentials} accountInfo={null} epgEnabled onEpgEnabledChange={onEpgEnabledChange} />);
    await waitFor(() => expect(epg.syncEpg).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('⚠ epg_sync_error')).toBeNull();
    // Fin annoncée par Rust : les statistiques sont relues et affichées
    await act(async () => { rust.progress?.({ payload: { phase: 'done', progress: 100, count: 500 } }); });
    expect(await screen.findByText('✓ epg_sync_done {"total":"500"}')).toBeInTheDocument();
    expect(onEpgEnabledChange).not.toHaveBeenCalledWith(false);
  });

  it('synchro lancée en allumant : les statistiques sont relues dès sa fin, sans attendre l\'annonce de Rust', async () => {
    let finish: (v: unknown) => void = () => {};
    epg.syncEpg.mockImplementationOnce(() => new Promise((r) => { finish = r; }));
    const onEpgEnabledChange = vi.fn();
    const { rerender } = renderSection({ onEpgEnabledChange });
    fireEvent.click(epgToggle());
    rerender(<SourcesSection credentials={credentials} accountInfo={null} epgEnabled onEpgEnabledChange={onEpgEnabledChange} />);
    await flush();
    const readsBeforeEnd = db.reads;

    await act(async () => { finish({ programsCount: 500, durationMs: 1 }); });
    await waitFor(() => expect(db.reads).toBe(readsBeforeEnd + 1));
  });

  it('guide éteint : les statistiques ne sont jamais relues', async () => {
    db.programs = 500;
    renderSection();
    await flush();
    expect(db.reads).toBe(0);
    expect(screen.queryByText(/epg_sync_done/)).toBeNull();
  });

  it('deux échecs de suite : message d\'erreur et guide éteint', async () => {
    epg.syncEpg.mockRejectedValue(new Error('fournisseur injoignable'));
    const onEpgEnabledChange = vi.fn();
    const { rerender } = renderSection({ onEpgEnabledChange });
    fireEvent.click(epgToggle());
    rerender(<SourcesSection credentials={credentials} accountInfo={null} epgEnabled onEpgEnabledChange={onEpgEnabledChange} />);
    expect(await screen.findByText('⚠ epg_sync_error')).toBeInTheDocument();
    expect(epg.syncEpg).toHaveBeenCalledTimes(2);
    expect(onEpgEnabledChange).toHaveBeenLastCalledWith(false);
    expect(document.querySelector('.epg-status-syncing')).toBeNull();
  });

  it('rallumé pendant qu\'une synchro arrêtée tourne encore : elle reprend au lieu d\'en lancer une autre', () => {
    epg.syncing = true;
    const onEpgEnabledChange = vi.fn();
    renderSection({ onEpgEnabledChange });
    fireEvent.click(epgToggle());
    expect(epg.cancelAbort).toHaveBeenCalledTimes(1);
    expect(epg.syncEpg).not.toHaveBeenCalled();
    expect(onEpgEnabledChange).toHaveBeenCalledWith(true);
  });

  it('éteindre : confirmation demandée, « Annuler » garde le guide', async () => {
    const onEpgEnabledChange = vi.fn();
    renderSection({ epgEnabled: true, onEpgEnabledChange });
    await flush();
    fireEvent.click(epgToggle());
    expect(screen.getByText('epg_disable_title')).toBeInTheDocument();
    fireEvent.click(button('modal_cancel'));
    expect(screen.queryByText('epg_disable_title')).toBeNull();
    expect(epg.purgeEpgData).not.toHaveBeenCalled();
    expect(onEpgEnabledChange).not.toHaveBeenCalled();
  });

  it('éteindre confirmé : guide effacé, « effacement » affiché pendant ce temps, puis guide éteint', async () => {
    db.programs = 10;
    let purged: () => void = () => {};
    epg.purgeEpgData.mockImplementationOnce(() => new Promise<void>((r) => { purged = r; }));
    const onEpgEnabledChange = vi.fn();
    renderSection({ epgEnabled: true, onEpgEnabledChange });
    await flush();
    fireEvent.click(epgToggle());
    await act(async () => { fireEvent.click(button('epg_disable_confirm')); });
    expect(screen.getByText('epg_purging')).toBeInTheDocument();

    // Appui pendant l'effacement : ignoré
    fireEvent.click(epgToggle());
    expect(screen.queryByText('epg_disable_title')).toBeNull();

    await act(async () => { purged(); });
    expect(onEpgEnabledChange).toHaveBeenCalledWith(false);
    expect(epg.requestSyncAbort).not.toHaveBeenCalled();
  });

  it('éteindre pendant une synchro : la synchro est arrêtée avant l\'effacement', async () => {
    epg.syncing = true;
    const onEpgEnabledChange = vi.fn();
    renderSection({ epgEnabled: true, onEpgEnabledChange });
    await flush();
    fireEvent.click(epgToggle());
    await act(async () => { fireEvent.click(button('epg_disable_confirm')); });
    expect(epg.requestSyncAbort).toHaveBeenCalledTimes(1);
    expect(epg.purgeEpgData).toHaveBeenCalledTimes(1);
    expect(onEpgEnabledChange).toHaveBeenCalledWith(false);
  });

  it('téléphone : réglage « Wi-Fi uniquement » visible et enregistré', () => {
    platform.mobile = true;
    renderSection({ epgEnabled: true });
    const wifi = lastCheckbox();
    expect(screen.getByText('epg_wifi_only_label')).toBeInTheDocument();
    fireEvent.click(wifi);
    expect(prefs.setEpgWifiOnly).toHaveBeenCalledWith(true);
    expect(wifi.checked).toBe(true);
  });

  it('Windows : pas de réglage « Wi-Fi uniquement »', () => {
    renderSection({ epgEnabled: true });
    expect(screen.queryByText('epg_wifi_only_label')).toBeNull();
  });
});

describe('SourcesSection — fiches TMDB par le titre', () => {
  it('réglage allumé par défaut ; le couper l\'enregistre', () => {
    renderSection();
    const toggle = screen.getByTestId('settings-tmdb-title-search-toggle') as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);
    expect(toggle.checked).toBe(false);
    expect(prefs.setTmdbTitleSearch).toHaveBeenCalledWith(false);
  });
});
