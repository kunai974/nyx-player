/**
 * Fichier catalogue d'une source : `nyxcat_<espace>_<source>.db`, à côté de la base du compte.
 *
 * Il garde le catalogue brut du fournisseur (films, séries, chaînes, catégories, guide), écrit par
 * le chargement et l'actualisation natifs ; les données perso restent dans la base du compte. Une
 * source se supprime donc en effaçant son fichier, sans toucher aux autres sources.
 *
 * Le nom est vérifié ici et, de nouveau, côté Rust (storage.rs) : seul ce motif exact est accepté.
 */

import { invoke } from '@tauri-apps/api/core';
import { isValidSourceId, isValidSpaceId } from './sourceVault';

/** Nom du fichier catalogue d'une source ; null si l'espace ou la source n'a pas la bonne forme */
export function sourceCatalogFileName(spaceId: string, sourceId: string): string | null {
  if (!isValidSpaceId(spaceId) || !isValidSourceId(sourceId)) return null;
  return `nyxcat_${spaceId}_${sourceId}.db`;
}

/**
 * Efface le fichier d'une source (avec son journal). Un fichier encore tenu (Windows) est effacé au
 * lancement suivant, et ne peut plus être rempli d'ici là : l'erreur remonte quand même, pour le dire.
 */
export async function deleteSourceCatalog(spaceId: string, sourceId: string): Promise<void> {
  const dbName = sourceCatalogFileName(spaceId, sourceId);
  if (!dbName) throw new Error('invalid_source_catalog');
  await invoke('delete_source_catalog', { dbName });
}
