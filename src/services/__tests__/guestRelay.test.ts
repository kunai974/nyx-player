/**
 * Relais TMDB de l'invité : un compte anonyme à part du client principal, créé à la première demande,
 * et l'app qui reste sous les limites du relais (minute, jour) et respecte ses pauses.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let space: { kind: 'account' | 'guest'; id: string } | null = { kind: 'guest', id: 'espace' };
vi.mock('../localSpace', () => ({ getOpenLocalSpace: () => space }));
vi.mock('../supabaseClient', () => ({ SUPABASE_STORAGE_KEY: 'sb-projet-auth-token' }));

let storedSession: { access_token: string } | null = null;
let signInResult: { data: { session: { access_token: string } | null }; error: { name: string } | null };
const signInAnonymously = vi.fn(async () => {
  if (signInResult.data.session) storedSession = signInResult.data.session;
  return signInResult;
});
const signOut = vi.fn(async () => { storedSession = null; return { error: null }; });
let refreshResult: { data: { session: { access_token: string } | null }; error: { name: string } | null };
const refreshSession = vi.fn(async () => {
  if (refreshResult.data.session) storedSession = refreshResult.data.session;
  return refreshResult;
});
let sessionError: { name: string } | null = null;
const createClient = vi.fn((_url: string, _key: string, _options: unknown) => ({
  auth: {
    getSession: vi.fn(async () => ({ data: { session: sessionError ? null : storedSession }, error: sessionError })),
    signInAnonymously,
    signOut,
    refreshSession,
  },
}));
vi.mock('@supabase/supabase-js', () => ({ createClient: (...a: [string, string, unknown]) => createClient(...a) }));

import {
  GUEST_DAY_LIMIT, GUEST_MINUTE_LIMIT, GUEST_BACKGROUND_LIMIT, GUEST_RELAY_PAUSE_KEY, GUEST_RELAY_STORAGE_KEY,
  guestRelayAllowsBackground, guestRelayPausedUntil, isGuestRelayAvailable, isGuestRelayStopped, noteGuestRelayResponse,
  resetGuestRelayForTests, takeGuestRelayToken,
} from '../guestRelay';

let clock = Date.parse('2026-11-02T10:00:00Z');
const sleeps: number[] = [];

describe('relais TMDB de l\'invité', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    space = { kind: 'guest', id: 'espace' };
    storedSession = null;
    sessionError = null;
    refreshResult = { data: { session: null }, error: { name: 'AuthApiError' } };
    signInResult = { data: { session: { access_token: 'jeton-invite' } }, error: null };
    clock = Date.parse('2026-11-02T10:00:00Z');
    sleeps.length = 0;
    resetGuestRelayForTests({ now: () => clock, sleep: async (ms) => { sleeps.push(ms); clock += ms; } });
  });

  it('crée un compte anonyme à la première demande, dans un client à part, puis le réutilise', async () => {
    expect(await takeGuestRelayToken()).toBe('jeton-invite');
    expect(await takeGuestRelayToken()).toBe('jeton-invite');
    expect(signInAnonymously).toHaveBeenCalledTimes(1);
    expect(createClient).toHaveBeenCalledTimes(1);
    const options = createClient.mock.calls[0][2] as { auth: { storageKey: string; storage: Storage }; global?: unknown };
    expect(options.auth.storageKey).toBe(GUEST_RELAY_STORAGE_KEY);
    expect(options.auth.storageKey).not.toBe('sb-projet-auth-token');
    expect(options.auth.storage).toBe(localStorage);
    expect(options.global).toBeUndefined(); // ni garde de session ni horloge du client principal
  });

  it('deux demandes simultanées ne créent qu\'un seul invité', async () => {
    const [a, b] = await Promise.all([takeGuestRelayToken(), takeGuestRelayToken()]);
    expect([a, b]).toEqual(['jeton-invite', 'jeton-invite']);
    expect(signInAnonymously).toHaveBeenCalledTimes(1);
  });

  it('hors de l\'espace invité : rien, aucun compte anonyme', async () => {
    space = { kind: 'account', id: 'compte' };
    expect(isGuestRelayAvailable()).toBe(false);
    expect(await takeGuestRelayToken()).toBeNull();
    expect(signInAnonymously).not.toHaveBeenCalled();
    expect(guestRelayAllowsBackground()).toBe(true);
  });

  it('connexion anonyme refusée : null, et pas de nouvel essai avant 10 minutes', async () => {
    signInResult = { data: { session: null }, error: { name: 'AuthApiError' } };
    expect(await takeGuestRelayToken()).toBeNull();
    expect(await takeGuestRelayToken()).toBeNull();
    expect(signInAnonymously).toHaveBeenCalledTimes(1);
    expect(isGuestRelayAvailable()).toBe(true); // l'accueil garde ses rangées TMDB
    clock += 10 * 60 * 1000;
    signInResult = { data: { session: { access_token: 'jeton-invite' } }, error: null };
    expect(await takeGuestRelayToken()).toBe('jeton-invite');
  });

  it(`au plus ${GUEST_MINUTE_LIMIT} demandes par minute : la suivante attend la minute d'après`, async () => {
    for (let i = 0; i < GUEST_MINUTE_LIMIT; i++) await takeGuestRelayToken();
    expect(sleeps).toEqual([]);
    await takeGuestRelayToken();
    expect(sleeps).toEqual([60_000]);
  });

  it(`au plus ${GUEST_DAY_LIMIT} par jour (temps universel), puis plus rien jusqu'à minuit`, async () => {
    localStorage.setItem('nyx_guest_relay_day', JSON.stringify({ day: '2026-11-02', n: GUEST_DAY_LIMIT - 1 }));
    expect(await takeGuestRelayToken()).toBe('jeton-invite');
    expect(await takeGuestRelayToken()).toBeNull();
    expect(isGuestRelayAvailable()).toBe(false);
    expect(guestRelayPausedUntil()).toBe(Date.parse('2026-11-03T00:00:00Z'));
    clock = Date.parse('2026-11-03T00:00:01Z');
    expect(isGuestRelayAvailable()).toBe(true);
  });

  it('les remplissages en arrière-plan s\'arrêtent avant la limite du jour', () => {
    localStorage.setItem('nyx_guest_relay_day', JSON.stringify({ day: '2026-11-02', n: GUEST_BACKGROUND_LIMIT }));
    expect(guestRelayAllowsBackground()).toBe(false);
    expect(isGuestRelayAvailable()).toBe(true);
  });

  it('refus « budget » du relais : pause jusqu\'à l\'heure donnée, retenue après un redémarrage', async () => {
    await noteGuestRelayResponse(429, { reason: 'budget', retry_at: '2026-11-03T00:00:00Z' });
    expect(JSON.parse(localStorage.getItem(GUEST_RELAY_PAUSE_KEY)!).until).toBe(Date.parse('2026-11-03T00:00:00Z'));
    resetGuestRelayForTests({ now: () => clock });
    expect(isGuestRelayAvailable()).toBe(false);
    expect(await takeGuestRelayToken()).toBeNull();
    expect(signInAnonymously).not.toHaveBeenCalled();
  });

  it('refus du jour sans heure lisible : pause jusqu\'à minuit, montrée dans Réglages', async () => {
    await noteGuestRelayResponse(429, { reason: 'off' });
    expect(guestRelayPausedUntil()).toBe(Date.parse('2026-11-03T00:00:00Z'));
  });

  it('« minute », ou 429 sans corps (passerelle) : Retry-After sinon une minute, sans ligne dans Réglages', async () => {
    await noteGuestRelayResponse(429, { reason: 'minute', retry_at: null });
    expect(isGuestRelayStopped()).toBe(true);
    expect(guestRelayPausedUntil()).toBeNull();
    clock += 60_000;
    expect(isGuestRelayStopped()).toBe(false);
    await noteGuestRelayResponse(429, null, 'jeton-invite', '120');
    expect(JSON.parse(localStorage.getItem(GUEST_RELAY_PAUSE_KEY)!)).toEqual({ until: clock + 120_000, long: false });
    clock += 120_000;
    await noteGuestRelayResponse(429, null);
    expect(JSON.parse(localStorage.getItem(GUEST_RELAY_PAUSE_KEY)!).until).toBe(clock + 60_000);
  });

  it('la minute suit l\'horloge (minute calendaire, comme le relais)', async () => {
    clock = Date.parse('2026-11-02T10:00:50Z');
    for (let i = 0; i < GUEST_MINUTE_LIMIT; i++) await takeGuestRelayToken();
    await takeGuestRelayToken();
    expect(sleeps).toEqual([10_000]);
  });

  it('une demande qui attendait sa minute ne part pas si le relais a refusé entre-temps', async () => {
    for (let i = 0; i < GUEST_MINUTE_LIMIT; i++) await takeGuestRelayToken();
    resetGuestRelayForTests({
      now: () => clock,
      sleep: async (ms) => { sleeps.push(ms); await noteGuestRelayResponse(429, { reason: 'day', retry_at: '2026-11-03T00:00:00Z' }); clock += ms; },
    });
    for (let i = 0; i < GUEST_MINUTE_LIMIT; i++) await takeGuestRelayToken();
    expect(await takeGuestRelayToken()).toBeNull();
    expect(sleeps).toEqual([60_000]);
  });

  it('session illisible (renouvellement impossible) : aucun nouvel invité', async () => {
    sessionError = { name: 'AuthRetryableFetchError' };
    expect(await takeGuestRelayToken()).toBeNull();
    expect(signInAnonymously).not.toHaveBeenCalled();
  });

  it('401 hors ligne (renouvellement injoignable) : l\'invité est gardé, une minute de pause', async () => {
    await takeGuestRelayToken();
    refreshResult = { data: { session: null }, error: { name: 'AuthRetryableFetchError' } };
    await noteGuestRelayResponse(401, null, 'jeton-invite');
    expect(signOut).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem(GUEST_RELAY_PAUSE_KEY)!).until).toBe(clock + 60_000);
  });

  it('stockage plein : la pause la plus récente vient de la mémoire', async () => {
    await noteGuestRelayResponse(429, { reason: 'minute' });
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('plein'); });
    try {
      await noteGuestRelayResponse(429, { reason: 'day', retry_at: '2026-11-03T00:00:00Z' });
      expect(guestRelayPausedUntil()).toBe(Date.parse('2026-11-03T00:00:00Z'));
    } finally {
      setItem.mockRestore();
    }
  });

  it('sans stockage, la pause tient pour la session', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('plein'); });
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('refusé'); });
    try {
      await noteGuestRelayResponse(429, { reason: 'day', retry_at: '2026-11-03T00:00:00Z' });
      expect(isGuestRelayAvailable()).toBe(false);
    } finally {
      setItem.mockRestore();
      getItem.mockRestore();
    }
  });

  it('relais indisponible (503) : pause d\'une minute', async () => {
    await noteGuestRelayResponse(503, { reason: 'unavailable' });
    expect(JSON.parse(localStorage.getItem(GUEST_RELAY_PAUSE_KEY)!)).toEqual({ until: clock + 60_000, long: false });
    expect(isGuestRelayStopped()).toBe(true);
    expect(guestRelayPausedUntil()).toBeNull(); // pas de ligne « limite du jour » dans Réglages
    expect(isGuestRelayAvailable()).toBe(true); // ni d'accueil vidé pour une minute
    expect(await takeGuestRelayToken()).toBeNull();
  });

  it('invité effacé par la purge (401) : session oubliée, nouvel invité seulement après 10 minutes', async () => {
    await takeGuestRelayToken();
    await noteGuestRelayResponse(401, null, 'jeton-invite');
    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(signOut).toHaveBeenCalledWith({ scope: 'local' });
    signInResult = { data: { session: { access_token: 'nouvel-invite' } }, error: null };
    expect(await takeGuestRelayToken()).toBeNull();
    clock += 10 * 60 * 1000;
    expect(await takeGuestRelayToken()).toBe('nouvel-invite');
    expect(signInAnonymously).toHaveBeenCalledTimes(2);
  });

  it('401 en série (relais qui refuse tout) : au plus un invité créé par 10 minutes, même après un redémarrage', async () => {
    for (let i = 0; i < 5; i++) {
      await takeGuestRelayToken();
      await noteGuestRelayResponse(401, null);
      localStorage.removeItem(GUEST_RELAY_PAUSE_KEY); // même sans la pause, l'écart entre créations tient
      resetGuestRelayForTests({ now: () => clock });
      clock += 60_000;
    }
    expect(signInAnonymously).toHaveBeenCalledTimes(1);
  });

  it('401 sur un jeton expiré : renouvelé, la session est gardée, courte pause', async () => {
    await takeGuestRelayToken();
    refreshResult = { data: { session: { access_token: 'jeton-renouvele' } }, error: null };
    await noteGuestRelayResponse(401, null, 'jeton-invite');
    expect(signOut).not.toHaveBeenCalled();
    clock += 60_000;
    expect(await takeGuestRelayToken()).toBe('jeton-renouvele');
    expect(signInAnonymously).toHaveBeenCalledTimes(1);
  });

  it('401 d\'une ancienne demande après un nouvel invité : la nouvelle session n\'est pas effacée', async () => {
    await takeGuestRelayToken();
    await noteGuestRelayResponse(401, null, 'jeton-plus-ancien');
    expect(refreshSession).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
  });
});
