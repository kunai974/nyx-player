/**
 * Connexion de la TV par QR code — lien mis dans le QR code.
 *
 * Tout ce qui est propre à cette TV (canal, clé publique, écran) est après « # » : un navigateur
 * n'envoie jamais cette partie au site, la page du téléphone la lit sur place (web/tv).
 */

import { TV_LINK_VERSION } from './tvLinkCrypto';
import type { TvLinkMode } from './tvLinkPayload';

/** Page du site ouverte par le QR code. */
export const TV_LINK_PAGE = 'https://nyxplayer.app/tv/';

export function tvLinkUrl(channelId: string, publicKey: string, mode: TvLinkMode): string {
  return `${TV_LINK_PAGE}#v=${TV_LINK_VERSION}&c=${channelId}&k=${publicKey}&m=${mode === 'account' ? 'a' : 'p'}`;
}
