/**
 * Light Index Builder
 * 
 * Construit les Light Indexes à partir des données IPTV brutes.
 * Ces indexes légers contiennent uniquement les infos essentielles pour
 * l'affichage et les lookups rapides.
 * 
 * OPTIMIZATION: Uses string interning for icon URLs to save ~25MB RAM.
 * URLs are split into prefix (stored once) and suffix (stored per item).
 */

import type {
  LightMovie,
  LightSeries,
  LightLive,
  LightCategory,
  LightIndexes,
} from '../types/lightIndex';
import { categoryKey } from '../types/lightIndex';
import i18n from '../i18n/config';
import type { MovieRow } from '../types/repositories';
import type { SeriesRow } from '../types/repositories';
import type { LiveRow } from '../types/repositories';
import type { CategoryRow } from '../types/repositories';
import { devLog } from './devLog';

/**
 * Extract prefix and suffix from a URL
 * Example: "http://provider.com/images/movie_123.jpg" 
 *   -> { prefix: "http://provider.com/images/", suffix: "movie_123.jpg" }
 * 
 * NOTE: We use a trick to force V8 to create a real copy of the string
 * instead of a "sliced string" that keeps a reference to the original.
 * Without this, the full URLs would stay in memory!
 */
function extractPrefixSuffix(url: string): { prefix: string; suffix: string } {
  if (!url) return { prefix: '', suffix: '' };
  const lastSlash = url.lastIndexOf('/');
  if (lastSlash === -1) return { prefix: '', suffix: forceStringCopy(url) };
  return {
    prefix: url.slice(0, lastSlash + 1), // Prefix is stored once in registry, no need to copy
    suffix: forceStringCopy(url.slice(lastSlash + 1)), // Force copy to release original URL
  };
}

/**
 * Force V8 to create a real string copy instead of a sliced string reference.
 * Sliced strings keep the entire original string in memory!
 * 
 * NOTE: The old trick `(' ' + str).slice(1)` STILL creates a sliced string!
 * We use Array spread + join which guarantees a fresh string allocation.
 */
function forceStringCopy(str: string): string {
  if (!str) return str;
  // Spread into array of chars, then join - guaranteed new string
  return [...str].join('');
}


/**
 * Build icon prefix registry from a list of URLs
 * Returns the registry and a Map from prefix -> prefixId
 */
function buildPrefixRegistry(urls: string[]): { 
  prefixes: string[]; 
  prefixToId: Map<string, number>;
} {
  // Count frequency of each prefix
  const prefixCount = new Map<string, number>();
  for (const url of urls) {
    const { prefix } = extractPrefixSuffix(url);
    if (prefix) {
      prefixCount.set(prefix, (prefixCount.get(prefix) || 0) + 1);
    }
  }

  // Sort by frequency (most common first) and create registry
  const sortedPrefixes = Array.from(prefixCount.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([prefix]) => prefix);

  // Build reverse lookup
  const prefixToId = new Map<string, number>();
  sortedPrefixes.forEach((prefix, index) => {
    prefixToId.set(prefix, index);
  });

  return { prefixes: sortedPrefixes, prefixToId };
}


// ============================================================================
// BUILD FROM THE COMPACT CATALOG
// ============================================================================

/**
 * Nom affiché d'une catégorie : « Sans catégorie » si le fournisseur n'en donne pas (Xtream :
 * category_name absent ou vide ; M3U : groupe absent, écrit « — » par le Rust), au lieu d'un titre de
 * rangée vide ou d'un tiret.
 */
function categoryDisplayName(name: string | null | undefined): string {
  const trimmed = (name ?? '').trim();
  return trimmed === '' || trimmed === '—' ? i18n.t('common:unnamed_category') : (name as string);
}

/**
 * Catalogue compact envoyé par la commande Rust `load_light_catalog` (src-tauri/src/catalog_light.rs) :
 * mêmes lignes et même ordre que les quatre `getAll*`, en colonnes, adresses d'affiche déjà découpées
 * avec les règles de `buildPrefixRegistry` / `internIcon` ci-dessus. Les valeurs brutes (null compris)
 * sont transmises telles quelles : les valeurs par défaut sont appliquées ici, comme dans
 * `buildLightIndexesFromSQLite`.
 */
export interface LightCatalog {
  iconPrefixes: string[];
  movies: {
    id: number[]; name: (string | null)[]; iconPrefixId: number[]; iconSuffix: string[];
    tmdbId: (number | null)[]; categoryId: (string | null)[]; added: (number | null)[]; containerExtension: (string | null)[];
  };
  series: {
    id: number[]; name: (string | null)[]; iconPrefixId: number[]; iconSuffix: string[];
    tmdbId: (number | null)[]; categoryId: (string | null)[]; added: (number | null)[];
  };
  live: {
    id: number[]; name: (string | null)[]; iconPrefixId: number[]; iconSuffix: string[];
    categoryId: (string | null)[]; epgChannelId: (string | null)[]; matchedEpgId: (string | null)[]; matchMethod: (string | null)[];
  };
  /** [id, name, type] */
  categories: [string, string, LightCategory['type']][];
}

/**
 * Même résultat que `buildLightIndexesFromSQLite(getAllMovies(), getAllSeries(), getAllLive(),
 * getAllCategories())`, à partir du catalogue compact. Contrôlé à l'identique par un test et, dans la
 * version de mesure, sur le vrai catalogue (useSessionLifecycle).
 * Pas de `forceStringCopy` : les fins d'adresse arrivent déjà comme chaînes indépendantes (JSON).
 */
export function buildLightIndexesFromCatalog(catalog: LightCatalog): LightIndexes {
  const t0 = performance.now();
  const { movies: m, series: s, live: l } = catalog;

  const movieIndex = new Map<number, LightMovie>();
  for (let i = 0; i < m.id.length; i++) {
    if (m.id[i] === 0) continue;
    movieIndex.set(m.id[i], {
      id: m.id[i],
      name: m.name[i] || '',
      iconPrefixId: m.iconPrefixId[i],
      iconSuffix: m.iconSuffix[i],
      tmdbId: m.tmdbId[i] || 0,
      categoryId: m.categoryId[i] || '',
      added: m.added[i] || 0,
      containerExt: m.containerExtension[i] || '',
    });
  }

  const seriesIndex = new Map<number, LightSeries>();
  for (let i = 0; i < s.id.length; i++) {
    seriesIndex.set(s.id[i], {
      id: s.id[i],
      name: s.name[i] || '',
      iconPrefixId: s.iconPrefixId[i],
      iconSuffix: s.iconSuffix[i],
      tmdbId: s.tmdbId[i] || 0,
      categoryId: s.categoryId[i] || '',
      added: s.added[i] || 0,
    });
  }

  const liveIndex = new Map<number, LightLive>();
  for (let i = 0; i < l.id.length; i++) {
    if (l.id[i] === 0) continue;
    liveIndex.set(l.id[i], {
      id: l.id[i],
      name: l.name[i] || '',
      iconPrefixId: l.iconPrefixId[i],
      iconSuffix: l.iconSuffix[i],
      categoryId: l.categoryId[i] || '',
      epgChannelId: l.epgChannelId[i] || undefined,
      matchedEpgId: l.matchedEpgId[i] || undefined,
      matchMethod: l.matchMethod[i] || undefined,
    });
  }

  const categoriesIndex = new Map<string, LightCategory>();
  for (const [id, name, type] of catalog.categories) {
    categoriesIndex.set(categoryKey(type, id), { id, name: categoryDisplayName(name), type });
  }

  const moviesByTmdb = new Map<number, LightMovie>();
  for (const movie of movieIndex.values()) {
    if (movie.tmdbId > 0) moviesByTmdb.set(movie.tmdbId, movie);
  }
  const seriesByTmdb = new Map<number, LightSeries>();
  for (const serie of seriesIndex.values()) {
    if (serie.tmdbId > 0) seriesByTmdb.set(serie.tmdbId, serie);
  }

  devLog('perf', `buildLightIndexesFromCatalog: ${(performance.now() - t0).toFixed(1)}ms`);

  return {
    movies: movieIndex,
    series: seriesIndex,
    live: liveIndex,
    categories: categoriesIndex,
    moviesByTmdb,
    seriesByTmdb,
    iconPrefixes: catalog.iconPrefixes,
  };
}

/**
 * Nombre de différences entre deux catalogues en mémoire (contrôle d'identité de la version de
 * mesure). 0 = identiques (mêmes clés, mêmes champs, même registre des préfixes, même ordre).
 */
export function countLightIndexDifferences(a: LightIndexes, b: LightIndexes): number {
  let diff = 0;
  const same = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);
  if (!same(a.iconPrefixes, b.iconPrefixes)) diff += 1;
  for (const key of ['movies', 'series', 'live', 'categories', 'moviesByTmdb', 'seriesByTmdb'] as const) {
    const ma = a[key] as Map<unknown, unknown>;
    const mb = b[key] as Map<unknown, unknown>;
    if (ma.size !== mb.size) diff += 1;
    const ka = [...ma.keys()];
    const kb = [...mb.keys()];
    for (let i = 0; i < ka.length; i++) {
      if (ka[i] !== kb[i] || !same(ma.get(ka[i]), mb.get(ka[i]))) diff += 1;
    }
  }
  return diff;
}

// ============================================================================
// BUILD FROM SQLITE (Phase 1 - SQLite-First Architecture)
// ============================================================================


/**
 * Construit les Light Indexes directement depuis les colonnes SQLite.
 * Utilisé après ingestion Rust (Phase 1 SQLite-First).
 * 
 * IMPORTANT: Cette fonction n'utilise PAS la colonne 'data' car elle n'est
 * plus remplie par le parser Rust. Toutes les infos viennent des colonnes light.
 */
export function buildLightIndexesFromSQLite(
  movies: MovieRow[],
  series: SeriesRow[],
  live: LiveRow[],
  categories: CategoryRow[]
): LightIndexes {
  const t0 = performance.now();

  // Step 1: Collect all icon URLs and build prefix registry
  const tReg0 = performance.now();
  const allIconUrls: string[] = [];
  for (const m of movies) allIconUrls.push(m.icon || '');
  for (const s of series) allIconUrls.push(s.icon || '');
  for (const l of live) allIconUrls.push(l.icon || '');
  
  const { prefixes, prefixToId } = buildPrefixRegistry(allIconUrls);
  devLog('perf', `buildPrefixRegistry (SQLite): ${(performance.now() - tReg0).toFixed(1)}ms`);

  // Helper to get prefixId and suffix for an icon URL
  const internIcon = (url: string): { prefixId: number; suffix: string } => {
    if (!url) return { prefixId: -1, suffix: '' };
    const { prefix, suffix } = extractPrefixSuffix(url);
    const prefixId = prefixToId.get(prefix);
    if (prefixId === undefined) {
      return { prefixId: -1, suffix: url };
    }
    return { prefixId, suffix };
  };

  // Step 2: Build movie index
  const movieIndex = new Map<number, LightMovie>();
  for (const m of movies) {
    if (m.id === 0) continue;
    const { prefixId, suffix } = internIcon(m.icon || '');
    movieIndex.set(m.id, {
      id: m.id,
      name: m.name || '',
      iconPrefixId: prefixId,
      iconSuffix: suffix,
      tmdbId: m.tmdb_id || 0,
      categoryId: m.category_id || '',
      added: m.added || 0,
      containerExt: m.container_extension || '',
    });
  }

  // Step 3: Build series index
  const seriesIndex = new Map<number, LightSeries>();
  for (const s of series) {
    const { prefixId, suffix } = internIcon(s.icon || '');
    seriesIndex.set(s.id, {
      id: s.id,
      name: s.name || '',
      iconPrefixId: prefixId,
      iconSuffix: suffix,
      tmdbId: s.tmdb_id || 0,
      categoryId: s.category_id || '',
      added: s.added || 0,
    });
  }

  // Step 4: Build live index
  const liveIndex = new Map<number, LightLive>();
  for (const l of live) {
    if (l.id === 0) continue;
    const { prefixId, suffix } = internIcon(l.icon || '');
    liveIndex.set(l.id, {
      id: l.id,
      name: l.name || '',
      iconPrefixId: prefixId,
      iconSuffix: suffix,
      categoryId: l.category_id || '',
      epgChannelId: l.epg_channel_id || undefined,
      matchedEpgId: l.matched_epg_id || undefined,
      matchMethod: l.match_method || undefined,
    });
  }

  // Step 5: Build categories index
  const categoriesIndex = new Map<string, LightCategory>();
  for (const c of categories) {
    categoriesIndex.set(categoryKey(c.type, c.id), {
      id: c.id,
      name: categoryDisplayName(c.name),
      type: c.type,
    });
  }

  // Step 6: Build TMDB lookup indexes
  const moviesByTmdb = new Map<number, LightMovie>();
  for (const m of movieIndex.values()) {
    if (m.tmdbId > 0) {
      moviesByTmdb.set(m.tmdbId, m);
    }
  }

  const seriesByTmdb = new Map<number, LightSeries>();
  for (const s of seriesIndex.values()) {
    if (s.tmdbId > 0) {
      seriesByTmdb.set(s.tmdbId, s);
    }
  }

  devLog('perf', `buildLightIndexesFromSQLite: ${(performance.now() - t0).toFixed(1)}ms`);

  return {
    movies: movieIndex,
    series: seriesIndex,
    live: liveIndex,
    categories: categoriesIndex,
    moviesByTmdb,
    seriesByTmdb,
    iconPrefixes: prefixes,
  };
}
