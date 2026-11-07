/**
 * Recherche groupée de titres : plusieurs titres en un seul appel au relais (cartes de l'accueil d'une
 * liste sans numéro TMDB). TMDB n'a pas de recherche groupée : le relais cherche chaque titre de son
 * côté, cache partagé d'abord. Sans dépendance à Deno : testé par vitest.
 *
 * Forme de l'appel : `GET /search/batch?language=fr-FR&t=movie:2010:Inception&t=tv::Lost`.
 * Chaque `t` : sorte (`movie` ou `tv`), année (vide ou 4 chiffres), titre (le reste, `:` permis).
 */

/** Titres au plus par appel : le temps d'exécution du relais reste court */
export const BATCH_MAX_ITEMS = 20;
/** Recherches lancées en même temps chez TMDB */
export const BATCH_CONCURRENCY = 5;
/** Résultats gardés par titre (les premiers suffisent au choix du bon titre) */
export const BATCH_RESULTS_PER_ITEM = 10;
const MAX_QUERY_LENGTH = 200;

export interface BatchItem {
  kind: "movie" | "tv";
  year: string;
  query: string;
}

/**
 * Titres demandés, ou null si l'appel est mal formé : aucun titre, plus de `BATCH_MAX_ITEMS`, sorte,
 * année ou titre invalide. Les doublons exacts ne sont cherchés qu'une fois (et comptés une fois).
 */
export function parseBatchItems(values: readonly string[]): BatchItem[] | null {
  if (values.length === 0 || values.length > BATCH_MAX_ITEMS) return null;
  const items: BatchItem[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const first = value.indexOf(":");
    const second = first < 0 ? -1 : value.indexOf(":", first + 1);
    if (second < 0) return null;
    const kind = value.slice(0, first);
    const year = value.slice(first + 1, second);
    const query = value.slice(second + 1).trim();
    if (kind !== "movie" && kind !== "tv") return null;
    if (year !== "" && !/^\d{4}$/.test(year)) return null;
    if (!query || query.length > MAX_QUERY_LENGTH) return null;
    const key = `${kind}:${year}:${query}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ kind, year, query });
  }
  return items;
}

/** Résultat réduit à ce que l'app lit pour choisir le bon titre (numéro, titres, date, affiche) */
export function slimSearchAnswer(kind: "movie" | "tv", answer: unknown): Record<string, unknown>[] {
  const results = (answer as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) return [];
  const keep = kind === "movie"
    ? ["id", "title", "original_title", "release_date", "poster_path"]
    : ["id", "name", "original_name", "first_air_date", "poster_path"];
  return results.slice(0, BATCH_RESULTS_PER_ITEM).flatMap((result) => {
    if (!result || typeof result !== "object" || typeof (result as { id?: unknown }).id !== "number") return [];
    const slim: Record<string, unknown> = {};
    for (const field of keep) {
      const value = (result as Record<string, unknown>)[field];
      if (value !== undefined) slim[field] = value;
    }
    return [slim];
  });
}

/** `task` sur chaque élément, `limit` à la fois, résultats dans l'ordre */
export async function mapWithLimit<T, R>(items: readonly T[], limit: number, task: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await task(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
