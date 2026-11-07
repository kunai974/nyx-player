/**
 * La fin d'une synchro du guide était annoncée deux fois (ici à la réception de
 * « done », puis par epgService une fois la connexion recyclée) : le catalogue du direct et le guide
 * étaient reconstruits deux fois, ce qui est lourd sur TV. Et l'écoute de la progression restait
 * branchée si la page Réglages était quittée avant la fin de l'abonnement. La fin d'un recalcul des
 * liens du guide n'est plus annoncée ici non plus : la session l'annonce, Réglages ouverts ou non
 * (guide coché mais vide après connexion).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';

type ProgressHandler = (e: { payload: { phase: string; progress: number; count: number } }) => void;

const { listen, epg, bus } = vi.hoisted(() => ({
  listen: vi.fn(),
  epg: { syncing: false },
  bus: { handler: null as ProgressHandler | null, resolve: null as ((fn: () => void) => void) | null },
}));

vi.mock('@tauri-apps/api/event', () => ({ listen }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'fr' } }),
}));
vi.mock('../../../services/epgService', () => ({
  syncEpg: vi.fn(),
  purgeEpgData: vi.fn(),
  isSyncing: () => epg.syncing,
  requestSyncAbort: vi.fn(),
  cancelAbort: vi.fn(),
}));
vi.mock('../../../services/preferencesService', () => ({ isEpgWifiOnly: () => false, setEpgWifiOnly: vi.fn(), isTmdbTitleSearchEnabled: () => true, setTmdbTitleSearch: vi.fn() }));
vi.mock('../../../services/catalogAutoRefresh', () => ({
  getAutoRefreshInfo: () => new Promise(() => {}),
  setAutoRefreshEnabled: vi.fn(),
}));
vi.mock('../../../services/dbCore', () => ({
  getDatabase: () => Promise.resolve({ select: () => Promise.resolve([{ cnt: 0 }]) }),
  getMeta: () => Promise.resolve(null),
}));
vi.mock('../../../utils/platform', () => ({ isMobile: () => false }));
vi.mock('../SourceForm', () => ({ default: () => null }));
vi.mock('../AccountInfoCard', () => ({ default: () => null }));
vi.mock('../CategoryManagerModal', () => ({ default: () => null }));
vi.mock('../../Common/ConfirmModal', () => ({ default: () => null }));
vi.mock('../../Common/NyxButton', () => ({ default: () => null }));

import SourcesSection from '../SourcesSection';
import { EPG_UPDATED_EVENT } from '../../../services/eventConstants';

const credentials = { host: 'http://test.invalid', username: 'u', password: 'p' } as never;

describe('SourcesSection — fin de synchro du guide', () => {
  let announcements = 0;
  const count = () => { announcements++; };

  beforeEach(() => {
    announcements = 0;
    epg.syncing = false;
    bus.handler = null;
    bus.resolve = null;
    listen.mockReset().mockImplementation((_name: string, handler: ProgressHandler) => {
      bus.handler = handler;
      return new Promise<() => void>((resolve) => { bus.resolve = resolve; });
    });
    window.addEventListener(EPG_UPDATED_EVENT, count);
  });
  afterEach(() => window.removeEventListener(EPG_UPDATED_EVENT, count));

  const done = () => act(() => { bus.handler?.({ payload: { phase: 'done', progress: 100, count: 1 } }); });

  it('fin d\'une synchro du guide : pas d\'annonce ici (epgService la fait, une seule fois)', async () => {
    render(<SourcesSection credentials={credentials} accountInfo={null} epgEnabled />);
    await act(async () => { bus.resolve?.(() => {}); });

    epg.syncing = true;
    done();

    expect(announcements).toBe(0);
  });

  it('fin d\'un recalcul des liens du guide (après une lecture du catalogue) : pas d\'annonce ici (la session la fait, une seule fois)', async () => {
    render(<SourcesSection credentials={credentials} accountInfo={null} epgEnabled />);
    await act(async () => { bus.resolve?.(() => {}); });

    done();

    expect(announcements).toBe(0);
  });

  it('page quittée avant la fin de l\'abonnement : l\'écoute est retirée dès son arrivée', async () => {
    const unlisten = vi.fn();
    const { unmount } = render(<SourcesSection credentials={credentials} accountInfo={null} epgEnabled />);
    unmount();

    await act(async () => { bus.resolve?.(unlisten); });

    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});
