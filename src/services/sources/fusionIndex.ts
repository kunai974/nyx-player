/**
 * Index commun aux sources d'un espace : `nyxidx_<espace>.db`, construit en natif
 * (src-tauri/src/fusion_index.rs) à partir des fichiers catalogue des sources.
 *
 * Un film, une série ou une chaîne proposé par plusieurs fournisseurs n'y a qu'une ligne, avec
 * toutes ses offres derrière. Ce ne sont que des données dérivées : on le reconstruit à volonté,
 * sans rien télécharger.
 *
 * Pas encore appelé par les écrans : il le sera quand ils liront le catalogue de chaque source.
 */

import { invoke } from '@tauri-apps/api/core';
import { sourceCatalogFileName } from './sourceCatalogFile';
import { isValidSpaceId } from './sourceVault';

/** Résultat de la construction, renvoyé par la commande native */
export interface FusionIndexReport {
  /** `built`, `stopped` (arrêt demandé, l'index précédent reste) ou `busy` (une autre tourne) */
  status: 'built' | 'stopped' | 'busy';
  titles: number;
  offers: number;
  channels: number;
  streams: number;
  categories: number;
  /** Sources dont le fichier manque encore : absentes de l'index */
  missingSources: string[];
  /** Sources dont le fichier est illisible (abîmé) : absentes de l'index */
  failedSources: string[];
}

/** Nom de l'index commun d'un espace ; null si l'espace n'a pas la bonne forme */
export function fusionIndexFileName(spaceId: string): string | null {
  return isValidSpaceId(spaceId) ? `nyxidx_${spaceId}.db` : null;
}

/**
 * (Re)construit l'index de l'espace. `sourceIds` dans l'ordre de priorité : la première source qui
 * propose un titre lui donne son nom et son affiche.
 */
export async function buildFusionIndex(spaceId: string, sourceIds: readonly string[]): Promise<FusionIndexReport> {
  const indexDbName = fusionIndexFileName(spaceId);
  if (!indexDbName) throw new Error('invalid_space');
  const sources = sourceIds.map((id) => {
    const file = sourceCatalogFileName(spaceId, id);
    if (!file) throw new Error('invalid_source_catalog');
    return { id, file };
  });
  return invoke<FusionIndexReport>('build_fusion_index', { indexDbName, sources });
}

/** Arrête la construction en cours (lecture d'une vidéo) ; l'index précédent reste en place. */
export async function abortFusionIndex(): Promise<void> {
  await invoke('abort_fusion_index');
}
