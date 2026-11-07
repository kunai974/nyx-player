/**
 * Chaque texte demandé par un écran avec une clé littérale (`t('clé')`) doit exister dans son espace.
 * Sinon l'écran affiche le texte de secours écrit dans le code (en français) même en anglais.
 * Ne regarde que les fichiers qui déclarent un seul espace (`useTranslation('espace')`).
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import fr from '../locales/fr';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' || name === 'i18n' ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\./.test(name) ? [path] : [];
  });
}

function has(ns: unknown, key: string): boolean {
  let node: unknown = ns;
  for (const part of key.split('.')) {
    if (node === null || typeof node !== 'object' || !(part in node)) return false;
    node = (node as Record<string, unknown>)[part];
  }
  return true;
}

describe('clés de texte utilisées', () => {
  it('existent toutes dans l\'espace déclaré par leur fichier', () => {
    const manquantes: string[] = [];
    for (const file of sourceFiles(join(__dirname, '..', '..'))) {
      const code = readFileSync(file, 'utf8');
      const spaces = [...code.matchAll(/useTranslation\(\s*'([a-z]+)'\s*\)/g)].map((m) => m[1]);
      if (new Set(spaces).size !== 1) continue;
      const ns = (fr as Record<string, unknown>)[spaces[0]];
      if (!ns) continue;
      for (const m of code.matchAll(/(?<![\w.])t\(\s*'([A-Za-z0-9_.]+)'/g)) {
        if (!has(ns, m[1])) manquantes.push(`${file.replace(/\\/g, '/').split('/src/')[1]} : ${spaces[0]}:${m[1]}`);
      }
    }
    expect(manquantes).toEqual([]);
  });
});
