/**
 * Search Index — FTS5 full-text search operations
 */

import { getDatabase } from './dbCore';
import { createLogger } from '../utils/logger';

const log = createLogger('SQLite');

// ============================================================================
// NORMALIZATION
// ============================================================================

/**
 * Version de la règle de normalisation des noms (`normalizeName`). Un index fait avec une autre
 * version est refait une fois, en arrière-plan (`applyPendingSearchChanges`) : les noms y sont
 * rangés sous l'ancienne forme. Version 2 : toutes les écritures (arabe, cyrillique, grec, chinois…)
 * et les lettres sans accent séparable (œ, ß, ı, ł…) gardées ; avant, seuls a-z et 0-9 restaient.
 */
export const SEARCH_NORM_VERSION = '2';

/**
 * Lettres qui ne se décomposent pas en lettre + accent (NFD) : traduites comme on les tape sur un
 * clavier sans ces lettres (« coeur » trouve « Cœur », « kirmizi » trouve « Kırmızı »).
 */
const FOLDED_LETTERS: Record<string, string> = {
  'œ': 'oe', 'æ': 'ae', 'ß': 'ss', 'ø': 'o', 'ł': 'l', 'đ': 'd', 'ð': 'd', 'þ': 'th', 'ı': 'i', 'ħ': 'h', 'ŧ': 't',
  // Sigma grec de fin de mot : même lettre que σ
  'ς': 'σ',
};
const FOLDED_PATTERN = new RegExp(`[${Object.keys(FOLDED_LETTERS).join('')}]`, 'g');

/**
 * Normalize a name for search indexing.
 * - Lowercase
 * - Compatibility forms unfolded (NFKD : « Ｔｏｋｙｏ », « ᴴᴰ », « 𝐅𝐫𝐚𝐧𝐜𝐞 », « ﬁ » se tapent normalement)
 * - Remove accents and other combining marks (é → e, ñ → n, harakat arabes…). Les signes voyelles
 *   des écritures indiennes ou les dakuten japonais disparaissent aussi : la recherche y est un peu
 *   moins précise, mais le nom rangé et la requête tapée suivent la même règle et se retrouvent.
 * - Letters without a separable accent spelled out (œ → oe, ß → ss, ı → i…)
 * - Remove punctuation and symbols (keep the letters and digits of every script)
 * - Collapse multiple spaces
 */
export function normalizeName(name: string): string {
  return name
    .normalize('NFKD')
    .toLowerCase()
    // Remove accents (NFKD separates them from their letter)
    .replace(/\p{M}/gu, '')
    .replace(FOLDED_PATTERN, (letter) => FOLDED_LETTERS[letter] ?? letter)
    // Remove everything but letters and digits of any script (hyphens, apostrophes, symbols…)
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    // Collapse multiple spaces into one
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Même règle que la recherche FTS5 (`mot1* mot2*` sur le nom normalisé) : chaque mot de la requête
 * commence un mot du nom. Sert à filtrer aussitôt les résultats déjà affichés quand l'utilisateur
 * ajoute des lettres, en attendant la vraie recherche.
 */
export function matchesSearch(name: string, query: string): boolean {
  const words = normalizeName(query).split(' ').filter((w) => w.length > 0);
  if (words.length === 0) return false;
  const tokens = normalizeName(name).split(' ');
  return words.every((w) => tokens.some((t) => t.startsWith(w)));
}

// ============================================================================
// INDEX REBUILD
// ============================================================================

/**
 * Rebuild the FTS5 search index from existing data.
 * Called after login/resume to populate the search index.
 *
 * Now includes normalized_name for better search matching:
 * - "spider-man" → "spiderman" (finds with "spiderman" query)
 * - "Café" → "cafe" (finds with "cafe" query)
 *
 * @param preloadedData Optional pre-loaded data to avoid redundant SELECTs
 */
export async function rebuildSearchIndex(preloadedData?: {
  movies: { id: number; name: string }[];
  series: { id: number; name: string }[];
  live: { id: number; name: string }[];
}): Promise<void> {
  const database = await getDatabase();
  // Notes de l'actualisation en arrière-plan couvertes par cette reconstruction (effacées à la fin)
  const seq = await readSearchSeq(database);
  // Reconstruction complète notée avant de vider l'index, effacée à la fin : l'app tuée en route
  // (connexion, « Actualiser ») laisse la note, et la vérification suivante de l'actualisation
  // automatique refait l'index au lieu de le garder vide ou périmé
  await database.execute(
    `INSERT OR REPLACE INTO meta (key, value) VALUES ('search_dirty', '1'), ('search_pending', 'all')`
  );

  // Clear existing index
  await database.execute('DELETE FROM search_index');

  // Use preloaded data or fetch fresh
  let movies: { id: number; name: string }[];
  let series: { id: number; name: string }[];
  let live: { id: number; name: string }[];

  if (preloadedData) {
    movies = preloadedData.movies.filter(m => m.name);
    series = preloadedData.series.filter(s => s.name);
    live = preloadedData.live.filter(l => l.name);
  } else {
    // Load all names from tables (fallback)
    [movies, series, live] = await Promise.all([
      database.select<{ id: number; name: string }[]>('SELECT id, name FROM movies WHERE name IS NOT NULL AND name != ""'),
      database.select<{ id: number; name: string }[]>('SELECT id, name FROM series WHERE name IS NOT NULL AND name != ""'),
      database.select<{ id: number; name: string }[]>('SELECT id, name FROM live WHERE name IS NOT NULL AND name != ""'),
    ]);
  }

  // Batch insert with normalized names
  await insertSearchRows(database, 'movie', movies);
  await insertSearchRows(database, 'series', series);
  await insertSearchRows(database, 'live', live);
  // Marque posée avant d'effacer la note : l'app tuée entre les deux ne refait pas tout une fois de plus
  await markSearchNormVersion(database);
  await clearSearchNotes(database, seq);
}

type SearchContentType = 'movie' | 'series' | 'live';
type SearchDatabase = Awaited<ReturnType<typeof getDatabase>>;

/**
 * Insertion par paquets de 500, avec le nom normalisé (reconstruction et mise à jour ligne à ligne).
 * Renvoie vrai si `shouldStop` l'a arrêtée avant la fin.
 */
async function insertSearchRows(
  database: SearchDatabase,
  type: SearchContentType,
  rows: { id: number; name: string }[],
  shouldStop?: () => boolean,
): Promise<boolean> {
  const BATCH_SIZE = 500;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    if (shouldStop?.()) return true;
    const batch = rows.slice(i, i + BATCH_SIZE);
    const placeholders = batch.map(() => '(?, ?, ?, ?)').join(', ');
    const values = batch.flatMap(r => [r.name, normalizeName(r.name), type, r.id]);
    await database.execute(
      `INSERT INTO search_index (name, normalized_name, content_type, content_id) VALUES ${placeholders}`,
      values
    );
  }
  return false;
}

// ============================================================================
// MISE À JOUR APRÈS UNE ACTUALISATION EN ARRIÈRE-PLAN
// ============================================================================

const SEARCH_TABLES: Record<SearchContentType, string> = { movie: 'movies', series: 'series', live: 'live' };
const DELTA_CHUNK = 500;

async function readSearchSeq(database: SearchDatabase): Promise<string | null> {
  const rows = await database.select<{ value: string | null }[]>("SELECT value FROM meta WHERE key = 'search_seq'");
  return rows[0]?.value ?? null;
}

/** Index refait avec la règle de normalisation actuelle (`SEARCH_NORM_VERSION`) */
async function markSearchNormVersion(database: SearchDatabase): Promise<void> {
  await database.execute(
    `INSERT OR REPLACE INTO meta (key, value) VALUES ('search_norm', ?)`,
    [SEARCH_NORM_VERSION]
  );
}

/** Efface les notes, seulement si l'actualisation n'en a pas ajouté depuis `seq` */
async function clearSearchNotes(database: SearchDatabase, seq: string | null): Promise<void> {
  await database.execute(
    `DELETE FROM meta WHERE key IN ('search_dirty', 'search_pending')
       AND (SELECT value FROM meta WHERE key = 'search_seq') IS ?`,
    [seq]
  );
}

/**
 * Reconstruction complète sans période vide : les nouvelles lignes sont ajoutées à côté des
 * anciennes, puis les anciennes sont retirées d'un seul coup (numéros de ligne ≤ au plus grand
 * d'avant). Entre les deux, une recherche peut trouver un titre deux fois : `searchContent`
 * n'en garde qu'un.
 *
 * Arrêtée en route (vidéo qui démarre), elle s'arrête là sans rien effacer : retirer d'un coup
 * jusqu'à des centaines de milliers de lignes tomberait pile au démarrage de la lecture. Les lignes
 * déjà ajoutées sont des doublons (un seul résultat par titre) et la note reste en base : la
 * reconstruction suivante les compte parmi les anciennes et les retire avec elles.
 */
async function rebuildBesideOldRows(database: SearchDatabase, shouldStop: () => boolean): Promise<boolean> {
  const last = await database.select<{ rowid: number }[]>('SELECT rowid FROM search_index ORDER BY rowid DESC LIMIT 1');
  const maxOld = last[0]?.rowid ?? 0;
  for (const type of Object.keys(SEARCH_TABLES) as SearchContentType[]) {
    if (shouldStop()) return false;
    const rows = await database.select<{ id: number; name: string }[]>(
      `SELECT id, name FROM ${SEARCH_TABLES[type]} WHERE name IS NOT NULL AND name != ''`
    );
    if (await insertSearchRows(database, type, rows, shouldStop)) return false;
  }
  if (shouldStop()) return false;
  await database.execute('DELETE FROM search_index WHERE rowid <= ?', [maxOld]);
  return true;
}

/**
 * Applique les notes laissées par l'actualisation en arrière-plan (`catalog_refresh.rs`) :
 * `meta.search_dirty = '1'` avec la liste des numéros dont le nom a changé
 * (`meta.search_pending` = `{"movie":[…],"series":[…],"live":[…]}`), ou `"all"` au-delà de
 * 2 000 numéros (reconstruction complète).
 *
 * Ligne à ligne : les lignes de ces numéros sont supprimées, puis réinsérées avec leur nom actuel
 * en base (un titre retiré n'est donc pas réinséré). La note n'est effacée qu'après réussite, et
 * seulement si l'actualisation n'en a pas ajouté pendant ce travail (`meta.search_seq` inchangé) ;
 * sinon elle sera retraitée, sans risque (supprimer puis réinsérer un nom à jour ne change rien).
 * Une note restée d'un arrêt de l'app est traitée au passage suivant.
 *
 * `shouldStop` (vidéo qui démarre, session fermée) est vérifiée entre deux paquets : le travail
 * s'arrête (`'stopped'`), la note reste en base et tout est refait plus tard. La reconstruction
 * complète garde l'ancien index jusqu'au bout (`rebuildBesideOldRows`).
 */
export async function applyPendingSearchChanges(
  shouldStop: () => boolean = () => false,
): Promise<'none' | 'delta' | 'rebuilt' | 'stopped'> {
  const database = await getDatabase();
  const notes = await database.select<{ key: string; value: string | null }[]>(
    "SELECT key, value FROM meta WHERE key IN ('search_dirty', 'search_pending', 'search_seq', 'search_norm')"
  );
  const note = (key: string) => notes.find((n) => n.key === key)?.value ?? null;
  // Index fait avec une ancienne règle de normalisation (noms non latins effacés…) : refait en entier
  const oldNorm = note('search_norm') !== SEARCH_NORM_VERSION;
  if (note('search_dirty') !== '1' && !oldNorm) return 'none';
  const seq = note('search_seq');

  let pending: Partial<Record<SearchContentType, number[]>> | null = null;
  try {
    const parsed: unknown = oldNorm ? null : JSON.parse(note('search_pending') ?? 'null');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      pending = parsed as Partial<Record<SearchContentType, number[]>>;
    }
  } catch {
    pending = null; // "all" ou note illisible : reconstruction complète
  }

  let outcome: 'delta' | 'rebuilt';
  if (pending) {
    for (const type of Object.keys(SEARCH_TABLES) as SearchContentType[]) {
      const ids = [...new Set((pending[type] ?? []).filter((id) => Number.isInteger(id)))];
      for (let i = 0; i < ids.length; i += DELTA_CHUNK) {
        // Arrêt entre deux paquets : la note reste, le travail est refait (sans risque) plus tard
        if (shouldStop()) return 'stopped';
        const chunk = ids.slice(i, i + DELTA_CHUNK);
        const marks = chunk.map(() => '?').join(', ');
        const old = await database.select<{ rowid: number }[]>(
          `SELECT rowid FROM search_index WHERE content_type = ? AND content_id IN (${marks})`,
          [type, ...chunk]
        );
        if (old.length > 0) {
          const rowids = old.map((r) => r.rowid);
          await database.execute(
            `DELETE FROM search_index WHERE rowid IN (${rowids.map(() => '?').join(', ')})`,
            rowids
          );
        }
        const current = await database.select<{ id: number; name: string }[]>(
          `SELECT id, name FROM ${SEARCH_TABLES[type]} WHERE id IN (${marks}) AND name IS NOT NULL AND name != ''`,
          chunk
        );
        await insertSearchRows(database, type, current);
      }
    }
    outcome = 'delta';
  } else {
    if (!(await rebuildBesideOldRows(database, shouldStop))) return 'stopped';
    outcome = 'rebuilt';
  }

  if (oldNorm) await markSearchNormVersion(database);
  await clearSearchNotes(database, seq);
  return outcome;
}

// ============================================================================
// SEARCH
// ============================================================================

/**
 * Search result from FTS5
 */
interface FTS5SearchResult {
  id: number;
  name: string;
  type: 'movie' | 'series' | 'live';
}

/**
 * Search content using FTS5 full-text search.
 * Supports prefix search (e.g., "bat" matches "batman")
 *
 * Now searches on normalized_name for better matching:
 * - "spiderman" finds "Spider-Man"
 * - "cafe" finds "Café"
 *
 * Une limite par type : une recherche courte qui trouve des centaines
 * de chaînes ne prend plus toute la place des films et des séries. Résultats rangés films, séries,
 * puis chaînes, chacun par pertinence.
 *
 * @param query - Search query (min 2 characters)
 * @param limit - Max results per type (default 100)
 * @returns Array of search results with id, name, and type
 */
export async function searchContent(
  query: string,
  limit = 100
): Promise<FTS5SearchResult[]> {
  // Minimum 2 characters for search
  if (!query || query.trim().length < 2) return [];

  const database = await getDatabase();

  // Normalize the query the same way we normalize names
  const normalizedQuery = normalizeName(query);

  if (!normalizedQuery || normalizedQuery.length < 2) return [];

  // FTS5 query with prefix search on normalized_name
  // Split into words and add prefix to each for multi-word search
  const words = normalizedQuery.split(' ').filter(w => w.length > 0);
  const ftsQuery = words.map(w => `${w}*`).join(' ');

  try {
    // Une seule passe : rang de pertinence calculé une fois, puis les `limit` premiers de chaque type
    const results = await database.select<{
      content_id: number;
      name: string;
      content_type: SearchContentType;
    }[]>(
      `SELECT content_id, name, content_type FROM (
         SELECT content_id, name, content_type,
                ROW_NUMBER() OVER (PARTITION BY content_type ORDER BY rank) AS type_rank
         FROM search_index
         WHERE normalized_name MATCH ?
       )
       WHERE type_rank <= ?
       ORDER BY CASE content_type WHEN 'movie' THEN 0 WHEN 'series' THEN 1 ELSE 2 END, type_rank`,
      [ftsQuery, limit]
    );

    // Un titre peut figurer deux fois pendant une reconstruction en arrière-plan
    // (rebuildBesideOldRows) : un seul résultat par titre
    const seen = new Set<string>();
    return results
      .filter(r => {
        const key = `${r.content_type}:${r.content_id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map(r => ({
        id: r.content_id,
        name: r.name,
        type: r.content_type
      }));
  } catch (error) {
    log.error('Search error:', error);
    return [];
  }
}
