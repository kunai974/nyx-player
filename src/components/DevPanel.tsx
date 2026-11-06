/**
 * DevPanel — Panneau overlay flottant pour forcer les états visuels en dev.
 *
 * Toggle : Ctrl+Shift+D ou clic sur le bouton ⚙ en bas à droite.
 * Détecte la page active et affiche les toggles pertinents.
 * Visible uniquement en import.meta.env.DEV.
 */

import React, { useEffect, useState, useCallback } from 'react';
import { useDevOverrides, XTREAM_FORCED_ERRORS } from '../contexts/DevOverrideContext';
import type { XtreamForcedError } from '../contexts/DevOverrideContext';
import { isTvOverrideEnabled, TV_OVERRIDE_KEY } from '../utils/platform';
import type { LoginPageOverrides } from '../contexts/DevOverrideContext';
import { invoke } from '@tauri-apps/api/core';
import { getDatabaseFileName } from '../services/dbCore';
import { useTranslation } from 'react-i18next';
import './DevPanel.css';

/** Libellé de chaque erreur Xtream que le panneau sait forcer (le type exige les trois). */
const XTREAM_ERROR_LABELS: Record<XtreamForcedError, string> = {
  error_m3u_missing_info: 'M3U infos manquantes',
  error_m3u_invalid: 'URL M3U invalide',
  error_login_failed: 'Erreur connexion',
};

// ---- Constantes pour les options des selects ----

const ERROR_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: '— Aucune —' },
  { value: 'supabase_error_required', label: 'Champs requis vides' },
  { value: 'supabase_error_password_length', label: 'MDP < 10 chars' },
  { value: 'supabase_error_password_mismatch', label: 'MDP ≠ confirm' },
  { value: 'supabase_error_terms_required', label: 'CGU non acceptées' },
  { value: 'login_incorrect', label: 'Login incorrect (Supabase)' },
  { value: 'supabase_signup_cooldown', label: 'Rate-limit signup' },
  { value: 'supabase_error_resend_failed', label: 'Échec resend' },
  { value: 'supabase_error_forgot_email', label: 'Email requis (forgot)' },
  { value: 'supabase_error_reset_failed', label: 'Échec reset password' },
  { value: 'supabase_brute', label: 'Erreur Supabase brute' },
];

const SUCCESS_OPTIONS: Array<{ value: LoginPageOverrides['forceSuccess'] | ''; label: string }> = [
  { value: '', label: '— Aucun —' },
  { value: 'registered', label: 'Inscription confirmée' },
  { value: 'resent', label: 'Email renvoyé' },
  { value: 'reset_sent', label: 'Lien reset envoyé' },
];

const MODE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: 'Auto' },
  { value: 'login', label: 'Login' },
  { value: 'register', label: 'Register' },
  { value: 'forgot', label: 'Forgot' },
];

const VIEWPORT_PRESETS = [
  { label: '720p', w: 1280, h: 720 },
  { label: '768p', w: 1366, h: 768 },
  { label: '1080p', w: 1920, h: 1080 },
  { label: '1440p', w: 2560, h: 1440 },
  { label: 'UW-FHD', w: 2560, h: 1080 },
  { label: 'UW-QHD', w: 3440, h: 1440 },
];

const TEXT_SCALE_PRESETS = [
  { label: '100%', value: 100 },
  { label: '125%', value: 125 },
  { label: '150%', value: 150 },
  { label: '175%', value: 175 },
  { label: '200%', value: 200 },
];

const DevPanel: React.FC = () => {
  // Interface TV forcée depuis le PC : évite les allers-retours d'APK pour tester la télécommande
  const [tvMode] = useState(() => isTvOverrideEnabled());

  const { overrides, setLoginOverride, resetLoginOverrides, setXtreamOverride, resetXtreamOverrides, setWatchlistOverride, resetWatchlistOverrides, setGlobalSearchOverride, resetGlobalSearchOverrides, setSettingsOverride, resetSettingsOverrides, setLiveTvOverride, resetLiveTvOverrides, setMovieDetailOverride, resetMovieDetailOverrides, setSeriesDetailOverride, resetSeriesDetailOverrides, setDashboardOverride, resetDashboardOverrides, setPlayerControlsOverride, resetPlayerControlsOverrides, isDevMode, resetAll } = useDevOverrides();
  const { i18n } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [viewport, setViewport] = useState({ w: window.innerWidth, h: window.innerHeight });
  const [textScale, setTextScale] = useState(100);
  const [viewportZoom, setViewportZoom] = useState<{ zoom: number; target: string } | null>(null);

  // Keyboard shortcut: Ctrl+Shift+D
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key === 'D') {
        e.preventDefault();
        setIsOpen(prev => !prev);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Viewport size tracking
  useEffect(() => {
    const onResize = () => setViewport({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Resize window via Tauri API — falls back to CSS zoom for resolutions larger than screen
  const resizeWindow = useCallback(async (w: number, h: number, label: string) => {
    const screenW = window.screen.availWidth;
    const screenH = window.screen.availHeight;

    // If target fits on screen, resize normally and clear zoom
    if (w <= screenW && h <= screenH) {
      setViewportZoom(null);
      document.documentElement.style.removeProperty('zoom');
      try {
        const mod = await import('@tauri-apps/api/window');
        const win = mod.getCurrentWindow();
        await win.setSize(new mod.LogicalSize(w, h));
      } catch {
        window.resizeTo(w, h);
      }
      return;
    }

    // Target is larger than screen → maximize window + apply CSS zoom
    try {
      const mod = await import('@tauri-apps/api/window');
      const win = mod.getCurrentWindow();
      await win.maximize();
    } catch {
      // noop
    }

    // Wait for maximize to settle
    await new Promise(r => setTimeout(r, 200));

    // Calculate zoom to make innerWidth/innerHeight match target
    const currentW = window.innerWidth;
    const currentH = window.innerHeight;
    const zoomX = currentW / w;
    const zoomY = currentH / h;
    const zoom = Math.min(zoomX, zoomY);

    document.documentElement.style.setProperty('zoom', String(zoom));
    setViewportZoom({ zoom, target: label });
  }, []);

  // Text Scale simulation — simulates Windows Accessibility "Text size" setting
  // Overrides root font-size to scale all rem units proportionally
  const applyTextScale = useCallback((scale: number) => {
    setTextScale(scale);
    if (scale === 100) {
      document.documentElement.style.removeProperty('font-size');
    } else {
      document.documentElement.style.fontSize = `${16 * (scale / 100)}px`;
    }
  }, []);

  // Reset viewport zoom
  const resetZoom = useCallback(() => {
    setViewportZoom(null);
    document.documentElement.style.removeProperty('zoom');
  }, []);

  // Cleanup text scale + zoom on unmount
  useEffect(() => {
    return () => {
      document.documentElement.style.removeProperty('font-size');
      document.documentElement.style.removeProperty('zoom');
    };
  }, []);

  const handleForceRemap = useCallback(async () => {
    const dbName = getDatabaseFileName();
    if (!dbName) return alert('[DevPanel] No DB found (not logged in)');
    try {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      console.log('[DevPanel] Triggering background EPG remap...');
      await invoke('remap_epg', { dbName });
      console.log('[DevPanel] EPG remap completed');
    } catch (e) {
      alert('[DevPanel] Mapping failed: ' + e);
    }
  }, []);


  // Don't render in production
  if (!isDevMode) return null;

  /**
   * Bascule l'interface Android TV sur cette machine. Le rechargement garantit un état propre :
   * la marque de plateforme, la couche CSS et la navigation directionnelle sont posées au
   * démarrage, et plusieurs composants lisent `isTv()` au rendu.
   */
  const toggleTvMode = (enabled: boolean) => {
    if (enabled === tvMode) return;
    try {
      localStorage.setItem(TV_OVERRIDE_KEY, String(enabled));
    } catch {
      // Stockage indisponible : la bascule ne survivra pas au rechargement
    }
    window.location.reload();
  };

  const lp = overrides.loginPage;
  const xp = overrides.xtreamPage;
  const wp = overrides.watchlistPage;
  const gs = overrides.globalSearchPage;
  const sp = overrides.settingsPage;
  const tv = overrides.liveTvPage;
  const md = overrides.movieDetailPage;
  const sd = overrides.seriesDetailPage;
  const db = overrides.dashboardPage;
  const pc = overrides.playerControls;
  const page = overrides.activePage;

  return (
    <>
      {/* Toggle button */}
      <button
        type="button"
        className={`dev-panel-toggle ${isOpen ? 'dev-panel-toggle--active' : ''}`}
        onClick={() => setIsOpen(v => !v)}
        title="DevPanel (Ctrl+Shift+D)"
        // Hors du parcours clavier / télécommande : outil de développement, raccourci Ctrl+Shift+D
        tabIndex={-1}
      >
        ⚙
      </button>

      {/* Panel */}
      {isOpen && (
        <div className="dev-panel">
          <div className="dev-panel__header">
            <div className="dev-panel__title">
              🛠 DevPanel
              <span className="dev-panel__page-badge">{page}</span>
            </div>
            <button
              type="button"
              className="dev-panel__reset"
              onClick={() => {
                resetAll();
                applyTextScale(100);
                resetZoom();
              }}
            >
              Reset All
            </button>
          </div>

          {/* ---- Viewport section (always visible) ---- */}
          <div className="dev-panel__section">
            <div className="dev-panel__section-title">
              Viewport
              {viewportZoom && <span className="dev-panel__badge-warning">🔍 {viewportZoom.target} ({(viewportZoom.zoom * 100).toFixed(0)}%)</span>}
            </div>
            <div className="dev-panel__row">
              <span className="dev-panel__label">Physique</span>
              <span className="dev-panel__viewport-value">{viewport.w} × {viewport.h}</span>
            </div>
            {viewportZoom && (
              <div className="dev-panel__row">
                <span className="dev-panel__label">Effectif</span>
                <span className="dev-panel__viewport-value" style={{ color: '#fbbf24' }}>
                  {Math.round(viewport.w / viewportZoom.zoom)} × {Math.round(viewport.h / viewportZoom.zoom)}
                </span>
              </div>
            )}
            <div className="dev-panel__row">
              <span className="dev-panel__label">Presets</span>
              <div className="dev-panel__radio-group">
                {VIEWPORT_PRESETS.map(p => (
                  <button
                    key={p.label}
                    type="button"
                    className={`dev-panel__radio ${
                      !viewportZoom && viewport.w === p.w && viewport.h === p.h ? 'dev-panel__radio--active' : ''
                    }${
                      viewportZoom?.target === p.label ? ' dev-panel__radio--active' : ''
                    }`}
                    onClick={() => void resizeWindow(p.w, p.h, p.label)}
                  >
                    {p.label}
                  </button>
                ))}
                {viewportZoom && (
                  <button
                    type="button"
                    className="dev-panel__radio dev-panel__radio--danger"
                    onClick={resetZoom}
                  >
                    ✕ Reset
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* ---- Plateforme (always visible) : tester l'interface TV depuis le PC ---- */}
          <div className="dev-panel__section">
            <div className="dev-panel__section-title">
              Plateforme
              {tvMode && <span className="dev-panel__badge-warning">📺 Mode TV</span>}
            </div>
            <div className="dev-panel__row">
              <span className="dev-panel__label">Interface TV</span>
              <div className="dev-panel__radio-group">
                <button
                  type="button"
                  className={`dev-panel__radio ${tvMode ? 'dev-panel__radio--active' : ''}`}
                  onClick={() => toggleTvMode(true)}
                >
                  Android TV
                </button>
                <button
                  type="button"
                  className={`dev-panel__radio ${tvMode ? '' : 'dev-panel__radio--active'}`}
                  onClick={() => toggleTvMode(false)}
                >
                  Bureau
                </button>
              </div>
            </div>
            {tvMode && (
              <div className="dev-panel__row">
                <span className="dev-panel__label">Télécommande</span>
                <span className="dev-panel__viewport-value">flèches = D-pad · Entrée = OK</span>
              </div>
            )}
          </div>

          {/* ---- Text Scale section (always visible) ---- */}
          <div className="dev-panel__section">
            <div className="dev-panel__section-title">
              Text Scale
              {textScale !== 100 && <span className="dev-panel__badge-warning">⚠ {textScale}%</span>}
            </div>
            <div className="dev-panel__row">
              <span className="dev-panel__label">Échelle</span>
              <div className="dev-panel__radio-group">
                {TEXT_SCALE_PRESETS.map(p => (
                  <button
                    key={p.value}
                    type="button"
                    className={`dev-panel__radio ${
                      textScale === p.value ? 'dev-panel__radio--active' : ''
                    }`}
                    onClick={() => applyTextScale(p.value)}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="dev-panel__row">
              <span className="dev-panel__label">root px</span>
              <span className="dev-panel__viewport-value">{(16 * textScale / 100).toFixed(0)}px (1rem)</span>
            </div>
          </div>

          {/* ---- LoginPage section ---- */}
          {page === 'SupabaseAuthPage' && (
            <>
              {/* Mode */}
              <div className="dev-panel__section">
                <div className="dev-panel__section-title">Mode</div>
                <div className="dev-panel__row">
                  <span className="dev-panel__label">Écran</span>
                  <div className="dev-panel__radio-group">
                    {MODE_OPTIONS.map(opt => (
                      <button
                        key={opt.value}
                        type="button"
                        className={`dev-panel__radio ${
                          (lp.forceMode ?? '') === opt.value ? 'dev-panel__radio--active' : ''
                        }`}
                        onClick={() => setLoginOverride(
                          'forceMode',
                          opt.value === '' ? null : opt.value as LoginPageOverrides['forceMode'],
                        )}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Erreurs */}
              <div className="dev-panel__section">
                <div className="dev-panel__section-title">Erreurs</div>
                <div className="dev-panel__row">
                  <span className="dev-panel__label">Type</span>
                  <select
                    className="dev-panel__select"
                    value={lp.forceError ?? ''}
                    onChange={e => setLoginOverride('forceError', e.target.value || null)}
                  >
                    {ERROR_OPTIONS.map(opt => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                </div>
                <div className="dev-panel__row">
                  <span className="dev-panel__label">Texte long</span>
                  <ToggleSwitch
                    on={lp.forceLongError}
                    onToggle={v => setLoginOverride('forceLongError', v)}
                  />
                </div>
              </div>

              {/* Succès */}
              <div className="dev-panel__section">
                <div className="dev-panel__section-title">Succès</div>
                <div className="dev-panel__row">
                  <span className="dev-panel__label">Type</span>
                  <select
                    className="dev-panel__select"
                    value={lp.forceSuccess ?? ''}
                    onChange={e => setLoginOverride(
                      'forceSuccess',
                      (e.target.value || null) as LoginPageOverrides['forceSuccess'],
                    )}
                  >
                    {SUCCESS_OPTIONS.map(opt => (
                      <option key={opt.value ?? 'none'} value={opt.value ?? ''}>{opt.label}</option>
                    ))}
                  </select>
                </div>
                <div className="dev-panel__row">
                  <span className="dev-panel__label">Email enregistré</span>
                  <ToggleSwitch
                    on={lp.forceLastRegisteredEmail !== null}
                    onToggle={v => {
                      setLoginOverride('forceLastRegisteredEmail', v ? 'test@example.com' : null);
                      // Auto-dep : afficher un succès pour que le bouton resend soit visible
                      if (v && !lp.forceSuccess) setLoginOverride('forceSuccess', 'registered');
                    }}
                  />
                </div>
              </div>

              {/* Loading */}
              <div className="dev-panel__section">
                <div className="dev-panel__section-title">Loading</div>
                <div className="dev-panel__row">
                  <span className="dev-panel__label">Submit</span>
                  <ToggleSwitch
                    on={lp.forceLoadingSubmit}
                    onToggle={v => setLoginOverride('forceLoadingSubmit', v)}
                  />
                </div>
                <div className="dev-panel__row">
                  <span className="dev-panel__label">Forgot</span>
                  <ToggleSwitch
                    on={lp.forceLoadingForgot}
                    onToggle={v => {
                      setLoginOverride('forceLoadingForgot', v);
                      // Auto-dep : basculer en mode forgot pour voir la section
                      if (v && lp.forceMode !== 'forgot') setLoginOverride('forceMode', 'forgot');
                    }}
                  />
                </div>
                <div className="dev-panel__row">
                  <span className="dev-panel__label">Resend</span>
                  <ToggleSwitch
                    on={lp.forceLoadingResend}
                    onToggle={v => {
                      setLoginOverride('forceLoadingResend', v);
                      // Auto-dep : besoin d'un succès + email pour voir le bouton resend
                      if (v) {
                        if (!lp.forceSuccess) setLoginOverride('forceSuccess', 'registered');
                        if (!lp.forceLastRegisteredEmail) setLoginOverride('forceLastRegisteredEmail', 'test@example.com');
                      }
                    }}
                  />
                </div>
              </div>

              {/* Interactifs */}
              <div className="dev-panel__section">
                <div className="dev-panel__section-title">Interactifs</div>
                <div className="dev-panel__row">
                  <span className="dev-panel__label">Suggestion email</span>
                  <ToggleSwitch
                    on={lp.forceEmailSuggestion !== null}
                    onToggle={v => setLoginOverride(
                      'forceEmailSuggestion',
                      v ? 'user@gmail.com' : null,
                    )}
                  />
                </div>
                <div className="dev-panel__row">
                  <span className="dev-panel__label">Cooldown signup</span>
                  <ToggleSwitch
                    on={lp.forceSignupCooldown !== null}
                    onToggle={v => setLoginOverride(
                      'forceSignupCooldown',
                      v ? 45 : null,
                    )}
                  />
                </div>
                <div className="dev-panel__row">
                  <span className="dev-panel__label">Resend cooldown</span>
                  <ToggleSwitch
                    on={lp.forceResendCooldown}
                    onToggle={v => {
                      setLoginOverride('forceResendCooldown', v);
                      // Auto-dep : besoin d'un succès + email pour voir le bouton resend
                      if (v) {
                        if (!lp.forceSuccess) setLoginOverride('forceSuccess', 'registered');
                        if (!lp.forceLastRegisteredEmail) setLoginOverride('forceLastRegisteredEmail', 'test@example.com');
                      }
                    }}
                  />
                </div>
                <div className="dev-panel__row">
                  <span className="dev-panel__label">CGU cochée</span>
                  <ToggleSwitch
                    on={lp.forceAcceptTerms === true}
                    onToggle={v => setLoginOverride('forceAcceptTerms', v ? true : null)}
                  />
                </div>
              </div>

              {/* NyxButton */}
              <div className="dev-panel__section">
                <div className="dev-panel__section-title">NyxButton</div>
                <div className="dev-panel__row">
                  <span className="dev-panel__label">Variante</span>
                  <div className="dev-panel__radio-group">
                    {([
                      { value: '', label: 'Auto' },
                      { value: 'primary', label: 'Primary' },
                      { value: 'secondary', label: 'Secondary' },
                    ] as const).map(opt => (
                      <button
                        key={opt.value}
                        type="button"
                        className={`dev-panel__radio ${
                          (lp.forceButtonVariant ?? '') === opt.value ? 'dev-panel__radio--active' : ''
                        }`}
                        onClick={() => setLoginOverride(
                          'forceButtonVariant',
                          opt.value === '' ? null : opt.value as 'primary' | 'secondary',
                        )}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="dev-panel__row">
                  <span className="dev-panel__label">Taille</span>
                  <div className="dev-panel__radio-group">
                    {([
                      { value: '', label: 'Auto' },
                      { value: 'medium', label: 'Medium' },
                      { value: 'small', label: 'Small' },
                    ] as const).map(opt => (
                      <button
                        key={opt.value}
                        type="button"
                        className={`dev-panel__radio ${
                          (lp.forceButtonSize ?? '') === opt.value ? 'dev-panel__radio--active' : ''
                        }`}
                        onClick={() => setLoginOverride(
                          'forceButtonSize',
                          opt.value === '' ? null : opt.value as 'md' | 'sm',
                        )}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="dev-panel__row">
                  <span className="dev-panel__label">Couleur</span>
                  <div className="dev-panel__radio-group">
                    {([
                      { value: '', label: 'Auto' },
                      { value: 'blue', label: 'Blue' },
                      { value: 'blue-light', label: 'B.Light' },
                      { value: 'red', label: 'Red' },
                    ] as const).map(opt => (
                      <button
                        key={opt.value}
                        type="button"
                        className={`dev-panel__radio ${
                          (lp.forceButtonColor ?? '') === opt.value ? 'dev-panel__radio--active' : ''
                        }`}
                        onClick={() => setLoginOverride(
                          'forceButtonColor',
                          opt.value === '' ? null : opt.value as 'blue' | 'blue-light' | 'red',
                        )}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Update Banner */}
              <div className="dev-panel__section">
                <div className="dev-panel__section-title">Update Banner</div>
                <div className="dev-panel__row">
                  <span className="dev-panel__label">Statut</span>
                  <div className="dev-panel__radio-group">
                    {[
                      { value: '', label: 'Auto' },
                      { value: 'available', label: 'Dispo' },
                      { value: 'downloading', label: 'DL' },
                      { value: 'ready', label: 'Prêt' },
                      { value: 'error', label: 'Erreur' },
                    ].map(opt => (
                      <button
                        key={opt.value}
                        type="button"
                        className={`dev-panel__radio ${
                          (sp.forceUpdaterStatus ?? '') === opt.value ? 'dev-panel__radio--active' : ''
                        }`}
                        onClick={() => setSettingsOverride(
                          'forceUpdaterStatus',
                          opt.value === '' ? null : opt.value as 'available' | 'downloading' | 'ready' | 'error',
                        )}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Reset section */}
              <div className="dev-panel__section">
                <button
                  type="button"
                  className="dev-panel__reset dev-panel__reset--full"
                  onClick={resetLoginOverrides}
                >
                  Reset LoginPage
                </button>
              </div>
            </>
          )}

          {/* ---- ProfileSelector section ---- */}
          {page === 'ProfileSelectorPage' && (
            <>
              {/* Update Banner */}
              <div className="dev-panel__section">
                <div className="dev-panel__section-title">Update Banner</div>
                <div className="dev-panel__row">
                  <span className="dev-panel__label">Statut</span>
                  <div className="dev-panel__radio-group">
                    {[
                      { value: '', label: 'Auto' },
                      { value: 'available', label: 'Dispo' },
                      { value: 'downloading', label: 'DL' },
                      { value: 'ready', label: 'Prêt' },
                      { value: 'error', label: 'Erreur' },
                    ].map(opt => (
                      <button
                        key={opt.value}
                        type="button"
                        className={`dev-panel__radio ${
                          (sp.forceUpdaterStatus ?? '') === opt.value ? 'dev-panel__radio--active' : ''
                        }`}
                        onClick={() => setSettingsOverride(
                          'forceUpdaterStatus',
                          opt.value === '' ? null : opt.value as 'available' | 'downloading' | 'ready' | 'error',
                        )}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </>
          )}

          {/* ---- Xtream Login section ---- */}
          {page === 'XtreamLoginPage' && (
            <>
              {/* Mode */}
              <div className="dev-panel__section">
                <div className="dev-panel__section-title">Mode Xtream</div>
                <div className="dev-panel__row">
                  <span className="dev-panel__label">Onglet</span>
                  <div className="dev-panel__radio-group">
                    {[
                      { value: '', label: 'Auto' },
                      { value: 'xtream', label: 'Xtream' },
                      { value: 'm3u', label: 'M3U' },
                    ].map(opt => (
                      <button
                        key={opt.value}
                        type="button"
                        className={`dev-panel__radio ${
                          (xp.forceMode ?? '') === opt.value ? 'dev-panel__radio--active' : ''
                        }`}
                        onClick={() => setXtreamOverride(
                          'forceMode',
                          opt.value === '' ? null : opt.value as 'xtream' | 'm3u',
                        )}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Loading */}
              <div className="dev-panel__section">
                <div className="dev-panel__section-title">Loading</div>
                <div className="dev-panel__row">
                  <span className="dev-panel__label">isLoading</span>
                  <ToggleSwitch
                    on={xp.forceLoading}
                    onToggle={v => setXtreamOverride('forceLoading', v)}
                  />
                </div>
                <div className="dev-panel__row">
                  <span className="dev-panel__label">Progress %</span>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    step="5"
                    value={xp.forceProgress ?? 0}
                    onChange={e => {
                      const val = Number(e.target.value);
                      setXtreamOverride('forceProgress', val > 0 ? val : null);
                      if (val > 0 && !xp.forceLoading) setXtreamOverride('forceLoading', true);
                    }}
                    className="dev-panel__slider"
                  />
                  <span className="dev-panel__slider-value">{xp.forceProgress ?? 0}%</span>
                </div>
              </div>

              {/* Erreurs */}
              <div className="dev-panel__section">
                <div className="dev-panel__section-title">Erreurs</div>
                <div className="dev-panel__row">
                  <span className="dev-panel__label">Erreur form</span>
                  <select
                    className="dev-panel__select"
                    value={xp.forceError ?? ''}
                    onChange={e => setXtreamOverride('forceError', XTREAM_FORCED_ERRORS.find(k => k === e.target.value) ?? null)}
                  >
                    <option value="">— Aucune —</option>
                    {XTREAM_FORCED_ERRORS.map(k => <option key={k} value={k}>{XTREAM_ERROR_LABELS[k]}</option>)}
                  </select>
                </div>
              </div>

              {/* Banners (App.tsx) */}
              <div className="dev-panel__section">
                <div className="dev-panel__section-title">Banners (App.tsx)</div>
                <div className="dev-panel__row">
                  <span className="dev-panel__label">Source warning</span>
                  <ToggleSwitch
                    on={xp.forceSourceWarning}
                    onToggle={v => setXtreamOverride('forceSourceWarning', v)}
                  />
                </div>
                <div className="dev-panel__row">
                  <span className="dev-panel__label">Session error</span>
                  <ToggleSwitch
                    on={xp.forceSessionError !== null}
                    onToggle={v => setXtreamOverride(
                      'forceSessionError',
                      v ? 'Session expirée. Veuillez vous reconnecter.' : null,
                    )}
                  />
                </div>
              </div>

              {/* Update Banner */}
              <div className="dev-panel__section">
                <div className="dev-panel__section-title">Update Banner</div>
                <div className="dev-panel__row">
                  <span className="dev-panel__label">Statut</span>
                  <div className="dev-panel__radio-group">
                    {[
                      { value: '', label: 'Auto' },
                      { value: 'available', label: 'Dispo' },
                      { value: 'downloading', label: 'DL' },
                      { value: 'ready', label: 'Prêt' },
                      { value: 'error', label: 'Erreur' },
                    ].map(opt => (
                      <button
                        key={opt.value}
                        type="button"
                        className={`dev-panel__radio ${
                          (sp.forceUpdaterStatus ?? '') === opt.value ? 'dev-panel__radio--active' : ''
                        }`}
                        onClick={() => setSettingsOverride(
                          'forceUpdaterStatus',
                          opt.value === '' ? null : opt.value as 'available' | 'downloading' | 'ready' | 'error',
                        )}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Reset */}
              <div className="dev-panel__section">
                <button
                  type="button"
                  className="dev-panel__reset dev-panel__reset--full"
                  onClick={resetXtreamOverrides}
                >
                  Reset XtreamLogin
                </button>
              </div>
            </>
          )}

          {/* ---- WatchlistPage section ---- */}
          {page === 'WatchlistPage' && (
            <>
              {/* Écrans principaux */}
              <div className="dev-panel__section">
                <div className="dev-panel__section-title">Écrans</div>
                <div className="dev-panel__row">
                  <span className="dev-panel__label">Loading</span>
                  <ToggleSwitch
                    on={wp.forceLoading}
                    onToggle={v => setWatchlistOverride('forceLoading', v)}
                  />
                </div>
                <div className="dev-panel__row">
                  <span className="dev-panel__label">Watchlist vide</span>
                  <ToggleSwitch
                    on={wp.forceEmpty}
                    onToggle={v => {
                      setWatchlistOverride('forceEmpty', v);
                      // Auto-dep : désactiver loading et slider si on force vide
                      if (v) {
                        if (wp.forceLoading) setWatchlistOverride('forceLoading', false);
                        if (wp.forceManyItems !== null) setWatchlistOverride('forceManyItems', null);
                      }
                    }}
                  />
                </div>
              </div>

              {/* Cards */}
              <div className="dev-panel__section">
                <div className="dev-panel__section-title">Cards</div>
                <div className="dev-panel__row">
                  <span className="dev-panel__label">Items orphelins</span>
                  <ToggleSwitch
                    on={wp.forceOrphanItems}
                    onToggle={v => {
                      setWatchlistOverride('forceOrphanItems', v);
                      // Auto-dep : désactiver vide si on force orphelins
                      if (v && wp.forceEmpty) setWatchlistOverride('forceEmpty', false);
                    }}
                  />
                </div>
                <div className="dev-panel__row">
                  <span className="dev-panel__label">Items mock</span>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    step="10"
                    value={wp.forceManyItems ?? 0}
                    onChange={e => {
                      const val = Number(e.target.value);
                      setWatchlistOverride('forceManyItems', val > 0 ? val : null);
                      // Auto-dep : désactiver vide/loading si on force des items mock
                      if (val > 0) {
                        if (wp.forceEmpty) setWatchlistOverride('forceEmpty', false);
                        if (wp.forceLoading) setWatchlistOverride('forceLoading', false);
                      }
                    }}
                    className="dev-panel__slider"
                  />
                  <span className="dev-panel__slider-value">{wp.forceManyItems ?? 0}</span>
                </div>
              </div>

              {/* Erreur */}
              <div className="dev-panel__section">
                <div className="dev-panel__section-title">Erreur</div>
                <div className="dev-panel__row">
                  <span className="dev-panel__label">Erreur chargement</span>
                  <ToggleSwitch
                    on={wp.forceError !== null}
                    onToggle={v => {
                      setWatchlistOverride('forceError', v ? 'Simulated load error' : null);
                      if (v && wp.forceLoading) setWatchlistOverride('forceLoading', false);
                    }}
                  />
                </div>
              </div>

              {/* Reset */}
              <div className="dev-panel__section">
                <button
                  type="button"
                  className="dev-panel__reset dev-panel__reset--full"
                  onClick={resetWatchlistOverrides}
                >
                  Reset WatchlistPage
                </button>
              </div>
            </>
          )}

          {/* ---- GlobalSearchPage section ---- */}
          {page === 'GlobalSearchPage' && (
            <>
              {/* Écrans */}
              <div className="dev-panel__section">
                <div className="dev-panel__section-title">Écrans</div>
                <div className="dev-panel__row">
                  <span className="dev-panel__label">Aucun résultat</span>
                  <ToggleSwitch
                    on={gs.forceNoResults}
                    onToggle={v => {
                      setGlobalSearchOverride('forceNoResults', v);
                      if (v && gs.forceManyResults !== null) setGlobalSearchOverride('forceManyResults', null);
                    }}
                  />
                </div>
                <div className="dev-panel__row">
                  <span className="dev-panel__label">Items mock</span>
                  <input
                    type="range"
                    min="0"
                    max="50"
                    step="5"
                    value={gs.forceManyResults ?? 0}
                    onChange={e => {
                      const val = Number(e.target.value);
                      setGlobalSearchOverride('forceManyResults', val > 0 ? val : null);
                      if (val > 0 && gs.forceNoResults) setGlobalSearchOverride('forceNoResults', false);
                    }}
                    className="dev-panel__slider"
                  />
                  <span className="dev-panel__slider-value">{gs.forceManyResults ?? 0}</span>
                </div>
              </div>

              {/* Erreur */}
              <div className="dev-panel__section">
                <div className="dev-panel__section-title">Erreur</div>
                <div className="dev-panel__row">
                  <span className="dev-panel__label">Erreur recherche</span>
                  <ToggleSwitch
                    on={gs.forceError !== null}
                    onToggle={v => {
                      setGlobalSearchOverride('forceError', v ? 'Simulated search error' : null);
                    }}
                  />
                </div>
              </div>

              {/* Reset */}
              <div className="dev-panel__section">
                <button
                  type="button"
                  className="dev-panel__reset dev-panel__reset--full"
                  onClick={resetGlobalSearchOverrides}
                >
                  Reset GlobalSearch
                </button>
              </div>
            </>
          )}

          {/* ---- SettingsPage section ---- */}
          {page === 'SettingsPage' && (
            <>
              {/* IPTV Status */}
              <div className="dev-panel__section">
                <div className="dev-panel__section-title">Sources IPTV</div>
                <div className="dev-panel__row">
                  <span className="dev-panel__label">Statut IPTV</span>
                  <div className="dev-panel__radio-group">
                    {[
                      { value: '', label: 'Auto' },
                      { value: 'ok', label: 'OK' },
                      { value: 'warning', label: 'Warning' },
                      { value: 'error', label: 'Error' },
                    ].map(opt => (
                      <button
                        key={opt.value}
                        type="button"
                        className={`dev-panel__radio ${
                          (sp.forceIptvStatus ?? '') === opt.value ? 'dev-panel__radio--active' : ''
                        }`}
                        onClick={() => setSettingsOverride(
                          'forceIptvStatus',
                          opt.value === '' ? null : opt.value as 'ok' | 'warning' | 'error',
                        )}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="dev-panel__row" style={{ marginTop: '0.5rem' }}>
                    <button type="button" className="dev-panel__radio" style={{ width: '100%' }} onClick={() => void handleForceRemap()}>
                        Trigger EPG Mapping (Rust 4/4)
                    </button>
                </div>
              </div>

              {/* Refresh */}
              <div className="dev-panel__section">
                <div className="dev-panel__section-title">Refresh</div>
                <div className="dev-panel__row">
                  <span className="dev-panel__label">isRefreshing</span>
                  <ToggleSwitch
                    on={sp.forceRefreshing}
                    onToggle={v => setSettingsOverride('forceRefreshing', v)}
                  />
                </div>
                <div className="dev-panel__row">
                  <span className="dev-panel__label">Progress %</span>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    step="5"
                    value={sp.forceRefreshProgress ?? 0}
                    onChange={e => {
                      const val = Number(e.target.value);
                      setSettingsOverride('forceRefreshProgress', val > 0 ? val : null);
                      if (val > 0 && !sp.forceRefreshing) setSettingsOverride('forceRefreshing', true);
                    }}
                    className="dev-panel__slider"
                  />
                  <span className="dev-panel__slider-value">{sp.forceRefreshProgress ?? 0}%</span>
                </div>
              </div>

              {/* Édition */}
              <div className="dev-panel__section">
                <div className="dev-panel__section-title">Édition</div>
                <div className="dev-panel__row">
                  <span className="dev-panel__label">Mode édition</span>
                  <ToggleSwitch
                    on={sp.forceEditing}
                    onToggle={v => setSettingsOverride('forceEditing', v)}
                  />
                </div>
                <div className="dev-panel__row">
                  <span className="dev-panel__label">CategoryManager</span>
                  <ToggleSwitch
                    on={sp.forceCategoryManager}
                    onToggle={v => setSettingsOverride('forceCategoryManager', v)}
                  />
                </div>
              </div>

              {/* TMDB Integration */}
              <div className="dev-panel__section">
                <div className="dev-panel__section-title">TMDB</div>
                <div className="dev-panel__row">
                  <span className="dev-panel__label">Films {sp.forceTmdbMovieRate ?? '—'}%</span>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    step="5"
                    value={sp.forceTmdbMovieRate ?? 0}
                    onChange={e => setSettingsOverride('forceTmdbMovieRate', Number(e.target.value))}
                    className="dev-panel__slider"
                  />
                </div>
                <div className="dev-panel__row">
                  <span className="dev-panel__label">Séries {sp.forceTmdbSeriesRate ?? '—'}%</span>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    step="5"
                    value={sp.forceTmdbSeriesRate ?? 0}
                    onChange={e => setSettingsOverride('forceTmdbSeriesRate', Number(e.target.value))}
                    className="dev-panel__slider"
                  />
                </div>
                <div className="dev-panel__row">
                  <button
                    type="button"
                    className="dev-panel__reset"
                    onClick={() => { setSettingsOverride('forceTmdbMovieRate', null); setSettingsOverride('forceTmdbSeriesRate', null); }}
                  >
                    Reset TMDB
                  </button>
                </div>
              </div>

              {/* Expiration */}
              <div className="dev-panel__section">
                <div className="dev-panel__section-title">Expiration</div>
                <div className="dev-panel__row">
                  <span className="dev-panel__label">Statut</span>
                  <div className="dev-panel__radio-group">
                    {[
                      { value: '', label: 'Auto' },
                      { value: 'active', label: 'Actif' },
                      { value: 'expiring', label: 'Bientôt' },
                      { value: 'expired', label: 'Expiré' },
                    ].map(opt => (
                      <button
                        key={opt.value}
                        type="button"
                        className={`dev-panel__radio ${
                          (sp.forceExpiration ?? '') === opt.value ? 'dev-panel__radio--active' : ''
                        }`}
                        onClick={() => setSettingsOverride(
                          'forceExpiration',
                          opt.value === '' ? null : opt.value as 'active' | 'expiring' | 'expired',
                        )}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Updater (About) */}
              <div className="dev-panel__section">
                <div className="dev-panel__section-title">Updater (About)</div>
                <div className="dev-panel__row">
                  <span className="dev-panel__label">Status</span>
                  <div className="dev-panel__radio-group">
                    {[
                      { value: '', label: 'Auto' },
                      { value: 'checking', label: 'Checking' },
                      { value: 'available', label: 'Available' },
                      { value: 'downloading', label: 'Download' },
                      { value: 'ready', label: 'Ready' },
                      { value: 'error', label: 'Error' },
                    ].map(opt => (
                      <button
                        key={opt.value}
                        type="button"
                        className={`dev-panel__radio ${
                          (sp.forceUpdaterStatus ?? '') === opt.value ? 'dev-panel__radio--active' : ''
                        }`}
                        onClick={() => setSettingsOverride(
                          'forceUpdaterStatus',
                          opt.value === '' ? null : opt.value as 'checking' | 'available' | 'downloading' | 'ready' | 'error',
                        )}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="dev-panel__row">
                  <span className="dev-panel__label">Msg "À jour"</span>
                  <ToggleSwitch
                    on={sp.forceUpToDateMsg}
                    onToggle={v => {
                      setSettingsOverride('forceUpToDateMsg', v);
                      // Auto-dep: reset status to idle for the message to show
                      if (v && sp.forceUpdaterStatus) setSettingsOverride('forceUpdaterStatus', null);
                    }}
                  />
                </div>
              </div>

              {/* Account */}
              <div className="dev-panel__section">
                <div className="dev-panel__section-title">Account</div>
                <div className="dev-panel__row">
                  <span className="dev-panel__label">Profile Rename</span>
                  <ToggleSwitch
                    on={sp.forceProfileRename}
                    onToggle={v => setSettingsOverride('forceProfileRename', v)}
                  />
                </div>
                <div className="dev-panel__row">
                  <span className="dev-panel__label">Email Form</span>
                  <ToggleSwitch
                    on={sp.forceEmailForm}
                    onToggle={v => setSettingsOverride('forceEmailForm', v)}
                  />
                </div>
                <div className="dev-panel__row">
                  <span className="dev-panel__label">Password Form</span>
                  <ToggleSwitch
                    on={sp.forcePasswordForm}
                    onToggle={v => setSettingsOverride('forcePasswordForm', v)}
                  />
                </div>
                <div className="dev-panel__row">
                  <span className="dev-panel__label">Delete Confirm</span>
                  <ToggleSwitch
                    on={sp.forceDeleteConfirm}
                    onToggle={v => setSettingsOverride('forceDeleteConfirm', v)}
                  />
                </div>
                <div className="dev-panel__row">
                  <span className="dev-panel__label">Loading</span>
                  <select
                    className="dev-panel__select"
                    value={sp.forceAccountLoading ?? ''}
                    onChange={e => setSettingsOverride(
                      'forceAccountLoading',
                      (e.target.value || null) as typeof sp.forceAccountLoading,
                    )}
                  >
                    <option value="">— Aucun —</option>
                    <option value="rename">Rename</option>
                    <option value="email">Email</option>
                    <option value="password">Password</option>
                    <option value="delete">Delete</option>
                  </select>
                </div>
                <div className="dev-panel__row">
                  <span className="dev-panel__label">Error</span>
                  <select
                    className="dev-panel__select"
                    value={sp.forceAccountError ?? ''}
                    onChange={e => setSettingsOverride(
                      'forceAccountError',
                      (e.target.value || null) as typeof sp.forceAccountError,
                    )}
                  >
                    <option value="">— Aucune —</option>
                    <option value="rename">Rename</option>
                    <option value="email">Email</option>
                    <option value="password">Password</option>
                    <option value="delete">Delete</option>
                  </select>
                </div>
                <div className="dev-panel__row">
                  <span className="dev-panel__label">Success</span>
                  <select
                    className="dev-panel__select"
                    value={sp.forceAccountSuccess ?? ''}
                    onChange={e => setSettingsOverride(
                      'forceAccountSuccess',
                      (e.target.value || null) as typeof sp.forceAccountSuccess,
                    )}
                  >
                    <option value="">— Aucun —</option>
                    <option value="rename">Rename</option>
                    <option value="email">Email</option>
                    <option value="password">Password</option>
                  </select>
                </div>
              </div>

              {/* Provider Change */}
              <div className="dev-panel__section">
                <div className="dev-panel__section-title">Provider Change</div>
                <div className="dev-panel__row">
                  <span className="dev-panel__label">ConfirmModal provider</span>
                  <ToggleSwitch
                    on={sp.forceProviderChange}
                    onToggle={v => setSettingsOverride('forceProviderChange', v)}
                  />
                </div>
              </div>

              {/* Toast */}
              <div className="dev-panel__section">
                <div className="dev-panel__section-title">Toast</div>
                <div className="dev-panel__row">
                  <span className="dev-panel__label">Success toast</span>
                  <ToggleSwitch
                    on={sp.forceToast !== null}
                    onToggle={v => setSettingsOverride(
                      'forceToast',
                      v ? '✓ Reset simulé avec succès' : null,
                    )}
                  />
                </div>
              </div>

              {/* Reset */}
              <div className="dev-panel__section">
                <button
                  type="button"
                  className="dev-panel__reset dev-panel__reset--full"
                  onClick={resetSettingsOverrides}
                >
                  Reset SettingsPage
                </button>
              </div>
            </>
          )}

          {/* ---- LiveTvPage section ---- */}
          {page === 'LiveTvPage' && (
            <>
              {/* Écrans */}
              <div className="dev-panel__section">
                <div className="dev-panel__section-title">Écrans</div>
                <div className="dev-panel__row">
                  <span className="dev-panel__label">Loading</span>
                  <ToggleSwitch
                    on={tv.forceLoading}
                    onToggle={v => {
                      setLiveTvOverride('forceLoading', v);
                      if (v) {
                        if (tv.forceEmpty) setLiveTvOverride('forceEmpty', false);
                        if (tv.forceError !== null) setLiveTvOverride('forceError', null);
                      }
                    }}
                  />
                </div>
                <div className="dev-panel__row">
                  <span className="dev-panel__label">Aucune chaîne</span>
                  <ToggleSwitch
                    on={tv.forceEmpty}
                    onToggle={v => {
                      setLiveTvOverride('forceEmpty', v);
                      if (v) {
                        if (tv.forceLoading) setLiveTvOverride('forceLoading', false);
                        if (tv.forceError !== null) setLiveTvOverride('forceError', null);
                      }
                    }}
                  />
                </div>
              </div>

              {/* Erreur */}
              <div className="dev-panel__section">
                <div className="dev-panel__section-title">Erreur</div>
                <div className="dev-panel__row">
                  <span className="dev-panel__label">Erreur IPTV</span>
                  <ToggleSwitch
                    on={tv.forceError !== null}
                    onToggle={v => {
                      setLiveTvOverride('forceError', v ? 'Erreur de chargement des chaînes TV' : null);
                      if (v && tv.forceLoading) setLiveTvOverride('forceLoading', false);
                    }}
                  />
                </div>
              </div>

              {/* Reset */}
              <div className="dev-panel__section">
                <button
                  type="button"
                  className="dev-panel__reset dev-panel__reset--full"
                  onClick={resetLiveTvOverrides}
                >
                  Reset LiveTvPage
                </button>
              </div>
            </>
          )}

          {/* ---- MovieDetailPage section ---- */}
          {page === 'MovieDetailPage' && (
            <>
              {/* Loading State */}
              <div className="dev-panel__section">
                <div className="dev-panel__section-title">Loading State</div>
                <div className="dev-panel__row">
                  <span className="dev-panel__label">État</span>
                  <div className="dev-panel__radio-group">
                    {[
                      { value: '', label: 'Auto' },
                      { value: 'loading', label: 'Loading' },
                      { value: 'ready', label: 'Ready' },
                      { value: 'fallback', label: 'Fallback' },
                    ].map(opt => (
                      <button
                        key={opt.value}
                        type="button"
                        className={`dev-panel__radio ${
                          (md.forceLoadingState ?? '') === opt.value ? 'dev-panel__radio--active' : ''
                        }`}
                        onClick={() => setMovieDetailOverride(
                          'forceLoadingState',
                          opt.value === '' ? null : opt.value as 'loading' | 'ready' | 'fallback',
                        )}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Contenu */}
              <div className="dev-panel__section">
                <div className="dev-panel__section-title">Contenu</div>
                <div className="dev-panel__row">
                  <span className="dev-panel__label">No Backdrop</span>
                  <ToggleSwitch
                    on={md.forceNoBackdrop}
                    onToggle={v => setMovieDetailOverride('forceNoBackdrop', v)}
                  />
                </div>
                <div className="dev-panel__row">
                  <span className="dev-panel__label">No Similar</span>
                  <ToggleSwitch
                    on={md.forceNoSimilar}
                    onToggle={v => setMovieDetailOverride('forceNoSimilar', v)}
                  />
                </div>
                <div className="dev-panel__row">
                  <span className="dev-panel__label">No Trailer</span>
                  <ToggleSwitch
                    on={md.forceNoTrailer}
                    onToggle={v => setMovieDetailOverride('forceNoTrailer', v)}
                  />
                </div>
                <div className="dev-panel__row">
                  <span className="dev-panel__label">Has Progress</span>
                  <ToggleSwitch
                    on={md.forceProgress}
                    onToggle={v => setMovieDetailOverride('forceProgress', v)}
                  />
                </div>
              </div>

              {/* Reset */}
              <div className="dev-panel__section">
                <button
                  type="button"
                  className="dev-panel__reset dev-panel__reset--full"
                  onClick={resetMovieDetailOverrides}
                >
                  Reset MovieDetailPage
                </button>
              </div>
            </>
          )}

          {/* ---- SeriesDetailPage section ---- */}
          {page === 'SeriesDetailPage' && (
            <>
              {/* Loading State */}
              <div className="dev-panel__section">
                <div className="dev-panel__section-title">Loading State</div>
                <div className="dev-panel__row">
                  <span className="dev-panel__label">État</span>
                  <div className="dev-panel__radio-group">
                    {[
                      { value: '', label: 'Auto' },
                      { value: 'loading', label: 'Loading' },
                      { value: 'ready', label: 'Ready' },
                      { value: 'fallback', label: 'Fallback' },
                    ].map(opt => (
                      <button
                        key={opt.value}
                        type="button"
                        className={`dev-panel__radio ${
                          (sd.forceLoadingState ?? '') === opt.value ? 'dev-panel__radio--active' : ''
                        }`}
                        onClick={() => setSeriesDetailOverride(
                          'forceLoadingState',
                          opt.value === '' ? null : opt.value as 'loading' | 'ready' | 'fallback',
                        )}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Contenu */}
              <div className="dev-panel__section">
                <div className="dev-panel__section-title">Contenu</div>
                <div className="dev-panel__row">
                  <span className="dev-panel__label">No Backdrop</span>
                  <ToggleSwitch
                    on={sd.forceNoBackdrop}
                    onToggle={v => setSeriesDetailOverride('forceNoBackdrop', v)}
                  />
                </div>
                <div className="dev-panel__row">
                  <span className="dev-panel__label">Empty Season</span>
                  <ToggleSwitch
                    on={sd.forceEmptySeason}
                    onToggle={v => setSeriesDetailOverride('forceEmptySeason', v)}
                  />
                </div>
                <div className="dev-panel__row">
                  <span className="dev-panel__label">Has Progress</span>
                  <ToggleSwitch
                    on={sd.forceProgress}
                    onToggle={v => setSeriesDetailOverride('forceProgress', v)}
                  />
                </div>
                <div className="dev-panel__row">
                  <span className="dev-panel__label">No Episode Synopsis</span>
                  <ToggleSwitch
                    on={sd.forceNoEpisodeSynopsis}
                    onToggle={v => setSeriesDetailOverride('forceNoEpisodeSynopsis', v)}
                  />
                </div>
                <div className="dev-panel__row">
                  <span className="dev-panel__label">Season Loading</span>
                  <ToggleSwitch
                    on={sd.forceSeasonLoading}
                    onToggle={v => setSeriesDetailOverride('forceSeasonLoading', v)}
                  />
                </div>
              </div>

              {/* Reset */}
              <div className="dev-panel__section">
                <button
                  type="button"
                  className="dev-panel__reset dev-panel__reset--full"
                  onClick={resetSeriesDetailOverrides}
                >
                  Reset SeriesDetailPage
                </button>
              </div>
            </>
          )}

          {/* ====================================
               DashboardPage
             ==================================== */}
          {page === 'DashboardPage' && (
            <>
              {/* Mode Dashboard */}
              <div className="dev-panel__section">
                <div className="dev-panel__section-title">Mode Dashboard</div>
                {(['', 'suggestions', 'films', 'series'] as const).map((val) => (
                  <label key={val || 'auto'} className="dev-panel__radio">
                    <input
                      type="radio"
                      name="dp-mode"
                      checked={db.forceDashboardMode === (val || null)}
                      onChange={() => setDashboardOverride('forceDashboardMode', val || null)}
                    />
                    {val || 'Auto'}
                  </label>
                ))}
              </div>

              {/* IPTV Status */}
              <div className="dev-panel__section">
                <div className="dev-panel__section-title">IPTV Status</div>
                {(['', 'ok', 'warning', 'error'] as const).map((val) => (
                  <label key={val || 'auto'} className="dev-panel__radio">
                    <input
                      type="radio"
                      name="dp-iptv"
                      checked={db.forceIptvStatus === (val || null)}
                      onChange={() => setDashboardOverride('forceIptvStatus', val || null)}
                    />
                    {val || 'Auto'}
                  </label>
                ))}
              </div>

              {/* Hero Overrides */}
              <div className="dev-panel__section">
                <div className="dev-panel__section-title">Hero</div>
                <div className="dev-panel__row">
                  <span className="dev-panel__label">Loading (skeleton)</span>
                  <ToggleSwitch
                    on={db.forceHeroLoading}
                    onToggle={v => setDashboardOverride('forceHeroLoading', v)}
                  />
                </div>
                <div className="dev-panel__row">
                  <span className="dev-panel__label">Empty (fallback)</span>
                  <ToggleSwitch
                    on={db.forceHeroEmpty}
                    onToggle={v => setDashboardOverride('forceHeroEmpty', v)}
                  />
                </div>
                <div className="dev-panel__row">
                  <span className="dev-panel__label">Fading (rotation)</span>
                  <ToggleSwitch
                    on={db.forceHeroFading}
                    onToggle={v => setDashboardOverride('forceHeroFading', v)}
                  />
                </div>
                <div className="dev-panel__row">
                  <span className="dev-panel__label">No Logo (titre H1)</span>
                  <ToggleSwitch
                    on={db.forceHeroNoLogo}
                    onToggle={v => setDashboardOverride('forceHeroNoLogo', v)}
                  />
                </div>
              </div>

              {/* Page Overrides */}
              <div className="dev-panel__section">
                <div className="dev-panel__section-title">Page</div>
                <div className="dev-panel__row">
                  <span className="dev-panel__label">Mode Switching</span>
                  <ToggleSwitch
                    on={db.forceModeSwitching}
                    onToggle={v => setDashboardOverride('forceModeSwitching', v)}
                  />
                </div>
              </div>

              {/* Data Overrides */}
              <div className="dev-panel__section">
                <div className="dev-panel__section-title">Data</div>
                <div className="dev-panel__row">
                  <span className="dev-panel__label">No LightIndexes</span>
                  <ToggleSwitch
                    on={db.forceNoLightIndexes}
                    onToggle={v => setDashboardOverride('forceNoLightIndexes', v)}
                  />
                </div>
                <div className="dev-panel__row">
                  <span className="dev-panel__label">IPTV No Categories</span>
                  <ToggleSwitch
                    on={db.forceIptvNoCategories}
                    onToggle={v => setDashboardOverride('forceIptvNoCategories', v)}
                  />
                </div>
              </div>

              {/* Reset */}
              <div className="dev-panel__section">
                <button
                  type="button"
                  className="dev-panel__reset dev-panel__reset--full"
                  onClick={resetDashboardOverrides}
                >
                  Reset DashboardPage
                </button>
              </div>
            </>
          )}

          {/* ---- PlayerControls section ---- */}
          {page === 'PlayerControls' && (
            <>
              {/* Language */}
              <div className="dev-panel__section">
                <div className="dev-panel__section-title">Language</div>
                <div className="dev-panel__row">
                  <span className="dev-panel__label">Player language</span>
                  <div className="dev-panel__radio-group">
                    {([['en', 'UK'], ['fr', 'FR']] as const).map(([code, label]) => (
                      <button
                        key={code}
                        type="button"
                        className={`dev-panel__radio ${i18n.resolvedLanguage === code ? 'dev-panel__radio--active' : ''}`}
                        onClick={() => { void i18n.changeLanguage(code); }}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* States */}
              <div className="dev-panel__section">
                <div className="dev-panel__section-title">États Player</div>
                <div className="dev-panel__row">
                  <span className="dev-panel__label">Loading</span>
                  <ToggleSwitch
                    on={pc.forceLoading}
                    onToggle={v => setPlayerControlsOverride('forceLoading', v)}
                  />
                </div>
                <div className="dev-panel__row">
                  <span className="dev-panel__label">Mode série</span>
                  <ToggleSwitch
                    on={pc.forceSeriesMode}
                    onToggle={v => setPlayerControlsOverride('forceSeriesMode', v)}
                  />
                </div>
              </div>

              {/* Overlays */}
              <div className="dev-panel__section">
                <div className="dev-panel__section-title">Overlays</div>
                <div className="dev-panel__row">
                  <span className="dev-panel__label">BingePopup</span>
                  <ToggleSwitch
                    on={pc.forceBingePopup}
                    onToggle={v => setPlayerControlsOverride('forceBingePopup', v)}
                  />
                </div>
                <div className="dev-panel__row">
                  <span className="dev-panel__label">GeekStats</span>
                  <ToggleSwitch
                    on={pc.forceGeekStats}
                    onToggle={v => setPlayerControlsOverride('forceGeekStats', v)}
                  />
                </div>
                <div className="dev-panel__row">
                  <span className="dev-panel__label">Episode Skeleton</span>
                  <ToggleSwitch
                    on={pc.forceEpisodeSkeleton}
                    onToggle={v => setPlayerControlsOverride('forceEpisodeSkeleton', v)}
                  />
                </div>
              </div>

              {/* Reset */}
              <div className="dev-panel__section">
                <button
                  type="button"
                  className="dev-panel__reset dev-panel__reset--full"
                  onClick={resetPlayerControlsOverrides}
                >
                  Reset PlayerControls
                </button>
              </div>
            </>
          )}

          {/* Pages sans toggles */}
          {page !== 'SupabaseAuthPage' && page !== 'XtreamLoginPage' && page !== 'WatchlistPage' && page !== 'GlobalSearchPage' && page !== 'SettingsPage' && page !== 'LiveTvPage' && page !== 'MovieDetailPage' && page !== 'SeriesDetailPage' && page !== 'DashboardPage' && page !== 'PlayerControls' && (
            <div className="dev-panel__section">
              <div className="dev-panel__section-title">
                Pas de toggles pour cette page
              </div>
              <p className="dev-panel__muted-text">
                Page active : {page}. Les toggles seront ajoutés lors de la refonte de cette page.
              </p>
            </div>
          )}

          <div className="dev-panel__hint">
            <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>D</kbd> pour toggle
          </div>
        </div>
      )}
    </>
  );
};

// ---- Sub-component: Toggle switch ----

const ToggleSwitch: React.FC<{
  on: boolean;
  onToggle: (value: boolean) => void;
}> = ({ on, onToggle }) => (
  <button
    type="button"
    className={`dev-panel__toggle ${on ? 'dev-panel__toggle--on' : ''}`}
    onClick={() => onToggle(!on)}
    aria-pressed={on}
  />
);

export default DevPanel;
