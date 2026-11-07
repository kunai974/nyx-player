/**
 * Écran Compte — nom du profil : affichage et formulaire de renommage.
 */

import React, { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { updateProfileName } from '../../../services/profileService';
import { useSupabaseAuth } from '../../../contexts/SupabaseAuthContext';
import { PROFILE_NAME_MAX_LENGTH } from '../../../services/sync/cloudLimits';
import { useDevOverrides } from '../../../contexts/DevOverrideContext';
import NyxButton from '../../Common/NyxButton';

interface ProfileNameSettingProps {
  profileName?: string;
  profileId?: string;
  onProfileRenamed?: () => void;
}

const ProfileNameSetting: React.FC<ProfileNameSettingProps> = ({
  profileName,
  profileId,
  onProfileRenamed,
}) => {
  const { t } = useTranslation('settings');
  const sp = useDevOverrides().overrides.settingsPage;
  const userId = useSupabaseAuth().user?.id;

  const [showProfileRename, setShowProfileRename] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [renameLoading, setRenameLoading] = useState(false);
  const [renameSuccess, setRenameSuccess] = useState<string | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);

  // ---- DevPanel effective states ----
  const effectiveShowProfileRename = sp.forceProfileRename || showProfileRename;
  const effectiveRenameLoading = sp.forceAccountLoading === 'rename' || renameLoading;
  const effectiveRenameError = sp.forceAccountError === 'rename' ? 'Simulated rename error' : renameError;
  const effectiveRenameSuccess = sp.forceAccountSuccess === 'rename' ? 'Profile renamed!' : renameSuccess;

  const handleRenameProfile = useCallback(async () => {
    setRenameError(null);
    setRenameSuccess(null);

    const trimmed = renameValue.trim();
    if (!trimmed) {
      setRenameError(t('account_profile_name_required'));
      return;
    }
    if (!profileId || !userId) {
      setRenameError(t('unexpected_error'));
      return;
    }

    setRenameLoading(true);
    try {
      await updateProfileName(userId, profileId, trimmed);
      setRenameSuccess(t('account_profile_renamed'));
      setShowProfileRename(false);
      setRenameValue('');
      onProfileRenamed?.();
    } catch {
      setRenameError(t('unexpected_error'));
    } finally {
      setRenameLoading(false);
    }
  }, [renameValue, profileId, userId, onProfileRenamed, t]);

  const cancelRenameForm = () => {
    setShowProfileRename(false);
    setRenameValue('');
    setRenameError(null);
  };

  return (
    <>
      <div className="setting-item">
        <div className="setting-item__info">
          <span className="setting-item__label">{t('account_profile_label')}</span>
          <span className="setting-item__desc">{profileName || '—'}</span>
        </div>
        {!effectiveShowProfileRename && (
          <NyxButton
            data-testid="settings-profile-rename"
            variant="primary"
            size="sm"
            color="blue"
            onClick={() => { setShowProfileRename(true); setRenameSuccess(null); setRenameValue(profileName || ''); }}
          >
            {t('account_change')}
          </NyxButton>
        )}
      </div>

      {effectiveShowProfileRename && (
        <div className="setting-item setting-item--form">
          <input
            data-testid="settings-profile-rename-input"
            className="settings-input"
            type="text"
            placeholder={t('account_new_profile_name')}
            value={renameValue}
            maxLength={PROFILE_NAME_MAX_LENGTH}
            onChange={(e) => setRenameValue(e.target.value)}
            autoFocus
          />
          {effectiveRenameError && <div className="settings-inline-error">{effectiveRenameError}</div>}
          <div className="settings-form-actions">
            <NyxButton
              data-testid="settings-profile-rename-save"
              variant="primary"
              size="xs"
              color="blue"
              onClick={() => void handleRenameProfile()}
              disabled={effectiveRenameLoading}
            >
              {effectiveRenameLoading ? '…' : t('account_save')}
            </NyxButton>
            <NyxButton
              data-testid="settings-profile-rename-cancel"
              variant="primary"
              size="xs"
              color="red"
              onClick={cancelRenameForm}
            >
              {t('cancel')}
            </NyxButton>
          </div>
        </div>
      )}
      {effectiveRenameSuccess && <div className="settings-inline-success">{effectiveRenameSuccess}</div>}
    </>
  );
};

export default ProfileNameSetting;
