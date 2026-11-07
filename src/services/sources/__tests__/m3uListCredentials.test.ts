/**
 * Lien collé dans l'onglet « Lien M3U » (connexion et Paramètres) : un lien Xtream reste un
 * abonnement Xtream, toute autre liste devient une liste M3U rangée dans la source de la session.
 * Adresses factices uniquement.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const platform = vi.hoisted(() => ({ android: false }));
vi.mock('../../../utils/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../utils/platform')>()),
  isAndroid: () => platform.android,
}));

import { credentialsFromM3uLink, isM3uListCredentials, m3uListCredentials } from '../m3uListCredentials';
import { m3uFingerprintInput } from '../sourceFingerprint';

beforeEach(() => { platform.android = false; });

describe('credentialsFromM3uLink', () => {
  it('lien Xtream complet : abonnement Xtream, comme avant', () => {
    expect(credentialsFromM3uLink('https://lien.invalid:8443/get.php?username=ana&password=p%40ss&type=m3u_plus'))
      .toEqual({ creds: { host: 'https://lien.invalid:8443', username: 'ana', password: 'p@ss' } });
  });

  it('liste M3U sans identifiants : vraie liste M3U, l\'adresse complète gardée pour la lecture', () => {
    const url = 'http://liste.invalid:9191/output/m3u?token=abc';
    const result = credentialsFromM3uLink(`  ${url}  `);
    expect(result).toEqual({ creds: { host: 'm3u:liste.invalid:9191', username: '', password: '', m3u: { url } } });
    if ('creds' in result) expect(isM3uListCredentials(result.creds)).toBe(true);
  });

  it('l\'hôte rangé est le texte de l\'empreinte d\'une source M3U (même fournisseur reconnu)', () => {
    const url = 'https://Liste.Invalid/playlist.m3u8';
    const result = credentialsFromM3uLink(url);
    expect('creds' in result && result.creds.host).toBe(m3uFingerprintInput(url));
  });

  it('un seul des deux identifiants : lien Xtream mal copié, pas une liste', () => {
    expect(credentialsFromM3uLink('http://lien.invalid/get.php?username=ana')).toEqual({ error: 'missing_info' });
    expect(credentialsFromM3uLink('http://lien.invalid/get.php?password=x')).toEqual({ error: 'missing_info' });
  });

  it('adresse du serveur seule, ou page Xtream sans identifiants : lien Xtream incomplet, pas une liste', () => {
    expect(credentialsFromM3uLink('http://lien.invalid:8080')).toEqual({ error: 'missing_info' });
    expect(credentialsFromM3uLink('http://lien.invalid:8080/')).toEqual({ error: 'missing_info' });
    expect(credentialsFromM3uLink('http://lien.invalid/get.php?type=m3u_plus')).toEqual({ error: 'missing_info' });
    expect(credentialsFromM3uLink('http://lien.invalid/player_api.php')).toEqual({ error: 'missing_info' });
    // Liste servie à la racine avec un jeton : bien une liste
    expect('creds' in credentialsFromM3uLink('https://liste.invalid/?token=abc')).toBe(true);
  });

  it('texte qui n\'est pas une adresse http(s) : invalide', () => {
    expect(credentialsFromM3uLink('pas un lien')).toEqual({ error: 'invalid' });
    expect(credentialsFromM3uLink('ftp://liste.invalid/a.m3u')).toEqual({ error: 'invalid' });
    expect(credentialsFromM3uLink('ftp://lien.invalid/get.php?username=a&password=b')).toEqual({ error: 'invalid' });
    expect(credentialsFromM3uLink('')).toEqual({ error: 'invalid' });
  });

  it('adresse trop longue pour le coffre de l\'ordinateur : refusée sur ordinateur, acceptée sur Android', () => {
    const url = `https://liste.invalid/a.m3u?token=${'x'.repeat(1300)}`;
    expect(credentialsFromM3uLink(url)).toEqual({ error: 'too_long' });
    platform.android = true;
    expect('creds' in credentialsFromM3uLink(url)).toBe(true);
  });
});

describe('isM3uListCredentials / m3uListCredentials', () => {
  it('abonnement Xtream : pas une liste M3U', () => {
    expect(isM3uListCredentials({ host: 'http://a.invalid', username: 'u', password: 'p' })).toBe(false);
    expect(isM3uListCredentials(null)).toBe(false);
    expect(isM3uListCredentials({ host: 'm3u:a.invalid', username: '', password: '', m3u: { url: '' } })).toBe(false);
  });

  it('guide des programmes gardé quand il est donné', () => {
    expect(m3uListCredentials({ kind: 'm3u', url: 'http://a.invalid/l.m3u', epgUrl: 'http://a.invalid/g.xml' }))
      .toEqual({ host: 'm3u:a.invalid', username: '', password: '', m3u: { url: 'http://a.invalid/l.m3u', epgUrl: 'http://a.invalid/g.xml' } });
  });
});
