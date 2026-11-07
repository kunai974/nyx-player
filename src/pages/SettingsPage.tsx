import React, { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useSession } from '../contexts/SessionContext';
import { useSettingsData } from '../hooks/useSettingsData';
import { useSettingsPreferences } from '../hooks/useSettingsPreferences';
import { SettingsSidebar, type SettingsSection } from '../components/Navigation/SettingsSidebar';
import SourcesSection from '../components/Settings/SourcesSection';
import SettingsCarousels from '../components/Settings/SettingsCarousels';
import GeneralSection from '../components/Settings/GeneralSection';
import DataSection from '../components/Settings/DataSection';
import AboutSection from '../components/Settings/AboutSection';
import AccountSection from '../components/Settings/AccountSection';
import GuestAccountSection from '../components/Settings/GuestAccountSection';
import { useSupabaseAuth } from '../contexts/SupabaseAuthContext';
import ResetOptionsModal from '../components/Common/ResetOptionsModal';
import ConfirmModal from '../components/Common/ConfirmModal';
import { useDevOverrides } from '../contexts/DevOverrideContext';
import { useBackHandler } from '../hooks/useBackHandler';
import { isCompactLayout } from '../utils/layout';
import './SettingsPage.css';

// ============================================================================
// TYPES
// ============================================================================
interface SettingsPageProps {
  profileName?: string;
  profileId?: string;
  onProfileRenamed?: () => void;
  /** Affiché en bas de la liste des rubriques sur téléphone (plus de bouton dans la navigation) */
  onLogout?: () => void;
  /** Invité : quitter l'espace invité pour se connecter ou créer un compte */
  onLeaveGuest?: (intent: 'login' | 'register') => void;
}

// ============================================================================
// COMPONENT
// ============================================================================
const SettingsPage: React.FC<SettingsPageProps> = ({ profileName, profileId, onProfileRenamed, onLogout, onLeaveGuest }) => {
  const { isGuest } = useSupabaseAuth();
  const {
    credentials: rawCredentials,
    accountInfo,
    settingsContentCounts: contentCounts,
    iptvStatus,
    isLoading: isRefreshing,
    progress: refreshProgress,
    refreshSources: onRefreshSources,
    updateCredentials: onCredentialsChange,
    lightIndexes,
  } = useSession();

  const credentials = rawCredentials || { host: '', username: '', password: '' };
  const { t } = useTranslation('settings');
  /**
   * Téléphone : la liste des rubriques sert d'écran d'accueil (modèle des réglages Android),
   * `null` = liste affichée. Desktop : barre latérale + rubrique toujours visibles.
   */
  const compact = isCompactLayout();
  const [activeSection, setActiveSection] = useState<SettingsSection | null>(compact ? null : 'sources');
  const showList = !compact || activeSection === null;
  const showSection = !compact || activeSection !== null;
  useBackHandler(compact && activeSection !== null, () => setActiveSection(null));

  // Changer de rubrique ouvre la nouvelle page en haut, pas à la position de la précédente
  const mainRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (mainRef.current) mainRef.current.scrollTop = 0;
  }, [activeSection]);

  // Hooks extraits
  const data = useSettingsData();
  const prefs = useSettingsPreferences();

  // DevPanel — detect active page + read overrides
  const { overrides, setActivePage } = useDevOverrides();
  const sp = overrides.settingsPage;

  useEffect(() => {
    setActivePage('SettingsPage');
  }, [setActivePage]);

  // Apply overrides for SourcesSection
  const effectiveIptvStatus = sp.forceIptvStatus ?? iptvStatus;
  const effectiveIsRefreshing = sp.forceRefreshing || isRefreshing;
  const effectiveRefreshProgress = sp.forceRefreshProgress ?? refreshProgress;

  // =========== RENDER ACTIVE SECTION ===========
  const renderActiveSection = () => {
    switch (activeSection) {
      case 'general':
        return (
          <GeneralSection
            homePage={prefs.homePage}
            onHomePageChange={prefs.handleHomePageChange}
            dnsProvider={prefs.dnsProvider}
            onDnsProviderChange={prefs.handleDnsProviderChange}
            bingeMode={prefs.bingeMode}
            onBingeModeChange={prefs.handleBingeModeChange}
            bingeCountdown={prefs.bingeCountdown}
            onBingeCountdownChange={prefs.handleBingeCountdownChange}
            geekStats={prefs.geekStats}
            onGeekStatsChange={prefs.handleGeekStatsChange}
            hwAccel={prefs.hwAccel}
            hwAccelLoaded={prefs.hwAccelLoaded}
            onHwAccelChange={prefs.handleHwAccelChange}
          />
        );
      case 'dashboard':
        return <SettingsCarousels />;
      case 'sources':
        return (
          <SourcesSection
            credentials={credentials}
            accountInfo={accountInfo}
            contentCounts={contentCounts}
            iptvStatus={effectiveIptvStatus}
            isRefreshing={effectiveIsRefreshing}
            refreshProgress={effectiveRefreshProgress}
            onRefreshSources={() => void onRefreshSources()}
            onCredentialsChange={onCredentialsChange}
            lightIndexes={lightIndexes || undefined}
            forceEditing={sp.forceEditing}
            forceExpiration={sp.forceExpiration}
            forceCategoryManager={sp.forceCategoryManager}
            forceTmdbMovieRate={sp.forceTmdbMovieRate}
            forceTmdbSeriesRate={sp.forceTmdbSeriesRate}
            epgEnabled={prefs.epgEnabled}
            onEpgEnabledChange={prefs.handleEpgEnabledChange}
          />
        );
      case 'data':
        return (
          <DataSection
            cacheStats={data.cacheStats}
            cacheSize={data.cacheSize}
            cacheCleared={data.cacheCleared}
            onResetMovies={() => data.openResetModal('movies')}
            onResetSeries={() => data.openResetModal('series')}
            onFullReset={data.handleFullResetClick}
          />
        );
      case 'about':
        return <AboutSection />;
      case 'account':
        if (isGuest) {
          return <GuestAccountSection onLeaveGuest={onLeaveGuest} onEraseDeviceData={data.handleFullResetClick} />;
        }
        return (
          <AccountSection
            profileName={profileName}
            profileId={profileId}
            onProfileRenamed={onProfileRenamed}
          />
        );
      default:
        return (
          <SourcesSection
            credentials={credentials}
            accountInfo={accountInfo}
            contentCounts={contentCounts}
            iptvStatus={effectiveIptvStatus}
            isRefreshing={effectiveIsRefreshing}
            refreshProgress={effectiveRefreshProgress}
            onRefreshSources={() => void onRefreshSources()}
            onCredentialsChange={onCredentialsChange}
            lightIndexes={lightIndexes || undefined}
            forceEditing={sp.forceEditing}
            forceExpiration={sp.forceExpiration}
            forceCategoryManager={sp.forceCategoryManager}
            forceTmdbMovieRate={sp.forceTmdbMovieRate}
            forceTmdbSeriesRate={sp.forceTmdbSeriesRate}
            epgEnabled={prefs.epgEnabled}
            onEpgEnabledChange={prefs.handleEpgEnabledChange}
          />
        );
    }
  };

  return (
    <div className={`settings-page${compact ? ' settings-page--compact' : ''}`} data-testid="settings-page">
      {showList && (
        <SettingsSidebar
          activeSection={activeSection ?? 'sources'}
          onSelectSection={setActiveSection}
          iptvStatus={effectiveIptvStatus}
          onLogout={compact ? onLogout : undefined}
        />
      )}

      {showSection && (
      <div ref={mainRef} className="settings-main scrollbar-thin">
        {compact && activeSection && (
          <button type="button" className="settings-back" data-testid="settings-back" onClick={() => setActiveSection(null)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="15 18 9 12 15 6" />
            </svg>
            {t(`sidebar_${activeSection}` as 'sidebar_sources')}
          </button>
        )}
        {/* Fondu d'entrée en CSS (SettingsPage.css), rejoué à chaque rubrique grâce à la clé */}
        <div
          key={activeSection}
          className="settings-content settings-content--enter"
          data-testid="settings-content"
          data-section={activeSection ?? undefined}
          // Télécommande : une option, la rangée Rafraîchir / Modifier, un bouton seul ou une ligne du
          // compte = un étage. Les formulaires à champs empilés (.setting-item--form) restent géométriques.
          // `.settings-subsection > *` : ne rien mettre de sélectionnable à côté des options dans ce bloc.
          data-nav-blocks=".settings-option, .settings-section > h3, .settings-subsection > *, .setting-item:not(.setting-item--form)"
        >
          {renderActiveSection()}
        </div>
      </div>
      )}

      <ResetOptionsModal
        isOpen={data.resetModal.isOpen}
        type={data.resetModal.type}
        onConfirm={(options) => void data.handleResetConfirm(options)}
        onCancel={data.closeResetModal}
      />

      <ConfirmModal
        testId="full-reset-modal"
        isOpen={data.showFullResetModal}
        title={t('btn_clear_cache')}
        message={isGuest ? t('guest_confirm_reset') : t('confirm_clear_cache')}
        danger
        // Sans compte, rien n'est au cloud : pas de case « supprimer aussi mes données cloud »
        checkbox={isGuest ? undefined : {
          label: t('purge_cloud_data'),
          hint: t('purge_cloud_data_hint'),
          checked: data.purgeCloud,
          onChange: data.setPurgeCloud,
        }}
        onConfirm={() => void data.executeFullReset()}
        onCancel={data.closeFullResetModal}
      />

      {data.resetError && (
        <div className="settings-toast error" role="alert">
          <span>{data.resetError}</span>
          <button
            type="button"
            className="settings-toast__dismiss"
            data-testid="settings-toast-dismiss"
            onClick={data.dismissResetError}
            aria-label={t('close')}
          >
            ✕
          </button>
        </div>
      )}

      {(data.resetSuccess || sp.forceToast) && (
        <div className="settings-toast success">
          {sp.forceToast || data.resetSuccess}
        </div>
      )}
    </div>
  );
};

export default SettingsPage;
