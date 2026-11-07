/**
 * Connexion de la TV par QR code — vérification du fournisseur reçu, avant de répondre au téléphone.
 *
 * Le fournisseur est essayé tout de suite auprès de son serveur (une seule demande, celle de la
 * connexion habituelle) : un mot de passe faux s'affiche alors sur le téléphone, où on le corrige et
 * renvoie, au lieu d'apparaître plus tard sur la TV, une fois le téléphone rangé.
 *
 * Une liste M3U sans identifiants n'est pas téléchargée ici (elle peut peser des dizaines de Mo) :
 * seule sa forme est contrôlée, et un échec éventuel s'affiche sur la TV pendant le chargement.
 *
 * Un serveur du réseau local (adresse privée, `localhost`, nom en `.local`…) n'est pas essayé non
 * plus : quiconque voit le QR code pourrait sinon se servir des réponses de la TV (« refusé » ou
 * « injoignable ») pour sonder les appareils de la maison. Un vrai serveur local (relais IPTV
 * maison) marche toujours ; ses erreurs s'affichent sur la TV. Les autres adresses sont essayées
 * en « public seulement » : un nom qui se résout vers la maison, ou une redirection vers elle, est
 * refusé par l'application elle-même et répond comme un serveur injoignable.
 */

import type { XtreamCredentials } from '../../types/iptv';
import { providerFormToCredentials, type ProviderFormInput } from '../../utils/providerForm';
import { isM3uListCredentials } from '../sources/m3uListCredentials';
import type { TvLinkFailure } from './tvLinkSession';

export type TvLinkProviderCheck =
  | { ok: true; creds: XtreamCredentials; typedHost: string }
  | { ok: false; reason: TvLinkFailure };

export async function checkTvLinkProvider(
  input: ProviderFormInput,
  authenticate?: (creds: XtreamCredentials) => Promise<unknown>,
): Promise<TvLinkProviderCheck> {
  // Client Xtream chargé à l'usage seulement : l'écran du fournisseur ne tire pas ses dépendances (textes traduits) à l'import
  const { XtreamApiService, isCredentialsRejectedError, isProviderAccountInactiveError } = await import('../xtreamApi');
  const tryProvider = authenticate ?? ((creds: XtreamCredentials) => new XtreamApiService(creds, { publicOnly: true }).authenticate());
  const result = providerFormToCredentials(input);
  if ('errorKey' in result) return { ok: false, reason: 'provider-format' };
  if (isM3uListCredentials(result.creds) || isLocalNetworkHost(result.creds.host)) {
    return { ok: true, creds: result.creds, typedHost: result.typedHost };
  }
  try {
    await tryProvider(result.creds);
  } catch (error) {
    if (isCredentialsRejectedError(error)) return { ok: false, reason: 'provider' };
    if (isProviderAccountInactiveError(error)) return { ok: false, reason: 'provider-inactive' };
    // Serveur en panne, injoignable, certificat refusé, page web au lieu des informations du compte
    return { ok: false, reason: 'provider-unreachable' };
  }
  return { ok: true, creds: result.creds, typedHost: result.typedHost };
}

/** Vrai pour une adresse du réseau local ou de l'appareil lui-même (IPv4, IPv6 ou nom local). */
export function isLocalNetworkHost(address: string): boolean {
  let host: string;
  try {
    // Point final retiré : « nas.local. » est le même nom que « nas.local »
    host = new URL(address).hostname.toLowerCase().replace(/\.+$/, '');
  } catch {
    return false;
  }
  if (host.startsWith('[')) {
    const v6 = host.slice(1, -1);
    // Bouclage, non spécifiée, locale unique (fc00::/7), lien local (fe80::/10), site local
    // (fec0::/10), multidiffusion, IPv4 encapsulée (::ffff:…), compatible (::a.b.c.d) ou NAT64
    return v6 === '::1' || v6 === '::' || /^f[cd]/.test(v6) || /^fe[89a-f]/.test(v6) || v6.startsWith('ff')
      || v6.startsWith('::ffff:') || /^::[0-9a-f]{1,4}(:[0-9a-f]{1,4})?$/.test(v6) || v6.startsWith('64:ff9b:');
  }
  const v4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b, c] = [Number(v4[1]), Number(v4[2]), Number(v4[3])];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 192 && b === 0 && c === 0)
      || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  // Nom sans point (« box »), localhost, et suffixes réservés aux réseaux privés
  return !host.includes('.') || host === 'localhost' || /\.(local|localhost|lan|home|internal|home\.arpa)$/.test(host);
}
