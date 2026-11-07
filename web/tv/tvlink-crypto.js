// Connexion de la TV par QR code — chiffrement côté téléphone.
// Mêmes paramètres que l'app (src/services/tvLink/tvLinkCrypto.ts) : ECDH P-256, HKDF-SHA-256
// (sel = identifiant du canal, info = « nyx-tvlink-v1|a » écran du compte, « nyx-tvlink-v1|p » fournisseur), AES-GCM 256 (données associées = canal).
// Les identifiants sont fermés ici, dans le navigateur du téléphone, avec la clé publique de la TV :
// seule la TV peut les ouvrir.

export const TV_LINK_VERSION = 1;
const HKDF_INFO = 'nyx-tvlink-v1';

export function toBase64Url(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text) {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error('base64url invalide');
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Lit la partie après « # » du lien du QR code. Renvoie null si elle est incomplète ou invalide. */
export function parseTvLinkFragment(hash) {
  const params = new URLSearchParams(String(hash || '').replace(/^#/, ''));
  const v = Number(params.get('v'));
  const channel = params.get('c') || '';
  const key = params.get('k') || '';
  const mode = params.get('m') === 'p' ? 'provider' : params.get('m') === 'a' ? 'account' : null;
  if (v !== TV_LINK_VERSION || !mode) return null;
  if (!/^[A-Za-z0-9_-]{22}$/.test(channel)) return null;
  if (!/^[A-Za-z0-9_-]{87}$/.test(key)) return null; // 65 octets bruts
  return { channel, key, mode };
}

/** Ferme `plaintext` pour la TV dont la clé publique est `tvPublicKey` (base64url), pour son écran `mode`. */
export async function sealForTv(tvPublicKey, channel, mode, plaintext) {
  const letter = mode === 'account' ? 'a' : 'p';
  const subtle = globalThis.crypto.subtle;
  const tvKey = await subtle.importKey('raw', fromBase64Url(tvPublicKey), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const mine = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const shared = await subtle.deriveBits({ name: 'ECDH', public: tvKey }, mine.privateKey, 256);
  const hkdfKey = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const enc = new TextEncoder();
  const aes = await subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode(channel), info: enc.encode(HKDF_INFO + '|' + letter) },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  );
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(channel) }, aes, enc.encode(plaintext));
  const epk = new Uint8Array(await subtle.exportKey('raw', mine.publicKey));
  return { v: TV_LINK_VERSION, epk: toBase64Url(epk), iv: toBase64Url(iv), ct: toBase64Url(new Uint8Array(ct)) };
}
