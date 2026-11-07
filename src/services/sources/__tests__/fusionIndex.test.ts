/**
 * Index commun des sources : noms acceptés par Rust, ordre de priorité transmis tel quel.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { abortFusionIndex, buildFusionIndex, fusionIndexFileName } from '../fusionIndex';

const SPACE = '0f8b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d';
const A = '6a1e5c3b-9d2f-4e7a-b8c1-0d2e4f6a8b9c';
const B = '1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d';

beforeEach(() => invoke.mockReset());

describe('index commun des sources', () => {
  it('nom du fichier : même motif que la garde Rust', () => {
    expect(fusionIndexFileName(SPACE)).toBe(`nyxidx_${SPACE}.db`);
    for (const bad of ['', SPACE.toUpperCase(), `guest-${SPACE}`, '../x']) expect(fusionIndexFileName(bad)).toBeNull();
    const rust = readFileSync(resolve(__dirname, '../../../../src-tauri/src/storage.rs'), 'utf8');
    expect(rust).toContain('^nyxidx_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\\.db$');
  });

  it('les sources partent dans l\'ordre de priorité, avec leur fichier', async () => {
    invoke.mockResolvedValueOnce({ status: 'built' });
    await buildFusionIndex(SPACE, [B, A]);
    expect(invoke).toHaveBeenCalledWith('build_fusion_index', {
      indexDbName: `nyxidx_${SPACE}.db`,
      sources: [{ id: B, file: `nyxcat_${SPACE}_${B}.db` }, { id: A, file: `nyxcat_${SPACE}_${A}.db` }],
    });
  });

  it('un espace ou une source mal formé est refusé avant la commande', async () => {
    await expect(buildFusionIndex('x', [A])).rejects.toThrow('invalid_space');
    await expect(buildFusionIndex(SPACE, ['../x'])).rejects.toThrow('invalid_source_catalog');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('arrêt', async () => {
    invoke.mockResolvedValueOnce(undefined);
    await abortFusionIndex();
    expect(invoke).toHaveBeenCalledWith('abort_fusion_index');
  });
});
