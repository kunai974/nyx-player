/**
 * Cycle de session et catalogue neuf : « Actualiser » installe le catalogue avec l'accueil et
 * Ma liste remis en ordre ; la connexion, la déconnexion et la remise à zéro oublient l'accueil
 * et les fiches de la session précédente.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { LightIndexes } from '../../types/lightIndex';

// ============================================================================
// MOCKS
// ============================================================================

const freshIndexes = {
  movies: new Map(), series: new Map(), live: new Map(), categories: new Map(),
  moviesByTmdb: new Map(), seriesByTmdb: new Map(), iconPrefixes: [],
} as LightIndexes;

vi.mock('../../services/storage', () => ({
  StorageService: {
    getCredentials: vi.fn(async () => null),
    saveCredentials: vi.fn(async () => {}),
    clearAll: vi.fn(async () => {}),
  },
}));
vi.mock('../../services/xtreamApi', () => ({
  isProviderAccountInactiveError: (e: unknown) => e instanceof Error && e.message === 'provider_account_inactive',
  inactiveAccountInfo: () => undefined,
  XtreamApiService: class {
    authenticate = vi.fn(async () => ({ user_info: { status: 'Active' } }));
  },
}));
// Pas de recalcul des liens du guide par défaut (testé plus bas)
const epgLinks = vi.hoisted(() => ({ ready: Promise.resolve(false) as Promise<boolean> }));
vi.mock('../../services/catalogIngestion', () => ({
  ingestCatalog: vi.fn(async () => ({ movies_count: 0, series_count: 0, live_count: 0, categories_count: 0, partial: false, failed_endpoints: [] })),
  cancelCatalogIngestion: vi.fn(async () => {}),
  whenEpgLinksReady: () => epgLinks.ready,
}));
vi.mock('../../services/catalogLight', () => ({
  loadLightIndexes: vi.fn(async () => freshIndexes),
}));
vi.mock('../../services/dbCore', () => ({
  setMeta: vi.fn(async () => {}),
  getMeta: vi.fn(async () => null),
  clearCatalogData: vi.fn(async () => {}),
  isDatabaseOf: vi.fn(() => true),
  refreshConnection: vi.fn(async () => {}),
  getDatabase: vi.fn(async () => ({})),
  getDatabaseFileName: vi.fn(() => 'nyx_test.db'),
}));
vi.mock('../../services/searchIndex', () => ({ rebuildSearchIndex: vi.fn(async () => {}) }));
vi.mock('../../services/preferencesService', () => ({
  initPreferences: vi.fn(async () => {}),
  getHomePage: vi.fn(() => 'dashboard'),
  getLanguage: vi.fn(() => null),
  setLastProviderHash: vi.fn(async () => {}),
  computeProviderHash: vi.fn(async () => 'hash'),
  getLastProviderHash: vi.fn(() => null),
  isEpgEnabled: vi.fn(() => true),
}));
vi.mock('../../services/liveTvBookmarksService', () => ({
  initLiveTvBookmarks: vi.fn(async () => {}),
  resetLiveTvBookmarksCache: vi.fn(),
}));
vi.mock('../../services/hiddenCategoriesService', () => ({
  initHiddenCategories: vi.fn(async () => {}),
  resetHiddenCategories: vi.fn(),
}));
vi.mock('../../services/piconCache', () => ({ initPiconCache: vi.fn(async () => {}) }));
const mockStopEpgSync = vi.fn();
vi.mock('../../services/epgService', () => ({
  checkAndAutoSync: vi.fn(async () => {}),
  purgeExpiredPrograms: vi.fn(async () => {}),
  stopSyncForSessionChange: () => mockStopEpgSync(),
}));
vi.mock('../../services/syncService', () => ({
  syncOnLogin: vi.fn(async () => ({ cloudWatchlistItems: [] })),
  setCurrentSyncUserId: vi.fn(),
  getCurrentSyncUserId: vi.fn(() => 'compte-a'),
  fetchCloudProviderHash: vi.fn(async () => null),
  pushWatchlistUpdates: vi.fn(async () => {}),
}));
vi.mock('../../services/watchlistRelinking', () => ({
  relinkWatchlistStreamIds: vi.fn(async () => ({ relinked: 0, orphaned: 0, relinkedItems: [] })),
}));
vi.mock('../../services/supabaseClient', () => ({
  supabase: { auth: { getSession: vi.fn(async () => ({ data: { session: null } })) } },
}));
// Relances de la synchro observées sans lancer de vraie synchro
vi.mock('../../services/sync/syncScheduler', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/sync/syncScheduler')>()),
  startCloudResync: vi.fn(),
}));
vi.mock('i18next', () => ({ default: { resolvedLanguage: 'fr', changeLanguage: vi.fn() } }));
vi.mock('../../utils/tmdbLanguage', () => ({ getTmdbLanguage: () => 'fr-FR' }));
vi.mock('../../services/tmdbCacheSqlite', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/tmdbCacheSqlite')>()),
  ensureCacheLanguage: vi.fn(async () => false),
}));

const prepared = { indexes: freshIndexes, dashboard: { generation: 0, base: null, genres: null } };
const mockPrepare = vi.fn(async () => prepared);
const mockApply = vi.fn();
const mockReset = vi.fn();
vi.mock('../../services/catalogReconcile', () => ({
  prepareRefreshedCatalog: (...args: unknown[]) => mockPrepare(...(args as [])),
  applyRefreshedCatalog: (...args: unknown[]) => mockApply(...args),
  resetCatalogCaches: () => mockReset(),
}));

const mockStartAuto = vi.fn();
const mockStopAuto = vi.fn(async () => {});
vi.mock('../../services/catalogAutoRefresh', () => ({
  startCatalogAutoRefresh: (...args: unknown[]) => mockStartAuto(...args),
  stopCatalogAutoRefresh: () => mockStopAuto(),
  updateAutoRefreshCredentials: vi.fn(),
  clearAutoRefreshNotes: vi.fn(async () => {}),
  noteListsToRetry: vi.fn(async () => {}),
}));
const mockMarkInstalled = vi.fn();
const mockClearPending = vi.fn();
vi.mock('../../services/catalogSwapGate', () => ({
  registerCatalogInstaller: vi.fn(),
  markInstalledFromDb: (...args: unknown[]) => mockMarkInstalled(...args),
  clearPendingCatalog: () => mockClearPending(),
  readChangesSeq: vi.fn(async () => 7),
  hasPendingCatalog: () => mockHasPending(),
  invalidatePreparedCatalog: (...args: unknown[]) => mockInvalidate(...args),
}));
const mockHasPending = vi.fn(() => false);
const mockInvalidate = vi.fn();

// ============================================================================
// IMPORTS APRÈS LES MOCKS
// ============================================================================

import { useSessionLifecycle } from '../useSessionLifecycle';
import type { SessionSetters } from '../useSessionLifecycle';
import { clearCatalogData, getMeta } from '../../services/dbCore';
import { startCloudResync } from '../../services/sync/syncScheduler';

function makeSetters(): SessionSetters {
  return {
    setSessionError: vi.fn(), setIsLoggedIn: vi.fn(), setIsLoading: vi.fn(),
    setIsLoadingSavedData: vi.fn(), setProgress: vi.fn(), setHasSavedSession: vi.fn(),
    setCredentials: vi.fn(), setAccountInfo: vi.fn(), setLightIndexes: vi.fn(),
    setLastIngestionPartial: vi.fn(), setHomeTab: vi.fn(), setActiveProfileId: vi.fn(),
    setSourceChanged: vi.fn(), setPendingProviderChange: vi.fn(),
  };
}

const creds = { host: 'http://fournisseur', username: 'u', password: 'p' };
const t = (key: string) => key;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useSessionLifecycle — catalogue neuf', () => {
  it('« Actualiser » prépare puis installe le catalogue avec l\'accueil (réseau permis)', async () => {
    const setters = makeSetters();
    const { result } = renderHook(() => useSessionLifecycle(setters, creds, null, t));

    await act(async () => { await result.current.refreshSources(); });

    expect(mockPrepare).toHaveBeenCalledWith(freshIndexes, { allowNetwork: true, isStillCurrent: expect.any(Function) });
    expect(mockApply).toHaveBeenCalledWith(prepared, setters.setLightIndexes);
    // Le catalogue ne passe que par l'installation (pas de setLightIndexes à part, sans l'accueil)
    expect(setters.setLightIndexes).not.toHaveBeenCalled();
    expect(mockPrepare.mock.invocationCallOrder[0]).toBeLessThan(mockApply.mock.invocationCallOrder[0]);
  });

  it('déconnexion pendant « Actualiser » : rien n\'est installé dans la session suivante', async () => {
    const { loadLightIndexes } = await import('../../services/catalogLight');
    let finishRead: (v: LightIndexes) => void = () => {};
    vi.mocked(loadLightIndexes).mockImplementationOnce(() => new Promise((resolve) => { finishRead = resolve; }));
    const setters = makeSetters();
    const { result } = renderHook(() => useSessionLifecycle(setters, creds, null, t));

    let refresh: Promise<void> = Promise.resolve();
    await act(async () => { refresh = result.current.refreshSources(); });
    await act(async () => { await result.current.logout(); });
    await act(async () => { finishRead(freshIndexes); await refresh; });

    expect(mockPrepare).not.toHaveBeenCalled();
    expect(mockApply).not.toHaveBeenCalled();
    expect(setters.setAccountInfo).not.toHaveBeenCalledWith({ status: 'Active' });
    expect(setters.setIsLoading).toHaveBeenLastCalledWith(false);
  });

  it('autre compte Supabase pendant la préparation : rien n\'est installé', async () => {
    const { getCurrentSyncUserId } = await import('../../services/syncService');
    mockPrepare.mockImplementationOnce(async () => {
      vi.mocked(getCurrentSyncUserId).mockReturnValue('compte-b');
      return prepared;
    });
    const setters = makeSetters();
    const { result } = renderHook(() => useSessionLifecycle(setters, creds, null, t));

    await act(async () => { await result.current.refreshSources(); });

    expect(mockApply).not.toHaveBeenCalled();
    expect(setters.setAccountInfo).not.toHaveBeenCalled();
    // Session Supabase fermée d'elle-même : pas de chargement laissé affiché
    expect(setters.setIsLoading).toHaveBeenLastCalledWith(false);
    expect(setters.setProgress).toHaveBeenLastCalledWith(0);
    vi.mocked(getCurrentSyncUserId).mockReturnValue('compte-a');
  });

  it('la reprise de session oublie l\'accueil et les fiches d\'une session précédente', async () => {
    const setters = makeSetters();
    const { result } = renderHook(() => useSessionLifecycle(setters, creds, null, t));
    await act(async () => { await result.current.resumeSession(); });
    expect(mockReset).toHaveBeenCalledTimes(1);
  });

  it('« Actualiser » en échec : rien n\'est installé', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { loadLightIndexes } = await import('../../services/catalogLight');
    vi.mocked(loadLightIndexes).mockRejectedValueOnce(new Error('base verrouillée'));
    const setters = makeSetters();
    const { result } = renderHook(() => useSessionLifecycle(setters, creds, null, t));

    await act(async () => { await result.current.refreshSources(); });

    expect(mockApply).not.toHaveBeenCalled();
    expect(setters.setSessionError).toHaveBeenCalledWith('common:error_refresh');
    error.mockRestore();
  });

  it('« Actualiser » avec le serveur injoignable : message « ne répond pas »', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { loadLightIndexes } = await import('../../services/catalogLight');
    vi.mocked(loadLightIndexes).mockRejectedValueOnce('provider_unreachable: error sending request: operation timed out');
    const setters = makeSetters();
    const { result } = renderHook(() => useSessionLifecycle(setters, creds, null, t));

    await act(async () => { await result.current.refreshSources(); });

    expect(setters.setSessionError).toHaveBeenCalledWith('auth:error_provider_unavailable');
    expect(setters.setSessionError).not.toHaveBeenCalledWith('common:error_refresh');
    error.mockRestore();
  });

  it('la déconnexion oublie l\'accueil et les fiches', async () => {
    const setters = makeSetters();
    const { result } = renderHook(() => useSessionLifecycle(setters, creds, null, t));
    await act(async () => { await result.current.logout(); });
    expect(mockReset).toHaveBeenCalledTimes(1);
    expect(setters.setLightIndexes).toHaveBeenCalledWith(null);
  });

  it('la remise à zéro oublie l\'accueil et les fiches', () => {
    const setters = makeSetters();
    const { result } = renderHook(() => useSessionLifecycle(setters, creds, null, t));
    act(() => { result.current.fullReset(); });
    expect(mockReset).toHaveBeenCalledTimes(1);
  });

  it('la connexion à une source oublie l\'accueil précédent, sans vider le catalogue du même fournisseur', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    vi.mocked(getMeta).mockImplementation(async (key: string) => (key === 'lastProvider' ? creds.host : null));
    const setters = makeSetters();
    const { result } = renderHook(() => useSessionLifecycle(setters, creds, null, t));

    await act(async () => { await result.current.login(creds); });

    expect(mockReset).toHaveBeenCalledTimes(1);
    expect(clearCatalogData).not.toHaveBeenCalled();
    expect(setters.setLightIndexes).toHaveBeenCalledWith(freshIndexes);
    vi.useRealTimers();
  });

  it('« Actualiser » arrête l\'actualisation en arrière-plan puis la relance après l\'installation', async () => {
    const setters = makeSetters();
    const { result } = renderHook(() => useSessionLifecycle(setters, creds, null, t));

    await act(async () => { await result.current.refreshSources(); });

    expect(mockClearPending).toHaveBeenCalled();
    expect(mockStopAuto.mock.invocationCallOrder[0]).toBeLessThan(mockPrepare.mock.invocationCallOrder[0]);
    // Compteur lu avant la relecture du catalogue : les changements suivants resteront en attente
    expect(mockMarkInstalled).toHaveBeenCalledWith(7);
    expect(mockStartAuto).toHaveBeenCalledWith({ creds, dbName: 'nyx_test.db', userId: 'compte-a' });
    expect(mockApply.mock.invocationCallOrder[0]).toBeLessThan(mockStartAuto.mock.invocationCallOrder[0]);
  });

  // Un film ajouté à Ma
  // liste sur le téléphone n'apparaissait pas sur le PC après « Rafraîchir » ; le bouton ne relançait que le catalogue, pas la synchro du cloud,
  // et repoussait même la relance au retour dans l'app.
  it('« Actualiser » reprend aussi tout de suite les changements des autres appareils (Ma liste)', async () => {
    const setters = makeSetters();
    const { result } = renderHook(() => useSessionLifecycle(setters, creds, null, t));

    await act(async () => { await result.current.refreshSources(); });

    expect(startCloudResync).toHaveBeenCalledTimes(1);
    expect(startCloudResync).toHaveBeenCalledWith('compte-a', { syncNow: true });
    expect(mockApply.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(startCloudResync).mock.invocationCallOrder[0]);
  });

  it('« Actualiser » en échec côté fournisseur : la synchro du cloud part quand même', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { loadLightIndexes } = await import('../../services/catalogLight');
    vi.mocked(loadLightIndexes).mockRejectedValueOnce(new Error('hors ligne'));
    const setters = makeSetters();
    const { result } = renderHook(() => useSessionLifecycle(setters, creds, null, t));

    try {
      await act(async () => { await result.current.refreshSources(); });
      expect(startCloudResync).toHaveBeenCalledWith('compte-a', { syncNow: true });
    } finally {
      error.mockRestore();
    }
  });

  it('« Actualiser » avec un certificat https refusé : le message le dit', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { loadLightIndexes } = await import('../../services/catalogLight');
    vi.mocked(loadLightIndexes).mockRejectedValueOnce('provider_certificate_error: invalid peer certificate: Expired');
    const setters = makeSetters();
    const { result } = renderHook(() => useSessionLifecycle(setters, creds, null, t));

    try {
      await act(async () => { await result.current.refreshSources(); });
      expect(setters.setSessionError).toHaveBeenCalledWith('auth:error_provider_certificate');
    } finally {
      error.mockRestore();
    }
  });

  it('autre compte pendant « Rafraîchir » : aucune synchro relancée pour lui', async () => {
    const { getCurrentSyncUserId } = await import('../../services/syncService');
    mockPrepare.mockImplementationOnce(async () => {
      vi.mocked(getCurrentSyncUserId).mockReturnValue('compte-b');
      return prepared;
    });
    const setters = makeSetters();
    const { result } = renderHook(() => useSessionLifecycle(setters, creds, null, t));

    try {
      await act(async () => { await result.current.refreshSources(); });
      expect(startCloudResync).not.toHaveBeenCalled();
    } finally {
      vi.mocked(getCurrentSyncUserId).mockReturnValue('compte-a');
    }
  });

  it('la déconnexion arrête l\'actualisation en arrière-plan sans la relancer', async () => {
    const setters = makeSetters();
    const { result } = renderHook(() => useSessionLifecycle(setters, creds, null, t));
    await act(async () => { await result.current.logout(); });
    expect(mockStopAuto).toHaveBeenCalledTimes(1);
    expect(mockClearPending).toHaveBeenCalledTimes(1);
    expect(mockStartAuto).not.toHaveBeenCalled();
  });

  it('la déconnexion arrête la synchro du guide en cours', async () => {
    mockStopEpgSync.mockClear();
    const setters = makeSetters();
    const { result } = renderHook(() => useSessionLifecycle(setters, creds, null, t));
    await act(async () => { await result.current.logout(); });
    expect(mockStopEpgSync).toHaveBeenCalledTimes(1);
  });

  it('guide TV mis à jour pendant qu\'un catalogue neuf attend : rien n\'est installé en dehors de la porte', async () => {
    const { EPG_UPDATED_EVENT } = await import('../../services/eventConstants');
    const setters = makeSetters();
    renderHook(() => useSessionLifecycle(setters, creds, null, t));

    mockHasPending.mockReturnValue(true);
    await act(async () => { window.dispatchEvent(new CustomEvent(EPG_UPDATED_EVENT)); });
    expect(mockInvalidate).toHaveBeenCalled();
    expect(setters.setLightIndexes).not.toHaveBeenCalled();

    mockHasPending.mockReturnValue(false);
    await act(async () => { window.dispatchEvent(new CustomEvent(EPG_UPDATED_EVENT)); });
    await vi.waitFor(() => expect(setters.setLightIndexes).toHaveBeenCalledWith(freshIndexes));
  });
});

// Guide TV activé, mais Live TV sans programmes après la connexion et après
// « Actualiser ». La lecture du catalogue efface les liens des chaînes au guide, recalculés ensuite en
// arrière-plan (remap_epg) ; le catalogue en mémoire, relu entre les deux, n'en avait aucun, et la fin du
// recalcul n'était annoncée que par les Paramètres ouverts. Il fallait éteindre puis rallumer le guide.
describe('useSessionLifecycle — liens du guide après une lecture du catalogue', () => {
  let announcements: number[] = [];
  let order = 0;
  const onEpgUpdated = () => { announcements.push(++order); };
  let EPG_UPDATED_EVENT = '';

  beforeEach(async () => {
    ({ EPG_UPDATED_EVENT } = await import('../../services/eventConstants'));
    announcements = [];
    order = 0;
    epgLinks.ready = Promise.resolve(true);
    window.addEventListener(EPG_UPDATED_EVENT, onEpgUpdated);
    return async () => {
      window.removeEventListener(EPG_UPDATED_EVENT, onEpgUpdated);
      epgLinks.ready = Promise.resolve(false);
      vi.useRealTimers();
      const { isEpgEnabled } = await import('../../services/preferencesService');
      vi.mocked(isEpgEnabled).mockReturnValue(true);
    };
  });

  it('connexion : à la fin du recalcul des liens, le catalogue est relu avec ses liens', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    let finishLinks: (ok: boolean) => void = () => {};
    epgLinks.ready = new Promise((resolve) => { finishLinks = resolve; });
    const setters = makeSetters();
    const { result } = renderHook(() => useSessionLifecycle(setters, creds, null, t));

    await act(async () => { await result.current.login(creds); });
    expect(setters.setLightIndexes).toHaveBeenCalledTimes(1);
    expect(announcements).toHaveLength(0);

    await act(async () => { finishLinks(true); });

    expect(announcements).toHaveLength(1);
    // Catalogue relu depuis la base (liens compris) et installé une seconde fois
    await vi.waitFor(() => expect(setters.setLightIndexes).toHaveBeenCalledTimes(2));
  });

  it('« Actualiser » : recalcul fini avant l\'installation, l\'annonce vient quand même après elle', async () => {
    const seen: number[] = [];
    mockApply.mockImplementationOnce(() => { seen.push(++order); });
    const setters = makeSetters();
    const { result } = renderHook(() => useSessionLifecycle(setters, creds, null, t));

    await act(async () => { await result.current.refreshSources(); });

    expect(seen).toHaveLength(1);
    expect(announcements).toHaveLength(1);
    expect(announcements[0]).toBeGreaterThan(seen[0]);
    await vi.waitFor(() => expect(setters.setLightIndexes).toHaveBeenCalledWith(freshIndexes));
  });

  it('guide désactivé : rien n\'est annoncé (pas de relecture inutile du catalogue)', async () => {
    const { isEpgEnabled } = await import('../../services/preferencesService');
    vi.mocked(isEpgEnabled).mockReturnValue(false);
    const setters = makeSetters();
    const { result } = renderHook(() => useSessionLifecycle(setters, creds, null, t));

    await act(async () => { await result.current.refreshSources(); });

    expect(announcements).toHaveLength(0);
  });

  it('recalcul des liens en échec : rien n\'est annoncé', async () => {
    epgLinks.ready = Promise.resolve(false);
    const setters = makeSetters();
    const { result } = renderHook(() => useSessionLifecycle(setters, creds, null, t));

    await act(async () => { await result.current.refreshSources(); });

    expect(announcements).toHaveLength(0);
  });

  it('déconnexion avant la fin du recalcul : rien n\'est annoncé dans la session suivante', async () => {
    let finishLinks: (ok: boolean) => void = () => {};
    epgLinks.ready = new Promise((resolve) => { finishLinks = resolve; });
    const setters = makeSetters();
    const { result } = renderHook(() => useSessionLifecycle(setters, creds, null, t));

    await act(async () => { await result.current.refreshSources(); });
    await act(async () => { await result.current.logout(); });
    await act(async () => { finishLinks(true); });

    expect(announcements).toHaveLength(0);
  });
});
