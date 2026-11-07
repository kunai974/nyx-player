/**
 * Connexion de la TV par QR code — contenu du paquet, une fois ouvert par la TV.
 *
 * Le paquet vient d'une page web : il est relu champ par champ (types et longueurs), et rien d'autre
 * n'est gardé. Les identifiants ne sont jamais journalisés.
 */

import type { ProviderFormInput } from '../../utils/providerForm';

export type TvLinkMode = 'account' | 'provider';

export interface TvLinkAccount {
  email: string;
  password: string;
}

export interface TvLinkPayload {
  account?: TvLinkAccount;
  provider?: ProviderFormInput;
}

const MAX_FIELD = 512;
const MAX_LINK = 4096;

function str(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length <= max ? value : null;
}

function readAccount(value: unknown): TvLinkAccount | null {
  if (!value || typeof value !== 'object') return null;
  const a = value as Record<string, unknown>;
  // Forme d'une adresse e-mail, sans espace : l'adresse s'affiche sur la TV pendant la connexion,
  // elle ne doit pas pouvoir y écrire une phrase (« Abonnement expiré, appelez le … »)
  const email = str(a.email, 254)?.trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  const password = str(a.password, MAX_FIELD);
  if (!email || !password) return null;
  return { email, password };
}

function readProvider(value: unknown): ProviderFormInput | null {
  if (!value || typeof value !== 'object') return null;
  const p = value as Record<string, unknown>;
  if (p.type === 'm3u') {
    const link = str(p.link, MAX_LINK)?.trim();
    return link ? { type: 'm3u', link } : null;
  }
  if (p.type === 'xtream') {
    // Identifiant et mot de passe peuvent manquer (adresse complète collée) ; mal formés, refusés
    const host = str(p.host, MAX_FIELD)?.trim();
    const username = p.username === undefined ? '' : str(p.username, MAX_FIELD)?.trim();
    const password = p.password === undefined ? '' : str(p.password, MAX_FIELD);
    if (!host || username === null || username === undefined || password === null) return null;
    return { type: 'xtream', host, username, password };
  }
  return null;
}

/**
 * Relit le texte ouvert. Écran du compte : le compte est obligatoire, le fournisseur facultatif.
 * Écran du fournisseur : seul le fournisseur compte (un compte envoyé en trop est ignoré).
 */
export function parseTvLinkPayload(text: string, mode: TvLinkMode): TvLinkPayload | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const provider = r.provider === undefined || r.provider === null ? undefined : readProvider(r.provider);
  if (provider === null) return null;
  if (mode === 'provider') return provider ? { provider } : null;
  const account = readAccount(r.account);
  if (!account) return null;
  return provider ? { account, provider } : { account };
}
