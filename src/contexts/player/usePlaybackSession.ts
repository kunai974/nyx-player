/**
 * Cœur du lecteur : lecture, arrêt, zap, relance et message d'erreur, avec l'état qu'ils partagent
 * (item en cours, fondu, série, erreur, compteur de relances) et le numéro de la dernière demande.
 * Sorti de PlayerContext sans changement : ces actions s'appellent entre elles et
 * partagent leurs références, elles restent donc ensemble.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import type { AppSeriesInfo } from '../../types/xtream';
import { XtreamApiService } from '../../services/xtreamApi';
import { StorageService } from '../../services/storage';
import { mpvPlay, mpvStop, mpvSwitchChannel } from '../../services/mpvBridge';
import { devLog } from '../../utils/devLog';
import { sanitizeIptvUrl } from '../../utils/sanitizeUrl';
import { enterPlayerMode, exitPlayerMode, purgeInPlayerMode } from '../../services/memoryService';
import { isAndroid } from '../../utils/platform';
import { setFullscreen as setAndroidFullscreen } from '../../services/player/androidPlayer';
import {
    subscribePlaybackErrors,
    RETRY_MIN_INTERVAL_MS,
    type PlaybackError,
} from '../../services/player/playbackErrors';
import type { PlayableItem, DirectPlayableItem, PlayOptions } from '../../types/player';
import { buildStreamUrl, recordPlaybackStart, resolveStartPosition } from './streamRequest';
import { resolveM3uPlayback } from '../../services/m3uCatalog';
import { useDeferredPurge } from './useDeferredPurge';
import type { LastPlayRequest, PlayerActions, PlayerState } from './types';
import { createLogger } from '../../utils/logger';

const log = createLogger('PlayerContext');

type PlaybackSession =
    Omit<PlayerState, 'mpvConnected'>
    & Omit<PlayerActions, 'playNextEpisode' | 'playPreviousEpisode'>;

export function usePlaybackSession(): PlaybackSession {
    // État
    const [currentlyPlaying, setCurrentlyPlaying] = useState<PlayableItem | null>(null);
    const [isTransitioningToPlayer, setIsTransitioningToPlayer] = useState(false);
    const [currentSeries, setCurrentSeries] = useState<AppSeriesInfo | null>(null);
    const [playbackError, setPlaybackError] = useState<PlaybackError | null>(null);
    const lastPlayRequestRef = useRef<LastPlayRequest | null>(null);
    // Compteur de relances : ici et pas dans l'écran d'erreur, démonté pendant chaque relance
    const [retryAttempt, setRetryAttempt] = useState(0);
    const retryingRef = useRef(false);
    const lastRetryAtRef = useRef(0);

    // Erreurs remontées par les moteurs de lecture (ignorées si plus rien n'est demandé)
    useEffect(() => subscribePlaybackErrors((error) => {
        if (!lastPlayRequestRef.current) return;
        devLog('player', `⚠ Playback error: ${error.kind}${error.httpStatus ? ` (HTTP ${error.httpStatus})` : ''}`);
        // Même erreur signalée deux fois (tampon bloqué puis fin du flux) : ne pas relancer le compte à rebours
        setPlaybackError((prev) => (
            prev && prev.kind === error.kind && prev.httpStatus === error.httpStatus ? prev : error
        ));
    }), []);

    /**
     * Numéro de la dernière demande (lecture, zap ou arrêt). Une demande dépassée par une plus récente
     * ne touche plus à l'état après ses attentes : un Retour juste après Lecture ne rouvre plus le
     * lecteur, et en zappant vite l'écran affiche la dernière chaîne demandée.
     */
    const requestIdRef = useRef(0);
    const { schedulePurge, cancelPendingPurge } = useDeferredPurge();

    /**
     * Lancer la lecture d'un item.
     *
     * Orchestrateur : construit l'URL, enregistre le début de lecture,
     * puis lance MPV. Chaque étape est déléguée à une fonction de streamRequest.ts.
     */
    const play = useCallback(async (
        item: PlayableItem | DirectPlayableItem,
        series?: AppSeriesInfo,
        startPosition?: number,
        options?: PlayOptions
    ) => {
        const requestId = ++requestIdRef.current;
        const isCurrent = () => requestIdRef.current === requestId;
        const request: LastPlayRequest = { type: 'play', item, series, startPosition, options };
        lastPlayRequestRef.current = request;
        cancelPendingPurge();
        setPlaybackError(null);
        if (!retryingRef.current) setRetryAttempt(0);

        // Sauvegarder la série si fournie (pour navigation épisodes)
        if (series) {
            setCurrentSeries(series);
        }

        // Transition vers player
        const itemName = 'name' in item ? (item as { name: string }).name : ('title' in item ? (item as { title: string }).title : 'unknown');
        devLog('player', `▶ Play: ${itemName}`);
        setIsTransitioningToPlayer(true);
        await new Promise((resolve) => setTimeout(resolve, 300));
        if (!isCurrent()) return;

        /** Lancement impossible : message à l'écran au lieu d'un retour silencieux */
        const failLaunch = (error: PlaybackError) => {
            if (!isCurrent()) return;
            // Aucune requête n'est partie chez le fournisseur : « Réessayer » reste permis tout de suite
            lastRetryAtRef.current = 0;
            setPlaybackError(error);
            setIsTransitioningToPlayer(false);
        };

        // Entrée d'une liste M3U : son adresse est dans le catalogue, sans identifiants Xtream
        const direct = await resolveM3uPlayback(item, { seriesEpisodes: series?.episodes, seriesId: options?.seriesId ?? series?.series_id });
        if (!isCurrent()) return;
        let result: { url: string; container: string; live: boolean } | null = direct;
        if (!result) {
            // Récupérer les credentials
            const creds = await StorageService.getCredentials();
            if (!isCurrent()) return;
            if (!creds) {
                log.error('No credentials');
                failLaunch({ kind: 'missing_credentials' });
                return;
            }

            // Construire l'URL du stream
            result = buildStreamUrl(item, new XtreamApiService(creds));
        }

        if (!result) {
            log.error('Could not build stream URL');
            failLaunch({ kind: 'invalid_stream' });
            return;
        }

        // Position de reprise lue avant l'enregistrement du début de lecture
        const resumeAt = result.live ? undefined : await resolveStartPosition(item, startPosition);
        if (!isCurrent()) return;

        // Enregistrer le début de lecture dans SQLite (fire-and-forget)
        recordPlaybackStart(item, series, options);

        // Lancer MPV
        try {
            await mpvPlay(result.url, resumeAt, { live: result.live });
            // Arrêt ou autre lecture demandés pendant le chargement : ils ont repris la main sur le moteur
            if (!isCurrent()) return;
            if (isAndroid()) {
                // Paysage + barres système masquées, comme un lecteur vidéo natif
                setAndroidFullscreen(true).catch(e => log.warn('fullscreen failed:', e));
            }
            setCurrentlyPlaying(item as PlayableItem); // Safe: DirectPlayableItem ⊂ PlayableItem at runtime
            void enterPlayerMode(); // WebView2 → Low Memory permanent
            schedulePurge();

            devLog('player', 'Lecture démarrée', { url: direct ? 'liste M3U' : sanitizeIptvUrl(result.url), container: result.container });
        } catch (e) {
            log.error('mpvPlay failed:', e);
            // Sinon l'écran « réessayer » disparaît pendant une relance et laisse une image figée
            if (!isCurrent()) return;
            setPlaybackError({ kind: 'unknown' });
        }

        setIsTransitioningToPlayer(false);
    }, [cancelPendingPurge, schedulePurge]);

    // Arrêter la lecture (avec transition fade)
    const stop = useCallback(async () => {
        devLog('player', '⏹ Stop');
        const requestId = ++requestIdRef.current;
        lastPlayRequestRef.current = null;
        cancelPendingPurge();
        setPlaybackError(null);
        setRetryAttempt(0);

        // Fade to black (overlay covers MPV video)
        setIsTransitioningToPlayer(true);
        await new Promise(resolve => setTimeout(resolve, 300));
        // Une lecture relancée pendant le fondu garde le moteur, son état et son propre fondu
        if (requestIdRef.current !== requestId) return;

        // Stop MPV + release resources
        void exitPlayerMode(); // WebView2 → Normal + purge
        try {
            await mpvStop();
        } catch (e) {
            log.error('mpvStop failed:', e);
        }
        if (requestIdRef.current !== requestId) return;

        // Reset state — UI becomes visible behind overlay
        setCurrentlyPlaying(null);
        setCurrentSeries(null);

        // Overlay fades out, revealing the UI
        setIsTransitioningToPlayer(false);
    }, [cancelPendingPurge]);

    // Zapping live : switch de flux sans transition ni progression
    const switchChannel = useCallback(async (item: PlayableItem) => {
        const requestId = ++requestIdRef.current;
        const isCurrent = () => requestIdRef.current === requestId;
        const request: LastPlayRequest = { type: 'switch', item };
        lastPlayRequestRef.current = request;
        cancelPendingPurge();
        setPlaybackError(null);
        if (!retryingRef.current) setRetryAttempt(0);
        // Chaîne d'une liste M3U : adresse prise dans le catalogue ; sinon identifiants Xtream
        const direct = await resolveM3uPlayback(item);
        const creds = direct ? null : await StorageService.getCredentials();
        if (!isCurrent()) return;
        // Zap pendant le fondu d'un arrêt ou d'une relance : ce zap prend la main, le voile noir doit partir
        setIsTransitioningToPlayer(false);
        if (!direct && !creds) {
            log.error('switchChannel: No credentials');
            lastRetryAtRef.current = 0;
            setPlaybackError({ kind: 'missing_credentials' });
            return;
        }

        const result = direct ?? (creds ? buildStreamUrl(item, new XtreamApiService(creds)) : null);
        if (!result) {
            log.error('switchChannel: Could not build URL');
            lastRetryAtRef.current = 0;
            setPlaybackError({ kind: 'invalid_stream' });
            return;
        }

        try {
            await mpvSwitchChannel(result.url, { live: result.live });
        } catch (e) {
            log.error('mpvSwitchChannel failed:', e);
            if (isCurrent()) setPlaybackError({ kind: 'unknown' });
            return;
        }
        // Un zap plus récent (ou un arrêt) a pris la main : ne pas afficher cette chaîne-ci
        if (!isCurrent()) return;
        setIsTransitioningToPlayer(false);
        setCurrentlyPlaying(item);
        void purgeInPlayerMode(); // Micro-cycle Normal→200ms→Low pour libérer la RAM du flux précédent
        devLog('player', `📺 Switch → ${'name' in item ? (item as { name: string }).name : 'unknown'}`);
    }, [cancelPendingPurge]);

    // Relance du dernier flux (bouton ou reconnexion automatique espacée, cf. playbackErrors.ts)
    const retryPlayback = useCallback(async () => {
        const request = lastPlayRequestRef.current;
        if (!request || retryingRef.current) return;
        // Anti-spam : jamais deux relances à moins de RETRY_MIN_INTERVAL_MS (le fournisseur compte chaque requête)
        const now = Date.now();
        if (now - lastRetryAtRef.current < RETRY_MIN_INTERVAL_MS) return;
        lastRetryAtRef.current = now;

        setRetryAttempt((attempt) => attempt + 1);
        retryingRef.current = true;
        devLog('player', `🔁 Retry ${request.type}`);
        try {
            if (request.type === 'switch') {
                await switchChannel(request.item);
            } else {
                // Pas la position de départ d'origine : après 40 min de film, une relance rouvrirait au point
                // de reprise du lancement. La position enregistrée (sauvegardes de 30 s) est relue à la place.
                await play(request.item, request.series, undefined, request.options);
            }
        } catch (e) {
            // Relance lancée par un minuteur : un rejet ici ne doit ni passer inaperçu ni rester sans écran
            log.error('retry failed:', e);
            // play/switchChannel ont remplacé la demande par une copie : on compare l'item (pas après un arrêt ou un zap)
            if (lastPlayRequestRef.current?.item === request.item) setPlaybackError({ kind: 'unknown' });
            setIsTransitioningToPlayer(false); // play() a pu lever pendant le fondu : il couvrirait le message
        } finally {
            retryingRef.current = false;
        }
    }, [play, switchChannel]);

    const dismissPlaybackError = useCallback(() => setPlaybackError(null), []);

    // Lancement impossible, message fermé : plus rien n'est demandé au lecteur
    const cancelFailedLaunch = useCallback(() => {
        ++requestIdRef.current;
        lastPlayRequestRef.current = null;
        setPlaybackError(null);
        setRetryAttempt(0);
        // Moteur qui aurait chargé le flux malgré l'échec signalé (délai dépassé) : sans effet sinon
        mpvStop().catch((e) => log.warn('mpvStop after failed launch failed:', e));
    }, []);

    const confirmPlaybackRecovered = useCallback(() => {
        devLog('player', '✅ Lecture rétablie, compteur de relances remis à zéro');
        setRetryAttempt(0);
    }, []);

    return {
        currentlyPlaying,
        isTransitioningToPlayer,
        currentSeries,
        playbackError,
        retryAttempt,
        play,
        stop,
        switchChannel,
        setCurrentSeries,
        retryPlayback,
        dismissPlaybackError,
        confirmPlaybackRecovered,
        cancelFailedLaunch,
    };
}
