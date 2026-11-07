/**
 * Portée d'une synchro selon l'interrupteur des tables par fournisseur (sync/cloudScope.ts).
 *
 * Interrupteur éteint : table, dernier accord et clés d'aujourd'hui, sans changement.
 * Interrupteur allumé : la table `…_v2` du type, son propre dernier accord, et des clés
 * « fournisseur|élément ». Une synchro ne touche alors qu'aux lignes du fournisseur de cet appareil :
 * celles d'un autre fournisseur (une autre source, un autre appareil) ne sont ni copiées ici ni
 * retirées du cloud, et le dernier accord n'est comparé que sur ce fournisseur.
 *
 * Une ligne du cloud sans empreinte (ancienne version) appartient à la première source ; tant que
 * l'appareil n'a qu'une source, c'est la sienne. Son empreinte brute (vide) est gardée pour les
 * retraits : retirer avec l'empreinte résolue laisserait la ligne vide dans le cloud, et elle
 * reviendrait à la synchro suivante.
 */

import type { Baseline, BaselineScope } from './syncBaseline';
import {
  providerTablesOn, cloudTable, baselineScopeFor, providerRowKey, parseProviderRowKey, resolveRowProviderHash,
  isProviderHash, type CloudDataKind,
} from './cloudScope';
import { getDeviceProviderHash } from '../preferencesService';

export interface ProviderSyncScope {
  /** Tables par fournisseur */
  on: boolean;
  table: string;
  baselineScope: BaselineScope;
  /** Fournisseur de cet appareil (tables par fournisseur seulement) */
  deviceHash: string | null;
  /** Fournisseur à qui reviennent les lignes sans empreinte : la première source de l'appareil */
  sourceOneHash: string | null;
}

/**
 * Portée de la synchro de ce type. null quand les tables par fournisseur sont allumées et que le
 * fournisseur de l'appareil est inconnu : rien n'est alors synchronisé, plutôt que rangé chez un
 * fournisseur au hasard.
 */
export function providerSyncScope(kind: CloudDataKind, on: boolean = providerTablesOn()): ProviderSyncScope | null {
  if (!on) return { on, table: cloudTable(kind, false), baselineScope: baselineScopeFor(kind, false), deviceHash: null, sourceOneHash: null };
  const deviceHash = getDeviceProviderHash();
  if (!isProviderHash(deviceHash)) return null;
  // Une seule source par appareil pour l'instant : elle est la première
  return { on, table: cloudTable(kind, true), baselineScope: baselineScopeFor(kind, true), deviceHash, sourceOneHash: deviceHash };
}

/** Clé d'un élément de la base de l'appareil */
export function localKey(scope: ProviderSyncScope, itemKey: string): string {
  return scope.on ? providerRowKey(scope.deviceHash!, itemKey) : itemKey;
}

/** Clé d'une ligne du cloud, ou null pour une ligne d'un autre fournisseur ou illisible (laissée telle quelle) */
export function cloudKey(scope: ProviderSyncScope, rowHash: string | null | undefined, itemKey: string): string | null {
  if (!scope.on) return itemKey;
  const hash = resolveRowProviderHash(rowHash, scope.sourceOneHash);
  return hash !== null && hash === scope.deviceHash ? providerRowKey(hash, itemKey) : null;
}

/** Élément d'une clé de cette portée (null si elle appartient à un autre fournisseur) */
export function itemKeyOf(scope: ProviderSyncScope, key: string): string | null {
  if (!scope.on) return key;
  const parsed = parseProviderRowKey(key);
  return parsed && parsed.providerHash === scope.deviceHash ? parsed.id : null;
}

/** Dernier accord réduit au fournisseur de l'appareil : les autres fournisseurs n'y perdent rien */
export function baselineForScope(scope: ProviderSyncScope, baseline: Baseline): Baseline {
  if (!scope.on) return baseline;
  return new Map([...baseline].filter(([key]) => itemKeyOf(scope, key) !== null));
}

/**
 * Empreintes brutes sous lesquelles le cloud peut ranger un élément de cet appareil : la sienne, et
 * la valeur vide quand il est la première source. Pour retirer un élément sans laisser une copie
 * qui reviendrait.
 */
export function ownedRowHashes(scope: ProviderSyncScope): string[] {
  if (!scope.on || !scope.deviceHash) return [];
  return scope.deviceHash === scope.sourceOneHash ? [scope.deviceHash, ''] : [scope.deviceHash];
}
