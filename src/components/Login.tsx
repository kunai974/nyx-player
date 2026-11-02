import React, { useState, useEffect } from 'react';
import logoSecondaireBlanc from '../assets/brand/logo-secondaire-blanc.svg';
import { useTranslation } from 'react-i18next';
import type { XtreamCredentials } from '../types/iptv';
import { useSupabaseAuth } from '../contexts/SupabaseAuthContext';
import { useDevOverrides } from '../contexts/DevOverrideContext';
import NyxButton from './Common/NyxButton';
import { EyeOpen, EyeClosed } from './Common/EyeIcons';
import { readM3uParam, splitPastedXtreamAddress } from '../utils/xtreamCredentials';
import { normalizeProviderHost, noteTypedProviderHost } from '../utils/providerHost';
import { isTv } from '../utils/platform';
import LocalDatabaseDamagedNotice from './Common/LocalDatabaseDamagedNotice';

interface LoginProps {
  onLogin: (creds: XtreamCredentials) => void;
  isLoading: boolean;
  progress: number;
  onBackToProfiles?: () => void;
}

const Login: React.FC<LoginProps> = ({ onLogin, isLoading, progress, onBackToProfiles }) => {
  const { t, i18n } = useTranslation(['auth', 'common']);
  const { signOut } = useSupabaseAuth();
  const { overrides } = useDevOverrides();
  const xp = overrides.xtreamPage;

  const [mode, setMode] = useState<'xtream' | 'm3u'>('xtream');
  const [error, setError] = useState<string | null>(null);
  const [host, setHost] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [m3uLink, setM3uLink] = useState('');
  // DevPanel overrides
  const effectiveLoading = xp.forceLoading || isLoading;
  const effectiveProgress = xp.forceProgress ?? progress;
  const effectiveError: string | null = xp.forceError ? t(xp.forceError) : error;

  // Sync mode override
  useEffect(() => {
    if (xp.forceMode && xp.forceMode !== mode) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- forçage du DevPanel (développement) : le mode suit le réglage forcé
      setMode(xp.forceMode);
    }
    // Outil de développement : appliqué quand le forçage change, sans empêcher ensuite de changer de mode
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mode lu sans abonnement
  }, [xp.forceMode]);

  const handleSubmit = (e: React.FormEvent): void => {
    e.preventDefault();
    setError(null);

    if (mode === 'm3u') {
      try {
        const url = new URL(m3uLink);
        noteTypedProviderHost('');
        const host = normalizeProviderHost(`${url.protocol}//${url.host}`);
        // « + » gardé tel quel dans les identifiants
        const username = readM3uParam(url, 'username');
        const password = readM3uParam(url, 'password');

        if (!host || !username || !password) {
          setError(t('error_m3u_missing_info'));
          return;
        }

        onLogin({ host, username, password });
      } catch {
        setError(t('error_m3u_invalid'));
      }
      return;
    }

    // Adresse complète collée (`…/player_api.php?username=…`) : le serveur seul, et les identifiants
    // qu'elle contient pour les champs laissés vides
    const pasted = splitPastedXtreamAddress(host);
    const user = username || pasted.username;
    const pass = password || pasted.password;
    if (!pasted.host.trim() || !user || !pass) {
      setError(t('error_missing_fields'));
      return;
    }
    // Adresse nettoyée (espaces, « / » final, majuscules) : le même serveur écrit autrement n'est pas
    // pris pour un autre fournisseur
    noteTypedProviderHost(pasted.host);
    onLogin({ host: normalizeProviderHost(pasted.host), username: user, password: pass });
  };

  // Télécommande : valider un champ avec OK ne doit pas envoyer le formulaire (les champs suivants sont
  // vides) ; il amène sur le champ suivant, puis sur « Se connecter » (utils/spatialNavigation)
  const tvField = (next: string): Record<string, string> =>
    isTv() ? { 'data-nav-longpress': 'passive', 'data-nav-enter-next': next } : {};

  return (
    <div className="login-container" data-testid="provider-login">
      {/* Globe toggle — langue pré-login (localStorage only) */}
      <button
        data-testid="provider-language"
        type="button"
        className="lang-toggle"
        onClick={() => void i18n.changeLanguage(i18n.resolvedLanguage === 'fr' ? 'en' : 'fr')}
        aria-label={t('common:toggle_language')}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><path d="M2 12h20" /><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" /></svg>
        {' '}{i18n.resolvedLanguage === 'fr' ? 'FR' : 'EN'}
      </button>

      <div className="login-box">
        {effectiveError && <div className="login-error" data-testid="provider-error">{effectiveError}</div>}
        {/* Base de l'appareil abîmée : réinitialisation proposée ici, pas seulement dans les Paramètres */}
        <LocalDatabaseDamagedNotice testId="provider-db" />
        <div className="login-logo-container">
          <img
            src={logoSecondaireBlanc}
            alt="Nyx Player Logo"
            className="login-brand-logo"
          />
        </div>

        <div className="tab-buttons">
          <button
            type="button"
            className={mode === 'xtream' ? 'active' : ''}
            data-testid="provider-tab-xtream"
            onClick={() => setMode('xtream')}
            disabled={effectiveLoading}
          >
            {t('tab_xtream')}
          </button>
          <button
            type="button"
            className={mode === 'm3u' ? 'active' : ''}
            data-testid="provider-tab-m3u"
            onClick={() => setMode('m3u')}
            disabled={effectiveLoading}
          >
            {t('tab_m3u')}
          </button>
        </div>

        <form onSubmit={handleSubmit} data-testid="provider-form">
          {mode === 'xtream' ? (
            <>
              <div className="form-group">
                <label>{t('label_host')}</label>
                <input
                  type="text"
                  placeholder="http://example.com:8080"
                  data-testid="provider-url"
                  id="provider-url"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  {...tvField('provider-username')}
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                  disabled={effectiveLoading}
                />
              </div>

              <div className="form-group">
                <label>{t('label_username')}</label>
                <input
                  type="text"
                  data-testid="provider-username"
                  id="provider-username"
                  {...tvField('provider-password')}
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  disabled={effectiveLoading}
                />
              </div>

              <div className="form-group">
                <label>{t('label_password')}</label>
                <div className="login-input-wrapper">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    data-testid="provider-password"
                    id="provider-password"
                    {...tvField('provider-submit')}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    disabled={effectiveLoading}
                  />
                  <button
                    data-testid="provider-password-toggle"
                    type="button"
                    className="login-eye-toggle"
                    onClick={() => setShowPassword(v => !v)}
                    aria-label={showPassword ? t('common:password_hide') : t('common:password_show')}
                    tabIndex={-1}
                  >
                    {showPassword ? <EyeClosed /> : <EyeOpen />}
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div className="form-group">
              <label>{t('label_m3u_link')}</label>
              <textarea
                rows={3}
                data-testid="provider-m3u-link"
                placeholder={t('placeholder_m3u')}
                value={m3uLink}
                onChange={(e) => setM3uLink(e.target.value)}
                disabled={effectiveLoading}
              />
              <p className="login-m3u-note">
                {t('note_m3u')}
              </p>
            </div>
          )}

          <NyxButton
            type="submit"
            data-testid="provider-submit"
            id="provider-submit"
            variant="primary"
            size="md"
            color="blue"
            disabled={effectiveLoading}
          >
            {effectiveLoading ? t('common:loading') : t('btn_login')}
          </NyxButton>
        </form>

        {effectiveLoading && (
          <div className="progress-container" data-testid="provider-progress">
            <div className="progress-bar-bg">
              <div className="progress-bar-fill" style={{ width: `${effectiveProgress}%` }}></div>
            </div>
            <p className="progress-text">{t('sync_progress', { progress: effectiveProgress })}</p>
            <p className="progress-subtext">{t('common:please_wait')}</p>
          </div>
        )}

        {onBackToProfiles && (
          <button
            type="button"
            className="login-back-btn"
            data-testid="provider-back-to-profiles"
            onClick={onBackToProfiles}
            disabled={effectiveLoading}
          >
            ← {t('btn_back_to_profiles')}
          </button>
        )}
        <button
          data-testid="provider-sign-out"
          type="button"
          className="supabase-logout-link"
          onClick={() => void signOut()}
          disabled={effectiveLoading}
        >
          {t('btn_supabase_logout')}
        </button>
      </div>
    </div>
  );
};

export default Login;
