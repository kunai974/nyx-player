/**
 * localSpace.ts — Espace local : ce qui range les données d'une personne sur l'appareil
 *
 * Chaque espace a sa base (`nyxplayer_<id>.db`) et sa place dans le coffre du système
 * (`iptv_credentials_<id>`). Deux sortes d'espace :
 * - compte : l'identifiant est celui du compte Supabase, et la synchro avec le cloud est permise ;
 * - invité : l'identifiant est créé sur l'appareil, et rien ne part jamais au cloud (aucun compte
 *   n'est noté pour la synchro, `canSync()` reste faux).
 *
 * L'identifiant d'un invité a la même forme qu'un identifiant de compte (UUID en minuscules) : la
 * partie native n'ouvre que des bases et des places du coffre nommées ainsi, et un invité n'a donc
 * besoin d'aucun changement de son côté. Deux UUID tirés au hasard ne se rencontrent pas en pratique.
 */

import { setDatabaseName, resetDatabaseName } from './dbCore';
import { setKeyringUser, resetKeyringUser } from './storage';
import { setCurrentSyncUserId } from './syncService';
import { resetPersonalTmdbKeyCache } from './tmdbPersonalKey';
import { createLogger } from '../utils/logger';

const log = createLogger('LocalSpace');

export type LocalSpaceKind = 'account' | 'guest';

export interface LocalSpace {
    kind: LocalSpaceKind;
    /** UUID en minuscules, forme 8-4-4-4-12 */
    id: string;
}

/** Forme acceptée par la partie native pour les noms de base et du coffre */
const SPACE_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

/** Où l'appareil retient l'identifiant de son espace invité (rien de secret ni de personnel) */
export const GUEST_SPACE_STORAGE_KEY = 'nyx_guest_space_id';

/** Vrai si cet identifiant peut nommer une base et une place du coffre */
export function isValidSpaceId(id: string): boolean {
    return SPACE_ID_PATTERN.test(id);
}

/** Espace d'un compte Supabase : son identifiant est celui du compte, tel quel */
export function accountSpace(uid: string): LocalSpace {
    return { kind: 'account', id: uid };
}

/**
 * Identifiant de l'espace invité de cet appareil, ou null s'il n'y en a pas encore. Une valeur
 * abîmée ou modifiée à la main n'est jamais prise : elle finirait dans un nom de fichier.
 */
export function readGuestSpaceId(): string | null {
    try {
        const stored = localStorage.getItem(GUEST_SPACE_STORAGE_KEY);
        return stored && isValidSpaceId(stored) ? stored : null;
    } catch {
        return null;
    }
}

/**
 * UUID tiré au hasard (version 4), en minuscules. `crypto.randomUUID` manque aux WebView anciennes
 * de certaines box Android TV : on le refait alors avec `crypto.getRandomValues`, disponible partout.
 */
export function newSpaceId(): string {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID().toLowerCase();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Espace invité de cet appareil : le même à chaque lancement, créé la première fois. Si l'appareil
 * ne peut pas retenir l'identifiant, l'espace vaut pour ce lancement seulement.
 */
export function guestSpace(): LocalSpace {
    const known = readGuestSpaceId();
    if (known) return { kind: 'guest', id: known };
    const created = newSpaceId();
    try {
        localStorage.setItem(GUEST_SPACE_STORAGE_KEY, created);
    } catch (err) {
        log.warn('guest space id not saved:', err);
    }
    return { kind: 'guest', id: created };
}

/**
 * Où l'appareil retient que la personne utilise Nyx sans compte (« Continuer sans compte »). Distinct
 * de l'identifiant : se connecter à un compte puis revenir ne doit pas rouvrir l'espace invité de force.
 */
export const GUEST_MODE_STORAGE_KEY = 'nyx_guest_mode';

/** Vrai si la personne a choisi d'utiliser Nyx sans compte sur cet appareil */
export function readGuestMode(): boolean {
    try {
        return localStorage.getItem(GUEST_MODE_STORAGE_KEY) === '1';
    } catch {
        return false;
    }
}

/** Retient (ou oublie) le choix d'utiliser Nyx sans compte */
export function writeGuestMode(active: boolean): void {
    try {
        if (active) localStorage.setItem(GUEST_MODE_STORAGE_KEY, '1');
        else localStorage.removeItem(GUEST_MODE_STORAGE_KEY);
    } catch (err) {
        log.warn('guest mode not saved:', err);
    }
}

/** Oublie l'espace invité de cet appareil (après l'effacement de ses données) */
export function forgetGuestSpaceId(): void {
    try {
        localStorage.removeItem(GUEST_SPACE_STORAGE_KEY);
        localStorage.removeItem(GUEST_MODE_STORAGE_KEY);
    } catch {
        /* rien à oublier si l'appareil ne retient rien */
    }
}

let openSpace: LocalSpace | null = null;

/**
 * Prépare l'espace avant tout accès à la base ou au coffre. Un compte est aussi noté pour la
 * synchro ; un invité ne l'est jamais, ce qui coupe tout envoi au cloud.
 */
export function openLocalSpace(space: LocalSpace): void {
    if (space.kind === 'guest' && !isValidSpaceId(space.id)) {
        throw new Error('[LocalSpace] invalid guest space id');
    }
    openSpace = { ...space };
    setDatabaseName(space.id);
    setKeyringUser(space.id);
    setCurrentSyncUserId(space.kind === 'account' ? space.id : null);
}

/** Referme l'espace : plus de base nommée, coffre et synchro remis à leur état sans personne */
export function closeLocalSpace(): void {
    openSpace = null;
    resetDatabaseName();
    resetPersonalTmdbKeyCache();
    resetKeyringUser();
    setCurrentSyncUserId(null);
}

/** L'espace préparé en ce moment, ou null */
export function getOpenLocalSpace(): LocalSpace | null {
    return openSpace ? { ...openSpace } : null;
}
