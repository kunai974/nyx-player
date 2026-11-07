/**
 * sessionSteps.ts — Étapes du cycle de vie de la session, sans React
 *
 * Sorties de hooks/useSessionLifecycle.ts : ce sont les morceaux qui ne dépendent ni de
 * l'état React ni des refs du hook (lecture du catalogue, changement de fournisseur, re-liaison de
 * Ma liste). Le hook garde l'enchaînement : connexion, reprise, actualisation, déconnexion.
 */

import type { XtreamCredentials } from '../types/iptv';
import type { LightIndexes } from '../types/lightIndex';
import type { XtreamUserInfo } from '../types/xtream';
import { XtreamApiService } from './xtreamApi';
import { ingestCatalog, ingestM3uCatalog, whenEpgLinksReady } from './catalogIngestion';
import { isM3uListCredentials } from './sources/m3uListCredentials';
import { loadLightIndexes } from './catalogLight';
import { setMeta, getMeta, refreshConnection, getDatabase, getDatabaseFileName, isDatabaseOf } from './dbCore';
import { rebuildSearchIndex } from './searchIndex';
import { initPreferences, getLanguage, computeProviderHash, isEpgEnabled } from './preferencesService';
import { normalizeProviderHost, providerHostSpellings, sameProviderHost, typedProviderHostSpellings } from '../utils/providerHost';
import { initLiveTvBookmarks, resetLiveTvBookmarksCache } from './liveTvBookmarksService';
import { initHiddenCategories, resetHiddenCategories } from './hiddenCategoriesService';
import { initPiconCache } from './piconCache';
import { ensureCacheLanguage } from './tmdbCacheSqlite';
import { resetDashboardCache } from './dashboardCache';
import { EPG_UPDATED_EVENT, TMDB_LANGUAGE_EVENT } from './eventConstants';
import { getTmdbLanguage } from '../utils/tmdbLanguage';
import { getCurrentSyncUserId, fetchCloudProviderHash, pushWatchlistUpdates, purgeProviderCloudData } from './syncService';
import { relinkWatchlistStreamIds } from './watchlistRelinking';
import { deviceProviderHash, updateWatchlistOrigins, watchlistRowKey } from './watchlistAvailability';
import { clearBaselines } from './sync/syncBaseline';
import { PROVIDER_DATA_SCOPES, providerTablesOn } from './sync/cloudScope';
import { supabase } from './supabaseClient';
import { noteListsToRetry, startCatalogAutoRefresh } from './catalogAutoRefresh';
import { readChangesSeq } from './catalogSwapGate';
import { devLog } from '../utils/devLog';
import i18next from 'i18next';
import { createLogger } from '../utils/logger';

const log = createLogger('Provider');
const sessionLog = createLogger('Session');

/** Attente maximale de l'effacement du cloud de l'ancien fournisseur à la connexion */
export const PROVIDER_PURGE_WAIT_MS = 10_000;

/** Titre de Ma liste tel que le cloud le connaît, pour la re-liaison */
export type CloudWatchlistRef = { tmdb_id: number; type: 'movie' | 'series'; provider_hash: string | null };

// ============================================================================
// SESSION EN COURS
// ============================================================================

/** Travail abandonné parce que la session a changé (déconnexion, autre compte, autre connexion) */
export class SessionChangedError extends Error {
    constructor() {
        super('Session changed while working');
        this.name = 'SessionChangedError';
    }
}

/**
 * Vrai si la session commencée à `epoch` est toujours là : pas de nouvelle connexion, déconnexion ni
 * remise à zéro, et, pour un compte connu au départ, sa base est toujours celle qui est ouverte.
 */
export function isSessionStill(epochRef: { current: number }, epoch: number, accountId: string | null): boolean {
    return epochRef.current === epoch && (accountId === null || isDatabaseOf(accountId));
}

// ============================================================================
// SHARED HELPERS (used by login, resume, refresh)
// ============================================================================

/**
 * Langue enregistrée dans SQLite (ou reçue du cloud) appliquée à i18next si elle diffère. Attendue :
 * les textes d'une langue se chargent à son premier choix (i18n/config.ts), et la langue TMDB lue
 * juste après doit déjà être la nouvelle.
 */
async function applySavedLanguage(): Promise<void> {
    const savedLang = getLanguage();
    if (savedLang && savedLang !== i18next.resolvedLanguage) {
        await i18next.changeLanguage(savedLang);
    }
}

/**
 * Langue reçue du cloud par la synchro, après le démarrage des services : appliquée comme un
 * changement de langue dans les Paramètres. Le cache TMDB de l'autre langue est vidé, l'accueil
 * et les fiches ouvertes rechargés ; sans cela, la session mélangeait les deux langues jusqu'au
 * lancement suivant. Rien si la langue TMDB ne change pas.
 */
export async function applySyncedLanguage(): Promise<boolean> {
    const savedLang = getLanguage();
    if (!savedLang || savedLang === i18next.resolvedLanguage) return false;
    const tmdbBefore = getTmdbLanguage();
    await i18next.changeLanguage(savedLang);
    if (getTmdbLanguage() === tmdbBefore) return false;
    resetDashboardCache();
    await ensureCacheLanguage(getTmdbLanguage());
    window.dispatchEvent(new Event(TMDB_LANGUAGE_EVENT));
    return true;
}

/** Init services (preferences, bookmarks, picons) */
export async function initServices(): Promise<void> {
    await initPreferences();
    // Force la langue SQLite → i18next IMMÉDIATEMENT (avant le premier render)
    await applySavedLanguage();
    // Cache TMDB rempli dans une autre langue : vidé avant le premier affichage
    await ensureCacheLanguage(getTmdbLanguage());
    await initLiveTvBookmarks();
    await initHiddenCategories();
    await initPiconCache();
}

/** Actualisation toutes les 12 h pour la session qui vient de s'ouvrir */
export function startAutoRefresh(creds: XtreamCredentials): void {
    // L'actualisation en arrière-plan compare les listes de l'API Xtream ; une liste M3U se relit
    // en entier par « Actualiser »
    if (isM3uListCredentials(creds)) return;
    const dbName = getDatabaseFileName();
    if (!dbName) return;
    startCatalogAutoRefresh({ creds, dbName, userId: getCurrentSyncUserId() });
}

/** Compteur des changements écrits en arrière-plan, lu avant de relire le catalogue */
export function readSeqSafely(): Promise<number> {
    return readChangesSeq().catch(() => 0);
}

/**
 * Séquence commune : authenticate → ingest → rebuild indexes. Liste M3U : pas de compte à
 * authentifier (`userInfo` nul), la liste est lue en entier.
 */
export async function performIngestion(
    creds: XtreamCredentials,
    onProgress: (p: number) => void,
    isStillCurrent: () => boolean = () => true,
): Promise<{ indexes: LightIndexes; userInfo: XtreamUserInfo | null; partial: boolean; failedEndpoints: string[]; changesSeq: number }> {
    const m3uList = isM3uListCredentials(creds);
    let userInfo: XtreamUserInfo | null = null;
    if (!m3uList) {
        // Authenticate
        devLog('session', 'Authentification en cours...');
        const api = new XtreamApiService(creds);
        onProgress(5);
        const authResult = await api.authenticate();
        devLog('session', 'Authentification réussie', { status: authResult.user_info.status });
        userInfo = authResult.user_info;
    }

    // Ensure DB exists with all migrations
    await getDatabase();
    onProgress(10);

    // Rust Ingestion
    devLog('data', m3uList ? 'Lecture de la liste M3U en cours...' : 'Ingestion Rust en cours...');
    const ingestStart = performance.now();
    const ingestResult = m3uList
        ? await ingestM3uCatalog(creds.m3u.url, undefined, isStillCurrent)
        : await ingestCatalog(creds.host, creds.username, creds.password, undefined, isStillCurrent);
    devLog('data', `Ingestion Rust terminée (${(performance.now() - ingestStart).toFixed(0)}ms)`, {
        movies: ingestResult.movies_count,
        series: ingestResult.series_count,
        live: ingestResult.live_count,
        categories: ingestResult.categories_count,
        partial: ingestResult.partial,
        failedEndpoints: ingestResult.failed_endpoints,
    });

    // Session fermée pendant la lecture : la base ouverte n'est plus celle de ce catalogue, rien
    // n'y est relu ni écrit (index de recherche, date de mise à jour)
    if (!isStillCurrent()) throw new SessionChangedError();

    // Connexion de la page remplacée après les écritures du Rust (WAL), sans être fermée
    try {
        await refreshConnection();
    } catch (e) {
        // Déconnexion pendant le remplacement : la session a changé, ce n'est pas un échec de lecture
        if (!isStillCurrent()) throw new SessionChangedError();
        throw e;
    }
    onProgress(70);

    // Build Light Indexes (même lecture que buildIndexes du hook)
    devLog('data', 'Construction des indexes...');
    const indexStart = performance.now();
    const changesSeq = await readSeqSafely();
    const indexes = await loadLightIndexes();
    devLog('data', `Indexes construits (${(performance.now() - indexStart).toFixed(0)}ms)`, {
        movies: indexes.movies.size,
        series: indexes.series.size,
        live: indexes.live.size,
    });
    onProgress(90);

    // Build FTS5 search index
    if (!isStillCurrent()) throw new SessionChangedError();
    await rebuildSearchIndex();

    // Save lastUpdate metadata
    if (!isStillCurrent()) throw new SessionChangedError();
    await setMeta('lastUpdate', new Date().toISOString());
    // Listes en échec (films, séries…) retentées par l'actualisation automatique dès sa première
    // vérification, sans attendre 12 h
    await noteListsToRetry(ingestResult.failed_endpoints);
    // Liste refusée car démesurée : les Paramètres le disent au lieu d'une simple « instabilité »
    await setMeta('lastTooLargeLists', JSON.stringify(ingestResult.too_large_endpoints ?? []));

    return { indexes, userInfo, partial: ingestResult.partial, failedEndpoints: ingestResult.failed_endpoints, changesSeq };
}

/**
 * À appeler une fois le catalogue d'une lecture complète installé (connexion, « Actualiser ») : la
 * lecture efface les liens des chaînes au guide, recalculés ensuite en arrière-plan. À la fin de ce
 * recalcul, la mise à jour du guide est annoncée et le catalogue en mémoire est relu avec ses liens
 * (useSessionLifecycle). Seuls les Paramètres l'annonçaient, et seulement s'ils étaient ouverts :
 * guide activé mais Live TV sans programmes jusqu'au redémarrage.
 * Appelé après l'installation, l'annonce vient toujours après elle, même si le recalcul a fini avant.
 */
export function announceEpgLinksWhenReady(isStillCurrent: () => boolean): void {
    void whenEpgLinksReady().then((linked) => {
        if (linked && isStillCurrent() && isEpgEnabled()) window.dispatchEvent(new Event(EPG_UPDATED_EVENT));
    });
}

// ============================================================================
// PROVIDER CHANGE DETECTION — Wipe & Warn (Option A)
// ============================================================================

/**
 * Écriture de l'adresse déjà connue du compte pour ce serveur, d'après une empreinte enregistrée :
 * celle de l'appareil (`lastProvider`) si elle désigne le même serveur, sinon une des écritures
 * plausibles de l'adresse saisie (utils/providerHost.ts). null si l'empreinte est celle d'un autre
 * serveur. Les empreintes notées avant le nettoyage des adresses restent ainsi reconnues.
 */
export async function findKnownProviderSpelling(
    hash: string,
    host: string,
    lastProvider: string | null,
): Promise<string | null> {
    const sameAsDevice = !!lastProvider && sameProviderHost(lastProvider, host);
    const spellings = new Set<string>(sameAsDevice && lastProvider ? [lastProvider, ...providerHostSpellings(lastProvider)] : []);
    for (const spelling of providerHostSpellings(host)) spellings.add(spelling);
    for (const spelling of typedProviderHostSpellings(host)) spellings.add(spelling);
    for (const spelling of spellings) {
        if (await computeProviderHash(spelling) === hash) return spelling;
    }
    return null;
}

/** Fournisseur d'une connexion : changé ou non, et l'écriture de son adresse à noter (empreinte) */
export interface ProviderOnLogin {
    changed: boolean;
    /** Adresse notée dans `lastProvider` et dont l'empreinte part au cloud et sur les titres */
    spelling: string;
}

/**
 * Phase 2B : le fournisseur de cette connexion est-il différent du précédent ? Le cloud d'abord
 * (nouvel appareil), la base locale ensuite (même appareil, hors ligne). Le même serveur écrit
 * autrement (« / » final, majuscule, https) n'est pas un changement : l'écriture déjà connue
 * est gardée, pour que l'empreinte reste celle des données déjà enregistrées.
 */
export async function detectProviderChangeOnLogin(host: string): Promise<ProviderOnLogin> {
    // Base illisible : détection locale impossible, la connexion échouera plus loin avec le bon message
    const lastProvider = await getMeta('lastProvider').catch(() => null);
    let cloudSpelling: string | null = null;

    // 1. Try cloud detection first (covers new device scenario)
    try {
        const { data: { session: supaSession } } = await supabase.auth.getSession();
        if (supaSession?.user) {
            const cloudHash = await fetchCloudProviderHash(supaSession.user.id);
            if (cloudHash) {
                cloudSpelling = await findKnownProviderSpelling(cloudHash, host, lastProvider);
                // Tables par fournisseur : la préférence du cloud ne sert plus qu'à retrouver l'écriture
                // déjà connue du même serveur. Un autre fournisseur y est normal (autre appareil, ancienne
                // version) et n'est pas un changement : rien n'est effacé
                if (!cloudSpelling && !providerTablesOn()) {
                    devLog('session', '⚠️ Provider change detected via CLOUD');
                    return { changed: true, spelling: normalizeProviderHost(host) };
                }
            }
        }
    } catch (e) {
        devLog('session', '⚠️ Cloud provider check failed, falling back to local', e);
    }

    // 2. Fallback: local detection (covers same-device scenario & offline)
    if (lastProvider && !sameProviderHost(lastProvider, host)) {
        devLog('session', '⚠️ Provider change detected via LOCAL');
        return { changed: true, spelling: cloudSpelling ?? normalizeProviderHost(host) };
    }

    return { changed: false, spelling: cloudSpelling ?? lastProvider ?? normalizeProviderHost(host) };
}

/** Empreinte notée pour des titres dont on sait seulement qu'ils viennent d'un fournisseur précédent */
const PREVIOUS_PROVIDER = 'fournisseur-precedent';

/**
 * Ma liste est gardée au changement de fournisseur : chaque ligne sans origine notée est notée comme
 * venant du fournisseur précédent (adresse locale pas encore remplacée à ce moment), pour que l'écran ne prenne pas la
 * fiche qui a repris son numéro pour ce titre (watchlistAvailability.ts). Non bloquant.
 */
async function noteWatchlistOriginBeforeProviderChange(db: Awaited<ReturnType<typeof getDatabase>>): Promise<void> {
    try {
        const rows = await db.select<{ stream_id: number; type: 'movie' | 'series' }[]>('SELECT stream_id, type FROM watchlist');
        const previous = (await deviceProviderHash()) ?? PREVIOUS_PROVIDER;
        await updateWatchlistOrigins(rows.map((row) => [watchlistRowKey(row.stream_id, row.type), previous] as const), { onlyMissing: true });
    } catch (err) {
        log.warn('Origine de Ma liste non notée :', err);
    }
}

/** Wipe les données locales liées au provider (stream_id, category_id) */
export async function wipeProviderSpecificData(): Promise<void> {
    const db = await getDatabase();
    await db.execute('DELETE FROM playback_progress');
    await db.execute('DELETE FROM live_tv_favorites');
    await db.execute('DELETE FROM live_tv_pinned_categories');
    await db.execute(`DELETE FROM content_preferences WHERE content_type = 'player'`);
    try { await db.execute('DELETE FROM hidden_categories'); } catch { /* table may not exist yet */ }
    // Épisodes du fournisseur, rangés par numéro de série : chez le nouveau fournisseur, le même
    // numéro peut être une autre série. Le cache TMDB, lui, ne dépend
    // pas du fournisseur et n'est pas touché (fiches protégées de Ma liste et de Reprendre).
    await db.execute('DELETE FROM xtream_series_cache');
    await noteWatchlistOriginBeforeProviderChange(db);
    resetLiveTvBookmarksCache();
    resetHiddenCategories();
    // Vidé ici et purgé du cloud : le dernier accord avec le cloud ne vaut plus (sync/syncBaseline.ts)
    const syncUserId = getCurrentSyncUserId();
    // Les deux derniers accords de chaque type (tables d'une seule source et par fournisseur)
    if (syncUserId) await clearBaselines(syncUserId, PROVIDER_DATA_SCOPES);
    devLog('session', '🧹 Wiped provider-specific local data (playback, favorites, pins, player prefs, hidden categories, series episodes)');
}

/**
 * Efface du cloud, pour ce compte, les données propres à l'ancien fournisseur, et l'attend : la
 * synchro qui suit ne peut plus les ramener. En cas d'échec (hors ligne), l'effacement reste noté
 * et la synchro le retente avant de toucher à ces données (sync/syncPurge.ts).
 *
 * `newHost` : adresse du NOUVEAU fournisseur. Son empreinte est calculée ici, car l'empreinte de
 * l'appareil (getLastProviderHash) n'est remplacée qu'après cet effacement : les lignes déjà
 * envoyées pour ce fournisseur par un autre appareil sont gardées.
 */
export async function purgeProviderSpecificCloud(newHost?: string): Promise<void> {
    const userId = getCurrentSyncUserId();
    if (!userId) return;
    // Attente bornée : sur un réseau qui ne répond pas, la connexion continue ; l'effacement,
    // resté noté, est terminé ou retenté par la synchro avant de toucher à ces données
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const keepHash = newHost ? await computeProviderHash(newHost) : null;
        await Promise.race([
            purgeProviderCloudData(userId, keepHash),
            new Promise<void>((resolve) => { timer = setTimeout(resolve, PROVIDER_PURGE_WAIT_MS); }),
        ]);
    } catch (err) {
        log.warn('Cloud purge not started:', err);
    } finally {
        clearTimeout(timer);
    }
}

// ============================================================================
// MA LISTE — re-liaison après la synchro (connexion et reprise)
// ============================================================================

/** Titres de Ma liste reçus du cloud par la synchro (no double-fetch) */
export function toCloudWatchlistRefs(
    items: ReadonlyArray<{ tmdb_id: number; media_type: string; provider_hash: string | null }>,
): CloudWatchlistRef[] {
    return items.map(ci => ({
        tmdb_id: ci.tmdb_id,
        type: ci.media_type as 'movie' | 'series',
        provider_hash: ci.provider_hash,
    }));
}

/** Messages des journaux, propres à la connexion ou à la reprise */
const RELINK_LOGS = {
    login: {
        done: '🔗 Watchlist re-linked',
        pushFailed: 'pushWatchlistUpdates failed:',
        relinkFailed: 'Watchlist relink failed (non-fatal):',
    },
    resume: {
        done: '🔗 Resume: watchlist re-linked',
        pushFailed: 'Resume pushWatchlistUpdates failed:',
        relinkFailed: 'Resume watchlist relink failed (non-fatal):',
    },
} as const;

/**
 * Re-liaison de Ma liste au catalogue (data-driven), puis envoi au cloud des titres re-liés.
 * Non bloquante : un échec est journalisé et n'arrête ni la connexion ni la reprise.
 */
export async function relinkWatchlist(
    indexes: LightIndexes,
    currentHash: string,
    cloudWatchlistItems: CloudWatchlistRef[],
    isStillCurrent: () => boolean,
    context: keyof typeof RELINK_LOGS,
): Promise<void> {
    const logs = RELINK_LOGS[context];
    try {
        // Compte dont Ma liste est lue : l'envoi au cloud n'a lieu que s'il est toujours connecté
        const relinkUserId = getCurrentSyncUserId();
        const relinkResult = await relinkWatchlistStreamIds(indexes, currentHash, cloudWatchlistItems, { isStillCurrent });
        devLog('session', logs.done, relinkResult);

        // Push re-linked items to cloud
        if (relinkResult.relinkedItems.length > 0) {
            pushWatchlistUpdates(relinkResult.relinkedItems, relinkUserId).catch(err =>
                sessionLog.warn(logs.pushFailed, err)
            );
        }
    } catch (relinkErr) {
        sessionLog.warn(logs.relinkFailed, relinkErr);
    }
}
