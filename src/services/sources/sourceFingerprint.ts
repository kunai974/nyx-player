/**
 * Empreinte et nom d'hôte d'une source.
 *
 * L'empreinte est le repère commun à tous les appareils d'un compte : le cloud range par elle ce
 * qui dépend des numéros d'un fournisseur (reprises, favoris, catégories masquées). L'identifiant
 * local d'une source, lui, ne quitte jamais l'appareil.
 * - Xtream : empreinte de l'adresse, exactement comme en 0.8.0 (`computeProviderHash`), pour que
 *   les données déjà dans le cloud restent rattachées. L'écriture déjà connue de l'adresse
 *   (`meta.lastProvider`) se passe en `knownSpelling`, retenue seulement si elle désigne le même
 *   serveur ; sinon l'adresse nettoyée.
 * - M3U : empreinte de « m3u: » + hôte (port compris s'il n'est pas celui par défaut), sans le
 *   chemin : beaucoup d'adresses y mettent identifiant, mot de passe ou jeton (`/get/<u>/<p>/`,
 *   `/playlist/<jeton>`), qui ne doivent pas partir au cloud, même hachés, et qui changent. Deux
 *   playlists du même serveur partagent l'empreinte : leurs numéros (numéro du fournisseur ou
 *   empreinte de l'adresse du flux) ne se chevauchent pas pour autant.
 */

import type { SourceSecret } from '../../types/iptvSource';
import { computeProviderHash } from '../preferencesService';
import { normalizeProviderHost, sameProviderHost } from '../../utils/providerHost';
import { m3uFingerprintInput, parseSourceAddress } from './sourceAddress';
import { isLocalM3uUrl, localM3uFileName } from './m3uLocalAddress';

export { m3uFingerprintInput };


export async function sourceProviderHash(secret: SourceSecret, knownSpelling?: string | null): Promise<string> {
  if (secret.kind === 'xtream') {
    // L'écriture connue ne vaut que pour le même serveur : une autre source n'hérite jamais de l'empreinte d'une autre
    const spelling = knownSpelling && sameProviderHost(knownSpelling, secret.host) ? knownSpelling : normalizeProviderHost(secret.host);
    return computeProviderHash(spelling);
  }
  // Adresse illisible (impossible à lire de toute façon) : jamais l'adresse brute, qui peut porter un jeton
  return computeProviderHash(m3uFingerprintInput(secret.url) ?? 'm3u:');
}

/**
 * Nom d'hôte seul, affichable et journalisable (ni identifiant, ni port, ni chemin, ni jeton). Pour un
 * fichier de l'appareil, son nom, choisi par l'utilisateur : affichable, jamais envoyé dans un journal distant.
 */
export function sourceHostLabel(secret: SourceSecret): string {
  // Fichier de l'appareil : son nom, pas le numéro de sa copie
  if (secret.kind === 'm3u' && isLocalM3uUrl(secret.url)) return localM3uFileName(secret.url);
  const parsed = parseSourceAddress(secret.kind === 'xtream' ? secret.host : secret.url);
  return parsed ? parsed.hostname.toLowerCase() : '';
}
