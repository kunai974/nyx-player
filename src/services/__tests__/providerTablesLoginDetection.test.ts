/**
 * Connexion avec les tables du cloud par fournisseur allumées : la préférence du fournisseur notée
 * dans le cloud sert encore à retrouver l'écriture déjà connue du même serveur (même empreinte que
 * les autres appareils), mais un autre fournisseur noté n'est plus un changement : rien n'est
 * effacé, chaque appareil a son fournisseur.
 * Cloud, base et interrupteur simulés.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  lastProvider: null as string | null,
  cloudHash: null as string | null,
}));

vi.mock('../sync/cloudScope', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../sync/cloudScope')>()),
  providerTablesOn: () => true,
}));
vi.mock('../dbCore', () => ({
  getMeta: vi.fn(async (key: string) => (key === 'lastProvider' ? state.lastProvider : null)),
}));
vi.mock('../supabaseClient', () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: { user: { id: 'compte-a' } } } }) } },
}));
vi.mock('../syncService', () => ({
  fetchCloudProviderHash: vi.fn(async () => state.cloudHash),
}));

import { detectProviderChangeOnLogin } from '../sessionSteps';
import { computeProviderHash } from '../preferencesService';

beforeEach(() => {
  state.lastProvider = null;
  state.cloudHash = null;
});

describe('détection du fournisseur à la connexion, tables par fournisseur allumées', () => {
  it('appareil neuf, même serveur écrit autrement dans le cloud : cette écriture est gardée', async () => {
    state.cloudHash = await computeProviderHash('http://Provider-a.example');

    const found = await detectProviderChangeOnLogin('http://provider-a.example');

    expect(found).toEqual({ changed: false, spelling: 'http://Provider-a.example' });
  });

  it('autre fournisseur noté dans le cloud : pas un changement, rien n\'est effacé', async () => {
    state.cloudHash = await computeProviderHash('http://provider-b.example');

    const found = await detectProviderChangeOnLogin('http://provider-a.example');

    expect(found).toEqual({ changed: false, spelling: 'http://provider-a.example' });
  });

  it('autre fournisseur sur ce même appareil : changement détecté par la base locale', async () => {
    state.lastProvider = 'http://provider-b.example';
    state.cloudHash = await computeProviderHash('http://provider-b.example');

    const found = await detectProviderChangeOnLogin('http://provider-a.example');

    expect(found).toEqual({ changed: true, spelling: 'http://provider-a.example' });
  });
});
