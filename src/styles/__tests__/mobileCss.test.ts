/**
 * Garde-fou de la surcouche téléphone (src/styles/mobile.css).
 *
 * Chaque règle doit être limitée à la marque de plateforme `.nyx-mobile` :
 * - sinon elle fuit sur desktop (fenêtre étroite) ;
 * - et sans le +1 de spécificité, elle dépend de l'ordre des feuilles, que Vite
 *   ne garantit pas entre dev et build (layout bureau constaté dans l'APK).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { COMPACT_LAYOUT_QUERY } from '../../utils/layout';

const read = (file: string) => readFileSync(resolve(process.cwd(), file), 'utf8');
const css = read('src/styles/mobile.css').replace(/\/\*[\s\S]*?\*\//g, '');

/** Préludes `xxx {` : sélecteurs de règles (at-rules à part). */
const preludes = [...css.matchAll(/([^{};]+)\{/g)].map((m) => m[1].trim());
const selectors = preludes
  .filter((p) => !p.startsWith('@'))
  .flatMap((p) => p.split(',').map((s) => s.trim()));
const mediaQueries = preludes
  .filter((p) => p.startsWith('@media'))
  .map((p) => p.replace(/^@media\s+/, '').replace(/\s+/g, ' '));

describe('styles/mobile.css', () => {
  it('contient des règles', () => {
    expect(selectors.length).toBeGreaterThan(50);
  });

  it('limite chaque sélecteur à la marque .nyx-mobile', () => {
    const unscoped = selectors.filter((s) => !s.startsWith(':root.nyx-mobile') && !s.startsWith('.nyx-mobile '));
    expect(unscoped).toEqual([]);
  });

  it('utilise la même media query que isCompactLayout()', () => {
    expect(mediaQueries).toContain(COMPACT_LAYOUT_QUERY);
  });

  it('est importé statiquement par main.tsx, après App.css', () => {
    const main = read('src/main.tsx');
    const appCss = main.indexOf("import './App.css'");
    const mobileCss = main.indexOf("import './styles/mobile.css'");
    expect(appCss).toBeGreaterThan(-1);
    expect(mobileCss).toBeGreaterThan(appCss);
    expect(main).not.toMatch(/import\(\s*['"]\.\/styles\/mobile\.css['"]\s*\)/);
  });

  it('Réglages › Compte sans compte : sur téléphone, texte puis boutons pleine largeur (ils débordaient)', () => {
    const rule = (sel: string) => {
      const m = css.match(new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}'));
      return m ? m[1] : '';
    };
    expect(rule('.nyx-mobile .settings-section--guest .setting-item')).toMatch(/flex-direction:\s*column/);
    expect(rule('.nyx-mobile .settings-section--guest .settings-form-actions')).toMatch(/flex-direction:\s*column/);
    expect(rule('.nyx-mobile .settings-section--guest .setting-item .nyx-btn')).toMatch(/width:\s*100%/);
    expect(read('src/components/Settings/GuestAccountSection.tsx')).toContain('settings-section--guest');
  });
});
