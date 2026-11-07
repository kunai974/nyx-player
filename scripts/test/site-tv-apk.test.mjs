// Le code Downloader 2679899 (AFTVnews) mène à https://nyxplayer.app/tv-apk : cette adresse doit
// toujours rediriger vers l'APK TV (armv7) de la version annoncée par android.json.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const web = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');
const read = (f) => JSON.parse(readFileSync(path.join(web, f), 'utf8'));

describe('/tv-apk (code Downloader)', () => {
  it('redirige (302) vers l’APK armv7 de android.json', () => {
    const redirect = read('vercel.json').redirects.find((r) => r.source === '/tv-apk');
    expect(redirect).toBeDefined();
    expect(redirect.permanent).toBe(false);
    expect(redirect.destination).toBe(read('updates/android.json').apks.armv7.url);
  });
});
