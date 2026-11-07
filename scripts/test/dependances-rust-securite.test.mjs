// @vitest-environment node
// Dépendances Rust visées par des avis de sécurité (novembre 2026).
// - zip : le module de mise à jour l'utilisait pour ouvrir une mise à jour livrée en archive .zip.
//   La version 4 qu'il impose a plusieurs failles (extraction hors du dossier, en-têtes trompeurs) et
//   aucune version 4 corrigée n'existe. Nyx publie un installeur .exe, jamais un .zip : la fonction
//   « zip » du module est coupée et la bibliothèque disparaît du programme.
// - serde_with : plantage possible avant 3.21.0, corrigé par une simple montée de version.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const lock = readFileSync(`${root}src-tauri/Cargo.lock`, 'utf8');
const cargoToml = readFileSync(`${root}src-tauri/Cargo.toml`, 'utf8');
const latest = JSON.parse(readFileSync(`${root}web/updates/latest.json`, 'utf8'));

/** Versions d'une bibliothèque retenues dans Cargo.lock. */
function lockedVersions(lockText, name) {
  const re = new RegExp(`\\[\\[package\\]\\]\\r?\\nname = "${name}"\\r?\\nversion = "([^"]+)"`, 'g');
  return [...lockText.matchAll(re)].map((m) => m[1]);
}

/** Compare deux versions « a.b.c » : négatif si a < b. */
function compare(a, b) {
  // parseInt : « 0-rc1 » donne 0 au lieu de NaN (une comparaison NaN laisserait passer le test).
  const pa = a.split('.').map((x) => Number.parseInt(x, 10));
  const pb = b.split('.').map((x) => Number.parseInt(x, 10));
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

describe('dépendances Rust et avis de sécurité', () => {
  it('lit les versions de Cargo.lock', () => {
    const sample = '[[package]]\r\nname = "zip"\r\nversion = "4.6.1"\r\n\r\n[[package]]\nname = "zipper"\nversion = "1.0.0"\n';
    expect(lockedVersions(sample, 'zip')).toEqual(['4.6.1']);
    expect(compare('3.18.0', '3.21.0')).toBeLessThan(0);
    expect(compare('3.21.0', '3.21.0')).toBe(0);
    expect(compare('3.21.0-rc1', '3.21.0')).toBe(0);
  });

  it('la bibliothèque zip ne fait plus partie du programme', () => {
    expect(lockedVersions(lock, 'zip')).toEqual([]);
    // La fonction « zip » du module de mise à jour reste coupée (elle la ramènerait).
    expect(cargoToml).toMatch(/^tauri-plugin-updater = \{[^}]*default-features = false[^}]*\}/m);
    expect(cargoToml).not.toMatch(/^tauri-plugin-updater = \{[^}]*"zip"/m);
  });

  it('les mises à jour Windows annoncées sont des installeurs, jamais des archives .zip', () => {
    // Sans la fonction « zip », une mise à jour livrée en .zip serait refusée par l'application.
    const urls = Object.values(latest.platforms).map((p) => p.url);
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) expect(url).toMatch(/\.(exe|msi)$/);
  });

  it('serde_with est en version corrigée (3.21.0 ou plus)', () => {
    const versions = lockedVersions(lock, 'serde_with');
    expect(versions.length).toBeGreaterThan(0);
    for (const v of versions) expect(compare(v, '3.21.0')).toBeGreaterThanOrEqual(0);
  });
});
