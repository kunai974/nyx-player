/**
 * Empreinte d'une source : Xtream identique à la 0.8.0 (données cloud gardées), M3U sans jeton.
 */
import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';

vi.mock('../../supabaseClient', () => ({ supabase: {} }));

import { sourceProviderHash, sourceHostLabel, m3uFingerprintInput } from '../sourceFingerprint';
import { computeProviderHash } from '../../preferencesService';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

describe('empreinte', () => {
  it('Xtream : la même que la 0.8.0, pour l\'adresse nettoyée ou l\'écriture déjà connue', async () => {
    const secret = { kind: 'xtream' as const, host: ' HTTP://Provider.example:80/ ', username: 'u', password: 'p' };
    expect(await sourceProviderHash(secret)).toBe(await computeProviderHash('http://provider.example'));
    expect(await sourceProviderHash(secret, 'http://provider.example/')).toBe(sha('http://provider.example/'));
  });

  it('M3U : l\'hôte seul, jamais le chemin, les paramètres ni l\'identifiant (souvent des secrets)', async () => {
    const a = { kind: 'm3u' as const, url: 'https://jean:pw@CDN.example/get.php?username=jean&password=x&token=1' };
    const b = { kind: 'm3u' as const, url: 'https://cdn.example/get/jean/secret-pass/playlist.m3u' };
    const c = { kind: 'm3u' as const, url: 'https://cdn.example/playlist/7f3a9c2e1b' };
    expect(m3uFingerprintInput(a.url)).toBe('m3u:cdn.example');
    expect(m3uFingerprintInput(b.url)).toBe('m3u:cdn.example');
    expect(await sourceProviderHash(a)).toBe(sha('m3u:cdn.example'));
    expect(await sourceProviderHash(b)).toBe(await sourceProviderHash(c));
  });

  it('M3U : un port non standard fait une autre source ; adresse illisible, jamais hachée telle quelle', async () => {
    expect(m3uFingerprintInput('http://cdn.example:8080/list.m3u')).toBe('m3u:cdn.example:8080');
    expect(m3uFingerprintInput('http://cdn.example:80/list.m3u')).toBe('m3u:cdn.example');
    expect(m3uFingerprintInput('cdn.example/other.m3u')).toBe('m3u:cdn.example');
    expect(m3uFingerprintInput('   ')).toBeNull();
    expect(await sourceProviderHash({ kind: 'm3u', url: 'http://[jeton-secret' })).toBe(sha('m3u:'));
  });

  it('une source Xtream et une M3U du même serveur n\'ont pas la même empreinte', async () => {
    const x = await sourceProviderHash({ kind: 'xtream', host: 'http://cdn.example', username: 'u', password: 'p' });
    const m = await sourceProviderHash({ kind: 'm3u', url: 'http://cdn.example' });
    expect(x).not.toBe(m);
  });
});

describe('nom d\'hôte affichable', () => {
  it('ni identifiant, ni port, ni chemin, ni jeton', () => {
    expect(sourceHostLabel({ kind: 'm3u', url: 'https://jean:pw@CDN.example:8443/get.php?password=x' })).toBe('cdn.example');
    expect(sourceHostLabel({ kind: 'xtream', host: 'provider.example:8080', username: 'u', password: 'p' })).toBe('provider.example');
    expect(sourceHostLabel({ kind: 'm3u', url: '::' })).toBe('');
  });
});
