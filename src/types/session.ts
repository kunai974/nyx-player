/**
 * types/session.ts — Types partagés pour le contexte Session
 *
 * Extraits de SessionContext.tsx pour réduire la taille du god file
 * et permettre l'import sans dépendance circulaire.
 */

import type { XtreamCredentials } from './iptv';
import type { XtreamUserInfo } from './xtream';
import type { LightIndexes } from './lightIndex';
import type { TabType } from './navigation';

// ============================================================================
// TYPES
// ============================================================================

/** Données en attente de confirmation pour un changement de provider */
export interface PendingProviderChange {
    from: string;
    to: string;
    creds: XtreamCredentials;
}

export interface SessionState {
    /** Erreur session lifecycle (login/resume/refresh) — affichée inline */
    sessionError: string | null;
    /** Utilisateur connecté */
    isLoggedIn: boolean;
    /** Chargement en cours (login, fetch data) */
    isLoading: boolean;
    /** Chargement données sauvegardées (resume) */
    isLoadingSavedData: boolean;
    /** Progression du chargement (0-100) */
    progress: number;
    /** Session sauvegardée disponible */
    hasSavedSession: boolean;
    /** Lecture de la session sauvegardée en cours au démarrage : les profils ne sont pas encore cliquables */
    isCheckingSavedSession: boolean;
    /** Credentials actuels */
    credentials: XtreamCredentials | null;
    /** Informations du compte */
    accountInfo: XtreamUserInfo | null;
    /** Données catalogue en RAM (films, séries, live, catégories) */
    lightIndexes: LightIndexes | null;
    /** Stats pré-calculées pour SettingsPage */
    settingsContentCounts: SettingsContentCounts | undefined;
    /** Statut IPTV pour sidebar */
    iptvStatus: 'ok' | 'warning' | 'error';
    /** Tab de départ après login */
    homeTab: TabType;
    /** Profil actif (UUID Supabase) — Phase 1.5 */
    activeProfileId: string | null;
    /** Source Xtream a changé depuis la dernière session */
    sourceChanged: boolean;
    /** Changement de provider en attente de confirmation */
    pendingProviderChange: PendingProviderChange | null;
}

export interface SettingsContentCounts {
    live: number;
    movies: number;
    series: number;
    uniqueMovies: number;
    uniqueSeries: number;
    tmdbMovies: number;
    tmdbSeries: number;
    tmdbMovieRate: number;
    tmdbSeriesRate: number;
    /** Part du taux ci-dessus due aux numéros trouvés par le titre (le reste vient du fournisseur) */
    tmdbMovieTitleRate: number;
    tmdbSeriesTitleRate: number;
}

export interface SessionActions {
    /** Effacer le message d'erreur session */
    clearSessionError: () => void;
    /** Login complet : auth + ingest + build indexes */
    login: (creds: XtreamCredentials) => Promise<void>;
    /** Reprendre session : load indexes from SQLite + auth refresh */
    resumeSession: () => Promise<void>;
    /** Rafraîchir les sources : re-auth + re-ingest + rebuild */
    refreshSources: () => Promise<void>;
    /** Déconnexion */
    logout: () => Promise<void>;
    /** Supprimer la session sauvegardée */
    startFresh: () => Promise<void>;
    /** Factory reset: reset complet du state React (appelé APRÈS performFullReset) */
    fullReset: () => void;
    /** Changer de credentials (sans recharger le catalogue) */
    updateCredentials: (newCreds: XtreamCredentials) => Promise<void>;
    /** Navigate to home tab (exposed for post-login navigation) */
    setActiveTabAfterAuth: (tab: TabType) => void;
    /** Sélectionner un profil actif — Phase 1.5 */
    selectProfile: (profileId: string) => Promise<void>;
    /** Confirmer ou annuler un changement de provider en attente */
    confirmProviderChange: (accepted: boolean) => Promise<void>;
}

export type SessionContextValue = SessionState & SessionActions;
