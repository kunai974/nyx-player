// @vitest-environment node
/**
 * Connexion de la TV par QR code : le paquet ouvert est relu champ par champ ; seul ce que l'écran
 * attend est gardé, et le fournisseur en attente sert une fois.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { parseTvLinkPayload } from '../tvLinkPayload';
import { clearPendingTvLinkProvider, setPendingTvLinkProvider, takePendingTvLinkProvider } from '../pendingProvider';

const xtream = { type: 'xtream', host: ' http://h.example:8080 ', username: 'u', password: 'p' };

describe('connexion TV par QR code : contenu du paquet', () => {
  it('écran du compte : compte obligatoire, fournisseur facultatif', () => {
    expect(parseTvLinkPayload(JSON.stringify({ account: { email: ' a@b.c ', password: 'pw' } }), 'account'))
      .toEqual({ account: { email: 'a@b.c', password: 'pw' } });
    expect(parseTvLinkPayload(JSON.stringify({ account: { email: 'a@b.c', password: 'pw' }, provider: xtream }), 'account'))
      .toEqual({ account: { email: 'a@b.c', password: 'pw' }, provider: { type: 'xtream', host: 'http://h.example:8080', username: 'u', password: 'p' } });
    expect(parseTvLinkPayload(JSON.stringify({ provider: xtream }), 'account')).toBeNull();
    expect(parseTvLinkPayload(JSON.stringify({ account: { email: 'a@b.c', password: '' } }), 'account')).toBeNull();
  });

  it('écran du fournisseur : le fournisseur seul, un compte en trop est ignoré', () => {
    expect(parseTvLinkPayload(JSON.stringify({ account: { email: 'a@b.c', password: 'pw' }, provider: { type: 'm3u', link: 'http://l.example/x.m3u' } }), 'provider'))
      .toEqual({ provider: { type: 'm3u', link: 'http://l.example/x.m3u' } });
    expect(parseTvLinkPayload(JSON.stringify({}), 'provider')).toBeNull();
  });

  it('refuse un texte qui n\'est pas le paquet attendu', () => {
    expect(parseTvLinkPayload('pas du json', 'account')).toBeNull();
    expect(parseTvLinkPayload('null', 'provider')).toBeNull();
    expect(parseTvLinkPayload(JSON.stringify({ provider: { type: 'ftp', host: 'x' } }), 'provider')).toBeNull();
    expect(parseTvLinkPayload(JSON.stringify({ provider: { type: 'xtream', host: 'h', username: 1 } }), 'provider')).toBeNull();
    expect(parseTvLinkPayload(JSON.stringify({ provider: { type: 'm3u', link: 'x'.repeat(5000) } }), 'provider')).toBeNull();
    expect(parseTvLinkPayload(JSON.stringify({ account: { email: 'e'.repeat(400), password: 'p' } }), 'account')).toBeNull();
    // L'adresse s'affiche sur la TV : une phrase à la place d'une adresse e-mail est refusée
    for (const email of ['Abonnement expiré, appelez le 01 23 45 67 89', 'pas-une-adresse', 'a@b', `${'e'.repeat(250)}@b.example`]) {
      expect(parseTvLinkPayload(JSON.stringify({ account: { email, password: 'p' } }), 'account'), email).toBeNull();
    }
  });
});

describe('connexion TV par QR code : fournisseur en attente', () => {
  beforeEach(() => clearPendingTvLinkProvider());

  it('sert une seule fois', () => {
    setPendingTvLinkProvider({ type: 'm3u', link: 'http://l.example/x.m3u' }, 1000);
    expect(takePendingTvLinkProvider(2000)).toEqual({ type: 'm3u', link: 'http://l.example/x.m3u' });
    expect(takePendingTvLinkProvider(2000)).toBeNull();
  });

  it('est oublié au bout de 15 minutes, ou à la déconnexion', () => {
    setPendingTvLinkProvider({ type: 'm3u', link: 'http://l.example/x.m3u' }, 0);
    expect(takePendingTvLinkProvider(15 * 60 * 1000 + 1)).toBeNull();
    setPendingTvLinkProvider({ type: 'm3u', link: 'http://l.example/x.m3u' }, 0);
    clearPendingTvLinkProvider();
    expect(takePendingTvLinkProvider(1)).toBeNull();
  });
});
