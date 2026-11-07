import { describe, it, expect, vi } from 'vitest';
import {
  classifyHttpStatus,
  classifyNativeError,
  isAutoRetryable,
  RETRY_DELAYS_S,
  RETRY_MIN_INTERVAL_MS,
  emitPlaybackError,
  subscribePlaybackErrors,
} from '../playbackErrors';

describe('playbackErrors', () => {
  it('classe le 458 Xtream (et 429 / 509) en limite de connexions', () => {
    expect(classifyHttpStatus(458)).toBe('connection_limit');
    expect(classifyHttpStatus(429)).toBe('connection_limit');
    expect(classifyHttpStatus(509)).toBe('connection_limit');
  });

  it('classe les refus d\'accès, contenus absents et erreurs serveur', () => {
    expect(classifyHttpStatus(401)).toBe('access_denied');
    expect(classifyHttpStatus(403)).toBe('access_denied');
    expect(classifyHttpStatus(404)).toBe('not_found');
    expect(classifyHttpStatus(503)).toBe('server');
    expect(classifyHttpStatus(undefined)).toBe('network');
    expect(classifyHttpStatus(0)).toBe('network');
  });

  it('priorise le code HTTP sur le code natif', () => {
    expect(classifyNativeError('MPV_LOAD_FAILED', 458)).toBe('connection_limit');
    expect(classifyNativeError('MPV_LOAD_FAILED', 404)).toBe('not_found');
  });

  it('reconnaît les codes du plugin libmpv Android', () => {
    expect(classifyNativeError('NO_DECODER')).toBe('unsupported_format');
    // Dolby Vision 5 décodé par le processeur, images perdues : pas de relance (même résultat)
    expect(classifyNativeError('DEVICE_TOO_SLOW')).toBe('device_too_slow');
    expect(isAutoRetryable('device_too_slow')).toBe(false);
    // Échec d'ouverture sans réponse HTTP : serveur injoignable, relance lente autorisée
    expect(classifyNativeError('MPV_LOAD_FAILED')).toBe('network');
    expect(classifyNativeError(undefined)).toBe('unknown');
  });

  it('flux HTTPS refusé faute de certificats : message dédié, pas de relance automatique', () => {
    expect(classifyNativeError('TLS_CA_UNAVAILABLE')).toBe('tls_unavailable');
    // Relancer toutes les 30 s ne ferait que refaire le même refus : l'utilisateur relance à la main
    expect(isAutoRetryable('tls_unavailable')).toBe(false);
  });

  it('ne relance automatiquement que les erreurs passagères', () => {
    expect(isAutoRetryable('connection_limit')).toBe(true);
    expect(isAutoRetryable('network')).toBe(true);
    expect(isAutoRetryable('server')).toBe(true);
    expect(isAutoRetryable('access_denied')).toBe(false);
    expect(isAutoRetryable('not_found')).toBe(false);
    expect(isAutoRetryable('unsupported_format')).toBe(false);
  });

  it('reste très en dessous des seuils anti-flood des panels', () => {
    const total = RETRY_DELAYS_S.reduce((a, b) => a + b, 0);
    // Lecture initiale + relances, ×2 sur desktop (MPV + sonde du code HTTP)
    const requests = (RETRY_DELAYS_S.length + 1) * 2;
    expect(requests).toBeLessThanOrEqual(10);
    expect(Math.min(...RETRY_DELAYS_S)).toBeGreaterThanOrEqual(30);
    // XUI par défaut : 30 requêtes / 10 s → on reste sous 1 requête / 30 s en moyenne
    expect(total / requests).toBeGreaterThanOrEqual(30);
    expect(RETRY_MIN_INTERVAL_MS).toBeGreaterThanOrEqual(15_000);
  });

  it('diffuse les erreurs aux abonnés', () => {
    const listener = vi.fn();
    const unsubscribe = subscribePlaybackErrors(listener);
    emitPlaybackError({ kind: 'connection_limit', httpStatus: 458 });
    unsubscribe();
    emitPlaybackError({ kind: 'network' });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ kind: 'connection_limit', httpStatus: 458 });
  });
});

describe('code HTTP 460 (retour Sentry du 01/11, Android, 0.8.0)', () => {
  it('est traité comme le 458 : limite de connexions, relance espacée permise', () => {
    expect(classifyHttpStatus(460)).toBe('connection_limit');
    expect(classifyNativeError('MPV_LOAD_FAILED', 460)).toBe('connection_limit');
    expect(isAutoRetryable(classifyHttpStatus(460))).toBe(true);
  });
});
