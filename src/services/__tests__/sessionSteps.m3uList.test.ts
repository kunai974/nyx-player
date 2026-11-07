/**
 * Session ouverte sur une liste M3U : le catalogue vient de la liste (pas d'authentification
 * Xtream, pas de compte à afficher) et l'actualisation automatique, propre à l'API Xtream, ne
 * démarre pas. Services voisins simulés, aucun réseau.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const ingestResult = { movies_count: 1, series_count: 0, live_count: 2, categories_count: 1, partial: false, failed_endpoints: [], too_large_endpoints: [] };
const authenticate = vi.fn(async () => ({ user_info: { status: 'Active' } }));

vi.mock('../xtreamApi', () => ({ XtreamApiService: vi.fn(function () { return { authenticate }; }) }));
vi.mock('../catalogIngestion', () => ({
  ingestCatalog: vi.fn(async () => ingestResult),
  ingestM3uCatalog: vi.fn(async () => ingestResult),
  whenEpgLinksReady: vi.fn(async () => {}),
}));
vi.mock('../catalogLight', () => ({ loadLightIndexes: vi.fn(async () => ({ movies: new Map(), series: new Map(), live: new Map() })) }));
vi.mock('../dbCore', () => ({
  setMeta: vi.fn(async () => {}), getMeta: vi.fn(async () => null), refreshConnection: vi.fn(async () => {}),
  getDatabase: vi.fn(async () => ({})), getDatabaseFileName: vi.fn(() => 'nyx_test.db'), isDatabaseOf: vi.fn(() => true),
}));
vi.mock('../searchIndex', () => ({ rebuildSearchIndex: vi.fn(async () => {}) }));
vi.mock('../catalogAutoRefresh', () => ({ noteListsToRetry: vi.fn(async () => {}), startCatalogAutoRefresh: vi.fn() }));
vi.mock('../catalogSwapGate', () => ({ readChangesSeq: vi.fn(async () => 0) }));

import { performIngestion, startAutoRefresh } from '../sessionSteps';
import { ingestCatalog, ingestM3uCatalog } from '../catalogIngestion';
import { startCatalogAutoRefresh } from '../catalogAutoRefresh';
import type { XtreamCredentials } from '../../types/iptv';

const m3uCreds: XtreamCredentials = { host: 'm3u:liste.invalid', username: '', password: '', m3u: { url: 'http://liste.invalid/l.m3u?token=t' } };
const xtreamCreds: XtreamCredentials = { host: 'http://fournisseur.invalid', username: 'u', password: 'p' };

beforeEach(() => { vi.clearAllMocks(); });

describe('performIngestion — liste M3U', () => {
  it('lit la liste par son adresse, sans authentification Xtream ni compte', async () => {
    const result = await performIngestion(m3uCreds, () => {});
    expect(ingestM3uCatalog).toHaveBeenCalledWith('http://liste.invalid/l.m3u?token=t', undefined, expect.any(Function));
    expect(ingestCatalog).not.toHaveBeenCalled();
    expect(authenticate).not.toHaveBeenCalled();
    expect(result.userInfo).toBeNull();
  });

  it('abonnement Xtream : authentification puis lecture de l\'API, comme avant', async () => {
    const result = await performIngestion(xtreamCreds, () => {});
    expect(authenticate).toHaveBeenCalledTimes(1);
    expect(ingestCatalog).toHaveBeenCalledWith('http://fournisseur.invalid', 'u', 'p', undefined, expect.any(Function));
    expect(ingestM3uCatalog).not.toHaveBeenCalled();
    expect(result.userInfo).toEqual({ status: 'Active' });
  });
});

describe('startAutoRefresh', () => {
  it('liste M3U : pas d\'actualisation automatique', () => {
    startAutoRefresh(m3uCreds);
    expect(startCatalogAutoRefresh).not.toHaveBeenCalled();
  });

  it('abonnement Xtream : actualisation automatique démarrée', () => {
    startAutoRefresh(xtreamCreds);
    expect(startCatalogAutoRefresh).toHaveBeenCalledTimes(1);
  });
});
