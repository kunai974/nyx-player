/**
 * Première source d'un espace venu de la 0.8.0 : les identifiants deviennent la Source 1, et le
 * catalogue de la base du compte est recopié dans son fichier, sans rien retélécharger.
 *
 * Deux étapes, chacune rejouable : la reprise des identifiants retrouve la même source après une
 * coupure (sourceRegistry.ts), et la recopie native ne fait rien si le fichier de la source existe
 * déjà (src-tauri/src/catalog_split.rs). Relancer après une coupure à n'importe quel endroit
 * termine donc le travail, sans doublon.
 *
 * Pas encore appelé au démarrage : il le sera quand les écrans liront le catalogue de chaque
 * source, pour ne jamais garder deux copies d'un même catalogue qui divergent.
 */

import { invoke } from '@tauri-apps/api/core';
import type { XtreamCredentials } from '../../types/iptv';
import type { SourceSummary } from '../../types/iptvSource';
import { adoptLegacySource } from './sourceRegistry';
import { sourceCatalogFileName } from './sourceCatalogFile';
import { isValidSpaceId } from './sourceVault';

/** Lignes recopiées (ou déjà présentes si `alreadyDone`), renvoyées par la commande native */
export interface CatalogCopyReport {
  movies: number;
  series: number;
  live: number;
  categories: number;
  epgPrograms: number;
  alreadyDone: boolean;
}

export interface SourceOneResult {
  source: SourceSummary;
  copy: CatalogCopyReport;
}

/**
 * Prépare la Source 1. null si l'espace n'a rien à reprendre : il a déjà ses propres sources, ou
 * la personne a supprimé la source reprise depuis.
 */
export async function prepareSourceOne(
  spaceId: string,
  legacy: XtreamCredentials,
  options: { name?: string; knownSpelling?: string | null } = {},
): Promise<SourceOneResult | null> {
  if (!isValidSpaceId(spaceId)) throw new Error('invalid_space');
  const source = await adoptLegacySource(spaceId, legacy, options);
  if (!source) return null;
  const sourceDbName = sourceCatalogFileName(spaceId, source.id);
  if (!sourceDbName) throw new Error('invalid_source_catalog');
  const copy = await invoke<CatalogCopyReport>('copy_catalog_to_source', {
    accountDbName: `nyxplayer_${spaceId}.db`,
    sourceDbName,
  });
  return { source, copy };
}
