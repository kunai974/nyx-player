import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { openExternalLink } from '../../services/externalLink';
import { getVersion } from '@tauri-apps/api/app';
import { useUpdater } from '../../contexts/UpdaterContext';
import { useDevOverrides } from '../../contexts/DevOverrideContext';
import * as Sentry from '@sentry/react';
import NyxButton from '../Common/NyxButton';
import logoSecondaire from '../../assets/brand/logo-secondaire-blanc.svg';
import logoTmdb from '../../assets/tmdb/tmdb-logo-blue-short.svg';
import checkIcon from '../../assets/icons/check.svg';
import { isAndroid, isMobile } from '../../utils/platform';
import ThirdPartyLicensesModal from './ThirdPartyLicensesModal';
import AndroidUpdateActions from './AndroidUpdateActions';
import { warnOnReject } from '../../utils/warnOnReject';
import { legalNoticesUrl, privacyPolicyUrl, termsUrl } from '../../utils/legalLinks';
import { clickableProps } from '../../utils/clickable';

/** Longueur maximale d'un signalement : 500 coupait les listes de demandes au milieu d'une phrase. */
const REPORT_MAX_LENGTH = 2000;

const LEGAL_BASE_URL = 'https://nyxplayer.app';

// ============================================================================
// COMPONENT
// ============================================================================
const AboutSection: React.FC = () => {
    const { t, i18n } = useTranslation('settings');
    const { t: tCommon } = useTranslation('common');
    const realUpdater = useUpdater();
    const { overrides } = useDevOverrides();
    const sp = overrides.settingsPage;

    // Dev override: fake updater state
    const updater = useMemo(() => ({
        ...realUpdater,
        status: sp.forceUpdaterStatus ?? realUpdater.status,
        version: sp.forceUpdaterStatus === 'available' ? '99.0.0' : realUpdater.version,
    }), [realUpdater, sp.forceUpdaterStatus]);

    // Dynamic version from tauri.conf.json
    const [appVersion, setAppVersion] = useState('...');
    useEffect(() => {
        getVersion().then(v => setAppVersion(v)).catch(warnOnReject('AboutSection'));
    }, []);

    // Local state for the "up to date" message only
    const [upToDateMsg, setUpToDateMsg] = useState<string | null>(null);
    const hasManuallyChecked = React.useRef(false);

    const handleCheckUpdate = useCallback(async () => {
        if (updater.status === 'checking' || updater.status === 'downloading') return;
        // Android : APK prêt, rien à revérifier (après un échec, « Vérifier » repart de zéro)
        if (updater.status === 'ready') return;
        setUpToDateMsg(null);
        hasManuallyChecked.current = true;

        await updater.checkForUpdate();
    }, [updater]);

    // Watch updater status to show "up to date" message after manual check
    useEffect(() => {
        if (updater.status === 'idle' && hasManuallyChecked.current && !sp.forceUpToDateMsg) {
            setUpToDateMsg(tCommon('update_up_to_date'));
            hasManuallyChecked.current = false;
        }
        // Vérification finie sur une mise à jour ou une erreur : « Plus tard » ne dira pas « à jour » ensuite
        if (updater.status === 'available' || updater.status === 'error' || updater.status === 'ready') {
            hasManuallyChecked.current = false;
        }
        // Dev override: force "up to date" message
        if (sp.forceUpToDateMsg) {
            // eslint-disable-next-line react-hooks/set-state-in-effect -- message « à jour » affiché en réaction au statut du service de mise à jour (et au forçage du DevPanel)
            setUpToDateMsg(tCommon('update_up_to_date'));
        }
    }, [updater.status, tCommon, sp.forceUpToDateMsg]);

    // Clear "up to date" message after 5 seconds
    useEffect(() => {
        if (upToDateMsg) {
            const timer = setTimeout(() => setUpToDateMsg(null), 5000);
            return () => clearTimeout(timer);
        }
    }, [upToDateMsg]);

    // ---- Report Bug state ----
    const [showBugForm, setShowBugForm] = useState(false);
    const [showLicenses, setShowLicenses] = useState(false);
    const [bugDescription, setBugDescription] = useState('');
    const [bugSent, setBugSent] = useState(false);

    const handleSubmitBug = useCallback(async () => {
        if (!bugDescription.trim()) return;
        const version = await getVersion();
        Sentry.captureFeedback({
            message: `[v${version}] ${bugDescription}`,
            name: 'Testeur',
        });
        setBugDescription('');
        setShowBugForm(false);
        setBugSent(true);
        setTimeout(() => setBugSent(false), 4000);
    }, [bugDescription]);

    // Des liens en texte : activables aussi à la télécommande, qui ne s'arrête que sur un élément focusable
    const openTerms = () => { void openExternalLink(termsUrl(i18n.resolvedLanguage)); };
    const openPrivacy = () => { void openExternalLink(privacyPolicyUrl(i18n.resolvedLanguage)); };
    const openNotices = () => { void openExternalLink(legalNoticesUrl(i18n.resolvedLanguage)); };

    return (
        <section className="settings-section">
            <h3>
                <span className="section-icon"><svg viewBox="0 0 178.53 178.53" fill="currentColor" style={{ width: '1.25rem', height: '1.25rem', verticalAlign: 'middle' }}><path d="M89.27,0C40.04,0,0,40.04,0,89.27s40.04,89.27,89.27,89.27,89.27-40.04,89.27-89.27S138.49,0,89.27,0ZM89.27,158.53c-38.19,0-69.27-31.07-69.27-69.27S51.07,20,89.27,20s69.27,31.07,69.27,69.27-31.07,69.27-69.27,69.27Z"/><rect x="79.27" y="75.81" width="20" height="61.38"/><rect x="79.27" y="47.17" width="20" height="17.13"/></svg></span>
                {t('about_title')}
            </h3>
            <div className="about-content">
                <img
                    src={logoSecondaire}
                    alt="Nyx Player"
                    className="about-logo-img"
                />
                <p className="about-version">Version {appVersion}</p>
                <p className="about-description">
                    {t('about_desc')}
                </p>
                {/* Mention exigée par les conditions de l'API TMDB : leur logo officiel, plus petit que le
                    nôtre, et leur phrase. En haut de page : lisible sans défilement, y compris à la
                    télécommande où ce bloc ne reçoit pas le focus. */}
                <img
                    src={logoTmdb}
                    alt="TMDB"
                    className="about-tmdb-logo"
                    data-testid="settings-about-tmdb-logo"
                />
                <p className="about-tmdb-notice" data-testid="settings-about-tmdb">
                    {t('tmdb_attribution')}
                </p>

                {/* === UPDATE CHECK (Windows et Android, téléphone et TV ; pas iOS) === */}
                {(!isMobile() || isAndroid()) && (
                <div className="about-update-check">
                    <NyxButton
                        variant="secondary"
                        size="sm"
                        color="blue"
                        onClick={() => void handleCheckUpdate()}
                        data-testid="settings-update-check"
                        // aria-disabled, pas disabled : un bouton désactivé perd le focus de la télécommande
                        // (handleCheckUpdate ignore déjà l'appui pendant une vérification)
                        aria-disabled={updater.status === 'checking' || updater.status === 'downloading'}
                    >
                        {updater.status === 'checking' ? t('update_checking') : t('update_check_button')}
                    </NyxButton>
                    {upToDateMsg && (
                        <span className="about-update-check__result about-update-check__result--success">
                            {upToDateMsg}
                            <img src={checkIcon} alt="" className="about-update-check__icon" />
                        </span>
                    )}
                    {updater.status === 'available' && (
                        <span className="about-update-check__result about-update-check__result--available">
                            {/* eslint-disable-next-line i18next/no-literal-string -- séparateur et numéro de version, sans mot à traduire */}
                            {tCommon('update_available')} — v{updater.version}
                        </span>
                    )}
                    {isAndroid() && <AndroidUpdateActions updater={updater} />}
                </div>
                )}
                <button
                    type="button"
                    className="about-changelog-link"
                    data-testid="settings-changelog"
                    onClick={() => void openExternalLink(`${LEGAL_BASE_URL}/changelog.html`)}
                >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: '0.85rem', height: '0.85rem', marginRight: '0.35rem', verticalAlign: 'middle' }}>
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                        <polyline points="14 2 14 8 20 8" />
                        <line x1="16" y1="13" x2="8" y2="13" />
                        <line x1="16" y1="17" x2="8" y2="17" />
                        <polyline points="10 9 9 9 8 9" />
                    </svg>
                    Changelog
                </button>
                <button
                    type="button"
                    className="about-changelog-link"
                    data-testid="settings-licenses"
                    onClick={() => setShowLicenses(true)}
                >
                    {t('licenses_title')}
                </button>
                <ThirdPartyLicensesModal isOpen={showLicenses} onClose={() => setShowLicenses(false)} />
                {/* === REPORT BUG === */}
                <div className="about-report-bug">
                    <h4>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: '1rem', height: '1rem', marginRight: '0.4rem', verticalAlign: 'middle' }}>
                            <circle cx="12" cy="12" r="10" />
                            <line x1="12" y1="8" x2="12" y2="12" />
                            <line x1="12" y1="16" x2="12.01" y2="16" />
                        </svg>
                        {t('report_bug_title')}
                    </h4>
                    <p className="about-report-bug__desc">{t('report_bug_desc')}</p>
                    {!showBugForm ? (
                        <NyxButton
                            variant="secondary"
                            size="sm"
                            color="red"
                            onClick={() => setShowBugForm(true)}
                            data-testid="settings-report-bug"
                        >
                            {t('report_bug_button')}
                        </NyxButton>
                    ) : (
                        <div className="about-report-bug__form">
                            <textarea
                                className="about-report-bug__textarea"
                                data-testid="settings-report-bug-text"
                                value={bugDescription}
                                onChange={(e) => setBugDescription(e.target.value.slice(0, REPORT_MAX_LENGTH))}
                                placeholder={t('report_bug_placeholder')}
                                rows={4}
                                maxLength={REPORT_MAX_LENGTH}
                                autoFocus
                            />
                            <span className="about-report-bug__counter">
                                {bugDescription.length}/{REPORT_MAX_LENGTH}
                            </span>
                            <div className="about-report-bug__actions">
                                <NyxButton
                                    variant="secondary"
                                    size="sm"
                                    color="red"
                                    onClick={() => void handleSubmitBug()}
                                    data-testid="settings-report-bug-send"
                                    disabled={!bugDescription.trim()}
                                >
                                    {t('report_bug_send')}
                                </NyxButton>
                                <button
                                    type="button"
                                    className="about-report-bug__cancel"
                                    data-testid="settings-report-bug-cancel"
                                    onClick={() => { setShowBugForm(false); setBugDescription(''); }}
                                >
                                    {t('cancel')}
                                </button>
                            </div>
                        </div>
                    )}
                    {bugSent && (
                        <span className="about-report-bug__sent">
                            ✓ {t('report_bug_sent')}
                        </span>
                    )}
                </div>
                <div className="about-legal">
                    <h4><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: '1rem', height: '1rem', marginRight: '0.4rem', verticalAlign: 'middle' }}><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" /></svg>{t('legal_title')}</h4>
                    <div className="legal-links">
                        <span className="legal-link" data-testid="settings-legal-terms" onClick={openTerms} {...clickableProps(openTerms)}>
                            {t('legal_terms')}
                        </span>
                        <span className="legal-link-separator">·</span>
                        <span className="legal-link" data-testid="settings-legal-privacy" onClick={openPrivacy} {...clickableProps(openPrivacy)}>
                            {t('legal_privacy')}
                        </span>
                        <span className="legal-link-separator">·</span>
                        <span className="legal-link" data-testid="settings-legal-notices" onClick={openNotices} {...clickableProps(openNotices)}>
                            {t('legal_notices')}
                        </span>
                    </div>
                </div>
            </div>
        </section>
    );
};

export default AboutSection;
