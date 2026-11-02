/**
 * Parcours complets du cycle de session : connexion complète, changement de fournisseur,
 * reprise avec synchro, et session fermée pendant la connexion ou la reprise.
 * Reproduit aussi les défauts corrigés : Ma liste vidée à la connexion,
 * écritures dans la base du compte suivant, synchro attendue après le catalogue.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { LightIndexes } from '../../types/lightIndex';

// ============================================================================
// MOCKS
// ============================================================================

const freshIndexes = {
  movies: new Map(), series: new Map(), live: new Map(), categories: new Map(),
  moviesByTmdb: new Map(), seriesByTmdb: new Map(), iconPrefixes: [],
} as LightIndexes;

const creds = { host: 'http://fournisseur', username: 'u', password: 'p' };

/** Base ouverte : celle du compte A tant qu'aucun test ne la change */
let openAccount = 'compte-a';

vi.mock('../../services/storage', () => ({
  StorageService: {
    getCredentials: vi.fn(async () => creds),
    saveCredentials: vi.fn(async () => {}),
    clearAll: vi.fn(async () => {}),
  },
}));
const authenticate = vi.hoisted(() => vi.fn(async (): Promise<unknown> => ({ user_info: { status: 'Active' } })));
vi.mock('../../services/xtreamApi', () => ({
  isProviderHtmlResponseError: (e: unknown) => e instanceof Error && e.message === 'provider_html_response',
  isProviderAccountInactiveError: (e: unknown) => e instanceof Error && e.message === 'provider_account_inactive',
  inactiveAccountInfo: (e: unknown) => (e instanceof Error && e.message === 'provider_account_inactive' ? (e as Error & { userInfo?: unknown }).userInfo : undefined),
  XtreamApiService: class {
    authenticate = authenticate;
  },
}));
vi.mock('../../services/catalogIngestion', () => ({
  ingestCatalog: vi.fn(async () => ({ movies_count: 0, series_count: 0, live_count: 0, categories_count: 0, partial: false, failed_endpoints: [] })),
  cancelCatalogIngestion: vi.fn(async () => {}),
  // Liens du guide recalculés : testé dans useSessionLifecycle.catalog.test.ts
  whenEpgLinksReady: vi.fn(async () => false),
}));
vi.mock('../../services/catalogLight', () => ({
  loadLightIndexes: vi.fn(async () => freshIndexes),
}));
vi.mock('../../services/dbCore', () => ({
  setMeta: vi.fn(async () => {}),
  getMeta: vi.fn(async () => null),
  clearCatalogData: vi.fn(async () => {}),
  refreshConnection: vi.fn(async () => {}),
  getDatabase: vi.fn(async () => ({ execute: vi.fn(async () => {}) })),
  getDatabaseFileName: vi.fn(() => 'nyx_test.db'),
  isDatabaseOf: vi.fn((uid: string) => uid === openAccount),
}));
vi.mock('../../services/searchIndex', () => ({ rebuildSearchIndex: vi.fn(async () => {}) }));
vi.mock('../../services/preferencesService', () => ({
  initPreferences: vi.fn(async () => {}),
  getHomePage: vi.fn(() => 'dashboard'),
  getLanguage: vi.fn(() => null),
  setLastProviderHash: vi.fn(async () => {}),
  computeProviderHash: vi.fn(async () => 'hash-fournisseur'),
  getLastProviderHash: vi.fn(() => 'hash-fournisseur'),
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
vi.mock('../../services/epgService', () => ({
  checkAndAutoSync: vi.fn(async () => {}),
  purgeExpiredPrograms: vi.fn(async () => {}),
  stopSyncForSessionChange: vi.fn(),
}));
vi.mock('../../services/syncService', () => ({
  syncOnLogin: vi.fn(async () => ({ cloudWatchlistItems: [] })),
  setCurrentSyncUserId: vi.fn(),
  getCurrentSyncUserId: vi.fn(() => 'compte-a'),
  fetchCloudProviderHash: vi.fn(async () => null),
  pushWatchlistUpdates: vi.fn(async () => {}),
  purgeProviderCloudData: vi.fn(async () => true),
}));
vi.mock('../../services/watchlistRelinking', () => ({
  relinkWatchlistStreamIds: vi.fn(async () => ({ relinked: 0, orphaned: 0, relinkedItems: [] })),
}));
const cloudDelete = vi.fn(() => ({ eq: vi.fn(async () => ({ error: null })) }));
vi.mock('../../services/supabaseClient', () => ({
  supabase: {
    auth: { getSession: vi.fn(async () => ({ data: { session: { user: { id: 'compte-a' } } } })) },
    from: vi.fn(() => ({ delete: cloudDelete })),
  },
}));
vi.mock('../../services/sync/syncScheduler', () => ({
  startCloudResync: vi.fn(),
  stopCloudResync: vi.fn(),
  waitForCloudResync: vi.fn(async () => {}),
}));
vi.mock('../../services/sync/syncBaseline', () => ({ clearBaselines: vi.fn(async () => {}) }));
vi.mock('../../services/localDatabaseHealth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/localDatabaseHealth')>()),
  checkLocalDatabase: vi.fn(async () => 'corrupt'),
  isLocalDatabaseDamaged: vi.fn(() => false),
}));
vi.mock('../../utils/devLog', () => ({ devLog: vi.fn() }));
vi.mock('i18next', () => ({ default: { resolvedLanguage: 'fr', changeLanguage: vi.fn() } }));
vi.mock('../../utils/tmdbLanguage', () => ({ getTmdbLanguage: () => 'fr-FR' }));
vi.mock('../../services/tmdbCacheSqlite', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/tmdbCacheSqlite')>()),
  ensureCacheLanguage: vi.fn(async () => false),
}));
vi.mock('../../services/catalogReconcile', () => ({
  prepareRefreshedCatalog: vi.fn(),
  applyRefreshedCatalog: vi.fn(),
  resetCatalogCaches: vi.fn(),
}));
vi.mock('../../services/catalogAutoRefresh', () => ({
  startCatalogAutoRefresh: vi.fn(),
  stopCatalogAutoRefresh: vi.fn(async () => {}),
  updateAutoRefreshCredentials: vi.fn(),
  clearAutoRefreshNotes: vi.fn(async () => {}),
  noteListsToRetry: vi.fn(async () => {}),
}));
vi.mock('../../services/catalogSwapGate', () => ({
  registerCatalogInstaller: vi.fn(),
  markInstalledFromDb: vi.fn(),
  clearPendingCatalog: vi.fn(),
  readChangesSeq: vi.fn(async () => 1),
  hasPendingCatalog: () => false,
  invalidatePreparedCatalog: vi.fn(),
}));

// ============================================================================
// IMPORTS APRÈS LES MOCKS
// ============================================================================

import { useSessionLifecycle } from '../useSessionLifecycle';
import type { SessionSetters } from '../useSessionLifecycle';
import { clearCatalogData, getMeta, setMeta, getDatabase, isDatabaseOf } from '../../services/dbCore';
import { StorageService } from '../../services/storage';
import { ingestCatalog, cancelCatalogIngestion } from '../../services/catalogIngestion';
import { loadLightIndexes } from '../../services/catalogLight';
import { syncOnLogin, fetchCloudProviderHash, setCurrentSyncUserId, purgeProviderCloudData } from '../../services/syncService';
import { relinkWatchlistStreamIds } from '../../services/watchlistRelinking';
import { startCloudResync } from '../../services/sync/syncScheduler';
import { rebuildSearchIndex } from '../../services/searchIndex';
import { updateAutoRefreshCredentials, noteListsToRetry } from '../../services/catalogAutoRefresh';
import { initPreferences, setLastProviderHash, computeProviderHash } from '../../services/preferencesService';
import { getCurrentSyncUserId } from '../../services/syncService';
import { devLog } from '../../utils/devLog';
import { checkLocalDatabase, isLocalDatabaseDamaged } from '../../services/localDatabaseHealth';
import { noteTypedProviderHost, normalizeProviderHost } from '../../utils/providerHost';

function makeSetters(): SessionSetters {
  return {
    setSessionError: vi.fn(), setIsLoggedIn: vi.fn(), setIsLoading: vi.fn(),
    setIsLoadingSavedData: vi.fn(), setProgress: vi.fn(), setHasSavedSession: vi.fn(),
    setCredentials: vi.fn(), setAccountInfo: vi.fn(), setLightIndexes: vi.fn(),
    setLastIngestionPartial: vi.fn(), setHomeTab: vi.fn(), setActiveProfileId: vi.fn(),
    setSourceChanged: vi.fn(), setPendingProviderChange: vi.fn(),
  };
}

const t = (key: string) => key;
const order = (fn: unknown) => vi.mocked(fn as () => void).mock.invocationCallOrder[0];

/** Promesse résolue à la main, pour tenir une étape le temps de fermer la session */
function deferred<T>() {
  let resolve: (v: T) => void = () => {};
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  openAccount = 'compte-a';
  vi.mocked(getMeta).mockResolvedValue(null);
});

afterEach(() => {
  vi.useRealTimers();
});

// ============================================================================
// CONNEXION COMPLÈTE
// ============================================================================

describe('useSessionLifecycle — connexion complète', () => {
  it('lit le catalogue, range les identifiants, synchronise, relie Ma liste puis ouvre l\'accueil, dans cet ordre', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const setters = makeSetters();
    const { result } = renderHook(() => useSessionLifecycle(setters, creds, null, t));

    await act(async () => { await result.current.login(creds); });
    await act(async () => { vi.advanceTimersByTime(500); });

    expect(order(ingestCatalog)).toBeLessThan(order(StorageService.saveCredentials));
    expect(order(StorageService.saveCredentials)).toBeLessThan(order(syncOnLogin));
    expect(order(syncOnLogin)).toBeLessThan(order(relinkWatchlistStreamIds));
    expect(setters.setLightIndexes).toHaveBeenCalledWith(freshIndexes);
    expect(setters.setIsLoggedIn).toHaveBeenCalledWith(true);
    expect(setters.setHasSavedSession).toHaveBeenCalledWith(true);
    expect(startCloudResync).toHaveBeenCalledWith('compte-a');
  });

  it('même fournisseur : ni Ma liste ni le catalogue ne sont vidés avant la lecture', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    vi.mocked(getMeta).mockImplementation(async (key: string) => (key === 'lastProvider' ? creds.host : null));
    const setters = makeSetters();
    const { result } = renderHook(() => useSessionLifecycle(setters, creds, null, t));

    await act(async () => { await result.current.login(creds); });

    // Une liste en échec garde l'ancienne (garde-fous du Rust) au lieu de laisser la section vide
    expect(clearCatalogData).not.toHaveBeenCalled();
    expect(ingestCatalog).toHaveBeenCalledTimes(1);
    const db = await vi.mocked(getDatabase).mock.results[0]?.value;
    const statements = (db?.execute.mock.calls ?? []).map((call: unknown[]) => String(call[0]));
    expect(statements.some((sql: string) => /watchlist/i.test(sql))).toBe(false);
  });

  it('fournisseur jamais noté dans la base : catalogue vidé avant la lecture, par prudence', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const setters = makeSetters();
    const { result } = renderHook(() => useSessionLifecycle(setters, creds, null, t));

    await act(async () => { await result.current.login(creds); });

    expect(clearCatalogData).toHaveBeenCalledTimes(1);
    expect(order(clearCatalogData)).toBeLessThan(order(ingestCatalog));
  });

  it('liste des films en échec : notée pour être retentée par l\'actualisation automatique', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    vi.mocked(getMeta).mockImplementation(async (key: string) => (key === 'lastProvider' ? creds.host : null));
    vi.mocked(ingestCatalog).mockResolvedValueOnce({
      movies_count: 0, series_count: 3, live_count: 0, categories_count: 0, partial: true, failed_endpoints: ['movies', 'movies_guarded'],
    } as never);
    const setters = makeSetters();
    const { result } = renderHook(() => useSessionLifecycle(setters, creds, null, t));

    await act(async () => { await result.current.login(creds); });

    await act(async () => { vi.advanceTimersByTime(500); });

    expect(noteListsToRetry).toHaveBeenCalledWith(['movies', 'movies_guarded']);
    expect(clearCatalogData).not.toHaveBeenCalled();
    expect(setters.setIsLoggedIn).toHaveBeenCalledWith(true);
  });

  it('fournisseur changé sur un autre appareil : la connexion attend la confirmation', async () => {
    vi.mocked(fetchCloudProviderHash).mockResolvedValueOnce('hash-ancien');
    const setters = makeSetters();
    const { result } = renderHook(() => useSessionLifecycle(setters, creds, null, t));

    await act(async () => { await result.current.login(creds); });

    expect(setters.setPendingProviderChange).toHaveBeenCalledWith({ from: '***', to: creds.host, creds });
    expect(ingestCatalog).not.toHaveBeenCalled();
    expect(setters.setIsLoading).toHaveBeenLastCalledWith(false);
  });

  it('changement de fournisseur confirmé : données du fournisseur effacées en local puis connexion complète', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    // Effacement du cloud lent : la connexion l'attend avant de continuer
    const purge = deferred<boolean>();
    vi.mocked(purgeProviderCloudData).mockImplementationOnce(() => purge.promise);
    vi.mocked(fetchCloudProviderHash).mockResolvedValueOnce('hash-ancien');
    const setters = makeSetters();
    let pending: Parameters<SessionSetters['setPendingProviderChange']>[0] = null;
    vi.mocked(setters.setPendingProviderChange).mockImplementation((v) => { pending = v; });
    const { result, rerender } = renderHook(() => useSessionLifecycle(setters, creds, pending, t));

    await act(async () => { await result.current.login(creds); });
    rerender();
    let confirm: Promise<void> = Promise.resolve();
    await act(async () => { confirm = result.current.confirmProviderChange(true); });
    expect(ingestCatalog).not.toHaveBeenCalled();
    await act(async () => { purge.resolve(true); await confirm; });
    await act(async () => { vi.advanceTimersByTime(500); });

    const db = await vi.mocked(getDatabase).mock.results[0]?.value;
    const statements = (db?.execute.mock.calls ?? []).map((call: unknown[]) => String(call[0]));
    expect(statements).toContain('DELETE FROM playback_progress');
    expect(statements).toContain('DELETE FROM live_tv_favorites');
    expect(ingestCatalog).toHaveBeenCalledTimes(1);
    // Autre fournisseur : ses numéros ne valent plus rien, le catalogue est vidé avant la lecture
    expect(clearCatalogData).toHaveBeenCalledTimes(1);
    expect(order(clearCatalogData)).toBeLessThan(order(ingestCatalog));
    // Effacement du cloud de l'ancien fournisseur attendu avant la synchro
    // Empreinte du NOUVEAU fournisseur (calculée depuis son adresse, l'empreinte de l'appareil
    // n'étant remplacée qu'après), pour garder ses lignes déjà envoyées par un autre appareil
    expect(purgeProviderCloudData).toHaveBeenCalledWith('compte-a', 'hash-fournisseur');
    expect(computeProviderHash).toHaveBeenCalledWith(creds.host);
    expect(order(purgeProviderCloudData)).toBeLessThan(order(syncOnLogin));
    expect(setMeta).toHaveBeenCalledWith('lastProvider', creds.host);
    expect(setters.setIsLoggedIn).toHaveBeenCalledWith(true);
  });
});

// ============================================================================
// SESSION FERMÉE PENDANT LA CONNEXION
// ============================================================================

describe('useSessionLifecycle — session fermée pendant la connexion', () => {
  it('déconnexion pendant la lecture du catalogue : rien n\'est écrit ni ouvert ensuite', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const ingest = deferred<Awaited<ReturnType<typeof ingestCatalog>>>();
    vi.mocked(ingestCatalog).mockImplementationOnce(() => ingest.promise);
    const setters = makeSetters();
    const { result } = renderHook(() => useSessionLifecycle(setters, creds, null, t));

    let login: Promise<void> = Promise.resolve();
    await act(async () => { login = result.current.login(creds); });
    await act(async () => { await result.current.logout(); });
    await act(async () => {
      ingest.resolve({ movies_count: 0, series_count: 0, live_count: 0, categories_count: 0, partial: false, failed_endpoints: [] } as never);
      await login;
      vi.advanceTimersByTime(500);
    });

    expect(rebuildSearchIndex).not.toHaveBeenCalled();
    expect(StorageService.saveCredentials).not.toHaveBeenCalled();
    expect(syncOnLogin).not.toHaveBeenCalled();
    expect(relinkWatchlistStreamIds).not.toHaveBeenCalled();
    expect(setters.setIsLoggedIn).not.toHaveBeenCalledWith(true);
    expect(setters.setSessionError).not.toHaveBeenCalledWith('auth:error_login_failed');
    // Le téléchargement est aussi arrêté côté Rust, au lieu de continuer jusqu'au bout
    expect(cancelCatalogIngestion).toHaveBeenCalledTimes(1);
  });

  it('page web du fournisseur (maintenance) : le message le dit, au lieu de « vérifiez vos identifiants » seul', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    authenticate.mockRejectedValueOnce(new Error('provider_html_response'));
    const setters = makeSetters();
    const { result } = renderHook(() => useSessionLifecycle(setters, creds, null, t));

    await act(async () => { await result.current.login(creds); });

    expect(setters.setSessionError).toHaveBeenCalledWith('auth:error_provider_html');
    error.mockRestore();
  });

  it('abonnement expiré ou suspendu chez le fournisseur : le message le dit, au lieu de « échec de connexion »', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    authenticate.mockRejectedValueOnce(new Error('provider_account_inactive'));
    const setters = makeSetters();
    const { result } = renderHook(() => useSessionLifecycle(setters, creds, null, t));

    await act(async () => { await result.current.login(creds); });

    expect(setters.setSessionError).toHaveBeenCalledWith('auth:error_provider_account_inactive');
    expect(setters.setIsLoggedIn).not.toHaveBeenCalledWith(true);
    error.mockRestore();
  });

  it('certificat https du fournisseur refusé : le message le dit, pas « le serveur ne répond pas »', async () => {
    authenticate.mockRejectedValueOnce('provider_certificate_error: error sending request: invalid peer certificate: Expired');
    const setters = makeSetters();
    const { result } = renderHook(() => useSessionLifecycle(setters, creds, null, t));

    await act(async () => { await result.current.login(creds); });

    expect(setters.setSessionError).toHaveBeenCalledWith('auth:error_provider_certificate');
    expect(setters.setSessionError).not.toHaveBeenCalledWith('auth:error_provider_unavailable');
  });

  it('serveur du fournisseur en panne (5xx) : message « ne répond pas », pas « identifiants faux »', async () => {
    authenticate.mockRejectedValueOnce('provider_server_error: HTTP 503');
    const setters = makeSetters();
    const { result } = renderHook(() => useSessionLifecycle(setters, creds, null, t));

    await act(async () => { await result.current.login(creds); });

    expect(setters.setSessionError).toHaveBeenCalledWith('auth:error_provider_unavailable');
    expect(setters.setSessionError).not.toHaveBeenCalledWith('auth:error_login_failed');
    expect(ingestCatalog).not.toHaveBeenCalled();
  });

  it.each([
    ['délai dépassé', 'provider_unreachable: error sending request: operation timed out'],
    ['adresse introuvable (DNS)', 'provider_unreachable: error trying to connect: dns error: no record found'],
  ])('serveur injoignable (%s) : message « ne répond pas », pas « identifiants faux »', async (_label, failure) => {
    authenticate.mockRejectedValueOnce(failure);
    const setters = makeSetters();
    const { result } = renderHook(() => useSessionLifecycle(setters, creds, null, t));

    await act(async () => { await result.current.login(creds); });

    expect(setters.setSessionError).toHaveBeenCalledWith('auth:error_provider_unavailable');
    expect(setters.setSessionError).not.toHaveBeenCalledWith('auth:error_login_failed');
    expect(ingestCatalog).not.toHaveBeenCalled();
  });

  it('identifiants refusés : le message habituel reste affiché', async () => {
    authenticate.mockRejectedValueOnce(new Error('Authentication failed'));
    const setters = makeSetters();
    const { result } = renderHook(() => useSessionLifecycle(setters, creds, null, t));

    await act(async () => { await result.current.login(creds); });

    expect(setters.setSessionError).toHaveBeenCalledWith('auth:error_login_failed');
  });

  it('autre compte pendant la synchro : Ma liste n\'est pas re-liée dans la base du compte suivant', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    vi.mocked(syncOnLogin).mockImplementationOnce(async () => {
      openAccount = 'compte-b';
      return { cloudWatchlistItems: [] } as never;
    });
    const setters = makeSetters();
    const { result } = renderHook(() => useSessionLifecycle(setters, creds, null, t));

    await act(async () => { await result.current.login(creds); });
    await act(async () => { vi.advanceTimersByTime(500); });

    expect(relinkWatchlistStreamIds).not.toHaveBeenCalled();
    expect(setters.setIsLoggedIn).not.toHaveBeenCalledWith(true);
  });

  it('session Supabase fermée d\'elle-même pendant la lecture (sans logout) : le chargement s\'éteint', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    vi.mocked(ingestCatalog).mockImplementationOnce(async () => {
      openAccount = 'aucun'; // SIGNED_OUT a fermé la base, l'époque n'a pas bougé
      return { movies_count: 0, series_count: 0, live_count: 0, categories_count: 0, partial: false, failed_endpoints: [] } as never;
    });
    const setters = makeSetters();
    const { result } = renderHook(() => useSessionLifecycle(setters, creds, null, t));

    await act(async () => { await result.current.login(creds); });

    expect(StorageService.saveCredentials).not.toHaveBeenCalled();
    expect(setters.setIsLoading).toHaveBeenLastCalledWith(false);
    expect(setters.setProgress).toHaveBeenLastCalledWith(0);
  });

  it('la re-liaison reçoit la garde de session', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const setters = makeSetters();
    const { result } = renderHook(() => useSessionLifecycle(setters, creds, null, t));

    await act(async () => { await result.current.login(creds); });

    const options = vi.mocked(relinkWatchlistStreamIds).mock.calls[0][3];
    expect(options?.isStillCurrent?.()).toBe(true);
    openAccount = 'compte-b';
    expect(options?.isStillCurrent?.()).toBe(false);
    expect(vi.mocked(isDatabaseOf)).toHaveBeenCalledWith('compte-a');
  });
});

// ============================================================================
// REPRISE DE SESSION
// ============================================================================

describe('useSessionLifecycle — reprise de session', () => {
  it('reprend avec synchro : catalogue installé, synchro, re-liaison, accueil ouvert', async () => {
    const setters = makeSetters();
    const { result } = renderHook(() => useSessionLifecycle(setters, creds, null, t));

    await act(async () => { await result.current.resumeSession(); });

    expect(setters.setLightIndexes).toHaveBeenCalledWith(freshIndexes);
    expect(setCurrentSyncUserId).toHaveBeenCalledWith('compte-a');
    expect(syncOnLogin).toHaveBeenCalledWith('compte-a');
    expect(order(syncOnLogin)).toBeLessThan(order(relinkWatchlistStreamIds));
    expect(order(relinkWatchlistStreamIds)).toBeLessThan(order(setters.setIsLoggedIn));
    expect(setters.setIsLoggedIn).toHaveBeenCalledWith(true);
    expect(setters.setIsLoadingSavedData).toHaveBeenLastCalledWith(false);
  });

  it('la synchro part pendant la lecture du catalogue : l\'accueil attend le plus long des deux, pas leur somme', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'performance'] });
    const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    vi.mocked(loadLightIndexes).mockImplementationOnce(async () => { await wait(2400); return freshIndexes; });
    vi.mocked(syncOnLogin).mockImplementationOnce(async () => { await wait(2300); return { cloudWatchlistItems: [] } as never; });
    const setters = makeSetters();
    const { result } = renderHook(() => useSessionLifecycle(setters, creds, null, t));

    let resume: Promise<void> = Promise.resolve();
    await act(async () => { resume = result.current.resumeSession(); });
    // Avant : 2,4 s de catalogue puis 2,3 s de synchro. Maintenant les deux avancent ensemble.
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
    expect(setters.setIsLoggedIn).toHaveBeenCalledWith(true);
    await act(async () => { await resume; });
  });

  it('les catégories masquées sont toujours attendues avant l\'accueil', async () => {
    const sync = deferred<{ cloudWatchlistItems: [] }>();
    vi.mocked(syncOnLogin).mockImplementationOnce(() => sync.promise as never);
    const setters = makeSetters();
    const { result } = renderHook(() => useSessionLifecycle(setters, creds, null, t));

    let resume: Promise<void> = Promise.resolve();
    await act(async () => { resume = result.current.resumeSession(); });
    expect(setters.setLightIndexes).toHaveBeenCalledWith(freshIndexes);
    expect(setters.setIsLoggedIn).not.toHaveBeenCalled();

    await act(async () => { sync.resolve({ cloudWatchlistItems: [] }); await resume; });
    expect(setters.setIsLoggedIn).toHaveBeenCalledWith(true);
  });

  it('fournisseur changé sur un autre appareil : ni synchro ni accueil, retour à la connexion', async () => {
    vi.mocked(fetchCloudProviderHash).mockResolvedValueOnce('hash-ancien');
    const setters = makeSetters();
    const { result } = renderHook(() => useSessionLifecycle(setters, creds, null, t));

    await act(async () => { await result.current.resumeSession(); });

    expect(setters.setSourceChanged).toHaveBeenCalledWith(true);
    expect(syncOnLogin).not.toHaveBeenCalled();
    expect(setters.setIsLoggedIn).not.toHaveBeenCalled();
  });

  it('déconnexion pendant la reprise : pas d\'accueil ouvert ni de re-liaison ensuite', async () => {
    const sync = deferred<{ cloudWatchlistItems: [] }>();
    vi.mocked(syncOnLogin).mockImplementationOnce(() => sync.promise as never);
    const setters = makeSetters();
    const { result } = renderHook(() => useSessionLifecycle(setters, creds, null, t));

    let resume: Promise<void> = Promise.resolve();
    await act(async () => { resume = result.current.resumeSession(); });
    await act(async () => { await result.current.logout(); });
    await act(async () => { sync.resolve({ cloudWatchlistItems: [] }); await resume; });

    expect(relinkWatchlistStreamIds).not.toHaveBeenCalled();
    expect(setters.setIsLoggedIn).not.toHaveBeenCalledWith(true);
    expect(startCloudResync).not.toHaveBeenCalled();
  });

  it('déconnexion avant la réponse du fournisseur : ses infos de compte ne reviennent pas après (carte « Compte »)', async () => {
    const auth = deferred<unknown>();
    authenticate.mockImplementationOnce(() => auth.promise);
    const setters = makeSetters();
    const { result } = renderHook(() => useSessionLifecycle(setters, creds, null, t));

    // Reprise terminée, réponse du fournisseur encore en route (appel sans attente)
    await act(async () => { await result.current.resumeSession(); });
    expect(authenticate).toHaveBeenCalledTimes(1);
    await act(async () => { await result.current.logout(); });
    await act(async () => { auth.resolve({ user_info: { status: 'Active', username: 'ancien' } }); await auth.promise; });

    expect(setters.setAccountInfo).not.toHaveBeenCalledWith(expect.objectContaining({ username: 'ancien' }));
    expect(setters.setAccountInfo).toHaveBeenLastCalledWith(null);
  });

  it('déconnexion juste avant l\'appel au fournisseur : ni appel, ni identifiants, ni « source changée »', async () => {
    const lastProvider = deferred<string | null>();
    vi.mocked(getMeta).mockImplementation(async (key: string) => (key === 'lastProvider' ? lastProvider.promise : null));
    const setters = makeSetters();
    const { result } = renderHook(() => useSessionLifecycle(setters, creds, null, t));

    let resume: Promise<void> = Promise.resolve();
    await act(async () => { resume = result.current.resumeSession(); });
    await act(async () => { await result.current.logout(); });
    // Autre fournisseur noté dans la base : la reprise aurait affiché le bandeau « source changée »
    await act(async () => { lastProvider.resolve('http://autre-fournisseur'); await resume; });

    expect(authenticate).not.toHaveBeenCalled();
    expect(setters.setCredentials).not.toHaveBeenCalledWith(creds);
    expect(setters.setSourceChanged).not.toHaveBeenCalledWith(true);
  });

  it('synchro en échec : la reprise continue sur les données de l\'appareil', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(syncOnLogin).mockRejectedValueOnce(new Error('hors ligne'));
    const setters = makeSetters();
    const { result } = renderHook(() => useSessionLifecycle(setters, creds, null, t));

    await act(async () => { await result.current.resumeSession(); });

    expect(setters.setIsLoggedIn).toHaveBeenCalledWith(true);
    expect(relinkWatchlistStreamIds).toHaveBeenCalledWith(freshIndexes, 'hash-fournisseur', [], expect.any(Object));
    error.mockRestore();
  });
});

// ============================================================================
// CHANGER D'IDENTIFIANTS DANS LES RÉGLAGES
// ============================================================================

describe('useSessionLifecycle — identifiants modifiés dans les Réglages', () => {
  const sameHost = { ...creds, username: 'nouveau', password: 'autre-factice' };

  it('même serveur : identifiants vérifiés, puis rangés et repris par l\'actualisation automatique', async () => {
    authenticate.mockResolvedValueOnce({ user_info: { status: 'Active', username: 'nouveau' } });
    const setters = makeSetters();
    const { result } = renderHook(() => useSessionLifecycle(setters, creds, null, t));

    await act(async () => { await result.current.updateCredentials(sameHost); });

    expect(authenticate).toHaveBeenCalledTimes(1);
    expect(setters.setCredentials).toHaveBeenCalledWith(sameHost);
    expect(setters.setAccountInfo).toHaveBeenCalledWith({ status: 'Active', username: 'nouveau' });
    expect(StorageService.saveCredentials).toHaveBeenCalledWith(sameHost);
    expect(updateAutoRefreshCredentials).toHaveBeenCalledWith(sameHost);
    expect(order(authenticate)).toBeLessThan(order(StorageService.saveCredentials));
    // Simple nouvelle vérification : le catalogue n'est pas relu
    expect(ingestCatalog).not.toHaveBeenCalled();
  });

  it.each([
    ['identifiants refusés', new Error('Authentication failed')],
    ['serveur du fournisseur injoignable', 'provider_server_error: HTTP 503'],
  ])('%s : l\'erreur remonte au formulaire, les anciens identifiants restent', async (_label, failure) => {
    authenticate.mockRejectedValueOnce(failure);
    const setters = makeSetters();
    const { result } = renderHook(() => useSessionLifecycle(setters, creds, null, t));

    let caught: unknown = null;
    await act(async () => {
      await result.current.updateCredentials(sameHost).catch((e: unknown) => { caught = e; });
    });

    expect(caught).toBe(failure);
    expect(setters.setCredentials).not.toHaveBeenCalled();
    expect(StorageService.saveCredentials).not.toHaveBeenCalled();
    expect(updateAutoRefreshCredentials).not.toHaveBeenCalled();
  });

  it('autre serveur : changement de fournisseur à confirmer, rien n\'est vérifié ni rangé avant', async () => {
    const other = { host: 'http://autre-fournisseur.invalid', username: 'u', password: 'p' };
    const setters = makeSetters();
    const { result } = renderHook(() => useSessionLifecycle(setters, creds, null, t));

    await act(async () => { await result.current.updateCredentials(other); });

    expect(setters.setPendingProviderChange).toHaveBeenCalledWith({ from: creds.host, to: other.host, creds: other });
    expect(authenticate).not.toHaveBeenCalled();
    expect(StorageService.saveCredentials).not.toHaveBeenCalled();
  });

  it('changement de fournisseur refusé : rien n\'est effacé ni relu', async () => {
    const other = { host: 'http://autre-fournisseur.invalid', username: 'u', password: 'p' };
    const setters = makeSetters();
    const pending = { from: creds.host, to: other.host, creds: other };
    const { result } = renderHook(() => useSessionLifecycle(setters, creds, pending, t));

    await act(async () => { await result.current.confirmProviderChange(false); });

    expect(setters.setPendingProviderChange).toHaveBeenCalledWith(null);
    expect(clearCatalogData).not.toHaveBeenCalled();
    expect(ingestCatalog).not.toHaveBeenCalled();
  });
});

// ============================================================================
// PETITS CAS RARES
// ============================================================================

describe('useSessionLifecycle — cas rares de session', () => {
  const executed = async () => {
    const statements: string[] = [];
    for (const result of vi.mocked(getDatabase).mock.results) {
      const db = await result.value;
      for (const call of db?.execute.mock.calls ?? []) statements.push(String((call as unknown[])[0]));
    }
    return statements;
  };

  it("changement de fournisseur confirmé, autre compte entre-temps : rien n'est effacé dans sa base", async () => {
    vi.mocked(fetchCloudProviderHash).mockResolvedValueOnce('hash-ancien');
    const setters = makeSetters();
    let pending: Parameters<SessionSetters['setPendingProviderChange']>[0] = null;
    vi.mocked(setters.setPendingProviderChange).mockImplementation((v) => { pending = v; });
    const { result, rerender } = renderHook(() => useSessionLifecycle(setters, creds, pending, t));

    await act(async () => { await result.current.login(creds); });
    rerender();
    // Un autre compte prend la place pendant les préparatifs de la connexion confirmée
    vi.mocked(initPreferences).mockImplementationOnce(async () => { openAccount = 'compte-b'; });
    await act(async () => { await result.current.confirmProviderChange(true); });

    expect(await executed()).not.toContain('DELETE FROM playback_progress');
    expect(purgeProviderCloudData).not.toHaveBeenCalled();
    expect(ingestCatalog).not.toHaveBeenCalled();
    expect(setters.setIsLoading).toHaveBeenLastCalledWith(false);
  });

  it("« Actualiser » après un changement d'adresse : empreinte du nouveau fournisseur notée", async () => {
    vi.mocked(getMeta).mockImplementation(async (key: string) => (key === 'lastProvider' ? 'http://ancien-fournisseur' : null));
    const setters = makeSetters();
    const { result } = renderHook(() => useSessionLifecycle(setters, creds, null, t));

    await act(async () => { await result.current.refreshSources(); });

    expect(await executed()).toContain('DELETE FROM playback_progress');
    expect(setMeta).toHaveBeenCalledWith('lastProvider', creds.host);
    expect(setLastProviderHash).toHaveBeenCalledWith(creds.host);
  });

  it("« Actualiser » après un changement d'adresse, autre compte entre-temps : rien n'est effacé", async () => {
    vi.mocked(getMeta).mockImplementation(async (key: string) => {
      if (key !== 'lastProvider') return null;
      vi.mocked(getCurrentSyncUserId).mockReturnValue('compte-b');
      return 'http://ancien-fournisseur';
    });
    const setters = makeSetters();
    const { result } = renderHook(() => useSessionLifecycle(setters, creds, null, t));

    await act(async () => { await result.current.refreshSources(); });
    vi.mocked(getCurrentSyncUserId).mockReturnValue('compte-a');

    expect(await executed()).not.toContain('DELETE FROM playback_progress');
    expect(setMeta).not.toHaveBeenCalledWith('lastProvider', creds.host);
    expect(ingestCatalog).not.toHaveBeenCalled();
    expect(setters.setIsLoading).toHaveBeenLastCalledWith(false);
  });

  it("« Actualiser », autre compte pendant l'effacement du cloud : ni adresse ni empreinte notées chez lui", async () => {
    vi.mocked(getMeta).mockImplementation(async (key: string) => (key === 'lastProvider' ? 'http://ancien-fournisseur' : null));
    vi.mocked(purgeProviderCloudData).mockImplementationOnce(async () => {
      vi.mocked(getCurrentSyncUserId).mockReturnValue('compte-b');
      return true;
    });
    const setters = makeSetters();
    const { result } = renderHook(() => useSessionLifecycle(setters, creds, null, t));

    await act(async () => { await result.current.refreshSources(); });
    vi.mocked(getCurrentSyncUserId).mockReturnValue('compte-a');

    expect(setMeta).not.toHaveBeenCalledWith('lastProvider', creds.host);
    expect(setLastProviderHash).not.toHaveBeenCalled();
    expect(ingestCatalog).not.toHaveBeenCalled();
    // L'effacement garde les lignes du nouveau fournisseur (empreinte de sa nouvelle adresse)
    expect(purgeProviderCloudData).toHaveBeenCalledWith('compte-a', 'hash-fournisseur');
  });

  it("journaux de développement : jamais l'adresse du fournisseur", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    vi.mocked(getMeta).mockImplementation(async (key: string) => (key === 'lastProvider' ? 'http://ancien-fournisseur' : null));
    const setters = makeSetters();
    const { result } = renderHook(() => useSessionLifecycle(setters, creds, null, t));

    await act(async () => { await result.current.login(creds); });
    await act(async () => { await result.current.refreshSources(); });
    await act(async () => { vi.advanceTimersByTime(500); });

    const logged = JSON.stringify(vi.mocked(devLog).mock.calls);
    expect(vi.mocked(devLog).mock.calls.length).toBeGreaterThan(0);
    expect(logged).not.toContain('http://');
  });
});

// ============================================================================
// MÊME FOURNISSEUR ÉCRIT AUTREMENT
// ============================================================================

describe('useSessionLifecycle — même serveur écrit autrement', () => {
  // Empreinte lisible : celle de l'écriture exacte de l'adresse, comme le vrai SHA-256
  beforeEach(() => {
    vi.mocked(computeProviderHash).mockImplementation(async (host: string) => `h:${host}`);
  });
  afterEach(() => {
    vi.mocked(computeProviderHash).mockImplementation(async () => 'hash-fournisseur');
    noteTypedProviderHost('');
  });

  it('adresse avec « / » final, empreinte du cloud sans : ni dialogue ni effacement, écriture du compte gardée', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    vi.mocked(fetchCloudProviderHash).mockResolvedValueOnce('h:http://fournisseur');
    const typed = { ...creds, host: 'http://fournisseur/' };
    const setters = makeSetters();
    const { result } = renderHook(() => useSessionLifecycle(setters, creds, null, t));

    await act(async () => { await result.current.login(typed); });
    await act(async () => { vi.advanceTimersByTime(500); });

    expect(setters.setPendingProviderChange).not.toHaveBeenCalled();
    expect(purgeProviderCloudData).not.toHaveBeenCalled();
    const db = await vi.mocked(getDatabase).mock.results[0]?.value;
    const statements = (db?.execute.mock.calls ?? []).map((call: unknown[]) => String(call[0]));
    expect(statements).not.toContain('DELETE FROM playback_progress');
    // Empreinte inchangée : reprises, favoris et titres déjà enregistrés restent ceux de ce fournisseur
    expect(setMeta).toHaveBeenCalledWith('lastProvider', 'http://fournisseur');
    expect(setLastProviderHash).toHaveBeenCalledWith('http://fournisseur');
    expect(setters.setIsLoggedIn).toHaveBeenCalledWith(true);
  });

  it('empreinte ancienne calculée sur une adresse avec « / » final : reconnue, pas de faux changement après la mise à jour', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    vi.mocked(fetchCloudProviderHash).mockResolvedValueOnce('h:http://fournisseur/');
    const setters = makeSetters();
    const { result } = renderHook(() => useSessionLifecycle(setters, creds, null, t));

    await act(async () => { await result.current.login(creds); });

    expect(setters.setPendingProviderChange).not.toHaveBeenCalled();
    expect(purgeProviderCloudData).not.toHaveBeenCalled();
    expect(setLastProviderHash).toHaveBeenCalledWith('http://fournisseur/');
  });

  it('adresse notée sur l\'appareil avec majuscules et « / » final : même fournisseur, catalogue gardé', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    vi.mocked(getMeta).mockImplementation(async (key: string) => (key === 'lastProvider' ? 'Http://Fournisseur/' : null));
    const setters = makeSetters();
    const { result } = renderHook(() => useSessionLifecycle(setters, creds, null, t));

    await act(async () => { await result.current.login(creds); });

    expect(setters.setPendingProviderChange).not.toHaveBeenCalled();
    expect(clearCatalogData).not.toHaveBeenCalled();
    expect(setMeta).toHaveBeenCalledWith('lastProvider', 'Http://Fournisseur/');
  });

  it('appareil neuf, empreinte ancienne d\'une écriture inhabituelle (majuscules au milieu, espace, « // ») : retrouvée par la saisie brute', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const raw = ' http://MonFournisseur.example//';
    vi.mocked(fetchCloudProviderHash).mockResolvedValueOnce(`h:${raw}`);
    noteTypedProviderHost(raw);
    const setters = makeSetters();
    const { result } = renderHook(() => useSessionLifecycle(setters, creds, null, t));

    await act(async () => { await result.current.login({ ...creds, host: normalizeProviderHost(raw) }); });

    expect(setters.setPendingProviderChange).not.toHaveBeenCalled();
    expect(purgeProviderCloudData).not.toHaveBeenCalled();
    expect(setLastProviderHash).toHaveBeenCalledWith(raw);
  });

  it('https au lieu de http pour le même hôte : même fournisseur', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    vi.mocked(fetchCloudProviderHash).mockResolvedValueOnce('h:http://fournisseur');
    const setters = makeSetters();
    const { result } = renderHook(() => useSessionLifecycle(setters, creds, null, t));

    await act(async () => { await result.current.login({ ...creds, host: 'https://fournisseur' }); });

    expect(setters.setPendingProviderChange).not.toHaveBeenCalled();
    expect(purgeProviderCloudData).not.toHaveBeenCalled();
  });

  it('un autre serveur reste un changement de fournisseur à confirmer', async () => {
    vi.mocked(fetchCloudProviderHash).mockResolvedValueOnce('h:http://autre-fournisseur');
    const setters = makeSetters();
    const { result } = renderHook(() => useSessionLifecycle(setters, creds, null, t));

    await act(async () => { await result.current.login(creds); });

    expect(setters.setPendingProviderChange).toHaveBeenCalledWith({ from: '***', to: creds.host, creds });
    expect(ingestCatalog).not.toHaveBeenCalled();
  });

  it('reprise : empreinte du cloud sur l\'adresse avec « / » final, identifiants sans : pas de retour forcé à la connexion', async () => {
    vi.mocked(fetchCloudProviderHash).mockResolvedValueOnce('h:http://fournisseur/');
    vi.mocked(getMeta).mockImplementation(async (key: string) => (key === 'lastProvider' ? 'http://fournisseur/' : null));
    const setters = makeSetters();
    const { result } = renderHook(() => useSessionLifecycle(setters, creds, null, t));

    await act(async () => { await result.current.resumeSession(); });

    expect(setters.setSourceChanged).toHaveBeenCalledWith(false);
    expect(setters.setSourceChanged).not.toHaveBeenCalledWith(true);
    expect(syncOnLogin).toHaveBeenCalledWith('compte-a');
    expect(setters.setIsLoggedIn).toHaveBeenCalledWith(true);
  });

  it('Réglages : même serveur avec « / » final, simple nouvelle vérification sans dialogue', async () => {
    const setters = makeSetters();
    const { result } = renderHook(() => useSessionLifecycle(setters, creds, null, t));

    await act(async () => { await result.current.updateCredentials({ ...creds, host: 'http://fournisseur/' }); });

    expect(setters.setPendingProviderChange).not.toHaveBeenCalled();
    expect(authenticate).toHaveBeenCalledTimes(1);
  });

  it('vrai changement confirmé, nouveau fournisseur déjà connu du compte sous une autre écriture : ses lignes du cloud sont gardées', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    // Un autre appareil est déjà passé à ce fournisseur, noté « http://fournisseur/ » ; cet appareil avait l'ancien
    vi.mocked(fetchCloudProviderHash).mockResolvedValueOnce('h:http://fournisseur/').mockResolvedValueOnce('h:http://fournisseur/');
    vi.mocked(getMeta).mockImplementation(async (key: string) => (key === 'lastProvider' ? 'http://ancien-fournisseur' : null));
    const setters = makeSetters();
    let pending: Parameters<SessionSetters['setPendingProviderChange']>[0] = null;
    vi.mocked(setters.setPendingProviderChange).mockImplementation((v) => { pending = v; });
    const { result, rerender } = renderHook(() => useSessionLifecycle(setters, creds, pending, t));

    await act(async () => { await result.current.login(creds); });
    expect(pending).not.toBeNull();
    rerender();
    await act(async () => { await result.current.confirmProviderChange(true); });
    await act(async () => { vi.advanceTimersByTime(500); });

    expect(purgeProviderCloudData).toHaveBeenCalledWith('compte-a', 'h:http://fournisseur/');
    expect(setMeta).toHaveBeenCalledWith('lastProvider', 'http://fournisseur/');
  });

  it('« Actualiser » sur un vrai changement : l\'adresse notée est l\'adresse nettoyée', async () => {
    vi.mocked(getMeta).mockImplementation(async (key: string) => (key === 'lastProvider' ? 'http://ancien-fournisseur' : null));
    const setters = makeSetters();
    const { result } = renderHook(() => useSessionLifecycle(setters, { ...creds, host: 'Http://Fournisseur/' }, null, t));

    await act(async () => { await result.current.refreshSources(); });

    expect(setMeta).toHaveBeenCalledWith('lastProvider', 'http://fournisseur');
    expect(purgeProviderCloudData).toHaveBeenCalledWith('compte-a', 'h:http://fournisseur');
  });

  it('changement annulé : un message dit que rien n\'a été supprimé et pourquoi le dialogue est venu', async () => {
    const other = { host: 'http://autre-fournisseur.invalid', username: 'u', password: 'p' };
    const setters = makeSetters();
    const { result } = renderHook(() => useSessionLifecycle(setters, creds, { from: '***', to: other.host, creds: other }, t));

    await act(async () => { await result.current.confirmProviderChange(false); });

    expect(setters.setSessionError).toHaveBeenCalledWith('common:provider_change_cancelled');
    expect(ingestCatalog).not.toHaveBeenCalled();
  });
});

// ============================================================================
// BASE DE L'APPAREIL ABÎMÉE
// ============================================================================

describe('useSessionLifecycle — base de l\'appareil abîmée', () => {
  it('connexion en échec sur une base abîmée : le message le dit (pas « vérifiez vos identifiants ») et la base est contrôlée', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(ingestCatalog).mockRejectedValueOnce('error returned from database: (code: 26) file is not a database');
    const setters = makeSetters();
    const { result } = renderHook(() => useSessionLifecycle(setters, creds, null, t));

    await act(async () => { await result.current.login(creds); });

    expect(setters.setSessionError).toHaveBeenCalledWith('common:local_db_damaged_error');
    expect(setters.setSessionError).not.toHaveBeenCalledWith('auth:error_login_failed');
    expect(checkLocalDatabase).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });

  it('base illisible dès son ouverture : message « base abîmée » et plus de sablier sans fin', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(initPreferences).mockRejectedValueOnce('error returned from database: (code: 26) file is not a database');
    const setters = makeSetters();
    const { result } = renderHook(() => useSessionLifecycle(setters, creds, null, t));

    await act(async () => { await result.current.login(creds); });

    expect(setters.setSessionError).toHaveBeenCalledWith('common:local_db_damaged_error');
    expect(setters.setIsLoading).toHaveBeenLastCalledWith(false);
    expect(ingestCatalog).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it('erreur qui ressemble à une base abîmée mais base saine au contrôle : message habituel', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(checkLocalDatabase).mockResolvedValueOnce('ok');
    vi.mocked(ingestCatalog).mockRejectedValueOnce('file is not a database');
    const setters = makeSetters();
    const { result } = renderHook(() => useSessionLifecycle(setters, creds, null, t));

    await act(async () => { await result.current.login(creds); });

    expect(setters.setSessionError).toHaveBeenCalledWith('auth:error_login_failed');
    expect(setters.setSessionError).not.toHaveBeenCalledWith('common:local_db_damaged_error');
    error.mockRestore();
  });

  it('dernière adresse illisible dans la base : la connexion continue jusqu\'à son vrai message, sans rester bloquée', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(getMeta).mockRejectedValue(new Error('database disk image is malformed'));
    const setters = makeSetters();
    const { result } = renderHook(() => useSessionLifecycle(setters, creds, null, t));

    await act(async () => { await result.current.login(creds); });

    expect(setters.setSessionError).toHaveBeenCalledWith('common:local_db_damaged_error');
    expect(setters.setIsLoading).toHaveBeenLastCalledWith(false);
    error.mockRestore();
  });

  // Base abîmée (constaté sur téléphone) : sur l'écran des profils, chaque clic échouait sans rien montrer
  // (« Uncaught (in promise) … (code: 26) ») et l'écran ne changeait pas
  it('choix du profil sur une base abîmée : le clic aboutit quand même et la base est contrôlée', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(setMeta).mockRejectedValueOnce('error returned from database: (code: 26) file is not a database');
    const setters = makeSetters();
    const { result } = renderHook(() => useSessionLifecycle(setters, creds, null, t));

    await act(async () => { await expect(result.current.selectProfile('profil-1')).resolves.toBeUndefined(); });

    expect(setters.setActiveProfileId).toHaveBeenCalledWith('profil-1');
    expect(checkLocalDatabase).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('choix du profil, base déjà reconnue abîmée au démarrage : pas de nouveau contrôle à chaque clic', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(isLocalDatabaseDamaged).mockReturnValueOnce(true);
    vi.mocked(setMeta).mockRejectedValueOnce('error returned from database: (code: 26) file is not a database');
    const setters = makeSetters();
    const { result } = renderHook(() => useSessionLifecycle(setters, creds, null, t));

    await act(async () => { await expect(result.current.selectProfile('profil-1')).resolves.toBeUndefined(); });

    expect(checkLocalDatabase).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('choix du profil, autre erreur de la base : le clic aboutit aussi, sans contrôle complet de la base', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(setMeta).mockRejectedValueOnce(new Error('database is locked'));
    const setters = makeSetters();
    const { result } = renderHook(() => useSessionLifecycle(setters, creds, null, t));

    await act(async () => { await expect(result.current.selectProfile('profil-1')).resolves.toBeUndefined(); });

    expect(checkLocalDatabase).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
