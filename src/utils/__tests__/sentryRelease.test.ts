/**
 * Les erreurs envoyées à Sentry ne portaient aucun numéro de version : impossible de comparer deux
 * versions (0.8.0 et 0.8.1, bilan du 02/11). La version de l'app est maintenant jointe à chaque envoi.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SENTRY_RELEASE } from '../sentryRelease';

const racine = resolve(__dirname, '../../..');
const lireJson = (chemin: string) => JSON.parse(readFileSync(resolve(racine, chemin), 'utf8')) as { version: string };

describe('version jointe aux envois Sentry', () => {
  it('est « nyx-player@ » suivi de la version de l’app', () => {
    expect(SENTRY_RELEASE).toBe(`nyx-player@${lireJson('package.json').version}`);
  });

  it('correspond à la version de l’app installée (tauri.conf.json)', () => {
    expect(SENTRY_RELEASE).toBe(`nyx-player@${lireJson('src-tauri/tauri.conf.json').version}`);
  });

  it('est passée à Sentry.init', () => {
    const main = readFileSync(resolve(racine, 'src/main.tsx'), 'utf8');
    expect(main).toMatch(/Sentry\.init\(\{[\s\S]*?release: SENTRY_RELEASE,[\s\S]*?\}\);/);
  });
});
