/**
 * SupabaseAuthPage — Écran Login / Register Supabase
 *
 * Affiché comme guard global avant l'app IPTV.
 * Flux : Register/Login → JWT Supabase → accès à l'app
 *
 * i18n : Utilise useTranslation('auth') avec les clés supabase_*.
 * La langue est gérée en LOCAL uniquement (localStorage via i18next).
 * Zéro couplage avec SQLite/Supabase pour la langue.
 */

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import { useSupabaseAuth } from '../contexts/SupabaseAuthContext';
import { supabase } from '../services/supabaseClient';
import { authErrorKey } from '../services/authErrors';
import { consumeAccountDeletedNotice } from '../services/accountExistenceCheck';
import { openExternalLink } from '../services/externalLink';
import { suggestEmailCorrection } from '../utils/emailSuggestions';
import { useDevOverrides } from '../contexts/DevOverrideContext';
import NyxButton from '../components/Common/NyxButton';
import { useTvLongPress } from '../hooks/useTvLongPress';
import { isTv } from '../utils/platform';
import { QUIET_IME_PROPS } from '../utils/spatialNavigation';
import { EyeOpen, EyeClosed } from '../components/Common/EyeIcons';
import logoSecondaireBlanc from '../assets/brand/logo-secondaire-blanc.svg';
import './SupabaseAuthPage.css';
import { isPasswordLongEnough } from '../utils/passwordPolicy';
import { privacyPolicyUrl, termsUrl } from '../utils/legalLinks';

// ---- Texte long pour test overflow (DevPanel) ----
const DEV_LONG_ERROR = 'This is a very long error message from Supabase that simulates a real-world scenario where the backend returns an unexpectedly verbose error description. For security purposes, email enumeration has been blocked on this project. To prevent this, you can disable the option in your authentication settings. Error code: AUTH-429-RATE-LIMIT-EXCEEDED. Please contact support if this persists.';

// ---- Constantes signup cooldown (Stratégie 3) ----
const SIGNUP_COOLDOWN_SUPABASE = 60; // secondes (défaut GoTrue, non configurable)
const SIGNUP_COOLDOWN_CLIENT = SIGNUP_COOLDOWN_SUPABASE + 2; // 62s avec marge
const LS_KEY = 'nyx_last_signup_ts';

type AuthMode = 'login' | 'register';

interface SupabaseAuthPageProps {
    /** Onglet ouvert à l'arrivée (« Créer un compte » depuis les réglages d'un invité) */
    initialMode?: AuthMode;
    /** « Continuer sans compte » : l'app ferme d'abord toute session ouverte (défaut : ouvre l'espace invité) */
    onContinueAsGuest?: () => void;
}

const SupabaseAuthPage: React.FC<SupabaseAuthPageProps> = ({ initialMode = 'login', onContinueAsGuest }) => {
    const { signIn, signUp, sessionExpired, enterGuestMode } = useSupabaseAuth();
    const { t, i18n } = useTranslation(['auth', 'common']);
    const { overrides } = useDevOverrides();
    const dev = overrides.loginPage;

    const [mode, setMode] = useState<AuthMode>(initialMode);
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [error, setError] = useState<string | null>(null);
    // Session refusée par Supabase (jeton de renouvellement invalide) : on le dit au lieu d'un retour muet
    const [expiredNotice, setExpiredNotice] = useState(sessionExpired);
    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- avis « session expirée » gardé jusqu'à ce que l'utilisateur l'efface
        if (sessionExpired) setExpiredNotice(true);
    }, [sessionExpired]);
    // Compte supprimé depuis un autre appareil, appareil nettoyé puis relancé : dit une seule fois
    const [deletedNotice, setDeletedNotice] = useState(consumeAccountDeletedNotice);
    const [success, setSuccess] = useState<string | null>(null);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [isResending, setIsResending] = useState(false);
    const [resendCooldown, setResendCooldown] = useState(false);
    const [lastRegisteredEmail, setLastRegisteredEmail] = useState<string | null>(null);
    const [forgotMode, setForgotMode] = useState(false);
    const [forgotLoading, setForgotLoading] = useState(false);
    const [acceptTerms, setAcceptTerms] = useState(false);
    const [showPassword, setShowPassword] = useState(false);
    const [showConfirmPassword, setShowConfirmPassword] = useState(false);

    // Télécommande : appui long sur OK dans un champ mot de passe = afficher / masquer (l'œil n'est
    // pas focusable). Mode passif : l'appui court garde son effet natif (ouvrir le clavier).
    const passwordRef = useRef<HTMLInputElement>(null);
    const confirmPasswordRef = useRef<HTMLInputElement>(null);
    const passwordLongPress = useTvLongPress(passwordRef, () => setShowPassword(v => !v), true);
    const confirmLongPress = useTvLongPress(confirmPasswordRef, () => setShowConfirmPassword(v => !v), true);

    // ---- S2 : Suggestion email typo ----
    const [emailSuggestion, setEmailSuggestion] = useState<string | null>(null);

    // ---- S3 : Timer signup cooldown ----
    const [signupCooldown, setSignupCooldown] = useState(0);
    const cooldownRef = useRef<ReturnType<typeof setInterval> | null>(null);

    // Démarrer un timer dégressif à partir d'un nombre de secondes
    const startCooldownTimer = useCallback((seconds: number) => {
        setSignupCooldown(seconds);
        if (cooldownRef.current) clearInterval(cooldownRef.current);
        cooldownRef.current = setInterval(() => {
            setSignupCooldown(prev => {
                if (prev <= 1) {
                    if (cooldownRef.current) clearInterval(cooldownRef.current);
                    return 0;
                }
                return prev - 1;
            });
        }, 1000);
    }, []);

    // Vérifier au mount si un cooldown est encore actif (localStorage)
    useEffect(() => {
        const savedTs = localStorage.getItem(LS_KEY);
        if (savedTs) {
            const elapsed = (Date.now() - Number(savedTs)) / 1000;
            const remaining = SIGNUP_COOLDOWN_CLIENT - elapsed;
            if (remaining > 0) {
                // eslint-disable-next-line react-hooks/set-state-in-effect -- délai d'inscription en cours (localStorage) repris au montage avec son minuteur
                startCooldownTimer(Math.ceil(remaining));
            }
        }
        return () => { if (cooldownRef.current) clearInterval(cooldownRef.current); };
    }, [startCooldownTimer]);

    const resetForm = useCallback(() => {
        setError(null);
        setSuccess(null);
        setExpiredNotice(false);
        setDeletedNotice(false);
    }, []);

    const switchMode = useCallback((newMode: AuthMode) => {
        setMode(newMode);
        setForgotMode(false);
        setEmailSuggestion(null);
        resetForm();
    }, [resetForm]);

    const handleSubmit = useCallback(async (e: React.FormEvent) => {
        e.preventDefault();
        setError(null);
        setSuccess(null);
        setExpiredNotice(false);
        setDeletedNotice(false);

        // Validation
        if (!email.trim() || !password.trim()) {
            setError(t('supabase_error_required'));
            return;
        }

        if (mode === 'register') {
            if (!isPasswordLongEnough(password)) {
                setError(t('supabase_error_password_length'));
                return;
            }
            if (password !== confirmPassword) {
                setError(t('supabase_error_password_mismatch'));
                return;
            }
            if (!acceptTerms) {
                setError(t('supabase_error_terms_required'));
                return;
            }

            // S2 : Vérifier typo domaine email avant signUp
            const suggestion = suggestEmailCorrection(email);
            if (suggestion && !emailSuggestion) {
                // Première détection → afficher suggestion, bloquer le submit
                setEmailSuggestion(suggestion);
                return;
            }

            // S3 : Vérifier cooldown localStorage avant signUp
            if (signupCooldown > 0) {
                setError(t('supabase_signup_cooldown', { seconds: signupCooldown }));
                return;
            }
        }

        setIsSubmitting(true);

        try {
            if (mode === 'login') {
                const { errorKey: loginErrorKey } = await signIn(email, password);
                if (loginErrorKey) setError(t(loginErrorKey));
                // Si succès, le SupabaseAuthContext met à jour le state → l'app redirige automatiquement
            } else {
                const { error: registerError, errorKey: registerErrorKey } = await signUp(email, password);
                if (registerError) {
                    // S3 : Parser rate-limit Supabase si applicable
                    const rateLimitMatch = registerError.match(/after (\d+) second/i);
                    if (rateLimitMatch) {
                        const seconds = parseInt(rateLimitMatch[1], 10) + 2; // +2s marge
                        localStorage.setItem(LS_KEY, String(Date.now()));
                        startCooldownTimer(seconds);
                        setError(t('supabase_signup_cooldown', { seconds }));
                    } else {
                        setError(t(registerErrorKey ?? 'auth_error_generic'));
                    }
                } else {
                    // S3 : Sauvegarder timestamp signup réussi
                    localStorage.setItem(LS_KEY, String(Date.now()));
                    startCooldownTimer(SIGNUP_COOLDOWN_CLIENT);

                    setLastRegisteredEmail(email);
                    setEmailSuggestion(null);
                    setSuccess(t('supabase_success_registered'));
                    setMode('login');
                    setPassword('');
                    setConfirmPassword('');
                }
            }
        } finally {
            setIsSubmitting(false);
        }
    }, [email, password, confirmPassword, mode, acceptTerms, signIn, signUp, t, emailSuggestion, signupCooldown, startCooldownTimer]);

    const handleResend = useCallback(async () => {
        if (!lastRegisteredEmail || isResending || resendCooldown) return;
        setIsResending(true);
        try {
            const { error: resendError } = await supabase.auth.resend({
                type: 'signup',
                email: lastRegisteredEmail,
            });
            if (resendError) {
                setError(t(authErrorKey(resendError)));
            } else {
                setSuccess(t('supabase_success_resent'));
                setResendCooldown(true);
                setTimeout(() => setResendCooldown(false), SIGNUP_COOLDOWN_CLIENT * 1000);
            }
        } catch {
            setError(t('supabase_error_resend_failed'));
        } finally {
            setIsResending(false);
        }
    }, [lastRegisteredEmail, isResending, resendCooldown, t]);

    const handleForgotPassword = useCallback(async () => {
        if (!email.trim()) {
            setError(t('supabase_error_forgot_email'));
            return;
        }
        setForgotLoading(true);
        setError(null);
        try {
            const { error: resetError } = await supabase.auth.resetPasswordForEmail(email, {
                redirectTo: 'https://nyxplayer.app/auth/reset-password.html',
            });
            if (resetError) {
                setError(t(authErrorKey(resetError)));
            } else {
                setSuccess(t('supabase_success_reset_sent'));
                setForgotMode(false);
            }
        } catch {
            setError(t('supabase_error_reset_failed'));
        } finally {
            setForgotLoading(false);
        }
    }, [email, t]);

    const toggleLanguage = useCallback(() => {
        void i18n.changeLanguage(i18n.resolvedLanguage === 'fr' ? 'en' : 'fr');
    }, [i18n]);

    // ---- DevPanel overrides : variables effectives ----
    const effectiveMode: AuthMode | 'forgot' = dev.forceMode ?? (forgotMode ? 'forgot' : mode);
    const effectiveForgotMode = effectiveMode === 'forgot';
    const effectiveAuthMode: AuthMode = effectiveMode === 'forgot' ? 'login' : effectiveMode;

    const effectiveError = dev.forceLongError
        ? DEV_LONG_ERROR
        : dev.forceError
            ? (dev.forceError === 'login_incorrect'
                ? 'Invalid login credentials'
                : dev.forceError === 'supabase_brute'
                    ? 'Email rate limit exceeded: please wait 60 seconds before trying again'
                    : t(dev.forceError as 'supabase_signup_cooldown', { seconds: 45 }))
            : error ?? (deletedNotice
                ? t('supabase_account_deleted_elsewhere')
                : expiredNotice ? t('supabase_session_expired') : null);

    const effectiveSuccess = dev.forceSuccess
        ? dev.forceSuccess === 'registered'
            ? t('supabase_success_registered')
            : dev.forceSuccess === 'resent'
                ? t('supabase_success_resent')
                : t('supabase_success_reset_sent')
        : success;

    const effectiveIsSubmitting = dev.forceLoadingSubmit || isSubmitting;
    const effectiveForgotLoading = dev.forceLoadingForgot || forgotLoading;
    const effectiveIsResending = dev.forceLoadingResend || isResending;
    const effectiveEmailSuggestion = dev.forceEmailSuggestion ?? emailSuggestion;
    const effectiveSignupCooldown = dev.forceSignupCooldown ?? signupCooldown;
    const effectiveResendCooldown = dev.forceResendCooldown || resendCooldown;
    const effectiveAcceptTerms = dev.forceAcceptTerms ?? acceptTerms;
    const effectiveLastRegisteredEmail = dev.forceLastRegisteredEmail ?? lastRegisteredEmail;

    return (
        <div className="supabase-auth" data-testid="auth-page">
            {/* Globe toggle — langue pré-login (localStorage only) */}
            <button
                data-testid="auth-language"
                type="button"
                className="lang-toggle"
                onClick={toggleLanguage}
                aria-label={t('common:toggle_language')}
            >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><path d="M2 12h20" /><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" /></svg>
                {' '}{i18n.resolvedLanguage === 'fr' ? 'FR' : 'EN'}
            </button>

            <div className="supabase-auth__card scrollbar-thin">
                {/* Header */}
                <div className="supabase-auth__header">
                    <img
                        src={logoSecondaireBlanc}
                        alt="Nyx Player"
                        className="supabase-auth__brand-logo"
                    />
                    {!effectiveForgotMode && (
                        <p className="supabase-auth__subtitle">
                            {effectiveAuthMode === 'login' ? t('supabase_subtitle_login') : t('supabase_subtitle_register')}
                        </p>
                    )}
                </div>

                {/* ---- FORGOT MODE: dedicated screen ---- */}
                {effectiveForgotMode && (
                    <div className="supabase-auth__forgot-screen">
                        <h2 className="supabase-auth__forgot-title">{t('supabase_forgot_password')}</h2>
                        <p className="supabase-auth__forgot-text">{t('supabase_forgot_text')}</p>

                        {effectiveError && <div className="supabase-auth__error">{effectiveError}</div>}
                        {effectiveSuccess && <div className="supabase-auth__success"><span>{effectiveSuccess}</span></div>}

                        <div className="supabase-auth__field">
                            <label className="supabase-auth__label" htmlFor="forgot-email">{t('supabase_label_email')}</label>
                            <input
                                data-testid="auth-forgot-email"
                                id="forgot-email"
                                className="supabase-auth__input"
                                type="email"
                                placeholder={t('supabase_placeholder_email')}
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                                autoComplete="off"
                            />
                        </div>

                        <NyxButton
                            data-testid="auth-forgot-submit"
                            type="button"
                            variant={dev.forceButtonVariant ?? 'primary'}
                            size={dev.forceButtonSize ?? 'md'}
                            color={dev.forceButtonColor ?? 'blue-light'}
                            onClick={() => void handleForgotPassword()}
                            disabled={effectiveForgotLoading}
                        >
                            {effectiveForgotLoading && <span className="supabase-auth__spinner" />}
                            {t('supabase_btn_send_reset')}
                        </NyxButton>

                        <button
                            data-testid="auth-forgot-back"
                            type="button"
                            className="supabase-auth__back-link"
                            onClick={() => setForgotMode(false)}
                        >
                            ← {t('supabase_forgot_back')}
                        </button>
                    </div>
                )}

                {/* ---- NORMAL MODE: tabs + form ---- */}
                {!effectiveForgotMode && (
                    <>
                        {/* Tabs */}
                        <div className="supabase-auth__tabs">
                            <button
                                type="button"
                                className={`supabase-auth__tab ${effectiveAuthMode === 'login' ? 'supabase-auth__tab--active' : ''}`}
                                data-testid="auth-tab-login"
                                onClick={() => switchMode('login')}
                            >
                                {t('supabase_tab_signin')}
                            </button>
                            <button
                                type="button"
                                className={`supabase-auth__tab ${effectiveAuthMode === 'register' ? 'supabase-auth__tab--active' : ''}`}
                                data-testid="auth-tab-register"
                                onClick={() => switchMode('register')}
                            >
                                {t('supabase_tab_register')}
                            </button>
                        </div>

                        {/* Error / Success */}
                        {effectiveError && <div className="supabase-auth__error" data-testid="auth-error">{effectiveError}</div>}
                        {effectiveSuccess && (
                            <div className="supabase-auth__success">
                                <span>{effectiveSuccess}</span>
                                {effectiveLastRegisteredEmail && (
                                    <button
                                        data-testid="auth-resend"
                                        type="button"
                                        className="supabase-auth__resend"
                                        onClick={() => void handleResend()}
                                        disabled={effectiveIsResending || effectiveResendCooldown}
                                    >
                                        {effectiveIsResending
                                            ? t('supabase_btn_resending')
                                            : effectiveResendCooldown
                                                ? t('supabase_btn_resent')
                                                : t('supabase_btn_resend')}
                                    </button>
                                )}
                                {/* S4 : Message fallback confirmation (anti-énumération) */}
                                <p className="supabase-auth__confirmation-hint">
                                    {t('supabase_confirmation_hint')}
                                </p>
                            </div>
                        )}

                        {/* S2 : Suggestion correction email */}
                        {effectiveEmailSuggestion && (
                            <div className="supabase-auth__email-suggestion">
                                <Trans i18nKey="supabase_email_suggestion" ns="auth" values={{ suggested: effectiveEmailSuggestion }} components={{ strong: <strong /> }} />
                                <div className="supabase-auth__email-suggestion-actions">
                                    <button
                                        data-testid="auth-email-suggestion-accept"
                                        type="button"
                                        onClick={() => { setEmail(effectiveEmailSuggestion); setEmailSuggestion(null); }}
                                    >
                                        {t('supabase_email_suggestion_confirm')}
                                    </button>
                                    <button
                                        data-testid="auth-email-suggestion-dismiss"
                                        type="button"
                                        onClick={() => setEmailSuggestion(null)}
                                    >
                                        {t('supabase_email_suggestion_dismiss')}
                                    </button>
                                </div>
                            </div>
                        )}

                        {/* Form */}
                        <form className="supabase-auth__form" onSubmit={(e) => void handleSubmit(e)} data-testid="auth-form">
                            <div className="supabase-auth__field">
                                <label className="supabase-auth__label" htmlFor="auth-email">{t('supabase_label_email')}</label>
                                <input
                                    id="auth-email"
                                    data-testid="auth-email"
                                    className="supabase-auth__input"
                                    type="email"
                                    placeholder={t('supabase_placeholder_email')}
                                    value={email}
                                    onChange={(e) => { setEmail(e.target.value); setEmailSuggestion(null); }}
                                    autoComplete="off"
                                    required
                                    // Télécommande : premier focus sur l'e-mail, clavier ouvert par OK
                                    autoFocus={isTv()}
                                    {...(isTv() ? QUIET_IME_PROPS : {})}
                                />
                            </div>

                            <div className="supabase-auth__field">
                                <label className="supabase-auth__label" htmlFor="auth-password">{t('supabase_label_password')}</label>
                                <div className="supabase-auth__input-wrapper">
                                    <input
                                        id="auth-password"
                                        data-testid="auth-password"
                                        ref={passwordRef}
                                        {...passwordLongPress.rootProps}
                                        // Télécommande : valider le mot de passe amène sur « Connecter »
                                        data-nav-enter-next={effectiveAuthMode === 'login' ? 'auth-submit' : undefined}
                                        className="supabase-auth__input"
                                        type={showPassword ? 'text' : 'password'}
                                        placeholder={t('supabase_placeholder_password')}
                                        value={password}
                                        onChange={(e) => setPassword(e.target.value)}
                                        autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                                        required
                                    />
                                    <button
                                        data-testid="auth-password-toggle"
                                        type="button"
                                        className="supabase-auth__eye-toggle"
                                        onClick={() => setShowPassword(v => !v)}
                                        aria-label={showPassword ? t('common:password_hide') : t('common:password_show')}
                                        tabIndex={-1}
                                    >
                                        {showPassword ? <EyeClosed /> : <EyeOpen />}
                                    </button>
                                </div>
                            </div>

                            {effectiveAuthMode === 'login' && (
                                <button
                                    data-testid="auth-forgot"
                                    type="button"
                                    className="supabase-auth__forgot"
                                    onClick={() => setForgotMode(true)}
                                >
                                    {t('supabase_forgot_password')}
                                </button>
                            )}

                            {effectiveAuthMode === 'register' && (
                                <div className="supabase-auth__field">
                                    <label className="supabase-auth__label" htmlFor="auth-confirm">{t('supabase_label_confirm_password')}</label>
                                    <div className="supabase-auth__input-wrapper">
                                        <input
                                            data-testid="auth-confirm-password"
                                            id="auth-confirm"
                                            ref={confirmPasswordRef}
                                            {...confirmLongPress.rootProps}
                                            className="supabase-auth__input"
                                            type={showConfirmPassword ? 'text' : 'password'}
                                            placeholder={t('supabase_placeholder_password')}
                                            value={confirmPassword}
                                            onChange={(e) => setConfirmPassword(e.target.value)}
                                            autoComplete="new-password"
                                            required
                                        />
                                        <button
                                            data-testid="auth-confirm-password-toggle"
                                            type="button"
                                            className="supabase-auth__eye-toggle"
                                            onClick={() => setShowConfirmPassword(v => !v)}
                                            aria-label={showConfirmPassword ? t('common:password_hide') : t('common:password_show')}
                                            tabIndex={-1}
                                        >
                                            {showConfirmPassword ? <EyeClosed /> : <EyeOpen />}
                                        </button>
                                    </div>
                                </div>
                            )}

                            {effectiveAuthMode === 'register' && (
                                <label className="supabase-auth__terms-checkbox">
                                    <input
                                        data-testid="auth-terms-accept"
                                        type="checkbox"
                                        checked={effectiveAcceptTerms}
                                        onChange={(e) => setAcceptTerms(e.target.checked)}
                                    />
                                    <span>
                                        {t('supabase_accept_terms')}{' '}
                                        <button
                                            data-testid="auth-terms-link"
                                            type="button"
                                            className="supabase-auth__terms-link"
                                            // Télécommande : Bas depuis le mot de passe va sur la case, pas sur ce lien (CGU aussi en bas de page)
                                            tabIndex={passwordLongPress.tv ? -1 : undefined}
                                            onClick={() => void openExternalLink(termsUrl(i18n.resolvedLanguage))}
                                        >
                                            {t('supabase_terms_link')}
                                        </button>
                                    </span>
                                </label>
                            )}

                            <NyxButton
                                type="submit"
                                id="auth-submit"
                                data-testid="auth-submit"
                                variant={dev.forceButtonVariant ?? 'primary'}
                                size={dev.forceButtonSize ?? 'md'}
                                color={dev.forceButtonColor ?? (effectiveAuthMode === 'login' ? 'blue' : 'blue-light')}
                                disabled={effectiveIsSubmitting || (effectiveAuthMode === 'register' && !effectiveAcceptTerms) || (effectiveAuthMode === 'register' && effectiveSignupCooldown > 0)}
                            >
                                {effectiveIsSubmitting && <span className="supabase-auth__spinner" />}
                                {effectiveAuthMode === 'register' && effectiveSignupCooldown > 0
                                    ? t('supabase_signup_cooldown', { seconds: effectiveSignupCooldown })
                                    : effectiveAuthMode === 'login' ? t('supabase_btn_signin') : t('supabase_btn_register')}
                            </NyxButton>
                        </form>

                        {/* Sans compte : tout reste sur l'appareil (docs/plans/MODE_INVITE_PLAN.md) */}
                        <div className="supabase-auth__guest">
                            {/* « ou » : deux chemins au choix, la connexion reste l'action principale */}
                            <div className="supabase-auth__or" role="separator">
                                <span>{t('supabase_or')}</span>
                            </div>
                            <NyxButton
                                data-testid="auth-guest"
                                variant="secondary"
                                size="sm"
                                color="blue"
                                onClick={onContinueAsGuest ?? enterGuestMode}
                            >
                                {t('supabase_btn_guest')}
                            </NyxButton>
                            <p className="supabase-auth__guest-hint">{t('supabase_guest_hint')}</p>
                        </div>
                    </>
                )}

                <div className="supabase-auth__legal-footer">
                    <button data-testid="auth-legal-terms" type="button" onClick={() => void openExternalLink(termsUrl(i18n.resolvedLanguage))}>
                        {t('supabase_footer_terms')}
                    </button>
                    <span>·</span>
                    <button data-testid="auth-legal-privacy" type="button" onClick={() => void openExternalLink(privacyPolicyUrl(i18n.resolvedLanguage))}>
                        {t('supabase_footer_privacy')}
                    </button>
                </div>
            </div>
        </div>
    );
};

export default SupabaseAuthPage;
