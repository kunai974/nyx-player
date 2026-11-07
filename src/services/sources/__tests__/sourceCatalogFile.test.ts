/**
 * Fichier catalogue d'une source : nom exact, le même que celui accepté par Rust, et suppression
 * par la seule commande prévue.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock('../../../utils/platform', () => ({ isAndroid: () => false }));
vi.mock('../../dbCore', () => ({ clearAllData: vi.fn(), hasContent: vi.fn() }));

import { sourceCatalogFileName, deleteSourceCatalog } from '../sourceCatalogFile';

const SPACE = '0f8b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d';
const SOURCE = '6a1e5c3b-9d2f-4e7a-b8c1-0d2e4f6a8b9c';
const UUID = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';

beforeEach(() => invoke.mockReset());

describe('nom du fichier', () => {
  it('espace puis source, à côté de la base du compte', () => {
    expect(sourceCatalogFileName(SPACE, SOURCE)).toBe(`nyxcat_${SPACE}_${SOURCE}.db`);
  });

  it('rien pour une valeur que Rust refuserait', () => {
    for (const [space, source] of [
      ['', SOURCE], [SPACE, ''], [SPACE.toUpperCase(), SOURCE], [`guest-${SPACE}`, SOURCE],
      ['../x', SOURCE], [SPACE, `${SOURCE}.db`], [SPACE, `${SOURCE}_${SOURCE}`],
    ]) {
      expect(sourceCatalogFileName(space, source), `${space} / ${source}`).toBeNull();
    }
  });

  it('même motif que la garde Rust (storage.rs)', () => {
    const rust = readFileSync(resolve(__dirname, '../../../../src-tauri/src/storage.rs'), 'utf8');
    expect(rust).toContain(`const UUID: &str = "${UUID}";`);
    expect(rust).toContain('Regex::new(&format!(r"^nyxcat_{UUID}_{UUID}\\.db$"))');
    expect(new RegExp(`^nyxcat_${UUID}_${UUID}\\.db$`).test(sourceCatalogFileName(SPACE, SOURCE)!)).toBe(true);
  });
});

describe('suppression', () => {
  it('par la seule commande prévue, avec le nom exact', async () => {
    invoke.mockResolvedValueOnce(undefined);
    await deleteSourceCatalog(SPACE, SOURCE);
    expect(invoke).toHaveBeenCalledWith('delete_source_catalog', { dbName: `nyxcat_${SPACE}_${SOURCE}.db` });
  });

  it('identifiant invalide : refusé avant tout appel natif', async () => {
    await expect(deleteSourceCatalog('../x', SOURCE)).rejects.toThrow('invalid_source_catalog');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('commande déclarée et autorisée côté Rust', () => {
    const build = readFileSync(resolve(__dirname, '../../../../src-tauri/build.rs'), 'utf8');
    const caps = readFileSync(resolve(__dirname, '../../../../src-tauri/capabilities/default.json'), 'utf8');
    expect(build).toContain('"delete_source_catalog"');
    expect(caps).toContain('"allow-delete-source-catalog"');
  });
});
