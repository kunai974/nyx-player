/**
 * Verrou « jamais de vrai flux » des versions d'audit (banc de tests automatiques).
 *
 * Le verrou n'existe que dans la version du banc (VITE_BANC=1) : le module est rechargé avec la
 * variable posée, comme dans dev/__tests__/auditBridge.test.tsx. Une adresse admise n'est pas lue non
 * plus : le lecteur simulé (dev/lecteurSimule.ts) remplace mpv, rien ne part vers mpv.exe ni vers le
 * plugin Android. Hors de cette version, `loadfile` part tel quel vers le lecteur, comme avant.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { invoke, android, platform } = vi.hoisted(() => ({
  invoke: vi.fn(),
  android: { command: vi.fn(), setFullscreen: vi.fn() },
  platform: { android: false },
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('tauri-plugin-mpv-api', () => ({}));
vi.mock('../../../utils/platform', () => ({ isAndroid: () => platform.android }));
vi.mock('../androidPlayer', () => android);

async function load(audit: boolean) {
  vi.resetModules();
  vi.stubEnv('VITE_AUDIT', audit ? '1' : '');
  vi.stubEnv('VITE_BANC', audit ? '1' : '');
  const api = await import('../mpvApi');
  await import('../../../dev/prisesBanc'); // outils du banc branchés, comme au démarrage (main.tsx)
  const banc = await import('../../../dev/bancAdresses');
  return { ...api, ...banc };
}

const VRAI = 'http://fournisseur.exemple.invalid:8080/live/u/p/1.ts';
const FAUX = 'http://127.0.0.1:8765/live/banc/banc/1.ts';

describe('mpvApi — verrou du banc (version du banc)', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    invoke.mockReset().mockResolvedValue(null);
    android.command.mockReset().mockResolvedValue(undefined);
    android.setFullscreen.mockReset().mockResolvedValue(undefined);
    platform.android = false;
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    warn.mockRestore();
  });

  it('Windows : refuse une adresse hors du faux fournisseur, sans rien envoyer à mpv.exe', async () => {
    const { command, estLectureRefusee } = await load(true);
    const e = await command('loadfile', [VRAI, 'replace']).catch((err: unknown) => err);
    expect(estLectureRefusee(e)).toBe(true);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('Android : refuse de même, le plugin natif ne reçoit rien', async () => {
    platform.android = true;
    const { command } = await load(true);
    await expect(command('loadfile', [VRAI])).rejects.toMatchObject({ code: 'BANC_LECTURE_REFUSEE' });
    expect(android.command).not.toHaveBeenCalled();
  });

  it('refuse loadlist, les options de fichier de loadfile et les propriétés qui ouvrent une adresse', async () => {
    const { command, setProperty, estLectureRefusee } = await load(true);
    expect(estLectureRefusee(await command('loadlist', [FAUX]).catch((err: unknown) => err))).toBe(true);
    expect(estLectureRefusee(await command('loadfile', [FAUX, 'replace', '0', `stream-open-filename=${VRAI}`]).catch((err: unknown) => err))).toBe(true);
    for (const nom of ['stream-open-filename', 'path', 'playlist-pos']) {
      expect(estLectureRefusee(await setProperty(nom as never, VRAI as never).catch((err: unknown) => err))).toBe(true);
    }
    expect(invoke).not.toHaveBeenCalled();
    // Lecteur simulé : les autres propriétés restent dans la page
    await setProperty('pause' as never, true as never);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('admet le faux fournisseur (émulateur et Windows, 4 instances) sans rien lire : lecteur simulé', async () => {
    const { command, tentativesLecture } = await load(true);
    for (const url of [FAUX, 'http://10.0.2.2:8766/movie/banc/banc/2.mp4', 'https://10.0.2.2:8768/live/banc/banc/3.ts', 'http://127.0.0.1:8767/series/banc/banc/4.mkv']) {
      await command('loadfile', [url, 'replace']);
    }
    expect(tentativesLecture().map((t) => t.acceptee)).toEqual([true, true, true, true]);
    // Titre lancé (genre, numéro) noté pour le banc, qui vérifie ainsi QUEL film « Reprendre » lance
    expect(tentativesLecture().map((t) => t.titre)).toEqual([
      { genre: 'live', numero: 1 }, { genre: 'movie', numero: 2 }, { genre: 'live', numero: 3 }, { genre: 'series', numero: 4 },
    ]);
    expect(invoke).not.toHaveBeenCalled();
    platform.android = true;
    await command('loadfile', [FAUX, 'replace']);
    expect(android.command).not.toHaveBeenCalled();
  });

  it('refuse le relais du vrai fournisseur, un port hors plage, localhost et les adresses piégées', async () => {
    const { command } = await load(true);
    const refusees = [
      'http://127.0.0.1:8790/live/u/p/1.ts', // relais : jamais de lecture
      'http://127.0.0.1:8764/live/banc/banc/1.ts',
      'http://127.0.0.1:8769/live/banc/banc/1.ts',
      'http://127.0.0.1/live/banc/banc/1.ts',
      'http://localhost:8765/live/banc/banc/1.ts',
      'http://127.0.0.1:8765@fournisseur.exemple.invalid/live/1.ts',
      'http://127.0.0.1:8765\\@fournisseur.exemple.invalid/live/1.ts',
      'http://127.0.0.1:87650/live/1.ts',
      'http://127.0.0.1:8765.exemple.invalid/live/1.ts',
      'http://127.0.0.1.exemple.invalid:8765/live/1.ts',
      'rtmp://127.0.0.1:8765/live/1',
      'file:///C:/video.ts',
      ' http://127.0.0.1:8765/live/1.ts',
      'http://127.0.0.1:8765/live/1.ts\n',
      'HTTP://127.0.0.1:8765/live/1.ts',
      'http://127.0.0.1:8765?@fournisseur.exemple.invalid/x', // « @ » nulle part (Java y verrait un hôte)
      'http://127.0.0.1:8765/live/a@b/1.ts',
      'http://127.0.0.1:8765/live/1.ts\t',
      'http://127.0.0.1:8765/live/é.ts',
      '',
    ];
    for (const url of refusees) {
      await expect(command('loadfile', [url, 'replace']), url).rejects.toMatchObject({ code: 'BANC_LECTURE_REFUSEE' });
    }
    await expect(command('loadfile', [])).rejects.toMatchObject({ code: 'BANC_LECTURE_REFUSEE' });
    await expect(command('loadfile', [{ url: FAUX }])).rejects.toMatchObject({ code: 'BANC_LECTURE_REFUSEE' });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('n\'écrit jamais l\'adresse refusée, ni dans la console ni dans l\'erreur', async () => {
    const { command } = await load(true);
    const e = (await command('loadfile', [VRAI]).catch((err: unknown) => err)) as Error;
    expect(String(e.message)).not.toContain('exemple.invalid');
    expect(warn).toHaveBeenCalledWith('[BANC] lecture refusée : adresse hors du faux fournisseur');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('exemple.invalid');
  });

  it('note chaque tentative (nature seulement) pour le pont d\'audit', async () => {
    const { command, tentativesLecture } = await load(true);
    await command('loadfile', [FAUX]);
    await command('loadfile', [VRAI]).catch(() => {});
    await command('loadfile', ['http://10.0.2.2:8790/live/u/p/1.ts']).catch(() => {});
    const t = tentativesLecture();
    expect(t.map(({ cible, acceptee }) => ({ cible, acceptee }))).toEqual([
      { cible: 'faux', acceptee: true },
      { cible: 'autre', acceptee: false },
      { cible: 'relais', acceptee: false },
    ]);
    expect(JSON.stringify(t)).not.toContain('exemple.invalid');
    // Jamais de titre pour une adresse refusée, même de la forme d'un flux
    expect(t.slice(1).map((x) => x.titre)).toEqual([undefined, undefined]);
  });

  it('un refus n\'est jamais oublié, même après beaucoup de lectures acceptées', async () => {
    const { command, tentativesLecture } = await load(true);
    await command('loadfile', [VRAI]).catch(() => {});
    for (let i = 0; i < 250; i++) await command('loadfile', [FAUX]);
    const t = tentativesLecture();
    expect(t.length).toBe(200);
    expect(t.some((x) => !x.acceptee && x.cible === 'autre')).toBe(true);
  });

  it('les autres commandes vont au lecteur simulé, jamais à mpv.exe', async () => {
    const { command, init, isEngineAlive } = await load(true);
    await init({ args: [], observedProperties: [], ipcTimeoutMs: 1 });
    await command('stop');
    expect(await isEngineAlive()).toBe(true);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('Android : l\'arrêt du lecteur simulé sort du paysage plein écran natif, sans toucher au moteur', async () => {
    platform.android = true;
    const { command } = await load(true);
    await command('loadfile', [FAUX, 'replace']);
    await command('cycle', ['pause']);
    // Le lancement passe au paysage par le plugin (usePlaybackSession) : seul l'arrêt doit en sortir
    expect(android.setFullscreen).not.toHaveBeenCalled();
    await command('stop');
    expect(android.setFullscreen).toHaveBeenCalledExactlyOnceWith(false);
    expect(android.command).not.toHaveBeenCalled();
    // Windows : rien de natif (la fenêtre sort du plein écran par PlayerControls)
    platform.android = false;
    android.setFullscreen.mockClear();
    await command('stop');
    expect(android.setFullscreen).not.toHaveBeenCalled();
  });
});

describe('mpvApi — version normale', () => {
  beforeEach(() => {
    invoke.mockReset().mockResolvedValue(null);
    platform.android = false;
  });
  afterEach(() => vi.unstubAllEnvs());

  it('aucun verrou : toute adresse part vers le lecteur, comme avant', async () => {
    const { command, tentativesLecture } = await load(false);
    await command('loadfile', [VRAI, 'replace']);
    expect(invoke).toHaveBeenLastCalledWith('nyx_mpv_command', { name: 'loadfile', args: [VRAI, 'replace'] });
    expect(tentativesLecture()).toEqual([]);
  });

  it('vrai lecteur : initialisation, propriétés et arrêt partent vers mpv.exe, jamais vers le lecteur simulé', async () => {
    const { init, command, setProperty, getProperty } = await load(false);
    await init({ args: [], observedProperties: [], ipcTimeoutMs: 1 });
    expect(invoke).toHaveBeenLastCalledWith('nyx_mpv_init', { args: [], observedProperties: [], ipcTimeoutMs: 1 });
    await setProperty('pause' as never, true as never);
    expect(invoke).toHaveBeenLastCalledWith('nyx_mpv_command', { name: 'set_property', args: ['pause', true] });
    await getProperty('time-pos' as never);
    expect(invoke).toHaveBeenLastCalledWith('nyx_mpv_command', { name: 'get_property', args: ['time-pos'] });
    await command('stop');
    expect(invoke).toHaveBeenLastCalledWith('nyx_mpv_command', { name: 'stop', args: [] });
  });

  it('version d\'audit ordinaire (tests à la main, sans VITE_BANC) : lecture normale, aucun verrou', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_AUDIT', '1');
    vi.stubEnv('VITE_BANC', '');
    const { command, tentativesLecture } = await import('../mpvApi').then(async (api) => ({ ...api, ...(await import('../../../dev/bancAdresses')) }));
    await command('loadfile', [VRAI, 'replace']);
    expect(invoke).toHaveBeenLastCalledWith('nyx_mpv_command', { name: 'loadfile', args: [VRAI, 'replace'] });
    expect(tentativesLecture()).toEqual([]);
  });
});

describe('mpvApi — variante « vrai lecteur » du banc (VITE_BANC_LECTEUR=reel, zone 6 bis)', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  async function loadReel() {
    vi.resetModules();
    vi.stubEnv('VITE_AUDIT', '1');
    vi.stubEnv('VITE_BANC', '1');
    vi.stubEnv('VITE_BANC_LECTEUR', 'reel');
    const api = await import('../mpvApi');
    await import('../../../dev/prisesBanc');
    return { ...api, ...(await import('../../../dev/bancAdresses')) };
  }
  beforeEach(() => {
    invoke.mockReset().mockResolvedValue(null);
    android.command.mockReset().mockResolvedValue(undefined);
    platform.android = false;
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    warn.mockRestore();
  });

  it('garde le verrou : une adresse hors du faux fournisseur est refusée, rien ne part vers mpv.exe ni Android', async () => {
    const { command, setProperty, estLectureRefusee } = await loadReel();
    expect(estLectureRefusee(await command('loadfile', [VRAI, 'replace']).catch((err: unknown) => err))).toBe(true);
    expect(estLectureRefusee(await command('loadlist', [FAUX]).catch((err: unknown) => err))).toBe(true);
    expect(estLectureRefusee(await setProperty('stream-open-filename' as never, VRAI as never).catch((err: unknown) => err))).toBe(true);
    expect(invoke).not.toHaveBeenCalled();
    platform.android = true;
    expect(estLectureRefusee(await command('loadfile', [VRAI]).catch((err: unknown) => err))).toBe(true);
    expect(android.command).not.toHaveBeenCalled();
  });

  it('le faux fournisseur est lu par le vrai lecteur (mpv.exe sous Windows, libmpv sur Android)', async () => {
    const { command, tentativesLecture } = await loadReel();
    await command('loadfile', [FAUX, 'replace']);
    expect(invoke).toHaveBeenLastCalledWith('nyx_mpv_command', { name: 'loadfile', args: [FAUX, 'replace'] });
    expect(tentativesLecture()).toEqual([expect.objectContaining({ cible: 'faux', acceptee: true })]);
    platform.android = true;
    await command('loadfile', [FAUX]);
    expect(android.command).toHaveBeenCalledWith('loadfile', [FAUX]);
  });
});

describe('mpvApi — version du banc sans outils de test branchés (prise vide)', () => {
  beforeEach(() => {
    invoke.mockReset().mockResolvedValue(null);
    android.command.mockReset().mockResolvedValue(undefined);
    platform.android = false;
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('refuse tout, même le faux fournisseur, et rien ne part vers mpv.exe ni Android', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_AUDIT', '1');
    vi.stubEnv('VITE_BANC', '1');
    const { command, setProperty, getProperty, observeProperties, listenDesktopEvents } = await import('../mpvApi');
    await expect(command('loadfile', [FAUX, 'replace'])).rejects.toThrow('non branchés');
    await expect(command('loadfile', [VRAI, 'replace'])).rejects.toThrow('non branchés');
    await expect(command('loadlist', [FAUX])).rejects.toThrow('non branchés');
    await expect(setProperty('stream-open-filename', VRAI)).rejects.toThrow('non branchés');
    await expect(command('stop')).rejects.toThrow('non branchés');
    await expect(getProperty('time-pos')).rejects.toThrow('non branchés');
    await expect(observeProperties(['time-pos'], () => {})).rejects.toThrow('non branchés');
    await expect(listenDesktopEvents(() => {})).rejects.toThrow('non branchés');
    platform.android = true;
    await expect(command('loadfile', [FAUX, 'replace'])).rejects.toThrow('non branchés');
    expect(invoke).not.toHaveBeenCalled();
    expect(android.command).not.toHaveBeenCalled();
  });

  it('variante « vrai lecteur » : le faux fournisseur est refusé aussi, rien ne part vers mpv.exe', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_AUDIT', '1');
    vi.stubEnv('VITE_BANC', '1');
    vi.stubEnv('VITE_BANC_LECTEUR', 'reel');
    const { command } = await import('../mpvApi');
    await expect(command('loadfile', [FAUX, 'replace'])).rejects.toThrow('non branchés');
    expect(invoke).not.toHaveBeenCalled();
  });
});
