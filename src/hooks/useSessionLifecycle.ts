/**
 * useSessionLifecycle.ts — Actions et helpers du cycle de vie Session
 *
 * Extrait de SessionContext.tsx pour réduire le god file.
 * Ce hook retourne toutes les actions lifecycle (login, resume, refresh, logout, etc.)
 * ainsi que les refs internes. Les étapes sans état React (lecture du catalogue, changement de
 * fournisseur, re-liaison de Ma liste) sont dans services/sessionSteps.ts.
 */

import { useCallback, useEffect, useRef } from 'react';
import type { ParseKeys } from 'i18next';
import type { XtreamCredentials } from '../types/iptv';
import type { LightIndexes } from '../types/lightIndex';
import type { TabType } from '../contexts/NavigationContext';
import type { PendingProviderChange } from '../types/session';
import { StorageService } from '../services/storage';
import { XtreamApiService, inactiveAccountInfo, isProviderAccountInactiveError, isProviderHtmlResponseError } from '../services/xtreamApi';
import { isProviderCertificateError, isProviderServerError } from '../services/networkService';
import { cancelCatalogIngestion } from '../services/catalogIngestion';
import { loadLightIndexes } from '../services/catalogLight';
import { setMeta, getMeta, clearCatalogData, getDatabase } from '../services/dbCore';
import { getHomePage, setLastProviderHash, getLastProviderHash } from '../services/preferencesService';
import { checkAndAutoSync, purgeExpiredPrograms, stopSyncForSessionChange } from '../services/epgService';
import { devLog } from '../utils/devLog';
import { perfMark } from '../utils/perfMarks';
import { EPG_UPDATED_EVENT } from '../services/eventConstants';
import { syncOnLogin, setCurrentSyncUserId, getCurrentSyncUserId, fetchCloudProviderHash } from '../services/syncService';
import { startCloudResync, stopCloudResync, waitForCloudResync } from '../services/sync/syncScheduler';
import { prepareRefreshedCatalog, applyRefreshedCatalog, resetCatalogCaches } from '../services/catalogReconcile';
import { supabase } from '../services/supabaseClient';
import { stopCatalogAutoRefresh, updateAutoRefreshCredentials, clearAutoRefreshNotes } from '../services/catalogAutoRefresh';
import {
    registerCatalogInstaller, markInstalledFromDb, clearPendingCatalog,
    hasPendingCatalog, invalidatePreparedCatalog,
} from '../services/catalogSwapGate';
import {
    type CloudWatchlistRef, isSessionStill, applySyncedLanguage, initServices, startAutoRefresh, readSeqSafely,
    performIngestion, detectProviderChangeOnLogin, findKnownProviderSpelling, wipeProviderSpecificData, purgeProviderSpecificCloud,
    toCloudWatchlistRefs, relinkWatchlist, announceEpgLinksWhenReady,
} from '../services/sessionSteps';
import type { XtreamUserInfo } from '../types/xtream';
import { normalizeProviderHost, sameProviderHost } from '../utils/providerHost';
import { checkLocalDatabase, isDatabaseDamagedError, isLocalDatabaseDamaged } from '../services/localDatabaseHealth';
import { createLogger } from '../utils/logger';

const log = createLogger('Session');
const ingestionLog = createLogger('Ingestion');

// ============================================================================
// TYPES — State setters passed from the Provider
// ============================================================================

export interface SessionSetters {
    setSessionError: (v: string | null) => void;
    setIsLoggedIn: (v: boolean) => void;
    setIsLoading: (v: boolean) => void;
    setIsLoadingSavedData: (v: boolean) => void;
    setProgress: (v: number) => void;
    setHasSavedSession: (v: boolean) => void;
    setCredentials: (v: XtreamCredentials | null) => void;
    setAccountInfo: (v: XtreamUserInfo | null) => void;
    setLightIndexes: (v: LightIndexes | null) => void;
    setLastIngestionPartial: (v: boolean) => void;
    setHomeTab: (v: TabType) => void;
    setActiveProfileId: (v: string | null) => void;
    setSourceChanged: (v: boolean) => void;
    setPendingProviderChange: (v: PendingProviderChange | null) => void;
}

// ============================================================================
// HOOK
// ============================================================================

export function useSessionLifecycle(
    setters: SessionSetters,
    credentials: XtreamCredentials | null,
    pendingProviderChange: PendingProviderChange | null,
    // La fonction t d'i18next de SessionContext : seules des clés de « common » et « auth » sont traduites ici
    t: (key: ParseKeys<['common', 'auth']>) => string,
) {
    const {
        setSessionError,
        setIsLoggedIn, setIsLoading, setIsLoadingSavedData,
        setProgress, setHasSavedSession, setCredentials,
        setAccountInfo, setLightIndexes, setLastIngestionPartial,
        setHomeTab, setActiveProfileId, setSourceChanged,
        setPendingProviderChange,
    } = setters;

    // Cache credentials from startup check to avoid Keychain re-read failure on Windows
    const savedCredsRef = useRef<XtreamCredentials | null>(null);
    // Flag pour skip la détection provider quand l'user a déjà confirmé
    const providerChangeConfirmedRef = useRef(false);
    // Numéro de session, augmenté par login, logout et fullReset : une actualisation commencée dans
    // une session n'installe rien dans la suivante (catalogue, infos du compte Xtream, Ma liste).
    const sessionEpochRef = useRef(0);

    // =========================================================================
    // SHARED HELPERS (used by login, resume, refresh) — les autres : services/sessionSteps.ts
    // =========================================================================

    /** Build LightIndexes from SQLite tables */
    // Lecture compacte par le cœur natif, ancienne lecture ligne à ligne en secours
    // (services/catalogLight.ts)
    const buildIndexes = useCallback((): Promise<LightIndexes> => loadLightIndexes(), []);

    // Catalogue neuf préparé après une actualisation en arrière-plan : installé par la porte
    // (services/catalogSwapGate.ts) au moment calme suivant
    useEffect(() => {
        registerCatalogInstaller(setLightIndexes);
        return () => registerCatalogInstaller(null);
    }, [setLightIndexes]);

    // Rebuild LightIndexes when EPG mapping updates matched_epg_id in DB.
    // Without this, the in-memory live channels have stale epgChannelId until app restart.
    useEffect(() => {
        const rebuild = async () => {
            try {
                // Catalogue neuf en attente d'un moment calme : il est refait avec les nouveaux
                // liens et installé à ce moment-là, jamais un catalogue relu en dehors de la porte
                if (hasPendingCatalog()) {
                    invalidatePreparedCatalog('liens du guide TV recalculés');
                    return;
                }
                const indexes = await buildIndexes();
                if (hasPendingCatalog()) {
                    invalidatePreparedCatalog('liens du guide TV recalculés');
                    return;
                }
                setLightIndexes(indexes);
                devLog('session', '✅ LightIndex rebuilt after EPG update');
            } catch {
                // Non-fatal: DB might not be ready yet
            }
        };
        const handler = () => { void rebuild(); };
        window.addEventListener(EPG_UPDATED_EVENT, handler);
        return () => window.removeEventListener(EPG_UPDATED_EVENT, handler);
    }, [buildIndexes, setLightIndexes]);

    // =========================================================================
    // ACTIONS
    // =========================================================================

    const login = useCallback(async (creds: XtreamCredentials): Promise<void> => {
        const epoch = ++sessionEpochRef.current;
        // Synchro du guide de la session précédente arrêtée, guide gardé
        stopSyncForSessionChange();
        // Compte et base de cette connexion : après chaque attente, plus rien n'est écrit si l'on s'est
        // déconnecté ou si un autre compte a pris la place entre-temps
        const accountId = getCurrentSyncUserId();
        const stillCurrent = () => isSessionStill(sessionEpochRef, epoch, accountId);
        // Abandon : login, logout ou fullReset gère déjà l'indicateur de chargement ; une session
        // Supabase fermée d'elle-même (jeton refusé, autre appareil) n'appelle pas logout, on l'éteint ici
        const abandon = (why: string) => {
            devLog('session', `⏹ Connexion abandonnée : ${why}`);
            if (sessionEpochRef.current === epoch) {
                setIsLoading(false);
                setProgress(0);
            }
        };
        // Synchro en cours finie avant tout effacement (changement de fournisseur, catalogue)
        stopCloudResync();
        await waitForCloudResync();
        // Plus d'actualisation en arrière-plan pendant la connexion (écriture complète du catalogue)
        clearPendingCatalog();
        await stopCatalogAutoRefresh();
        setSessionError(null);
        // Sans l'adresse du fournisseur : les journaux ne la contiennent jamais en clair
        devLog('session', '🔑 Login en cours...');
        setIsLoading(true);
        setProgress(0);
        // Échec de la connexion : le message dit la vraie raison, et le chargement s'arrête
        const fail = async (error: unknown): Promise<void> => {
            log.error('Login/Fetch failed:', error);
            // Base de l'appareil abîmée (contrôlée d'abord, le texte d'une erreur ne suffit pas) : ni les
            // identifiants ni le fournisseur n'y sont pour rien, l'écran du fournisseur propose la réinitialisation
            const damaged = isDatabaseDamagedError(error) && await checkLocalDatabase() === 'corrupt';
            if (!stillCurrent()) { abandon('la session a changé pendant le contrôle de la base'); return; }
            // Serveur du fournisseur en panne ou injoignable : ne pas faire croire à des identifiants faux
            setSessionError(t(damaged ? 'common:local_db_damaged_error'
                : isProviderServerError(error) ? 'auth:error_provider_unavailable'
                : isProviderCertificateError(error) ? 'auth:error_provider_certificate'
                : isProviderHtmlResponseError(error) ? 'auth:error_provider_html'
                : isProviderAccountInactiveError(error) ? 'auth:error_provider_account_inactive' : 'auth:error_login_failed'));
            setIsLoading(false);
        };
        // Base illisible dès l'ouverture : le même message qu'un échec plus loin, sans sablier sans fin
        try {
            await initServices();
        } catch (error) {
            if (!stillCurrent()) return abandon('la session a changé pendant l\'ouverture de la base');
            return fail(error);
        }

        // Phase 2B: Cloud provider change detection (multi-device). Cloud d'abord, base locale ensuite.
        // Aussi après la confirmation : elle donne l'écriture de l'adresse à noter
        const provider = await detectProviderChangeOnLogin(creds.host);
        if (!providerChangeConfirmedRef.current) {
            // If change detected → show confirmation dialog
            if (provider.changed) {
                setPendingProviderChange({ from: '***', to: creds.host, creds });
                setIsLoading(false);
                return; // Login paused — will resume via confirmProviderChange
            }
        }

        // Reset confirmed flag
        const isProviderChange = providerChangeConfirmedRef.current;
        providerChangeConfirmedRef.current = false;

        // If confirmed provider change, wipe provider-specific data. Pas dans la base d'un autre compte :
        // la session a pu changer pendant les attentes qui précèdent
        if (isProviderChange) {
            if (!stillCurrent()) return abandon('la session a changé avant l\'effacement des données du fournisseur');
            devLog('session', '🧹 Provider change confirmed — wiping data');
            try {
                await wipeProviderSpecificData();
            } catch (error) {
                if (!stillCurrent()) return abandon('la session a changé pendant l\'effacement des données du fournisseur');
                return fail(error);
            }
            await purgeProviderSpecificCloud(provider.spelling);
        }

        try {
            if (!stillCurrent()) return abandon('la session a changé avant la lecture du catalogue');
            // Step 1: catalogue vidé avant la lecture complète seulement au changement de fournisseur
            // (ses numéros ne valent plus rien). Même fournisseur : le catalogue en base est gardé,
            // pour qu'une liste en échec ou vide ne vide pas la section (les garde-fous du Rust
            // gardent l'ancienne), comme « Actualiser ». Ma liste
            // est gardée dans les deux cas. Fournisseur jamais noté dans cette
            // base (première connexion interrompue, synchro hors ligne) : on ne peut pas savoir, on vide.
            const knownProvider = await getMeta('lastProvider');
            if (isProviderChange || !knownProvider || !sameProviderHost(knownProvider, creds.host)) {
                await clearCatalogData();
                devLog('session', '🧹 Catalogue vidé avant la connexion (autre fournisseur ou fournisseur inconnu)');
            }
            // Accueil et fiches de la session précédente (autre source, autre compte) oubliés
            resetCatalogCaches();

            // Step 2-3: Ingest + build indexes
            const { indexes, userInfo, partial, failedEndpoints, changesSeq } = await performIngestion(creds, setProgress, stillCurrent);
            if (!stillCurrent()) return abandon('la session a changé pendant la lecture du catalogue');
            setAccountInfo(userInfo);
            setCredentials(creds);
            setLightIndexes(indexes);
            markInstalledFromDb(changesSeq);
            // Catalogue relu avec ses liens au guide à la fin de leur recalcul
            announceEpgLinksWhenReady(stillCurrent);
            setProgress(100);

            // Persist partial status
            setLastIngestionPartial(partial);
            if (!stillCurrent()) return abandon('la session a changé après la lecture du catalogue');
            await setMeta('lastIngestionPartial', String(partial));
            await setMeta('lastFailedEndpoints', JSON.stringify(failedEndpoints));

            if (partial) {
                ingestionLog.warn('⚠ Ingestion partielle:', failedEndpoints);
            }

            // Identifiants rangés dans le trousseau du compte de cette connexion, jamais du suivant
            if (!stillCurrent()) return abandon('la session a changé avant l\'enregistrement des identifiants');
            await StorageService.saveCredentials(creds);
            savedCredsRef.current = creds;

            // Fournisseur noté dans la base et le cloud de ce compte seulement (l'écriture du coffre a attendu)
            if (!stillCurrent()) return abandon('la session a changé pendant l\'enregistrement des identifiants');

            // Persist lastProvider for local detection. Écriture déjà connue du compte pour ce serveur :
            // l'empreinte reste celle des reprises, favoris et titres déjà enregistrés
            await setMeta('lastProvider', provider.spelling);

            // Persist provider hash to SQLite + cloud
            await setLastProviderHash(provider.spelling);

            // Step 4: Sync cloud (await — watchlist must finish before re-link)
            const currentHash = getLastProviderHash();
            let cloudWatchlistItems: CloudWatchlistRef[] = [];
            try {
                const { data: { session: supaSession } } = await supabase.auth.getSession();
                if (supaSession?.user) {
                    setCurrentSyncUserId(supaSession.user.id);
                    const syncResult = await syncOnLogin(supaSession.user.id);
                    devLog('session', '☁️ Sync on login completed', syncResult);

                    // Langue reçue du cloud : cache TMDB, accueil et fiches suivent
                    await applySyncedLanguage();

                    // Use cloud watchlist items from sync (no double-fetch)
                    cloudWatchlistItems = toCloudWatchlistRefs(syncResult.cloudWatchlistItems);
                }
            } catch (err) {
                log.error('Sync on login failed:', err);
            }

            // Step 5: Re-link pass (data-driven, always runs)
            // Wrapped in try/catch — relink failures are non-fatal and should not block login
            if (!stillCurrent()) return abandon('la session a changé pendant la synchro');
            if (currentHash) {
                await relinkWatchlist(indexes, currentHash, cloudWatchlistItems, stillCurrent, 'login');
            }

            if (!stillCurrent()) return abandon('la session a changé pendant la re-liaison de Ma liste');
            const tab = getHomePage() as TabType;
            setHomeTab(tab);

            devLog('session', '✅ Login réussi', { tab, movies: indexes.movies.size, series: indexes.series.size });

            // EPG boot tasks (fire-and-forget — ne bloque pas le login)
            purgeExpiredPrograms().catch(() => {});
            checkAndAutoSync().catch(() => {});
            startAutoRefresh(creds);
            // Synchro relancée pendant la session : réseau revenu, retour dans l'app, régulièrement
            const resyncUserId = getCurrentSyncUserId();
            if (resyncUserId) startCloudResync(resyncUserId);

            setTimeout(() => {
                if (!stillCurrent()) return abandon('la session a changé avant l\'ouverture de l\'accueil');
                setIsLoggedIn(true);
                setIsLoading(false);
                setHasSavedSession(true);
            }, 500);
        } catch (error) {
            // Session fermée pendant la connexion : l'erreur vient de la base fermée, rien à signaler
            if (!stillCurrent()) return abandon('la session a changé pendant la connexion');
            await fail(error);
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setters de la session (useState) stables, reçus en paramètre : la règle ne les reconnaît pas
    }, [t]);

    const resumeSession = useCallback(async (): Promise<void> => {
        // Reprise commencée dans cette session : une déconnexion ou un autre compte l'arrête avant
        // toute écriture dans la base qui a pris la place
        const epoch = sessionEpochRef.current;
        const accountId = getCurrentSyncUserId();
        const stillCurrent = () => isSessionStill(sessionEpochRef, epoch, accountId);
        setSessionError(null);
        devLog('session', '🔄 Resume session...');
        setIsLoadingSavedData(true);
        // Accueil et fiches d'une session fermée sans passer par logout (jeton expiré, déconnexion
        // depuis un autre appareil) oubliés
        resetCatalogCaches();
        try {
            // Use cached credentials from startup check (avoids Windows Keychain re-read failure)
            let savedCreds = savedCredsRef.current;
            if (!savedCreds) {
                savedCreds = await StorageService.getCredentials();
            }
            if (!savedCreds) {
                setSessionError(t('common:no_saved_data'));
                setIsLoadingSavedData(false);
                return;
            }

            const resumeStart = performance.now();
            const elapsed = () => Math.round(performance.now() - resumeStart);

            // Phase 2C: Cloud provider change detection (multi-device resume).
            // Lancée tout de suite, en parallèle de la lecture du catalogue (réseau d'un côté, base locale
            // de l'autre, sans dépendance) ; son résultat est attendu au même endroit qu'avant.
            const remoteProviderCheck = (async (): Promise<boolean> => {
                try {
                    const { data: { session: supaSession } } = await supabase.auth.getSession();
                    if (supaSession?.user) {
                        const cloudHash = await fetchCloudProviderHash(supaSession.user.id);
                        // Même serveur écrit autrement (« / » final, majuscule) : pas un changement
                        if (cloudHash && !(await findKnownProviderSpelling(cloudHash, savedCreds.host, await getMeta('lastProvider')))) {
                            devLog('session', '⚠️ Resume: provider changed on another device');
                            return true;
                        }
                    }
                } catch (e) {
                    devLog('session', '⚠️ Resume: cloud provider check failed, using local', e);
                }
                return false;
            })();

            // Ensure DB exists
            await getDatabase();
            // Préférences et catégories masquées de l'appareil chargées avant la synchro, qui les complète
            await initServices();

            // Synchro cloud lancée dès la fin de la vérification du fournisseur, pendant la lecture du
            // catalogue au lieu d'après (mesure : ≈ 2,4 s de catalogue puis
            // ≈ 2,3 s d'attente du cloud). Même contenu, même attente bornée des catégories masquées :
            // seul l'ordre change. Elle n'a pas besoin du catalogue ; la re-liaison de
            // Ma liste, qui en a besoin, reste après les deux.
            const cloudSync = (async (): Promise<{ cloudWatchlistItems: CloudWatchlistRef[]; readyAt: number } | null> => {
                // Source changée sur un autre appareil : pas de synchro, retour à la connexion (ci-dessous)
                if (await remoteProviderCheck) return null;
                if (!stillCurrent()) return null;
                let cloudWatchlistItems: CloudWatchlistRef[] = [];
                try {
                    const { data: { session: supaSession } } = await supabase.auth.getSession();
                    if (supaSession?.user && stillCurrent()) {
                        setCurrentSyncUserId(supaSession.user.id);
                        const syncResult = await syncOnLogin(supaSession.user.id);
                        devLog('session', '☁️ Sync on resume completed', syncResult);
                        // Use cloud watchlist items from sync (no double-fetch)
                        cloudWatchlistItems = toCloudWatchlistRefs(syncResult.cloudWatchlistItems);
                    }
                } catch (err) {
                    log.error('Sync on resume failed:', err);
                }
                return { cloudWatchlistItems, readyAt: elapsed() };
            })();

            const changesSeq = await readSeqSafely();
            const indexes = await buildIndexes();
            const catalogReadyAt = elapsed();
            if (!stillCurrent()) return;
            setLightIndexes(indexes);
            markInstalledFromDb(changesSeq);

            // Guard V2: relire le flag partial persisté
            const wasPartial = await getMeta('lastIngestionPartial');
            if (!stillCurrent()) return;
            setLastIngestionPartial(wasPartial === 'true');

            if (indexes.movies.size === 0 && indexes.series.size === 0 && indexes.live.size === 0) {
                log.warn('SQLite appears empty - may need fresh login');
            }

            // Phase 2C : résultat de la vérification lancée au début de la reprise
            const remoteProviderChanged = await remoteProviderCheck;

            // Phase 1.5: détection changement de source (local fallback)
            const lastProvider = await getMeta('lastProvider');
            // Déconnexion pendant les lectures qui précèdent : ni bandeau « source changée », ni
            // identifiants remis en place, ni appel au fournisseur pour une session fermée
            if (!stillCurrent()) return;
            const localProviderChanged = !!(lastProvider && !sameProviderHost(lastProvider, savedCreds.host));

            if (remoteProviderChanged || localProviderChanged) {
                setSourceChanged(true);
            } else {
                setSourceChanged(false);
            }

            // If provider changed remotely → force return to login
            if (remoteProviderChanged) {
                devLog('session', '🔄 Forcing re-login due to remote provider change');
                setIsLoadingSavedData(false);
                return;
            }

            setCredentials(savedCreds);

            // Fetch fresh account info (non-blocking) : vraiment sans attendre désormais. Le code attendait la
            // réponse du fournisseur avant d'afficher l'accueil, alors que ces infos (date d'expiration,
            // connexions) ne servent qu'à la carte « Compte » des Paramètres.
            // Réponse arrivée après une déconnexion ou un changement de compte : ignorée, sinon la carte
            // « Compte » montrerait les infos de la session fermée
            new XtreamApiService(savedCreds).authenticate()
                .then((authResult) => { if (stillCurrent()) setAccountInfo(authResult.user_info); })
                .catch((e) => {
                    // Abonnement expiré ou suspendu : la carte « Compte » affiche quand même son état
                    const info = inactiveAccountInfo(e);
                    if (info && stillCurrent()) setAccountInfo(info as XtreamUserInfo);
                    log.warn('Could not refresh account info:', e);
                });

            // Sync cloud, lancée plus haut (await — watchlist must finish before re-link)
            const currentHash = getLastProviderHash();
            const synced = await cloudSync;
            const cloudWatchlistItems = synced?.cloudWatchlistItems ?? [];
            perfMark('resume-cloud-ready');
            if (!stillCurrent()) return;

            // Langue reçue du cloud : cache TMDB, accueil et fiches suivent
            await applySyncedLanguage();

            // Re-link pass (data-driven, always runs after sync)
            // Non-fatal: relink errors should not break resume
            const relinkStart = elapsed();
            if (currentHash && indexes) {
                await relinkWatchlist(indexes, currentHash, cloudWatchlistItems, stillCurrent, 'resume');
            }
            if (!stillCurrent()) return;

            // Où part le temps de la reprise : catalogue lu, cloud prêt, attente du cloud
            // après le catalogue, re-liaison, total
            const cloudReadyAt = synced?.readyAt ?? catalogReadyAt;
            devLog('session', `✅ Resume terminé (${elapsed()}ms)`, {
                catalogMs: catalogReadyAt,
                cloudMs: cloudReadyAt,
                cloudWaitAfterCatalogMs: Math.max(0, cloudReadyAt - catalogReadyAt),
                relinkMs: elapsed() - relinkStart,
                movies: indexes.movies.size, series: indexes.series.size, live: indexes.live.size,
            });

            // EPG boot tasks (fire-and-forget — ne bloque pas le resume)
            purgeExpiredPrograms().catch(() => {});
            checkAndAutoSync().catch(() => {});

            setIsLoggedIn(true);
            perfMark('resume-done');
            const tab = getHomePage() as TabType;
            setHomeTab(tab);
            // Synchro relancée pendant la session : réseau revenu, retour dans l'app, régulièrement
            const resyncUserId = getCurrentSyncUserId();
            if (resyncUserId) startCloudResync(resyncUserId);
            // Autre source enregistrée sur cet appareil : l'actualisation s'arrêterait à chaque fois
            if (!localProviderChanged) startAutoRefresh(savedCreds);
        } catch (e) {
            // Session fermée pendant la reprise : l'erreur vient de la base fermée, rien à signaler
            if (!stillCurrent()) return;
            log.error('Failed to load saved data:', e);
            // Base abîmée, confirmée par le contrôle : la reprise ne peut pas aboutir, l'écran du fournisseur
            // propose la réinitialisation
            const damaged = isDatabaseDamagedError(e) && await checkLocalDatabase() === 'corrupt';
            if (!stillCurrent()) return;
            setSessionError(t(damaged ? 'common:local_db_damaged_error' : 'common:error_loading_saved'));
        } finally {
            setIsLoadingSavedData(false);
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setters de la session (useState) stables, reçus en paramètre : la règle ne les reconnaît pas
    }, [buildIndexes, t]);

    const refreshSources = useCallback(async (): Promise<void> => {
        setSessionError(null);
        devLog('session', '🔄 Refresh sources...');
        const creds = credentials || await StorageService.getCredentials();
        if (!creds) {
            setSessionError(t('common:no_source_configured'));
            return;
        }

        setIsLoading(true);
        setProgress(0);
        // L'écriture complète remplace l'actualisation en arrière-plan, relancée à la fin
        clearPendingCatalog();
        await stopCatalogAutoRefresh();
        // Pas de synchro en arrière-plan pendant l'écriture complète du catalogue (Ma liste re-liée)
        stopCloudResync();
        await waitForCloudResync();
        const epoch = sessionEpochRef.current;
        const syncUserId = getCurrentSyncUserId();
        // Relances reprises avec une synchro tout de suite : « Rafraîchir » montre aussi ce qui a changé
        // sur les autres appareils (Ma liste, reprises, favoris TV)
        const restartResync = () => { if (syncUserId && !sessionChanged()) startCloudResync(syncUserId, { syncNow: true }); };
        const sessionChanged = () => sessionEpochRef.current !== epoch || getCurrentSyncUserId() !== syncUserId;
        // Abandon : si login, logout ou fullReset a eu lieu, il gère déjà l'indicateur de chargement ;
        // sinon (session Supabase fermée d'elle-même), on l'éteint ici pour ne pas le laisser affiché.
        const abandon = (why: string) => {
            devLog('session', `⏹ Actualisation abandonnée : ${why}`);
            if (sessionEpochRef.current === epoch) {
                setIsLoading(false);
                setProgress(0);
            }
            restartResync();
        };

        // Provider change detection: wipe provider-specific data if host changed
        const lastProvider = await getMeta('lastProvider');
        if (lastProvider && !sameProviderHost(lastProvider, creds.host)) {
            // Pas dans la base d'un autre compte
            if (sessionChanged()) {
                abandon('la session a changé avant l\'effacement des données du fournisseur');
                return;
            }
            devLog('session', '⚠️ Provider changed on refresh');
            const spelling = normalizeProviderHost(creds.host);
            await wipeProviderSpecificData();
            await purgeProviderSpecificCloud(spelling);
            // L'effacement du cloud peut durer : rien n'est noté dans la base d'un autre compte
            if (sessionChanged()) {
                abandon('la session a changé pendant l\'effacement des données du fournisseur');
                return;
            }
            await setMeta('lastProvider', spelling);
            // Empreinte du nouveau fournisseur, notée sur les titres de Ma liste et envoyée au cloud,
            // comme à la connexion
            await setLastProviderHash(spelling);
        }

        try {
            const { indexes, userInfo, partial, failedEndpoints, changesSeq } = await performIngestion(creds, setProgress, () => !sessionChanged());
            if (sessionChanged()) {
                abandon('la session a changé pendant la lecture du catalogue');
                return;
            }
            // Catalogue neuf : accueil recalculé et Ma liste re-liée avant l'affichage, puis tout
            // installé d'un coup (services/catalogReconcile.ts). Réseau permis : on attend déjà.
            const prepared = await prepareRefreshedCatalog(indexes, {
                allowNetwork: true,
                isStillCurrent: () => !sessionChanged(),
            });
            if (sessionChanged()) {
                abandon('la session a changé pendant la préparation');
                return;
            }
            setAccountInfo(userInfo);
            applyRefreshedCatalog(prepared, setLightIndexes);
            markInstalledFromDb(changesSeq);
            // Catalogue relu avec ses liens au guide à la fin de leur recalcul
            announceEpgLinksWhenReady(() => !sessionChanged());
            setProgress(100);
            // Plus d'essai en attente ni de conseil « Actualiser » dans les Paramètres
            if (!partial) await clearAutoRefreshNotes().catch(() => {});
            startAutoRefresh(creds);
            restartResync();

            // Guard V2: persist partial status
            setLastIngestionPartial(partial);
            await setMeta('lastIngestionPartial', String(partial));
            await setMeta('lastFailedEndpoints', JSON.stringify(failedEndpoints));

            if (partial) {
                ingestionLog.warn('⚠ Refresh partiel:', failedEndpoints);
            }

            setTimeout(() => {
                setIsLoading(false);
                setProgress(0);
            }, 500);
        } catch (error) {
            if (sessionChanged()) {
                abandon('la session a changé pendant la lecture du catalogue');
                return;
            }
            log.error('Refresh failed:', error);
            // Abonnement expiré ou suspendu : la carte « Compte » le montre aussi
            const inactiveInfo = inactiveAccountInfo(error);
            if (inactiveInfo) setAccountInfo(inactiveInfo as XtreamUserInfo);
            setSessionError(t(isProviderServerError(error) ? 'auth:error_provider_unavailable'
                : isProviderCertificateError(error) ? 'auth:error_provider_certificate'
                : isProviderAccountInactiveError(error) ? 'auth:error_provider_account_inactive' : 'common:error_refresh'));
            setIsLoading(false);
            setProgress(0);
            // Même session : l'actualisation automatique reprend son cours
            if (!sessionChanged()) startAutoRefresh(creds);
            restartResync();
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setters de la session (useState) stables, reçus en paramètre : la règle ne les reconnaît pas
    }, [credentials, t]);

    const logout = useCallback(async (): Promise<void> => {
        devLog('session', '🚪 Logout');
        sessionEpochRef.current++;
        // La synchro du guide ne déborde plus sur le compte suivant, guide gardé
        stopSyncForSessionChange();
        // Actualisation en arrière-plan arrêtée sans attendre (la connexion suivante, elle, l'attend)
        clearPendingCatalog();
        void stopCatalogAutoRefresh();
        // Chargement complet en cours arrêté côté Rust, sans attendre
        void cancelCatalogIngestion();
        stopCloudResync();
        setSessionError(null);
        // Une actualisation en cours ne se terminera pas dans cette session : pas de chargement laissé affiché
        setIsLoading(false);
        setProgress(0);
        setIsLoggedIn(false);
        setLightIndexes(null);
        resetCatalogCaches();
        setCredentials(null);
        setAccountInfo(null);
        setActiveProfileId(null);
        setSourceChanged(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setters de la session (useState) stables, reçus en paramètre : la règle ne les reconnaît pas
    }, []);

    /**
     * startFresh — Efface les credentials sauvegardées (Keychain) et le flag hasSavedSession.
     *
     * Effet : au prochain sélection de profil, l'auto-resume est bypassé et l'écran
     * Login Xtream s'affiche, permettant à l'utilisateur de se connecter à un autre
     * fournisseur IPTV sans passer par Settings.
     *
     * ⚠️ NON APPELÉ DANS L'UI ACTUELLEMENT (mars 2026).
     * L'ancien bouton "Nouvelle connexion" sur ProfileSelectorPage a été supprimé lors
     * de la refonte Phase 2. La détection de changement de provider se fait désormais
     * automatiquement dans login() (cloud hash + local fallback).
     *
     * TODO: Réintégrer si besoin — ex: bouton discret sur ProfileSelector ou option Settings.
     * La fonction reste fonctionnelle et testée (SessionContext.test.tsx).
     */
    const startFresh = useCallback(async (): Promise<void> => {
        devLog('session', '🧹 Start fresh — suppression données');
        setSessionError(null);
        await StorageService.clearAll();
        setHasSavedSession(false);
        setActiveProfileId(null);
        setSourceChanged(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setters de la session (useState) stables, reçus en paramètre : la règle ne les reconnaît pas
    }, []);

    /** Factory reset: reset complet du state React sans toucher la DB. */
    const fullReset = useCallback((): void => {
        devLog('session', '💥 Full Reset — state React remis à zéro');
        sessionEpochRef.current++;
        stopSyncForSessionChange();
        clearPendingCatalog();
        // Sans attente ici (fonction synchrone) : performFullReset l'attend avant d'effacer la base
        void stopCatalogAutoRefresh();
        stopCloudResync();
        setSessionError(null);
        setIsLoading(false);
        setProgress(0);
        setIsLoggedIn(false);
        setLightIndexes(null);
        resetCatalogCaches();
        setCredentials(null);
        setAccountInfo(null);
        setHasSavedSession(false);
        setActiveProfileId(null);
        setSourceChanged(false);
        savedCredsRef.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setters de la session (useState) stables, reçus en paramètre : la règle ne les reconnaît pas
    }, []);

    const updateCredentials = useCallback(async (newCreds: XtreamCredentials): Promise<void> => {
        // Host changed → provider change flow (dialog + re-login complet)
        if (credentials && !sameProviderHost(credentials.host, newCreds.host)) {
            setPendingProviderChange({ from: credentials.host, to: newCreds.host, creds: newCreds });
            return;
        }
        // Même host → simple re-auth
        const api = new XtreamApiService(newCreds);
        const authResult = await api.authenticate();
        setCredentials(newCreds);
        setAccountInfo(authResult.user_info);
        await StorageService.saveCredentials(newCreds);
        updateAutoRefreshCredentials(newCreds);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setters de la session (useState) stables, reçus en paramètre : la règle ne les reconnaît pas
    }, [credentials]);

    /** Confirmer ou annuler un changement de provider détecté */
    const confirmProviderChange = useCallback(async (accepted: boolean): Promise<void> => {
        if (!pendingProviderChange) return;
        const { creds } = pendingProviderChange;
        setPendingProviderChange(null);

        if (accepted) {
            devLog('session', '✅ Provider change accepted — wiping + re-login');
            providerChangeConfirmedRef.current = true;
            await login(creds);
        } else {
            devLog('session', '❌ Provider change refused — cancelled');
            // Rien n'est effacé : le dire, et pourquoi le dialogue est venu
            setSessionError(t('common:provider_change_cancelled'));
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setters de la session (useState) stables, reçus en paramètre : la règle ne les reconnaît pas ; t non suivi : le message prend la langue du moment où le callback a été créé
    }, [pendingProviderChange, login]);

    const setActiveTabAfterAuth = useCallback((tab: TabType) => {
        setHomeTab(tab);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setters de la session (useState) stables, reçus en paramètre : la règle ne les reconnaît pas
    }, []);

    /** Phase 1.5: Sélectionner un profil actif et persister en meta SQLite */
    const selectProfile = useCallback(async (profileId: string): Promise<void> => {
        setActiveProfileId(profileId);
        // Note dans la base sans laquelle l'app s'ouvre quand même : une base illisible ne bloque plus
        // le choix du profil (chaque clic échouait en silence). Abîmée : contrôlée, l'écran
        // suivant propose la réinitialisation
        try {
            await setMeta('active_profile_id', profileId);
        } catch (e) {
            log.warn('Profil choisi non noté dans la base :', e);
            // Déjà reconnue abîmée au démarrage : pas de nouveau contrôle (il relit tout le fichier)
            if (isDatabaseDamagedError(e) && !isLocalDatabaseDamaged()) await checkLocalDatabase();
        }
        devLog('session', '👤 Profil sélectionné', { profileId });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setters de la session (useState) stables, reçus en paramètre : la règle ne les reconnaît pas
    }, []);

    return {
        // Actions
        login,
        resumeSession,
        refreshSources,
        logout,
        startFresh,
        fullReset,
        updateCredentials,
        confirmProviderChange,
        setActiveTabAfterAuth,
        selectProfile,
        // Refs (exposed for startup effect)
        savedCredsRef,
    };
}
