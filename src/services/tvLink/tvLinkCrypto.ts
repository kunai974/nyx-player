/**
 * Connexion de la TV par QR code — chiffrement de bout en bout (côté TV).
 *
 * La TV tire une paire de clés (ECDH P-256) ; la clé publique part dans le QR code, la clé privée ne
 * quitte jamais la mémoire de la TV (non exportable). La page du téléphone (`web/tv/tvlink-crypto.js`)
 * tire sa propre paire éphémère, calcule le même secret partagé et chiffre en AES-GCM 256.
 * Le transport (Supabase Realtime) ne voit qu'un paquet illisible.
 *
 * Paramètres communs aux deux côtés (à changer ensemble, avec `TV_LINK_VERSION`) :
 * - ECDH P-256, clé publique au format brut (65 octets), en base64url ;
 * - HKDF-SHA-256, sel = identifiant du canal (UTF-8), info = `nyx-tvlink-v1|a` (écran du compte) ou
 *   `nyx-tvlink-v1|p` (écran du fournisseur) : un paquet fermé pour un écran ne s'ouvre pas sur l'autre ;
 * - AES-GCM 256, IV de 12 octets tiré au hasard, données associées = identifiant du canal.
 */

export const TV_LINK_VERSION = 1;
const HKDF_INFO = 'nyx-tvlink-v1';

/** Écran de la TV : « a » compte, « p » fournisseur (aussi dans le lien du QR code). */
export type TvLinkModeLetter = 'a' | 'p';

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error('base64url invalide');
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Identifiant de canal : 16 octets au hasard (128 bits), en base64url (22 caractères). */
export function newChannelId(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
}

export interface TvLinkKeys {
  privateKey: CryptoKey;
  /** Clé publique brute en base64url, à mettre dans le QR code. */
  publicKey: string;
}

export async function generateTvKeys(): Promise<TvLinkKeys> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveKey', 'deriveBits']);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return { privateKey: pair.privateKey, publicKey: toBase64Url(raw) };
}

/** Paquet envoyé par le téléphone. */
export interface TvLinkEnvelope {
  v: number;
  /** Clé publique éphémère du téléphone (brute, base64url). */
  epk: string;
  iv: string;
  ct: string;
}

export function isTvLinkEnvelope(value: unknown): value is TvLinkEnvelope {
  if (!value || typeof value !== 'object') return false;
  const e = value as Record<string, unknown>;
  return e.v === TV_LINK_VERSION
    && typeof e.epk === 'string' && e.epk.length <= 128
    && typeof e.iv === 'string' && e.iv.length <= 32
    && typeof e.ct === 'string' && e.ct.length <= 64_000;
}

async function deriveAesKey(privateKey: CryptoKey, peerPublicRaw: Uint8Array, channelId: string, mode: TvLinkModeLetter): Promise<CryptoKey> {
  const peer = await crypto.subtle.importKey('raw', peerPublicRaw as BufferSource, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: peer }, privateKey, 256);
  const hkdfKey = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const enc = new TextEncoder();
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode(channelId), info: enc.encode(`${HKDF_INFO}|${mode}`) },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  );
}

/**
 * Ouvre le paquet du téléphone. Lève une erreur si le paquet n'a pas été fermé pour cette TV et ce
 * canal (clé ou canal différents, contenu modifié en route).
 */
export async function openEnvelope(
  privateKey: CryptoKey,
  channelId: string,
  mode: TvLinkModeLetter,
  envelope: TvLinkEnvelope,
): Promise<string> {
  const aes = await deriveAesKey(privateKey, fromBase64Url(envelope.epk), channelId, mode);
  const iv = fromBase64Url(envelope.iv);
  if (iv.length !== 12) throw new Error('IV invalide');
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as BufferSource, additionalData: new TextEncoder().encode(channelId) },
    aes,
    fromBase64Url(envelope.ct) as BufferSource,
  );
  return new TextDecoder().decode(plain);
}
