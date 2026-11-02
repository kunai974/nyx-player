import { toggleWatchlistOrNotify } from '../../services/watchlistActions';
import { watchlistItemKey } from '../../services/watchlistHydration';
import type { CarouselItem } from './CarouselCard';

/**
 * Titre dans Ma liste d'après les clés lues pour tout l'accueil (hooks/useWatchlistKeys.ts, null : pas encore lues) ; sans
 * numéro, l'ancien état de la carte. Seule règle pour la carte TV et le calque de sélection : ils ne divergent jamais.
 */
export function isItemInWatchlist(item: CarouselItem, keys: Set<string> | null): boolean {
    const key = item.mediaType ? watchlistItemKey(item.streamId ?? 0, item.tmdbId ?? 0, item.mediaType) : null;
    return key !== null ? keys?.has(key) === true : item.inWatchlist === true;
}

/**
 * Note portée par la carte elle-même sur TV : le badge « Introuvable » et l'épisode suivant de « Reprendre » restent
 * visibles sur chaque carte ; seule la note ★ passe au calque de la carte sélectionnée.
 */
export function overlayStaysOnCard(item: CarouselItem): boolean {
    return !!item.overlayText && (!!item.unavailable || !!item.showPlayButton);
}

/** La carte a-t-elle un bouton Ma liste (numéro TMDB ou de source et type connus, ou ancien rappel) ? */
export function cardHasWatchlist(item: CarouselItem): boolean {
    const hasId = (item.tmdbId !== undefined && item.tmdbId > 0) || (item.streamId !== undefined && item.streamId > 0);
    return (!!item.mediaType && hasId) || !!item.onAddToList;
}

/**
 * Ajoute ou retire la carte de Ma liste. Avec un numéro TMDB ou de source et un type : par le service, nouvel état
 * rendu (null : échec, déjà signalé). Un titre sans numéro TMDB passe aussi par le service, sous son numéro de
 * source : sinon le bouton s'affichait sans rien faire chez un fournisseur qui ne relie pas ses titres à TMDB.
 * Sans numéro : l'ancien rappel de la carte, état inconnu (null).
 */
export async function toggleCardWatchlist(item: CarouselItem): Promise<boolean | null> {
    const tmdbId = item.tmdbId !== undefined && item.tmdbId > 0 ? item.tmdbId : 0;
    const hasStreamId = item.streamId !== undefined && item.streamId > 0;
    if (item.mediaType && (tmdbId > 0 || hasStreamId)) {
        // Avec un numéro TMDB, le numéro de source part tel quel : un titre « Introuvable » de Ma liste garde son
        // numéro provisoire négatif s'il est retiré puis remis avant que sa rangée se recharge.
        return toggleWatchlistOrNotify(item.streamId ?? 0, tmdbId, item.mediaType);
    }
    item.onAddToList?.();
    return null;
}
