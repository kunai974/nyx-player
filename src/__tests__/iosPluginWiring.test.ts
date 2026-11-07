/**
 * iOS: the nyx-android plugin is registered on iOS with its Swift package (same JS name as on
 * Android). The Swift build itself runs in .github/workflows/ios.yml; this checks the wiring text.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PLUGIN = resolve(__dirname, '../../src-tauri/plugins/tauri-plugin-nyx-android');

describe('plugin nyx-android sur iOS', () => {
  const buildRs = readFileSync(resolve(PLUGIN, 'build.rs'), 'utf8');
  const libRs = readFileSync(resolve(PLUGIN, 'src/lib.rs'), 'utf8');
  const swift = readFileSync(resolve(PLUGIN, 'ios/Sources/NyxIosPlugin/NyxPlugin.swift'), 'utf8');

  it('build.rs déclare le dossier iOS', () => expect(buildRs).toMatch(/\.ios_path\("ios"\)/));

  it('lib.rs enregistre le plugin Swift sur iOS seulement', () => {
    expect(libRs).toMatch(/#\[cfg\(target_os = "ios"\)\]\s*tauri::ios_plugin_binding!\(init_plugin_nyx_android\);/);
    expect(libRs).toMatch(/#\[cfg\(target_os = "ios"\)\]\s*_api\.register_ios_plugin\(init_plugin_nyx_android\)\?;/);
  });

  it('point d’entrée Swift public (édition de liens Xcode 27)', () =>
    expect(swift).toMatch(/@_cdecl\("init_plugin_nyx_android"\)\s*public func initPlugin\(\) -> Plugin/));

  it('device_info : jamais une TV', () => expect(swift).toMatch(/"isTv":\s*false/));

  // The build script writes Tauri's Swift API to <plugin>/.tauri (Package.swift: ../.tauri/tauri-api).
  it('.tauri/ ignoré à la racine du plugin', () => {
    const gitignore = readFileSync(resolve(PLUGIN, '.gitignore'), 'utf8').split(/\r?\n/);
    expect(gitignore).toContain('/.tauri');
  });

  it.each(['updateInfo', 'fetchUpdateManifest', 'requestInstallPermission', 'downloadUpdate', 'installUpdate'])(
    '%s refusé sur iOS', (name) =>
      expect(swift).toMatch(new RegExp(`func ${name}\\(_ invoke: Invoke\\)[^}]*invoke\\.reject\\("not supported on iOS"\\)`)));
});
