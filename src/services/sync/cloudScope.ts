/**
 * Tables du cloud par fournisseur (plusieurs sources), pas encore allumées.
 *
 * Aujourd'hui l'appli range reprises, Ma liste, favoris TV et catégories masquées dans les tables
 * d'une seule source (`user_playback_progress`…), toutes les lignes portant l'empreinte du
 * fournisseur courant. Avec plusieurs sources, chaque ligne appartient à un fournisseur : les
 * tables `…_v2` ont l'empreinte dans leur clé, et deux fournisseurs peuvent avoir le même numéro
 * sans se gêner. Ces tables n'existent dans le cloud qu'une fois l'étape correspondante jouée sur
 * Supabase : d'ici là, l'appli garde les anciennes tables (interrupteur éteint).
 *
 * Empreinte d'une ligne du cloud :
 * - 64 caractères hexadécimaux : un fournisseur connu, gardé tel quel ;
 * - vide (ou absente) : écrite par une ancienne version sans empreinte, rattachée à la première
 *   source de l'appareil ;
 * - autre chose : illisible, la ligne est laissée de côté (jamais rattachée à un fournisseur au
 *   hasard, jamais supprimée).
 */

import type { BaselineScope } from './syncBaseline';

/**
 * Interrupteur des tables par fournisseur. Allumé dans la version qui met en route plusieurs
 * sources, une fois les tables créées dans le cloud ; jamais avant (les envois échoueraient).
 */
export const PROVIDER_TABLES_ENABLED = false;

/** État de l'interrupteur, lu à chaque synchro et à chaque envoi */
export function providerTablesOn(): boolean {
  return PROVIDER_TABLES_ENABLED;
}

/** Types de données synchronisés par fournisseur */
export type CloudDataKind = 'playback' | 'watchlist' | 'livetv' | 'hidden';

const SINGLE_SOURCE_TABLES: Record<CloudDataKind, string> = {
  playback: 'user_playback_progress',
  watchlist: 'user_watchlist',
  livetv: 'user_livetv_bookmarks',
  hidden: 'user_hidden_categories',
};

/** Table du cloud d'un type de données, selon l'interrupteur */
export function cloudTable(kind: CloudDataKind, providerTables: boolean): string {
  const table = SINGLE_SOURCE_TABLES[kind];
  return providerTables ? `${table}_v2` : table;
}

/**
 * Dernier accord avec le cloud d'un type de données, selon l'interrupteur. Les tables par
 * fournisseur ont leur propre dernier accord : celui des anciennes tables, aux clés sans
 * fournisseur, ferait prendre chaque ligne pour un retrait à la première synchro.
 */
export function baselineScopeFor(kind: CloudDataKind, providerTables: boolean): BaselineScope {
  return providerTables ? `${kind}_v2` : kind;
}

/** Les deux derniers accords d'un type (anciennes tables et tables par fournisseur), à effacer ensemble */
export function bothBaselineScopes(kind: CloudDataKind): BaselineScope[] {
  return [kind, `${kind}_v2`];
}

/**
 * Derniers accords des données propres à un fournisseur (reprises, favoris TV, catégories
 * masquées), effacés ensemble quand ces données sont vidées
 */
export const PROVIDER_DATA_SCOPES: BaselineScope[] = [
  ...bothBaselineScopes('playback'), ...bothBaselineScopes('livetv'), ...bothBaselineScopes('hidden'),
];

const PROVIDER_HASH = /^[0-9a-f]{64}$/;

/** Empreinte d'un fournisseur connu (SHA-256 en hexadécimal minuscule) */
export function isProviderHash(value: unknown): value is string {
  return typeof value === 'string' && PROVIDER_HASH.test(value);
}

/**
 * Fournisseur d'une ligne du cloud (voir l'en-tête) : son empreinte, celle de la première source
 * pour une ligne sans empreinte, ou null pour une ligne à laisser de côté.
 */
export function resolveRowProviderHash(rowHash: string | null | undefined, sourceOneHash: string | null): string | null {
  if (isProviderHash(rowHash)) return rowHash;
  if (rowHash === null || rowHash === undefined || rowHash === '') return isProviderHash(sourceOneHash) ? sourceOneHash : null;
  return null;
}

/**
 * Clé d'un élément d'un fournisseur (dernier accord, comparaisons) : le même numéro chez deux
 * fournisseurs donne deux clés.
 */
export function providerRowKey(providerHash: string, id: string | number): string {
  return `${providerHash}|${id}`;
}

/** Fournisseur et numéro d'une clé de providerRowKey (null si elle n'en est pas une) */
export function parseProviderRowKey(key: string): { providerHash: string; id: string } | null {
  const separator = key.indexOf('|');
  if (separator !== 64) return null;
  const providerHash = key.slice(0, separator);
  const id = key.slice(separator + 1);
  if (!isProviderHash(providerHash) || id === '') return null;
  return { providerHash, id };
}
