/**
 * Relais TMDB, invités : lecture de la réponse de la base, adresse comptée, jeton d'invité.
 * Fermé par défaut : seule une réponse « allowed: true » explicite laisse passer un invité.
 */
import { describe, it, expect } from 'vitest';
import { clientAddress, guestVerdict, retryAfterSeconds } from '../../../supabase/functions/_shared/guestQuota';
import { isGuestToken, isSignedInAccount } from '../../../supabase/functions/_shared/tokenClaims';

describe('réponse de la base aux limites des invités', () => {
  it('laisse passer seulement sur allowed === true', () => {
    expect(guestVerdict({ data: { allowed: true }, error: null })).toEqual({ allowed: true });
    expect(guestVerdict({ data: { allowed: 'true' }, error: null }).allowed).toBe(false);
    expect(guestVerdict({ data: { allowed: 1 }, error: null }).allowed).toBe(false);
    expect(guestVerdict({ data: { allowed: true }, error: { message: 'x' } }).allowed).toBe(false);
    expect(guestVerdict({ data: null, error: null })).toEqual({ allowed: false, reason: 'unavailable', retryAt: null });
    expect(guestVerdict(null).allowed).toBe(false);
    expect(guestVerdict(undefined).allowed).toBe(false);
  });

  it('garde la raison connue et l\'heure de reprise, sinon « unavailable »', () => {
    expect(guestVerdict({ data: { allowed: false, reason: 'day', retry_at: '2026-11-03T00:00:00Z' } }))
      .toEqual({ allowed: false, reason: 'day', retryAt: '2026-11-03T00:00:00Z' });
    expect(guestVerdict({ data: { allowed: false, reason: 'inventée' } }))
      .toEqual({ allowed: false, reason: 'unavailable', retryAt: null });
  });

  it('Retry-After : secondes jusqu\'à la reprise, au moins 1, 60 si inconnue', () => {
    const now = Date.parse('2026-11-02T10:00:30Z');
    expect(retryAfterSeconds('2026-11-02T10:01:00Z', now)).toBe(30);
    expect(retryAfterSeconds('2026-11-02T09:00:00Z', now)).toBe(1);
    expect(retryAfterSeconds(null, now)).toBe(60);
    expect(retryAfterSeconds('pas une date', now)).toBe(60);
  });
});

describe('adresse comptée pour la limite par adresse', () => {
  const h = (values: Record<string, string>) => new Headers(values);

  it('prend l\'adresse posée par Cloudflare, jamais X-Forwarded-For ni X-Real-IP (écrits par l\'appelant)', () => {
    expect(clientAddress(h({ 'cf-connecting-ip': '192.0.2.10', 'x-forwarded-for': '198.51.100.1' }))).toBe('192.0.2.10');
    expect(clientAddress(h({ 'x-forwarded-for': '198.51.100.1' }))).toBeNull();
    expect(clientAddress(h({ 'x-real-ip': '203.0.113.4' }))).toBeNull();
  });

  it('une adresse IPv4 écrite en IPv6 compte comme l\'adresse IPv4', () => {
    expect(clientAddress(h({ 'cf-connecting-ip': '::ffff:192.0.2.10' }))).toBe('192.0.2.10');
  });

  it('compte une adresse IPv6 par son bloc /64 (un appareil ne change pas de case en changeant d\'adresse)', () => {
    expect(clientAddress(h({ 'cf-connecting-ip': '2001:db8:aa:bb:1:2:3:4' }))).toBe('2001:db8:aa:bb::/64');
    expect(clientAddress(h({ 'cf-connecting-ip': '2001:DB8:AA:BB:ffff::9' }))).toBe('2001:db8:aa:bb::/64');
    expect(clientAddress(h({ 'cf-connecting-ip': '2001:db8::1' }))).toBe('2001:db8:0:0::/64');
  });

  it('refuse une valeur qui n\'est pas une adresse (case commune « inconnue »)', () => {
    expect(clientAddress(h({}))).toBeNull();
    expect(clientAddress(h({ 'cf-connecting-ip': 'pas-une-adresse' }))).toBeNull();
    expect(clientAddress(h({ 'cf-connecting-ip': '1:2:3' }))).toBeNull();
    expect(clientAddress(h({ 'cf-connecting-ip': '1::2::3' }))).toBeNull();
    expect(clientAddress(h({ 'cf-connecting-ip': 'x'.repeat(80) }))).toBeNull();
  });
});

describe('jeton d\'invité', () => {
  it('reconnaît une connexion anonyme du projet, avec un identifiant', () => {
    expect(isGuestToken({ aud: 'authenticated', is_anonymous: true, sub: 'x' })).toBe(true);
    expect(isGuestToken({ aud: 'authenticated', is_anonymous: true })).toBe(false);
    expect(isGuestToken({ aud: 'autre', is_anonymous: true, sub: 'x' })).toBe(false);
    expect(isGuestToken({ aud: 'authenticated', is_anonymous: 'true', sub: 'x' })).toBe(false);
    expect(isGuestToken({ aud: 'authenticated', sub: 'x' })).toBe(false);
  });

  it('la vérification des comptes est inchangée : elle refuse toujours un invité', () => {
    expect(isSignedInAccount({ aud: 'authenticated', is_anonymous: true, sub: 'x' })).toBe(false);
  });
});
