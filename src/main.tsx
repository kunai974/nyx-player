// Doit rester le premier import : prépare le mode preview (DEV) avant l'init Supabase
import { IS_PREVIEW, previewReady } from './dev/preview/bootstrap';
// Capteurs du test de mesure : avant React (version de mesure seulement, vide ailleurs)
import { PERF_ENABLED } from './dev/perfHook';
// Variantes de fluidité (version de mesure seulement, vide ailleurs)
import './dev/perfVariants';
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import ErrorBoundary from './components/Common/ErrorBoundary';
import TvExitNotice from './components/Common/TvExitNotice';
import AppNotice from './components/Common/AppNotice';
import LinkFallback from './components/Common/LinkFallback';
import { SupabaseAuthProvider } from './contexts/SupabaseAuthContext';
import { PlayerProvider } from './contexts/PlayerContext';
import { NavigationProvider } from './contexts/NavigationContext';
import { SessionProvider } from './contexts/SessionContext';
import { UpdaterProvider } from './contexts/UpdaterContext';
import { DevOverrideProvider } from './contexts/DevOverrideContext';
import * as Sentry from '@sentry/react';
import { sentryPrivacyOptions } from './utils/sentryScrub';
import { SENTRY_RELEASE } from './utils/sentryRelease';
import { isAndroid, isMobile, isMobileDevice, isTv, detectDeviceType, setTvMode, setPhoneMode, isTvOverrideEnabled, isPhoneOverrideEnabled } from './utils/platform';
import { applyTvViewport, installDesktopTvZoom, resetDesktopZoom } from './utils/tvScale';
import { installViewportHeightVar } from './utils/viewportHeight';
import { installSpatialNavigation } from './utils/spatialNavigation';
import { resetOnStartup as resetAndroidPlayer } from './services/player/androidPlayer';
import { reportLastAbnormalExit } from './services/androidExitReport';
import { AUDIT_BRIDGE_ENABLED, AuditBridge } from './dev/auditBridge';
// Outils de test branchés sur les prises de l'appli (services/outilsTest.ts) : seule porte d'entrée de src/dev
import './dev/prises';
import { PerfRunner } from './dev/perfRunner/PerfRunner';
import { runStartup } from './utils/startup';
import { finishPendingAccountDeletion } from './services/accountDeletion';
import { warnOnReject } from './utils/warnOnReject';
// --- Fonts embarquées (offline-safe, bundlées par Vite) ---
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/space-grotesk/500.css';
import '@fontsource/space-grotesk/600.css';
import '@fontsource/space-grotesk/700.css';
import './App.css';
import './styles/mobile.css'; // Surcouche téléphone : après App.css, active seulement avec la marque .nyx-mobile
import './styles/tv.css'; // Surcouche Android TV : même principe, marque .nyx-tv
import { i18nReady } from './i18n/config'; // Textes de la langue affichée, chargés avant le premier rendu

/**
 * Marque de plateforme sur <html>, avant le premier rendu : active la bonne surcouche CSS.
 * Le même APK sert au téléphone et à la TV, d'où la détection au démarrage :
 * - `.nyx-mobile` : tactile, mise en page téléphone (styles/mobile.css)
 * - `.nyx-tv` : télécommande, interface 10 pieds (styles/tv.css)
 * Une fenêtre desktop étroite n'est jamais marquée.
 */
function applyPlatformMark(): void {
  if (isTv()) {
    document.documentElement.classList.add('nyx-tv');
    return;
  }
  if (isMobile()) {
    document.documentElement.classList.add('nyx-mobile');
    // Fenêtres ancrées en bas : rester au-dessus du clavier virtuel
    installViewportHeightVar();
  }
}

// --- Sentry — Crash Reporting (conditionnel au DSN) ---
const SENTRY_DSN = import.meta.env.VITE_SENTRY_DSN;
// Versions d'audit (banc de tests automatiques, VITE_AUDIT=1) : Sentry coupé, les erreurs vont dans
// le journal local du banc. Rallumable pour un besoin précis par VITE_AUDIT_SENTRY=1 à la
// compilation, sous l'étiquette « tests-auto ».
// Évalué à la compilation : une version normale garde exactement l'environnement d'avant.
const SENTRY_ENVIRONMENT = import.meta.env.VITE_AUDIT === '1'
  ? (import.meta.env.VITE_AUDIT_SENTRY === '1' ? 'tests-auto' : null)
  : import.meta.env.MODE;
let sentryEnabled = false;
if (SENTRY_DSN && !IS_PREVIEW && SENTRY_ENVIRONMENT) {
  sentryEnabled = true;
  Sentry.init({
    dsn: SENTRY_DSN,
    environment: SENTRY_ENVIRONMENT,
    // Version de l'app jointe à chaque envoi : comparer les erreurs d'une version à l'autre
    release: SENTRY_RELEASE,
    // Masque partout (message, exceptions, extra, contextes, miettes y compris la copie brute des
    // arguments console, requête) : identifiants IPTV, hôte du fournisseur, paramètres d'adresse
    // (Supabase), jetons, identifiants de compte. Retours et transactions : même nettoyage.
    // Détail et tests : utils/sentryScrub.ts
    ...sentryPrivacyOptions(),
  });
}

// Android : raison de la dernière fermeture anormale (plantage du lecteur, app tuée ou figée),
// invisible autrement pour Sentry. Lue une seule fois, sans rien bloquer (services/androidExitReport.ts).
// Sans Sentry (version de banc, aperçu, compilation sans DSN), rien n'est lu ni envoyé.
if (sentryEnabled) void reportLastAbnormalExit();

// ---------------------------------------------------------------------------
// Delayed-show strategy: the Tauri window starts invisible (visible: false in
// tauri.conf.json). React mounts in the background. When the first stable
// screen is ready (Auth page, Profile selector, etc.), we show the window.
// This eliminates 100% of startup flash/FOUC since the user never sees
// intermediate loading states.
// ---------------------------------------------------------------------------
let appShown = false;

/** Pont interne de Tauri (fenêtre Windows) : seule la commande d'affichage est utilisée ici */
type TauriInternals = { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };

declare global {
  // Écran de démarrage retiré par App.tsx quand le premier écran est stable
  interface Window { __hideAppLoader?: () => void }
}

const showApp = () => {
  if (appShown) return;
  appShown = true;
  // Double rAF: ensures the browser has painted the final React screen
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      // Mobile : la fenêtre est toujours visible, show() n'existe pas
      const internals = (window as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__;
      if (internals && !isMobileDevice()) {
        internals.invoke('plugin:window|show', { label: 'main' }).catch(warnOnReject('Window'));
      }
    });
  });
};

// Expose for React (App.tsx calls this when isStable)
window.__hideAppLoader = showApp;
// Safety: show window after 5s even if React fails (so user can see error)
setTimeout(showApp, 5000);

// Suppression du compte interrompue (app fermée avant la réponse du serveur) : le nettoyage local
// est fini avant d'afficher quoi que ce soit (services/accountDeletion.ts)
const startupReady = Promise.all([previewReady, detectDeviceType(), i18nReady]).then(() => finishPendingAccountDeletion());

void runStartup(startupReady, () => {
  // Interface TV sans appareil réel : preview navigateur (?preview=androidtv) ou
  // interrupteur « Mode TV » du DevPanel (app Windows de développement).
  if (IS_PREVIEW && new URLSearchParams(window.location.search).get('preview') === 'androidtv') {
    setTvMode(true);
  } else if (isTvOverrideEnabled()) {
    setTvMode(true);
  } else if (isPhoneOverrideEnabled()) {
    // Interface téléphone sans téléphone : banc de tests (version d'audit) sous Linux ou Windows
    setPhoneMode(true);
  }
  applyPlatformMark();
  if (isTv()) {
    // Toile TV fixe, mise à l'échelle de l'écran (utils/tvScale.ts)
    if (isAndroid()) applyTvViewport();
    else void installDesktopTvZoom();
    installSpatialNavigation();
  } else if (import.meta.env.DEV || import.meta.env.VITE_AUDIT === '1') {
    // Sortie du mode TV forcé (DevPanel, outil de mesure de la version d'audit) : zoom rendu à 1
    void resetDesktopZoom();
  }
  if (isAndroid()) resetAndroidPlayer();
}, () => {
  ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <React.StrictMode>
      <ErrorBoundary context="App">
        <DevOverrideProvider>
          <SupabaseAuthProvider>
            <SessionProvider>
              <PlayerProvider>
                <NavigationProvider>
                  <UpdaterProvider>
                    <App />
                    <AppNotice />
                    <LinkFallback />
                    {isTv() && <TvExitNotice />}
                    {AUDIT_BRIDGE_ENABLED && <AuditBridge />}
                    {PERF_ENABLED && <PerfRunner />}
                  </UpdaterProvider>
                </NavigationProvider>
              </PlayerProvider>
            </SessionProvider>
          </SupabaseAuthProvider>
        </DevOverrideProvider>
      </ErrorBoundary>
    </React.StrictMode>
  );
});

