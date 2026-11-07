/**
 * Preferences Service — SQLite-First avec Cache Mémoire
 * 
 * Remplace userPreferences.ts et carouselPreferences.ts (localStorage)
 * par une table SQLite user_preferences (key/value).
 * 
 * Architecture :
 * - Boot : initPreferences() charge TOUT depuis SQLite → cache mémoire
 * - Read : getPreference() lit depuis le cache (synchrone, O(1))
 * - Write : setPreference() écrit SQLite + met à jour le cache
 * - Event : dispatch 'preferencesUpdated' pour sync cross-composant
 * 

 */

import i18next from 'i18next';
import { getDatabase } from './dbCore';
import { pushPreferenceToCloud } from './syncService';
import { serverNow } from './sync/serverClock';
import { PREFERENCES_EVENT, CAROUSEL_PREFERENCES_EVENT } from './eventConstants';
import { DEFAULT_CAROUSELS } from './carouselConstants';
import { createLogger } from '../utils/logger';
import { providerTablesOn } from './sync/cloudScope';

const log = createLogger('Preferences');

// ============================================================================
// TYPES
// ============================================================================

/** Pages disponibles comme page d'accueil */
export type HomePageOption = 'dashboard' | 'live' | 'watchlist';

/** Fournisseur DNS sécurisé */
export type DnsProvider = 'system' | 'cloudflare' | 'quad9';

/** Structure des préférences utilisateur */
interface UserPreferences {
  homePage: HomePageOption;
  bingeMode: boolean;
  bingeCountdown: number;
  geekStatsEnabled: boolean;
  dnsProvider: DnsProvider;
}

/** Structure des préférences de carousels */
export interface CarouselPreferences {
  disabledCarousels: string[];
  enabledGenres: number[];
  filterExoticScripts: boolean;
}

// ============================================================================
// DEFAULTS
// ============================================================================

const DEFAULT_USER_PREFS: UserPreferences = {
  homePage: 'dashboard',
  bingeMode: false,
  bingeCountdown: 15,
  geekStatsEnabled: true,
  dnsProvider: 'cloudflare',
};

const DEFAULT_CAROUSEL_PREFS: CarouselPreferences = {
  disabledCarousels: [],
  enabledGenres: [28, 35], // Action, Comédie
  filterExoticScripts: true,
};

// ============================================================================
// MEMORY CACHE
// ============================================================================

/** Cache mémoire — toutes les préférences chargées au boot */
const cache = new Map<string, string>();

/** Flag d'initialisation */
let initialized = false;

/**
 * Empreinte du fournisseur de CET appareil (son adresse `meta.lastProvider`), lue à l'initialisation
 * et remplacée à chaque `setLastProviderHash`. La préférence `last_provider_hash`, elle, est
 * synchronisée : la synchro peut y mettre le fournisseur d'un autre appareil.
 */
let deviceProviderHash: string | null = null;

/** Change à chaque remise à zéro du cache : une initialisation commencée avant ne le remplit plus */
let cacheGeneration = 0;

/** Parse JSON avec fallback en cas de valeur null ou corrompue */
function safeJsonParse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    log.error('Corrupted JSON in SQLite, using default:', raw);
    return fallback;
  }
}

// ============================================================================
// CORE — INIT / GET / SET
// ============================================================================

/**
 * Charge toutes les préférences depuis SQLite dans le cache mémoire.
 * Doit être appelé au boot de l'app, AVANT tout accès aux préférences.
 */
export async function initPreferences(): Promise<void> {
  if (initialized) return;
  // Déconnexion (resetPreferencesCache) pendant l'initialisation : les préférences et le fournisseur
  // du compte précédent ne sont pas remis dans le cache du compte suivant
  const startedAt = cacheGeneration;
  const stale = () => cacheGeneration !== startedAt;

  const db = await getDatabase();

  // Charger TOUT depuis SQLite → cache
  try {
    const rows = await db.select<{ key: string; value: string }[]>(
      'SELECT key, value FROM user_preferences'
    );
    if (stale()) return;
    for (const row of rows) {
      cache.set(row.key, row.value);
    }
  } catch (error) {
    log.error('Failed to load from SQLite:', error);
  }

  try {
    const rows = await db.select<{ value: string }[]>(`SELECT value FROM meta WHERE key = 'lastProvider'`);
    const host = rows[0]?.value;
    const hash = host ? await sha256(host) : null;
    if (stale()) return;
    deviceProviderHash = hash;
  } catch (error) {
    log.warn('Fournisseur de l\'appareil illisible :', error);
    deviceProviderHash = null;
  }

  // Seed langue pour les nouveaux comptes : la langue affichée (choisie sur l'écran de connexion,
  // sinon celle du système), pas directement celle du système (« English » choisi avant de
  // créer le compte repassait en français).
  // updated_at = 0 (epoch) pour que le cloud LWW gagne toujours au premier sync.
  // Si aucune valeur cloud, ce seed sert de fallback par défaut.
  if (!getPreference('language')) {
    const shownLang = (i18next.resolvedLanguage || navigator.language).slice(0, 2); // "fr", "en", "de"...
    const supported = ['fr', 'en'];
    const lang = supported.includes(shownLang) ? shownLang : 'en'; // fallback EN
    await db.execute(
      `INSERT INTO user_preferences (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      ['language', lang, 0]
    );
    if (stale()) return;
    cache.set('language', lang);
  }

  if (stale()) return;
  initialized = true;
}

/**
 * Reset le cache mémoire des préférences.
 * Appelé au SIGNED_OUT pour éviter que le prochain user hérite des données en mémoire.
 */
export function resetPreferencesCache(): void {
  cache.clear();
  initialized = false;
  deviceProviderHash = null;
  cacheGeneration++;
  // Notifier les composants React qui écoutent cet event
  window.dispatchEvent(new CustomEvent(PREFERENCES_EVENT, { detail: { key: '*', value: null } }));
}

/**
 * Recharge le cache mémoire depuis SQLite.
 * Appelé après un sync Supabase pour que les getters synchrones
 * (getLanguage, getDashboardDefaultMode, etc.) retournent les valeurs pullées.
 */
export async function refreshPreferencesCache(): Promise<void> {
  try {
    const db = await getDatabase();
    const rows = await db.select<{ key: string; value: string }[]>(
      'SELECT key, value FROM user_preferences'
    );
    cache.clear();
    for (const row of rows) {
      cache.set(row.key, row.value);
    }
  } catch (error) {
    log.error('Failed to refresh cache:', error);
  }
}

/**
 * Lit une préférence depuis le cache mémoire (synchrone).
 */
function getPreference(key: string): string | null {
  return cache.get(key) ?? null;
}

/**
 * Écrit une préférence dans SQLite + cache mémoire.
 */
async function setPreference(key: string, value: string): Promise<void> {
  // Heure du serveur : la date sert à régler les conflits avec les autres appareils
  const now = serverNow();
  try {
    const db = await getDatabase();
    await db.execute(
      `INSERT INTO user_preferences (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, value, now]
    );
    cache.set(key, value);
  } catch (error) {
    log.error(`Failed to save "${key}":`, error);
    return;
  }

  // Notifier les autres composants
  window.dispatchEvent(new CustomEvent(PREFERENCES_EVENT, { detail: { key, value } }));

  // Fire-and-forget upsert vers Supabase, à la même date qu'en local
  pushPreferenceToCloud(key, value, now);
}


// ============================================================================
// USER PREFERENCES API (rétrocompatible)
// ============================================================================

// Helpers individuels
export function getHomePage(): HomePageOption {
  return (getPreference('home_page') as HomePageOption) ?? DEFAULT_USER_PREFS.homePage;
}

export async function setHomePage(page: HomePageOption): Promise<void> {
  await setPreference('home_page', page);
}

export function isBingeModeEnabled(): boolean {
  return getPreference('binge_mode') === 'true';
}

export async function setBingeMode(enabled: boolean): Promise<void> {
  await setPreference('binge_mode', String(enabled));
}

export function getBingeCountdown(): number {
  return Number(getPreference('binge_countdown')) || DEFAULT_USER_PREFS.bingeCountdown;
}

export async function setBingeCountdown(seconds: number): Promise<void> {
  await setPreference('binge_countdown', String(seconds));
}

export function isGeekStatsEnabled(): boolean {
  return getPreference('geek_stats_enabled') !== 'false';
}

export async function setGeekStats(enabled: boolean): Promise<void> {
  await setPreference('geek_stats_enabled', String(enabled));
}

/**
 * Recherche des fiches TMDB par le titre pour les films et séries d'une liste M3U (qui ne donne pas
 * de numéro TMDB). Active par défaut ; coupée, les fiches gardent les images de la liste.
 */
export function isTmdbTitleSearchEnabled(): boolean {
  return getPreference('tmdb_title_search') !== 'false';
}

export async function setTmdbTitleSearch(enabled: boolean): Promise<void> {
  await setPreference('tmdb_title_search', String(enabled));
}

export function getDnsProvider(): DnsProvider {
  return (getPreference('dns_provider') as DnsProvider) ?? DEFAULT_USER_PREFS.dnsProvider;
}

export async function setDnsProvider(provider: DnsProvider): Promise<void> {
  await setPreference('dns_provider', provider);
}

export function getLanguage(): string {
  return getPreference('language') ?? 'en';
}

export async function setLanguage(lang: string): Promise<void> {
  await setPreference('language', lang);
}

// ============================================================================
// CAROUSEL PREFERENCES API (rétrocompatible)
// ============================================================================

export function getCarouselPreferences(): CarouselPreferences {
  const disabledRaw = getPreference('disabled_carousels');
  const genresRaw = getPreference('enabled_genres');
  const exoticRaw = getPreference('filter_exotic_scripts');

  return {
    disabledCarousels: safeJsonParse(disabledRaw, [...DEFAULT_CAROUSEL_PREFS.disabledCarousels]),
    enabledGenres: safeJsonParse(genresRaw, [...DEFAULT_CAROUSEL_PREFS.enabledGenres]),
    filterExoticScripts: exoticRaw !== null ? exoticRaw === 'true' : DEFAULT_CAROUSEL_PREFS.filterExoticScripts,
  };
}

async function setCarouselPreferences(prefs: CarouselPreferences): Promise<void> {
  await setPreference('disabled_carousels', JSON.stringify(prefs.disabledCarousels));
  await setPreference('enabled_genres', JSON.stringify(prefs.enabledGenres));
  await setPreference('filter_exotic_scripts', String(prefs.filterExoticScripts));

  // Dispatch pour sync cross-composant
  window.dispatchEvent(new CustomEvent(CAROUSEL_PREFERENCES_EVENT));
}

export function isCarouselEnabled(id: string): boolean {
  const prefs = getCarouselPreferences();
  return !prefs.disabledCarousels.includes(id);
}

export function isGenreEnabled(genreId: number): boolean {
  const prefs = getCarouselPreferences();
  return prefs.enabledGenres.includes(genreId);
}

export async function toggleCarousel(id: string): Promise<void> {
  const carousel = DEFAULT_CAROUSELS.find((c) => c.id === id);
  if (!carousel?.removable) return;

  const prefs = getCarouselPreferences();
  const index = prefs.disabledCarousels.indexOf(id);

  if (index === -1) {
    prefs.disabledCarousels.push(id);
  } else {
    prefs.disabledCarousels.splice(index, 1);
  }

  await setCarouselPreferences(prefs);
}

export async function toggleGenre(genreId: number): Promise<void> {
  const prefs = getCarouselPreferences();
  const index = prefs.enabledGenres.indexOf(genreId);

  if (index === -1) {
    prefs.enabledGenres.push(genreId);
  } else {
    prefs.enabledGenres.splice(index, 1);
  }

  await setCarouselPreferences(prefs);
}

export function getEnabledGenres(): number[] {
  return getCarouselPreferences().enabledGenres;
}

export function isExoticFilterEnabled(): boolean {
  return getCarouselPreferences().filterExoticScripts;
}

export async function setExoticFilter(enabled: boolean): Promise<void> {
  const prefs = getCarouselPreferences();
  prefs.filterExoticScripts = enabled;
  await setCarouselPreferences(prefs);
}

// ============================================================================
// DASHBOARD DEFAULT MODE
// ============================================================================

export type DashboardDefaultMode = 'suggestions' | 'films' | 'series';

export function getDashboardDefaultMode(): DashboardDefaultMode {
  return (getPreference('dashboard_default_mode') as DashboardDefaultMode) ?? 'suggestions';
}

export async function setDashboardDefaultMode(mode: DashboardDefaultMode): Promise<void> {
  await setPreference('dashboard_default_mode', mode);
}

// ============================================================================
// SUBTITLE SCALE
// ============================================================================

export function getSubtitleScale(): number {
  return Number(getPreference('subtitle_scale')) || 1;
}

export async function setSubtitleScale(scale: number): Promise<void> {
  await setPreference('subtitle_scale', String(scale));
}

// ============================================================================
// PROVIDER HASH — Phase 2: Cloud source of truth
// ============================================================================

/** SHA256 hash using Web Crypto API (native, no external lib) */
async function sha256(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Empreinte du fournisseur de cet appareil (synchrone), celle que Ma liste note sur ses titres et
 * envoie au cloud. Pas la préférence synchronisée seule : un autre appareil du compte, passé à un
 * autre fournisseur, la remplace à la synchro suivante. Elle ne sert que tant que
 * l'adresse de l'appareil est inconnue.
 */
export function getLastProviderHash(): string | null {
  return deviceProviderHash ?? getPreference('last_provider_hash');
}

/**
 * Empreinte du fournisseur de cet appareil seulement (son adresse notée), sans repli sur la
 * préférence synchronisée : null tant qu'elle est inconnue. Pour ranger une donnée chez un
 * fournisseur (tables du cloud par fournisseur, sync/cloudScope.ts), mieux vaut ne rien envoyer
 * que l'envoyer chez le fournisseur d'un autre appareil.
 */
export function getDeviceProviderHash(): string | null {
  return deviceProviderHash;
}

/**
 * Note le fournisseur de cet appareil (empreinte SHA-256 de son adresse).
 * Tables d'une seule source : aussi dans la préférence `last_provider_hash`, base locale et cloud.
 * Tables par fournisseur (sync/cloudScope.ts) : sur l'appareil seulement. Chaque appareil a alors
 * son fournisseur, et les appareils restés sur une ancienne version comparent cette préférence au
 * leur : la changer leur ferait effacer leurs reprises, favoris TV et catégories masquées.
 */
export async function setLastProviderHash(host: string): Promise<void> {
  const hash = await sha256(host);
  deviceProviderHash = hash;
  if (providerTablesOn()) return;
  await setPreference('last_provider_hash', hash);
}

/** Compute SHA256 of a host for comparison (exported for login/resume detection) */
export async function computeProviderHash(host: string): Promise<string> {
  return sha256(host);
}

// ============================================================================
// EPG PREFERENCES
// ============================================================================

/** Vérifie si l'EPG est activé (toggle ON). Défaut: OFF */
export function isEpgEnabled(): boolean {
  return getPreference('epg_enabled') === 'true';
}

/** Active ou désactive l'EPG (persiste SQLite + cloud sync) */
export async function setEpgEnabled(enabled: boolean): Promise<void> {
  await setPreference('epg_enabled', String(enabled));
}

/**
 * Synchronisation EPG réservée au Wi-Fi. Défaut : ON — le fichier fait environ 205 Mo,
 * ce qui épuiserait un forfait mobile en une synchro.
 */
export function isEpgWifiOnly(): boolean {
  return getPreference('epg_wifi_only') !== 'false';
}

export async function setEpgWifiOnly(enabled: boolean): Promise<void> {
  await setPreference('epg_wifi_only', String(enabled));
}

