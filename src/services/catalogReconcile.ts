/**
 * catalogReconcile.ts — Remise en ordre après un catalogue neuf (« Actualiser » aujourd'hui,
 * rafraîchissement automatique demain).
 *
 * Quand le catalogue est relu, tout ce qui garde des numéros de l'ancien catalogue doit suivre :
 * - les rangées de l'accueil (services/dashboardCache.ts) ;
 * - Ma liste en base (numéros renumérotés par le fournisseur) ;
 * - la mémoire des fiches (detailFetcher), indexée par numéro.
 * Les titres retirés par le fournisseur disparaissent des rangées de l'accueil ; la re-liaison de
 * Ma liste est celle de la connexion et de la reprise (sans perte lors des renumérotations).
 *
 * Deux temps, pour qu'un rafraîchissement en arrière-plan puisse préparer à l'avance et installer
 * à un moment calme :
 *   1. `prepareRefreshedCatalog(catalogue)`, asynchrone, n'affiche rien ;
 *   2. `applyRefreshedCatalog(préparé, setLightIndexes)`, synchrone : catalogue et rangées de
 *      l'accueil changent dans le même geste, React les affiche ensemble.
 */

import { WATCHLIST_EVENT } from './eventConstants';
import type { LightIndexes } from '../types/lightIndex';
import { getDashboardCacheGeneration, installDashboardRematch } from './dashboardCache';
import type { DashboardRematch } from './dashboardCache';
import { computeDashboardRematch } from './dashboardRematch';
import type { ComputeRematchOptions } from './dashboardRematch';
import { clearDetailCache } from './detailFetcher';
import { getDatabase } from './dbCore';
import { getLastProviderHash } from './preferencesService';
import { pushWatchlistUpdates } from './syncService';
import { relinkWatchlistStreamIds } from './watchlistRelinking';
import { devLog } from '../utils/devLog';
import { createLogger } from '../utils/logger';
import { rememberCurrentCatalog } from './titleTmdbLinkStore';

const log = createLogger('Catalog');

/**
 * Temps accordé au réseau (listes TMDB expirées, logos des nouveaux films de la bannière) pendant
 * « Actualiser ». Au-delà, les rangées sont recalculées depuis le cache seulement : la barre de
 * progression ne reste jamais bloquée sur un proxy TMDB qui traîne.
 */
export const DASHBOARD_NETWORK_BUDGET_MS = 8000;

export interface PrepareOptions extends ComputeRematchOptions {
  /**
   * Faux dès que la session a changé (déconnexion, autre compte) : Ma liste n'est alors ni réécrite
   * ni envoyée au cloud, pour ne jamais écrire chez le compte suivant.
   */
  isStillCurrent?: () => boolean;
}

export interface PreparedCatalog {
  indexes: LightIndexes;
  dashboard: DashboardRematch;
}

/**
 * Ma liste : relie à nouveau les titres renumérotés par le fournisseur.
 * La liste « cloud » est fabriquée à partir des lignes locales, avec le fournisseur actuel : seuls
 * les titres dont le numéro a réellement changé sont réécrits et renvoyés au cloud (avec une liste
 * vide, toute Ma liste serait considérée comme à relier et renvoyée).
 */
export async function relinkWatchlistAfterRefresh(
  indexes: LightIndexes,
  isStillCurrent: () => boolean = () => true,
): Promise<void> {
  const currentHash = getLastProviderHash();
  if (!currentHash || !isStillCurrent()) return;

  const db = await getDatabase();
  const rows = await db.select<{ tmdb_id: number; type: 'movie' | 'series' }[]>(
    'SELECT tmdb_id, type FROM watchlist WHERE tmdb_id > 0'
  );
  if (rows.length === 0 || !isStillCurrent()) return;

  const localItems = rows.map((row) => ({ tmdb_id: row.tmdb_id, type: row.type, provider_hash: currentHash }));
  // Sans prévenir l'écran : « Ma liste » affichée reste celle de l'ancien catalogue jusqu'à
  // l'installation (applyRefreshedCatalog), qui la fait relire
  const result = await relinkWatchlistStreamIds(indexes, currentHash, localItems, { notify: false, isStillCurrent });
  devLog('session', '🔗 Actualisation : Ma liste re-liée', { relinked: result.relinked, orphaned: result.orphaned });

  if (result.relinkedItems.length > 0 && isStillCurrent()) {
    pushWatchlistUpdates(result.relinkedItems).catch((err) =>
      log.warn('pushWatchlistUpdates failed:', err)
    );
  }
}

/** Rangées de l'accueil ; avec le réseau, dans la limite de DASHBOARD_NETWORK_BUDGET_MS */
async function computeDashboardWithinBudget(
  indexes: LightIndexes,
  options: ComputeRematchOptions,
): Promise<DashboardRematch> {
  if (!options.allowNetwork) return computeDashboardRematch(indexes, options);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), DASHBOARD_NETWORK_BUDGET_MS);
  });
  try {
    const withNetwork = await Promise.race([computeDashboardRematch(indexes, options), timeout]);
    if (withNetwork) return withNetwork;
  } finally {
    clearTimeout(timer);
  }
  devLog('session', '⏱ TMDB trop lent : accueil recalculé depuis le cache seulement');
  return computeDashboardRematch(indexes, { ...options, allowNetwork: false });
}

/**
 * Prépare tout ce qui prend du temps, sans rien afficher : rangées de l'accueil recalculées pour
 * le catalogue neuf, Ma liste re-liée en base. Ne lève jamais d'erreur : un échec laisse l'accueil
 * faire son propre recalcul discret à son prochain affichage.
 */
export async function prepareRefreshedCatalog(
  indexes: LightIndexes,
  options: PrepareOptions = {},
): Promise<PreparedCatalog> {
  const { isStillCurrent, ...rematchOptions } = options;
  const generation = getDashboardCacheGeneration();
  const [computed] = await Promise.all([
    computeDashboardWithinBudget(indexes, rematchOptions).catch((e): DashboardRematch => {
      log.warn('Recalcul de l\'accueil impossible, il se fera à son affichage', e);
      return { generation, base: null, genres: null };
    }),
    relinkWatchlistAfterRefresh(indexes, isStillCurrent).catch((e) => {
      log.warn('Re-liaison de Ma liste impossible (non bloquant)', e);
    }),
  ]);
  // Cache vidé pendant la préparation (le repli « cache seulement » relit la génération) : rien à installer
  const dashboard: DashboardRematch = computed.generation === generation
    ? computed
    : { generation, base: null, genres: null };
  return { indexes, dashboard };
}

/**
 * Installe un catalogue préparé. Synchrone : le catalogue en mémoire et les rangées de l'accueil
 * changent dans le même geste.
 */
export function applyRefreshedCatalog(
  prepared: PreparedCatalog,
  setLightIndexes: (indexes: LightIndexes) => void,
): void {
  setLightIndexes(prepared.indexes);
  // Catalogue à l'écran : les fiches trouvées par le titre y posent leurs liens
  rememberCurrentCatalog(prepared.indexes);
  installDashboardRematch(prepared.dashboard);
  // « Ma liste » relue avec le nouveau catalogue (re-liée en base pendant la préparation, sans
  // prévenir l'écran ; ou lors d'une préparation abandonnée avant celle-ci)
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(WATCHLIST_EVENT));
  // Fiches gardées en mémoire par numéro : un numéro disparu ou une autre extension de fichier
  // resterait sinon affiché jusqu'au redémarrage.
  clearDetailCache();
}

export { resetCatalogCaches } from './catalogCaches';
