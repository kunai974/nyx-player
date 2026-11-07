/**
 * EpisodeCard.tsx - Carte d'épisode pour le carousel série
 *
 * Composant réutilisable extrait de SeriesDetailPage.tsx (Phase 6.1)
 * Affiche: thumbnail, titre, synopsis, durée, qualité, bouton play
 */

import React, { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { XtreamEpisode } from '../../types/xtream';
import { clearProgress } from '../../services/playbackProgressService';
import { useTvLongPress } from '../../hooks/useTvLongPress';
import { clickableProps } from '../../utils/clickable';
import { warnOnReject } from '../../utils/warnOnReject';
import { showAppNotice } from '../../utils/appNotice';

/** Données TMDB d'un épisode (optionnel) */
export interface TmdbEpisodeData {
    name?: string | null;
    overview?: string | null;
    runtime?: number | null;
    still_path?: string | null;
}

export interface EpisodeCardProps {
    /** Épisode Xtream */
    episode: XtreamEpisode;
    /** Numéro de l'épisode */
    episodeNum: number;
    /** Données TMDB enrichies (optionnel) */
    tmdbEpisode?: TmdbEpisodeData;
    /** URL de l'image de l'épisode */
    imageUrl: string;
    /** Fallback si image échoue */
    posterFallback: string;
    /** Progression de lecture (0-100) */
    progress: number;
    /** Si le drag est en cours (empêche le clic) */
    dragStarted: boolean;
    /** Callback de lecture */
    onPlay: (episode: XtreamEpisode) => void;
    /** Callback optionnel après reset (pour refresh parent) */
    onProgressReset?: () => void;
    /** TMDB season data still loading — show shimmer on image/synopsis */
    tmdbLoading?: boolean;
}

// Note: Quality badge function removed - badge was inconsistent and caused layout issues

/**
 * Carte d'épisode Netflix-style
 */
export const EpisodeCard: React.FC<EpisodeCardProps> = ({
    episode,
    episodeNum,
    tmdbEpisode,
    imageUrl,
    posterFallback,
    progress,
    dragStarted,
    onPlay,
    onProgressReset,
    tmdbLoading = false,
}) => {
    const { t } = useTranslation('details');
    // État local pour tracker la progression (permet le reset visuel immédiat)
    const [localProgress, setLocalProgress] = useState(progress);


    // Synchroniser localProgress quand la prop progress change (après chargement SQLite)
    const [syncedProgress, setSyncedProgress] = useState(progress);
    if (!Object.is(progress, syncedProgress)) {
        setSyncedProgress(progress);
        setLocalProgress(progress);
    }

    // Image de l'épisode, puis l'affiche de la série ; aucune qui charge : la vignette reste un fond uni
    // (jamais l'icône d'image cassée avec le texte de remplacement en haut)
    const [failedImages, setFailedImages] = useState<string[]>([]);
    const shownImage = [imageUrl, posterFallback].find((url) => url && !failedImages.includes(url));

    // Données avec fallbacks TMDB → Xtream
    const episodeTitle = tmdbEpisode?.name || episode.title || '';
    const synopsis = tmdbEpisode?.overview || '';
    const runtime = tmdbEpisode?.runtime || episode.info?.duration || episode.duration || '';

    // Handle reset
    const handleReset = (e?: React.MouseEvent) => {
        e?.stopPropagation();
        const contentId = episode.id || episode.title;
        if (contentId) {
            const previous = localProgress;
            setLocalProgress(0);
            clearProgress(contentId).then(() => {
                onProgressReset?.();
            }).catch((err) => {
                warnOnReject('EpisodeCard')(err);
                setLocalProgress(previous);
                showAppNotice('progress_reset_failed');
            });
        }
    };

    // Télécommande : la carte est un arrêt (OK = lecture), appui long = remise à zéro de la progression
    const rootRef = useRef<HTMLDivElement>(null);
    // Toujours armé : sans ça, OK lançait la lecture dès l'appui, avant de savoir s'il était long
    const tvLongPress = useTvLongPress(rootRef, () => {
        if (localProgress > 0) handleReset();
    });
    const tv = tvLongPress.tv;
    const actionTabIndex = tv ? -1 : undefined;

    return (
        <div
            ref={rootRef}
            className="episode-card-netflix"
            data-testid="episode-card"
            data-episode-num={episodeNum}
            {...(tv ? clickableProps(() => onPlay(episode)) : {})}
            onClick={tv ? () => { if (!dragStarted) onPlay(episode); } : undefined}
            {...tvLongPress.rootProps}
        >
            <div className="episode-thumbnail">
                {tmdbLoading ? (
                    <div className="skeleton-item episode-thumbnail-skeleton" />
                ) : shownImage ? (
                    <img
                        key={shownImage}
                        src={shownImage}
                        alt={episodeTitle || t('episode_label_badge', { count: episodeNum })}
                        draggable={false}
                        onError={() => setFailedImages((failed) => [...failed, shownImage])}
                    />
                ) : null}

                {/* Title overlay on image */}
                {!tmdbLoading && episodeTitle && (
                    <div className="episode-title-overlay">
                        <span className="episode-num-label">{t('episode_label_badge', { count: episodeNum })}</span>
                        <span className="episode-title-label">{episodeTitle}</span>
                    </div>
                )}

                {/* Episode number badge if no title */}
                {!episodeTitle && (
                    <span className="episode-number-badge">{t('episode_label_badge', { count: episodeNum })}</span>
                )}

                {/* Reset button - top right corner */}
                {localProgress > 0 && (
                    <button
                        className="episode-reset-btn"
                        data-testid="episode-card-reset"
                        tabIndex={actionTabIndex}
                        title={t('restart_episode')}
                        onClick={handleReset}
                    >
                        <svg width="14" height="14" viewBox="0 0 192.49 171.14" fill="currentColor" aria-hidden="true"><path d="M105.53,171.05c.45.06.92.09,1.39.09,60.32,0,106.26-62.73,76.01-126.37-7.32-15.4-19.77-27.86-35.17-35.19C84.47-20.52,22.13,24.71,21.38,84.5H0l32.72,31.05,32.72-31.05h-23.06c.76-45.82,49.45-80.19,98.01-54.95,9.73,5.06,17.67,13.08,22.7,22.83,25.41,49.33-10.61,98.75-57.56,97.74v20.93Z"/></svg>
                    </button>
                )}

                {/* Progress bar */}
                {localProgress > 0 && (
                    <div className="episode-progress-bar" data-testid="episode-card-progress">
                        <div className="progress-fill" style={{ width: `${localProgress}%` }} />
                    </div>
                )}
            </div>

            <div className="episode-details">
                {/* Synopsis - avec fallback si absent */}
                <div className="episode-synopsis">
                    {tmdbLoading ? (
                        <>
                            <div className="skeleton-item episode-synopsis-skeleton" />
                            <div className="skeleton-item episode-synopsis-skeleton short" />
                        </>
                    ) : (
                        synopsis || <span className="episode-synopsis--fallback">{t('no_synopsis')}</span>
                    )}
                </div>

                {/* Runtime only - Quality badge removed (inconsistent + takes space) */}
                <div className="episode-meta-row">
                    {runtime && <span className="episode-duration">{runtime} {t('duration_min')}</span>}
                </div>

                {/* Play button */}
                <button
                    className="episode-play-btn"
                    data-testid="episode-card-play"
                    tabIndex={actionTabIndex}
                    onClick={(e) => {
                        e.stopPropagation();
                        if (!dragStarted) onPlay(episode);
                    }}
                >
                    ▶ {t('play_button')}
                </button>
            </div>
        </div>
    );
};



