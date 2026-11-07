/**
 * iOS: the bundle config merged over tauri.conf.json, and the Info.plist keys merged into the
 * generated Xcode project. No mpv.exe or updater on iOS, nothing personal committed.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const SRC_TAURI = resolve(__dirname, '../../src-tauri');
const GEN_APPLE = resolve(SRC_TAURI, 'gen/apple');

describe('configuration iOS', () => {
  const raw = readFileSync(resolve(SRC_TAURI, 'tauri.ios.conf.json'), 'utf8');
  const conf = JSON.parse(raw);
  const plist = readFileSync(resolve(SRC_TAURI, 'Info.ios.plist'), 'utf8');
  const plistArray = (key: string): string[] =>
    [...(new RegExp(`<key>${key}</key>\\s*<array>([\\s\\S]*?)</array>`).exec(plist)?.[1] ?? '')
      .matchAll(/<string>([^<]+)<\/string>/g)].map((m) => m[1]);

  it('ne fournit pas mpv.exe ni le module de mise à jour', () => {
    expect(conf.bundle.resources).toBeNull();
    expect(conf.bundle.createUpdaterArtifacts).toBe(false);
    expect(conf.plugins.updater).toBeNull();
  });

  it('iOS 15 minimum (MPVKit)', () => expect(conf.bundle.iOS.minimumSystemVersion).toBe('15.0'));

  it('aucune équipe Apple ni identifiant personnel', () => {
    expect(raw).not.toContain('developmentTeam');
    expect(conf.identifier).toBeUndefined();
  });

  it('lecture audio en arrière-plan déclarée', () => expect(plistArray('UIBackgroundModes')).toEqual(['audio']));

  it('http permis pour les logos et affiches, une seule clé ATS', () => {
    expect(plist).toMatch(/<key>NSAllowsArbitraryLoads<\/key>\s*<true\/>/);
    expect(plist).not.toMatch(/NSAllowsArbitraryLoadsInWebContent|NSAllowsArbitraryLoadsForMedia/);
  });

  it('iPhone : portrait et paysage, pas à l’envers ; iPad : tout', () => {
    expect(plistArray('UISupportedInterfaceOrientations').sort()).toEqual([
      'UIInterfaceOrientationLandscapeLeft', 'UIInterfaceOrientationLandscapeRight', 'UIInterfaceOrientationPortrait']);
    expect(plistArray('UISupportedInterfaceOrientations~ipad')).toHaveLength(4);
  });
});

// tauri-cli rewrites project.pbxproj and ExportOptions.plist on each `ios dev`/`ios build` with a
// team or a `--config` identifier: a build on a Mac must not leave anything personal committed.
describe('projet Xcode généré (gen/apple)', () => {
  const files = (readdirSync(GEN_APPLE, { recursive: true }) as string[])
    .map((f) => f.replace(/\\/g, '/'))
    .filter((f) => !/^(build|Externals)\/|xcuserdata\/|\.png$/.test(f))
    .filter((f) => /\.(pbxproj|plist|yml|xcscheme|entitlements|xcsettings|xcworkspacedata|json|storyboard|h|mm)$|Podfile$/.test(f));
  const text = (f: string) => readFileSync(resolve(GEN_APPLE, f), 'utf8');

  it('trouve les fichiers du projet', () => {
    expect(files).toContain('nyxplayer.xcodeproj/project.pbxproj');
    expect(files).toContain('ExportOptions.plist');
  });

  it('aucune équipe Apple', () => {
    for (const f of files) expect(text(f), f).not.toMatch(/DEVELOPMENT_TEAM|teamID|DevelopmentTeam/);
  });

  it('identifiant de bundle : toujours com.nyxplayer.app', () => {
    const ids = files.flatMap((f) =>
      [...text(f).matchAll(/PRODUCT_BUNDLE_IDENTIFIER\s*[=:]\s*"?([^";\s]+)"?/g)].map((m) => `${f}: ${m[1]}`));
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(id).toMatch(/: (com\.nyxplayer\.app|\$\(PRODUCT_BUNDLE_IDENTIFIER\))$/);
  });
});

describe('workflow iOS', () => {
  const yml = readFileSync(resolve(__dirname, '../../.github/workflows/ios.yml'), 'utf8').replace(/\r\n/g, '\n');

  it('aucun secret : contrôle de compilation seulement', () => expect(yml).not.toMatch(/secrets\./));

  it('IPA non signée, Xcode 26', () => {
    expect(yml).toContain('tauri ios build --ci --target aarch64 --no-sign');
    expect(yml).toMatch(/Xcode_26/);
  });

  it('vérifie que Info.ios.plist est bien fusionné', () => expect(yml).toContain('plutil -extract UIBackgroundModes'));

  // Xcode's archive leaves an incomplete .app in DerivedData: pick the complete one built for the Simulator
  it('choisit l’app du Simulateur par sa plateforme, pas par son dossier', () =>
    expect(yml).toMatch(/CFBundleSupportedPlatforms[\s\S]*iPhoneSimulator/));

  it('ne part jamais tout seul sur le dépôt public', () =>
    expect(yml).not.toContain("github.repository == 'kunai974/nyx-player'"));
});
