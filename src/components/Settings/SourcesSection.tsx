/**
 * SourcesSection — Section "Sources IPTV" extraite de SettingsPage.
 *
 * Orchestre l'affichage du header (refresh/edit), l'alerte IPTV,
 * la barre de progression, et délègue aux sous-composants :
 * - SourceForm : formulaire d'édition / affichage credentials
 * - AccountInfoCard : infos compte + stats
 * - EPG Toggle : Guide TV (EPG) ON/OFF
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { XtreamCredentials } from '../../types/iptv';
import type { LightIndexes } from '../../types/lightIndex';
import SourceForm from './SourceForm';
import { isM3uListCredentials } from '../../services/sources/m3uListCredentials';
import TmdbTitleSearchOption from './TmdbTitleSearchOption';
import AccountInfoCard from './AccountInfoCard';
import CategoryManagerModal from './CategoryManagerModal';
import ConfirmModal from '../Common/ConfirmModal';
import NyxButton from '../Common/NyxButton';
import { syncEpg, purgeEpgData, isSyncing, requestSyncAbort, cancelAbort } from '../../services/epgService';
import { isEpgWifiOnly, setEpgWifiOnly } from '../../services/preferencesService';
import { isMobile } from '../../utils/platform';
import { formatTimeAgo } from '../../utils/timeHelpers';
import { getAutoRefreshInfo, setAutoRefreshEnabled } from '../../services/catalogAutoRefresh';
import type { AutoRefreshInfo } from '../../services/catalogAutoRefresh';
import type { EpgProgressEvent } from '../../services/epgService';
import { listen } from '@tauri-apps/api/event';

import { devLog } from '../../utils/devLog';
import { getDatabase, getMeta } from '../../services/dbCore';
import { warnOnReject } from '../../utils/warnOnReject';
import { createLogger } from '../../utils/logger';

const log = createLogger('Settings');

// ============================================================================
// TYPES
// ============================================================================
interface SourcesSectionProps {
    credentials: XtreamCredentials;
    accountInfo: {
        username?: string;
        status?: string;
        exp_date?: string;
        is_trial?: string;
        active_cons?: string;
        max_connections?: string;
        created_at?: string;
    } | null;
    contentCounts?: {
        live: number;
        movies: number;
        series: number;
        uniqueMovies?: number;
        uniqueSeries?: number;
        tmdbMovies?: number;
        tmdbSeries?: number;
        tmdbMovieRate?: number;
        tmdbSeriesRate?: number;
        tmdbMovieTitleRate?: number;
        tmdbSeriesTitleRate?: number;
    };
    iptvStatus?: 'ok' | 'warning' | 'error';
    isRefreshing?: boolean;
    refreshProgress?: number;
    onRefreshSources?: () => void;
    onCredentialsChange?: (creds: XtreamCredentials) => void | Promise<void>;
    lightIndexes?: LightIndexes;
    /** EPG toggle state */
    epgEnabled?: boolean;
    /** EPG toggle change handler */
    onEpgEnabledChange?: (enabled: boolean) => void;
    /** DevPanel: force le mode édition */
    forceEditing?: boolean;
    /** DevPanel: force le statut d'expiration */
    forceExpiration?: 'active' | 'expiring' | 'expired' | null;
    /** DevPanel: force l'ouverture de la modale CategoryManager */
    forceCategoryManager?: boolean;
    /** DevPanel: force le taux TMDB films */
    forceTmdbMovieRate?: number | null;
    /** DevPanel: force le taux TMDB séries */
    forceTmdbSeriesRate?: number | null;
}

// ============================================================================
// HELPERS
// ============================================================================

/** Abbreviate large numbers: 125432 → "125K", 1234 → "1.2K", 342 → "342" */
function formatCompact(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1).replace(/\.0$/, '')}K`;
    return String(n);
}

// ============================================================================
// COMPONENT
// ============================================================================
const SourcesSection: React.FC<SourcesSectionProps> = ({
    credentials,
    accountInfo,
    contentCounts,
    iptvStatus = 'ok',
    isRefreshing = false,
    refreshProgress = 0,
    onRefreshSources,
    onCredentialsChange,
    lightIndexes,
    epgEnabled = false,
    onEpgEnabledChange,
    forceEditing = false,
    forceExpiration = null,
    forceCategoryManager = false,
    forceTmdbMovieRate = null,
    forceTmdbSeriesRate = null,
}) => {
    const { t, i18n } = useTranslation('settings');
    const [isEditingLocal, setIsEditingLocal] = useState(false);
    const [showCategoryManagerLocal, setShowCategoryManagerLocal] = useState(false);
    // Dernier chargement : une liste refusée car démesurée (écrit par sessionSteps)
    const [tooLargeLists, setTooLargeLists] = useState(false);
    useEffect(() => {
        if (iptvStatus === 'ok') return;
        let alive = true;
        getMeta('lastTooLargeLists')
            .then((value) => {
                const lists: unknown = value ? JSON.parse(value) : [];
                if (alive) setTooLargeLists(Array.isArray(lists) && lists.length > 0);
            })
            .catch(() => {});
        return () => { alive = false; };
    }, [iptvStatus]);

    // DevPanel override: forceEditing prend le dessus sur le state local
    const isEditing = forceEditing || isEditingLocal;
    // DevPanel override: forceCategoryManager prend le dessus
    const showCategoryManager = forceCategoryManager || showCategoryManagerLocal;

    // =========== ACTUALISATION AUTOMATIQUE ===========
    const [autoRefresh, setAutoRefresh] = useState<AutoRefreshInfo | null>(null);

    // Relue à l'ouverture et après chaque « Rafraîchir » (qui avance la date)
    useEffect(() => {
        if (isRefreshing) return;
        let cancelled = false;
        getAutoRefreshInfo()
            .then((info) => { if (!cancelled) setAutoRefresh(info); })
            .catch(() => { /* base pas encore prête : ligne masquée */ });
        return () => { cancelled = true; };
    }, [isRefreshing]);

    const handleAutoRefreshToggle = useCallback((enabled: boolean) => {
        setAutoRefresh((prev) => (prev ? { ...prev, enabled } : prev));
        setAutoRefreshEnabled(enabled).catch((e) => log.warn('auto refresh toggle failed:', e));
    }, []);

    // =========== EPG STATE ===========
    const [epgSyncing, setEpgSyncing] = useState(() => isSyncing());
    const [epgError, setEpgError] = useState<string | null>(null);
    const [epgStats, setEpgStats] = useState<{ count: number; matchedCount: number } | null>(null);
    // Effacement du guide en cours (≈ 10 s sur un Chromecast) : l'écran le montre, l'interrupteur attend
    const [epgPurging, setEpgPurging] = useState(false);
    const [showEpgDisableModal, setShowEpgDisableModal] = useState(false);
    const [epgProgress, setEpgProgress] = useState(0);
    const [epgPhase, setEpgPhase] = useState<'download' | 'parse' | 'insert' | 'mapping' | 'done'>('download');

    // Valeur à jour de l'interrupteur pour les tâches longues : une synchro lancée en allumant le guide
    // garde sinon l'état « éteint » du moment de l'appui et ne relit pas les statistiques à sa fin.
    const epgEnabledRef = useRef(epgEnabled);
    useEffect(() => { epgEnabledRef.current = epgEnabled; }, [epgEnabled]);

    const loadEpgStats = useCallback(async () => {
        if (!epgEnabledRef.current) return;
        try {
            const db = await getDatabase();
            const [progRows, matchRows] = await Promise.all([
                db.select<{ cnt: number }[]>('SELECT COUNT(*) as cnt FROM epg_programs'),
                db.select<{ cnt: number }[]>("SELECT COUNT(*) as cnt FROM live WHERE matched_epg_id IS NOT NULL AND matched_epg_id != ''"),
            ]);
            const count = progRows[0]?.cnt ?? 0;
            const matchedCount = matchRows[0]?.cnt ?? 0;
            if (count > 0) {
                setEpgStats({ count, matchedCount });
            }
        } catch {
            // Table may not exist yet — ignore
        }
    }, []);

    // Load last sync stats on mount, and again when the guide is switched on
    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- lecture SQLite asynchrone : l'état n'est modifié qu'après réception
        if (epgEnabled) void loadEpgStats();
    }, [epgEnabled, loadEpgStats]);

    // Listen to Tauri `epg-progress` events to track background syncs
    // (covers auto-sync from checkAndAutoSync which has no JS onProgress callback)
    useEffect(() => {
        if (!epgEnabled) return;

        let unlisten: (() => void) | null = null;
        // Page quittée avant la fin de l'abonnement : l'écouteur est retiré dès son arrivée
        let disposed = false;

        listen<EpgProgressEvent>('epg-progress', (e) => {
            const { phase, progress } = e.payload;
            if (phase === 'done') {
                setEpgSyncing(false);
                setEpgProgress(0);
                void loadEpgStats();
                // Jamais annoncé ici : la fin d'une synchro du guide l'est par epgService, celle
                // d'un recalcul des liens après une lecture du catalogue par la session, Paramètres ouverts
                // ou non (sessionSteps.announceEpgLinksWhenReady)
            } else {
                setEpgSyncing(true);
                setEpgPhase(phase);
                setEpgProgress(progress);
            }
        }).then(fn => {
            if (disposed) fn();
            else unlisten = fn;
        }).catch(warnOnReject('SourcesSection'));

        return () => { disposed = true; unlisten?.(); };
    }, [epgEnabled, loadEpgStats]);

    // =========== EPG HANDLERS ===========
    const handleEpgSync = useCallback(async () => {
        setEpgSyncing(true);
        setEpgError(null);
        setEpgProgress(0);
        setEpgPhase('download');

        const onProgress = (event: EpgProgressEvent) => {
            setEpgPhase(event.phase === 'done' ? 'done' : event.phase);
            setEpgProgress(event.progress);
            devLog('epg', `[${event.phase}] ${event.progress}% — ${event.count} programs`);
        };

        try {
            devLog('epg', 'Starting EPG sync...');
            const result = await syncEpg(onProgress);
            devLog('epg', `EPG sync complete: ${result.programsCount} programs in ${result.durationMs}ms`);
            await loadEpgStats();
        } catch (err) {
            devLog('epg', 'EPG sync failed, retrying...', err);
            // Retry once
            try {
                setEpgPhase('download');
                setEpgProgress(0);
                const result = await syncEpg(onProgress);
                devLog('epg', `EPG retry succeeded: ${result.programsCount} programs`);
                await loadEpgStats();
            } catch (retryErr) {
                devLog('epg', 'EPG retry also failed', retryErr);
                setEpgError(t('epg_sync_error'));
                // Repasser toggle OFF
                onEpgEnabledChange?.(false);
                // Reset syncing state on error since Rust won't emit 'done'
                setEpgSyncing(false);
                setEpgProgress(0);
            }
        } finally {
            // Happy path cleanup is handled by the epg-progress 'done' event listener.
            // Error path is handled in the catch blocks above.
        }
    }, [t, onEpgEnabledChange, loadEpgStats]);

    // Wi-Fi uniquement : évite de consommer un forfait mobile avec les 205 Mo du guide
    const [epgWifiOnly, setEpgWifiOnlyState] = useState(() => isEpgWifiOnly());

    const handleEpgToggle = useCallback((checked: boolean) => {
        // Effacement en cours : l'appui est ignoré (désactiver l'interrupteur lui ferait perdre la sélection TV)
        if (epgPurging) return;
        if (checked) {
            // OFF → ON : activer puis sync
            onEpgEnabledChange?.(true);

            if (isSyncing()) {
                // Rust still running from previous abort → cancel the abort,
                // let it finish naturally. The event listener will track progress.
                cancelAbort();
                setEpgSyncing(true);
                setEpgError(null);
            } else {
                void handleEpgSync();
            }
        } else {
            // ON → OFF : ouvrir modale de confirmation
            setShowEpgDisableModal(true);
        }
    }, [onEpgEnabledChange, handleEpgSync, epgPurging]);

    const handleEpgDisableConfirm = useCallback(async () => {
        setShowEpgDisableModal(false);

        // Si sync en cours, demander l'arrêt + reset UI immédiat
        if (epgSyncing) {
            requestSyncAbort();
            setEpgSyncing(false);
            setEpgProgress(0);
        }

        // Purge + toggle OFF
        setEpgPurging(true);
        try {
            await purgeEpgData();
        } finally {
            setEpgPurging(false);
        }
        onEpgEnabledChange?.(false);
        setEpgStats(null);
        setEpgError(null);
    }, [epgSyncing, onEpgEnabledChange]);



    // =========== RENDER ===========
    return (
        <section className="settings-section">
            <h3>
                <span className="section-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: '1.25rem', height: '1.25rem' }}><path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9" /><path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.4" /><path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.4" /><path d="M19.1 4.9C23 8.8 23 15.2 19.1 19.1" /><circle cx="12" cy="12" r="2" /></svg></span>
                {t('sources_title')}
                {!isEditing && (
                <div className="header-actions">
                        {onRefreshSources && (
                            <NyxButton
                                variant="primary"
                                size="sm"
                                color="blue"
                                onClick={onRefreshSources}
                                data-testid="settings-provider-refresh"
                                disabled={isRefreshing}
                                iconLeft={<svg viewBox="0 0 188.44 156.54" fill="currentColor" style={{ width: '1.25rem', height: '1.25rem', flexShrink: 0 }}><path d="M36.87,73.5c.66-39.86,43.02-69.76,85.26-47.8,8.46,4.4,15.37,11.38,19.75,19.86l17.26-6.62c-6.37-13.4-17.2-24.24-30.59-30.61C73.48-17.85,19.25,21.49,18.6,73.5H0l28.46,27.01,28.46-27.01h-20.06Z"/><path d="M159.97,56.03l-28.46,27.01h20.06c-.66,39.86-43.02,69.76-85.26,47.8-8.46-4.4-15.37-11.38-19.75-19.86l-17.26,6.62c6.37,13.4,17.2,24.24,30.59,30.61,55.06,26.18,109.29-13.16,109.94-65.17h18.6l-28.46-27.01Z"/></svg>}
                            >
                                {t('refresh')}
                            </NyxButton>
                        )}
                        {onCredentialsChange && (
                            <NyxButton
                                variant="primary"
                                size="sm"
                                color="blue"
                                onClick={() => setIsEditingLocal(true)}
                                data-testid="settings-provider-edit"
                            >
                                {t('edit')}
                            </NyxButton>
                        )}
                    </div>
                )}
            </h3>

            {/* IPTV Status Alert Banner */}
            {iptvStatus !== 'ok' && (
                <div className={`iptv-status-alert iptv-status-alert--${iptvStatus}`}>
                    <span className="alert-icon">⚠️</span>
                    <div className="alert-content">
                        <span className="alert-title">{t('iptv_status_warning')}</span>
                        <span className="alert-description">{t(tooLargeLists ? 'iptv_too_large_desc' : 'iptv_warning_desc')}</span>
                    </div>
                </div>
            )}

            {/* Refresh Progress Bar */}
            {isRefreshing && (
                <div className="refresh-progress-container">
                    <div className="refresh-progress-bar">
                        <div
                            className="refresh-progress-fill"
                            style={{ width: `${refreshProgress}%` }}
                        />
                    </div>
                    <span className="refresh-progress-text">
                        {t('loading_refresh')} {refreshProgress}%
                    </span>
                </div>
            )}

            {/* Credentials Form / Read-only Display */}
            <SourceForm
                credentials={credentials}
                isEditing={isEditing}
                onEditingChange={setIsEditingLocal}
                onCredentialsChange={onCredentialsChange}
            />

            {/* Account Info & Stats */}
            <AccountInfoCard
                accountInfo={accountInfo}
                contentCounts={contentCounts}
                forceExpiration={forceExpiration}
                forceTmdbMovieRate={forceTmdbMovieRate}
                forceTmdbSeriesRate={forceTmdbSeriesRate}
                showSubscription={!isM3uListCredentials(credentials)}
            />

            {/* Category Manager Button */}
            {lightIndexes && (
                <div className="settings-subsection">
                    <NyxButton
                        variant="primary"
                        size="sm"
                        color="blue"
                        onClick={() => setShowCategoryManagerLocal(true)}
                        data-testid="settings-manage-categories"
                    >
                        {t('manage_categories')}
                    </NyxButton>
                </div>
            )}

            {/* M3U Manager Placeholder */}
            <div className="settings-subsection placeholder-section">
                <h4>
                    📂 {t('m3u_manager')}
                    <span className="coming-soon-badge">{t('soon_badge')}</span>
                </h4>
                <p className="placeholder-text">
                    {t('m3u_manager_desc')}
                </p>
            </div>

            {/* ===== Actualisation automatique ===== */}
            {/* Liste M3U : relue en entier par « Actualiser », sans actualisation automatique */}
            {autoRefresh && !isM3uListCredentials(credentials) && (
                <div className="settings-subsection">
                    <h4>🔄 {t('auto_refresh_title')}</h4>
                    <div className="settings-options">
                        <div className="settings-option">
                            <div className="option-info">
                                <span className="option-label">{t('auto_refresh_label')}</span>
                                <span className="option-description">{t('auto_refresh_desc')}</span>
                                <span className="option-description">
                                    {autoRefresh.lastUpdate
                                        // eslint-disable-next-line react-hooks/purity -- « il y a … » calculé à l'affichage ; un léger retard tant que la page ne se redessine pas est acceptable
                                        ? t('auto_refresh_last', { when: formatTimeAgo(autoRefresh.lastUpdate, Date.now(), i18n.language) })
                                        : t('auto_refresh_never')}
                                </span>
                                {autoRefresh.lastError && (
                                    <span className="option-description">{t('auto_refresh_failed')}</span>
                                )}
                                {autoRefresh.manualAdvised && (
                                    <span className="option-description">{t('auto_refresh_advice')}</span>
                                )}
                            </div>
                            <label className="toggle-switch">
                                <input
                                    type="checkbox"
                                    checked={autoRefresh.enabled}
                                    data-testid="settings-auto-refresh-toggle"
                                    onChange={(e) => handleAutoRefreshToggle(e.target.checked)}
                                />
                                <span className="toggle-slider"></span>
                            </label>
                        </div>
                    </div>
                </div>
            )}

            {/* ===== Fiches TMDB par le titre (M3U, fournisseurs sans numéro TMDB) ===== */}
            <div className="settings-subsection">
                <h4>{t('tmdb_title_search_title')}</h4>
                <div className="settings-options">
                    <TmdbTitleSearchOption />
                </div>
            </div>

            {/* ===== EPG (Guide TV) Toggle ===== */}
            <div className="settings-subsection">
                <h4>📡 {t('epg_title')}</h4>
                <div className="settings-options">
                    <div className="settings-option">
                        <div className="option-info">
                            <span className="option-label">{t('epg_toggle_label')}</span>
                            <span className="option-description">{t('epg_toggle_desc')}</span>
                        </div>
                        <label className="toggle-switch">
                            <input
                                type="checkbox"
                                checked={epgEnabled}
                                data-testid="settings-epg-toggle"
                                onChange={(e) => handleEpgToggle(e.target.checked)}
                            />
                            <span className="toggle-slider"></span>
                        </label>
                    </div>

                    {epgEnabled && isMobile() && (
                        <div className="settings-option">
                            <div className="option-info">
                                <span className="option-label">{t('epg_wifi_only_label')}</span>
                                <span className="option-description">{t('epg_wifi_only_desc')}</span>
                            </div>
                            <label className="toggle-switch">
                                <input
                                    type="checkbox"
                                    checked={epgWifiOnly}
                                    data-testid="settings-epg-wifi-only-toggle"
                                    onChange={(e) => {
                                        setEpgWifiOnlyState(e.target.checked);
                                        setEpgWifiOnly(e.target.checked).catch(() => {});
                                    }}
                                />
                                <span className="toggle-slider"></span>
                            </label>
                        </div>
                    )}

                    {/* Sync status (only when EPG is ON) */}
                    {epgEnabled && (
                        <div className="epg-status">
                            {epgPurging && (
                                <span className="epg-status-syncing">
                                    <span className="epg-spinner" />
                                    {t('epg_purging')}
                                </span>
                            )}
                            {!epgPurging && epgSyncing && (
                                <span className="epg-status-syncing">
                                    <span className="epg-spinner" />
                                    {epgPhase === 'download'
                                        ? t('epg_syncing_download', { progress: epgProgress })
                                        : epgPhase === 'parse'
                                            ? t('epg_syncing_parse', { progress: epgProgress })
                                            : epgPhase === 'insert'
                                                ? t('epg_syncing_insert', { count: epgProgress })
                                                : epgPhase === 'mapping'
                                                    ? t('epg_syncing_mapping', { progress: epgProgress })
                                                    : t('epg_syncing')}
                                </span>
                            )}
                            {!epgPurging && !epgSyncing && epgError && (
                                <span className="epg-status-error">
                                    ⚠ {epgError}
                                </span>
                            )}
                            {!epgPurging && !epgSyncing && !epgError && epgStats && (
                                <span className="epg-status-ok">
                                    ✓ {t('epg_sync_done', { total: formatCompact(epgStats.count) })}
                                    {epgStats.matchedCount > 0 && (
                                        <> • {t('epg_matched_channels', { count: epgStats.matchedCount })}</>
                                    )}
                                </span>
                            )}
                            {!epgPurging && !epgSyncing && !epgError && !epgStats && (
                                <span className="epg-status-idle">
                                    {t('epg_never_synced')}
                                </span>
                            )}
                        </div>
                    )}
                </div>
            </div>

            {/* EPG Disable Confirm Modal */}
            <ConfirmModal
                testId="epg-disable-modal"
                isOpen={showEpgDisableModal}
                title={t('epg_disable_title')}
                message={t('epg_disable_message')}
                confirmText={t('epg_disable_confirm')}
                danger
                onConfirm={() => void handleEpgDisableConfirm()}
                onCancel={() => setShowEpgDisableModal(false)}
            />

            {/* Category Manager Modal */}
            {lightIndexes && (
                <CategoryManagerModal
                    isOpen={showCategoryManager}
                    onClose={() => setShowCategoryManagerLocal(false)}
                    lightIndexes={lightIndexes}
                />
            )}
        </section>
    );
};

export default SourcesSection;
