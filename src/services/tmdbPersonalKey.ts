/**
 * tmdbPersonalKey.ts — Clé TMDB personnelle, pour utiliser l'app sans compte
 *
 * Avec un compte, les fiches TMDB passent par le relais de Nyx (la clé de Nyx reste sur le serveur).
 * Sans compte, la personne peut donner sa propre clé, gratuite sur themoviedb.org : l'app appelle
 * alors TMDB directement avec elle, sans passer par nos serveurs. Sans clé, l'app montre les images
 * et résumés du fournisseur.
 *
 * Deux formes acceptées, celles que TMDB donne dans les réglages de son compte :
 * - la « clé d'API » (32 caractères hexadécimaux), envoyée dans l'adresse (`api_key`) ;
 * - le « jeton d'accès en lecture » (un JWT), envoyé dans l'en-tête `Authorization`.
 *
 * La clé est gardée dans la base de l'espace (table `meta`), jamais synchronisée ni écrite dans
 * les journaux. Elle ne donne accès qu'à la lecture du catalogue public de TMDB.
 */

import { getMeta, setMeta, getDatabaseFileName } from './dbCore';
import { createLogger } from '../utils/logger';

const log = createLogger('TmdbKey');

export const TMDB_DIRECT_BASE_URL = 'https://api.themoviedb.org/3';
const TMDB_DIRECT_HOST = 'api.themoviedb.org';
const ENDPOINT_RE = /^\/[a-z0-9_]+(?:\/[a-z0-9_]+)*$/;

/** Ligne de la table `meta` qui garde la clé (vide = aucune clé) */
export const TMDB_PERSONAL_KEY_META = 'tmdb_personal_key';

export type PersonalTmdbKey =
    | { kind: 'api-key'; value: string }
    | { kind: 'read-token'; value: string };

const API_KEY_RE = /^[a-f0-9]{32}$/i;
const READ_TOKEN_RE = /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/;
/** Un jeton de TMDB fait environ 200 caractères : bien au-delà, ce n'est pas une clé */
const READ_TOKEN_MAX_LENGTH = 2000;

/**
 * Lit une clé telle que la personne l'a collée ou tapée (espaces et retours à la ligne retirés).
 * null si ce n'est ni une clé d'API ni un jeton de lecture de TMDB.
 */
export function parsePersonalTmdbKey(raw: string): PersonalTmdbKey | null {
    const value = raw.replace(/\s+/g, '');
    if (API_KEY_RE.test(value)) return { kind: 'api-key', value: value.toLowerCase() };
    if (value.length <= READ_TOKEN_MAX_LENGTH && READ_TOKEN_RE.test(value)) return { kind: 'read-token', value };
    return null;
}

/** Clé lue pour une base donnée : relue seulement quand la base de l'espace change */
let cached: { database: string; key: PersonalTmdbKey | null } | null = null;
/**
 * Augmenté à chaque enregistrement, retrait ou oubli : une lecture commencée avant ne remet pas en
 * mémoire l'ancienne valeur par-dessus la nouvelle.
 */
let generation = 0;

/** Clé de l'espace ouvert, ou null (aucune clé, aucun espace ou base illisible) */
export async function getPersonalTmdbKey(): Promise<PersonalTmdbKey | null> {
    const database = getDatabaseFileName();
    if (!database) return null;
    if (cached?.database === database) return cached.key;
    const startedAt = generation;
    let key: PersonalTmdbKey | null = null;
    try {
        const stored = await getMeta(TMDB_PERSONAL_KEY_META);
        key = stored ? parsePersonalTmdbKey(stored) : null;
    } catch (err) {
        log.warn('personal key not read:', err instanceof Error ? err.name : 'unknown');
        return null;
    }
    // L'espace a pu changer pendant la lecture : on ne garde pas sa clé pour l'espace suivant
    if (getDatabaseFileName() === database && generation === startedAt) cached = { database, key };
    return key;
}

/**
 * Enregistre la clé dans l'espace ouvert.
 * @throws si ce n'est pas une clé de TMDB, ou si aucun espace n'est ouvert
 */
export async function savePersonalTmdbKey(raw: string): Promise<PersonalTmdbKey> {
    const key = parsePersonalTmdbKey(raw);
    if (!key) throw new Error('[TmdbKey] not a TMDB key');
    const database = getDatabaseFileName();
    if (!database) throw new Error('[TmdbKey] no local space open');
    generation++;
    await setMeta(TMDB_PERSONAL_KEY_META, key.value);
    generation++;
    cached = { database, key };
    return key;
}

/** Retire la clé de l'espace ouvert */
export async function clearPersonalTmdbKey(): Promise<void> {
    const database = getDatabaseFileName();
    if (!database) return;
    generation++;
    await setMeta(TMDB_PERSONAL_KEY_META, '');
    generation++;
    cached = { database, key: null };
}

/** Oublie la clé gardée en mémoire (remise à zéro, tests) */
export function resetPersonalTmdbKeyCache(): void {
    generation++;
    cached = null;
}

/** Adresse et en-têtes d'un appel direct à TMDB avec la clé personnelle */
export function directTmdbRequest(
    endpoint: string,
    params: Record<string, string>,
    key: PersonalTmdbKey,
): { url: string; headers: Record<string, string> } {
    // Chemin fait seulement de lettres, chiffres, « _ » et « / » : un numéro venu du fournisseur ne
    // peut pas mener ailleurs dans l'API, et la clé ne part jamais vers un autre serveur
    if (!ENDPOINT_RE.test(endpoint)) throw new Error('[TmdbKey] invalid TMDB endpoint');
    const url = new URL(`${TMDB_DIRECT_BASE_URL}${endpoint}`);
    if (url.host !== TMDB_DIRECT_HOST) throw new Error('[TmdbKey] invalid TMDB host');
    for (const [name, value] of Object.entries(params)) {
        if (value) url.searchParams.append(name, value);
    }
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (key.kind === 'api-key') url.searchParams.set('api_key', key.value);
    else headers.Authorization = `Bearer ${key.value}`;
    return { url: url.toString(), headers };
}

export type PersonalKeyCheck = 'ok' | 'refused' | 'unreachable';

/**
 * Essaie la clé auprès de TMDB avant de l'enregistrer : `refused` si TMDB la refuse,
 * `unreachable` sans réseau ou si TMDB ne répond pas normalement.
 */
export async function checkPersonalTmdbKey(key: PersonalTmdbKey, fetchImpl: typeof fetch = fetch): Promise<PersonalKeyCheck> {
    const { url, headers } = directTmdbRequest('/configuration', {}, key);
    try {
        const response = await fetchImpl(url, { headers });
        if (response.ok) return 'ok';
        if (response.status === 401 || response.status === 403) return 'refused';
        return 'unreachable';
    } catch {
        return 'unreachable';
    }
}
