/**
 * Tables du cloud par fournisseur : interrupteur éteint (anciennes tables et anciens derniers
 * accords), fournisseur d'une ligne et clés qui séparent deux fournisseurs au même numéro.
 */
import { describe, it, expect } from 'vitest';
import {
  PROVIDER_TABLES_ENABLED, providerTablesOn, cloudTable, baselineScopeFor, bothBaselineScopes, isProviderHash,
  resolveRowProviderHash, providerRowKey, parseProviderRowKey,
} from '../cloudScope';
import { ALL_SCOPES } from '../syncBaseline';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);

describe('interrupteur des tables par fournisseur', () => {
  it('éteint : les anciennes tables et les anciens derniers accords, comme aujourd\'hui', () => {
    expect(PROVIDER_TABLES_ENABLED).toBe(false);
    expect(providerTablesOn()).toBe(false);
    const on = providerTablesOn();
    expect(cloudTable('playback', on)).toBe('user_playback_progress');
    expect(cloudTable('watchlist', on)).toBe('user_watchlist');
    expect(cloudTable('livetv', on)).toBe('user_livetv_bookmarks');
    expect(cloudTable('hidden', on)).toBe('user_hidden_categories');
    expect(baselineScopeFor('watchlist', on)).toBe('watchlist');
  });

  it('allumé : tables …_v2 et dernier accord à part, jamais celui des anciennes tables', () => {
    expect(cloudTable('playback', true)).toBe('user_playback_progress_v2');
    expect(cloudTable('hidden', true)).toBe('user_hidden_categories_v2');
    expect(baselineScopeFor('playback', true)).toBe('playback_v2');
    expect(baselineScopeFor('playback', true)).not.toBe(baselineScopeFor('playback', false));
  });

  it('effacer un type efface ses deux derniers accords, et « tout effacer » les couvre tous', () => {
    expect(bothBaselineScopes('livetv')).toEqual(['livetv', 'livetv_v2']);
    for (const kind of ['playback', 'watchlist', 'livetv', 'hidden'] as const) {
      for (const scope of bothBaselineScopes(kind)) expect(ALL_SCOPES).toContain(scope);
    }
  });
});

describe('fournisseur d\'une ligne du cloud', () => {
  it('empreinte connue : gardée telle quelle, même si ce n\'est pas la première source', () => {
    expect(resolveRowProviderHash(B, A)).toBe(B);
  });

  it('ligne sans empreinte (ancienne version) : rattachée à la première source', () => {
    expect(resolveRowProviderHash('', A)).toBe(A);
    expect(resolveRowProviderHash(null, A)).toBe(A);
    expect(resolveRowProviderHash(undefined, A)).toBe(A);
  });

  it('sans première source connue, ou empreinte illisible : laissée de côté, jamais devinée', () => {
    expect(resolveRowProviderHash('', null)).toBeNull();
    expect(resolveRowProviderHash('', 'pas-une-empreinte')).toBeNull();
    expect(resolveRowProviderHash('ABC', A)).toBeNull();
    expect(resolveRowProviderHash(A.toUpperCase(), A)).toBeNull();
  });

  it('empreinte : 64 caractères hexadécimaux en minuscules seulement', () => {
    expect(isProviderHash(A)).toBe(true);
    expect(isProviderHash(A.slice(1))).toBe(false);
    expect(isProviderHash(42)).toBe(false);
  });
});

describe('clé d\'un élément d\'un fournisseur', () => {
  it('le même numéro chez deux fournisseurs donne deux clés', () => {
    expect(providerRowKey(A, 5)).not.toBe(providerRowKey(B, 5));
  });

  it('se relit en fournisseur et numéro, numéro texte compris (catégories, favoris)', () => {
    expect(parseProviderRowKey(providerRowKey(A, 5))).toEqual({ providerHash: A, id: '5' });
    expect(parseProviderRowKey(providerRowKey(B, 'favorite|12'))).toEqual({ providerHash: B, id: 'favorite|12' });
  });

  it('une ancienne clé sans fournisseur n\'est pas lue comme une clé par fournisseur', () => {
    expect(parseProviderRowKey('5')).toBeNull();
    expect(parseProviderRowKey('t:550:movie')).toBeNull();
    expect(parseProviderRowKey(`${A}|`)).toBeNull();
  });
});
