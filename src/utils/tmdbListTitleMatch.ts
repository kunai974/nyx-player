/**
 * Rapprochement « à l'envers » : les titres des listes TMDB de l'accueil (tendances, populaires,
 * genres…) sont comparés aux noms du catalogue, sur l'appareil, sans aucune demande à TMDB.
 * Sert aux fournisseurs qui ne donnent pas de numéro TMDB : sans lui, la page Suggestions resterait
 * vide.
 *
 * Même règle que la recherche par le titre (utils/tmdbTitleMatch.ts) : lien sûr ou rien.
 * - même titre (traduit ou original) une fois normalisé ;
 * - l'année du nom doit concorder à un an près avec celle de TMDB : lien sûr ;
 * - nom sans année (ou année qui faisait partie du titre, « Blade Runner 2049 ») : à confirmer par
 *   une recherche TMDB, un film du même nom ayant pu être refait ;
 * - plusieurs titres TMDB possibles pour un même nom : aucun lien.
 *
 * Coût : un catalogue de 160 000 films passe d'abord par un tri rapide (un mot du titre TMDB doit
 * figurer dans le nom), seuls les noms retenus sont nettoyés et comparés en entier.
 */

import { cleanTitleForSearch, normalizeTitle, type TitleQuery } from './tmdbTitleMatch';

export type ListTitleKind = 'movie' | 'series';

/** Un titre d'une liste TMDB, ramené à ce qui sert à comparer */
export interface ListTitle {
    kind: ListTitleKind;
    tmdbId: number;
    titles: string[];
    year?: number;
}

/** Titres des listes, prêts pour la comparaison */
export interface PreparedListTitles {
    byKey: Map<string, ListTitle[]>;
    anchors: Set<string>;
}

export type ListTitleVerdict =
    | { kind: 'sure'; tmdbId: number }
    | { kind: 'confirm'; tmdbId: number; query: TitleQuery };

const NON_ASCII = /[^ -~]/;
const SPLIT = /[^\p{L}\p{N}]+/u;

function stripAccents(text: string): string {
    return NON_ASCII.test(text) ? text.normalize('NFD').replace(/\p{Diacritic}/gu, '') : text;
}

/** Mots d'un nom, en minuscules et sans accents (tri rapide) */
function quickTokens(name: string): string[] {
    return stripAccents(name.toLowerCase()).split(SPLIT);
}

function longest(words: string[]): string {
    let best = '';
    for (const word of words) if (word.length > best.length) best = word;
    return best;
}

export function prepareListTitles(items: readonly ListTitle[]): PreparedListTitles {
    const byKey = new Map<string, ListTitle[]>();
    const anchors = new Set<string>();
    for (const item of items) {
        if (!Number.isSafeInteger(item.tmdbId) || item.tmdbId <= 0) continue;
        for (const title of item.titles) {
            if (!title) continue;
            const key = normalizeTitle(title);
            if (!key) continue;
            const list = byKey.get(key);
            if (!list) byKey.set(key, [item]);
            else if (!list.some((t) => t.kind === item.kind && t.tmdbId === item.tmdbId)) list.push(item);
            // Un mot qui figurera forcément dans le nom du catalogue s'il porte ce titre
            const quick = longest(quickTokens(title));
            if (quick) anchors.add(quick);
            const normalized = longest(key.split(' '));
            if (normalized) anchors.add(normalized);
        }
    }
    return { byKey, anchors };
}

function distinctIds(titles: readonly ListTitle[]): number[] {
    return [...new Set(titles.map((t) => t.tmdbId))];
}

/**
 * Verdict pour un nom du catalogue sans numéro TMDB : lien sûr, à confirmer par une recherche, ou
 * rien (null).
 */
export function matchListTitle(
    kind: ListTitleKind,
    name: string,
    prepared: PreparedListTitles,
): ListTitleVerdict | null {
    if (!name || prepared.byKey.size === 0) return null;
    if (!quickTokens(name).some((word) => prepared.anchors.has(word))) return null;

    const query = cleanTitleForSearch(name);
    if (!query) return null;
    const same = (prepared.byKey.get(normalizeTitle(query.query)) ?? []).filter((t) => t.kind === kind);

    if (query.year !== undefined) {
        const close = same.filter((t) => t.year !== undefined && Math.abs(t.year - query.year!) <= 1);
        const closeIds = distinctIds(close);
        if (closeIds.length === 1) return { kind: 'sure', tmdbId: closeIds[0] };
        if (closeIds.length > 1) {
            const exactIds = distinctIds(close.filter((t) => t.year === query.year));
            return exactIds.length === 1 ? { kind: 'sure', tmdbId: exactIds[0] } : null;
        }
        // « Blade Runner 2049 » : le nombre final faisait peut-être partie du titre
        if (!query.withYear) return null;
        const whole = distinctIds((prepared.byKey.get(normalizeTitle(query.withYear)) ?? []).filter((t) => t.kind === kind));
        return whole.length === 1 ? { kind: 'confirm', tmdbId: whole[0], query: { query: query.withYear } } : null;
    }

    const ids = distinctIds(same);
    return ids.length === 1 ? { kind: 'confirm', tmdbId: ids[0], query } : null;
}
