import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ErrorBoundary from './components/Common/ErrorBoundary';
import logoPrincipalBlanc from './assets/brand/logo-principal-blanc.svg';
import { useTranslation } from 'react-i18next';

import Login from './components/Login';
import ProfileSelectorPage from './pages/ProfileSelectorPage';
import LocalDatabaseDamagedNotice from './components/Common/LocalDatabaseDamagedNotice';
import Sidebar from './components/Navigation/Sidebar';
import TvCategoriesSidebar from './components/Navigation/TvCategoriesSidebar';
import LiveTvMobileBar from './components/Tv/LiveTvMobileBar';
import { isCompactLayout } from './utils/layout';
import PlayerControls from './components/PlayerControls';
import AppRoutes from './components/AppRoutes';
import { MovieDetailPage, SeriesDetailPage, preloadSecondaryPages } from './components/lazyPages';
import { whenIdle } from './utils/lazyPage';
import SupabaseAuthPage from './pages/SupabaseAuthPage';
import TvLinkAccountPage from './pages/TvLinkAccountPage';
import { clearPendingTvLinkProvider } from './services/tvLink/pendingProvider';
import WelcomePage from './pages/WelcomePage';
import { useDevOverrides } from './contexts/DevOverrideContext';
import type { IptvStream } from './types/iptv';
import type { XtreamMovie } from './types/xtream';
import { PREFERENCES_EVENT } from './services/eventConstants';
import { forceMemoryPurge } from './services/memoryService';
import { isEpgEnabled } from './services/preferencesService';
import type { LiveTvViewMode, NavigateToContent } from './types/navigation';

import { getMovieDetail, getSeriesDetail } from './services/detailFetcher';
// Debug tools chargés uniquement en dev (pas de window.debugCache en prod)
if (import.meta.env.DEV) {
  import('./services/initDevTools').catch(warnOnReject('DevTools'));
}

import { useSession } from './contexts/SessionContext';
import { useNavigation } from './contexts/NavigationContext';
import { usePlayer } from './contexts/PlayerContext';
import { useSupabaseAuth } from './contexts/SupabaseAuthContext';
import { useLiveTvCategories } from './hooks/useLiveTvCategories';
import { liveCategoryOf, liveTvLists, visibleLiveCategories } from './services/liveTvLists';
import { useHiddenCategoriesVersion } from './hooks/useHiddenCategoriesVersion';
import { getFavorites } from './services/liveTvBookmarksService';
import { useEpisodeNavigation } from './hooks/useEpisodeNavigation';
import { perfMark } from './utils/perfMarks';
import { useContentNavigation, cancelPendingOpen } from './hooks/useContentNavigation';
import { useUpdater } from './contexts/UpdaterContext';
import UpdateNotification from './components/Common/UpdateNotification';
import { useProfiles } from './hooks/useProfiles';
import ConfirmModal from './components/Common/ConfirmModal';
import PlaybackLaunchError from './components/Player/PlaybackLaunchError';
import { useAndroidBackButton, useBackHandler } from './hooks/useBackHandler';
import { isTv } from './utils/platform';
import { useEcranAudit } from './services/outilsTest';
import { warnOnReject } from './utils/warnOnReject';

// Panneau de développement : chargé seulement en développement, absent du bundle publié
const LazyDevPanel = import.meta.env.DEV ? React.lazy(() => import('./components/DevPanel')) : null;
const DevPanel: React.FC = () => (LazyDevPanel ? <Suspense fallback={null}><LazyDevPanel /></Suspense> : null);

const App: React.FC = () => {
  // Catégories Live TV — téléphone : barre + liste depuis le bas ; TV et desktop : barre latérale
  // (mêmes props). Choisi au rendu, pas au chargement du module : avant la détection de la TV, une
  // TV passe pour un téléphone, et un écran 16:10 (864 px avant la toile 1280) pour un écran compact.
  const TvCategoriesNav = isCompactLayout() ? LiveTvMobileBar : TvCategoriesSidebar;
  const { t } = useTranslation(['common', 'auth', 'navigation']);
  const { session, loading: supabaseLoading, signOut, isGuest, enterGuestMode, leaveGuestMode, sessionExpired } = useSupabaseAuth();
  // Écran de connexion demandé (« Se connecter » de l'accueil TV, ou depuis les réglages d'un invité)
  const [authRequested, setAuthRequested] = useState<'login' | 'register' | 'phone' | null>(null);
  // Connecté : la demande est remplie. Une déconnexion ramène alors à l'accueil, pas à la connexion
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- la demande d'écran de connexion tombe quand un compte se connecte
    if (session) setAuthRequested(null);
  }, [session]);
  const { setActivePage, overrides } = useDevOverrides();
  const xtreamDev = overrides.xtreamPage;
  // Version d'audit seulement : l'outil peut afficher la connexion ou l'ajout du fournisseur, session ouverte
  const auditScreen = useEcranAudit();

  // =========================================================================
  // SESSION STATE (from SessionContext)
  // =========================================================================
  const {
    isLoggedIn,
    isLoading,
    isLoadingSavedData,
    progress,
    hasSavedSession,
    isCheckingSavedSession,
    lightIndexes,
    iptvStatus,
    homeTab,
    sourceChanged,
    login: sessionLogin,
    resumeSession,
    logout: sessionLogout,
    selectProfile: sessionSelectProfile,
    pendingProviderChange,
    confirmProviderChange,
    sessionError,
    clearSessionError,
  } = useSession();

  // =========================================================================
  // PROFILS (Phase 1.5) — hooks/useProfiles.ts
  // =========================================================================
  const {
    profiles,
    profilesLoading,
    profilesError,
    profilesInitialized,
    profileSelected,
    setProfileSelected,
    activeProfileId,
    activeProfile,
    fetchProfiles,
    selectProfile: handleSelectProfile,
    refreshProfiles: handleProfileRenamed,
    resetProfiles,
  } = useProfiles({
    userId: session?.user?.id,
    isLoggedIn,
    hasSavedSession,
    selectSessionProfile: sessionSelectProfile,
    resumeSession,
    guest: isGuest,
    isCheckingSavedSession,
  });

  // =========================================================================
  // EPG VIEW MODE — Guide TV toggle (Phase 4)
  // =========================================================================
  const [viewMode, setViewMode] = useState<LiveTvViewMode>('grid');
  const viewModeRef = useRef(viewMode);
  // eslint-disable-next-line react-hooks/refs -- dernière valeur, lue seulement par l'écouteur des préférences
  viewModeRef.current = viewMode;

  // Guard: reset to grid if EPG disabled while in guide mode
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.key === 'epg_enabled' && detail?.value !== 'true' && viewModeRef.current === 'epg') {
        setViewMode('grid');
      }
    };
    window.addEventListener(PREFERENCES_EVENT, handler);
    return () => window.removeEventListener(PREFERENCES_EVENT, handler);
  }, []);

  const handleViewModeChange = useCallback((mode: LiveTvViewMode) => {
    setViewMode(mode);
    forceMemoryPurge();
  }, []);

  // =========================================================================
  // HIDE HTML STATIC LOADER — only when first stable screen is ready
  // Keeps #app-loader visible during all intermediate React loading states
  // so the user sees: HTML loader → fade → final screen (no cascade)
  // =========================================================================
  useEffect(() => {
    const isStable =
      !supabaseLoading && (
        (!session && !isGuest) ||            // → SupabaseAuthPage (ou l'accueil TV) is ready
        profilesInitialized    // → ProfileSelector (or beyond) is ready
      );
    if (isStable) {
      perfMark('first-screen');
      window.__hideAppLoader?.();
    }
  }, [supabaseLoading, session, isGuest, profilesInitialized]);

  // Pages secondaires préchargées en tâche de fond une fois le catalogue affiché : elles
  // s'ouvrent ensuite sans attente
  // Fournisseur reçu par QR code avec le compte : réservé au premier écran du fournisseur. Si le
  // profil choisi avait déjà sa source, il est oublié, et ne connecte pas un autre profil ensuite
  useEffect(() => {
    if (isLoggedIn) clearPendingTvLinkProvider();
  }, [isLoggedIn]);
  const mainUiReady = isLoggedIn && !!lightIndexes;
  useEffect(() => {
    if (!mainUiReady) return;
    return whenIdle(() => void preloadSecondaryPages());
  }, [mainUiReady]);

  // Déconnexion, depuis l'app comme depuis l'écran des profils : toujours confirmée dans la
  // fenêtre de l'app (charte, télécommande) et non par la boîte confirm() du système
  const [logoutConfirmOpen, setLogoutConfirmOpen] = useState(false);
  const handleLogout = useCallback(() => {
    setLogoutConfirmOpen(true);
  }, []);
  const cancelLogout = useCallback(() => {
    setLogoutConfirmOpen(false);
  }, []);
  // Quitter l'espace invité : les données restent sur l'appareil, l'accueil (ou la connexion) revient
  const leaveGuest = useCallback(async (intent: 'login' | 'register' | null = null) => {
    setLogoutConfirmOpen(false);
    setViewMode('grid');
    await sessionLogout();
    await leaveGuestMode();
    resetProfiles();
    setAuthRequested(intent);
  }, [sessionLogout, leaveGuestMode, resetProfiles]);
  // Entrer en invité : toute session IPTV d'un compte expiré est fermée d'abord (sa source ne passe pas à l'invité)
  const enterGuest = useCallback(async () => {
    await sessionLogout();
    resetProfiles();
    enterGuestMode();
  }, [sessionLogout, resetProfiles, enterGuestMode]);
  const confirmLogout = useCallback(async () => {
    if (isGuest) {
      await leaveGuest(null);
      return;
    }
    setLogoutConfirmOpen(false);
    setViewMode('grid');
    await signOut();
    await sessionLogout();
    resetProfiles();
  }, [isGuest, leaveGuest, sessionLogout, signOut, resetProfiles]);

  // Bandeau « source changée » : suit l'état de la session, effacé à la déconnexion et à la reprise
  // suivante (avant : un état local passé à vrai n'était jamais remis à faux)
  const showSourceWarning = sourceChanged && profileSelected;

  // =========================================================================
  // NAVIGATION STATE (from NavigationContext)
  // =========================================================================
  const {
    activeTab,
    setActiveTab,
    selectedMovie,
    closeMovieDetail,
    selectedSeries,
    closeSeriesDetail,
    categoryDetail,
    navigateToCategory,
    searchQuery,
    setSearchQuery,
    activeCategoryId: _activeCategoryId,
    setActiveCategoryId,
    goBack,
  } = useNavigation();

  // Tab transition overlay state
  const [tabTransitioning, setTabTransitioning] = useState(false);

  // Wrapped goBack for detail pages — uses the same overlay as sidebar transitions
  const handleDetailBack = useCallback(() => {
    // Une fiche demandée juste avant le retour ne s'ouvre plus par-dessus
    cancelPendingOpen();
    setTabTransitioning(true);
    setTimeout(() => {
      goBack();
      setTimeout(() => setTabTransitioning(false), 150);
    }, 150);
  }, [goBack]);

  const { navigateToContent, openMovie } = useContentNavigation();
  // Pour les pages (retour void attendu) : la navigation ne rejette pas, référence stable gardée
  const openContent = useCallback<NavigateToContent>((type, identifier) => {
    void navigateToContent(type, identifier);
  }, [navigateToContent]);

  // Navigate to user's preferred tab after login/resume
  // Guard: skip if already on the right tab (setActiveTab does 5 setState
  // which would unmount/remount DashboardPage → double fetch)
  useEffect(() => {
    if (isLoggedIn && homeTab && homeTab !== activeTab) {
      setActiveTab(homeTab);
    }
    // Voulu : seulement à la connexion ou au changement d'onglet d'accueil. Avec activeTab en
    // dépendance, chaque changement d'onglet ramènerait l'utilisateur sur l'accueil.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- activeTab lu sans abonnement, setActiveTab stable
  }, [isLoggedIn, homeTab]);

  // =========================================================================
  // EXTRACTED HOOKS (Phase 3B)
  // =========================================================================
  const { selectedCategory, setSelectedCategory, pinnedCategories, togglePin } = useLiveTvCategories();

  const {
    playerTitle,
    contentId,
    resolvedTmdbId,
    onNextEpisode,
    onPrevEpisode,
    seriesMetadata,
  } = useEpisodeNavigation(selectedMovie?.tmdbId, t);

  const { currentlyPlaying, mpvConnected, isTransitioningToPlayer, stop } = usePlayer();

  // =========================================================================
  // LIVE TV DATA — Données pour le Channel Switcher (calculé à partir de LightIndexes)
  // =========================================================================
  // Catégories live visibles : recalculées au changement de catalogue ou des catégories masquées,
  // plus à chaque rendu d'App ni à chaque changement de chaîne
  const hiddenCategoriesVersion = useHiddenCategoriesVersion();
  const liveCategoriesVisible = useMemo(
    () => (lightIndexes ? visibleLiveCategories(lightIndexes) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- hiddenCategoriesVersion invalide la liste filtrée
    [lightIndexes, hiddenCategoriesVersion],
  );

  const liveTvData = useMemo(() => {
    if (!currentlyPlaying || !lightIndexes) return undefined;

    // Détection robuste du type 'live' (fallback sur LightIndexes)
    let isLive = false;
    let computedCategoryId = '';

    if ('stream_type' in currentlyPlaying && currentlyPlaying.stream_type === 'live') {
      isLive = true;
      computedCategoryId = liveCategoryOf(lightIndexes, String((currentlyPlaying as IptvStream).category_id));
    } else if (
      'stream_id' in currentlyPlaying &&
      lightIndexes.live.has(Number(currentlyPlaying.stream_id)) &&
      !('episode_num' in currentlyPlaying) &&
      !('series_id' in currentlyPlaying)
    ) {
      isLive = true;
      computedCategoryId = liveCategoryOf(lightIndexes, lightIndexes.live.get(Number(currentlyPlaying.stream_id))!.categoryId);
    }

    if (!isLive) return undefined;

    // Listes du catalogue réutilisées : rien n'est reconstruit au changement de chaîne
    return {
      categories: liveCategoriesVisible,
      streams: liveTvLists(lightIndexes).streams,
      currentChannel: currentlyPlaying as IptvStream,
      currentCategoryId: computedCategoryId,
      favorites: getFavorites(),
      pinnedCategories,
      togglePin,
      totalChannels: lightIndexes.live.size,
    };
  }, [currentlyPlaying, lightIndexes, liveCategoriesVisible, pinnedCategories, togglePin]);

  // =========================================================================
  // APP UPDATER — state & dev overrides (auto-check handled in useAppUpdater)
  // =========================================================================
  const updater = useUpdater();
  const settingsDev = overrides.settingsPage;

  // Dev override: fake updater status for UpdateNotification banner
  const updaterForBanner = settingsDev.forceUpdaterStatus
    ? {
        ...updater,
        status: settingsDev.forceUpdaterStatus,
        version: settingsDev.forceUpdaterStatus === 'available' ? '99.0.0' : updater.version,
        progress: settingsDev.forceUpdaterStatus === 'downloading' ? 42 : updater.progress,
        error: settingsDev.forceUpdaterStatus === 'error' ? 'Simulated update error' : updater.error,
      } as typeof updater
    : updater;

  // =========================================================================
  // DEV PANEL — Track active page for DevPanel toggles
  // =========================================================================
  useEffect(() => {
    if (supabaseLoading) {
      setActivePage('LoadingScreen');
    } else if (!session && !isGuest) {
      setActivePage('SupabaseAuthPage');
    } else if (profilesLoading) {
      setActivePage('ProfileLoading');
    } else if (!profileSelected) {
      setActivePage('ProfileSelectorPage');
    } else if (!isLoggedIn) {
      setActivePage('XtreamLoginPage');
    } else {
      setActivePage('MainApp');
    }
  }, [supabaseLoading, session, isGuest, profilesLoading, profileSelected, isLoggedIn, setActivePage]);

  // =========================================================================
  // ANDROID BACK BUTTON — bas de la pile (player, menus et modals passent avant)
  // =========================================================================
  useAndroidBackButton();
  useBackHandler(true, () => {
    // TV, écran de connexion ouvert depuis l'accueil à deux tuiles : Retour revient à l'accueil
    if (!session && !isGuest && isTv() && authRequested) {
      setAuthRequested(null);
      return;
    }
    // Invité, ajout du fournisseur : Retour fait comme le bouton « Retour à l'accueil »
    if (!isLoggedIn && isGuest) {
      void leaveGuest(null);
      return;
    }
    if (!isLoggedIn) {
      if (session && profileSelected) {
        setProfileSelected(false);
        return;
      }
      return false;
    }
    // Lecture en cours de lancement comprise : un Retour l'annule
    if (currentlyPlaying || isTransitioningToPlayer) {
      void stop();
      return;
    }
    if (selectedMovie || selectedSeries) {
      handleDetailBack();
      return;
    }
    if (categoryDetail) {
      goBack();
      return;
    }
    // TV : Retour ramène sur la barre latérale (dernier recours de la pile), pas sur l'accueil
    if (isTv()) return false;
    const home = homeTab || 'dashboard';
    if (activeTab !== home) {
      setActiveTab(home);
      return;
    }
    return false;
  });

  // Confirmation de la déconnexion (app principale et écran des profils)
  const logoutConfirm = (
    <ConfirmModal
      testId="logout-modal"
      isOpen={logoutConfirmOpen}
      title={isGuest ? t('common:guest_leave_title') : t('navigation:logout')}
      message={isGuest ? t('common:guest_leave_confirm') : t('common:logout_confirm')}
      confirmText={isGuest ? t('common:guest_leave_action') : t('navigation:logout')}
      cancelText={t('common:cancel')}
      danger={false}
      onConfirm={() => void confirmLogout()}
      onCancel={cancelLogout}
    />
  );

  // Écran d'ajout du fournisseur IPTV (Xtream / M3U) : après la sélection du profil sans session
  // IPTV sauvegardée, ou affiché par l'outil d'audit (version d'audit seulement, même déconnecté)
  const renderProviderLogin = (): React.ReactElement => (
    <>
      <div className="container login-wrapper">
        {(sessionError || xtreamDev.forceSessionError) && (
          <div className="session-error-banner" role="alert">
            <span>{xtreamDev.forceSessionError ?? sessionError}</span>
            <button
              type="button"
              className="session-error-banner__dismiss"
              data-testid="session-error-dismiss"
              onClick={clearSessionError}
              aria-label={t('common:dismiss')}
            >
              ✕
            </button>
          </div>
        )}
        {(showSourceWarning || xtreamDev.forceSourceWarning) && (
          <div className="source-warning-banner">
            {t('common:profile_source_changed_warning')}
          </div>
        )}
        <Login
          onLogin={(creds) => void sessionLogin(creds)}
          isLoading={isLoading}
          progress={progress}
          onBackToProfiles={isGuest ? () => void leaveGuest(null) : () => setProfileSelected(false)}
          guest={isGuest}
        />

        {/* Provider Change Confirmation Dialog — must be here for login flow */}
        <ConfirmModal
          testId="provider-change-modal"
          isOpen={!!pendingProviderChange || overrides.settingsPage.forceProviderChange}
          title={t('common:provider_change_title')}
          message={t('common:provider_change_message')}
          confirmText={t('common:provider_change_confirm')}
          cancelText={t('common:provider_change_cancel')}
          danger
          onConfirm={() => void confirmProviderChange(true)}
          onCancel={() => void confirmProviderChange(false)}
        />
        <DevPanel />
      </div>
      <UpdateNotification updater={updaterForBanner} />
    </>
  );

  // =========================================================================
  // SUPABASE AUTH GUARD — Must authenticate before accessing anything
  // (placed after ALL hooks to respect React Rules of Hooks)
  // =========================================================================
  if (supabaseLoading) {
    return (
      <>
        <div className="container loading-screen">
          <div className="loading-screen__content">
            <img src={logoPrincipalBlanc} alt="Nyx Player Logo" className="loading-screen__logo" />
            <p className="loading-screen__text">{t('common:loading')}</p>
          </div>
        </div>
        <DevPanel />
      </>
    );
  }

  // Version d'audit : l'ajout du fournisseur s'affiche à la demande, même sans session (champs vides)
  if (auditScreen === 'provider') {
    return renderProviderLogin();
  }

  // TV sans compte : l'accueil à deux tuiles précède la connexion (sauf session expirée : le message
  // est sur l'écran de connexion)
  if (!session && !isGuest && isTv() && !authRequested && !sessionExpired && auditScreen !== 'account') {
    return (
      <>
        <WelcomePage
          onSignIn={() => setAuthRequested('login')}
          onSignInWithPhone={() => setAuthRequested('phone')}
          onContinueAsGuest={() => void enterGuest()}
        />
        <UpdateNotification updater={updaterForBanner} />
        <DevPanel />
      </>
    );
  }

  // TV, « Avec mon téléphone » : QR code, le compte (et peut-être le fournisseur) saisi sur le téléphone
  if (!session && !isGuest && isTv() && authRequested === 'phone' && auditScreen !== 'account') {
    return (
      <>
        <TvLinkAccountPage onCancel={() => setAuthRequested(null)} />
        <UpdateNotification updater={updaterForBanner} />
        <DevPanel />
      </>
    );
  }

  if ((!session && !isGuest) || auditScreen === 'account') {
    return (
      <>
        <SupabaseAuthPage onContinueAsGuest={() => void enterGuest()} initialMode={authRequested === 'register' ? 'register' : 'login'} />
        <UpdateNotification updater={updaterForBanner} />
        <DevPanel />
      </>
    );
  }

  // =========================================================================
  // RENDER
  // =========================================================================

  if (isLoadingSavedData) {
    return (
      <div className="container loading-screen">
        <div className="loading-screen__content">
          <img src={logoPrincipalBlanc} alt="Nyx Player Logo" className="loading-screen__logo" />
          <p className="loading-screen__text">{t('common:session_loading')}</p>
          <p className="loading-screen__hint">
            {t('common:session_loading_hint')}
          </p>
        </div>
      </div>
    );
  }

  // =========================================================================
  // RENDER — Profile Selector / Login flow (Phase 1.5)
  // =========================================================================

  // Loading profiles. Aussi tant que la session sauvegardée n'est pas lue : un profil choisi avant
  // sa réponse ouvrirait l'ajout du fournisseur, champs vides, au lieu de reprendre la session
  if (profilesLoading || (isCheckingSavedSession && !profileSelected)) {
    return (
      <div className="container loading-screen">
        <div className="loading-screen__content">
          <img src={logoPrincipalBlanc} alt="Nyx Player Logo" className="loading-screen__logo" />
          <p className="loading-screen__text">{t('common:profile_loading')}</p>
        </div>
      </div>
    );
  }

  // Profiles not yet initialized — prevents 1-frame flash of empty ProfileSelectorPage
  if (!profilesInitialized) {
    return (
      <div className="container loading-screen">
        <div className="loading-screen__content">
          <img src={logoPrincipalBlanc} alt="Nyx Player Logo" className="loading-screen__logo" />
          <p className="loading-screen__text">{t('common:profile_loading')}</p>
        </div>
      </div>
    );
  }

  // Error loading profiles
  if (profilesError) {
    return (
      <>
        <div className="container loading-screen">
          <div className="loading-screen__content">
            <img src={logoPrincipalBlanc} alt="Nyx Player Logo" className="loading-screen__logo" />
            <p className="loading-screen__text">{t('common:profile_error_network')}</p>
            {/* Base de l'appareil abîmée : la réinitialisation se fait sans réseau, proposée ici aussi */}
            <LocalDatabaseDamagedNotice testId="profile-error-db" className="profile-error-db-notice" />
            {/* Sans issue si l'échec persiste (session refusée, heure du PC fausse) : la
                déconnexion ramène à l'écran de connexion */}
            <div className="profile-error-actions">
              <button
                type="button"
                className="profile-retry-btn"
                data-testid="profile-error-retry"
                onClick={() => void fetchProfiles()}
              >
                {t('common:profile_retry')}
              </button>
              <button
                type="button"
                className="profile-retry-btn"
                data-testid="profile-error-sign-out"
                onClick={handleLogout}
              >
                {t('common:profile_sign_out')}
              </button>
            </div>
          </div>
        </div>
        {logoutConfirm}
        <UpdateNotification updater={updaterForBanner} />
      </>
    );
  }

  // Profile Selector
  if (!profileSelected) {
    return (
      <>
        <ProfileSelectorPage
          profiles={profiles}
          onSelectProfile={(profileId) => void handleSelectProfile(profileId)}
          onSignOut={handleLogout}
        />
        {logoutConfirm}
        <UpdateNotification updater={updaterForBanner} />
        <DevPanel />
      </>
    );
  }

  // Login Xtream (après sélection profil, pas de session sauvegardée)
  if (!isLoggedIn) {
    return renderProviderLogin();
  }

  // Main app
  return (
    <div className={`container ${currentlyPlaying ? 'player-active' : ''}`} data-testid="main-app">
      {/* Session error banner — refresh errors */}
      {sessionError && (
        <div className="session-error-banner" role="alert">
          <span>{sessionError}</span>
          <button
            type="button"
            className="session-error-banner__dismiss"
            data-testid="session-error-dismiss"
            onClick={clearSessionError}
            aria-label={t('common:dismiss')}
          >
            ✕
          </button>
        </div>
      )}
      {/* Transition overlay */}
      <div
        className={`transition-overlay ${isTransitioningToPlayer ? 'visible' : ''}`}
      />

      {/* Detail Pages */}
      {!currentlyPlaying && (selectedMovie || selectedSeries) && (
        <div className={`detail-overlay ${isTransitioningToPlayer ? 'detail-overlay--transitioning' : ''}`} data-testid="detail-overlay">
          <Suspense fallback={null}>
          {selectedMovie && (
            <ErrorBoundary context="MovieDetail" onClose={handleDetailBack}>
            <MovieDetailPage
              key={`${selectedMovie.tmdbId}-${selectedMovie.versions[0]?.stream_id}`}
              tmdbId={selectedMovie.tmdbId}
              versions={selectedMovie.versions}
              lightIndexes={lightIndexes || undefined}
              onBack={handleDetailBack}
              onLoadVersion={async (streamId: number) => {
                const movie = await getMovieDetail(streamId);
                return movie as XtreamMovie | null;
              }}
              onNavigateToMovie={(tmdbId, streamId) => {
                const lightMovie = lightIndexes?.movies.get(streamId);
                void openMovie({
                  stream_id: streamId,
                  tmdb: tmdbId,
                  name: lightMovie?.name || '',
                  container_extension: lightMovie?.containerExt || undefined,
                } as XtreamMovie);
              }}
            />
            </ErrorBoundary>
          )}

          {selectedSeries && (
            <ErrorBoundary context="SeriesDetail" onClose={handleDetailBack}>
            <SeriesDetailPage
              key={String(selectedSeries.series_id)}
              series={selectedSeries}
              onBack={handleDetailBack}
              onLoadVersion={async (seriesId: number) => {
                return await getSeriesDetail(seriesId);
              }}
            />
            </ErrorBoundary>
          )}
          </Suspense>
        </div>
      )}

      {/* Global page transition overlay — covers ALL content (detail pages + main UI) */}
      <div className={`tab-transition-overlay${tabTransitioning ? ' active' : ''}`} />

      {currentlyPlaying && (
        <div className="player-mode" />
      )}

      {/* Main UI */}
      <div className={`main-ui ${(currentlyPlaying || isTransitioningToPlayer) ? 'is-hidden' : ''}`}>
        <div className="background-layer" />
        <Sidebar
          activeTab={activeTab}
          onTabChange={(tab) => {
            if (tab === activeTab && !selectedMovie && !selectedSeries && !categoryDetail) return;
            setTabTransitioning(true);
            setTimeout(() => {
              setActiveTab(tab);
              setActiveCategoryId('all');
              setSearchQuery('');
              closeSeriesDetail();
              closeMovieDetail();
              setTimeout(() => setTabTransitioning(false), 150);
            }, 150);
          }}
          onLogout={handleLogout}
          iptvStatus={iptvStatus}
        />

        {/* TV Categories Extension — barre compacte sur téléphone, barre latérale sur desktop */}
        {activeTab === 'live' && lightIndexes && lightIndexes.live.size > 0 && (
          <TvCategoriesNav
            categories={liveCategoriesVisible}
            selectedCategory={selectedCategory}
            onSelectCategory={setSelectedCategory}
            pinnedCategoryIds={pinnedCategories}
            onTogglePin={togglePin}
            totalChannels={lightIndexes.live.size}
            viewMode={isEpgEnabled() ? viewMode : undefined}
            onViewModeChange={isEpgEnabled() ? handleViewModeChange : undefined}
          />
        )}

        <main>
          <Suspense fallback={null}>
          <AppRoutes
            activeTab={activeTab}
            categoryDetail={categoryDetail}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            lightIndexes={lightIndexes}
            iptvStatus={iptvStatus}
            navigateToContent={openContent}
            navigateToCategory={(detail) => {
              navigateToCategory({
                categoryId: detail.categoryId,
                categoryName: detail.categoryName,
                items: detail.items as IptvStream[],
                type: detail.type,
              });
            }}
            goBack={goBack}
            liveTvSelectedCategory={selectedCategory}
            liveTvViewMode={viewMode}
            onNavigateToTab={setActiveTab}
            profileName={activeProfile?.display_name}
            profileId={activeProfileId ?? undefined}
            onProfileRenamed={() => void handleProfileRenamed()}
            onLogout={handleLogout}
            onLeaveGuest={(intent) => void leaveGuest(intent)}
            homeCovered={!!(currentlyPlaying || isTransitioningToPlayer || selectedMovie || selectedSeries)}
          />
          </Suspense>
        </main>
      </div>

      {/* Update notification banner */}
      <UpdateNotification updater={updaterForBanner} />

      {/* Player controls overlay */}
      {currentlyPlaying && (
        <ErrorBoundary context="Player" onClose={() => void stop()} closeLabel={t('common:error_boundary_close_player')}>
        <PlayerControls
          key={liveTvData ? 'live-tv-player' : (contentId || 'player')}
          title={playerTitle}
          contentId={contentId}
          tmdbId={resolvedTmdbId}
          onClose={() => void stop()}
          isConnected={mpvConnected}
          onNextEpisode={onNextEpisode}
          onPrevEpisode={onPrevEpisode}
          seriesMetadata={seriesMetadata}
          liveTvData={liveTvData}
        />
        </ErrorBoundary>
      )}

      {/* Lecture qui n'a pas pu démarrer (aucun lecteur ouvert pour afficher l'erreur) */}
      <PlaybackLaunchError />

      {logoutConfirm}

      {/* Provider Change Confirmation Dialog */}
      <ConfirmModal
        testId="provider-change-modal"
        isOpen={!!pendingProviderChange || overrides.settingsPage.forceProviderChange}
        title={t('common:provider_change_title')}
        message={t('common:provider_change_message')}
        confirmText={t('common:provider_change_confirm')}
        cancelText={t('common:provider_change_cancel')}
        danger
        onConfirm={() => void confirmProviderChange(true)}
        onCancel={() => void confirmProviderChange(false)}
      />
      <DevPanel />
    </div>
  );
};

export default App;
