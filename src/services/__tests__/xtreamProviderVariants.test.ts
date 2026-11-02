/**
 * Tests : réponses de fournisseurs qui s'écartent de la forme habituelle (abonnement expiré,
 * `auth` envoyé en texte, avertissements PHP avant la réponse). Chaque cas vient d'un panneau réel.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const iptvFetchMock = vi.fn<(url: string) => Promise<string>>();
vi.mock('../networkService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../networkService')>();
  return { ...actual, iptvFetch: (url: string) => iptvFetchMock(url) };
});
vi.mock('../xtreamSeriesCache', () => ({
  getCachedXtreamSeries: vi.fn(async () => null),
  setCachedXtreamSeries: vi.fn(async () => undefined),
}));

import {
  XtreamApiService,
  isCredentialsRejectedError,
  inactiveAccountInfo,
  isProviderAccountInactiveError,
  isProviderHtmlResponseError,
  liveExtensionFor,
} from '../xtreamApi';

const creds = { host: 'http://provider.example:8080', username: 'jean', password: 'motdepasse' };

const account = (userInfo: Record<string, unknown>): string =>
  JSON.stringify({ user_info: { username: 'jean', ...userInfo }, server_info: { url: 'provider.example' } });

async function authOutcome(body: string): Promise<{ ok: true } | { ok: false; error: unknown }> {
  iptvFetchMock.mockResolvedValue(body);
  return new XtreamApiService(creds).authenticate().then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

describe('XtreamApiService.authenticate : variantes de fournisseurs', () => {
  beforeEach(() => {
    iptvFetchMock.mockReset();
  });

  it('abonnement actif : la connexion passe', async () => {
    expect(await authOutcome(account({ auth: 1, status: 'Active' }))).toEqual({ ok: true });
  });

  it.each(['Expired', 'Banned', 'Disabled', ' expired '])(
    'état « %s » : erreur « abonnement expiré ou suspendu », pas une connexion réussie',
    async (status) => {
      const outcome = await authOutcome(account({ auth: 1, status }));
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(isProviderAccountInactiveError(outcome.error)).toBe(true);
      expect(isCredentialsRejectedError(outcome.error)).toBe(false);
    },
  );

  it('date d’expiration passée mais état « Active » : la connexion passe (abonnements illimités mal datés)', async () => {
    expect(await authOutcome(account({ auth: 1, status: 'Active', exp_date: '1500000000' }))).toEqual({ ok: true });
  });

  it('état absent ou inconnu : la connexion passe comme avant', async () => {
    expect(await authOutcome(account({ auth: 1 }))).toEqual({ ok: true });
    expect(await authOutcome(account({ auth: 1, status: 'Trial' }))).toEqual({ ok: true });
  });

  it('« auth » envoyé en texte « 0 » : identifiants refusés', async () => {
    const outcome = await authOutcome(account({ auth: '0' }));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(isCredentialsRejectedError(outcome.error)).toBe(true);
  });

  it.each([null, '', 'yes'])('« auth » à %j (forme inconnue) : la connexion passe comme avant', async (auth) => {
    expect(await authOutcome(account({ auth, status: 'Active' }))).toEqual({ ok: true });
  });

  it('abonnement expiré : les infos du compte restent jointes à l’erreur (carte « Compte »)', async () => {
    const outcome = await authOutcome(account({ auth: 1, status: 'Expired', exp_date: '1700000000' }));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(inactiveAccountInfo(outcome.error)).toMatchObject({ status: 'Expired', exp_date: '1700000000' });
  });

  it('abonnement expiré : ni l’identifiant ni le mot de passe dans l’erreur, même journalisée', async () => {
    const outcome = await authOutcome(account({ auth: 1, status: 'Expired', password: 'motdepasse' }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    const info = inactiveAccountInfo(outcome.error) ?? {};
    expect(info).not.toHaveProperty('password');
    expect(info).not.toHaveProperty('username');
    // Les journaux recopient les propriétés propres et énumérables d'une erreur
    expect(Object.keys(outcome.error as object)).toEqual([]);
    expect(JSON.stringify(outcome.error)).not.toContain('motdepasse');
    expect(JSON.stringify({ ...(outcome.error as object) })).not.toContain('jean');
  });

  it('« auth » envoyé en texte « 1 » : la connexion passe', async () => {
    expect(await authOutcome(account({ auth: '1', status: 'Active' }))).toEqual({ ok: true });
  });

  it('avertissements PHP avant la réponse : la réponse est lue', async () => {
    const notice = '<br />\n<b>Deprecated</b>:  Function create_function() is deprecated in <b>/home/xtreamcodes/iptv_xtream_codes/wwwdir/player_api.php</b> on line <b>12</b><br />\n';
    expect(await authOutcome(notice + account({ auth: 1, status: 'Active' }))).toEqual({ ok: true });
  });

  it('avertissement PHP avant un refus : toujours un refus des identifiants', async () => {
    const outcome = await authOutcome('<br />\n<b>Notice</b>: Undefined index "x"<br />\n{"user_info":{"auth":0}}');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(isCredentialsRejectedError(outcome.error)).toBe(true);
  });

  it('vraie page web contenant du JSON (Cloudflare) : toujours « page web », jamais lue comme un compte', async () => {
    const page = '<!DOCTYPE html><html><head><title>Just a moment...</title><script>window._cf={"user_info":{"auth":1}}</script></head><body></body></html>';
    const outcome = await authOutcome(page);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(isProviderHtmlResponseError(outcome.error)).toBe(true);
  });

  it('page web sans JSON : toujours « page web »', async () => {
    const outcome = await authOutcome('<html><body><h1>Maintenance</h1></body></html>');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(isProviderHtmlResponseError(outcome.error)).toBe(true);
  });
});

describe('XtreamApiService : listes et fiches précédées d’avertissements PHP', () => {
  beforeEach(() => {
    iptvFetchMock.mockReset();
  });

  it('catégories : la liste est lue', async () => {
    iptvFetchMock.mockResolvedValue('<br /><b>Warning</b>: x<br />[{"category_id":"1","category_name":"Films"}]');
    const categories = await new XtreamApiService(creds).getCategories('get_vod_categories');
    expect(categories).toEqual([{ category_id: '1', category_name: 'Films' }]);
  });

  it('fiche d’une série : la fiche est lue', async () => {
    iptvFetchMock.mockResolvedValue('<br /><b>Notice</b>: y<br />{"info":{"name":"Série"},"episodes":{"1":[{"id":"7","episode_num":1}]}}');
    const info = await new XtreamApiService(creds).getSeriesInfo(42);
    expect(info?.info?.name).toBe('Série');
  });

  it('page web à la place d’une liste : liste vide, comme avant', async () => {
    iptvFetchMock.mockResolvedValue('<html><body>[{"category_id":"1"}]</body></html>');
    expect(await new XtreamApiService(creds).getCategories('get_vod_categories')).toEqual([]);
  });
});

describe('XtreamApiService : liste envoyée comme objet à clés numériques', () => {
  beforeEach(() => {
    iptvFetchMock.mockReset();
  });

  it('catégories en objet : lues comme une liste', async () => {
    iptvFetchMock.mockResolvedValue('{"0":{"category_id":"1","category_name":"Films"},"4":{"category_id":"5","category_name":"Séries"}}');
    const categories = await new XtreamApiService(creds).getCategories('get_vod_categories');
    expect(categories.map((c) => c.category_id)).toEqual(['1', '5']);
  });

  it('films en objet : lus, numéro TMDB normalisé', async () => {
    iptvFetchMock.mockResolvedValue('{"2":{"stream_id":7,"name":"A","tmdb":"603"}}');
    const movies = await new XtreamApiService(creds).getVodStreams();
    expect(movies).toHaveLength(1);
    expect(movies[0].stream_id).toBe(7);
  });

  it('objet d’erreur à la place d’une liste : liste vide, comme avant', async () => {
    iptvFetchMock.mockResolvedValue('{"user_info":{"auth":0}}');
    expect(await new XtreamApiService(creds).getLiveStreams()).toEqual([]);
    expect(await new XtreamApiService(creds).getSeries()).toEqual([]);
  });
});

describe('Format du direct selon allowed_output_formats', () => {
  beforeEach(() => {
    iptvFetchMock.mockReset();
  });

  it.each([
    [['m3u8'], 'm3u8'],
    [[' HLS ', 'M3U8'], 'm3u8'],
    [['m3u8', 'ts'], undefined],
    [['ts'], undefined],
    [['rtmp'], undefined],
    [[], undefined],
    [undefined, undefined],
    ['m3u8', undefined],
  ])('formats %j → %s', (formats, expected) => {
    expect(liveExtensionFor(formats)).toBe(expected);
  });

  it('compte « m3u8 seulement » : les chaînes sont demandées en m3u8 après l’authentification', async () => {
    const api = new XtreamApiService({ ...creds, username: 'hls-seulement' });
    expect(api.getStreamUrl('live', 5, api.preferredLiveExtension())).toBe('http://provider.example:8080/live/hls-seulement/motdepasse/5.ts');
    iptvFetchMock.mockResolvedValue(account({ auth: 1, status: 'Active', allowed_output_formats: ['m3u8'] }));
    await api.authenticate();
    // Nouvelle instance du même compte (une par lecture) : même choix
    const next = new XtreamApiService({ ...creds, username: 'hls-seulement' });
    expect(next.getStreamUrl('live', 5, next.preferredLiveExtension())).toBe('http://provider.example:8080/live/hls-seulement/motdepasse/5.m3u8');
    // Un autre compte n'est pas concerné
    expect(new XtreamApiService(creds).preferredLiveExtension()).toBeUndefined();
  });
});
