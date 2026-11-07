import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
const captureMessage = vi.fn();
let android = true;

vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock('@sentry/react', () => ({ captureMessage: (...a: unknown[]) => captureMessage(...a) }));
vi.mock('../../utils/platform', () => ({ isAndroid: () => android }));

import { exitReportTitle, noteExitRequested, reportLastAbnormalExit, type ExitReport } from '../androidExitReport';

const crashWhileOpening: ExitReport = {
  reason: 'crash_native',
  status: 11,
  foreground: true,
  timestamp: Date.UTC(2026, 10, 3, 19, 0, 0),
  description: 'crash',
  pssKb: 512_000,
  rssKb: 640_000,
  television: true,
  player: { kind: 'movie', extension: 'mkv', phase: 'opening', codec: null, hwdec: 'mediacodec' },
};

describe('androidExitReport', () => {
  beforeEach(() => {
    invoke.mockReset();
    captureMessage.mockReset();
    android = true;
  });

  it("envoie à Sentry la dernière fermeture anormale, avec ce que faisait le lecteur", async () => {
    invoke.mockResolvedValue({ report: crashWhileOpening });
    await reportLastAbnormalExit();

    expect(invoke).toHaveBeenCalledWith('plugin:nyx-android|last_exit_report');
    expect(captureMessage).toHaveBeenCalledTimes(1);
    const [title, options] = captureMessage.mock.calls[0];
    expect(title).toBe('Fermeture anormale Android : crash_native (ouverture movie)');
    expect(options.level).toBe('error');
    expect(options.fingerprint).toEqual(['android-exit', 'crash_native', 'opening', 'movie']);
    expect(options.tags).toMatchObject({
      exit_reason: 'crash_native',
      exit_foreground: 'true',
      device_tv: 'true',
      player_phase: 'opening',
      player_kind: 'movie',
      player_extension: 'mkv',
      player_codec: 'none',
      player_hwdec: 'mediacodec',
    });
    expect(options.contexts.android_exit).toMatchObject({
      status: 11, description: 'crash', pss_kb: 512_000, rss_kb: 640_000, exited_at: '2026-11-03T19:00:00.000Z',
    });
  });

  it("n'envoie rien quand la dernière fermeture était normale", async () => {
    invoke.mockResolvedValue({ report: null });
    await reportLastAbnormalExit();
    expect(captureMessage).not.toHaveBeenCalled();
  });

  it('ne demande rien hors Android', async () => {
    android = false;
    await reportLastAbnormalExit();
    expect(invoke).not.toHaveBeenCalled();
    expect(captureMessage).not.toHaveBeenCalled();
  });

  it('un plugin sans la commande (ancienne version, aperçu) ne gêne pas le démarrage', async () => {
    invoke.mockRejectedValue(new Error('command last_exit_report not found'));
    await expect(reportLastAbnormalExit()).resolves.toBeUndefined();
    expect(captureMessage).not.toHaveBeenCalled();
  });

  it('note la sortie demandée par Retour, sans jamais lever', async () => {
    invoke.mockResolvedValue(undefined);
    await noteExitRequested();
    expect(invoke).toHaveBeenCalledWith('plugin:nyx-android|note_exit_requested');
    invoke.mockRejectedValue(new Error('absent'));
    await expect(noteExitRequested()).resolves.toBeUndefined();
    android = false;
    invoke.mockClear();
    await noteExitRequested();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('nomme une fermeture hors lecture', () => {
    expect(exitReportTitle({ ...crashWhileOpening, reason: 'anr', player: null })).toBe('Fermeture anormale Android : anr (hors lecture)');
  });
});
