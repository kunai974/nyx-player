/**
 * Fiches TMDB retrouvées par le titre pour les films et séries que le fournisseur donne sans numéro
 * TMDB (beaucoup de fournisseurs Xtream n'en donnent aucun ; une liste M3U jamais).
 *
 * - Les listes TMDB de l'accueil (déjà en cache : aucune demande en plus) sont comparées aux noms
 *   du catalogue sur l'appareil (utils/tmdbListTitleMatch.ts, lien sûr ou rien). Un nom sans année
 *   est confirmé par une recherche TMDB, au plus `DAILY_CONFIRM_LIMIT` par jour et par appareil.
 * - Les liens trouvés sont rangés dans `m3u_tmdb_links` (base du catalogue, gardée aux
 *   actualisations), JAMAIS dans la colonne `tmdb_id` d'une ligne Xtream : l'actualisation du
 *   catalogue compte les numéros TMDB du fournisseur et refuse une liste qui en aurait « perdu »
 *   la moitié (garde de ingestion.rs). Ils sont reposés dans le catalogue en mémoire à chaque
 *   lecture (`applyStoredTitleLinks`, titleTmdbLinkStore.ts), tant que le nom de l'entrée ne
 *   change pas.
 * - Réglage pour tout couper : préférence `tmdb_title_search` (activée par défaut).
 */

import type { LightIndexes } from '../types/lightIndex';
import type { TmdbTrendingResult } from '../types/tmdb';
import tmdb, { getTmdbAccessKind } from './tmdbApi';
import { getDatabase, getDatabaseFileName, getMeta, setMeta } from './dbCore';
import { applyLinkInMemory, noteFoundPoster, type TitleLinkKind } from './titleTmdbLinkStore';
import { findTitleTmdbId } from './titleTmdbLookup';
import { getEnabledGenres, isTmdbTitleSearchEnabled } from './preferencesService';
import { readTmdbList, type DashboardListKey, type TmdbListKind } from './tmdbMatchingService';
import { cleanTitleForSearch, normalizeTitle, pickConfidentMatch, yearOf, type TitleCandidate, type TitleQuery } from '../utils/tmdbTitleMatch';
import {
    matchListTitle,
    prepareListTitles,
    type ListTitle,
    type ListTitleKind,
    type PreparedListTitles,
} from '../utils/tmdbListTitleMatch';
import { computeDashboardRematch } from './dashboardRematch';
import { installDashboardRematch } from './dashboardCache';
import { createLogger } from '../utils/logger';

const log = createLogger('TitleTmdbLinks');

/** Recherches de confirmation par jour et par appareil (noms sans année) */
export const DAILY_CONFIRM_LIMIT = 30;
/** « Pas trouvé » redemandé au bout de 30 jours (même délai que m3uTmdbLinks.ts) */
export const NOT_FOUND_RETRY_MS = 30 * 24 * 3600 * 1000;
/** Noms comparés entre deux pauses rendues à l'affichage (Chromecast) */
export const SCAN_CHUNK = 2000;
const CONFIRM_COUNTER_KEY = 'title_tmdb_confirm_day';
const ID_BATCH = 400;

// =============================================================================
// LISTES DE L'ACCUEIL → TITRES À COMPARER
// =============================================================================

/** Même tri film / série que `matchTmdbList` (tmdbMatchingService.ts) */
export function listItemToTitle(item: TmdbTrendingResult, kind: TmdbListKind): ListTitle | null {
    const raw = item as Partial<{ title: string; original_title: string; name: string; original_name: string;
        release_date: string; first_air_date: string; media_type: string }>;
    let isMovie: boolean;
    if (kind === 'mixed') {
        isMovie = raw.media_type === 'movie' || (!raw.media_type && !!raw.title);
        if (!isMovie && raw.media_type !== 'tv') return null;
    } else {
        isMovie = kind === 'movie';
    }
    const titles = (isMovie ? [raw.title, raw.original_title] : [raw.name, raw.original_name])
        .filter((t): t is string => typeof t === 'string' && t.length > 0);
    if (titles.length === 0 || !item.id) return null;
    const year = yearOf(isMovie ? raw.release_date : raw.first_air_date);
    return { kind: isMovie ? 'movie' : 'series', tmdbId: item.id, titles, ...(year ? { year } : {}) };
}

const BASE_LISTS: ReadonlyArray<[DashboardListKey, TmdbListKind]> = [
    ['trending', 'mixed'], ['now_playing', 'movie'], ['on_the_air', 'series'], ['top_rated', 'movie'], ['popular', 'movie'],
];

/** Titres des listes de l'accueil déjà en cache (aucun appel réseau) */
async function readCachedListTitles(): Promise<ListTitle[]> {
    const keys: Array<[DashboardListKey, TmdbListKind]> = [
        ...BASE_LISTS,
        ...getEnabledGenres().map((g): [DashboardListKey, TmdbListKind] => [`genre_${g}`, 'movie']),
    ];
    const lists = await Promise.all(keys.map(([key]) => readTmdbList(key, false).catch(() => null)));
    const titles: ListTitle[] = [];
    lists.forEach((list, i) => {
        for (const item of list ?? []) {
            const title = listItemToTitle(item, keys[i][1]);
            if (title) titles.push(title);
        }
    });
    return titles;
}

// =============================================================================
// COMPARAISON PAR PETITS MORCEAUX
// =============================================================================

interface Candidate { kind: ListTitleKind; id: number; name: string; tmdbId: number; query?: TitleQuery }

const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Noms du catalogue sans numéro TMDB comparés aux listes, avec une pause tous les `SCAN_CHUNK` */
export async function scanCatalog(
    indexes: Pick<LightIndexes, 'movies' | 'series'>,
    prepared: PreparedListTitles,
    isStillCurrent: () => boolean,
): Promise<{ sure: Candidate[]; confirm: Candidate[] } | null> {
    const sure: Candidate[] = [];
    const confirm: Candidate[] = [];
    let seen = 0;
    const sources: Array<[ListTitleKind, Iterable<{ id: number; name: string; tmdbId: number }>]> = [
        ['movie', indexes.movies.values()],
        ['series', indexes.series.values()],
    ];
    for (const [kind, entries] of sources) {
        for (const entry of entries) {
            if (++seen % SCAN_CHUNK === 0) {
                await pause();
                if (!isStillCurrent()) return null;
            }
            if (entry.tmdbId > 0) continue;
            const verdict = matchListTitle(kind, entry.name, prepared);
            if (!verdict) continue;
            const candidate = { kind, id: entry.id, name: entry.name, tmdbId: verdict.tmdbId };
            if (verdict.kind === 'sure') sure.push(candidate);
            else confirm.push({ ...candidate, query: verdict.query });
        }
    }
    return { sure, confirm };
}

// =============================================================================
// ENREGISTREMENT ET CONFIRMATION
// =============================================================================

interface StoredLink { kind: ListTitleKind; id: number; name: string; tmdb_id: number; checked_at: number }

async function readStoredLinks(candidates: readonly Candidate[]): Promise<Map<string, StoredLink>> {
    const database = await getDatabase();
    const stored = new Map<string, StoredLink>();
    for (const kind of ['movie', 'series'] as const) {
        const ids = candidates.filter((c) => c.kind === kind).map((c) => c.id);
        for (let i = 0; i < ids.length; i += ID_BATCH) {
            const batch = ids.slice(i, i + ID_BATCH);
            const rows = await database.select<StoredLink[]>(
                `SELECT kind, id, name, tmdb_id, checked_at FROM m3u_tmdb_links WHERE kind = ? AND id IN (${batch.map(() => '?').join(',')})`,
                [kind, ...batch],
            );
            for (const row of rows) stored.set(`${row.kind}:${row.id}`, row);
        }
    }
    return stored;
}

/** Lignes par écriture : 5 valeurs chacune, sous la limite de 999 de SQLite */
const SAVE_BATCH = 150;

/** Enregistre des liens par paquets (une écriture par paquet, pas une par film) */
async function saveLinks(rows: ReadonlyArray<{ candidate: Candidate; tmdbId: number }>, now: number): Promise<void> {
    const database = await getDatabase();
    for (let i = 0; i < rows.length; i += SAVE_BATCH) {
        const batch = rows.slice(i, i + SAVE_BATCH);
        await database.execute(
            // Un « pas trouvé » n'écrase jamais un lien du même nom posé entre-temps (fiche ouverte pendant la confirmation)
            `INSERT INTO m3u_tmdb_links (kind, id, name, tmdb_id, checked_at) VALUES ${batch.map(() => '(?, ?, ?, ?, ?)').join(', ')}
            ON CONFLICT(kind, id) DO UPDATE SET name = excluded.name, tmdb_id = excluded.tmdb_id, checked_at = excluded.checked_at
            WHERE excluded.tmdb_id > 0 OR m3u_tmdb_links.tmdb_id <= 0 OR m3u_tmdb_links.name <> excluded.name`,
            batch.flatMap(({ candidate, tmdbId }) => [candidate.kind, candidate.id, candidate.name, tmdbId, now]),
        );
    }
}

/**
 * Entrées d'une liste M3U parmi les candidats : elles ont leur propre recherche, avec l'année de la
 * liste (m3uTmdbLinks.ts). Un « pas trouvé » noté ici, sans cette année, la bloquerait 30 jours.
 */
async function readM3uIds(candidates: readonly Candidate[]): Promise<Set<string>> {
    const database = await getDatabase();
    const found = new Set<string>();
    for (const kind of ['movie', 'series'] as const) {
        const table = kind === 'movie' ? 'movies' : 'series';
        const ids = candidates.filter((c) => c.kind === kind).map((c) => c.id);
        for (let i = 0; i < ids.length; i += ID_BATCH) {
            const batch = ids.slice(i, i + ID_BATCH);
            const rows = await database.select<{ id: number }[]>(
                `SELECT id FROM ${table} WHERE id IN (${batch.map(() => '?').join(',')}) AND json_extract(data, '$.source') = 'm3u'`,
                batch,
            );
            for (const row of rows) found.add(`${kind}:${row.id}`);
        }
    }
    return found;
}

function today(now: number): string {
    return new Date(now).toISOString().slice(0, 10);
}

async function readConfirmCount(now: number): Promise<number> {
    try {
        const entry = JSON.parse((await getMeta(CONFIRM_COUNTER_KEY)) ?? 'null') as { day?: unknown; count?: unknown } | null;
        return entry && entry.day === today(now) && typeof entry.count === 'number' ? entry.count : 0;
    } catch {
        return 0;
    }
}

async function confirmBySearch(candidate: Candidate): Promise<number> {
    const query = candidate.query!;
    let results: TitleCandidate[];
    if (candidate.kind === 'movie') {
        const response = await tmdb.searchMovie(query.query);
        results = response.results.map((r) => ({ id: r.id, titles: [r.title, r.original_title], year: yearOf(r.release_date), poster: r.poster_path }));
    } else {
        const response = await tmdb.searchTv(query.query);
        results = response.results.map((r) => ({ id: r.id, titles: [r.name, r.original_name], year: yearOf(r.first_air_date), poster: r.poster_path }));
    }
    // Seul résultat de ce nom chez TMDB, et c'est bien celui de la liste : sinon aucun lien
    if (pickConfidentMatch(query, results) !== candidate.tmdbId) return 0;
    noteFoundPoster(candidate.kind, candidate.tmdbId, results.find((r) => r.id === candidate.tmdbId)?.poster);
    return candidate.tmdbId;
}

// =============================================================================
// POINT D'ENTRÉE
// =============================================================================

/** Dernières listes comparées à chaque catalogue en mémoire : rien n'est refait sans changement */
const lastSignature = new WeakMap<object, string>();
const running = new WeakMap<object, Promise<number>>();

function signatureOf(titles: readonly ListTitle[]): string {
    return [...new Set(titles.map((t) => `${t.kind}${t.tmdbId}`))].sort().join(',');
}

/**
 * Compare les listes TMDB de l'accueil (en cache) au catalogue en mémoire et pose les liens sûrs.
 * Renvoie le nombre de nouveaux liens (0 si rien, réglage coupé, ou erreur : jamais levée).
 */
export function linkHomeListsByTitle(
    indexes: LightIndexes,
    isStillCurrent: () => boolean = () => true,
    now: () => number = Date.now,
): Promise<number> {
    const current = running.get(indexes.movies);
    if (current) return current;
    const task = runLinking(indexes, isStillCurrent, now)
        .catch((e: unknown) => {
            log.warn('Liens TMDB par le titre interrompus :', e);
            return 0;
        })
        .finally(() => running.delete(indexes.movies));
    running.set(indexes.movies, task);
    return task;
}

async function runLinking(indexes: LightIndexes, isStillCurrent: () => boolean, now: () => number): Promise<number> {
    if (!isTmdbTitleSearchEnabled()) return 0;
    const dbName = getDatabaseFileName();
    const stillHere = () => isStillCurrent() && getDatabaseFileName() === dbName && isTmdbTitleSearchEnabled();

    const titles = await readCachedListTitles();
    // Listes pas encore en cache : rien n'est comparé, un nouvel essai pourra le faire
    if (titles.length === 0) return 0;
    settledCatalogs.add(indexes.movies);
    const signature = signatureOf(titles);
    const last = lastSignature.get(indexes.movies);
    if (last === `${signature}|done` || last === `${signature}|${today(now())}`) return 0;

    const scanned = await scanCatalog(indexes, prepareListTitles(titles), stillHere);
    if (!scanned || !stillHere()) return 0;
    const { sure, confirm } = scanned;
    if (sure.length + confirm.length === 0) {
        lastSignature.set(indexes.movies, `${signature}|done`);
        return 0;
    }

    if (!stillHere()) return 0;
    try {
        await saveLinks(sure.map((candidate) => ({ candidate, tmdbId: candidate.tmdbId })), now());
    } catch (e) {
        // Base qui refuse d'écrire : nouvel essai le lendemain, pas à chaque retour sur l'accueil
        lastSignature.set(indexes.movies, `${signature}|${today(now())}`);
        throw e;
    }
    let linked = 0;
    for (const candidate of sure) {
        if (applyLinkInMemory(indexes, candidate.kind, candidate.id, candidate.tmdbId)) linked++;
    }

    // Noms sans année : une recherche chacun, dans la limite du jour, « pas trouvé » gardé 30 jours
    let complete = true;
    if (confirm.length > 0) {
        const outcome = await confirmCandidates(indexes, confirm, stillHere, now);
        linked += outcome.linked;
        complete = outcome.complete;
    }
    // Complet : plus rien à faire pour ces listes. Sinon (limite du jour, TMDB injoignable) : une
    // nouvelle tentative le lendemain, pas à chaque retour sur l'accueil.
    lastSignature.set(indexes.movies, complete ? `${signature}|done` : `${signature}|${today(now())}`);
    log.info(`Liens TMDB par le titre : ${linked} nouveaux (${sure.length} sûrs, ${confirm.length} à confirmer)`);
    return linked;
}

async function confirmCandidates(
    indexes: LightIndexes,
    candidates: readonly Candidate[],
    stillHere: () => boolean,
    now: () => number,
): Promise<{ linked: number; complete: boolean }> {
    if ((await getTmdbAccessKind()) === null) return { linked: 0, complete: false };
    const [stored, m3uIds] = await Promise.all([readStoredLinks(candidates), readM3uIds(candidates)]);
    let used = await readConfirmCount(now());
    let linked = 0;
    for (const candidate of candidates) {
        if (!stillHere()) return { linked, complete: false };
        const key = `${candidate.kind}:${candidate.id}`;
        if (m3uIds.has(key)) continue;
        // Relié entre-temps (fiche ouverte pendant les confirmations) : plus rien à chercher
        const entry = candidate.kind === 'movie' ? indexes.movies.get(candidate.id) : indexes.series.get(candidate.id);
        if (entry && entry.tmdbId > 0) continue;
        const known = stored.get(key);
        if (known && known.name === candidate.name && known.tmdb_id === 0 && now() - known.checked_at < NOT_FOUND_RETRY_MS) continue;
        if (used >= DAILY_CONFIRM_LIMIT) return { linked, complete: false };
        used++;
        await setMeta(CONFIRM_COUNTER_KEY, JSON.stringify({ day: today(now()), count: used }));
        let tmdbId: number;
        try {
            tmdbId = await confirmBySearch(candidate);
        } catch (e) {
            // Réseau coupé, relais en pause : nouvelle tentative le lendemain
            log.warn('Confirmation par le titre interrompue :', e);
            return { linked, complete: false };
        }
        if (!stillHere()) return { linked, complete: false };
        await saveLinks([{ candidate, tmdbId }], now());
        if (applyLinkInMemory(indexes, candidate.kind, candidate.id, tmdbId)) linked++;
    }
    return { linked, complete: true };
}

/**
 * Après le chargement de l'accueil : liens par le titre, puis recalcul discret des rangées (cache
 * TMDB seulement, sans réseau) s'il y en a de nouveaux. Sans attendre ni rien lever.
 */
export async function linkHomeTitlesAndRefresh(
    indexes: LightIndexes,
    isStillCurrent: () => boolean = () => true,
): Promise<number> {
    const linked = await linkHomeListsByTitle(indexes, isStillCurrent);
    if (linked === 0 || !isStillCurrent()) return linked;
    try {
        installDashboardRematch(await computeDashboardRematch(indexes));
    } catch (e) {
        log.warn('Rangées non recalculées après les liens par le titre :', e);
    }
    return linked;
}

/**
 * Catalogue surtout sans numéro TMDB : l'accueil dépend des liens par le titre, qui arrivent un peu après
 * son affichage. Vrai tant que moins de la moitié des films ont un numéro (et que la recherche par le titre est permise).
 */
export function mostlyWithoutTmdb(indexes: Pick<LightIndexes, 'movies'>): boolean {
    if (!isTmdbTitleSearchEnabled() || indexes.movies.size === 0) return false;
    let withTmdb = 0;
    for (const movie of indexes.movies.values()) if (movie.tmdbId > 0) withTmdb++;
    return withTmdb * 2 < indexes.movies.size;
}

/** Titres déjà comparés, par catalogue en mémoire (une fiche rouverte ne reparcourt pas le catalogue) */
const titlesScanned = new WeakMap<object, Set<string>>();

/**
 * Titres TMDB donnés (films similaires d'une fiche) comparés aux noms du catalogue, en local : seuls les
 * liens sûrs (titre exact et année) sont posés, sans aucune recherche réseau. Renvoie le nombre de liens.
 */
export async function linkTitlesByName(
    indexes: LightIndexes,
    titles: readonly ListTitle[],
    isStillCurrent: () => boolean = () => true,
): Promise<number> {
    if (!isTmdbTitleSearchEnabled() || titles.length === 0) return 0;
    const dbName = getDatabaseFileName();
    const stillHere = () => isStillCurrent() && getDatabaseFileName() === dbName && isTmdbTitleSearchEnabled();
    // Mêmes titres déjà comparés à ce catalogue (fiche rouverte) : rien à refaire
    const signature = signatureOf(titles);
    const done = titlesScanned.get(indexes.movies) ?? new Set<string>();
    titlesScanned.set(indexes.movies, done);
    if (done.has(signature)) return 0;
    try {
        // Films seulement : les séries ne sont pas demandées ici, inutile de les parcourir
        const scanned = await scanCatalog({ movies: indexes.movies, series: new Map() }, prepareListTitles([...titles]), stillHere);
        if (!scanned || !stillHere()) return 0;
        done.add(signature);
        if (scanned.sure.length === 0) return 0;
        await saveLinks(scanned.sure.map((candidate) => ({ candidate, tmdbId: candidate.tmdbId })), Date.now());
        let linked = 0;
        for (const candidate of scanned.sure) {
            if (applyLinkInMemory(indexes, candidate.kind, candidate.id, candidate.tmdbId)) linked++;
        }
        return linked;
    } catch (e) {
        log.warn('Liens par le titre (similaires) interrompus :', e);
        return 0;
    }
}

/** Catalogues dont les nouveautés de la semaine ont déjà été cherchées par le titre */
const recentLinked = new WeakSet<object>();
const recentRunning = new WeakMap<object, Promise<number>>();
/** Nouveautés cherchées par catalogue et par type (les rangées « cette semaine » en montrent 20) */
export const RECENT_LINK_LIMIT = 20;
/** Recherches au plus par lancement de l'accueil, avec une pause entre deux */
export const RECENT_SEARCH_PER_LAUNCH = 12;
export const RECENT_SEARCH_PAUSE_MS = 300;

/**
 * Les nouveautés de la semaine d'un catalogue sans numéro TMDB n'ont aucune chance d'être dans les
 * listes de l'accueil : leur numéro est cherché par le titre, comme à l'ouverture de leur fiche (une
 * recherche chacune, mêmes règles sûres). Une fois par catalogue ; renvoie le nombre de liens posés.
 */
export function linkRecentByTitle(indexes: LightIndexes, isStillCurrent: () => boolean = () => true): Promise<number> {
    if (!isTmdbTitleSearchEnabled() || recentLinked.has(indexes.movies)) return Promise.resolve(0);
    // Déjà en cours (écran relancé pendant la boucle) : on attend la même, sans la doubler
    const running = recentRunning.get(indexes.movies);
    if (running) return running;
    const task = runRecentLinking(indexes, isStillCurrent).finally(() => recentRunning.delete(indexes.movies));
    recentRunning.set(indexes.movies, task);
    return task;
}

async function runRecentLinking(indexes: LightIndexes, isStillCurrent: () => boolean): Promise<number> {
    const weekAgo = Math.floor(Date.now() / 1000) - 7 * 24 * 3600;
    // Les plus récentes d'abord, puis un seul représentant par film (nom nettoyé + année) : les versions
    // 4K / FR / EN d'un même film ne coûtent qu'une recherche, ses sœurs sont reliées avec lui
    const distinct = (kind: TitleLinkKind, entries: Iterable<{ id: number; name: string; added?: number; tmdbId: number }>) => {
        const seen = new Set<string>();
        const picked: Candidate[] = [];
        let count = 0;
        const recent = [...entries].filter((e) => (e.added ?? 0) >= weekAgo)
            .sort((a, b) => (b.added ?? 0) - (a.added ?? 0));
        for (const e of recent) {
            const query = cleanTitleForSearch(e.name);
            if (!query) continue;
            const key = `${normalizeTitle(query.query)}|${query.year ?? ''}`;
            if (seen.has(key)) continue;
            seen.add(key);
            // Les 20 plus récents comptent même déjà reliés : la fenêtre ne glisse pas à chaque lancement
            if (e.tmdbId <= 0) picked.push({ kind, id: e.id, name: e.name, tmdbId: 0 });
            if (++count >= RECENT_LINK_LIMIT) break;
        }
        return picked;
    };
    const targets = [...distinct('movie', indexes.movies.values()), ...distinct('series', indexes.series.values())];
    // Déjà décidés (lien trouvé, ou « pas trouvé » de moins de 30 jours) : aucune requête à refaire
    const stored = await readStoredLinks(targets).catch((): Map<string, StoredLink> => new Map());
    const nowMs = Date.now();
    const todo = targets.filter((t) => {
        const known = stored.get(`${t.kind}:${t.id}`);
        return !(known && known.name === t.name && (known.tmdb_id > 0 || nowMs - known.checked_at < NOT_FOUND_RETRY_MS));
    });

    let linked = 0;
    let searched = 0;
    let finished = true;
    try {
        for (const { kind, id } of todo) {
            // Écran quitté en route : un prochain passage reprendra (les liens déjà posés sont gardés)
            if (!isStillCurrent()) { finished = false; break; }
            const entry = kind === 'movie' ? indexes.movies.get(id) : indexes.series.get(id);
            if (!entry || entry.tmdbId > 0) continue; // relié entre-temps avec une version sœur
            // Plafond par lancement : le reste est repris au lancement suivant, jamais de rafale
            if (searched >= RECENT_SEARCH_PER_LAUNCH) { finished = false; break; }
            searched++;
            try {
                if ((await findTitleTmdbId(kind, id, indexes)) > 0) linked++;
            } catch (e) {
                log.warn('Nouveauté non reliée par le titre :', e);
            }
            await new Promise<void>((resolve) => setTimeout(resolve, RECENT_SEARCH_PAUSE_MS));
        }
    } finally {
        if (finished) recentLinked.add(indexes.movies);
    }
    return linked;
}

/** Catalogues dont les listes de l'accueil ont été comparées (ou le sont déjà pour la journée) */
const settledCatalogs = new WeakSet<object>();

/** Les listes TMDB de l'accueil ont déjà été comparées à ce catalogue : un nouvel essai ne ferait rien de plus */
export function titleLinksSettled(indexes: Pick<LightIndexes, 'movies'>): boolean {
    return settledCatalogs.has(indexes.movies);
}
