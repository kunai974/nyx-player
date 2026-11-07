/**
 * Connexion de la TV par QR code — ce que la TV montre de ce qu'elle a reçu : l'e-mail du compte et le
 * nom du serveur seulement (jamais un mot de passe, un identifiant, le chemin ni le jeton d'une liste).
 */

import type { ProviderFormInput } from '../../utils/providerForm';
import { splitPastedXtreamAddress } from '../../utils/xtreamCredentials';
import { showAppNotice } from '../../utils/appNotice';

/** Durée du message « Connecté avec votre téléphone » : le temps de le lire de loin */
export const TV_LINK_NOTICE_MS = 10_000;

/**
 * Après une connexion par QR code, sans validation à la télécommande : la TV dit quelques secondes
 * avec quel compte et quel serveur elle s'est connectée. Un envoi qui ne vient pas de vous se voit.
 */
export function announceTvLinkConnection(received: { email?: string; provider?: ProviderFormInput }): void {
  const host = received.provider ? providerDisplayHost(received.provider) : undefined;
  if (received.email) {
    showAppNotice(host ? 'tvlink_connected_account_provider' : 'tvlink_connected_account', {
      values: host ? { email: received.email, host } : { email: received.email },
      ms: TV_LINK_NOTICE_MS,
    });
  } else if (host) {
    showAppNotice('tvlink_connected_provider', { values: { host }, ms: TV_LINK_NOTICE_MS });
  }
}

export function providerDisplayHost(input: ProviderFormInput): string {
  const raw = input.type === 'm3u' ? input.link : splitPastedXtreamAddress(input.host).host;
  const text = raw.trim();
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`).hostname || '?';
  } catch {
    return '?';
  }
}
