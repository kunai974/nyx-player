/**
 * Liens TMDB trouvés par le titre (titleTmdbLinks.ts, m3uTmdbLinks.ts), reposés dans le catalogue
 * en mémoire. Module léger, sans client TMDB : lu à chaque chargement du catalogue.
 */

import type { LightIndexes } from '../types/lightIndex';
import { getDatabase, getDatabaseFileName } from './dbCore';
import { isTmdbTitleSearchEnabled } from './preferencesService';
import { cleanTitleForSearch, normalizeTitle } from '../utils/tmdbTitleMatch';
import { markStaleTitleLink } from '../utils/lightIndexHelpers';
import { PREFERENCES_EVENT, WATCHLIST_EVENT } from './eventConstants';
import { createLogger } from '../utils/logger';

const log = createLogger('TitleTmdbLinks');

export type TitleLinkKind = 'movie' | 'series';

/**
 * Catalogue en mémoire de la session, et la base dont il vient. Référence faible : un catalogue
 * remplacé ou abandonné (déconnexion) n'est pas gardé en mémoire pour autant (Chromecast).
 */
interface WeakHandle<T> { deref(): T | undefined }
const WeakRefCtor = (globalThis as { WeakRef?: new <T extends object>(value: T) => WeakHandle<T> }).WeakRef;
const weakly = <T extends object>(value: T): WeakHandle<T> => (WeakRefCtor ? new WeakRefCtor(value) : { deref: () => value });

let current: { dbName: string | null; indexes: WeakHandle<LightIndexes> } | null = null;

/** Retient le catalogue chargé (catalogLight.ts) pour les recherches lancées sans lui */
export function rememberCurrentCatalog(indexes: LightIndexes): void {
    current = { dbName: getDatabaseFileName(), indexes: weakly(indexes) };
    watchTitleSearchSetting();
}

/** Catalogue retenu, s'il vient bien de cette base (sinon null : autre compte) */
export function currentCatalogFor(dbName: string | null): LightIndexes | null {
    return current && current.dbName === dbName ? current.indexes.deref() ?? null : null;
}

export type LinkTable = Pick<LightIndexes, 'movies' | 'series' | 'moviesByTmdb' | 'seriesByTmdb'> & Partial<Pick<LightIndexes, 'iconPrefixes'>>;

// =============================================================================
// LIENS GARDÉS → CATALOGUE EN MÉMOIRE
// =============================================================================

/** Numéros posés par le titre dans chaque table `moviesByTmdb` / `seriesByTmdb` */
const titleLinkedCount = new WeakMap<object, number>();

/** Titres (entrées du catalogue) reliés par le titre, par table `movies` / `series` */
const titleLinkedEntries = new WeakMap<object, number>();

/** Numéro de chaque titre relié par le titre avant son lien, par table `movies` / `series` : de quoi le retirer */
const titleLinkedBefore = new WeakMap<object, Map<number, number>>();

function noteLinkedEntry(table: object, id: number, before: number): void {
    let ids = titleLinkedBefore.get(table);
    if (!ids) {
        ids = new Map();
        titleLinkedBefore.set(table, ids);
    }
    if (!ids.has(id)) ids.set(id, before);
    titleLinkedEntries.set(table, (titleLinkedEntries.get(table) ?? 0) + 1);
}

/** Nombre de films et de séries du catalogue dont le numéro TMDB vient du titre et non du fournisseur */
export function titleLinkedEntryCounts(indexes: Pick<LightIndexes, 'movies' | 'series'>): { movies: number; series: number } {
    return { movies: titleLinkedEntries.get(indexes.movies) ?? 0, series: titleLinkedEntries.get(indexes.series) ?? 0 };
}

function noteTitleLink(byTmdb: object): void {
    titleLinkedCount.set(byTmdb, (titleLinkedCount.get(byTmdb) ?? 0) + 1);
}

/**
 * Numéros TMDB donnés par le fournisseur lui-même, sans ceux trouvés par le titre. Un catalogue
 * sans aucun numéro du fournisseur garde tous ses titres dans les onglets Films et Séries
 * (categoryRows.ts) : quelques liens trouvés par le titre ne doivent pas en cacher le reste.
 */
export function providerTmdbCount(byTmdb: Map<number, unknown>): number {
    return byTmdb.size - (titleLinkedCount.get(byTmdb) ?? 0);
}

/** Pays ou version entre parenthèses (« (UK) », « (US) ») : deux séries homonymes se distinguent par là */
const countryTags = (name: string): string => [...name.matchAll(/\(([A-Z]{2})\)/g)].map((m) => m[1]).join(',');

/**
 * Même titre à un nom près de préfixes et d'étiquettes de qualité (« Dune (2021) » = « FR | Dune (2021) 4K »).
 * Prudent : l'année doit être la même des DEUX côtés (ou absente des deux : « Dune » n'est pas « Dune (1984) »),
 * un nombre final qui fait partie du titre (« Blade Runner 2049 ») compte, et « (UK) » n'est pas « (US) ».
 */
function sameCleanedName(a: string, b: string): boolean {
    const x = cleanTitleForSearch(a);
    const y = cleanTitleForSearch(b);
    if (!x || !y || x.year !== y.year || countryTags(a) !== countryTags(b)) return false;
    return normalizeTitle(x.withYear ?? x.query) === normalizeTitle(y.withYear ?? y.query);
}

/**
 * Clé commune aux versions d'un même titre quand le nom donne une année (« Dune (2021) » = « FR | Dune (2021) 4K »),
 * même prudence que ci-dessus. Null sans année : « Dune » seul pourrait être n'importe quel film du nom.
 */
export function sameTitleVersionKey(name: string): string | null {
    // Un marqueur de saison (« S01 », « Saison 2 ») : chaque saison reste sa propre carte
    if (/\bS\d{1,3}(E\d+)?\b|\b(saison|season|staffel|temporada)\s*\d/i.test(name)) return null;
    const cleaned = cleanTitleForSearch(name);
    if (!cleaned?.year) return null;
    return `${normalizeTitle(cleaned.withYear ?? cleaned.query)}|${cleaned.year}|${countryTags(name)}`;
}

let linksEventQueued = false;

/**
 * Un lien vient d'être posé : Ma liste (boutons « dans Ma liste », cartes) se relit, un seul signal pour
 * tout un lot de liens. Un titre ajouté à Ma liste avant son lien se reconnaît alors aussi à son numéro TMDB.
 */
function announceLinks(): void {
    if (linksEventQueued || typeof window === 'undefined') return;
    linksEventQueued = true;
    setTimeout(() => {
        linksEventQueued = false;
        window.dispatchEvent(new CustomEvent(WATCHLIST_EVENT));
    }, 0);
}

// =============================================================================
// AFFICHES TMDB DES TITRES SANS IMAGE
// =============================================================================

/** Début des adresses d'affiche TMDB posées sur les cartes (même taille que celles des fournisseurs, getIconUrl) */
export const TMDB_POSTER_PREFIX = 'https://image.tmdb.org/t/p/w342';
/** Chemin d'affiche TMDB accepté : « /abc123.jpg », rien d'autre (jamais une adresse) */
const POSTER_PATH = /^\/[A-Za-z0-9_-]{1,64}\.(?:jpg|jpeg|png|webp)$/;

/** Affiches connues (recherche par le titre ou fiche déjà ouverte), par « sorte:numéro TMDB » */
const knownPosters = new Map<string, string>();
const posterKey = (kind: TitleLinkKind, tmdbId: number): string => `${kind}:${tmdbId}`;

/** Titres qui ont reçu une affiche TMDB, par table `movies` / `series`, avec leur image d'avant : de quoi la rendre */
const posteredEntries = new WeakMap<object, Map<number, { prefixId: number; suffix: string }>>();
/** Titres dont l'image est une affiche TMDB posée ici (le classement des rangées n'en tient pas compte) */
const givenPosters = new WeakSet<object>();

/** Vrai si l'image du titre est une affiche TMDB posée ici, pas celle du fournisseur */
export function hasGivenPoster(item: object): boolean {
    return givenPosters.has(item);
}

/** Version des affiches d'une catégorie : seules les rangées touchées se refont */
const categoryVersions = new Map<string, number>();
export function categoryPostersVersion(categoryId: string): number {
    return categoryVersions.get(categoryId) ?? 0;
}
const touchCategory = (categoryId: string) => categoryVersions.set(categoryId, (categoryVersions.get(categoryId) ?? 0) + 1);

/** Le catalogue affiché : un catalogue en cours de chargement reçoit ses affiches sans prévenir les rangées */
const isShown = (indexes: LinkTable): boolean => current?.indexes.deref() === indexes;

let postersVersion = 0;
const posterListeners = new Set<() => void>();
let posterSignalQueued = false;

/** Version des affiches posées : change quand des cartes reçoivent une affiche ou la perdent */
export function titlePostersVersion(): number {
    return postersVersion;
}

/** Abonnement aux changements d'affiches (useSyncExternalStore) */
export function subscribeTitlePosters(listener: () => void): () => void {
    posterListeners.add(listener);
    return () => {
        posterListeners.delete(listener);
    };
}

/**
 * Délai entre deux signaux : les rangées se refont une fois par lot d'affiches, pas à chaque titre trouvé
 * (la recherche en fond en trouve un à la fois, et refaire les rangées d'un gros catalogue coûte sur la TV)
 */
export const POSTER_SIGNAL_DELAY_MS = 1500;

/** Un seul signal pour tout un lot d'affiches (les cartes se refont une fois) */
function announcePosters(): void {
    if (posterSignalQueued) return;
    posterSignalQueued = true;
    setTimeout(() => {
        posterSignalQueued = false;
        postersVersion++;
        for (const listener of posterListeners) listener();
    }, POSTER_SIGNAL_DELAY_MS);
}

/**
 * Pose l'affiche TMDB connue sur un titre relié par le titre, seulement s'il n'a pas d'image à lui :
 * celle du fournisseur reste toujours la première. Vrai : affiche posée sur le catalogue affiché, les
 * rangées sont à prévenir.
 */
function givePoster(indexes: LinkTable, kind: TitleLinkKind, id: number): boolean {
    const prefixes = indexes.iconPrefixes;
    const table = kind === 'movie' ? indexes.movies : indexes.series;
    const entry = table.get(id);
    if (!prefixes || !entry || entry.tmdbId <= 0) return false;
    if (entry.iconPrefixId >= 0 && entry.iconSuffix !== '') return false;
    const path = knownPosters.get(posterKey(kind, entry.tmdbId));
    if (!path) return false;
    let prefixId = prefixes.indexOf(TMDB_POSTER_PREFIX);
    if (prefixId < 0) prefixId = prefixes.push(TMDB_POSTER_PREFIX) - 1;
    let ids = posteredEntries.get(table);
    if (!ids) {
        ids = new Map();
        posteredEntries.set(table, ids);
    }
    if (!ids.has(id)) ids.set(id, { prefixId: entry.iconPrefixId, suffix: entry.iconSuffix });
    entry.iconPrefixId = prefixId;
    entry.iconSuffix = path;
    givenPosters.add(entry);
    touchCategory(entry.categoryId);
    return isShown(indexes);
}

/** Retire les affiches TMDB posées (réglage coupé) : les cartes reprennent leur image d'avant */
function removePosters(table: Map<number, { iconPrefixId: number; iconSuffix: string; categoryId: string }>): number {
    const ids = posteredEntries.get(table);
    if (!ids) return 0;
    for (const [id, before] of ids) {
        const entry = table.get(id);
        if (!entry) continue;
        entry.iconPrefixId = before.prefixId;
        entry.iconSuffix = before.suffix;
        givenPosters.delete(entry);
        touchCategory(entry.categoryId);
    }
    posteredEntries.delete(table);
    return ids.size;
}

function rememberPoster(kind: TitleLinkKind, tmdbId: number, path: unknown): path is string {
    if (tmdbId <= 0 || typeof path !== 'string' || !POSTER_PATH.test(path)) return false;
    knownPosters.set(posterKey(kind, tmdbId), path);
    return true;
}

/** Pose l'affiche sur tous les titres reliés par le titre à ce numéro (plusieurs versions d'un même film) */
function givePostersFor(indexes: LinkTable, kind: TitleLinkKind, tmdbId: number): void {
    const table = kind === 'movie' ? indexes.movies : indexes.series;
    const linked = titleLinkedBefore.get(table);
    if (!linked) return;
    let given = 0;
    for (const id of linked.keys()) {
        if (table.get(id)?.tmdbId === tmdbId && givePoster(indexes, kind, id)) given++;
    }
    if (given > 0) announcePosters();
}

/**
 * Affiche du résultat TMDB choisi par une recherche par le titre : notée (base et mémoire) et posée tout de
 * suite sur les titres du catalogue reliés à ce numéro et sans image. Aucune demande à TMDB en plus.
 */
export function noteFoundPoster(kind: TitleLinkKind, tmdbId: number, path: string | null | undefined): void {
    if (!rememberPoster(kind, tmdbId, path)) return;
    void getDatabase()
        .then((database) => database.execute(
            'INSERT OR REPLACE INTO title_tmdb_posters (kind, tmdb_id, poster_path) VALUES (?, ?, ?)',
            [kind, tmdbId, path],
        ))
        .catch((e: unknown) => log.warn('Affiche TMDB non notée :', e));
    const indexes = currentCatalogFor(getDatabaseFileName());
    if (indexes) givePostersFor(indexes, kind, tmdbId);
}

/**
 * Affiches déjà connues relues de la base : celles des fiches déjà ouvertes (cache des fiches TMDB), puis
 * celles notées par les recherches. Ne lève jamais.
 */
async function loadKnownPosters(database: { select<T>(sql: string, params?: unknown[]): Promise<T> }): Promise<void> {
    const read = async (sql: string) => {
        try {
            const rows = await database.select<{ kind: TitleLinkKind; tmdb_id: number; poster_path: string }[]>(sql);
            for (const row of rows) rememberPoster(row.kind, Number(row.tmdb_id), row.poster_path);
        } catch (e) {
            log.warn('Affiches TMDB non relues :', e);
        }
    };
    await read(`SELECT type AS kind, tmdb_id, poster_path FROM tmdb_details_cache
                 WHERE season_number = 0 AND type IN ('movie', 'series') AND poster_path IS NOT NULL
                   AND tmdb_id IN (SELECT tmdb_id FROM m3u_tmdb_links WHERE tmdb_id > 0)`);
    await read('SELECT kind, tmdb_id, poster_path FROM title_tmdb_posters');
}

/** Pose un lien dans le catalogue en mémoire, si l'entrée est encore sans numéro TMDB */
export function applyLinkInMemory(indexes: LinkTable, kind: TitleLinkKind, id: number, tmdbId: number): boolean {
    // Réglage coupé pendant une recherche ou une relecture de la base : plus aucun lien posé
    if (tmdbId <= 0 || !isTmdbTitleSearchEnabled()) return false;
    if (kind === 'movie') {
        const entry = indexes.movies.get(id);
        if (!entry || entry.tmdbId > 0) return false;
        noteLinkedEntry(indexes.movies, id, entry.tmdbId);
        entry.tmdbId = tmdbId;
        if (!indexes.moviesByTmdb.has(tmdbId)) {
            indexes.moviesByTmdb.set(tmdbId, entry);
            noteTitleLink(indexes.moviesByTmdb);
        }
        if (givePoster(indexes, kind, id)) announcePosters();
        announceLinks();
        return true;
    }
    const entry = indexes.series.get(id);
    if (!entry || entry.tmdbId > 0) return false;
    noteLinkedEntry(indexes.series, id, entry.tmdbId);
    entry.tmdbId = tmdbId;
    if (!indexes.seriesByTmdb.has(tmdbId)) {
        indexes.seriesByTmdb.set(tmdbId, entry);
        noteTitleLink(indexes.seriesByTmdb);
    }
    if (givePoster(indexes, kind, id)) announcePosters();
    announceLinks();
    return true;
}

/**
 * Le fournisseur a renuméroté son catalogue : le numéro d'un lien gardé n'existe plus, mais le MÊME nom (exact,
 * avec une année) se retrouve sous un autre numéro, sans numéro TMDB et sans ligne à lui dans les liens gardés.
 * Le lien est reposé sans nouvelle recherche, seulement si un seul numéro TMDB est connu pour ce nom (un ancien
 * « pas trouvé » compte comme un désaccord) et si le catalogue n'a qu'une entrée de ce nom : jamais un homonyme.
 */
async function reapplyAfterRenumbering(
    database: { select<T>(sql: string, params?: unknown[]): Promise<T> },
    indexes: LightIndexes,
): Promise<number> {
    // Cas normal (aucune renumérotation) : une vérification par clé primaire, sans jointure sur les noms
    const gone = await database.select<{ one: number }[]>(
        `SELECT 1 AS one FROM m3u_tmdb_links l
          WHERE (l.kind = 'movie' AND NOT EXISTS (SELECT 1 FROM movies g WHERE g.id = l.id))
             OR (l.kind = 'series' AND NOT EXISTS (SELECT 1 FROM series g WHERE g.id = l.id)) LIMIT 1`,
    );
    if (gone.length === 0) return 0;
    // Liens dont le numéro a disparu, gardés une fois (MATERIALIZED) puis retrouvés par nom pendant UNE lecture
    // de chaque table : sans index sur le nom, une jointure par lien relisait tout le catalogue (2,4 s pour 300
    // titres disparus sur 160 000 films). SQLite embarqué (rusqlite « bundled ») : MATERIALIZED est connu.
    const moved = await database.select<{ kind: TitleLinkKind; id: number; name: string; tmdb_id: number }[]>(
        `WITH gone AS MATERIALIZED (
             SELECT l.kind AS kind, l.name AS name, l.tmdb_id AS tmdb_id FROM m3u_tmdb_links l
              WHERE (l.kind = 'movie' AND NOT EXISTS (SELECT 1 FROM movies x WHERE x.id = l.id))
                 OR (l.kind = 'series' AND NOT EXISTS (SELECT 1 FROM series x WHERE x.id = l.id)))
         SELECT g.kind AS kind, m.id AS id, g.name AS name, g.tmdb_id AS tmdb_id FROM movies m CROSS JOIN gone g
          WHERE g.kind = 'movie' AND g.name = m.name AND (m.tmdb_id IS NULL OR m.tmdb_id <= 0)
            AND NOT EXISTS (SELECT 1 FROM m3u_tmdb_links o WHERE o.kind = 'movie' AND o.id = m.id)
         UNION ALL
         SELECT g.kind, s.id, g.name, g.tmdb_id FROM series s CROSS JOIN gone g
          WHERE g.kind = 'series' AND g.name = s.name AND (s.tmdb_id IS NULL OR s.tmdb_id <= 0)
            AND NOT EXISTS (SELECT 1 FROM m3u_tmdb_links o WHERE o.kind = 'series' AND o.id = s.id)`,
    );
    const answers = new Map<string, Set<number>>();
    const entries = new Map<string, Set<number>>();
    for (const row of moved) {
        const key = `${row.kind}|${row.name}`;
        const known = answers.get(key) ?? new Set<number>();
        known.add(Number(row.tmdb_id));
        answers.set(key, known);
        const ids = entries.get(key) ?? new Set<number>();
        ids.add(Number(row.id));
        entries.set(key, ids);
    }
    let applied = 0;
    for (const row of moved) {
        const key = `${row.kind}|${row.name}`;
        const tmdbIds = answers.get(key);
        if (!tmdbIds || tmdbIds.size !== 1 || Number(row.tmdb_id) <= 0) continue;
        if (entries.get(key)?.size !== 1 || !sameTitleVersionKey(row.name)) continue;
        if (applyLinkInMemory(indexes, row.kind, Number(row.id), Number(row.tmdb_id))) applied++;
    }
    return applied;
}

/**
 * Retire du catalogue en mémoire tous les liens trouvés par le titre (réglage coupé) : chaque titre
 * reprend le numéro qu'il avait avant, et les numéros donnés par le fournisseur ne bougent pas. Les
 * liens restent notés dans la base : rallumer le réglage les repose sans nouvelle recherche.
 */
export function removeTitleLinksInMemory(indexes: LinkTable): number {
    let removed = 0;
    const pairs: [Map<number, { tmdbId: number }>, Map<number, unknown>][] = [
        [indexes.movies, indexes.moviesByTmdb],
        [indexes.series, indexes.seriesByTmdb],
    ];
    for (const [table, byTmdb] of pairs) {
        // Affiches TMDB d'abord : elles suivent le lien
        if (removePosters(table as unknown as Map<number, { iconPrefixId: number; iconSuffix: string; categoryId: string }>) > 0) announcePosters();
        const linked = titleLinkedBefore.get(table);
        if (!linked) continue;
        for (const [id, before] of linked) {
            const entry = table.get(id);
            if (!entry || entry.tmdbId <= 0) continue;
            if (byTmdb.get(entry.tmdbId) === entry) byTmdb.delete(entry.tmdbId);
            entry.tmdbId = before;
            removed++;
        }
        titleLinkedBefore.delete(table);
        titleLinkedEntries.delete(table);
        titleLinkedCount.delete(byTmdb);
    }
    if (removed > 0) announceLinks();
    return removed;
}

let watchingSetting = false;
let settingWasOn = true;

/**
 * Réglage « fiches TMDB par le titre » changé (ici, ou par la synchronisation d'un autre appareil) :
 * coupé, les fiches trouvées par le titre disparaissent tout de suite ; rallumé, elles reviennent.
 */
function watchTitleSearchSetting(): void {
    if (watchingSetting || typeof window === 'undefined') return;
    watchingSetting = true;
    settingWasOn = isTmdbTitleSearchEnabled();
    window.addEventListener(PREFERENCES_EVENT, () => {
        const on = isTmdbTitleSearchEnabled();
        if (on === settingWasOn) return;
        settingWasOn = on;
        const indexes = currentCatalogFor(getDatabaseFileName());
        if (!indexes) return;
        const changed = on ? applyStoredTitleLinks(indexes) : Promise.resolve(removeTitleLinksInMemory(indexes));
        void changed.then((count) => (count > 0 ? refreshHomeRows(indexes) : undefined));
    });
}

/**
 * Rangées et grande affiche de l'accueil recalculées avec les liens du moment (cache TMDB seulement, sans
 * réseau). Chargé à la demande : ce module reste léger, lu à chaque chargement du catalogue.
 */
async function refreshHomeRows(indexes: LightIndexes): Promise<void> {
    try {
        const [{ computeDashboardRematch }, { installDashboardRematch }] = await Promise.all([
            import('./dashboardRematch'),
            import('./dashboardCache'),
        ]);
        installDashboardRematch(await computeDashboardRematch(indexes));
    } catch (e) {
        log.warn('Accueil non recalculé après le réglage des fiches par le titre :', e);
    }
}

/**
 * Repose dans le catalogue en mémoire les liens trouvés par le titre lors des sessions
 * précédentes, pour les entrées toujours sans numéro et au même nom. Ne lève jamais.
 */
export async function applyStoredTitleLinks(indexes: LightIndexes): Promise<number> {
    try {
        if (!isTmdbTitleSearchEnabled()) return 0;
        if (indexes.movies.size + indexes.series.size === 0) return 0;
        const database = await getDatabase();
        await loadKnownPosters(database);
        const rows = await database.select<{ kind: TitleLinkKind; id: number; tmdb_id: number }[]>(
            `SELECT l.kind AS kind, l.id AS id, l.tmdb_id AS tmdb_id FROM m3u_tmdb_links l
               JOIN movies m ON l.kind = 'movie' AND m.id = l.id AND m.name = l.name
              WHERE l.tmdb_id > 0 AND (m.tmdb_id IS NULL OR m.tmdb_id <= 0)
             UNION ALL
             SELECT l.kind, l.id, l.tmdb_id FROM m3u_tmdb_links l
               JOIN series s ON l.kind = 'series' AND s.id = l.id AND s.name = l.name
              WHERE l.tmdb_id > 0 AND (s.tmdb_id IS NULL OR s.tmdb_id <= 0)`,
        );
        let applied = 0;
        for (const row of rows) {
            if (applyLinkInMemory(indexes, row.kind, Number(row.id), Number(row.tmdb_id))) applied++;
        }
        // Entrées au nom changé : même titre sous un autre nom (préfixe, qualité) = lien reposé ; sinon le
        // numéro a été donné à un autre titre, l'entrée est marquée pour ne pas reprendre l'ancien numéro
        const changed = await database.select<{ kind: TitleLinkKind; id: number; tmdb_id: number; old_name: string; new_name: string }[]>(
            `SELECT l.kind AS kind, l.id AS id, l.tmdb_id AS tmdb_id, l.name AS old_name, m.name AS new_name FROM m3u_tmdb_links l
               JOIN movies m ON l.kind = 'movie' AND m.id = l.id AND m.name <> l.name
              WHERE l.tmdb_id > 0 AND (m.tmdb_id IS NULL OR m.tmdb_id <= 0)
             UNION ALL
             SELECT l.kind, l.id, l.tmdb_id, l.name, s.name FROM m3u_tmdb_links l
               JOIN series s ON l.kind = 'series' AND s.id = l.id AND s.name <> l.name
              WHERE l.tmdb_id > 0 AND (s.tmdb_id IS NULL OR s.tmdb_id <= 0)`,
        );
        for (const row of changed) {
            const id = Number(row.id);
            if (sameCleanedName(row.old_name, row.new_name)) {
                if (applyLinkInMemory(indexes, row.kind, id, Number(row.tmdb_id))) applied++;
                continue;
            }
            const entry = row.kind === 'movie' ? indexes.movies.get(id) : indexes.series.get(id);
            if (entry && entry.tmdbId <= 0) markStaleTitleLink(entry);
        }
        applied += await reapplyAfterRenumbering(database, indexes);
        return applied;
    } catch (e) {
        log.warn('Liens TMDB par le titre non relus :', e);
        return 0;
    }
}
