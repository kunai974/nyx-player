// @vitest-environment node
// Page du téléphone de la connexion TV par QR code (web/tv) : envoi par la messagerie de Supabase,
// protocole minimal, et en-têtes du site qui l'autorisent.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sendToTv } from '../../web/tv/tvlink-transport.js';

const web = fileURLToPath(new URL('../../web/', import.meta.url));

class FakeSocket {
  static last = null;
  constructor(url) {
    this.url = url;
    this.sent = [];
    FakeSocket.last = this;
    queueMicrotask(() => this.onopen?.());
  }
  send(text) { this.sent.push(JSON.parse(text)); }
  close() { this.closed = true; }
  receive(msg) { this.onmessage?.({ data: JSON.stringify(msg) }); }
}

const base = { supabaseUrl: 'https://ref.supabase.co', apiKey: 'cle-publique', channel: 'c'.repeat(22), envelope: { v: 1, epk: 'e', iv: 'i', ct: 'x' } };

describe('page TV : envoi au téléphone', () => {
  it('rejoint le canal de la TV, envoie le paquet après l\'accord, rend la réponse de la TV', async () => {
    const done = sendToTv({ ...base, WebSocketImpl: FakeSocket });
    await Promise.resolve();
    const ws = FakeSocket.last;
    expect(ws.url).toBe('wss://ref.supabase.co/realtime/v1/websocket?apikey=cle-publique&vsn=1.0.0');
    const join = ws.sent[0];
    expect(join).toMatchObject({ topic: 'realtime:tvlink:' + base.channel, event: 'phx_join' });
    expect(join.payload.config.private).toBe(false);
    // Rien n'est envoyé avant que le canal soit rejoint
    expect(ws.sent.filter((m) => m.event === 'broadcast')).toEqual([]);
    ws.receive({ topic: join.topic, event: 'phx_reply', ref: join.ref, payload: { status: 'ok' } });
    const seal = ws.sent.find((m) => m.event === 'broadcast');
    const { rid, ...envelope } = seal.payload.payload;
    expect(seal.payload).toMatchObject({ type: 'broadcast', event: 'seal' });
    expect(envelope).toEqual(base.envelope);
    expect(rid).toMatch(/^[0-9a-f]{24}$/);
    // Un message d'un autre canal, ou d'un autre envoi sur ce canal, n'est pas pris pour la réponse
    ws.receive({ topic: 'realtime:autre', event: 'broadcast', payload: { event: 'ack', payload: { ok: true, rid } } });
    ws.receive({ topic: join.topic, event: 'broadcast', payload: { event: 'ack', payload: { ok: false, reason: 'busy', rid: 'autre-envoi' } } });
    ws.receive({ topic: join.topic, event: 'broadcast', payload: { event: 'ack', payload: { ok: true } } });
    ws.receive({ topic: join.topic, event: 'broadcast', payload: { event: 'ack', payload: { ok: false, reason: 'account', rid } } });
    await expect(done).resolves.toEqual({ ok: false, reason: 'account' });
    expect(ws.closed).toBe(true);
  });

  it('« la TV se connecte » : prévient la page et laisse 2 minutes pour la vérification et la connexion', async () => {
    vi.useFakeTimers();
    const onWorking = vi.fn();
    const done = sendToTv({ ...base, WebSocketImpl: FakeSocket, onWorking, timeoutMs: 1000, workingTimeoutMs: 5000 });
    await vi.advanceTimersByTimeAsync(0);
    const ws = FakeSocket.last;
    const topic = ws.sent[0].topic;
    ws.receive({ topic, event: 'phx_reply', ref: ws.sent[0].ref, payload: { status: 'ok' } });
    const rid = ws.sent.find((m) => m.event === 'broadcast').payload.payload.rid;
    ws.receive({ topic, event: 'broadcast', payload: { event: 'status', payload: { step: 'working', rid } } });
    expect(onWorking).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4000);
    ws.receive({ topic, event: 'broadcast', payload: { event: 'ack', payload: { ok: true, rid } } });
    await expect(done).resolves.toEqual({ ok: true, reason: undefined });
    vi.useRealTimers();
  });

  it('sans réponse de la TV : échec « timeout »', async () => {
    vi.useFakeTimers();
    const done = sendToTv({ ...base, WebSocketImpl: FakeSocket, timeoutMs: 1000 });
    const check = expect(done).rejects.toThrow('timeout');
    await vi.advanceTimersByTimeAsync(1000);
    await check;
    vi.useRealTimers();
  });

  it('canal refusé : échec « join »', async () => {
    const done = sendToTv({ ...base, WebSocketImpl: FakeSocket });
    await Promise.resolve();
    const ws = FakeSocket.last;
    ws.receive({ topic: ws.sent[0].topic, event: 'phx_reply', ref: ws.sent[0].ref, payload: { status: 'error' } });
    await expect(done).rejects.toThrow('join');
  });
});

describe('page TV : en-têtes du site', () => {
  const vercel = JSON.parse(readFileSync(web + 'vercel.json', 'utf8'));
  const tvRule = vercel.headers.find((h) => h.source === '/tv/(.*)');
  const bareRule = vercel.headers.find((h) => h.source === '/tv');
  const header = (key) => tvRule.headers.find((h) => h.key === key)?.value;

  it('la règle de /tv/ vient après la règle générale (elle la remplace) et autorise la messagerie Supabase', () => {
    const index = vercel.headers.indexOf(tvRule);
    expect(index).toBeGreaterThan(vercel.headers.findIndex((h) => h.source === '/(.*)'));
    // Seul le projet Supabase de Nyx est joignable (pas celui d'un tiers), en https et en wss
    const project = readFileSync(web + 'auth/supabase-config.js', 'utf8').match(/https:\/\/([a-z0-9]+)\.supabase\.co/)[1];
    const connect = header('Content-Security-Policy').match(/connect-src ([^;]+);/)[1].split(' ');
    expect(connect.sort()).toEqual(["'self'", `https://${project}.supabase.co`, `wss://${project}.supabase.co`].sort());
    expect(header('Content-Security-Policy')).toContain("frame-ancestors 'none'");
    expect(header('Referrer-Policy')).toBe('no-referrer');
    expect(header('Cache-Control')).toBe('no-store');
    expect(header('X-Robots-Tag')).toContain('noindex');
    // On y tape des mots de passe : aucun script en ligne permis
    expect(header('Content-Security-Policy')).toMatch(/script-src 'self';/);
    // « /tv » sans barre finale : mêmes en-têtes
    expect(bareRule.headers).toEqual(tvRule.headers);
    expect(vercel.headers.indexOf(bareRule)).toBeGreaterThan(vercel.headers.findIndex((h) => h.source === '/(.*)'));
  });

  it('l\'app (Tauri) peut ouvrir la messagerie instantanée de Supabase (wss)', () => {
    const conf = JSON.parse(readFileSync(fileURLToPath(new URL('../../src-tauri/tauri.conf.json', import.meta.url)), 'utf8'));
    const csp = JSON.stringify(conf);
    expect(csp).toMatch(/connect-src[^;]*wss:\/\/\*\.supabase\.co/);
  });

  it('la page lit le lien sur place et le retire de l\'adresse, sans script extérieur', () => {
    const html = readFileSync(web + 'tv/index.html', 'utf8');
    const js = readFileSync(web + 'tv/tvlink-page.js', 'utf8');
    expect(html).not.toMatch(/<script[^>]+src="https?:/);
    // Aucun script en ligne (interdit par la CSP de la page)
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(html).toContain('<meta name="referrer" content="no-referrer">');
    expect(js).toContain("history.replaceState(null, '', location.pathname + location.search)");
    // Aucune trace des saisies : ni console, ni stockage du navigateur
    expect(js).not.toMatch(/console\.|localStorage|sessionStorage|indexedDB/);
  });

  it('adresse e-mail incomplète (« jean@gmail ») : dite sur le téléphone, avec le même contrôle que la TV', () => {
    const js = readFileSync(web + 'tv/tvlink-page.js', 'utf8');
    const tv = readFileSync(web + '../src/services/tvLink/tvLinkPayload.ts', 'utf8');
    const pattern = '/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/';
    expect(tv).toContain(pattern);
    expect(js).toContain(`email.length > 254 || !${pattern}.test(email)) return showError('errEmail')`);
    expect(js.match(/\berrEmail: '/g)?.length).toBe(2);
  });

  it('chaque refus de la TV a son message sur le téléphone, en français et en anglais', async () => {
    const js = readFileSync(web + 'tv/tvlink-page.js', 'utf8');
    for (const reason of ['account', 'provider', 'provider-format', 'provider-unreachable', 'provider-inactive', 'unreadable', 'busy', 'closed']) {
      const key = js.match(new RegExp(`'?${reason}'?: '(err\\w+)'`))?.[1];
      expect(key, reason).toBeTruthy();
      expect(js.match(new RegExp(`\\b${key}: '`, 'g'))?.length, key).toBe(2);
    }
  });
});

describe('page TV : ce que le site en dit', () => {
  const session = readFileSync(web + '../src/services/tvLink/tvLinkSession.ts', 'utf8');
  const page = (name) => readFileSync(web + name, 'utf8').replace(/\s+/g, ' ');
  const minutes = (name) => Number(session.match(new RegExp(`${name} = (\\d+) \\* 60 \\* 1000`))[1]);

  it('les durées annoncées sur l\'accueil et dans la confidentialité sont celles de l\'app', () => {
    const tv = minutes('TV_LINK_TTL_MS');
    const embedded = minutes('TV_LINK_EMBEDDED_TTL_MS');
    expect(page('accueil.html')).toContain(`expire au bout de ${tv}&nbsp;minutes`);
    expect(page('index.html')).toContain(`expires after ${tv}&nbsp;minutes`);
    expect(page('confidentialite.html')).toContain(`plus ${tv} minutes (${embedded} sur l'écran du fournisseur)`);
    expect(page('privacy.html')).toContain(`${tv} minutes at most (${embedded} on the provider screen)`);
  });
});
