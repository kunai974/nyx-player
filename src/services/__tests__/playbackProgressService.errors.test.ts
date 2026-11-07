/**
 * playbackProgressService : cas d'erreur de la base et cas limites (durée inconnue, lots vides).
 * Les écritures de lecture ne doivent jamais faire tomber le lecteur ; la fermeture, elle, signale.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockDb = {
  select: vi.fn<(sql: string, params?: unknown[]) => Promise<unknown[]>>(),
  execute: vi.fn<(sql: string, params?: unknown[]) => Promise<void>>(),
};
vi.mock('../dbCore', () => ({ getDatabase: vi.fn(() => Promise.resolve(mockDb)) }));
vi.mock('../syncService', () => ({
  pushPlaybackUpsertToCloud: vi.fn(),
  pushPlaybackDeleteToCloud: vi.fn(),
}));
vi.mock('../sync/syncState', () => ({ getCurrentSyncUserId: vi.fn(() => 'user-test') }));
vi.mock('../sync/syncBaseline', () => ({
  readBaseline: vi.fn(async () => new Map()),
  forgetForCurrentAccount: vi.fn(async () => {}),
}));

import {
  getProgressByStreamId,
  getProgressByStreamIds,
  getProgressByTmdbIds,
  clearProgress,
  clearMultipleProgress,
  clearProgressByType,
  clearUnavailableResume,
  hasProgress,
  startPlayback,
  updateProgress,
  finalizePlayback,
} from '../playbackProgressService';
import { pushPlaybackDeleteToCloud } from '../syncService';
import { PLAYBACK_EVENT } from '../eventConstants';

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.select.mockResolvedValue([]);
  mockDb.execute.mockResolvedValue(undefined);
});

describe('lecture de la progression - cas limites', () => {
  it('une durée inconnue (0) donne 0 % sans division par zéro', async () => {
    mockDb.select.mockResolvedValueOnce([{ time_seconds: 50, duration_seconds: 0 }]);
    expect(await getProgressByStreamId(1)).toEqual({ timeSeconds: 50, durationSeconds: 0, progressPercent: 0 });
  });

  it('arrondit le pourcentage à l\'entier', async () => {
    mockDb.select.mockResolvedValueOnce([{ time_seconds: 1, duration_seconds: 3 }]);
    expect((await getProgressByStreamId(1))?.progressPercent).toBe(33);
  });

  it('renvoie null si la lecture échoue', async () => {
    mockDb.select.mockRejectedValueOnce(new Error('SQL'));
    expect(await getProgressByStreamId(1)).toBeNull();
  });

  it('getProgressByStreamIds : liste vide sans requête', async () => {
    expect((await getProgressByStreamIds([])).size).toBe(0);
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it('getProgressByStreamIds : convertit les identifiants texte en nombres et gère la durée 0', async () => {
    mockDb.select.mockResolvedValueOnce([{ stream_id: 7, time_seconds: 10, duration_seconds: 0 }]);
    const map = await getProgressByStreamIds(['7', 8]);
    expect(mockDb.select.mock.calls[0][1]).toEqual([7, 8]);
    expect(map.get(7)?.progressPercent).toBe(0);
  });

  it('getProgressByStreamIds : carte vide si la lecture échoue', async () => {
    mockDb.select.mockRejectedValueOnce(new Error('SQL'));
    expect((await getProgressByStreamIds([1])).size).toBe(0);
  });

  it('getProgressByTmdbIds : durée 0 donne 0 %, échec donne une carte vide', async () => {
    mockDb.select.mockResolvedValueOnce([{ tmdb_id: 5, time_seconds: 10, duration_seconds: 0 }]);
    expect((await getProgressByTmdbIds([5])).get(5)?.progressPercent).toBe(0);
    mockDb.select.mockRejectedValueOnce(new Error('SQL'));
    expect((await getProgressByTmdbIds([5])).size).toBe(0);
  });

  it('hasProgress : false si la lecture échoue', async () => {
    mockDb.select.mockRejectedValueOnce(new Error('SQL'));
    expect(await hasProgress(1)).toBe(false);
  });
});

describe('suppressions - erreurs', () => {
  it('clearProgress : aucun événement ni envoi cloud si la suppression échoue', async () => {
    const spy = vi.fn();
    window.addEventListener(PLAYBACK_EVENT, spy);
    mockDb.execute.mockRejectedValueOnce(new Error('SQL'));
    await expect(clearProgress(4)).rejects.toThrow('SQL');
    window.removeEventListener(PLAYBACK_EVENT, spy);
    expect(spy).not.toHaveBeenCalled();
    expect(pushPlaybackDeleteToCloud).not.toHaveBeenCalled();
  });

  it('clearProgress : convertit l\'identifiant texte en nombre pour la base et le cloud', async () => {
    await clearProgress('12');
    expect(mockDb.execute).toHaveBeenCalledWith('DELETE FROM playback_progress WHERE stream_id = ?', [12]);
    expect(pushPlaybackDeleteToCloud).toHaveBeenCalledWith(12);
  });

  it('clearMultipleProgress : un envoi cloud par identifiant', async () => {
    await clearMultipleProgress(['1', 2, 3]);
    expect(mockDb.execute.mock.calls[0][1]).toEqual([1, 2, 3]);
    expect(vi.mocked(pushPlaybackDeleteToCloud).mock.calls.map((c) => c[0])).toEqual([1, 2, 3]);
  });

  it('clearMultipleProgress : rien envoyé au cloud si la suppression échoue', async () => {
    mockDb.execute.mockRejectedValueOnce(new Error('SQL'));
    await expect(clearMultipleProgress([1, 2])).rejects.toThrow('SQL');
    expect(pushPlaybackDeleteToCloud).not.toHaveBeenCalled();
  });

  it('clearProgressByType : signale l\'échec (distinct de « rien à effacer »)', async () => {
    mockDb.select.mockRejectedValueOnce(new Error('SQL'));
    await expect(clearProgressByType('movie')).rejects.toThrow('SQL');
    expect(mockDb.execute).not.toHaveBeenCalled();
  });

  it('clearUnavailableResume : renvoie 0 si la base échoue', async () => {
    mockDb.select.mockRejectedValueOnce(new Error('SQL'));
    expect(await clearUnavailableResume({ id: 1, type: 'movie', tmdbId: 5 })).toBe(0);
  });
});

describe('écritures de lecture - erreurs', () => {
  it('startPlayback ne lève pas d\'erreur si la base échoue', async () => {
    mockDb.select.mockRejectedValue(new Error('SQL'));
    mockDb.execute.mockRejectedValue(new Error('SQL'));
    await expect(startPlayback({ streamId: 1, contentType: 'movie', title: 'Film' })).resolves.toBeUndefined();
  });

  it('updateProgress ne lève pas d\'erreur si la base échoue', async () => {
    mockDb.execute.mockRejectedValueOnce(new Error('SQL'));
    await expect(updateProgress(1, 10, 100)).resolves.toBeUndefined();
  });

  it('finalizePlayback relance l\'erreur pour que le lecteur sache que la position n\'est pas enregistrée', async () => {
    mockDb.select.mockRejectedValue(new Error('SQL'));
    mockDb.execute.mockRejectedValue(new Error('SQL'));
    await expect(finalizePlayback({
      streamId: 1, timeSeconds: 500, durationSeconds: 1000,
    } as never)).rejects.toThrow('SQL');
  });
});
