/**
 * Titres de Ma liste « introuvables » rattachés au catalogue par leur titre, sans aucune demande à TMDB.
 *
 * Une ligne de Ma liste porte le numéro TMDB du titre. Chez un fournisseur qui ne donne pas ces numéros
 * (liste M3U), le catalogue ne connaît que les titres déjà reliés par leur nom : les autres restent
 * « introuvables » alors que la liste les a. La fiche TMDB de la ligne est déjà dans le cache des fiches
 * (c'est elle qui donne son nom et son affiche à la carte) : son titre, son titre original et son année
 * suffisent à retrouver l'entrée du catalogue, avec la même règle « lien sûr ou rien » que la recherche
 * par le titre, en plus strict (année obligatoire des deux côtés, écart d'un an au plus).
 *
 * Le lien est gardé comme un lien trouvé par une recherche (`m3u_tmdb_links`) : il revient au lancement
 * suivant et suit le réglage « Chercher les fiches TMDB par le titre ». Entrées M3U seulement.
 */

import type { LightIndexes, LightMovie, LightSeries } from '../types/lightIndex';
import { getDatabase, getDatabaseFileName } from './dbCore';
import { isTmdbTitleSearchEnabled } from './preferencesService';
import { isM3uData } from './m3uTmdbLinks';
import { applyLinkInMemory, currentCatalogFor, noteFoundPoster } from './titleTmdbLinkStore';
import { cleanTitleForSearch, normalizeTitle, pickConfidentMatch, yearOf } from '../utils/tmdbTitleMatch';
import { createLogger } from '../utils/logger';

const log = createLogger('WatchlistTitleRelink');

type Kind = 'movie' | 'series';

export interface OrphanRow {
  tmdb_id: number;
  type: Kind;
}

/**
 * Entrées du catalogue examinées au plus pour un titre (un titre très court en trouve beaucoup) : au-delà,
 * un lien peut manquer, jamais un faux lien
 */
export const MAX_CANDIDATES_PER_TITLE = 300;
/** Noms du catalogue préparés par tranche avant de rendre la main à l'écran */
const NAME_CHUNK = 5000;

interface DetailsRow { tmdb_id: number; type: Kind; full_data: string | null; poster_path: string | null }
interface EntryRow { id: number; name: string; tmdb_id: number | null; data: string | null }

interface TitleFacts { titles: string[]; year: number; poster: string | null }

/** Noms des entrées sans numéro TMDB, sous leur forme de comparaison, préparés une fois par table */
const preparedNames = new WeakMap<object, { ids: number[]; names: string[] }>();
/** Titres déjà essayés pour ce catalogue : rien n'est refait à chaque relecture de Ma liste */
const tried = new WeakMap<object, Set<string>>();
/** Le catalogue a-t-il des entrées M3U ? Sans elles (fournisseur Xtream), rien n'est fait */
const hasM3u = new WeakMap<object, Promise<boolean>>();
let running: Promise<number> | null = null;
/** Demande arrivée pendant une passe : relancée à la fin (catalogue rechargé, nouvelles lignes) */
let pending: { indexes: LightIndexes; orphans: readonly OrphanRow[] } | null = null;

const yieldToScreen = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function namesOf(table: Map<number, LightMovie | LightSeries>): Promise<{ ids: number[]; names: string[] }> {
  const known = preparedNames.get(table);
  if (known) return known;
  const ids: number[] = [];
  const names: string[] = [];
  let count = 0;
  for (const [id, entry] of table) {
    if (++count % NAME_CHUNK === 0) await yieldToScreen();
    // Entrée qui a déjà son numéro (fournisseur ou lien) : jamais candidate
    if (entry.tmdbId > 0) continue;
    ids.push(id);
    names.push(normalizeTitle(entry.name));
  }
  const prepared = { ids, names };
  preparedNames.set(table, prepared);
  return prepared;
}

/** Titres et année d'une fiche TMDB gardée ; null sans année ou sans titre (jamais de lien alors) */
export function titleFactsOf(type: Kind, raw: string | null, poster: string | null): TitleFacts | null {
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    const text = (key: string) => (typeof data[key] === 'string' ? data[key] as string : '');
    const titles = (type === 'movie' ? [text('title'), text('original_title')] : [text('name'), text('original_name')]).filter(Boolean);
    const year = yearOf(type === 'movie' ? text('release_date') : text('first_air_date'));
    if (titles.length === 0 || year === undefined) return null;
    return { titles, year, poster };
  } catch {
    return null;
  }
}

/**
 * Rattache les lignes introuvables de Ma liste aux entrées M3U de même titre et de même année (à un an
 * près). Renvoie le nombre d'entrées reliées. Ne lève jamais ; une seule passe à la fois.
 */
export function relinkWatchlistOrphansByTitle(indexes: LightIndexes, orphans: readonly OrphanRow[]): Promise<number> {
  if (running) {
    pending = { indexes, orphans };
    return running;
  }
  running = relinkNow(indexes, orphans)
    .catch((e: unknown) => {
      log.warn('Rattachement de Ma liste par le titre impossible :', e);
      return 0;
    })
    .finally(() => {
      running = null;
      const next = pending;
      pending = null;
      if (next) void relinkWatchlistOrphansByTitle(next.indexes, next.orphans);
    });
  return running;
}

function catalogHasM3u(indexes: LightIndexes): Promise<boolean> {
  let known = hasM3u.get(indexes);
  if (!known) {
    known = getDatabase()
      .then((database) => database.select<{ one: number }[]>(
        `SELECT 1 AS one FROM movies WHERE tmdb_id IS NULL AND json_extract(data, '$.source') = 'm3u'
         UNION ALL SELECT 1 AS one FROM series WHERE tmdb_id IS NULL AND json_extract(data, '$.source') = 'm3u' LIMIT 1`,
      ))
      .then((rows) => rows.length > 0);
    // Lecture en échec : redemandée à la passe suivante
    known.catch(() => hasM3u.delete(indexes));
    hasM3u.set(indexes, known);
  }
  return known;
}

async function relinkNow(indexes: LightIndexes, orphans: readonly OrphanRow[]): Promise<number> {
  if (!isTmdbTitleSearchEnabled()) return 0;
  let done = tried.get(indexes);
  if (!done) {
    done = new Set();
    tried.set(indexes, done);
  }
  const wanted = orphans.filter((row) => row.tmdb_id > 0 && !done.has(`${row.type}:${row.tmdb_id}`));
  if (wanted.length === 0) return 0;
  // Base et catalogue de départ : un changement de compte ou de liste en cours de passe l'arrête
  const dbName = getDatabaseFileName();
  const stillCurrent = () => getDatabaseFileName() === dbName && currentCatalogFor(dbName) === indexes;
  if (!(await catalogHasM3u(indexes))) return 0;

  const database = await getDatabase();
  const ids = [...new Set(wanted.map((row) => row.tmdb_id))];
  const details = await database.select<DetailsRow[]>(
    `SELECT tmdb_id, type, full_data, poster_path FROM tmdb_details_cache
     WHERE season_number = 0 AND type IN ('movie', 'series') AND tmdb_id IN (${ids.map(() => '?').join(',')})`,
    ids,
  );

  let linked = 0;
  for (const row of wanted) {
    await yieldToScreen();
    if (!stillCurrent()) return linked;
    const detail = details.find((d) => Number(d.tmdb_id) === row.tmdb_id && d.type === row.type);
    // Fiche pas encore gardée : réessayé à la relecture qui suit son arrivée
    if (!detail) continue;
    done.add(`${row.type}:${row.tmdb_id}`);
    const facts = titleFactsOf(row.type, detail.full_data, detail.poster_path);
    if (!facts) continue;
    const table = row.type === 'movie' ? indexes.movies : indexes.series;
    const byTmdb = row.type === 'movie' ? indexes.moviesByTmdb : indexes.seriesByTmdb;
    if (byTmdb.has(row.tmdb_id)) continue;

    const keys = [...new Set(facts.titles.map(normalizeTitle).filter(Boolean))];
    const { ids: entryIds, names } = await namesOf(table);
    const candidates: number[] = [];
    for (let i = 0; i < names.length && candidates.length < MAX_CANDIDATES_PER_TITLE; i++) {
      if (!keys.some((key) => names[i].includes(key))) continue;
      const entry = table.get(entryIds[i]);
      if (entry && entry.tmdbId <= 0) candidates.push(entryIds[i]);
    }
    if (candidates.length === 0) continue;

    const kindTable = row.type === 'movie' ? 'movies' : 'series';
    const entries = await database.select<EntryRow[]>(
      `SELECT id, name, tmdb_id, data FROM ${kindTable} WHERE id IN (${candidates.map(() => '?').join(',')})`,
      candidates,
    );
    const now = Date.now();
    for (const entry of entries) {
      const m3u = isM3uData(entry.data);
      if (!m3u || (entry.tmdb_id ?? 0) > 0) continue;
      const query = cleanTitleForSearch(entry.name, m3u.year);
      // Année obligatoire : « Dune » sans année pourrait être n'importe quel film du nom
      if (!query || query.year === undefined || Math.abs(query.year - facts.year) > 1) continue;
      if (pickConfidentMatch(query, [{ id: row.tmdb_id, titles: facts.titles, year: facts.year }]) !== row.tmdb_id) continue;
      // Réglage coupé ou compte changé pendant la passe : rien n'est gardé
      if (!isTmdbTitleSearchEnabled() || !stillCurrent()) return linked;
      await database.execute(
        `INSERT INTO m3u_tmdb_links (kind, id, name, tmdb_id, checked_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(kind, id) DO UPDATE SET name = excluded.name, tmdb_id = excluded.tmdb_id, checked_at = excluded.checked_at
         WHERE excluded.tmdb_id > 0 OR m3u_tmdb_links.tmdb_id <= 0 OR m3u_tmdb_links.name <> excluded.name`,
        [row.type, entry.id, entry.name, row.tmdb_id, now],
      );
      noteFoundPoster(row.type, row.tmdb_id, facts.poster);
      if (applyLinkInMemory(indexes, row.type, Number(entry.id), row.tmdb_id)) linked++;
    }
  }
  return linked;
}
