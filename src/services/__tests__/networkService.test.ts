/**
 * Tests pour networkService.ts
 *
 * Vérifient les exports et le comportement de base de
 * iptvFetch.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================================
// Mock Tauri invoke
// ============================================================================

const mockInvoke = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

// Mock preferencesService
vi.mock('../preferencesService', () => ({
  getDnsProvider: vi.fn(() => 'cloudflare'),
}));

// ============================================================================
// TESTS
// ============================================================================

describe('networkService — exports', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('exporte iptvFetch', async () => {
    const mod = await import('../networkService');
    expect(typeof mod.iptvFetch).toBe('function');
  });

  it('iptvFetch appelle invoke avec les bons paramètres', async () => {
    mockInvoke.mockResolvedValueOnce('response body');
    const { iptvFetch } = await import('../networkService');
    const result = await iptvFetch('http://test.com/get.php');
    expect(mockInvoke).toHaveBeenCalledWith('iptv_fetch', {
      url: 'http://test.com/get.php',
      dnsProvider: 'cloudflare',
    });
    expect(result).toBe('response body');
  });
});

describe('networkService — isProviderServerError', () => {
  it('reconnaît une panne du serveur du fournisseur rendue par iptv_fetch', async () => {
    const { isProviderServerError } = await import('../networkService');
    expect(isProviderServerError('provider_server_error: HTTP 503')).toBe(true);
    expect(isProviderServerError(new Error('provider_server_error: HTTP 500'))).toBe(true);
  });

  it('reconnaît aussi un serveur injoignable : délai dépassé, adresse introuvable (DNS), connexion refusée', async () => {
    const { isProviderServerError } = await import('../networkService');
    expect(isProviderServerError('provider_unreachable: error sending request: operation timed out')).toBe(true);
    expect(isProviderServerError('provider_unreachable: error trying to connect: dns error: no record found')).toBe(true);
    expect(isProviderServerError(new Error('provider_unreachable: error trying to connect: Connection refused'))).toBe(true);
  });

  it('laisse les autres erreurs telles quelles', async () => {
    const { isProviderServerError } = await import('../networkService');
    expect(isProviderServerError(new Error('Authentication failed'))).toBe(false);
    expect(isProviderServerError('Request failed: builder error')).toBe(false);
    expect(isProviderServerError(undefined)).toBe(false);
  });
});

describe('isProviderCertificateError', () => {
  it('certificat refusé : reconnu, et ce n’est pas « serveur injoignable »', async () => {
    const { isProviderCertificateError, isProviderServerError } = await import('../networkService');
    const error = 'provider_certificate_error: error sending request: invalid peer certificate: Expired';
    expect(isProviderCertificateError(error)).toBe(true);
    expect(isProviderCertificateError(new Error(error))).toBe(true);
    expect(isProviderServerError(error)).toBe(false);
    expect(isProviderCertificateError('provider_unreachable: operation timed out')).toBe(false);
  });
});
