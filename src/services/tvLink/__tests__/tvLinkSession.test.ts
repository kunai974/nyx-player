// @vitest-environment node
/**
 * Connexion de la TV par QR code : la TV écoute son canal, ouvre le paquet, répond au téléphone, et
 * ferme le canal après une réussite (un code sert une fois).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

type Handler = (message: { payload?: unknown }) => void;
const fake = vi.hoisted(() => ({
  handler: null as Handler | null,
  status: null as ((s: string) => void) | null,
  sent: [] as unknown[],
  topic: '',
  // Canal ouvert par le test en cours, et canaux fermés : un test précédent ferme le sien avec un
  // vrai délai, qui peut tomber pendant le test suivant sur une machine chargée
  channel: null as object | null,
  removed: [] as object[],
}));

vi.mock('../../supabaseClient', () => ({
  supabase: {
    channel: (topic: string) => {
      fake.topic = topic;
      const ch: Record<string, unknown> = {
        on: (_t: string, _f: unknown, h: Handler) => { fake.handler = h; return ch; },
        subscribe: (cb: (s: string) => void) => { fake.status = cb; return ch; },
        send: (m: unknown) => { fake.sent.push(m); return Promise.resolve('ok'); },
      };
      fake.channel = ch;
      return ch;
    },
    removeChannel: (ch: object) => { fake.removed.push(ch); return Promise.resolve('ok'); },
  },
}));

import { startTvLinkSession } from '../tvLinkSession';
// @ts-expect-error -- module JavaScript du site, sans types
import { parseTvLinkFragment, sealForTv } from '../../../../web/tv/tvlink-crypto.js';

const flush = async (): Promise<void> => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)); };
const acks = (): unknown[] => fake.sent.map((m) => (m as { payload: unknown }).payload);

async function sealFor(url: string, payload: unknown): Promise<unknown> {
  const link = parseTvLinkFragment(new URL(url).hash) as { channel: string; key: string; mode: string };
  return sealForTv(link.key, link.channel, link.mode, JSON.stringify(payload));
}
const events = (): unknown[] => fake.sent.map((m) => { const x = m as { event: string; payload: unknown }; return [x.event, x.payload]; });

describe('connexion TV par QR code : canal de la TV', () => {
  beforeEach(() => {
    fake.handler = null; fake.status = null; fake.sent = []; fake.topic = ''; fake.channel = null; fake.removed = [];
  });
  afterEach(() => vi.useRealTimers());

  it('canal au nom tiré au hasard, prêt seulement une fois abonné', async () => {
    const onReady = vi.fn();
    const s = await startTvLinkSession({ mode: 'account', onPayload: vi.fn(), onReady });
    const link = parseTvLinkFragment(new URL(s.url).hash) as { channel: string };
    expect(fake.topic).toBe(`tvlink:${link.channel}`);
    expect(onReady).not.toHaveBeenCalled();
    fake.status?.('SUBSCRIBED');
    expect(onReady).toHaveBeenCalledTimes(1);
    s.close();
  });

  it('paquet valide : traité, réponse « ok », canal fermé ; un second paquet est ignoré', async () => {
    const onPayload = vi.fn(async () => ({ ok: true as const }));
    const s = await startTvLinkSession({ mode: 'account', onPayload });
    const envelope = await sealFor(s.url, { account: { email: 'a@b.c', password: 'pw' } });
    fake.handler?.({ payload: envelope });
    await flush();
    expect(onPayload).toHaveBeenCalledWith({ account: { email: 'a@b.c', password: 'pw' } });
    // Le téléphone est prévenu que la TV attend l'accord à la télécommande, puis reçoit la réponse
    expect(events()).toEqual([['status', { step: 'working' }], ['ack', { ok: true }]]);
    fake.handler?.({ payload: envelope });
    await flush();
    expect(onPayload).toHaveBeenCalledTimes(1);
    expect(events().slice(-1)[0]).toEqual(['ack', { ok: false, reason: 'closed' }]);
  });

  it('compte refusé : réponse d\'échec, le canal reste ouvert pour un nouvel essai', async () => {
    const onPayload = vi.fn()
      .mockResolvedValueOnce({ ok: false, reason: 'account' })
      .mockResolvedValueOnce({ ok: true });
    const s = await startTvLinkSession({ mode: 'account', onPayload });
    fake.handler?.({ payload: await sealFor(s.url, { account: { email: 'a@b.c', password: 'faux' } }) });
    await flush();
    fake.handler?.({ payload: await sealFor(s.url, { account: { email: 'a@b.c', password: 'bon' } }) });
    await flush();
    expect(acks()).toEqual([{ step: 'working' }, { ok: false, reason: 'account' }, { step: 'working' }, { ok: true }]);
  });

  it('paquet illisible ou mal formé : réponse d\'échec, rien n\'est traité', async () => {
    const onPayload = vi.fn();
    const s = await startTvLinkSession({ mode: 'provider', onPayload });
    fake.handler?.({ payload: { v: 1, epk: 'AAAA', iv: 'AAAA', ct: 'AAAA' } });
    await flush();
    fake.handler?.({ payload: 'n\'importe quoi' });
    await flush();
    // Paquet bien fermé, mais sans fournisseur pour l'écran du fournisseur
    fake.handler?.({ payload: await sealFor(s.url, { account: { email: 'a@b.c', password: 'pw' } }) });
    await flush();
    expect(onPayload).not.toHaveBeenCalled();
    expect(acks()).toEqual([{ ok: false, reason: 'unreadable' }, { ok: false, reason: 'invalid' }, { ok: false, reason: 'invalid' }]);
    s.close();
  });

  it('fermé : plus rien n\'est ouvert, le canal part peu après', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const onPayload = vi.fn();
    const s = await startTvLinkSession({ mode: 'provider', onPayload });
    const envelope = await sealFor(s.url, { provider: { type: 'm3u', link: 'http://l.example/x.m3u' } });
    s.close();
    fake.handler?.({ payload: envelope });
    expect(onPayload).not.toHaveBeenCalled();
    expect(fake.removed).not.toContain(fake.channel);
    vi.advanceTimersByTime(2000);
    expect(fake.removed.filter((ch) => ch === fake.channel)).toHaveLength(1);
  });

  it('le numéro d\'envoi du téléphone est recopié dans le « status » et la réponse', async () => {
    const s = await startTvLinkSession({ mode: 'account', onPayload: vi.fn(async () => ({ ok: true as const })) });
    const envelope = await sealFor(s.url, { account: { email: 'a@b.c', password: 'pw' } }) as Record<string, unknown>;
    fake.handler?.({ payload: { ...envelope, rid: 'abcdef0123456789' } });
    await flush();
    expect(events()).toEqual([['status', { step: 'working', rid: 'abcdef0123456789' }], ['ack', { ok: true, rid: 'abcdef0123456789' }]]);
  });

  it('5 échecs : le code est fermé (pas d\'essais de mots de passe en boucle)', async () => {
    const onExhausted = vi.fn();
    const onPayload = vi.fn(async () => ({ ok: false as const, reason: 'account' as const }));
    const s = await startTvLinkSession({ mode: 'account', onPayload, onExhausted });
    for (let i = 0; i < 6; i++) {
      fake.handler?.({ payload: await sealFor(s.url, { account: { email: 'a@b.c', password: `essai${i}` } }) });
      await flush();
    }
    expect(onPayload).toHaveBeenCalledTimes(5);
    expect(onExhausted).toHaveBeenCalledTimes(1);
    expect(events().slice(-1)[0]).toEqual(['ack', { ok: false, reason: 'closed' }]);
  });

  it('un second paquet pendant le traitement du premier : « occupé », sans compter un échec', async () => {
    let finish: (a: { ok: true }) => void = () => {};
    const onPayload = vi.fn(() => new Promise<{ ok: true }>((r) => { finish = r; }));
    const s = await startTvLinkSession({ mode: 'account', onPayload });
    fake.handler?.({ payload: await sealFor(s.url, { account: { email: 'a@b.c', password: 'pw' } }) });
    await flush();
    fake.handler?.({ payload: await sealFor(s.url, { account: { email: 'x@y.z', password: 'pw' } }) });
    await flush();
    expect(acks()).toContainEqual({ ok: false, reason: 'busy' });
    finish({ ok: true });
    await flush();
    expect(onPayload).toHaveBeenCalledTimes(1);
    expect(acks().slice(-1)[0]).toEqual({ ok: true });
  });

  it('erreur pendant la connexion (réseau) : refus envoyé au téléphone, rien ne reste en suspens', async () => {
    const onPayload = vi.fn(async () => { throw new Error('réseau'); });
    const s = await startTvLinkSession({ mode: 'account', onPayload });
    fake.handler?.({ payload: await sealFor(s.url, { account: { email: 'a@b.c', password: 'pw' } }) });
    await flush();
    expect(acks().slice(-1)[0]).toEqual({ ok: false, reason: 'account' });
    s.close();
  });

  it('erreur du canal signalée à l\'écran', async () => {
    const onError = vi.fn();
    const s = await startTvLinkSession({ mode: 'provider', onPayload: vi.fn(), onError });
    fake.status?.('CHANNEL_ERROR');
    expect(onError).toHaveBeenCalledTimes(1);
    s.close();
  });
});
