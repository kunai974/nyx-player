/**
 * ChannelCard - Carte de chaîne TV avec picon
 *
 * Affiche le logo de la chaîne (picon xxlarge) et son nom.
 * Supporte le marquage favori.
 */

import React, { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import ChannelLogo from '../ChannelLogo';
import { prises, type ChannelCardDebugInfo } from '../../services/outilsTest';
import { clickableProps } from '../../utils/clickable';
import { useTvLongPress } from '../../hooks/useTvLongPress';
import './ChannelCard.css';

interface ChannelCardProps {
    channelName: string;
    streamIcon?: string;
    onClick: () => void;
    isFavorite?: boolean;
    onToggleFavorite?: (e?: React.MouseEvent) => void;
    /** EPG: titre du programme en cours */
    epgTitle?: string;
    /** EPG: plage horaire (ex: "18:00 - 19:30") */
    epgTimeRange?: string;
    /** EPG: progression 0-100 */
    epgProgress?: number;
    /** Diagnostic du guide TV, affiché seulement en développement */
    debugInfo?: ChannelCardDebugInfo;
}

const ChannelCard: React.FC<ChannelCardProps> = ({
    channelName,
    streamIcon,
    onClick,
    isFavorite = false,
    onToggleFavorite,
    epgTitle,
    epgTimeRange,
    epgProgress,
    debugInfo,
}) => {
    const { t } = useTranslation('tv');
    // Télécommande : la chaîne est un arrêt (OK = lecture), appui long = ajouter ou retirer des favoris
    const rootRef = useRef<HTMLDivElement>(null);
    const tvLongPress = useTvLongPress(rootRef, onToggleFavorite ? () => onToggleFavorite() : undefined);

    return (
        <div
            ref={rootRef}
            className="channel-card"
            data-testid="channel-card"
            {...clickableProps(onClick)}
            {...tvLongPress.rootProps}
            aria-label={channelName}
            onClick={onClick}
            onDragStart={(e) => e.preventDefault()}
        >
            {/* Pastille « i » de diagnostic du guide : version de développement seulement */}
            {import.meta.env.DEV && debugInfo && prises.pastilleChaine && <prises.pastilleChaine debugInfo={debugInfo} />}

            {/* Bouton favori */}
            {onToggleFavorite && (
                <button
                    className={`channel-card__favorite ${isFavorite ? 'channel-card__favorite--active' : ''}`}
                    data-testid="channel-card-favorite"
                    onClick={onToggleFavorite}
                    tabIndex={tvLongPress.tv ? -1 : undefined}
                    title={isFavorite ? t('favorite_remove') : t('favorite_add')}
                >
                    {isFavorite ? (
                        <svg viewBox="0 0 192.6 172.24" fill="currentColor" style={{ width: '1rem', height: '1rem' }}>
                            <path d="M143.2,0c-13.34,0-25.84,5.53-35.21,15.57l-4.54,4.86s-3.58,3.84-7.16,7.67l-7.16-7.67-4.54-4.86C75.24,5.53,62.73,0,49.39,0S23.55,5.53,14.18,15.57c-18.91,20.27-18.91,53.26,0,73.54l74.96,75.89,7.16,7.24c3.58-3.62,7.16-7.24,7.16-7.24l74.96-75.89c18.91-20.28,18.91-53.27,0-73.54-9.37-10.04-21.87-15.57-35.21-15.57h0Z"/>
                        </svg>
                    ) : (
                        <svg viewBox="0 0 192.6 172.24" fill="currentColor" style={{ width: '1rem', height: '1rem' }}>
                            <path d="M143.2,20c7.85,0,14.96,3.19,20.59,9.21,11.64,12.48,11.69,33.51.17,46.08l-67.66,68.5L28.64,75.29c-11.52-12.56-11.47-33.6.17-46.08,5.62-6.03,12.74-9.21,20.59-9.21s14.96,3.19,20.59,9.21l4.54,4.86,7.16,7.67,14.62,15.68,14.62-15.68,7.16-7.67,4.54-4.86c5.62-6.03,12.74-9.21,20.59-9.21M143.2,0c-13.34,0-25.84,5.53-35.21,15.57l-4.54,4.86s-3.58,3.84-7.16,7.67l-7.16-7.67-4.54-4.86C75.24,5.53,62.73,0,49.39,0S23.55,5.53,14.18,15.57c-18.91,20.27-18.91,53.26,0,73.54l74.96,75.89,7.16,7.24c3.58-3.62,7.16-7.24,7.16-7.24l74.96-75.89c18.91-20.28,18.91-53.27,0-73.54-9.37-10.04-21.87-15.57-35.21-15.57h0Z"/>
                        </svg>
                    )}
                </button>
            )}

            {/* Picon */}
            <div className="channel-card__logo">
                <ChannelLogo
                    channelName={channelName}
                    xtreamIcon={streamIcon}
                    size="xxlarge"
                />
            </div>

            {/* Nom de la chaîne */}
            <div className="channel-card__name">{channelName}</div>

            {/* EPG: Programme en cours */}
            {epgTitle && (
                <div className="channel-card__epg">
                    <div className="channel-card__epg-title">{epgTitle}</div>
                    {epgTimeRange && (
                        <div className="channel-card__epg-time">{epgTimeRange}</div>
                    )}
                    {epgProgress !== undefined && (
                        <div className="channel-card__epg-bar">
                            <div
                                className="channel-card__epg-fill"
                                style={{ width: `${epgProgress}%` }}
                            />
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

export default ChannelCard;
