/**
 * M3uSourceForm — saisie d'une source « liste M3U » : adresse de la liste, adresse du guide
 * (facultative). Rend une partie secrète `M3uSourceSecret` prête pour le registre des sources ;
 * l'écran qui l'accueille (liste des sources) l'enregistre lui-même.
 *
 * La validation reste ici, sans réseau : la liste n'est téléchargée qu'une fois la source
 * enregistrée, par le chargement natif (seules les adresses http et https y sont acceptées).
 */

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { M3uSourceSecret } from '../../types/iptvSource';
import { validateM3uSourceInput, type M3uSourceInputError } from '../../services/sources/m3uSourceInput';
import NyxButton from '../Common/NyxButton';

export { validateM3uSourceInput, type M3uSourceInputError } from '../../services/sources/m3uSourceInput';

interface M3uSourceFormProps {
    /** Partie secrète validée ; l'écran parent l'enregistre (et affiche son éventuelle erreur) */
    onSubmit: (secret: M3uSourceSecret) => void | Promise<void>;
    onCancel: () => void;
    /** Enregistrement en cours : boutons désactivés */
    isSaving?: boolean;
    /** Erreur d'enregistrement venue du parent, déjà traduite */
    saveError?: string | null;
}

const M3uSourceForm: React.FC<M3uSourceFormProps> = ({ onSubmit, onCancel, isSaving = false, saveError }) => {
    const { t } = useTranslation('settings');
    const [url, setUrl] = useState('');
    const [epgUrl, setEpgUrl] = useState('');
    const [inputError, setInputError] = useState<M3uSourceInputError | null>(null);

    const handleSubmit = () => {
        const result = validateM3uSourceInput({ url, epgUrl });
        if ('error' in result) {
            setInputError(result.error);
            return;
        }
        setInputError(null);
        void onSubmit(result.secret);
    };

    const error = inputError ? t(`m3u_source_error_${inputError}`) : saveError;

    return (
        <div className="edit-source-form" data-testid="settings-m3u-source-form">
            <div className="edit-fields">
                <div className="edit-field">
                    <label htmlFor="m3u-source-url">{t('m3u_source_url')}</label>
                    <textarea
                        id="m3u-source-url"
                        value={url}
                        autoCapitalize="none"
                        autoCorrect="off"
                        spellCheck={false}
                        rows={3}
                        data-testid="settings-m3u-source-url"
                        onChange={(e) => setUrl(e.target.value)}
                        placeholder="https://example.com/playlist.m3u8"
                    />
                    <p className="field-hint">{t('m3u_source_url_hint')}</p>
                </div>
                <div className="edit-field">
                    <label htmlFor="m3u-source-epg">{t('m3u_source_epg')}</label>
                    <input
                        id="m3u-source-epg"
                        type="text"
                        value={epgUrl}
                        autoCapitalize="none"
                        autoCorrect="off"
                        spellCheck={false}
                        data-testid="settings-m3u-source-epg"
                        onChange={(e) => setEpgUrl(e.target.value)}
                        placeholder="https://example.com/guide.xml"
                    />
                    <p className="field-hint">{t('m3u_source_epg_hint')}</p>
                </div>
            </div>

            {error && <div className="settings-inline-error" data-testid="settings-m3u-source-error">{error}</div>}

            <div className="edit-actions">
                <NyxButton
                    variant="primary"
                    size="sm"
                    color="blue"
                    onClick={handleSubmit}
                    data-testid="settings-m3u-source-save"
                    disabled={isSaving}
                >
                    {isSaving ? t('m3u_source_saving') : t('save')}
                </NyxButton>
                <NyxButton
                    variant="primary"
                    size="sm"
                    color="red"
                    onClick={onCancel}
                    data-testid="settings-m3u-source-cancel"
                    disabled={isSaving}
                >
                    {t('cancel')}
                </NyxButton>
            </div>
        </div>
    );
};

export default M3uSourceForm;
