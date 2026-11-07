/**
 * Connexion de la TV par QR code — fournisseur reçu avant l'écran du fournisseur.
 *
 * Sur l'écran du compte, le téléphone peut envoyer le compte et le fournisseur d'un coup. La TV se
 * connecte au compte tout de suite ; le fournisseur attend ici, en mémoire seulement (jamais sur le
 * disque), que le profil soit choisi et que l'écran du fournisseur le reprenne. Il est oublié après
 * un usage, à la déconnexion, ou au bout de `PENDING_TTL_MS`.
 */

import type { ProviderFormInput } from '../../utils/providerForm';

const PENDING_TTL_MS = 15 * 60 * 1000;

let pending: { input: ProviderFormInput; at: number } | null = null;

export function setPendingTvLinkProvider(input: ProviderFormInput, now: number = Date.now()): void {
  pending = { input, at: now };
}

/**
 * Lit le fournisseur en attente sans l'oublier (initialisation d'un écran, que React peut appeler
 * deux fois) ; `takePendingTvLinkProvider` le consomme ensuite, une seule fois.
 */
export function peekPendingTvLinkProvider(now: number = Date.now()): ProviderFormInput | null {
  if (!pending || now - pending.at > PENDING_TTL_MS) return null;
  return pending.input;
}

/** Rend le fournisseur en attente une seule fois (puis l'oublie), ou null. */
export function takePendingTvLinkProvider(now: number = Date.now()): ProviderFormInput | null {
  const value = pending;
  pending = null;
  if (!value || now - value.at > PENDING_TTL_MS) return null;
  return value.input;
}

export function clearPendingTvLinkProvider(): void {
  pending = null;
}
