/**
 * Réglage « fiches TMDB par le titre » : sans numéro TMDB du fournisseur (liste M3U, certains Xtream),
 * l'app cherche donc le film ou la série par son titre (lien sûr ou rien). Coupé, les fiches gardent
 * les images et textes de la liste.
 */

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isTmdbTitleSearchEnabled, setTmdbTitleSearch } from '../../services/preferencesService';
import { createLogger } from '../../utils/logger';

const log = createLogger('TmdbTitleSearchOption');

const TmdbTitleSearchOption: React.FC = () => {
    const { t } = useTranslation('settings');
    const [enabled, setEnabled] = useState(isTmdbTitleSearchEnabled);

    const handleChange = (checked: boolean) => {
        setEnabled(checked);
        setTmdbTitleSearch(checked).catch((e: unknown) => {
            log.warn('Réglage non enregistré :', e);
            setEnabled(!checked);
        });
    };

    return (
        <div className="settings-option">
            <div className="option-info">
                <span className="option-label">{t('tmdb_title_search_label')}</span>
                <span className="option-description">{t('tmdb_title_search_desc')}</span>
            </div>
            <label className="toggle-switch">
                <input
                    type="checkbox"
                    checked={enabled}
                    data-testid="settings-tmdb-title-search-toggle"
                    onChange={(e) => handleChange(e.target.checked)}
                />
                <span className="toggle-slider"></span>
            </label>
        </div>
    );
};

export default TmdbTitleSearchOption;
