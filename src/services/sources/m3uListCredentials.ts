/**
 * Liste M3U utilisée comme source de la session (une source à la fois, en attendant l'affichage de
 * plusieurs sources ensemble).
 *
 * La session range sa source dans `XtreamCredentials` (coffre, connexion, reprise, actualisation).
 * Une liste M3U y est rangée ainsi :
 * - `m3u` : l'adresse complète de la liste (souvent avec un jeton), jamais journalisée ;
 * - `host` : « m3u: » + hôte (port compris s'il n'est pas celui par défaut), le même texte que
 *   l'empreinte d'une source M3U (sourceAddress.ts). Ce n'est pas une adresse : la détection
 *   d'un changement de fournisseur et l'empreinte du cloud la comparent telle quelle ;
 * - `username` et `password` vides.
 */

import type { XtreamCredentials } from '../../types/iptv';
import type { M3uSourceSecret } from '../../types/iptvSource';
import { m3uFingerprintInput } from './sourceAddress';
import { MAX_DESKTOP_ENTRY_LENGTH } from './sourceSecret';
import { validateM3uSourceInput } from './m3uSourceInput';
import { readM3uParam } from '../../utils/xtreamCredentials';
import { normalizeProviderHost } from '../../utils/providerHost';
import { isAndroid } from '../../utils/platform';

/** Source de session qui est une liste M3U (adresse de la liste présente) */
export type M3uListCredentials = XtreamCredentials & { m3u: { url: string; epgUrl?: string } };

export function isM3uListCredentials(creds: XtreamCredentials | null | undefined): creds is M3uListCredentials {
  return !!creds && typeof creds.m3u?.url === 'string' && creds.m3u.url !== '';
}

/** Identifiants de session d'une liste M3U déjà validée (null si l'adresse est illisible) */
export function m3uListCredentials(secret: M3uSourceSecret): M3uListCredentials | null {
  const host = m3uFingerprintInput(secret.url);
  if (!host) return null;
  return {
    host,
    username: '',
    password: '',
    m3u: { url: secret.url, ...(secret.epgUrl ? { epgUrl: secret.epgUrl } : {}) },
  };
}

export type M3uLinkError = 'invalid' | 'missing_info' | 'too_long';

/**
 * Lien collé dans l'onglet « M3U » (connexion ou Paramètres).
 * - Lien Xtream (`get.php?username=…&password=…`) : identifiants Xtream, comme avant ; l'API
 *   Xtream donne plus (compte, séries, rattrapage) que la liste.
 * - Lien avec un seul des deux identifiants, adresse d'un serveur seule (sans chemin ni paramètre) ou page
 *   Xtream (`get.php`, `player_api.php`) sans identifiants : sans doute un lien Xtream mal copié
 *   (`missing_info`). Le prendre pour une liste ouvrirait un changement de fournisseur pour rien.
 * - Toute autre liste M3U (sans identifiants) : la liste elle-même.
 */
export function credentialsFromM3uLink(link: string): { creds: XtreamCredentials } | { error: M3uLinkError } {
  const trimmed = link.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { error: 'invalid' };
  }
  // « + » gardé tel quel dans les identifiants
  const username = readM3uParam(url, 'username');
  const password = readM3uParam(url, 'password');
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { error: 'invalid' };
  if (username && password) {
    const host = normalizeProviderHost(`${url.protocol}//${url.host}`);
    if (!host) return { error: 'invalid' };
    return { creds: { host, username, password } };
  }
  if (username || password || (url.pathname === '/' && !url.search) || /\/(get|player_api)\.php$/i.test(url.pathname)) {
    return { error: 'missing_info' };
  }
  const checked = validateM3uSourceInput({ url: trimmed });
  if ('error' in checked) return { error: checked.error === 'too_long' ? 'too_long' : 'invalid' };
  const creds = m3uListCredentials(checked.secret);
  if (!creds) return { error: 'invalid' };
  // Le coffre de l'ordinateur range ces identifiants en une seule entrée, plafonnée (pas Android)
  if (!isAndroid() && JSON.stringify(creds).length > MAX_DESKTOP_ENTRY_LENGTH) return { error: 'too_long' };
  return { creds };
}
