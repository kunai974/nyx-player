/**
 * Tests : un mauvais mot de passe refusé par une erreur 5xx du fournisseur est classé
 * « identifiants refusés », pas « le serveur ne répond pas » ; une vraie panne le reste.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const iptvFetchMock = vi.fn<(url: string) => Promise<string>>();
const iptvFetchPublicMock = vi.fn<(url: string) => Promise<string>>();
vi.mock('../networkService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../networkService')>();
  return { ...actual, iptvFetch: (url: string) => iptvFetchMock(url), iptvFetchPublic: (url: string) => iptvFetchPublicMock(url) };
});

import { XtreamApiService, isCredentialsRejectedError, isProviderHtmlResponseError } from '../xtreamApi';
import { isProviderServerError } from '../networkService';

const creds = { host: 'http://provider.example:8080', username: 'jean.dupont', password: 'faux' };
const isAuthUrl = (url: string) => url.includes('player_api.php');

async function authError(): Promise<unknown> {
  return new XtreamApiService(creds).authenticate().then(
    () => { throw new Error('authentification réussie inattendue'); },
    (error: unknown) => error,
  );
}

describe('XtreamApiService.authenticate : mauvais mot de passe ou serveur en panne', () => {
  beforeEach(() => {
    iptvFetchMock.mockReset();
    iptvFetchPublicMock.mockReset();
  });

  it('serveur reçu d\'un autre appareil : toutes les demandes, sonde comprise, passent par le chemin « adresses publiques seulement »', async () => {
    iptvFetchPublicMock.mockImplementation(async (url) => {
      if (isAuthUrl(url)) throw 'provider_server_error: HTTP 520';
      return '<html>nginx</html>';
    });
    const error = await new XtreamApiService(creds, { publicOnly: true }).authenticate().catch((e: unknown) => e);
    expect(isCredentialsRejectedError(error)).toBe(true);
    expect(iptvFetchPublicMock).toHaveBeenCalledTimes(2);
    expect(iptvFetchMock).not.toHaveBeenCalled();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('5xx sur l’authentification, serveur qui répond par ailleurs : identifiants refusés', async () => {
    iptvFetchMock.mockImplementation(async (url) => {
      if (isAuthUrl(url)) throw 'provider_server_error: HTTP 520';
      return '<html>nginx</html>';
    });
    const error = await authError();
    expect(isProviderServerError(error)).toBe(false);
    // Réglages > Sources affiche alors « mot de passe refusé »
    expect(isCredentialsRejectedError(error)).toBe(true);
    // La vérification ne renvoie jamais les identifiants
    const probe = iptvFetchMock.mock.calls.map(([url]) => url).find((url) => !isAuthUrl(url));
    expect(probe).toBe('http://provider.example:8080/');
  });

  it('429 sur l’authentification, serveur qui répond par ailleurs : le serveur ne répond pas, sans sonde', async () => {
    // Trop de demandes : le fournisseur demande de ralentir, rien ne dit que les identifiants sont faux
    iptvFetchMock.mockImplementation(async (url) => {
      if (isAuthUrl(url)) throw 'provider_server_error: HTTP 429';
      return '<html>nginx</html>';
    });
    const error = await authError();
    expect(isProviderServerError(error)).toBe(true);
    expect(isCredentialsRejectedError(error)).toBe(false);
    expect(iptvFetchMock).toHaveBeenCalledTimes(1);
  });

  it('5xx partout : le serveur ne répond pas', async () => {
    iptvFetchMock.mockRejectedValue('provider_server_error: HTTP 502');
    const error = await authError();
    expect(isProviderServerError(error)).toBe(true);
    expect(isCredentialsRejectedError(error)).toBe(false);
  });

  it('5xx puis serveur injoignable : le serveur ne répond pas', async () => {
    iptvFetchMock.mockImplementation(async (url) => {
      throw isAuthUrl(url) ? 'provider_server_error: HTTP 503' : 'provider_unreachable: timed out';
    });
    expect(isProviderServerError(await authError())).toBe(true);
  });

  it('serveur injoignable : pas de seconde requête, le serveur ne répond pas', async () => {
    iptvFetchMock.mockRejectedValue('provider_unreachable: connection refused');
    expect(isProviderServerError(await authError())).toBe(true);
    expect(iptvFetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['auth à 0 (réponse Xtream classique)', '{"user_info":{"auth":0}}'],
    ['texte non JSON', 'Unauthorized'],
    ['réponse vide', ''],
  ])('%s : identifiants refusés', async (_label, body) => {
    iptvFetchMock.mockResolvedValue(body);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = await authError();
    expect(isProviderServerError(error)).toBe(false);
    expect(isCredentialsRejectedError(error)).toBe(true);
  });

  // Une page web peut venir d'une maintenance comme d'un refus (certains panneaux) : le message dit les deux
  it('page de maintenance (200 avec du HTML) : plus « vérifiez vos identifiants » seul', async () => {
    iptvFetchMock.mockResolvedValue('<!DOCTYPE html><html><body>Maintenance</body></html>');
    const error = await authError();
    expect(isProviderHtmlResponseError(error)).toBe(true);
    expect(isCredentialsRejectedError(error)).toBe(false);
  });

  it('corps vide : reste un refus des identifiants (réponse habituelle à un mauvais mot de passe)', async () => {
    iptvFetchMock.mockResolvedValue('');
    const error = await authError();
    expect(isCredentialsRejectedError(error)).toBe(true);
    expect(isProviderHtmlResponseError(error)).toBe(false);
  });

  it('compte refusé par le fournisseur (auth 0) : refus des identifiants', async () => {
    iptvFetchMock.mockResolvedValue(JSON.stringify({ user_info: { auth: 0 } }));
    expect(isCredentialsRejectedError(await authError())).toBe(true);
  });
});
