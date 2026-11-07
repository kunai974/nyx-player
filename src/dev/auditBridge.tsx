/**
 * Pont d'audit : déclencheurs nommés pour l'outil d'audit de l'affichage.
 *
 * Actif seulement dans l'APK d'audit des émulateurs, compilé avec VITE_AUDIT=1
 * (script de compilation de l'APK d'audit). Absent de toute version publiée : `AUDIT_BRIDGE_ENABLED` vaut
 * false à la compilation, et le composant disparaît du bundle.
 *
 * L'outil y lit l'état de la navigation et active les forçages d'état qui existent pour le
 * développement (DevOverrideContext) : Ma liste vide, bannière sans logo, fenêtres, bandeaux…
 * Aucun appel réseau, aucune écriture : les forçages ne vivent qu'en mémoire.
 *
 * Écran forcé (`set('appScreen', 'show', 'account' | 'provider' | null)`) : affiche la connexion au
 * compte ou l'ajout du fournisseur IPTV alors que la session reste ouverte, pour auditer ces écrans
 * sans déconnecter l'émulateur. Champs vides, rien n'est envoyé : l'outil ne tape jamais.
 *
 * Version 2 (banc de tests automatiques) :
 * lectures seules en plus, pour les scénarios. Nature de la source active (`source`), état du
 * lecteur (`lecteur`), tentatives de lecture vues par le verrou (`lectures`), empreinte du compte
 * connecté (`compte`), identifiant du profil actif (`profil`), nombre de chaînes, films et séries
 * chargés (`catalogue`). Jamais une adresse, un nom d'utilisateur ni un e-mail en clair.
 */
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { useNavigation } from '../contexts/NavigationContext';
import { useDevOverrides } from '../contexts/DevOverrideContext';
import { useSession } from '../contexts/SessionContext';
import { useSupabaseAuth } from '../contexts/SupabaseAuthContext';
import { usePlayer } from '../contexts/PlayerContext';
import { getProperty } from '../services/player/mpvApi';
import { getOpenDatabase } from '../services/dbCore';
import { VERSION_AUDIT, type EcranAudit } from '../services/outilsTest';
import { natureAdresse, tentativesLecture, type NatureAdresse, type TentativeLecture } from './bancAdresses';

export const AUDIT_BRIDGE_ENABLED = VERSION_AUDIT;

/** Écrans d'avant l'accueil, affichables par l'outil alors que la session est ouverte. */
export type AuditScreen = EcranAudit;
const AUDIT_SCREENS: readonly AuditScreen[] = ['account', 'provider'];

let forcedScreen: AuditScreen | null = null;
const screenListeners = new Set<() => void>();

function setForcedScreen(screen: AuditScreen | null): void {
  if (screen === forcedScreen) return;
  forcedScreen = screen;
  screenListeners.forEach((listener) => listener());
}

function subscribeForcedScreen(listener: () => void): () => void {
  screenListeners.add(listener);
  return () => { screenListeners.delete(listener); };
}

function useForcedScreen(): AuditScreen | null {
  return useSyncExternalStore(subscribeForcedScreen, () => forcedScreen);
}

function useNoForcedScreen(): null {
  return null;
}

/** Écran forcé par l'outil d'audit ; toujours null hors de la version d'audit. */
export const useAuditScreen: () => AuditScreen | null = AUDIT_BRIDGE_ENABLED ? useForcedScreen : useNoForcedScreen;

type OverrideGroup =
  | 'loginPage' | 'xtreamPage' | 'watchlistPage' | 'globalSearchPage' | 'settingsPage'
  | 'liveTvPage' | 'movieDetailPage' | 'seriesDetailPage' | 'dashboardPage';

/** État du lecteur, sans l'adresse du flux. Valeurs nulles quand le lecteur est fermé ou muet. */
export interface AuditLecteur {
  ouvert: boolean;
  position: number | null;
  duree: number | null;
  pause: boolean | null;
  muet: boolean | null;
  pisteAudio: unknown;
  sousTitres: unknown;
  /** Genre de l'erreur de lecture affichée (`PlaybackErrorKind`), ou null. */
  erreur: string | null;
}

/** Empreinte SHA-256 (hexadécimal) de l'e-mail en minuscules : le banc la compare à celle du compte de test. */
async function empreinteEmail(email: string): Promise<string> {
  const octets = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(email.trim().toLowerCase()));
  return [...new Uint8Array(octets)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Propriété du lecteur, ou null si elle ne se lit pas (lecteur arrêté, propriété inconnue). */
async function propriete(nom: string): Promise<unknown> {
  try {
    return (await getProperty<unknown>(nom)) ?? null;
  } catch {
    return null;
  }
}

const nombre = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const booleen = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

export interface NyxAuditBridge {
  version: 2;
  /** Code dont l'APK est compilé (commit, + empreinte des modifications non commitées) : l'outil
   *  refuse d'auditer un APK qui ne correspond pas au code en cours. */
  build: string;
  /** Onglet actif et fiches ouvertes. */
  state: () => { tab: string; movieOpen: boolean; seriesOpen: boolean; categoryOpen: boolean };
  /** Active un forçage : `set('watchlistPage', 'forceEmpty', true)`. Retourne false si inconnu.
   *  Écran forcé : `set('appScreen', 'show', 'account' | 'provider' | null)`. */
  set: (group: OverrideGroup | 'appScreen', key: string, value: unknown) => boolean;
  /** Retire tous les forçages. */
  reset: () => void;
  /** Forçages disponibles, par groupe, avec leur valeur actuelle. */
  list: () => Record<string, Record<string, unknown>>;
  /** Nature de la source IPTV active (d'après son hôte et son port), ou null sans source. */
  source: () => NatureAdresse | null;
  /** État du lecteur (propriétés lues au lecteur, erreur affichée par l'app). */
  lecteur: () => Promise<AuditLecteur>;
  /** Tentatives de lecture vues par le verrou du banc depuis le lancement. */
  lectures: () => TentativeLecture[];
  /** Compte connecté : empreinte de son e-mail, jamais l'e-mail. */
  compte: () => Promise<{ connecte: boolean; empreinte: string | null }>;
  /** Identifiant (tiré au hasard) du profil actif, jamais son nom ; null sans profil choisi. */
  profil: () => string | null;
  /** Nombre de chaînes, films et séries dans la base locale (null si une table ne se lit pas). */
  catalogue: () => Promise<AuditCatalogue>;
}

export interface AuditCatalogue { chaines: number | null; films: number | null; series: number | null }

type Base = NonNullable<ReturnType<typeof getOpenDatabase>>;

/** Compte les lignes d'une table de la base locale (lecture seule), ou null si elle ne se lit pas. */
async function compter(base: Base, table: 'live' | 'movies' | 'series'): Promise<number | null> {
  try {
    const lignes = await base.select<{ n: number }[]>(`SELECT COUNT(*) AS n FROM ${table}`);
    return nombre(lignes[0]?.n);
  } catch {
    return null;
  }
}

/** Taille du catalogue chargé ; tout à null si la base n'est pas encore ouverte par l'app (jamais ouverte ici). */
async function catalogueLocal(): Promise<AuditCatalogue> {
  try {
    const base = getOpenDatabase();
    if (!base) return { chaines: null, films: null, series: null };
    return { chaines: await compter(base, 'live'), films: await compter(base, 'movies'), series: await compter(base, 'series') };
  } catch {
    return { chaines: null, films: null, series: null };
  }
}

declare global {
  interface Window { __nyxAudit?: NyxAuditBridge }
}

export function AuditBridge(): null {
  const nav = useNavigation();
  const dev = useDevOverrides();
  const session = useSession();
  const auth = useSupabaseAuth();
  const player = usePlayer();
  // Dernières valeurs des contextes, lues à chaque appel du pont (l'objet n'est pas recréé à chaque rendu).
  const vivant = useRef({ session, auth, player });
  useEffect(() => { vivant.current = { session, auth, player }; });

  useEffect(() => {
    const setters: Record<OverrideGroup, (key: never, value: never) => void> = {
      loginPage: dev.setLoginOverride,
      xtreamPage: dev.setXtreamOverride,
      watchlistPage: dev.setWatchlistOverride,
      globalSearchPage: dev.setGlobalSearchOverride,
      settingsPage: dev.setSettingsOverride,
      liveTvPage: dev.setLiveTvOverride,
      movieDetailPage: dev.setMovieDetailOverride,
      seriesDetailPage: dev.setSeriesDetailOverride,
      dashboardPage: dev.setDashboardOverride,
    };
    window.__nyxAudit = {
      version: 2,
      build: import.meta.env.VITE_AUDIT_BUILD ?? '',
      state: () => ({
        tab: nav.activeTab,
        movieOpen: !!nav.selectedMovie,
        seriesOpen: !!nav.selectedSeries,
        categoryOpen: !!nav.categoryDetail,
      }),
      set: (group, key, value) => {
        if (group === 'appScreen') {
          if (key !== 'show' || (value !== null && !AUDIT_SCREENS.includes(value as AuditScreen))) return false;
          setForcedScreen(value as AuditScreen | null);
          return true;
        }
        const current = dev.overrides[group] as unknown as Record<string, unknown> | undefined;
        if (!current || !(key in current)) return false;
        setters[group](key as never, value as never);
        return true;
      },
      reset: () => { setForcedScreen(null); dev.resetAll(); },
      list: () => ({
        ...Object.fromEntries(
          (Object.keys(setters) as OverrideGroup[]).map((g) => [g, { ...(dev.overrides[g] as unknown as Record<string, unknown>) }]),
        ),
        appScreen: { show: forcedScreen },
      }),
      source: () => {
        const host = vivant.current.session.credentials?.host;
        return host ? natureAdresse(host) : null;
      },
      lecteur: async () => {
        const { currentlyPlaying, playbackError } = vivant.current.player;
        const erreur = playbackError?.kind ?? null;
        if (!currentlyPlaying) {
          return { ouvert: false, position: null, duree: null, pause: null, muet: null, pisteAudio: null, sousTitres: null, erreur };
        }
        const [position, duree, pause, muet, pisteAudio, sousTitres] = await Promise.all(
          ['time-pos', 'duration', 'pause', 'mute', 'aid', 'sid'].map(propriete),
        );
        return { ouvert: true, position: nombre(position), duree: nombre(duree), pause: booleen(pause), muet: booleen(muet), pisteAudio, sousTitres, erreur };
      },
      lectures: () => tentativesLecture(),
      compte: async () => {
        const email = vivant.current.auth.user?.email;
        return email ? { connecte: true, empreinte: await empreinteEmail(email) } : { connecte: false, empreinte: null };
      },
      profil: () => vivant.current.session.activeProfileId ?? null,
      catalogue: catalogueLocal,
    };
    return () => { delete window.__nyxAudit; };
  }, [nav, dev]);

  return null;
}
