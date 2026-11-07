/**
 * Lecture d'une adresse de source, sans dépendance (utilisable par les écrans de connexion sans
 * charger les services) : sert à l'empreinte d'une source (sourceFingerprint.ts) et au rangement
 * d'une liste M3U dans la source de la session.
 */

import { isLocalM3uUrl, localM3uFingerprintInput } from './m3uLocalAddress';

/** Adresse lue (« http:// » ajouté s'il manque), ou null si elle n'a pas d'hôte */
export function parseSourceAddress(address: string): URL | null {
  const trimmed = address.trim();
  if (!trimmed) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    const url = new URL(withScheme);
    return url.hostname ? url : null;
  } catch {
    return null;
  }
}

/** Texte dont l'empreinte est prise pour une playlist M3U (null si l'adresse est illisible) */
export function m3uFingerprintInput(url: string): string | null {
  // Fichier de l'appareil : son nom, pour qu'il soit le même fournisseur d'un appareil à l'autre
  if (isLocalM3uUrl(url)) return localM3uFingerprintInput(url);
  const parsed = parseSourceAddress(url);
  if (!parsed) return null;
  // `host` = nom + port s'il n'est pas celui par défaut ; jamais l'identifiant, le chemin ni les paramètres
  return `m3u:${parsed.host.toLowerCase()}`;
}
