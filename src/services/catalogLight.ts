/**
 * Lecture du catalogue en mémoire au démarrage.
 *
 * Chemin principal : commande Rust `load_light_catalog` (colonnes compactes, adresses d'affiche déjà
 * découpées) → `buildLightIndexesFromCatalog`. Secours, si la commande échoue (version ancienne du cœur
 * natif, mode aperçu, test) : l'ancienne lecture ligne à ligne par tauri-plugin-sql →
 * `buildLightIndexesFromSQLite`. Les deux donnent le même catalogue (test et contrôle sur appareil).
 */
import { invoke } from '@tauri-apps/api/core';
import { getDatabaseFileName } from './dbCore';
import { getAllMovies } from './movieRepository';
import { getAllSeries } from './seriesRepository';
import { getAllLive } from './liveRepository';
import { getAllCategories } from './categoryRepository';
import {
  buildLightIndexesFromCatalog,
  buildLightIndexesFromSQLite,
  countLightIndexDifferences,
  type LightCatalog,
} from '../utils/lightIndexBuilder';
import type { LightIndexes } from '../types/lightIndex';
import { applyStoredTitleLinks, rememberCurrentCatalog } from './titleTmdbLinkStore';
import { perfMark } from '../utils/perfMarks';
import { VERSION_MESURE as PERF_ENABLED } from './outilsTest';
import { createLogger } from '../utils/logger';

const log = createLogger('CatalogLight');
const catalogLog = createLogger('Catalog');

/** Ancienne lecture, ligne à ligne (secours, et référence du contrôle d'identité). */
export async function buildIndexesRowByRow(): Promise<LightIndexes> {
  const [movies, series, live, categories] = await Promise.all([
    getAllMovies(),
    getAllSeries(),
    getAllLive(),
    getAllCategories(),
  ]);
  const indexes = buildLightIndexesFromSQLite(movies, series, live, categories);
  await applyStoredTitleLinks(indexes);
  return indexes;
}

async function loadLightCatalog(): Promise<LightCatalog> {
  const dbName = getDatabaseFileName();
  if (!dbName) throw new Error('base locale non ouverte');
  return invoke<LightCatalog>('load_light_catalog', { dbName });
}

/**
 * Catalogue en mémoire (LightIndexes) : lecture compacte, ancienne lecture en secours.
 * `remember: false` : catalogue préparé en coulisse, retenu seulement une fois installé à l'écran
 * (applyRefreshedCatalog), une préparation pouvant être abandonnée.
 */
export async function loadLightIndexes(options: { remember?: boolean } = {}): Promise<LightIndexes> {
  const remember = options.remember !== false;
  perfMark('catalog-read-start');
  try {
    const catalog = await loadLightCatalog();
    perfMark('catalog-read-end');
    const indexes = buildLightIndexesFromCatalog(catalog);
    // Fiches TMDB trouvées par le titre (fournisseur sans numéro TMDB), gardées à part
    await applyStoredTitleLinks(indexes);
    if (remember) rememberCurrentCatalog(indexes);
    perfMark('catalog-indexed');
    if (PERF_ENABLED) scheduleIdentityCheck(indexes);
    return indexes;
  } catch (e) {
    catalogLog.warn('Lecture compacte indisponible, lecture ligne à ligne :', e);
  }
  const indexes = await buildIndexesRowByRow();
  if (remember) rememberCurrentCatalog(indexes);
  perfMark('catalog-read-end');
  perfMark('catalog-indexed');
  return indexes;
}

declare global {
  interface Window { __nyxCatalogCheck?: { differences: number; movies: number; series: number; live: number } }
}

/**
 * Version de mesure seulement, et seulement si l'outil l'a demandé (`nyx_perf_verify_catalog`) :
 * 15 s après le démarrage, recharge le catalogue par l'ancienne méthode et compte les différences.
 * Résultat dans window.__nyxCatalogCheck et la console (lus par l'outil de mesure).
 */
function scheduleIdentityCheck(indexes: LightIndexes): void {
  let wanted = false;
  try { wanted = localStorage.getItem('nyx_perf_verify_catalog') === '1'; } catch { /* stockage indisponible */ }
  if (!wanted) return;
  setTimeout(() => {
    void buildIndexesRowByRow().then((reference) => {
      const result = {
        differences: countLightIndexDifferences(indexes, reference),
        movies: indexes.movies.size,
        series: indexes.series.size,
        live: indexes.live.size,
      };
      window.__nyxCatalogCheck = result;
      log.info(`NYX_CATALOG_CHECK ${JSON.stringify(result)}`);
    }).catch((err) => log.warn('Identity check failed:', err));
  }, 15000);
}
