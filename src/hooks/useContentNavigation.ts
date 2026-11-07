/**
 * useContentNavigation — Navigation high-level avec résolution de source
 *
 * Extrait depuis NavigationContext.tsx (Phase 3D).
 * Sépare le data-fetching (SQLite + source préférée) de la navigation pure.
 *
 * Ce hook consomme :
 * - useNavigation() pour navigateToMovie / navigateToSeries (low-level)
 * - useSession() pour lightIndexes
 */

import { useCallback } from 'react';
import type { IptvStream, IptvSeries } from '../types/iptv';
import type { XtreamMovie } from '../types/xtream';
import type { ContentIdentifier, ContentType } from '../types/navigation';
import { getPreferredSource } from '../services/contentPreferencesService';
import { getMovieDetail, getSeriesDetail } from '../services/detailFetcher';
import { getAllVersionsByTmdb } from '../utils/lightIndexHelpers';
import { normalizeTmdbId } from '../utils/normalizeTmdb';
import { findTitleTmdbIdWithin } from '../services/titleTmdbLookup';
import { useNavigation } from '../contexts/NavigationContext';
import { useSession } from '../contexts/SessionContext';
import { devLog } from '../utils/devLog';
import type { AppSeriesInfo } from '../types/xtream';
import { createLogger } from '../utils/logger';

const log = createLogger('navigateToContent');

interface UseContentNavigationReturn {
    openMovie: (movie: IptvStream | XtreamMovie, allVersions?: (IptvStream | XtreamMovie)[]) => Promise<void>;
    openSeries: (series: IptvSeries, allVersions?: IptvSeries[]) => Promise<void>;
    navigateToContent: (type: ContentType, identifier: ContentIdentifier) => Promise<void>;
}

/**
 * Dernière ouverture de fiche demandée, toutes cartes confondues : une ouverture qui attend encore la
 * base quand une autre est demandée (deux cartes pressées très vite) abandonne. Sinon la réponse la
 * plus lente gagnait et ouvrait la première carte.
 */
let lastOpenRequest = 0;

/**
 * Attente maximale, à l'ouverture d'une fiche sans numéro TMDB, de la recherche de son numéro (détail
 * chez le fournisseur, puis titre) : trouvé à temps, la fiche s'ouvre complète avec toutes ses
 * versions ; sinon elle s'ouvre avec les données du fournisseur et se complète quand la réponse arrive.
 */
export const TITLE_LOOKUP_WAIT_MS = 1200;

/** Abandonne l'ouverture de fiche encore en attente (retour arrière pendant l'attente) */
export function cancelPendingOpen(): void {
    lastOpenRequest++;
}

/** La fiche chargée est-elle ce titre TMDB ? Une fiche sans numéro TMDB est acceptée (rien à comparer). */
function sameTitle(itemTmdb: IptvStream['tmdb'], tmdbId: number): boolean {
    const loaded = normalizeTmdbId(itemTmdb);
    return loaded <= 0 || loaded === tmdbId;
}

export function useContentNavigation(): UseContentNavigationReturn {
    const { navigateToMovie, navigateToSeries } = useNavigation();
    const { lightIndexes } = useSession();

    /**
     * Ouvrir un film : cherche la source préférée, charge depuis SQLite, navigue.
     * Si allVersions fourni (recherche groupée), utilise directement.
     */
    const openMovie = useCallback(async (
        movie: IptvStream | XtreamMovie,
        allVersions?: (IptvStream | XtreamMovie)[]
    ): Promise<void> => {
        const request = ++lastOpenRequest;
        const streamId = Number(movie.stream_id);
        // Numéro du fournisseur, sinon celui trouvé par le titre (catalogue en mémoire), sinon cherché
        let tmdbId = normalizeTmdbId('tmdb' in movie ? movie.tmdb : 0)
            || (lightIndexes?.movies.get(streamId)?.tmdbId ?? 0);
        if (tmdbId <= 0) {
            tmdbId = await findTitleTmdbIdWithin('movie', streamId, lightIndexes, TITLE_LOOKUP_WAIT_MS);
            if (request !== lastOpenRequest) return;
        }

        // Si allVersions fourni (depuis recherche groupée), utiliser directement
        if (allVersions && allVersions.length > 0) {
            navigateToMovie(tmdbId, allVersions as XtreamMovie[]);
            return;
        }

        // Chercher la source préférée en cache
        let selectedVersion: XtreamMovie | null = null;
        let lightVersionsArray: XtreamMovie[] = [];

        if (lightIndexes && tmdbId > 0) {
            const lightVersions = getAllVersionsByTmdb(lightIndexes, tmdbId, 'movie');
            if (lightVersions.length > 0) {
                const cachedStreamId = await getPreferredSource('movie', tmdbId);
                const targetId = cachedStreamId ?? lightVersions[0].id;
                const loaded = await getMovieDetail(targetId);
                if (loaded) {
                    selectedVersion = loaded as XtreamMovie;
                }

                // Construire toutes les versions légères (pattern série)
                lightVersionsArray = lightVersions.map(lv => ({
                    stream_id: lv.id,
                    name: lv.name,
                    tmdb: tmdbId,
                    container_extension: lv.containerExt || undefined,
                } as unknown as XtreamMovie));
            }
        }

        // Une autre fiche a été demandée pendant la lecture de la base : elle gagne
        if (request !== lastOpenRequest) return;

        const finalMovie = selectedVersion || movie as XtreamMovie;
        if (lightVersionsArray.length > 0) {
            // Remplacer la coquille par la version complète chargée
            const finalVersions = lightVersionsArray.map(v =>
                selectedVersion && Number(v.stream_id) === Number(selectedVersion.stream_id)
                    ? selectedVersion : v
            );
            navigateToMovie(tmdbId, finalVersions);
        } else {
            navigateToMovie(tmdbId, [finalMovie]);
        }
    }, [lightIndexes, navigateToMovie]);

    /**
     * Ouvrir une série : cherche la source préférée, charge depuis SQLite, navigue.
     * Si allVersions fourni (recherche groupée), utilise directement.
     */
    const openSeries = useCallback(async (
        series: IptvSeries,
        allVersions?: IptvSeries[]
    ): Promise<void> => {
        const request = ++lastOpenRequest;
        const seriesId = Number(series.series_id);
        // Numéro du fournisseur, sinon celui trouvé par le titre (catalogue en mémoire), sinon cherché
        let tmdbId = normalizeTmdbId(series.tmdb || 0)
            || (lightIndexes?.series.get(seriesId)?.tmdbId ?? 0);
        if (tmdbId <= 0) {
            tmdbId = await findTitleTmdbIdWithin('series', seriesId, lightIndexes, TITLE_LOOKUP_WAIT_MS);
            if (request !== lastOpenRequest) return;
        }

        // Si allVersions fourni, utiliser directement
        if (allVersions && allVersions.length > 0) {
            navigateToSeries({
                ...series,
                // Versions sans numéro du fournisseur (carte regroupée par le titre) : la fiche reçoit celui trouvé
                ...(tmdbId > 0 && normalizeTmdbId(series.tmdb || 0) <= 0 ? { tmdb: tmdbId } : {}),
                groupedVersions: allVersions,
            } as AppSeriesInfo);
            return;
        }

        // Chercher la source préférée en cache
        let selectedVersion: IptvSeries | null = null;
        let lightVersionsArray: IptvSeries[] = [];

        if (lightIndexes && tmdbId > 0) {
            const lightVersions = getAllVersionsByTmdb(lightIndexes, tmdbId, 'series');
            if (lightVersions.length > 0) {
                const cachedSeriesId = await getPreferredSource('series', tmdbId);
                const targetId = cachedSeriesId ?? lightVersions[0].id;
                const loaded = await getSeriesDetail(targetId);
                if (loaded) {
                    selectedVersion = loaded;
                }

                lightVersionsArray = lightVersions.map(lv => ({
                    series_id: lv.id,
                    name: lv.name,
                    cover: '',
                    tmdb: tmdbId,
                } as unknown as IptvSeries));
            }
        }

        // Une autre fiche a été demandée pendant la lecture de la base : elle gagne
        if (request !== lastOpenRequest) return;

        const loadedSeries = selectedVersion || series;
        // Numéro trouvé par le titre : la fiche le reçoit, la base du fournisseur n'en a pas
        const finalSeries = tmdbId > 0 && normalizeTmdbId(loadedSeries.tmdb || 0) <= 0
            ? { ...loadedSeries, tmdb: tmdbId }
            : loadedSeries;
        navigateToSeries({
            ...finalSeries,
            groupedVersions: lightVersionsArray.length > 0 ? lightVersionsArray : [finalSeries],
        } as AppSeriesInfo);
    }, [lightIndexes, navigateToSeries]);

    /**
     * Navigation unifiée : résout un ContentIdentifier → film ou série.
     *
     * Avec un numéro TMDB, la fiche au numéro de source n'est prise que si elle porte ce numéro TMDB
     * (ou aucun) : après un changement de fournisseur, le numéro d'un titre de Ma liste peut désigner
     * un autre film. Sinon, le titre est cherché dans le catalogue par son numéro TMDB.
     */
    const navigateToContent = useCallback(async (
        type: ContentType,
        identifier: ContentIdentifier
    ): Promise<void> => {
        const tmdbId = normalizeTmdbId(identifier.tmdbId);
        const sourceId = type === 'movie' ? identifier.streamId : identifier.seriesId;
        const load = type === 'movie' ? getMovieDetail : getSeriesDetail;
        const request = ++lastOpenRequest;

        let item: IptvStream | IptvSeries | null = sourceId ? await load(sourceId) : null;
        if (item && tmdbId > 0 && !sameTitle(item.tmdb, tmdbId)) {
            devLog('nav', '[navigateToContent] Numéro de source repris par un autre titre', { type, tmdbId });
            item = null;
        }
        if (!item && tmdbId > 0 && lightIndexes) {
            const versions = type === 'movie'
                ? getAllVersionsByTmdb(lightIndexes, tmdbId, 'movie')
                : getAllVersionsByTmdb(lightIndexes, tmdbId, 'series');
            if (versions.length > 0) item = await load(versions[0].id);
        }

        // Une autre fiche a été demandée pendant la lecture de la base : elle gagne
        if (request !== lastOpenRequest) return;

        if (!item) {
            log.warn('Content not found', { type, tmdbId });
        } else if (type === 'movie') {
            await openMovie(item as IptvStream);
        } else {
            await openSeries(item as IptvSeries);
        }
    }, [lightIndexes, openMovie, openSeries]);

    return { openMovie, openSeries, navigateToContent };
}
