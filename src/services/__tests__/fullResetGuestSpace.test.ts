/**
 * Remise à zéro complète et espace invité : effacer les données d'un compte garde l'identifiant de
 * l'espace invité (sa base resterait sinon sur l'appareil, sans plus personne pour la retrouver) ;
 * depuis l'espace invité lui-même, tout part, identifiant compris.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: vi.fn() }));
vi.mock('../storage', () => ({ StorageService: { clearCredentials: vi.fn() } }));
vi.mock('../dbCore', () => ({
  closeDatabaseConnection: vi.fn(),
  getDatabaseFileName: () => 'nyxplayer_x.db',
  resetDatabaseName: vi.fn(),
}));
vi.mock('../backgroundWork', () => ({ stopBackgroundWork: vi.fn() }));
vi.mock('../epgService', () => ({ stopSyncForSessionChange: vi.fn(), waitForSyncEnd: vi.fn() }));
vi.mock('../sync/syncScheduler', () => ({ startCloudResync: vi.fn(), stopCloudResync: vi.fn(), waitForCloudResync: vi.fn() }));
vi.mock('../sync/syncState', () => ({ getCurrentSyncUserId: () => null }));
vi.mock('../syncService', () => ({ purgeCloudData: vi.fn() }));
vi.mock('../authStorage', () => ({ purgeDurableAuthSession: vi.fn() }));
vi.mock('../supabaseClient', () => ({ SUPABASE_STORAGE_KEY: 'sb-test-auth-token' }));
vi.mock('../appRestart', () => ({ restartApp: vi.fn(async () => {}) }));
const space = vi.hoisted(() => ({ current: null as { kind: 'account' | 'guest'; id: string } | null }));
vi.mock('../localSpace', () => ({
  getOpenLocalSpace: () => space.current,
  GUEST_SPACE_STORAGE_KEY: 'nyx_guest_space_id',
}));

import { performFullReset } from '../fullResetService';

const GUEST_ID = '11111111-2222-4333-8444-555555555555';

describe('performFullReset : espace invité', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    localStorage.setItem('nyx_guest_space_id', GUEST_ID);
    localStorage.setItem('nyx_guest_mode', '1');
    localStorage.setItem('autre_reglage', 'x');
  });

  it('depuis un compte : l\'identifiant de l\'espace invité est gardé, le reste est effacé', async () => {
    space.current = { kind: 'account', id: '99999999-2222-4333-8444-555555555555' };
    await performFullReset();
    expect(localStorage.getItem('nyx_guest_space_id')).toBe(GUEST_ID);
    expect(localStorage.getItem('autre_reglage')).toBeNull();
  });

  it('suppression du compte : l\'espace invité n\'est pas oublié non plus', async () => {
    space.current = { kind: 'account', id: '99999999-2222-4333-8444-555555555555' };
    await performFullReset({ deleteAccount: true });
    expect(localStorage.getItem('nyx_guest_space_id')).toBe(GUEST_ID);
  });

  it('depuis l\'espace invité : tout part, identifiant et choix « sans compte » compris (retour à l\'accueil)', async () => {
    space.current = { kind: 'guest', id: GUEST_ID };
    await performFullReset();
    expect(localStorage.getItem('nyx_guest_space_id')).toBeNull();
    expect(localStorage.getItem('nyx_guest_mode')).toBeNull();
    expect(invokeMock).toHaveBeenCalledWith('full_reset', { dbName: 'nyxplayer_x.db' });
  });
});
