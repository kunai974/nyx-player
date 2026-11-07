import React, { useState, useEffect, useCallback, useRef } from 'react';
import logoSecondaireBlanc from '../assets/brand/logo-secondaire-blanc.svg';
import { useTranslation } from 'react-i18next';
import type { XtreamCredentials } from '../types/iptv';
import { useSupabaseAuth } from '../contexts/SupabaseAuthContext';
import { useDevOverrides } from '../contexts/DevOverrideContext';
import NyxButton from './Common/NyxButton';
import { EyeOpen, EyeClosed } from './Common/EyeIcons';
import { noteTypedProviderHost } from '../utils/providerHost';
import { providerFormToCredentials, type ProviderFormInput } from '../utils/providerForm';
import TvLinkPanel from './TvLink/TvLinkPanel';
import { peekPendingTvLinkProvider, takePendingTvLinkProvider } from '../services/tvLink/pendingProvider';
import { checkTvLinkProvider } from '../services/tvLink/tvLinkProviderCheck';
import { announceTvLinkConnection } from '../services/tvLink/tvLinkSummary';
import type { TvLinkAck } from '../services/tvLink/tvLinkSession';
import type { TvLinkPayload } from '../services/tvLink/tvLinkPayload';
import { isTv } from '../utils/platform';
import LocalDatabaseDamagedNotice from './Common/LocalDatabaseDamagedNotice';
import LocalM3uFileButton from './Common/LocalM3uFileButton';

interface LoginProps {
  onLogin: (creds: XtreamCredentials) => void;
  isLoading: boolean;
  progress: number;
  onBackToProfiles?: () => void;
  /** Sans compte (invité) : « Retour » ramène à l'accueil, et il n'y a pas de compte à quitter */
  guest?: boolean;
}

const Login: React.FC<LoginProps> = ({ onLogin, isLoading, progress, onBackToProfiles, guest = false }) => {
  const { t, i18n } = useTranslation(['auth', 'common']);
  const { signOut } = useSupabaseAuth();
  const { overrides } = useDevOverrides();
  const xp = overrides.xtreamPage;

  // Compte et fournisseur envoyés ensemble par QR code depuis l'accueil de la TV : le fournisseur
  // attendait cet écran. Il remplit le formulaire (pour corriger sans tout retaper si le serveur
  // refuse), et la connexion part seule s'il est complet. Lu sans être consommé ici : React peut
  // appeler cette initialisation deux fois, et la seconde trouvait le formulaire vide
  const [arrival] = useState(() => {
    const input = peekPendingTvLinkProvider();
    return input ? { input, result: providerFormToCredentials(input) } : null;
  });
  const arrivalForm = arrival?.input ?? null;

  const [mode, setMode] = useState<'xtream' | 'm3u'>(arrivalForm?.type === 'm3u' ? 'm3u' : 'xtream');
  const [error, setError] = useState<string | null>(
    arrival && 'errorKey' in arrival.result ? t(arrival.result.errorKey) : null,
  );
  const [host, setHost] = useState(arrivalForm?.type === 'xtream' ? arrivalForm.host : '');
  const [username, setUsername] = useState(arrivalForm?.type === 'xtream' ? arrivalForm.username : '');
  const [password, setPassword] = useState(arrivalForm?.type === 'xtream' ? arrivalForm.password : '');
  const [showPassword, setShowPassword] = useState(false);
  const [m3uLink, setM3uLink] = useState(arrivalForm?.type === 'm3u' ? arrivalForm.link : '');
  const containerRef = useRef<HTMLDivElement>(null);
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

  // Fournisseur venu du téléphone (QR code), déjà vérifié auprès de son serveur : le formulaire est
  // rempli (pour corriger sans tout retaper si le chargement échoue), puis la connexion part
  const applyPhoneProvider = useCallback((input: ProviderFormInput, creds: XtreamCredentials, typedHost: string): void => {
    if (input.type === 'm3u') {
      setMode('m3u');
      setM3uLink(input.link);
    } else {
      setMode('xtream');
      setHost(input.host);
      setUsername(input.username);
      setPassword(input.password);
    }
    setError(null);
    noteTypedProviderHost(typedHost);
    onLogin(creds);
  }, [onLogin]);

  // Une seule fois, même si l'écran est monté deux fois (mode strict de React en développement)
  const arrivalSent = useRef(false);
  useEffect(() => {
    if (arrivalSent.current || !arrival) return;
    arrivalSent.current = true;
    // Consommé ici, une fois : il ne resservira ni à un autre écran ni à un autre profil
    if (!takePendingTvLinkProvider() || !('creds' in arrival.result)) return;
    noteTypedProviderHost(arrival.result.typedHost);
    onLogin(arrival.result.creds);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fournisseur lu une fois à l'ouverture de l'écran
  }, []);

  // Pendant un chargement, un envoi du téléphone attend (« occupé ») : il ne remplace pas la connexion en cours
  const loadingRef = useRef(effectiveLoading);
  useEffect(() => {
    loadingRef.current = effectiveLoading;
  }, [effectiveLoading]);
  // Écran quitté pendant la vérification (Retour aux profils) : la connexion ne part plus
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  const handlePhonePayload = useCallback(async (payload: TvLinkPayload): Promise<TvLinkAck> => {
    if (!payload.provider) return { ok: false, reason: 'invalid' };
    if (loadingRef.current) return { ok: false, reason: 'busy' };
    const check = await checkTvLinkProvider(payload.provider);
    if (!mountedRef.current) return { ok: false, reason: 'closed' };
    if (!check.ok) return { ok: false, reason: check.reason };
    if (loadingRef.current) return { ok: false, reason: 'busy' };
    applyPhoneProvider(payload.provider, check.creds, check.typedHost);
    announceTvLinkConnection({ provider: payload.provider });
    return { ok: true };
  }, [applyPhoneProvider]);

  const handleSubmit = (e: React.FormEvent): void => {
    e.preventDefault();
    setError(null);

    const result = providerFormToCredentials(
      mode === 'm3u' ? { type: 'm3u', link: m3uLink } : { type: 'xtream', host, username, password },
    );
    if ('errorKey' in result) {
      setError(t(result.errorKey));
      return;
    }
    noteTypedProviderHost(result.typedHost);
    onLogin(result.creds);
  };

  // Télécommande : valider un champ avec OK ne doit pas envoyer le formulaire (les champs suivants sont
  // vides) ; il amène sur le champ suivant, puis sur « Se connecter » (utils/spatialNavigation)
  const tvField = (next: string): Record<string, string> =>
    isTv() ? { 'data-nav-longpress': 'passive', 'data-nav-enter-next': next } : {};

  return (
    <div className="login-container" data-testid="provider-login" ref={containerRef}>
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
              {/* Ou une liste posée sur l'appareil (ordinateur, téléphone) */}
              <LocalM3uFileButton
                testId="provider-m3u-file"
                disabled={effectiveLoading}
                onError={setError}
                onImported={(creds) => {
                  noteTypedProviderHost('');
                  onLogin(creds);
                }}
              />
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
            ← {guest ? t('btn_back_to_welcome') : t('btn_back_to_profiles')}
          </button>
        )}
        {!guest && (
          <button
            data-testid="provider-sign-out"
            type="button"
            className="supabase-logout-link"
            onClick={() => void signOut()}
            disabled={effectiveLoading}
          >
            {t('btn_supabase_logout')}
          </button>
        )}
      </div>

      {/* TV : à côté du formulaire, le fournisseur saisi sur le téléphone par QR code, sans clic de plus */}
      {isTv() && (
        <aside className="login-phone-side" data-testid="provider-phone-side">
          <TvLinkPanel mode="provider" onPayload={handlePhonePayload} embedded />
        </aside>
      )}
    </div>
  );
};

export default Login;
