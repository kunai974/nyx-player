// @vitest-environment node
/**
 * Connexion de la TV par QR code : le paquet fermé par la page du téléphone (web/tv) s'ouvre sur la
 * TV qui a montré le QR code, et seulement sur elle, pour ce canal, sans modification en route.
 */
import { describe, it, expect } from 'vitest';
import { fromBase64Url, generateTvKeys, isTvLinkEnvelope, newChannelId, openEnvelope, toBase64Url } from '../tvLinkCrypto';
// @ts-expect-error -- module JavaScript du site, sans types
import { parseTvLinkFragment, sealForTv } from '../../../../web/tv/tvlink-crypto.js';
import { tvLinkUrl } from '../tvLinkUrl';

type Envelope = { v: number; epk: string; iv: string; ct: string };
const sealRaw = sealForTv as (key: string, channel: string, mode: string, text: string) => Promise<Envelope>;
const seal = (key: string, channel: string, text: string): Promise<Envelope> => sealRaw(key, channel, 'account', text);

describe('connexion TV par QR code : chiffrement', () => {
  it('le paquet du téléphone s\'ouvre sur la TV', async () => {
    const tv = await generateTvKeys();
    const channel = newChannelId();
    const secret = JSON.stringify({ account: { email: 'a@b.c', password: 'p@ss é' } });
    const envelope = await seal(tv.publicKey, channel, secret);
    expect(isTvLinkEnvelope(envelope)).toBe(true);
    expect(envelope.ct).not.toContain('p@ss');
    await expect(openEnvelope(tv.privateKey, channel, 'a', envelope)).resolves.toBe(secret);
  });

  it('une autre TV, un autre canal ou un paquet modifié ne s\'ouvrent pas', async () => {
    const tv = await generateTvKeys();
    const other = await generateTvKeys();
    const channel = newChannelId();
    const envelope = await seal(tv.publicKey, channel, '{"x":1}');
    await expect(openEnvelope(other.privateKey, channel, 'a', envelope)).rejects.toThrow();
    await expect(openEnvelope(tv.privateKey, newChannelId(), 'a', envelope)).rejects.toThrow();
    const bytes = fromBase64Url(envelope.ct);
    bytes[0] ^= 1;
    await expect(openEnvelope(tv.privateKey, channel, 'a', { ...envelope, ct: toBase64Url(bytes) })).rejects.toThrow();
  });

  it('un paquet fermé pour l\'écran du compte ne s\'ouvre pas sur l\'écran du fournisseur', async () => {
    const tv = await generateTvKeys();
    const channel = newChannelId();
    const envelope = await seal(tv.publicKey, channel, '{"x":1}');
    await expect(openEnvelope(tv.privateKey, channel, 'p', envelope)).rejects.toThrow();
    const forProvider = await sealRaw(tv.publicKey, channel, 'provider', '{"x":1}');
    await expect(openEnvelope(tv.privateKey, channel, 'p', forProvider)).resolves.toBe('{"x":1}');
  });

  it('chaque envoi tire une clé et un IV neufs', async () => {
    const tv = await generateTvKeys();
    const channel = newChannelId();
    const a = await seal(tv.publicKey, channel, 'x');
    const b = await seal(tv.publicKey, channel, 'x');
    expect(a.epk).not.toBe(b.epk);
    expect(a.iv).not.toBe(b.iv);
  });

  it('le lien du QR code est relu tel quel par la page du téléphone', async () => {
    const tv = await generateTvKeys();
    const channel = newChannelId();
    expect(channel).toMatch(/^[A-Za-z0-9_-]{22}$/);
    for (const mode of ['account', 'provider'] as const) {
      const url = new URL(tvLinkUrl(channel, tv.publicKey, mode));
      expect(url.origin + url.pathname).toBe('https://nyxplayer.app/tv/');
      // Rien de secret avant « # » : le site ne reçoit jamais la clé ni le canal
      expect(url.search).toBe('');
      expect(parseTvLinkFragment(url.hash)).toEqual({ channel, key: tv.publicKey, mode });
    }
  });

  it('un lien incomplet ou abîmé est refusé par la page du téléphone', () => {
    const parse = parseTvLinkFragment as (h: string) => unknown;
    expect(parse('')).toBeNull();
    expect(parse('#v=2&c=' + 'a'.repeat(22) + '&k=' + 'b'.repeat(87) + '&m=a')).toBeNull();
    expect(parse('#v=1&c=short&k=' + 'b'.repeat(87) + '&m=a')).toBeNull();
    expect(parse('#v=1&c=' + 'a'.repeat(22) + '&k=' + 'b'.repeat(86) + '&m=a')).toBeNull();
    expect(parse('#v=1&c=' + 'a'.repeat(22) + '&k=' + 'b'.repeat(87) + '&m=x')).toBeNull();
  });

  it('enveloppe : forme et tailles contrôlées avant tout calcul', () => {
    expect(isTvLinkEnvelope(null)).toBe(false);
    expect(isTvLinkEnvelope({ v: 2, epk: 'a', iv: 'b', ct: 'c' })).toBe(false);
    expect(isTvLinkEnvelope({ v: 1, epk: 'a', iv: 'b', ct: 'c'.repeat(64_001) })).toBe(false);
    expect(isTvLinkEnvelope({ v: 1, epk: 'a', iv: 'b', ct: 'c' })).toBe(true);
  });
});
