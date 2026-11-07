/**
 * Lecteur (PlayerControls, mode TV) : choisir un épisode dans la liste enregistre d'abord la position
 * de l'épisode quitté, comme les boutons précédent / suivant.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import type { SeriesMetadata } from '../../types/player';
import type { IptvStream } from '../../types/iptv';
import type { AppSeriesInfo } from '../../types/xtream';

type PropertyEvent = { name: string; data?: unknown };

const { fakeMpv, mpvStop, player, prefs } = vi.hoisted(() => {
  const state: Record<string, unknown> = { pause: false, mute: false, volume: 100 };
  const listeners = new Set<(e: PropertyEvent) => void>();
  return {
    mpvStop: vi.fn(),
    fakeMpv: {
      state,
      listeners,
      emit: (name: string, data: unknown) => listeners.forEach((cb) => cb({ name, data })),
      setProperty: vi.fn(async (name: string, value: unknown) => {
        state[name] = value;
        listeners.forEach((cb) => cb({ name, data: value }));
      }),
      getProperty: vi.fn(async (name: string) => (name in state ? state[name] : null)),
      observeProperties: vi.fn(async (_props: string[], cb: (e: PropertyEvent) => void) => {
        listeners.add(cb);
        return () => { listeners.delete(cb); };
      }),
      command: vi.fn(async () => undefined),
    },
    player: {
      switchChannel: vi.fn(),
      currentSeries: null as unknown,
      currentlyPlaying: null as unknown,
      play: vi.fn(),
      playbackError: null as unknown,
      retryAttempt: 0,
      retryPlayback: vi.fn(),
      dismissPlaybackError: vi.fn(),
      confirmPlaybackRecovered: vi.fn(),
    },
    prefs: { geekStats: true, binge: true },
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key) }),
}));
vi.mock('../../contexts/PlayerContext', () => ({ usePlayer: () => player }));
const devOverrides = { overrides: { playerControls: {} }, setActivePage: () => {} };
vi.mock('../../contexts/DevOverrideContext', () => ({ useDevOverrides: () => devOverrides }));
vi.mock('../../services/player/mpvApi', () => ({
  setProperty: fakeMpv.setProperty,
  getProperty: fakeMpv.getProperty,
  observeProperties: fakeMpv.observeProperties,
  command: fakeMpv.command,
  setVideoMarginRatio: vi.fn(async () => undefined),
  listenMediaCommands: vi.fn(async () => () => {}),
}));
vi.mock('../../services/mpvBridge', () => ({ mpvStop, getLoadSequence: () => 0 }));
vi.mock('../../services/player/androidPlayer', () => ({ setFullscreen: vi.fn(), observeProperties: vi.fn() }));
vi.mock('../../services/preferencesService', () => ({
  isGeekStatsEnabled: () => prefs.geekStats,
  isBingeModeEnabled: () => prefs.binge,
  getBingeCountdown: () => 10,
}));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    onResized: () => Promise.resolve(() => {}),
    isFullscreen: () => Promise.resolve(false),
    setFullscreen: () => Promise.resolve(),
    innerSize: () => Promise.resolve({ width: 1280, height: 720 }),
  }),
}));
// Hors sujet ici (base locale, guide TV, TMDB) : neutralisés
const noPrefs = {
  savePlaybackPosition: vi.fn(() => Promise.resolve()),
  audioTracks: [{ id: 1, type: 'audio', title: 'Français', lang: 'fre' }, { id: 2, type: 'audio', title: 'English', lang: 'eng' }],
  subTracks: [],
  subtitleScale: 1,
  changeSpeed: vi.fn(),
  selectAudioTrack: vi.fn(),
  selectSubTrack: vi.fn(),
  changeSubtitleScale: vi.fn(),
};
vi.mock('../../hooks/usePlayerPreferences', () => ({ usePlayerPreferences: () => noPrefs }));
vi.mock('../../hooks/usePeriodicSave', () => ({ usePeriodicSave: () => {} }));
vi.mock('../../hooks/usePlayerEpg', () => ({ usePlayerEpg: () => ({ nowProgram: null, nextProgram: null, isVisible: false }) }));
vi.mock('../../hooks/useStallWatchdog', () => ({ useStallWatchdog: () => {}, useLiveEndWatchdog: () => {} }));
vi.mock('../../hooks/usePlaybackRecovery', () => ({ usePlaybackRecovery: () => {} }));
vi.mock('../../hooks/useMediaCommands', () => ({ useMediaCommands: () => {} }));
vi.mock('../../hooks/useTmdbSeries', () => ({ useTmdbSeries: () => ({ currentSeasonEpisodes: [], isSeasonLoading: false }) }));
vi.mock('../../services/memoryService', () => ({ requestMemoryPurge: () => {} }));
vi.mock('../../services/tmdbApi', () => ({ default: { imageUrl: () => null } }));
vi.mock('../Player/EpgBanner', () => ({ default: () => null }));
// Liste des chaînes : réduite à sa grille (ses propres tests couvrent le reste)
vi.mock('../Tv/ChannelSwitcher', () => ({
  default: ({ isOpen, filteredChannels, onChannelClick }: { isOpen: boolean; filteredChannels: IptvStream[]; onChannelClick: (c: IptvStream) => void }) => (
    <div className="channel-switcher" {...(isOpen ? {} : { inert: '' })}>
      <div className="channel-switcher__grid">
        {filteredChannels.map((c) => (
          <div key={c.stream_id} role="button" tabIndex={0} onClick={() => onChannelClick(c)}>{c.name}</div>
        ))}
      </div>
    </div>
  ),
}));

vi.mock('../Player/EpisodeSwitcher', () => ({
  default: ({ onPlayEpisode, currentSeries }: { onPlayEpisode: (e: unknown, s: unknown) => Promise<void>; currentSeries: unknown }) => (
    <button data-testid="pick-ep2" onClick={() => void onPlayEpisode({ id: '12', episode_num: 2 }, currentSeries)}>ep2</button>
  ),
}));
import PlayerControls from '../PlayerControls';
import { setTvMode } from '../../utils/platform';

// ---------------------------------------------------------------------------
// Données factices
// ---------------------------------------------------------------------------


const episode = (id: string, num: number) => ({ id, episode_num: num, title: `Épisode ${num}`, container_extension: 'mkv' });
const SERIES = { series_id: 5, name: 'Série test', episodes: { '1': [episode('11', 1), episode('12', 2)] } } as unknown as AppSeriesInfo;
const seriesMetadata: SeriesMetadata = {
  seriesId: 5, seriesName: 'Série test', seasonNumber: 1, episodeNumber: 1, episodeTitle: 'Pilote',
  episodeId: '11', containerExtension: 'mkv',
  nextEpisode: { episodeId: '12', seasonNumber: 1, episodeNumber: 2, episodeTitle: 'La suite' },
};

// ---------------------------------------------------------------------------
// Outils
// ---------------------------------------------------------------------------

const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });

const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T & HTMLElement>(selector);
const byTitle = (title: string) => $(`[title="${title}"]`)!;

type Props = Partial<React.ComponentProps<typeof PlayerControls>>;

async function mountPlayer(props: Props = {}) {
  const onClose = vi.fn();
  const view = render(<PlayerControls title="Film test" isConnected onClose={onClose} {...props} />);
  await flush();
  const rerender = async (next: Props = {}) => {
    view.rerender(<PlayerControls title="Film test" isConnected onClose={onClose} {...props} {...next} />);
    await flush();
  };
  return { ...view, onClose, rerender };
}

// jsdom ne défile pas : la liste des épisodes appelle scrollIntoView à l'ouverture
const originalScrollIntoView = Element.prototype.scrollIntoView;
beforeAll(() => { Element.prototype.scrollIntoView = () => {}; });
afterAll(() => { Element.prototype.scrollIntoView = originalScrollIntoView; });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'requestAnimationFrame', 'cancelAnimationFrame'] });
  setTvMode(true);
  prefs.geekStats = true;
  prefs.binge = true;
  Object.assign(fakeMpv.state, { pause: false, mute: false, volume: 100 });
  fakeMpv.listeners.clear();
  fakeMpv.setProperty.mockClear();
  fakeMpv.command.mockClear();
  mpvStop.mockReset().mockResolvedValue(undefined);
  Object.assign(player, {
    currentSeries: null, currentlyPlaying: null, playbackError: null, retryAttempt: 0,
  });
  player.switchChannel.mockReset();
  player.play.mockReset().mockResolvedValue(undefined);
  player.retryPlayback.mockReset();
  player.dismissPlaybackError.mockReset();
  player.confirmPlaybackRecovered.mockReset();
  for (const fn of [noPrefs.changeSpeed, noPrefs.selectAudioTrack, noPrefs.selectSubTrack, noPrefs.changeSubtitleScale]) fn.mockReset();
});

afterEach(() => {
  setTvMode(false);
  vi.useRealTimers();
});


describe('PREUVE audit neuf : liste des épisodes', () => {
  it('enregistre la position de l\'épisode en cours avant de lancer celui choisi dans la liste', async () => {
    player.currentSeries = SERIES;
    player.currentlyPlaying = { id: '11', episode_num: 1 };
    (noPrefs.savePlaybackPosition as ReturnType<typeof vi.fn>).mockClear();
    await mountPlayer({ seriesMetadata, contentId: '11', onNextEpisode: vi.fn(), onPrevEpisode: vi.fn() });
    const btn = document.querySelector('[data-testid="pick-ep2"]') as HTMLElement;
    expect(btn).toBeTruthy();
    await act(async () => { btn.click(); await vi.advanceTimersByTimeAsync(0); });
    expect(player.play).toHaveBeenCalled();
    expect(noPrefs.savePlaybackPosition).toHaveBeenCalled();
    const save = (noPrefs.savePlaybackPosition as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    expect(save).toBeLessThan(player.play.mock.invocationCallOrder[0]);
  });
  it('témoin : le bouton épisode suivant, lui, enregistre', async () => {
    player.currentSeries = SERIES;
    player.currentlyPlaying = { id: '11', episode_num: 1 };
    (noPrefs.savePlaybackPosition as ReturnType<typeof vi.fn>).mockClear();
    const onNextEpisode = vi.fn();
    await mountPlayer({ seriesMetadata, contentId: '11', onNextEpisode, onPrevEpisode: vi.fn() });
    await act(async () => { byTitle('next_episode').click(); await vi.advanceTimersByTimeAsync(0); });
    expect(onNextEpisode).toHaveBeenCalled();
    expect(noPrefs.savePlaybackPosition).toHaveBeenCalled();
  });
});
