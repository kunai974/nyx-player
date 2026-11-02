/**
 * networkService.ts — Réseau IPTV
 *
 * Responsabilités :
 * - iptvFetch : requête réseau via le backend Rust (Tauri invoke), avec le DNS sécurisé choisi
 *   dans les réglages (la lecture vidéo, elle, passe par le DNS de l'appareil)
 */

import { invoke } from '@tauri-apps/api/core';
import { getDnsProvider } from './preferencesService';

// ============================================================================
// IPTV FETCH
// ============================================================================

/**
 * Exécute une requête HTTP via le backend Rust (bypass CORS).
 */
export const iptvFetch = (url: string) =>
  invoke<string>('iptv_fetch', { url, dnsProvider: getDnsProvider() });

/** Début de l'erreur rendue par `iptv_fetch` quand le serveur du fournisseur répond 5xx (Rust, `ingestion.rs`). */
const PROVIDER_SERVER_ERROR = 'provider_server_error';
/** Début de l'erreur rendue par `iptv_fetch` quand le serveur est injoignable : délai dépassé,
 *  adresse introuvable (DNS), connexion refusée (Rust, `ingestion.rs`). */
const PROVIDER_UNREACHABLE = 'provider_unreachable';

/**
 * Vrai si l'erreur vient du serveur du fournisseur, en panne (5xx) ou injoignable (délai,
 * DNS, connexion refusée) : la
 * page affiche « le serveur ne répond pas » au lieu de « vérifiez vos identifiants ».
 */
export function isProviderServerError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith(PROVIDER_SERVER_ERROR) || message.startsWith(PROVIDER_UNREACHABLE);
}

/**
 * Vrai seulement pour une réponse 5xx du fournisseur (le serveur a répondu), pas pour un serveur
 * injoignable ni pour un 429 : « trop de demandes » ne dit rien des identifiants, et une demande de
 * plus irait contre la consigne du serveur de ralentir.
 */
export function isProviderHttpServerError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith(PROVIDER_SERVER_ERROR) && !/\bHTTP 429\b/.test(message);
}

/** Début de l'erreur rendue par `iptv_fetch` quand le certificat https du fournisseur est refusé (Rust, `ingestion.rs`). */
const PROVIDER_CERTIFICATE_ERROR = 'provider_certificate_error';

/**
 * Vrai si le certificat https du fournisseur a été refusé (expiré, signé par lui-même, autre nom) :
 * la page le dit au lieu de « le serveur ne répond pas ». La vérification n'est jamais désactivée.
 */
export function isProviderCertificateError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith(PROVIDER_CERTIFICATE_ERROR);
}
