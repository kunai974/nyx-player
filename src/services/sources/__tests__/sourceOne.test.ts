/**
 * Source 1 : reprise des identifiants puis recopie du catalogue, rejouable après une coupure à
 * chaque étape, sans doublon de source.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SPACE = '0f8b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d';
const SOURCE = '6a1e5c3b-9d2f-4e7a-b8c1-0d2e4f6a8b9c';

const { invoke, adoptLegacySource } = vi.hoisted(() => ({ invoke: vi.fn(), adoptLegacySource: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock('../sourceRegistry', () => ({ adoptLegacySource: (...a: unknown[]) => adoptLegacySource(...a) }));
vi.mock('../../../utils/platform', () => ({ isAndroid: () => false }));
vi.mock('../../dbCore', () => ({ clearAllData: vi.fn(), hasContent: vi.fn() }));

import { prepareSourceOne } from '../sourceOne';

const legacy = { host: 'http://provider.example:8080', username: 'jean', password: 'secret-pass' };
const summary = { id: SOURCE, name: 'Source 1', kind: 'xtream', hostLabel: 'provider.example', providerHash: 'h', sortOrder: 0, showInCatalog: true, createdAt: 1, updatedAt: 1 };
const copied = { movies: 50, series: 1, live: 1, categories: 2, epgPrograms: 1, alreadyDone: false };

beforeEach(() => {
  invoke.mockReset();
  adoptLegacySource.mockReset();
});

describe('Source 1', () => {
  it('reprend les identifiants puis recopie le catalogue du compte dans le fichier de la source', async () => {
    adoptLegacySource.mockResolvedValueOnce(summary);
    invoke.mockResolvedValueOnce(copied);
    const result = await prepareSourceOne(SPACE, legacy, { knownSpelling: 'http://provider.example:8080/' });
    expect(adoptLegacySource).toHaveBeenCalledWith(SPACE, legacy, { knownSpelling: 'http://provider.example:8080/' });
    expect(invoke).toHaveBeenCalledWith('copy_catalog_to_source', {
      accountDbName: `nyxplayer_${SPACE}.db`,
      sourceDbName: `nyxcat_${SPACE}_${SOURCE}.db`,
    });
    expect(result).toEqual({ source: summary, copy: copied });
  });

  it('coupure pendant la recopie : relancé, il retrouve la même source et finit la recopie', async () => {
    adoptLegacySource.mockResolvedValue(summary);
    invoke.mockRejectedValueOnce(new Error('app fermée'));
    await expect(prepareSourceOne(SPACE, legacy)).rejects.toThrow('app fermée');
    invoke.mockResolvedValueOnce(copied);
    const result = await prepareSourceOne(SPACE, legacy);
    expect(result?.source.id).toBe(SOURCE);
    expect(invoke).toHaveBeenLastCalledWith('copy_catalog_to_source', expect.objectContaining({ sourceDbName: `nyxcat_${SPACE}_${SOURCE}.db` }));
  });

  it('coupure pendant la reprise des identifiants : rien n\'est recopié', async () => {
    adoptLegacySource.mockRejectedValueOnce(new Error('coffre en panne'));
    await expect(prepareSourceOne(SPACE, legacy)).rejects.toThrow('coffre en panne');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('rien à reprendre (sources déjà là, ou source reprise supprimée) : aucune recopie', async () => {
    adoptLegacySource.mockResolvedValueOnce(null);
    expect(await prepareSourceOne(SPACE, legacy)).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('espace invalide : refusé avant tout', async () => {
    await expect(prepareSourceOne('../x', legacy)).rejects.toThrow('invalid_space');
    expect(adoptLegacySource).not.toHaveBeenCalled();
  });

  it('commande déclarée et autorisée côté Rust, champs du rapport identiques', () => {
    const build = readFileSync(resolve(__dirname, '../../../../src-tauri/build.rs'), 'utf8');
    const caps = readFileSync(resolve(__dirname, '../../../../src-tauri/capabilities/default.json'), 'utf8');
    const rust = readFileSync(resolve(__dirname, '../../../../src-tauri/src/catalog_split.rs'), 'utf8');
    expect(build).toContain('"copy_catalog_to_source"');
    expect(caps).toContain('"allow-copy-catalog-to-source"');
    expect(rust).toContain('#[serde(rename_all = "camelCase")]');
    for (const field of ['movies', 'series', 'live', 'categories', 'epg_programs', 'already_done']) {
      expect(rust).toContain(`pub ${field}:`);
    }
  });
});
