/**
 * Storage Service - Abstraction du stockage persistant
 *
 * Credentials chiffrés via le coffre du système (commandes nyx_secret_*, secret_vault.rs)
 * - Credentials: OS Keychain (Windows Credential Manager / macOS Keychain / Linux Secret Service)
 * - Catalog data: SQLite (App.tsx handles directly)
 * - clearAll(): clears credentials (keyring) + SQLite
 *
 * Phase 2 Multi-User : le keyring user est dynamique (`iptv_credentials_<uid>`).
 * `setKeyringUser(uid)` DOIT être appelé avant tout accès credentials.
 */

import type { XtreamCredentials } from '../types/iptv';
import { clearAllData as clearSQLiteData, hasContent } from './dbCore';
import { checkLocalDatabase } from './localDatabaseHealth';
import { invoke } from '@tauri-apps/api/core';
import { isAndroid } from '../utils/platform';
import { sanitizeIptvUrl } from '../utils/sanitizeUrl';
import { createLogger } from '../utils/logger';

const log = createLogger('StorageService');

// Android : pas de keyring OS → Android Keystore (AES-256-GCM, clé non exportable) via le plugin nyx-android
const ANDROID_SERVICE = 'nyxplayer';
const androidKey = (user: string) => `${ANDROID_SERVICE}::${user}`;

/** Attend que l'app soit visible à l'écran (appareil déverrouillé, app au premier plan). */
function waitUntilVisible(): Promise<void> {
  if (typeof document === 'undefined' || document.visibilityState === 'visible') return Promise.resolve();
  return new Promise((resolve) => {
    const onChange = () => {
      if (document.visibilityState !== 'visible') return;
      document.removeEventListener('visibilitychange', onChange);
      resolve();
    };
    document.addEventListener('visibilitychange', onChange);
  });
}

/**
 * Erreur du coffre citée dans un journal. Une erreur `JSON.parse` recopie le début du
 * texte illisible, c'est-à-dire des identifiants : elle n'est jamais citée telle quelle.
 */
export function describeVaultError(e: unknown): string {
  if (e instanceof SyntaxError) return 'identifiants enregistrés illisibles (JSON invalide)';
  const text = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return sanitizeIptvUrl(text).slice(0, 200);
}

// Ordinateur : coffre du système par les seules commandes nyx_secret_* (src-tauri/src/secret_vault.rs).
// Le service (« nyxplayer », ou « nyxplayer-audit » pour la version d'audit Windows) est fixé côté
// Rust et seuls les comptes de Nyx sont acceptés : la page n'atteint plus les autres identifiants.
async function getPassword(user: string): Promise<string | null> {
  if (!isAndroid()) return (await invoke<string | null>('nyx_secret_get', { user })) ?? null;
  const result = await invoke<{ value: string | null }>('plugin:nyx-android|secure_get', { key: androidKey(user) });
  return result?.value ?? null;
}

async function setPassword(user: string, value: string): Promise<void> {
  if (!isAndroid()) return invoke('nyx_secret_set', { user, value });
  await invoke('plugin:nyx-android|secure_set', { key: androidKey(user), value });
}

async function deletePassword(user: string): Promise<void> {
  if (!isAndroid()) return invoke('nyx_secret_delete', { user });
  await invoke('plugin:nyx-android|secure_delete', { key: androidKey(user) });
}

/**
 * Accès brut au coffre (ordinateur ou Android), pour les entrées des sources
 * (services/sources/sourceVault.ts). Côté ordinateur, Rust n'accepte que les comptes de Nyx.
 */
export const secretVault = {
  read: getPassword,
  write: setPassword,
  remove: deletePassword,
};

/** Compte du coffre : `iptv_credentials_<uid>` par utilisateur Supabase (dynamique). */
let keyringUser = 'iptv_credentials';

/**
 * Configure le keyring user pour l'utilisateur Supabase courant.
 * DOIT être appelé dans onAuthStateChange AVANT tout accès credentials.
 */
export function setKeyringUser(uid: string): void {
  keyringUser = `iptv_credentials_${uid}`;
}

/**
 * Identifiants gardés en mémoire pour la session : chaque lecture et chaque zap les
 * relisaient dans le coffre (déchiffrement Android Keystore), ce qui ralentissait le zap. Liés au
 * compte du coffre (keyringUser) ; remplacés à l'enregistrement, oubliés à la suppression.
 */
let cachedCredentials: { user: string; creds: XtreamCredentials } | null = null;
/** Incrémenté à chaque écriture ou suppression : une lecture commencée avant ne remplit pas le cache. */
let credentialsVersion = 0;

function forgetCachedCredentials(): void {
  cachedCredentials = null;
  credentialsVersion++;
}

/** Mémorise une lecture du coffre si rien n'a changé depuis son début (version et compte). */
function rememberCredentials(creds: XtreamCredentials | null, user: string, version: number): void {
  if (version !== credentialsVersion || user !== keyringUser) return;
  cachedCredentials = creds ? { user, creds } : null;
}

/**
 * Reset le keyring user au défaut (appelé au logout Supabase).
 */
export function resetKeyringUser(): void {
  keyringUser = 'iptv_credentials';
}

export const StorageService = {
  /**
   * Sauvegarde les credentials IPTV dans le keychain OS.
   * Les données sont sérialisées en JSON puis stockées comme "password".
   */
  async saveCredentials(creds: XtreamCredentials): Promise<void> {
    forgetCachedCredentials();
    const user = keyringUser;
    await setPassword(user, JSON.stringify(creds));
    forgetCachedCredentials();
    rememberCredentials(creds, user, credentialsVersion);
  },

  /**
   * Récupère les credentials IPTV depuis le keychain OS.
   * @returns Les credentials ou null si aucun n'est stocké.
   */
  async getCredentials(): Promise<XtreamCredentials | null> {
    if (cachedCredentials && cachedCredentials.user === keyringUser) return { ...cachedCredentials.creds };
    const user = keyringUser;
    const version = credentialsVersion;
    try {
      const raw = await getPassword(user);
      if (!raw) return null;
      const creds = JSON.parse(raw) as XtreamCredentials;
      rememberCredentials(creds, user, version);
      return creds;
    } catch (e) {
      // Clé inexistante ou erreur de parsing
      log.error('getCredentials: EXCEPTION caught:', describeVaultError(e));
      return null;
    }
  },

  /**
   * Lecture des identifiants au démarrage. Sur Android, une
   * ERREUR du coffre (Keystore momentanément indisponible, appareil verrouillé) n'est plus prise pour
   * « aucun identifiant » : on attend que l'app soit visible (appareil déverrouillé) et on réessaie,
   * 3 fois au plus. Le coffre Android répond `null` quand il n'y a vraiment rien : pas d'attente alors.
   * Ailleurs (Windows : le coffre signale l'absence par une erreur), comportement inchangé.
   */
  async getCredentialsAtStartup(): Promise<XtreamCredentials | null> {
    if (!isAndroid()) return this.getCredentials();
    for (let attempt = 1; ; attempt++) {
      const user = keyringUser;
      const version = credentialsVersion;
      try {
        const raw = await getPassword(user);
        const creds = raw ? (JSON.parse(raw) as XtreamCredentials) : null;
        rememberCredentials(creds, user, version);
        return creds;
      } catch (e) {
        log.warn(`Coffre indisponible au démarrage (essai ${attempt}/3) :`, describeVaultError(e));
        if (attempt >= 3) return null;
        await waitUntilVisible();
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  },

  /**
   * Supprime les credentials IPTV du keychain OS.
   */
  async clearCredentials(): Promise<void> {
    forgetCachedCredentials();
    try {
      await deletePassword(keyringUser);
    } catch {
      // Clé déjà inexistante — silencieux
    }
  },

  /**
   * Vérifie si des données existent dans SQLite (rapide). Lu au démarrage pour reprendre la session :
   * une erreur passagère de la base (occupée par un travail de fond) n'est plus prise pour « aucune
   * source », ce qui ouvrait le formulaire du fournisseur vide ; nouvel essai, 3 au plus.
   */
  async hasData(): Promise<boolean> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await hasContent();
      } catch (e) {
        log.warn(`Base indisponible au démarrage (essai ${attempt}/3) :`, describeVaultError(e));
        if (attempt >= 3) {
          // Base peut-être abîmée : contrôlée, l'écran du fournisseur propose alors de la réinitialiser
          void checkLocalDatabase();
          return false;
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  },

  /**
   * Supprime toutes les données (logout complet).
   * - Credentials: supprimés du keychain OS
   * - SQLite: toutes les tables vidées
   */
  async clearAll(): Promise<void> {
    await this.clearCredentials();
    await clearSQLiteData();
  },
};
