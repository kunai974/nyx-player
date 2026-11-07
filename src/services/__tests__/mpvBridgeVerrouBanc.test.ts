/**
 * Version du banc : aucune adresse n'est jamais sondée par `probe_stream_status` (requête Rust vers
 * le flux), ni une adresse refusée par le verrou du banc (mpvApi),
 * ni celle d'un faux fournisseur : le lecteur simulé ne demande aucun
 * flux, la sonde non plus. Les événements du lecteur simulé sont remplacés ici pour en envoyer un en
 * erreur.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MpvEvent } from 'tauri-plugin-mpv-api';

const { invoke, events } = vi.hoisted(() => ({
  invoke: vi.fn(),
  events: { callback: null as ((e: MpvEvent) => void) | null },
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('tauri-plugin-mpv-api', () => ({
  listenEvents: vi.fn(async (cb: (e: MpvEvent) => void) => { events.callback = cb; return () => {}; }),
}));
vi.mock('../appSettingsService', () => ({ isHardwareAccelerationEnabled: vi.fn().mockResolvedValue(true) }));
vi.mock('../../utils/platform', () => ({ isAndroid: () => false }));
vi.mock('../player/androidPlayer', () => ({}));
vi.mock('../../dev/lecteurSimule', async () => {
  const reel = await vi.importActual<typeof import('../../dev/lecteurSimule')>('../../dev/lecteurSimule');
  return { ...reel, ecouterEvenements: vi.fn(async (cb: (e: MpvEvent) => void) => { events.callback = cb; return () => {}; }) };
});

async function load(audit: boolean) {
  vi.resetModules();
  events.callback = null;
  vi.stubEnv('VITE_AUDIT', audit ? '1' : '');
  vi.stubEnv('VITE_BANC', audit ? '1' : '');
  const bridge = await import('../mpvBridge');
  await import('../../dev/prisesBanc'); // outils du banc branchés, comme au démarrage (main.tsx)
  return bridge;
}

const VRAI = 'http://fournisseur.exemple.invalid:8080/live/u/p/1.ts';
const FAUX = 'http://127.0.0.1:8765/live/banc/banc/1.ts';
const endFileError = { event: 'end-file', reason: 'error' } as unknown as MpvEvent;
const probes = () => invoke.mock.calls.filter(([cmd]) => cmd === 'probe_stream_status');

describe('mpvBridge — sonde et verrou du banc', () => {
  beforeEach(() => {
    invoke.mockReset().mockImplementation(async (cmd: string) => (cmd === 'nyx_mpv_alive' ? true : cmd === 'probe_stream_status' ? 404 : 'main'));
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('lecture refusée : un « end-file » en erreur ne sonde pas l\'adresse refusée', async () => {
    const { mpvPlay, mpvStop } = await load(true);
    await expect(mpvPlay(VRAI)).rejects.toMatchObject({ code: 'BANC_LECTURE_REFUSEE' });
    expect(events.callback).toBeTypeOf('function');
    events.callback!(endFileError);
    await new Promise((r) => setTimeout(r, 0));
    expect(probes()).toEqual([]);
    expect(JSON.stringify(invoke.mock.calls)).not.toContain('exemple.invalid');
    await mpvStop();
  });

  it('lecture admise (faux fournisseur) : jamais de sonde non plus, aucune requête vers un flux', async () => {
    const { mpvPlay, mpvStop } = await load(true);
    await mpvPlay(FAUX);
    events.callback!(endFileError);
    await new Promise((r) => setTimeout(r, 0));
    expect(probes()).toEqual([]);
    expect(invoke).not.toHaveBeenCalled();
    await mpvStop();
  });

  it('version normale : la sonde vise le flux lu, comme avant', async () => {
    const { mpvPlay, mpvStop } = await load(false);
    await mpvPlay(VRAI);
    events.callback!(endFileError);
    await vi.waitFor(() => expect(probes()).toEqual([['probe_stream_status', { url: VRAI }]]));
    await mpvStop();
  });
});

describe('mpvBridge — seconde barrière de la sonde', () => {
  beforeEach(() => {
    invoke.mockReset().mockImplementation(async (cmd: string) => (cmd === 'nyx_mpv_alive' ? true : cmd === 'probe_stream_status' ? 404 : 'main'));
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.doUnmock('../player/mpvApi');
  });

  it('version d\'audit : une adresse hors du faux fournisseur n\'est jamais sondée, même acceptée par mpvApi', async () => {
    vi.resetModules();
    events.callback = null;
    vi.stubEnv('VITE_AUDIT', '1');
    vi.stubEnv('VITE_BANC', '1');
    // mpvApi remplacé par une version sans verrou : seule la barrière de la sonde reste
    vi.doMock('../player/mpvApi', async () => {
      const reel = await vi.importActual<typeof import('../player/mpvApi')>('../player/mpvApi');
      return { ...reel, command: vi.fn(async () => undefined) };
    });
    const { mpvPlay, mpvStop } = await import('../mpvBridge');
    await import('../../dev/prisesBanc');
    await mpvPlay(VRAI);
    events.callback!(endFileError);
    await new Promise((r) => setTimeout(r, 0));
    expect(probes()).toEqual([]);
    await mpvStop();
  });
});
