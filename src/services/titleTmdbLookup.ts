/**
 * Numéro TMDB d'un film ou d'une série ouvert depuis un fournisseur qui n'en donne pas.
 *
 * Dans l'ordre, du plus sûr au moins coûteux :
 * 1. le numéro déjà connu (fournisseur, ou lien trouvé par le titre et gardé) ;
 * 2. liste M3U : sa propre recherche, avec l'année de la liste (m3uTmdbLinks.ts) ;
 * 3. film Xtream : le numéro TMDB du détail du film chez le fournisseur (`get_vod_info`), souvent
 *    rempli même quand la liste des films ne le donne pas ;
 * 4. sinon une recherche TMDB par le titre et l'année (lien sûr ou rien, utils/tmdbTitleMatch.ts).
 * La réponse (« pas trouvé » compris, redemandé au bout de 30 jours) est gardée dans
 * `m3u_tmdb_links`, jamais dans la colonne `tmdb_id` d'une ligne Xtream (garde de l'actualisation).
 *
 * Une fois le numéro trouvé, les autres versions du même titre chez le fournisseur (« Dune (2021)
 * 4K », « FR | Dune (2021) »…) reçoivent le même numéro, pour être réunies en sources d'une seule
 * fiche : même titre nettoyé et même année (à un an près), ou sans année seulement quand TMDB n'a
 * qu'un seul titre de ce nom.
 */

import type { LightIndexes } from '../types/lightIndex';
import tmdb, { getTmdbAccessKind } from './tmdbApi';
import { getDatabase, getDatabaseFileName } from './dbCore';
import { isTmdbTitleSearchEnabled } from './preferencesService';
import { findM3uTmdbId } from './m3uTmdbLinks';
import { StorageService } from './storage';
import { XtreamApiService } from './xtreamApi';
import { applyLinkInMemory, currentCatalogFor, noteFoundPoster, type TitleLinkKind } from './titleTmdbLinkStore';
import { normalizeTmdbId } from '../utils/normalizeTmdb';
import { cleanTitleForSearch, pickConfidentMatch, yearOf, type TitleCandidate, type TitleQuery } from '../utils/tmdbTitleMatch';
import { matchListTitle, prepareListTitles } from '../utils/tmdbListTitleMatch';
import type { XtreamVodInfo } from '../types/xtream';
import { createLogger } from '../utils/logger';

type Database = Awaited<ReturnType<typeof getDatabase>>;

const log = createLogger('TitleTmdbLookup');

/** « Pas trouvé » redemandé au bout de 30 jours (même délai que m3uTmdbLinks.ts) */
export const NOT_FOUND_RETRY_MS = 30 * 24 * 3600 * 1000;
/** Autres versions lues au plus pour un titre */
export const SIBLING_LIMIT = 200;

const TABLE: Record<TitleLinkKind, 'movies' | 'series'> = { movie: 'movies', series: 'series' };

interface EntryRow { name: string; tmdb_id: number | null; data: string | null }
interface LinkRow { name: string; tmdb_id: number; checked_at: number }

/** Ce qui a permis le lien, pour réunir les autres versions sans se tromper */
interface Found {
    tmdbId: number;
    /** Titres et année de la fiche TMDB, quand on les connaît */
    titles: string[];
    year?: number;
    /** Vrai si TMDB n'a qu'un seul titre de ce nom (une version sans année peut alors suivre) */
    uniqueTitle: boolean;
}

function isM3u(raw: string | null): boolean {
    if (!raw) return false;
    try {
        const data: unknown = JSON.parse(raw);
        return typeof data === 'object' && data !== null && (data as { source?: unknown }).source === 'm3u';
    } catch {
        return false;
    }
}

function vodYear(info: XtreamVodInfo | null): number | undefined {
    const raw = info?.info?.year ?? info?.info?.releasedate ?? info?.info?.release_date;
    const year = Number(String(raw ?? '').slice(0, 4));
    return Number.isInteger(year) && year >= 1900 && year < 2100 ? year : undefined;
}

/** Numéro TMDB et année du film dans son détail chez le fournisseur (0 si absent) */
async function readProviderMovie(id: number): Promise<{ tmdbId: number; year?: number }> {
    const creds = await StorageService.getCredentials();
    if (!creds || creds.host.startsWith('m3u:')) return { tmdbId: 0 };
    const info = await new XtreamApiService(creds).getVodInfo(id);
    // Réponse vide, page HTML ou JSON abîmé : traité comme une erreur (rien de noté)
    if (!info) throw new Error('détail du film vide ou illisible');
    const tmdbId = normalizeTmdbId(info.info?.tmdb_id ?? info.tmdb_id ?? info.info?.tmdb ?? info.tmdb);
    return { tmdbId, year: vodYear(info) };
}

async function searchByTitle(kind: TitleLinkKind, query: TitleQuery): Promise<Found | null> {
    let results: TitleCandidate[];
    if (kind === 'movie') {
        const response = await tmdb.searchMovie(query.query);
        results = response.results.map((r) => ({ id: r.id, titles: [r.title, r.original_title], year: yearOf(r.release_date), poster: r.poster_path }));
    } else {
        const response = await tmdb.searchTv(query.query);
        results = response.results.map((r) => ({ id: r.id, titles: [r.name, r.original_name], year: yearOf(r.first_air_date), poster: r.poster_path }));
    }
    const tmdbId = pickConfidentMatch(query, results);
    if (tmdbId <= 0) return null;
    const chosen = results.find((r) => r.id === tmdbId)!;
    noteFoundPoster(kind, tmdbId, chosen.poster);
    return {
        tmdbId,
        titles: chosen.titles.filter(Boolean),
        ...(chosen.year !== undefined ? { year: chosen.year } : {}),
        uniqueTitle: query.year === undefined,
    };
}

/** Lignes par écriture : 5 valeurs chacune, sous la limite de 999 de SQLite */
const SAVE_BATCH = 150;

/**
 * Écrit les liens. Un « pas trouvé » n'écrase jamais un lien trouvé entre-temps pour le même nom
 * (une recherche voisine a pu relier cette version pendant la sienne).
 */
async function saveLinks(
    database: Database,
    kind: TitleLinkKind,
    rows: ReadonlyArray<{ id: number; name: string }>,
    tmdbId: number,
    now: number,
): Promise<void> {
    if (rows.length === 0) return;
    for (let i = 0; i < rows.length; i += SAVE_BATCH) {
        const batch = rows.slice(i, i + SAVE_BATCH);
        await database.execute(
            `INSERT INTO m3u_tmdb_links (kind, id, name, tmdb_id, checked_at) VALUES ${batch.map(() => '(?, ?, ?, ?, ?)').join(', ')}
            ON CONFLICT(kind, id) DO UPDATE SET name = excluded.name, tmdb_id = excluded.tmdb_id, checked_at = excluded.checked_at
            WHERE excluded.tmdb_id > 0 OR m3u_tmdb_links.tmdb_id <= 0 OR m3u_tmdb_links.name <> excluded.name`,
            batch.flatMap((row) => [kind, row.id, row.name, tmdbId, now]),
        );
    }
}

/** Petits mots trop courants pour trier la base (« The Man » se cherche par « man ») */
const COMMON_WORDS = new Set(['the', 'les', 'des', 'and', 'une', 'aux', 'der', 'die', 'das', 'los', 'las', 'del']);

/** Mot le plus long du titre, tel qu'écrit dans le nom : sert de premier tri dans la base */
function anchorOf(query: string): string {
    let best = '';
    for (const word of query.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
        if (word.length > best.length || (word.length === best.length && COMMON_WORDS.has(best))) best = word;
    }
    return best;
}

/**
 * Autres versions du même titre, encore sans numéro : même titre nettoyé et même année à un an près
 * (ou sans année si TMDB n'a qu'un titre de ce nom). Renvoie celles qui ont reçu le numéro.
 */
async function linkSiblings(
    kind: TitleLinkKind,
    entryId: number,
    query: TitleQuery,
    found: Found,
    indexes: LightIndexes | null,
    now: number,
    database: Database,
    stillHere: () => boolean,
): Promise<number> {
    const anchor = anchorOf(query.query);
    if (anchor.length < 3) return 0;
    const year = found.year ?? query.year;
    const prepared = prepareListTitles([{ kind, tmdbId: found.tmdbId, titles: [query.query, ...found.titles], ...(year ? { year } : {}) }]);
    const rows = await database.select<{ id: number; name: string }[]>(
        // Une version déjà reliée (par son détail chez le fournisseur ou une autre recherche) garde son lien
        `SELECT id, name FROM ${TABLE[kind]} WHERE (tmdb_id IS NULL OR tmdb_id <= 0) AND id <> ? AND name LIKE ?
            AND id NOT IN (SELECT id FROM m3u_tmdb_links WHERE kind = ? AND tmdb_id > 0) LIMIT ?`,
        [entryId, `%${anchor}%`, kind, SIBLING_LIMIT],
    );
    const linked: { id: number; name: string }[] = [];
    for (const row of rows) {
        const verdict = matchListTitle(kind, row.name, prepared);
        if (!verdict || verdict.tmdbId !== found.tmdbId) continue;
        if (verdict.kind === 'confirm' && !found.uniqueTitle) continue;
        linked.push(row);
    }
    // Source changée pendant la lecture : rien n'est écrit dans la nouvelle base
    if (!stillHere()) return 0;
    await saveLinks(database, kind, linked, found.tmdbId, now);
    if (!stillHere()) return 0;
    if (indexes) for (const row of linked) applyLinkInMemory(indexes, kind, Number(row.id), found.tmdbId);
    return linked.length;
}

/**
 * Réponses de cette session : détail du fournisseur déjà lu (pas redemandé à chaque ouverture), et
 * liens que la base a refusé de noter (occupée par une actualisation du catalogue).
 */
const providerRead = new Map<string, { tmdbId: number; year?: number }>();
const sessionLinks = new Map<string, { name: string; tmdbId: number }>();

/** Oublie les réponses de la session (tests ; les clés portent déjà le nom de la base) */
export function forgetTitleLookupSession(): void {
    providerRead.clear();
    sessionLinks.clear();
}

async function resolve(kind: TitleLinkKind, id: number, given: LightIndexes | null | undefined, now: number): Promise<number> {
    const dbName = getDatabaseFileName();
    // Catalogue en mémoire de la session, même quand l'appelant ne le donne pas (fiche ouverte depuis
    // le lecteur) : les versions sœurs y sont posées aussi
    const indexes = given ?? currentCatalogFor(dbName);
    const known = kind === 'movie' ? indexes?.movies.get(id)?.tmdbId : indexes?.series.get(id)?.tmdbId;
    if (known && known > 0) return known;

    const database = await getDatabase();
    const row = (await database.select<EntryRow[]>(`SELECT name, tmdb_id, data FROM ${TABLE[kind]} WHERE id = ?`, [id]))[0];
    if (!row) return 0;
    if (row.tmdb_id && row.tmdb_id > 0) return row.tmdb_id;

    const key = `${dbName}:${kind}:${id}`;
    const stillHere = () => getDatabaseFileName() === dbName && isTmdbTitleSearchEnabled();
    const query = cleanTitleForSearch(row.name);

    if (isM3u(row.data)) {
        // Sa propre recherche, avec l'année de la liste ; le lien est noté à part, puis posé en mémoire ici
        const tmdbId = await findM3uTmdbId(kind, id);
        if (tmdbId > 0 && stillHere()) {
            if (indexes) applyLinkInMemory(indexes, kind, id, tmdbId);
            if (query) await linkSiblings(kind, id, query, { tmdbId, titles: [], uniqueTitle: false }, indexes, now, database, stillHere);
        }
        return tmdbId;
    }

    const remembered = sessionLinks.get(key);
    if (remembered && remembered.name === row.name) {
        if (indexes) applyLinkInMemory(indexes, kind, id, remembered.tmdbId);
        return remembered.tmdbId;
    }

    const stored = (await database.select<LinkRow[]>('SELECT name, tmdb_id, checked_at FROM m3u_tmdb_links WHERE kind = ? AND id = ?', [kind, id]))[0];
    if (stored && stored.name === row.name) {
        if (stored.tmdb_id > 0) {
            // Lien gardé mais absent du catalogue en mémoire : ses versions sœurs n'y sont peut-être pas
            if (indexes && applyLinkInMemory(indexes, kind, id, stored.tmdb_id) && query) {
                await linkSiblings(kind, id, query, { tmdbId: stored.tmdb_id, titles: [], uniqueTitle: false }, indexes, now, database, stillHere)
                    .catch((e: unknown) => log.warn('Versions sœurs non reliées :', e));
            }
            return stored.tmdb_id;
        }
        if (now - stored.checked_at < NOT_FOUND_RETRY_MS) return 0;
    }

    let found: Found | null = null;
    let year = query?.year;
    // Détail du fournisseur illisible : un « pas trouvé » sans son année n'est pas noté
    let providerUnread = false;
    if (kind === 'movie') {
        // Clé avec le nom : un numéro réutilisé par le fournisseur (#598) ne reprend jamais le détail de l'ancien titre
        const readKey = `${key}:${row.name}`;
        let provider = providerRead.get(readKey);
        if (!provider) {
            provider = await readProviderMovie(id).catch((e: unknown) => {
                log.warn('Détail du film chez le fournisseur illisible :', e);
                providerUnread = true;
                return { tmdbId: 0 };
            });
            if (!providerUnread) providerRead.set(readKey, provider);
        }
        if (provider.tmdbId > 0) {
            found = { tmdbId: provider.tmdbId, titles: [], ...(provider.year ? { year: provider.year } : {}), uniqueTitle: false };
        } else if (year === undefined) {
            year = provider.year;
        }
    }
    if (!found) {
        const titleQuery = query ? cleanTitleForSearch(row.name, year) : null;
        if (!titleQuery || (await getTmdbAccessKind()) === null) return 0;
        found = await searchByTitle(kind, titleQuery);
    }
    if (!stillHere()) return 0;

    const tmdbId = found?.tmdbId ?? 0;
    if (tmdbId > 0 || !providerUnread || year !== undefined) {
        try {
            await saveLinks(database, kind, [{ id, name: row.name }], tmdbId, now);
        } catch (e) {
            if (tmdbId > 0) sessionLinks.set(key, { name: row.name, tmdbId });
            log.warn('Lien TMDB gardé pour cette session seulement :', e);
        }
    }
    if (found) {
        if (indexes) applyLinkInMemory(indexes, kind, id, tmdbId);
        if (query) {
            await linkSiblings(kind, id, query, found, indexes, now, database, stillHere)
                .catch((e: unknown) => log.warn('Versions sœurs non reliées :', e));
        }
    }
    return tmdbId;
}

const inFlight = new Map<string, Promise<number>>();

/**
 * Numéro TMDB d'un film ou d'une série sans numéro du fournisseur (ouverture d'une fiche).
 * 0 : réglage coupé, aucun accès à TMDB, pas de lien sûr, ou erreur (jamais levée). Avec `indexes`,
 * le lien et ceux des autres versions sont aussi posés dans le catalogue en mémoire.
 */
export function findTitleTmdbId(kind: TitleLinkKind, id: number, indexes?: LightIndexes | null): Promise<number> {
    if (!Number.isSafeInteger(id) || id <= 0 || !isTmdbTitleSearchEnabled()) return Promise.resolve(0);
    const key = `${getDatabaseFileName()}:${kind}:${id}`;
    const running = inFlight.get(key);
    if (running) return running;
    const task = resolve(kind, id, indexes, Date.now())
        .catch((e: unknown) => {
            log.warn('Recherche TMDB par le titre impossible :', e);
            return 0;
        })
        .finally(() => inFlight.delete(key));
    inFlight.set(key, task);
    return task;
}

/** Comme `findTitleTmdbId`, sans attendre plus de `ms` (la recherche continue après, en fond) */
export function findTitleTmdbIdWithin(kind: TitleLinkKind, id: number, indexes: LightIndexes | null | undefined, ms: number): Promise<number> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<number>((resolveLate) => { timer = setTimeout(() => resolveLate(0), ms); });
    return Promise.race([findTitleTmdbId(kind, id, indexes), late]).finally(() => clearTimeout(timer));
}
