/**
 * Partie secrète d'une source (types/iptvSource.ts) : décodage, écriture et taille maximale d'une
 * entrée du coffre. Sans dépendance, pour que les écrans de saisie la vérifient sans charger le
 * coffre ; le coffre lui-même est sourceVault.ts.
 */

import type { SourceSecret } from '../../types/iptvSource';

/** Taille maximale d'une entrée du coffre Windows, en caractères UTF-16 (2 560 octets) */
export const MAX_DESKTOP_ENTRY_LENGTH = 1280;

/** Erreur d'écriture d'une source, avec un code que l'écran traduit */
export class SourceVaultError extends Error {
  constructor(readonly code: 'invalid_id' | 'invalid_secret' | 'too_long') {
    super(`source_vault_${code}`);
    this.name = 'SourceVaultError';
  }
}

const isText = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';
const optionalText = (value: unknown): string | undefined => (isText(value) ? value : undefined);

/**
 * Partie secrète lue dans le coffre. Une entrée sans `kind` (0.8.0 et avant) est une source Xtream.
 * null si l'entrée est illisible ou incomplète : jamais d'objet à moitié rempli.
 */
export function parseSourceSecret(raw: string): SourceSecret | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const entry = value as Record<string, unknown>;
  const kind = entry.kind ?? 'xtream';
  const epgUrl = optionalText(entry.epgUrl);
  if (kind === 'xtream') {
    if (!isText(entry.host) || !isText(entry.username) || !isText(entry.password)) return null;
    return { kind: 'xtream', host: entry.host, username: entry.username, password: entry.password, ...(epgUrl ? { epgUrl } : {}) };
  }
  if (kind === 'm3u') {
    if (!isText(entry.url)) return null;
    return { kind: 'm3u', url: entry.url, ...(epgUrl ? { epgUrl } : {}) };
  }
  return null;
}

/** Texte écrit dans le coffre : seulement les champs connus, dans un ordre fixe */
export function serializeSourceSecret(secret: SourceSecret): string {
  const checked = parseSourceSecret(JSON.stringify(secret));
  if (!checked) throw new SourceVaultError('invalid_secret');
  return JSON.stringify(checked);
}
