/**
 * SessionContext — Cycle de vie complet de la session utilisateur
 *
 * Gère l'authentification, le chargement catalogue, et les données
 * RAM (lightIndexes) en un seul contexte cohérent.
 *
 * API fonctionnelle :
 *   session.login(creds)        — auth + ingest + build indexes
 *   session.resumeSession()     — load from SQLite + auth refresh
 *   session.refreshSources()    — re-auth + re-ingest + rebuild
 *   session.logout()            — reset state
 *   session.startFresh()        — clear saved data
 *   session.updateCredentials() — change creds sans reload
 *
 * Expose aussi les données dérivées :
 *   session.lightIndexes        — LightIndexes | null
 *   session.settingsContentCounts — stats pour SettingsPage
 *   session.iptvStatus          — 'ok' | 'warning' | 'error'
 *
 * Phase 5 — Z1 App Orchestrator refactoring
 */

import React, { createContext, useContext, useState, useMemo, useEffect, useCallback, type ReactNode, useRef } from 'react';
import { uniqueTitleCount } from '../utils/lightIndexHelpers';
import { titleLinkedEntryCounts } from '../services/titleTmdbLinkStore';
import { WATCHLIST_EVENT } from '../services/eventConstants';
import type { XtreamCredentials } from '../types/iptv';
import type { XtreamUserInfo } from '../types/xtream';
import type { LightIndexes } from '../types/lightIndex';
import type { TabType } from './NavigationContext';
import type { SessionContextValue, SettingsContentCounts, PendingProviderChange } from '../types/session';
import { StorageService, describeVaultError } from '../services/storage';
import { useTranslation } from 'react-i18next';
import { devLog } from '../utils/devLog';
import { useSupabaseAuth } from './SupabaseAuthContext';
import { useSessionLifecycle } from '../hooks/useSessionLifecycle';
import { computeIptvStatus } from '../utils/iptvStatus';

// ============================================================================
// CONTEXT
// ============================================================================

const SessionContext = createContext<SessionContextValue | null>(null);

// ============================================================================
// PROVIDER
// ============================================================================

interface SessionProviderProps {
    children: ReactNode;
}

export const SessionProvider: React.FC<SessionProviderProps> = ({ children }) => {
    const { t } = useTranslation(['common', 'auth']);
    const { isDbReady, spaceKey } = useSupabaseAuth();

    // =========================================================================
    // STATE
    // =========================================================================
    const [isLoggedIn, setIsLoggedIn] = useState(false);
    const [isLoading, setIsLoading] = useState(false);
    const [isLoadingSavedData, setIsLoadingSavedData] = useState(false);
    const [progress, setProgress] = useState(0);
    const [hasSavedSession, setHasSavedSession] = useState(false);
    // Lecture de la session sauvegardée terminée pour la base ouverte (coffre + catalogue local)
    const [savedSessionChecked, setSavedSessionChecked] = useState(false);
    const [credentials, setCredentials] = useState<XtreamCredentials | null>(null);
    const [accountInfo, setAccountInfo] = useState<XtreamUserInfo | null>(null);
    const [lightIndexes, setLightIndexes] = useState<LightIndexes | null>(null);
    const [lastIngestionPartial, setLastIngestionPartial] = useState(false);
    const [linksTick, setLinksTick] = useState(0);
    const [homeTab, setHomeTab] = useState<TabType>('dashboard');
    // Phase 1.5 — Profile Selector
    const [activeProfileId, setActiveProfileId] = useState<string | null>(null);
    const [sourceChanged, setSourceChanged] = useState(false);
    const [pendingProviderChange, setPendingProviderChange] = useState<PendingProviderChange | null>(null);
    const [sessionError, setSessionError] = useState<string | null>(null);

    // =========================================================================
    // LIFECYCLE HOOK — actions extraites dans useSessionLifecycle
    // =========================================================================
    const {
        login, resumeSession, refreshSources,
        logout, startFresh, fullReset,
        updateCredentials, confirmProviderChange,
        setActiveTabAfterAuth, selectProfile,
        savedCredsRef,
    } = useSessionLifecycle(
        {
            setSessionError,
            setIsLoggedIn, setIsLoading, setIsLoadingSavedData,
            setProgress, setHasSavedSession, setCredentials,
            setAccountInfo, setLightIndexes, setLastIngestionPartial,
            setHomeTab, setActiveProfileId, setSourceChanged,
            setPendingProviderChange,
        },
        credentials,
        pendingProviderChange,
        t,
    );

    // =========================================================================
    // STARTUP: Check for saved session
    // =========================================================================
    // Tant qu'elle n'est pas finie, l'écran des profils attend : un profil choisi avant la réponse partait
    // sans reprise, sur le formulaire du fournisseur vide (premier lancement après une mise à jour)
    useEffect(() => {
        if (!isDbReady) return;
        let cancelled = false;
        const checkSavedSession = async () => {
            try {
                // Android : erreur passagère du coffre (appareil verrouillé…) → attente et nouvel essai
                const savedCreds = await StorageService.getCredentialsAtStartup();
                if (cancelled) return;
                // Cache credentials in ref for resumeSession (avoids Keychain re-read failure on Windows)
                if (savedCreds) {
                    savedCredsRef.current = savedCreds;
                }
                const hasData = await StorageService.hasData();
                if (cancelled) return;
                const hasSaved = !!savedCreds && hasData;
                setHasSavedSession(hasSaved);
                devLog('session', hasSaved ? 'Session sauvegardée détectée' : 'Aucune session sauvegardée');
            } catch (e) {
                if (!cancelled) setHasSavedSession(false);
                devLog('session', 'Lecture de la session sauvegardée impossible', describeVaultError(e));
            } finally {
                if (!cancelled) setSavedSessionChecked(true);
            }
        };
        void checkSavedSession();
        return () => {
            cancelled = true;
            setSavedSessionChecked(false);
        };
    }, [isDbReady, savedCredsRef]);

    // L'espace a changé sans déconnexion (invité remplacé par un compte qui revient) : la session IPTV et les
    // identifiants de l'ancien espace sont fermés, jamais repris dans le nouveau
    const lastSpaceKeyRef = useRef(spaceKey);
    useEffect(() => {
        if (lastSpaceKeyRef.current === spaceKey) return;
        lastSpaceKeyRef.current = spaceKey;
        savedCredsRef.current = null;
        void logout();
    }, [spaceKey, logout, savedCredsRef]);

    const isCheckingSavedSession = isDbReady && !savedSessionChecked;

    /** Effacer le message d'erreur session */
    const clearSessionError = useCallback(() => setSessionError(null), []);

    // =========================================================================
    // DERIVED STATE
    // =========================================================================

    /** Des liens trouvés par le titre ont été posés : les taux des Réglages se recalculent (un seul passage par lot) */
    useEffect(() => {
        if (!lightIndexes) return undefined;
        const total = () => { const c = titleLinkedEntryCounts(lightIndexes); return c.movies + c.series; };
        let seen = total();
        let timer: ReturnType<typeof setTimeout> | null = null;
        // Les lots de liens se suivent pendant la recherche par titre : un seul recalcul toutes les 2 s au plus
        const onLinks = () => {
            if (timer !== null || total() === seen) return;
            timer = setTimeout(() => {
                timer = null;
                seen = total();
                setLinksTick((n) => n + 1);
            }, 2000);
        };
        window.addEventListener(WATCHLIST_EVENT, onLinks);
        return () => {
            window.removeEventListener(WATCHLIST_EVENT, onLinks);
            if (timer !== null) clearTimeout(timer);
        };
    }, [lightIndexes]);

    /** Stats pré-calculées pour SettingsPage */
    const settingsContentCounts = useMemo<SettingsContentCounts | undefined>(() => {
        if (!lightIndexes) return undefined;

        let tmdbMovies = 0;
        for (const movie of lightIndexes.movies.values()) {
            if (movie.tmdbId !== 0) tmdbMovies++;
        }
        let tmdbSeries = 0;
        for (const series of lightIndexes.series.values()) {
            if (series.tmdbId !== 0) tmdbSeries++;
        }

        const moviesCount = lightIndexes.movies.size;
        const seriesCount = lightIndexes.series.size;
        const byTitle = titleLinkedEntryCounts(lightIndexes);
        const rate = (part: number, total: number) => (total > 0 ? Math.round((part / total) * 100) : 0);

        return {
            live: lightIndexes.live.size,
            movies: moviesCount,
            series: seriesCount,
            uniqueMovies: uniqueTitleCount(lightIndexes.moviesByTmdb.size, tmdbMovies, moviesCount),
            uniqueSeries: uniqueTitleCount(lightIndexes.seriesByTmdb.size, tmdbSeries, seriesCount),
            tmdbMovies,
            tmdbSeries,
            tmdbMovieRate: rate(tmdbMovies, moviesCount),
            tmdbSeriesRate: rate(tmdbSeries, seriesCount),
            tmdbMovieTitleRate: rate(Math.min(byTitle.movies, tmdbMovies), moviesCount),
            tmdbSeriesTitleRate: rate(Math.min(byTitle.series, tmdbSeries), seriesCount),
        };
    // linksTick : les liens trouvés par le titre arrivent après le chargement, sans nouveau catalogue
    // eslint-disable-next-line react-hooks/exhaustive-deps -- relance voulue du calcul quand des liens sont posés
    }, [lightIndexes, linksTick]);

    /** Statut IPTV pour sidebar indicator */
    const iptvStatus = useMemo(
        () => computeIptvStatus(lightIndexes, lastIngestionPartial),
        [lightIndexes, lastIngestionPartial],
    );

    // =========================================================================
    // CONTEXT VALUE
    // =========================================================================

    const value: SessionContextValue = useMemo(() => ({
        // State
        isLoggedIn,
        isLoading,
        isLoadingSavedData,
        progress,
        hasSavedSession,
        isCheckingSavedSession,
        credentials,
        accountInfo,
        lightIndexes,
        settingsContentCounts,
        iptvStatus,
        homeTab,
        activeProfileId,
        sourceChanged,
        pendingProviderChange,
        sessionError,
        // Actions
        login,
        resumeSession,
        refreshSources,
        logout,
        startFresh,
        fullReset,
        updateCredentials,
        setActiveTabAfterAuth,
        selectProfile,
        confirmProviderChange,
        clearSessionError,
    }), [
        isLoggedIn, isLoading, isLoadingSavedData, progress,
        hasSavedSession, isCheckingSavedSession, credentials, accountInfo, lightIndexes,
        settingsContentCounts, iptvStatus, homeTab,
        activeProfileId, sourceChanged, pendingProviderChange,
        sessionError,
        login, resumeSession, refreshSources, logout,
        startFresh, fullReset, updateCredentials, setActiveTabAfterAuth,
        selectProfile, confirmProviderChange, clearSessionError,
    ]);

    return (
        <SessionContext.Provider value={value}>
            {children}
        </SessionContext.Provider>
    );
};

// ============================================================================
// HOOKS
// ============================================================================

/**
 * Hook pour accéder au contexte Session complet.
 * @throws Error si utilisé hors du SessionProvider
 */
export function useSession(): SessionContextValue {
    const context = useContext(SessionContext);
    if (!context) {
        throw new Error('useSession must be used within a SessionProvider');
    }
    return context;
}
