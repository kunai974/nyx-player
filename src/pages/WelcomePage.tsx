/**
 * WelcomePage — Écran d'arrivée de la TV : « Se connecter », « Avec mon téléphone » (QR code, ajouté le
 * 07/11) et « Continuer sans compte »
 *
 * Seulement sur Android TV et seulement sans compte connecté (téléphone et PC ouvrent l'écran de
 * connexion, avec « Continuer sans compte » en bouton secondaire dessous) : la télécommande
 * atteint les deux choix sans taper une adresse e-mail.
 *
 * Parcours (docs/plans/ANDROID_TV_PLAN.md) : le focus part sur « Se connecter », Gauche / Droite
 * passent d'une tuile à l'autre.
 */

import React, { useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import logoSecondaireBlanc from '../assets/brand/logo-secondaire-blanc.svg';
import { useTvPageFocus } from '../hooks/useTvPageFocus';
import './WelcomePage.css';

interface WelcomePageProps {
    onSignIn: () => void;
    /** Connexion par QR code, le compte saisi sur le téléphone (TvLinkAccountPage) */
    onSignInWithPhone?: () => void;
    onContinueAsGuest: () => void;
}

const WelcomePage: React.FC<WelcomePageProps> = ({ onSignIn, onSignInWithPhone, onContinueAsGuest }) => {
    const { t, i18n } = useTranslation(['auth', 'common']);

    const toggleLanguage = useCallback(() => {
        void i18n.changeLanguage(i18n.resolvedLanguage === 'fr' ? 'en' : 'fr');
    }, [i18n]);

    const rootRef = useRef<HTMLDivElement>(null);
    useTvPageFocus(rootRef, ['.welcome-tile'], true, 'welcome');

    return (
        <div className="welcome" ref={rootRef} data-testid="welcome-page">
            <button
                data-testid="welcome-language"
                data-nav-row="welcome-language"
                type="button"
                className="lang-toggle"
                onClick={toggleLanguage}
                aria-label={t('common:toggle_language')}
            >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><path d="M2 12h20" /><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" /></svg>
                {' '}{i18n.resolvedLanguage === 'fr' ? 'FR' : 'EN'}
            </button>

            <div className="welcome__content">
                <img src={logoSecondaireBlanc} alt="Nyx Player" className="welcome__logo" />
                <h1 className="welcome__title">{t('welcome_title')}</h1>

                <div className="welcome__tiles" data-nav-row="welcome-tiles">
                    <button type="button" className="welcome-tile" data-testid="welcome-signin" onClick={onSignIn}>
                        <span className="welcome-tile__label">{t('welcome_signin')}</span>
                        <span className="welcome-tile__hint">{t('welcome_signin_hint')}</span>
                    </button>
                    {onSignInWithPhone && (
                        <button type="button" className="welcome-tile" data-testid="welcome-phone" onClick={onSignInWithPhone}>
                            <span className="welcome-tile__label">{t('welcome_phone')}</span>
                            <span className="welcome-tile__hint">{t('welcome_phone_hint')}</span>
                        </button>
                    )}
                    <button type="button" className="welcome-tile" data-testid="welcome-guest" onClick={onContinueAsGuest}>
                        <span className="welcome-tile__label">{t('welcome_guest')}</span>
                        <span className="welcome-tile__hint">{t('welcome_guest_hint')}</span>
                    </button>
                </div>
            </div>
        </div>
    );
};

export default WelcomePage;
