/**
 * Coffre des sources : une entrée par source, `iptv_source_<espace>_<source>` (espace = uuid d'un
 * compte ou d'un invité, services/localSpace.ts), qui garde la partie
 * secrète (types/iptvSource.ts).
 *
 * Une entrée par source et pas une liste dans une seule entrée : le Gestionnaire d'identifiants de
 * Windows refuse une entrée de plus de 2 560 octets (1 280 caractères UTF-16), et une adresse M3U
 * avec son jeton peut à elle seule en prendre une bonne partie.
 *
 * L'entrée de la 0.8.0 (`iptv_credentials_<espace>`, identifiants Xtream sans `kind`) se lit avec
 * le même décodage (`parseSourceSecret`) et n'est jamais modifiée ici : revenir à la 0.8.0 la
 * retrouve telle quelle.
 *
 * Aucun secret n'est jamais journalisé : une erreur de lecture est décrite par `describeVaultError`.
 */

import type { SourceSecret } from '../../types/iptvSource';
import { secretVault, describeVaultError } from '../storage';
import { isAndroid } from '../../utils/platform';
import { isValidSpaceId } from '../localSpace';
import { createLogger } from '../../utils/logger';
import { MAX_DESKTOP_ENTRY_LENGTH, SourceVaultError, parseSourceSecret, serializeSourceSecret } from './sourceSecret';

export { MAX_DESKTOP_ENTRY_LENGTH, SourceVaultError, parseSourceSecret, serializeSourceSecret };

const log = createLogger('SourceVault');

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const SOURCE_ID = new RegExp(`^${UUID}$`);

/** Espace : identifiant d'un compte ou d'un invité, un uuid en minuscules (localSpace.ts) */
export { isValidSpaceId };

export function isValidSourceId(sourceId: string): boolean {
  return SOURCE_ID.test(sourceId);
}

/** Nom de l'entrée du coffre d'une source (même forme que celle acceptée par Rust, secret_vault.rs) */
export function sourceVaultKey(spaceId: string, sourceId: string): string {
  if (!isValidSpaceId(spaceId) || !isValidSourceId(sourceId)) throw new SourceVaultError('invalid_id');
  return `iptv_source_${spaceId}_${sourceId}`;
}

export async function writeSourceSecret(spaceId: string, sourceId: string, secret: SourceSecret): Promise<void> {
  const key = sourceVaultKey(spaceId, sourceId);
  const value = serializeSourceSecret(secret);
  // Android (Keystore) n'a pas cette limite ; l'ordinateur refuserait l'entrée avec une erreur obscure
  if (!isAndroid() && value.length > MAX_DESKTOP_ENTRY_LENGTH) throw new SourceVaultError('too_long');
  await secretVault.write(key, value);
}

/** Partie secrète d'une source ; null si l'entrée est absente, illisible ou le coffre indisponible */
export async function readSourceSecret(spaceId: string, sourceId: string): Promise<SourceSecret | null> {
  const key = sourceVaultKey(spaceId, sourceId);
  try {
    const raw = await secretVault.read(key);
    if (!raw) return null;
    const secret = parseSourceSecret(raw);
    if (!secret) log.warn('Entrée de source illisible dans le coffre');
    return secret;
  } catch (e) {
    log.warn('Lecture du coffre impossible :', describeVaultError(e));
    return null;
  }
}

/**
 * Efface l'entrée. Une entrée déjà absente n'est pas une erreur (Rust et le Keystore la traitent
 * comme effacée) ; un coffre en panne, si : l'appelant garde alors la source, pour réessayer.
 */
export async function deleteSourceSecret(spaceId: string, sourceId: string): Promise<void> {
  await secretVault.remove(sourceVaultKey(spaceId, sourceId));
}
