/**
 * GuestAccountSection — Réglages > Compte quand Nyx est utilisé sans compte (espace invité)
 *
 * - une carte « Vous utilisez Nyx sans compte » ;
 * - « Créer un compte » et « Se connecter » : quittent l'espace invité, dont les données restent sur
 *   l'appareil (le passage invité → compte, avec reprise des données, viendra après le multi-sources) ;
 * - « Effacer les données de cet appareil » : la remise à zéro complète ouvre la même fenêtre de
 *   confirmation que Réglages > Données.
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import NyxButton from '../Common/NyxButton';
import { guestRelayPausedUntil } from '../../services/guestRelay';

interface GuestAccountSectionProps {
  onLeaveGuest?: (intent: 'login' | 'register') => void;
  onEraseDeviceData: () => void;
}

const GuestAccountSection: React.FC<GuestAccountSectionProps> = ({ onLeaveGuest, onEraseDeviceData }) => {
  const { t, i18n } = useTranslation('settings');
  // Fiches TMDB du relais en pause (limite du jour atteinte) : dit jusqu'à quand
  const pausedUntil = guestRelayPausedUntil();
  const pausedTime = pausedUntil
    ? new Date(pausedUntil).toLocaleString(i18n.language, { weekday: 'long', hour: '2-digit', minute: '2-digit' })
    : null;

  return (
    <div className="settings-section settings-section--guest" data-testid="guest-account-section">
      <h2 className="settings-section__title"><span className="section-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: '1.25rem', height: '1.25rem' }}><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg></span> {t('account_section_title')}</h2>

      {/* Une seule carte : des cartes empilées sans marge se touchaient à l'écran */}
      <div className="setting-item">
        <div className="setting-item__info">
          <span className="setting-item__label" data-testid="guest-card-title">{t('guest_card_title')}</span>
          <span className="setting-item__desc">{t('guest_card_text')}</span>
          <span className="setting-item__desc">{t('guest_account_later')}</span>
          <div className="settings-form-actions">
            <NyxButton data-testid="guest-create-account" variant="primary" size="sm" color="blue" onClick={() => onLeaveGuest?.('register')}>
              {t('guest_create_account')}
            </NyxButton>
            <NyxButton data-testid="guest-sign-in" variant="secondary" size="sm" color="blue" onClick={() => onLeaveGuest?.('login')}>
              {t('guest_sign_in')}
            </NyxButton>
          </div>
        </div>
      </div>

      {pausedTime && (
        <>
          <div className="settings-separator" />
          <div className="setting-item" data-testid="guest-tmdb-paused">
            <div className="setting-item__info">
              <span className="setting-item__desc">{t('guest_tmdb_paused', { time: pausedTime })}</span>
            </div>
          </div>
        </>
      )}

      <div className="settings-separator" />
      <div className="setting-item">
        <div className="setting-item__info">
          <span className="setting-item__label">{t('guest_reset_title')}</span>
          <span className="setting-item__desc">{t('guest_reset_text')}</span>
        </div>
        <NyxButton data-testid="guest-erase-data" variant="primary" size="sm" color="red" onClick={onEraseDeviceData}>
          {t('guest_reset_button')}
        </NyxButton>
      </div>
    </div>
  );
};

export default GuestAccountSection;
