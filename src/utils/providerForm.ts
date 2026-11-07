/**
 * Formulaire du fournisseur (Xtream ou lien M3U) → identifiants de session.
 *
 * Partagé par l'écran d'ajout du fournisseur (components/Login.tsx) et la connexion de la TV par
 * QR code (services/tvLink) : les mêmes saisies donnent les mêmes identifiants, quel que soit
 * l'appareil où on les a tapées.
 */

import type { XtreamCredentials } from '../types/iptv';
import { splitPastedXtreamAddress } from './xtreamCredentials';
import { credentialsFromM3uLink } from '../services/sources/m3uListCredentials';
import { normalizeProviderHost } from './providerHost';

export type ProviderFormInput =
  | { type: 'xtream'; host: string; username: string; password: string }
  | { type: 'm3u'; link: string };

export type ProviderFormErrorKey =
  | 'error_missing_fields'
  | 'error_m3u_too_long'
  | 'error_m3u_missing_info'
  | 'error_m3u_invalid';

export type ProviderFormResult =
  /** `typedHost` : adresse telle que saisie, à noter avec `noteTypedProviderHost` ('' pour un lien M3U). */
  | { creds: XtreamCredentials; typedHost: string }
  | { errorKey: ProviderFormErrorKey };

export function providerFormToCredentials(input: ProviderFormInput): ProviderFormResult {
  if (input.type === 'm3u') {
    // Lien Xtream (identifiants dans le lien) ou liste M3U
    const parsed = credentialsFromM3uLink(input.link);
    if ('error' in parsed) {
      return {
        errorKey: parsed.error === 'too_long' ? 'error_m3u_too_long'
          : parsed.error === 'missing_info' ? 'error_m3u_missing_info'
            : 'error_m3u_invalid',
      };
    }
    return { creds: parsed.creds, typedHost: '' };
  }

  // Adresse complète collée (`…/player_api.php?username=…`) : le serveur seul, et les identifiants
  // qu'elle contient pour les champs laissés vides
  const pasted = splitPastedXtreamAddress(input.host);
  const user = input.username || pasted.username;
  const pass = input.password || pasted.password;
  if (!pasted.host.trim() || !user || !pass) return { errorKey: 'error_missing_fields' };
  // Adresse nettoyée (espaces, « / » final, majuscules) : le même serveur écrit autrement n'est pas
  // pris pour un autre fournisseur
  return { creds: { host: normalizeProviderHost(pasted.host), username: user, password: pass }, typedHost: pasted.host };
}
