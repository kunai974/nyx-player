/**
 * Cartes de la rangée « Reprendre » : une reprise (PlaybackProgressItem) devient une carte de carrousel qui lance la
 * lecture directe (film repris à sa position, série à son épisode). Partagé par la rangée React (bureau, téléphone) et
 * par le rail de l'accueil TV.
 */

import { cleanTitle } from '../../utils/itemHelpers';
import { getMovieDetail } from '../../services/detailFetcher';
import { StorageService } from '../../services/storage';
import { XtreamApiService } from '../../services/xtreamApi';
import { getM3uSeriesEpisodes } from '../../services/m3uCatalog';
import type { PlaybackProgressItem } from '../../services/playbackProgressService';
import type { PlayableItem, DirectPlayableItem, PlayOptions } from '../../types/player';
import type { LightIndexes } from '../../types/lightIndex';
import { getIconUrl } from '../../types/lightIndex';
import type { AppSeriesInfo } from '../../types/xtream';
import type { CarouselItem } from '../Lists/ContentCarousel';
import { devLog } from '../../utils/devLog';
import { getCachedXtreamSeries } from '../../services/xtreamSeriesCache';
import { resolveResumeTarget } from '../../services/resumeTarget';

/** Gestes des cartes reprises */
export interface ContinueActions {
    play: (item: PlayableItem | DirectPlayableItem, series?: AppSeriesInfo, startPosition?: number, options?: PlayOptions) => Promise<void>;
    setCurrentSeries: (series: AppSeriesInfo | null) => void;
    navigateById: (type: 'movie' | 'series', id: number | string, tmdbId?: number) => void;
    handleWatchlistToggle: (streamId: number, tmdbId: number, type: 'movie' | 'series') => Promise<void>;
    /** Carte « Introuvable » (titre plus au catalogue) : ouvre la fenêtre Rechercher / Retirer */
    onUnavailable?: (item: PlaybackProgressItem) => void;
}

export interface ContinueLabels {
    /** Texte posé sur une carte « Introuvable » */
    unavailable: string;
}

export function buildContinueItems(
    items: PlaybackProgressItem[],
    lightIndexes: LightIndexes | undefined,
    actions: ContinueActions,
    labels: ContinueLabels,
): CarouselItem[] {
    return items.map((item): CarouselItem => {
        // Build episode badge for series
        let episodeBadge: string | undefined;
        if (item.type === 'series' && item.episodeInfo) {
            const { seasonNumber, episodeNumber, isNextEpisode } = item.episodeInfo;
            const seasonPart = seasonNumber > 0 ? `S${seasonNumber}` : '';
            const badge = `${seasonPart}E${episodeNumber}`;
            episodeBadge = isNextEpisode ? `▶ ${badge}` : badge;
        }

        const tmdbId = item.tmdbId || 0;
        // Numéro repris par un autre titre chez le fournisseur ou disparu du catalogue :
        // jamais lancé. Le titre retrouvé sous un autre numéro est lancé à ce numéro ; sinon la carte
        // est « Introuvable ».
        const target = resolveResumeTarget(item, lightIndexes);
        const unavailable = target.kind === 'unavailable';
        const relinkedId = target.kind === 'relinked' ? target.id : undefined;
        const itemId = item.type === 'movie' && relinkedId ? relinkedId : Number(item.id);
        const seriesId = item.type === 'series' && relinkedId ? relinkedId : item.seriesId;

        // Poster: lightIndexes fallback (posterUrl vide en SQLite). Jamais pour une carte
        // « Introuvable » : le numéro mène à l'affiche d'un autre titre.
        const posterUrl = item.image || (() => {
            if (unavailable) return '';
            if (item.type === 'movie') {
                const lightMovie = lightIndexes?.movies.get(itemId);
                return lightMovie ? getIconUrl(lightMovie, lightIndexes?.iconPrefixes || []) : '';
            } else if (seriesId) {
                const lightSeries = lightIndexes?.series.get(seriesId);
                return lightSeries ? getIconUrl(lightSeries, lightIndexes?.iconPrefixes || []) : '';
            }
            return '';
        })();

        return {
            id: item.id,
            title: cleanTitle(item.title),
            image: posterUrl,
            progress: item.progress,
            mediaType: item.type,
            overlayText: unavailable ? labels.unavailable : episodeBadge,
            unavailable,
            showPlayButton: !unavailable,
            // Carte « Introuvable » : ni bouton Ma liste ni appui long (télécommande), son numéro est
            // celui d'un autre titre ; elle se retire depuis sa fenêtre
            tmdbId: unavailable ? undefined : tmdbId,
            streamId: unavailable ? undefined : (item.type === 'series' && seriesId ? seriesId : itemId),
            // Pas d'ajout à Ma liste depuis une carte « Introuvable » : son numéro est celui d'un autre titre
            onAddToList: unavailable ? undefined : () => {
                const watchlistId = item.type === 'series' && seriesId ? seriesId : itemId;
                void actions.handleWatchlistToggle(watchlistId, tmdbId, item.type);
            },
            onClick: () => {
                if (unavailable) {
                    devLog('data', '[continueItems] Titre introuvable chez le fournisseur, lecture refusée', { type: item.type, tmdbId });
                    actions.onUnavailable?.(item);
                    return;
                }
                if (item.type === 'series' && relinkedId) {
                    // Série retrouvée sous un autre numéro : les numéros d'épisodes enregistrés sont
                    // ceux de l'ancien numéro, on ouvre donc la fiche au lieu de lancer un épisode
                    actions.navigateById('series', relinkedId, tmdbId || undefined);
                    return;
                }
                // LECTURE DIRECTE: lancer le contenu avec seek position
                if (item.type === 'movie') {
                    // Film: lecture directe avec seek
                    void (async () => {
                        // Re-liée : l'extension enregistrée est celle de l'ancien numéro
                        let ext = relinkedId
                            ? lightIndexes?.movies.get(itemId)?.containerExt || undefined
                            : item.containerExtension;
                        // Fallback: récupérer l'extension depuis SQLite si absente
                        if (!ext) {
                            try {
                                const movieDetail = await getMovieDetail(itemId);
                                ext = movieDetail?.container_extension || undefined;
                            } catch (e) {
                                devLog('data', '[continueItems] getMovieDetail fallback failed:', e);
                            }
                        }
                        const playableItem: DirectPlayableItem = {
                            stream_id: itemId,
                            name: item.title,
                            container_extension: ext,
                            tmdb: item.tmdbId || undefined,
                        };
                        // Numéro TMDB transmis : c'est lui qu'enregistre la reprise (le champ `tmdb`
                        // ci-dessus n'y sert pas). Indispensable pour un film re-lié, dont la reprise
                        // part sur une nouvelle ligne.
                        void actions.play(playableItem, undefined, item.timeSeconds, item.tmdbId ? { tmdbId: item.tmdbId } : undefined);
                    })();
                } else if (item.episodeInfo && item.seriesId) {
                    // Série: lookup extension + lecture immédiate
                    void (async () => {
                        const episodeStreamId = item.episodeInfo!.isNextEpisode
                            ? Number(item.episodeInfo!.episodeId)
                            : itemId;
                        const seekPosition = item.episodeInfo!.isNextEpisode ? 0 : item.timeSeconds;

                        // Lookup extension: si next episode, chercher dans le cache série
                        let ext = item.containerExtension;
                        if (item.episodeInfo!.isNextEpisode && item.seriesId) {
                            try {
                                const seriesData = await getCachedXtreamSeries<AppSeriesInfo>(item.seriesId);
                                if (seriesData?.episodes) {
                                    for (const eps of Object.values(seriesData.episodes)) {
                                        const found = eps.find(e => String(e.id) === String(episodeStreamId));
                                        if (found) {
                                            devLog('data', '[continueItems] Next episode ext resolved:', found.container_extension);
                                            ext = found.container_extension || ext;
                                            break;
                                        }
                                    }
                                }
                            } catch (e) {
                                devLog('data', '[continueItems] Episode ext lookup failed:', e);
                            }
                        }

                        const playableItem: DirectPlayableItem = {
                            id: String(episodeStreamId),
                            episode_num: item.episodeInfo!.episodeNumber,
                            title: item.title,
                            container_extension: ext || undefined,
                            tmdb: item.tmdbId || undefined,
                        };

                        // Lancer la lecture
                        void actions.play(playableItem, undefined, seekPosition, {
                            seriesId: item.seriesId || undefined,
                            tmdbId: item.tmdbId || undefined,
                            posterUrl: item.image || undefined,
                        });

                        // Background: charger les infos série pour navigation épisodes
                        try {
                            if (item.seriesId) {
                                // Série d'une liste M3U : épisodes pris dans le catalogue, sans fournisseur Xtream
                                const m3uEpisodes = await getM3uSeriesEpisodes(item.seriesId);
                                const creds = m3uEpisodes ? null : await StorageService.getCredentials();
                                const xtreamInfo = m3uEpisodes
                                    ? { episodes: m3uEpisodes, info: undefined }
                                    : creds ? await new XtreamApiService(creds).getSeriesInfo(item.seriesId) : null;
                                if (xtreamInfo) {
                                    const seriesInfo: AppSeriesInfo = {
                                        num: 0,
                                        name: item.title,
                                        series_id: item.seriesId,
                                        cover: item.image,
                                        plot: '',
                                        cast: '',
                                        director: '',
                                        genre: '',
                                        releaseDate: '',
                                        last_modified: '',
                                        rating: '',
                                        category_id: '',
                                        tmdb: item.tmdbId || 0,
                                        episodes: xtreamInfo.episodes,
                                        xtreamInfo: xtreamInfo.info,
                                    };
                                    actions.setCurrentSeries(seriesInfo);
                                }
                            }
                        } catch (e) {
                            devLog('data', '[continueItems] Background series info load failed:', e);
                        }
                    })();
                } else {
                    // Fallback: navigation classique vers la page détail
                    if (item.type === 'series' && item.seriesId) {
                        actions.navigateById('series', item.seriesId, tmdbId || undefined);
                    } else if (item.type === 'series') {
                        devLog('data', '[continueItems] Cannot navigate: series entry without seriesId', item.id);
                    } else {
                        actions.navigateById(item.type, itemId, tmdbId || undefined);
                    }
                }
            },
        };
    });
}
