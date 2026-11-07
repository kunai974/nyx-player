/**
 * Entrées d'une liste M3U rangées dans le catalogue : leur adresse de lecture est dans la colonne
 * `data` (écrite par le chargement natif, `src-tauri/src/m3u_ingest.rs`), au lieu d'être
 * construite à partir d'identifiants Xtream.
 *
 * - chaîne et film : `data` = { source: 'm3u', url, user_agent?, referrer?, year? } ;
 * - série : `data` = { source: 'm3u', episodes: [{ id, title, season, episode_num,
 *   container_extension, data: { source: 'm3u', url, … } }] }, triés par saison et numéro.
 *
 * Une ligne Xtream n'a pas `source: 'm3u'` : elle n'est jamais prise pour une entrée M3U, et sa
 * lecture continue de passer par l'adresse Xtream. Toute erreur de lecture de la base rend `null`
 * (la lecture Xtream habituelle prend le relais).
 */

import { getDatabase } from './dbCore';
import type { XtreamEpisode } from '../types/xtream';
import type { M3uStream } from '../types/player';
import { safeContainerExtension } from '../utils/xtreamCredentials';
import { createLogger } from '../utils/logger';

const log = createLogger('M3uCatalog');

/**
 * Adresse de chaque épisode M3U, rattachée à l'objet épisode lui-même et jamais à un champ : un
 * épisode Xtream vient du JSON du fournisseur, qui ne peut donc pas imposer une autre adresse.
 */
const episodeStreams = new WeakMap<object, M3uStream>();

/** Mêmes protocoles que ceux admis par la garde du lecteur Windows (`mpv_guard.rs`) */
const PLAYABLE_SCHEMES = new Set(['http:', 'https:', 'rtmp:', 'rtmps:', 'rtsp:', 'rtsps:']);
/** Mêmes plafonds que le lecteur de listes (adresse, en-têtes) */
const MAX_URL_LENGTH = 8192;
const MAX_HEADER_LENGTH = 512;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** En-tête gardé seulement s'il est court et sans caractère de contrôle (aucune injection d'en-tête) */
function cleanHeader(value: unknown): string | undefined {
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_HEADER_LENGTH) return undefined;
    // eslint-disable-next-line no-control-regex -- refuse justement les caractères de contrôle
    return /[\u0000-\u001f\u007f]/.test(value) ? undefined : value;
}

/** Adresse de lecture d'une entrée M3U, ou `null` si `data` n'en décrit pas une valide */
export function parseM3uStream(data: unknown): M3uStream | null {
    if (!isRecord(data) || data.source !== 'm3u') return null;
    const url = data.url;
    if (typeof url !== 'string' || url.length === 0 || url.length > MAX_URL_LENGTH) return null;
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return null;
    }
    if (!PLAYABLE_SCHEMES.has(parsed.protocol.toLowerCase()) || !parsed.host) return null;
    const stream: M3uStream = { url };
    const userAgent = cleanHeader(data.user_agent);
    const referrer = cleanHeader(data.referrer);
    if (userAgent) stream.userAgent = userAgent;
    if (referrer) stream.referrer = referrer;
    return stream;
}

function parseJson(raw: unknown): unknown {
    if (typeof raw !== 'string' || raw.length === 0) return null;
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

async function readData(table: 'live' | 'movies' | 'series', id: number): Promise<unknown> {
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    try {
        const database = await getDatabase();
        const rows = await database.select<{ data: string | null }[]>(`SELECT data FROM ${table} WHERE id = ?`, [id]);
        return parseJson(rows[0]?.data);
    } catch (e) {
        log.warn('Catalogue unreadable:', e);
        return null;
    }
}

/** Adresse d'une chaîne ou d'un film venu d'une liste M3U (`null` pour une entrée Xtream) */
export async function getM3uStream(kind: 'live' | 'movie', id: number): Promise<M3uStream | null> {
    return parseM3uStream(await readData(kind === 'live' ? 'live' : 'movies', id));
}

/**
 * Épisodes d'une série venue d'une liste M3U, rangés par saison comme ceux de Xtream
 * (`get_series_info`), ou `null` pour une série Xtream. L'adresse de chaque épisode est retenue à part.
 */
export async function getM3uSeriesEpisodes(seriesId: number): Promise<Record<string, XtreamEpisode[]> | null> {
    const data = await readData('series', seriesId);
    if (!isRecord(data) || data.source !== 'm3u' || !Array.isArray(data.episodes)) return null;
    const seasons: Record<string, XtreamEpisode[]> = {};
    for (const raw of data.episodes) {
        if (!isRecord(raw)) continue;
        const stream = parseM3uStream(raw.data);
        const id = Number(raw.id);
        if (!stream || !Number.isSafeInteger(id) || id <= 0) continue;
        const season = Number.isSafeInteger(Number(raw.season)) && Number(raw.season) >= 0 ? Number(raw.season) : 1;
        const episodeNum = Number.isSafeInteger(Number(raw.episode_num)) && Number(raw.episode_num) >= 0 ? Number(raw.episode_num) : 0;
        const episode: XtreamEpisode = {
            id: String(id),
            episode_num: episodeNum,
            title: typeof raw.title === 'string' ? raw.title : '',
            container_extension: safeContainerExtension(raw.container_extension) ?? '',
            info: { season },
        };
        episodeStreams.set(episode, stream);
        (seasons[String(season)] ??= []).push(episode);
    }
    return Object.keys(seasons).length > 0 ? seasons : null;
}

/** Ce qu'il faut savoir d'un item à lire pour trouver son adresse M3U */
export interface M3uPlayableLike {
    stream_id?: number | string;
    id?: number | string;
    stream_type?: string;
    episode_num?: number;
    container_extension?: string;
}

export interface M3uPlayback {
    url: string;
    container: string;
    live: boolean;
    stream: M3uStream;
}

function containerOf(url: string, fallback: string | undefined, live: boolean): string {
    const fromItem = safeContainerExtension(fallback);
    if (fromItem) return fromItem;
    try {
        const ext = /\.([a-z0-9]{1,8})$/i.exec(new URL(url).pathname)?.[1];
        if (ext) return ext.toLowerCase();
    } catch {
        // adresse déjà validée : sans extension lisible, valeur par défaut
    }
    return live ? 'ts' : 'mp4';
}

function findEpisode(episodes: Record<string, XtreamEpisode[]> | null | undefined, id: string): XtreamEpisode | undefined {
    if (!episodes) return undefined;
    for (const list of Object.values(episodes)) {
        const found = list.find((ep) => String(ep.id) === id);
        if (found) return found;
    }
    return undefined;
}

/**
 * Lecture d'une entrée M3U : son adresse prise dans le catalogue, ou `null` si l'item vient de
 * Xtream (sa lecture construit alors l'adresse Xtream comme avant).
 *
 * Un épisode venu de la page Séries a son adresse retenue ; sinon (carte « Reprendre », série
 * recopiée) elle est cherchée dans les épisodes de la série en cours, puis dans la série rangée en base.
 */
export async function resolveM3uPlayback(
    item: M3uPlayableLike,
    context?: { seriesEpisodes?: Record<string, XtreamEpisode[]>; seriesId?: number },
): Promise<M3uPlayback | null> {
    const own = episodeStreams.get(item);
    if (own) return { url: own.url, container: containerOf(own.url, item.container_extension, false), live: false, stream: own };

    const streamId = Number(item.stream_id);
    const hasStreamId = Number.isSafeInteger(streamId) && streamId > 0;
    const isEpisode = !hasStreamId && item.id !== undefined && item.id !== '';

    if (isEpisode) {
        const id = String(item.id);
        let episode = findEpisode(context?.seriesEpisodes, id);
        if (!(episode && episodeStreams.has(episode)) && context?.seriesId) {
            episode = findEpisode(await getM3uSeriesEpisodes(context.seriesId), id);
        }
        const stream = episode ? episodeStreams.get(episode) : undefined;
        return stream ? { url: stream.url, container: containerOf(stream.url, episode?.container_extension, false), live: false, stream } : null;
    }
    if (!hasStreamId) return null;

    const live = item.stream_type === 'live';
    const stream = await getM3uStream(live ? 'live' : 'movie', streamId);
    return stream ? { url: stream.url, container: containerOf(stream.url, item.container_extension, live), live, stream } : null;
}
