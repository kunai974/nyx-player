import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

let android = true;
let backListener: (() => void) | null = null;
const exit = vi.fn((_code: number) => Promise.resolve());
const noteExitRequested = vi.fn(() => Promise.resolve());

vi.mock('../../utils/platform', () => ({ isAndroid: () => android }));
vi.mock('@tauri-apps/api/app', () => ({
  onBackButtonPress: (cb: () => void) => {
    backListener = cb;
    return Promise.resolve({ unregister: () => Promise.resolve() });
  },
}));
vi.mock('@tauri-apps/plugin-process', () => ({ exit: (code: number) => exit(code) }));
vi.mock('../../services/androidExitReport', () => ({ noteExitRequested: () => noteExitRequested() }));

import { useAndroidBackButton } from '../useBackHandler';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('useAndroidBackButton : sortie de l\'app', () => {
  beforeEach(() => {
    android = true;
    backListener = null;
    exit.mockClear();
    noteExitRequested.mockReset();
    noteExitRequested.mockImplementation(() => Promise.resolve());
  });

  it('note la sortie demandée avant de quitter', async () => {
    const order: string[] = [];
    noteExitRequested.mockImplementation(() => { order.push('note'); return Promise.resolve(); });
    exit.mockImplementation(() => { order.push('exit'); return Promise.resolve(); });
    renderHook(() => useAndroidBackButton());
    await flush();
    backListener?.();
    await flush();
    expect(order).toEqual(['note', 'exit']);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('quitte quand même si la note échoue', async () => {
    noteExitRequested.mockImplementation(() => Promise.reject(new Error('absent')));
    renderHook(() => useAndroidBackButton());
    await flush();
    backListener?.();
    await flush();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('ne fait rien hors Android', async () => {
    android = false;
    renderHook(() => useAndroidBackButton());
    await flush();
    expect(backListener).toBeNull();
  });
});
