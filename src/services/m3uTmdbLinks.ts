/**
 * Fiches TMDB des films et séries d'une liste M3U, trouvées par le titre (une liste M3U ne donne
 * jamais de numéro TMDB, contrairement à Xtream).
 *
 * - Une recherche par titre, une seule fois par entrée : la réponse, « pas trouvé » compris, est
 *   gardée dans `m3u_tmdb_links` (base du catalogue, gardée d'une lecture de la liste à l'autre).
 * - Le lien n'est jamais écrit dans la colonne `tmdb_id` : il est posé dans le catalogue en mémoire
 *   tant que le réglage est allumé (titleTmdbLinkStore.ts), comme pour un fournisseur Xtream, et
 *   retiré dès qu'on le coupe.
 * - Règle « lien sûr ou rien » (utils/tmdbTitleMatch.ts).
 * - Coût : à l'ouverture d'une fiche, une recherche. En arrière-plan, seulement avec une clé TMDB
 *   personnelle, toujours par elle (appel direct à TMDB, même connecté) et plafonné par jour : le
 *   relais de Nyx a un quota commun à tous les comptes. Par le relais, seulement les cartes montrées
 *   par les rangées de l'accueil, en demandes groupées et plafonnées par jour (fin du fichier).
 *   Sans compte ni clé : aucun appel.
 * - Titres de Ma liste introuvables (venus d'un autre fournisseur) : rattachés sans recherche, par leur titre
 *   et leur année, dans watchlistTitleRelink.ts.
 * - Limite connue : un film mis dans Ma liste avant que son lien soit trouvé y reste rangé par son
 *   numéro de la liste ; la fiche, une fois liée, le rangerait par son numéro TMDB.
 * - Réglage pour tout couper (préférence `tmdb_title_search`).
 *
 * Seules les entrées M3U sont concernées : une ligne Xtream sans numéro TMDB reste comme avant.
 */

import tmdb, { getTmdbAccessKind, isTmdbAccountRelay, titleBatchChunks, type TitleBatchAnswer } from './tmdbApi';
import { getPersonalTmdbKey } from './tmdbPersonalKey';
import { getDatabase, getDatabaseFileName, getMeta, setMeta } from './dbCore';
import { isTmdbTitleSearchEnabled } from './preferencesService';
import { applyLinkInMemory, currentCatalogFor, noteFoundPoster } from './titleTmdbLinkStore';
import { cleanTitleForSearch, pickConfidentMatch, yearOf, type TitleCandidate } from '../utils/tmdbTitleMatch';
import { createLogger } from '../utils/logger';

const log = createLogger('M3uTmdbLinks');

export type LinkKind = 'movie' | 'series';

/** « Pas trouvé » redemandé au bout de 30 jours (la fiche a pu être créée sur TMDB entre-temps) */
export const NOT_FOUND_RETRY_MS = 30 * 24 * 3600 * 1000;
/** Recherches en arrière-plan par jour et par appareil, selon le chemin vers TMDB */
export const DAILY_BACKGROUND_LIMIT: Record<'proxy' | 'direct', number> = { proxy: 0, direct: 1000 };
const DAILY_COUNTER_KEY = 'm3u_tmdb_title_search_day';

const TABLE: Record<LinkKind, 'movies' | 'series'> = { movie: 'movies', series: 'series' };

interface EntryRow { name: string; tmdb_id: number | null; data: string | null }
interface LinkRow { name: string; tmdb_id: number; checked_at: number }

export function isM3uData(raw: string | null): { year?: number } | null {
    if (!raw) return null;
    try {
        const data: unknown = JSON.parse(raw);
        if (typeof data !== 'object' || data === null || (data as { source?: unknown }).source !== 'm3u') return null;
        const year = Number((data as { year?: unknown }).year);
        return Number.isInteger(year) ? { year } : {};
    } catch {
        return null;
    }
}

async function search(kind: LinkKind, query: string, directOnly: boolean): Promise<TitleCandidate[]> {
    const options = { directOnly };
    if (kind === 'movie') {
        const response = await tmdb.searchMovie(query, undefined, options);
        return response.results.map((r) => ({ id: r.id, titles: [r.title, r.original_title], year: yearOf(r.release_date), poster: r.poster_path }));
    }
    const response = await tmdb.searchTv(query, undefined, options);
    return response.results.map((r) => ({ id: r.id, titles: [r.name, r.original_name], year: yearOf(r.first_air_date), poster: r.poster_path }));
}

const inFlight = new Map<string, Promise<number>>();
/**
 * Réponses de cette session, au cas où la base refuse de les noter (occupée par une lecture de la
 * liste) : une recherche déjà payée n'est pas refaite à la prochaine ouverture.
 */
const sessionResults = new Map<string, { name: string; tmdbId: number }>();

/**
 * Lien d'une entrée : celui déjà connu, sinon une recherche. `searched` vaut vrai quand une
 * demande est partie chez TMDB (compte du plafond journalier).
 */
/** Recherche d'un titre ; null : pas cherché cette fois (relais saturé), rien n'est noté */
type Searcher = (kind: LinkKind, query: string) => Promise<TitleCandidate[] | null>;

async function resolveLink(
    kind: LinkKind,
    id: number,
    now: number,
    directOnly = false,
    searcher: Searcher = (k, q) => search(k, q, directOnly),
): Promise<{ tmdbId: number; searched: boolean }> {
    const database = await getDatabase();
    const table = TABLE[kind];
    const rows = await database.select<EntryRow[]>(`SELECT name, tmdb_id, data FROM ${table} WHERE id = ?`, [id]);
    const row = rows[0];
    const m3u = row ? isM3uData(row.data) : null;
    if (!row || !m3u) return { tmdbId: 0, searched: false };
    if (row.tmdb_id && row.tmdb_id > 0) return { tmdbId: row.tmdb_id, searched: false };

    const links = await database.select<LinkRow[]>('SELECT name, tmdb_id, checked_at FROM m3u_tmdb_links WHERE kind = ? AND id = ?', [kind, id]);
    const known = links[0];
    if (known && known.name === row.name) {
        if (known.tmdb_id > 0) return { tmdbId: known.tmdb_id, searched: false };
        if (now - known.checked_at < NOT_FOUND_RETRY_MS) return { tmdbId: 0, searched: false };
    }

    const stored = sessionResults.get(`${kind}:${id}`);
    const remembered = stored && stored.name === row.name ? stored : undefined;
    if (remembered && remembered.tmdbId === 0) return { tmdbId: 0, searched: false };

    const query = cleanTitleForSearch(row.name, m3u.year);
    let tmdbId = remembered ? remembered.tmdbId : 0;
    let searched = false;
    if (query && !remembered) {
        const reachable = directOnly ? (await getPersonalTmdbKey()) !== null : (await getTmdbAccessKind()) !== null;
        if (!reachable) return { tmdbId: 0, searched: false };
        // Sans l'année dans la demande : TMDB ne garderait que cette année exacte, et l'écart d'un an
        // (sortie en salle ou en France) comme le titre à nombre final ne seraient plus trouvés
        const results = await searcher(kind, query.query);
        if (results === null) return { tmdbId: 0, searched: false };
        tmdbId = pickConfidentMatch(query, results);
        if (tmdbId > 0) noteFoundPoster(kind, tmdbId, results.find((r) => r.id === tmdbId)?.poster);
        searched = true;
    }
    try {
        // « Pas trouvé » n'écrase jamais un lien noté entre-temps pour le même nom (autre recherche finie avant)
        await database.execute(
            `INSERT INTO m3u_tmdb_links (kind, id, name, tmdb_id, checked_at) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(kind, id) DO UPDATE SET name = excluded.name, tmdb_id = excluded.tmdb_id, checked_at = excluded.checked_at
             WHERE excluded.tmdb_id > 0 OR m3u_tmdb_links.tmdb_id <= 0 OR m3u_tmdb_links.name <> excluded.name`,
            [kind, id, row.name, tmdbId, now],
        );
        sessionResults.delete(`${kind}:${id}`);
    } catch (e) {
        if (!searched && !remembered) throw e;
        sessionResults.set(`${kind}:${id}`, { name: row.name, tmdbId });
        log.warn('Lien TMDB gardé pour cette session seulement :', e);
        return { tmdbId, searched };
    }
    return { tmdbId, searched };
}

/**
 * Numéro TMDB d'un film ou d'une série M3U, cherché par son titre si besoin (ouverture d'une fiche).
 * 0 : entrée Xtream, réglage coupé, aucun accès à TMDB, pas de lien sûr, ou erreur (jamais levée).
 */
export async function findM3uTmdbId(kind: LinkKind, id: number): Promise<number> {
    if (!Number.isSafeInteger(id) || id <= 0 || !isTmdbTitleSearchEnabled()) return 0;
    const key = `${kind}:${id}`;
    const running = inFlight.get(key);
    if (running) return running;
    const task = resolveLink(kind, id, Date.now())
        .then((r) => r.tmdbId)
        .catch((e: unknown) => {
            log.warn('Recherche TMDB par le titre impossible :', e);
            return 0;
        })
        .finally(() => inFlight.delete(key));
    inFlight.set(key, task);
    return task;
}

function today(now: number): string {
    return new Date(now).toISOString().slice(0, 10);
}

async function readDailyCount(now: number, counterKey = DAILY_COUNTER_KEY): Promise<number> {
    try {
        const parsed: unknown = JSON.parse((await getMeta(counterKey)) ?? 'null');
        const entry = parsed as { day?: unknown; count?: unknown } | null;
        return entry && entry.day === today(now) && typeof entry.count === 'number' ? entry.count : 0;
    } catch {
        return 0;
    }
}

/**
 * Recherche par petits morceaux des entrées M3U encore sans fiche, après une lecture de la liste.
 * Seulement avec une clé TMDB personnelle, et pas plus que le plafond du jour. S'arrête dès que
 * `isStillCurrent` devient faux (compte changé, déconnexion).
 */
export async function linkM3uTitlesInBackground(
    isStillCurrent: () => boolean = () => true,
    now: () => number = Date.now,
): Promise<{ searched: number; linked: number }> {
    const done = { searched: 0, linked: 0 };
    if (!isTmdbTitleSearchEnabled()) return done;
    // Seulement avec une clé personnelle, et toujours par elle (jamais le relais, même connecté)
    const access = (await getPersonalTmdbKey()) ? 'direct' : null;
    if (!access) return done;
    let used = await readDailyCount(now());
    const limit = DAILY_BACKGROUND_LIMIT[access];
    if (used >= limit) return done;

    const database = await getDatabase();
    const pending = await database.select<{ kind: LinkKind; id: number }[]>(
        `SELECT 'movie' AS kind, m.id AS id FROM movies m
           LEFT JOIN m3u_tmdb_links l ON l.kind = 'movie' AND l.id = m.id
          WHERE m.tmdb_id IS NULL AND json_extract(m.data, '$.source') = 'm3u'
            AND (l.id IS NULL OR l.name <> m.name OR (l.tmdb_id = 0 AND l.checked_at < ?))
         UNION ALL
         SELECT 'series' AS kind, s.id AS id FROM series s
           LEFT JOIN m3u_tmdb_links l ON l.kind = 'series' AND l.id = s.id
          WHERE s.tmdb_id IS NULL AND json_extract(s.data, '$.source') = 'm3u'
            AND (l.id IS NULL OR l.name <> s.name OR (l.tmdb_id = 0 AND l.checked_at < ?))
         LIMIT ?`,
        [now() - NOT_FOUND_RETRY_MS, now() - NOT_FOUND_RETRY_MS, limit - used],
    );

    for (const entry of pending) {
        if (!isStillCurrent() || !isTmdbTitleSearchEnabled() || used >= limit) break;
        try {
            const result = await resolveLink(entry.kind, entry.id, now(), true);
            if (result.searched) {
                used += 1;
                done.searched += 1;
                await setMeta(DAILY_COUNTER_KEY, JSON.stringify({ day: today(now()), count: used }));
            }
            if (result.tmdbId > 0) done.linked += 1;
        } catch (e) {
            // Réseau coupé ou TMDB indisponible : on reprendra à la prochaine lecture de la liste
            log.warn('Recherche TMDB par le titre interrompue :', e);
            break;
        }
    }
    return done;
}

// =============================================================================
// CARTES DE L'ACCUEIL : RECHERCHE GROUPÉE PAR LE RELAIS
// =============================================================================

/** Titres cherchés par jour et par appareil pour les cartes de l'accueil (titres, pas appels) */
export const DAILY_HOME_LIMIT = 100;
const HOME_COUNTER_KEY = 'm3u_tmdb_home_search_day';
/** Titres déjà demandés pendant cette session : une rangée revue ne relance rien */
const homeAsked = new Set<string>();
/** Attente maximale des lectures de la base avant l'envoi : ce qui attend part, les retardataires attendront la prochaine fois */
export const HOME_GATHER_TIMEOUT_MS = 5000;
/** Une recherche de l'accueil à la fois : le compteur du jour est lu puis écrit sans se faire doubler */
let homeChain: Promise<unknown> = Promise.resolve();

/** Oublie les titres demandés pendant la session (tests) */
export function forgetHomeTitleSearches(): void {
    homeAsked.clear();
}

function candidatesOf(answer: TitleBatchAnswer | undefined): TitleCandidate[] | null {
    if (!answer || answer.status !== 'ok' || !Array.isArray(answer.results)) return null;
    return answer.results.map((r) => answer.kind === 'movie'
        ? { id: r.id, titles: [r.title ?? '', r.original_title ?? ''], year: yearOf(r.release_date), poster: r.poster_path }
        : { id: r.id, titles: [r.name ?? '', r.original_name ?? ''], year: yearOf(r.first_air_date), poster: r.poster_path });
}

/**
 * Fiches des titres M3U montrés sur l'accueil (premières cartes des rangées), cherchées par le relais en
 * demandes groupées de `TITLE_BATCH_MAX` titres : 40 cartes = 2 appels, au lieu de 40. Chaque titre n'est
 * cherché qu'une fois : la réponse, « pas trouvé » compris, est notée comme à l'ouverture d'une fiche.
 * Seulement par le relais d'un compte connecté : avec une clé personnelle, la recherche en arrière-plan s'en
 * charge déjà ; un invité (quota de 300 demandes par jour) et sans accès à TMDB, rien. Ses tâches ne sont pas
 * partagées avec l'ouverture d'une fiche, qui fait sa propre recherche si besoin. Plafond de `DAILY_HOME_LIMIT` titres par jour. Les liens trouvés sont posés dans le
 * catalogue affiché (affiche comprise) ; rend les numéros trouvés, par « sorte:numéro ». Ne lève jamais.
 */
export function searchShownM3uTitles(
    entries: ReadonlyArray<{ kind: LinkKind; id: number }>,
    now: () => number = Date.now,
): Promise<Map<string, number>> {
    const run = homeChain.then(() => searchShownNow(entries, now));
    homeChain = run.catch(() => undefined);
    return run;
}

async function searchShownNow(
    entries: ReadonlyArray<{ kind: LinkKind; id: number }>,
    now: () => number,
): Promise<Map<string, number>> {
    const found = new Map<string, number>();
    try {
        if (!isTmdbTitleSearchEnabled()) return found;
        const fresh = entries.filter(({ kind, id }) => {
            const key = `${kind}:${id}`;
            if (!Number.isSafeInteger(id) || id <= 0 || homeAsked.has(key) || inFlight.has(key)) return false;
            homeAsked.add(key);
            return true;
        });
        if (fresh.length === 0 || !(await isTmdbAccountRelay())) return found;
        const used = await readDailyCount(now(), HOME_COUNTER_KEY);
        let budget = DAILY_HOME_LIMIT - used;
        if (budget <= 0) return found;

        // Chaque titre passe par la même lecture qu'à l'ouverture d'une fiche ; ceux qui doivent être
        // cherchés attendent ici, puis partent ensemble
        const waiting: Array<{ kind: LinkKind; query: string; resolve: (r: TitleCandidate[] | null) => void }> = [];
        let unsettled = fresh.length;
        let sent = 0;
        let closed = false;
        let release!: () => void;
        const allWaiting = new Promise<void>((r) => { release = r; });
        const settle = () => {
            unsettled--;
            if (unsettled === 0) release();
        };
        const searcher = (kind: LinkKind, query: string) => new Promise<TitleCandidate[] | null>((resolve) => {
            if (budget <= 0 || closed) {
                resolve(null);
            } else {
                budget--;
                waiting.push({ kind, query, resolve });
            }
            settle();
        });

        const tasks = fresh.map(({ kind, id }) => {
            let asked = false;
            const task = resolveLink(kind, id, now(), false, (k, q) => {
                asked = true;
                return searcher(k, q);
            })
                .then((r) => r.tmdbId)
                .catch((e: unknown) => {
                    log.warn('Recherche TMDB par le titre impossible :', e);
                    return 0;
                })
                .finally(() => {
                    if (!asked) settle();
                });
            return task.then((tmdbId) => {
                if (tmdbId <= 0) return;
                found.set(`${kind}:${id}`, tmdbId);
                try {
                    const indexes = currentCatalogFor(getDatabaseFileName());
                    if (indexes) applyLinkInMemory(indexes, kind, id, tmdbId);
                } catch (e) {
                    log.warn('Lien TMDB non posé dans le catalogue affiché :', e);
                }
            });
        });

        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([allWaiting, new Promise<void>((r) => { timer = setTimeout(r, HOME_GATHER_TIMEOUT_MS); })]);
        clearTimeout(timer);
        closed = true;
        for (const chunk of titleBatchChunks(waiting)) {
            let answers: TitleBatchAnswer[] = [];
            try {
                answers = await tmdb.searchTitlesBatch(chunk.map((w) => ({ kind: w.kind === 'movie' ? 'movie' : 'tv', query: w.query })));
                sent += chunk.length;
            } catch (e) {
                log.warn('Recherche groupée TMDB impossible :', e);
            }
            const byKey = new Map(answers.map((a) => [`${a.kind}:${a.query}`, a]));
            for (const w of chunk) w.resolve(candidatesOf(byKey.get(`${w.kind === 'movie' ? 'movie' : 'tv'}:${w.query}`)));
        }
        if (sent > 0) {
            await setMeta(HOME_COUNTER_KEY, JSON.stringify({ day: today(now()), count: used + sent }))
                .catch((e: unknown) => log.warn('Compteur des recherches de l\'accueil non noté :', e));
        }
        // Une lecture restée bloquée ne retient pas la suite : ce qui est trouvé est déjà posé
        await Promise.race([Promise.all(tasks), new Promise((r) => setTimeout(r, HOME_GATHER_TIMEOUT_MS))]);
    } catch (e) {
        log.warn('Recherche des cartes de l\'accueil interrompue :', e);
    }
    return found;
}

/** Attente avant l'envoi : les rangées affichées ensemble partent dans les mêmes demandes groupées */
export const HOME_SEARCH_GATHER_MS = 400;
let gathered: Array<{ kind: LinkKind; id: number }> = [];
let gatherTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Cartes montrées par une rangée de l'accueil : notées, puis cherchées ensemble un court instant plus
 * tard (`searchShownM3uTitles`). Les titres déjà liés ne sont pas à donner.
 */
export function requestShownM3uTitles(entries: ReadonlyArray<{ kind: LinkKind; id: number }>): void {
    if (entries.length === 0 || !isTmdbTitleSearchEnabled()) return;
    gathered.push(...entries);
    if (gatherTimer) return;
    gatherTimer = setTimeout(() => {
        gatherTimer = null;
        const batch = gathered;
        gathered = [];
        void searchShownM3uTitles(batch);
    }, HOME_SEARCH_GATHER_MS);
}
