/**
 * syncBaseline.ts — Dernier accord connu avec le cloud
 *
 * Pour chaque type de données, l'appareil retient les éléments qu'il sait présents à la fois chez
 * lui et dans le cloud : le « dernier accord ». À la synchro, comparer le local, le cloud et ce
 * dernier accord dit de quel côté vient un changement :
 * - présent en local seulement : dans le dernier accord, il a été retiré ailleurs, on le retire ici ;
 *   sinon il a été ajouté ici (ou son envoi a échoué), on l'envoie ;
 * - présent dans le cloud seulement : dans le dernier accord, il a été retiré ici et l'envoi du
 *   retrait a échoué, on le retire du cloud ; sinon il a été ajouté ailleurs, on le copie ici.
 * Un élément absent du dernier accord retombe sur l'ancienne règle (union des deux côtés) : une base
 * neuve, ou la première synchro après la mise à jour, ne retire donc jamais rien.
 *
 * Rien ne change dans Supabase (ni colonne ni table) : tout est gardé dans la table `meta` de la base
 * du compte, une ligne JSON par type. La valeur retenue pour un élément est la date de la version
 * connue (reprises de lecture), 0 pour les listes (Ma liste, favoris TV, catégories masquées).
 */

import { getMeta, setMeta, isDatabaseOf } from '../dbCore';
import { getCurrentSyncUserId } from './syncState';
import { createLogger } from '../../utils/logger';

const log = createLogger('Sync');

/**
 * Un dernier accord par type de données ; `…_v2` pour les tables du cloud par fournisseur
 * (sync/cloudScope.ts), dont les clés portent le fournisseur.
 */
export type BaselineScope =
  | 'watchlist' | 'playback' | 'livetv' | 'hidden'
  | 'watchlist_v2' | 'playback_v2' | 'livetv_v2' | 'hidden_v2';
export type Baseline = Map<string, number>;

/**
 * Garde-fou contre les retraits en masse : au-delà de ce nombre, des retraits qui toucheraient plus
 * de MASS_REMOVAL_RATIO des éléments d'un côté ne sont pas appliqués. Autant de retraits d'un coup
 * viennent plus souvent d'une base vidée, d'une réponse incomplète du cloud ou d'une purge que de
 * retraits un à un. La synchro retombe alors sur l'union, comme avant (rien n'est perdu).
 */
export const EMPTY_SIDE_REMOVAL_LIMIT = 3;
export const MASS_REMOVAL_RATIO = 0.5;

/** Vrai si ces retraits sont trop nombreux pour être appliqués (voir EMPTY_SIDE_REMOVAL_LIMIT) */
export function isMassRemoval(removals: number, sideSize: number): boolean {
  return removals > EMPTY_SIDE_REMOVAL_LIMIT && removals > sideSize * MASS_REMOVAL_RATIO;
}

const metaKey = (scope: BaselineScope) => `sync_baseline:${scope}`;

/** Écritures du dernier accord l'une après l'autre (lecture, modification, écriture) */
let queue: Promise<unknown> = Promise.resolve();
function serialize<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => {});
  return run;
}

/** Tous les types de données synchronisés avec un dernier accord */
export const ALL_SCOPES: readonly BaselineScope[] = [
  'watchlist', 'playback', 'livetv', 'hidden', 'watchlist_v2', 'playback_v2', 'livetv_v2', 'hidden_v2',
];

/**
 * Génération du dernier accord, une par type : augmentée à chaque effacement (données locales
 * vidées, oubli, arrêt des relances). Une synchro note la génération de son type quand elle lit le
 * dernier accord et n'écrit plus rien si elle a changé : elle ne peut pas rétablir un dernier accord
 * qu'on vient d'effacer. Une par type : oublier un titre de Ma liste (re-liaison au démarrage)
 * n'arrête plus la synchro des favoris TV ou des reprises qui tourne à côté.
 */
const generations = new Map<BaselineScope, number>();
export function currentGeneration(scope: BaselineScope): number {
  return generations.get(scope) ?? 0;
}
/**
 * Invalide les synchros en cours de ces types (tous par défaut), appelé avant un effacement. Elles ne
 * peuvent plus rien écrire : les synchros suivantes ne les attendent donc plus.
 */
export function bumpGeneration(scopes: readonly BaselineScope[] = ALL_SCOPES): void {
  for (const scope of scopes) {
    generations.set(scope, currentGeneration(scope) + 1);
    scopeLocks.delete(scope);
  }
}

/** Attente maximale de la synchro précédente du même type (requête réseau restée sans réponse) */
export const SCOPE_LOCK_WAIT_MS = 60_000;

/** Une synchro par type à la fois (synchro d'ouverture et synchro relancée ne se chevauchent pas) */
const scopeLocks = new Map<BaselineScope, Promise<unknown>>();
export function runExclusive<T>(scope: BaselineScope, task: () => Promise<T>): Promise<T> {
  const previous = scopeLocks.get(scope) ?? Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waited = Promise.race([
    previous,
    new Promise<void>((resolve) => { timer = setTimeout(resolve, SCOPE_LOCK_WAIT_MS); }),
  ]).finally(() => clearTimeout(timer));
  const run = waited.then(task, task);
  scopeLocks.set(scope, run.catch(() => {}));
  return run;
}

/** Clé d'un titre de Ma liste : son numéro TMDB, à défaut son numéro de flux */
export function watchlistKey(tmdbId: number, streamId: number, type: 'movie' | 'series'): string {
  return tmdbId > 0 ? `t:${tmdbId}:${type}` : `s:${streamId}:${type}`;
}

/** Le compte est toujours connecté et sa base est celle qui est ouverte */
export function isSameAccount(userId: string): boolean {
  return getCurrentSyncUserId() === userId && isDatabaseOf(userId);
}

async function load(scope: BaselineScope): Promise<Baseline> {
  const raw = await getMeta(metaKey(scope));
  if (!raw) return new Map();
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return new Map(Object.entries(parsed).filter((entry): entry is [string, number] => typeof entry[1] === 'number'));
  } catch {
    return new Map();
  }
}

/**
 * Dernier accord de ce type pour ce compte (vide si aucun, ou si le compte a changé), avec la
 * génération au moment de la lecture. À lire AVANT le cloud et le local : un envoi qui aboutit
 * ensuite est vu comme un changement pas encore connu, ce qui est sans danger.
 */
export async function readBaseline(userId: string, scope: BaselineScope): Promise<Baseline & BaselineRead> {
  return serialize(async () => {
    const at = currentGeneration(scope);
    if (!isSameAccount(userId)) return Object.assign(new Map<string, number>(), { generation: at, scope });
    const baseline = await load(scope);
    return Object.assign(isSameAccount(userId) ? baseline : new Map<string, number>(), { generation: at, scope });
  });
}

/** Ce qu'une synchro retient de sa lecture du dernier accord */
export interface BaselineRead {
  generation: number;
  scope: BaselineScope;
}

/**
 * La synchro qui a lu ce dernier accord peut encore écrire (même compte, rien d'effacé depuis).
 * Un refus est journalisé : une synchro arrêtée en silence a longtemps passé pour une synchro réussie.
 */
export function canStillWrite(userId: string, baseline: BaselineRead): boolean {
  const label = baseline.scope;
  if (!isSameAccount(userId)) {
    log.warn(`${label}: stopped before writing (account changed or signed out)`);
    return false;
  }
  if (baseline.generation !== currentGeneration(baseline.scope)) {
    log.warn(`${label}: stopped before writing (local data cleared or forgotten meanwhile)`);
    return false;
  }
  return true;
}

export interface BaselineChanges {
  /** Génération lue par la synchro : rien n'est écrit si elle a changé depuis */
  generation?: number;
  /** Éléments désormais présents des deux côtés, avec leur version */
  set?: Iterable<[string, number]>;
  /** Éléments désormais absents d'au moins un côté */
  remove?: Iterable<string>;
  /** Idem, pour tous les éléments qui répondent à ce test */
  removeWhere?: (key: string) => boolean;
}

/**
 * Met à jour le dernier accord. N'écrit rien si le compte a changé entre-temps : la base ouverte
 * serait celle d'un autre compte.
 */
export function updateBaseline(userId: string, scope: BaselineScope, changes: BaselineChanges): Promise<void> {
  return serialize(async () => {
    if (!isSameAccount(userId)) return;
    if (changes.generation !== undefined && changes.generation !== currentGeneration(scope)) return;
    const baseline = await load(scope);
    for (const [key, version] of changes.set ?? []) baseline.set(key, version);
    for (const key of changes.remove ?? []) baseline.delete(key);
    if (changes.removeWhere) for (const key of [...baseline.keys()]) if (changes.removeWhere(key)) baseline.delete(key);
    if (!isSameAccount(userId)) return;
    await setMeta(metaKey(scope), JSON.stringify(Object.fromEntries(baseline)));
  }).catch((err) => {
    log.warn(`Baseline ${scope} update failed:`, err);
  });
}

/** Oublie le dernier accord de ces types (données locales vidées, cloud purgé) */
export function clearBaselines(userId: string, scopes: BaselineScope[]): Promise<void> {
  bumpGeneration(scopes);
  return serialize(async () => {
    if (!isSameAccount(userId)) return;
    for (const scope of scopes) await setMeta(metaKey(scope), '{}');
  }).catch((err) => {
    log.warn('Baseline clear failed:', err);
  });
}

// ============================================================================
// PLAN DE FUSION (listes sans date : Ma liste, favoris TV, catégories masquées)
// ============================================================================

export interface MergePlan {
  /** Présents dans le cloud seulement, ajoutés ailleurs : à copier en local */
  pullToLocal: string[];
  /** Présents en local seulement, ajoutés ici : à envoyer au cloud */
  pushToCloud: string[];
  /** Présents en local seulement, retirés ailleurs : à retirer en local */
  removeLocal: string[];
  /** Présents dans le cloud seulement, retirés ici : à retirer du cloud */
  removeCloud: string[];
  /** Présents des deux côtés */
  inBoth: string[];
  /** Éléments du dernier accord absents des deux côtés : à oublier */
  stale: string[];
}

/**
 * Compare local, cloud et dernier accord (voir l'en-tête). Garde-fous : pas de retraits en masse
 * dans le cloud (isMassRemoval, irréversible), pas de retraits locaux face à un cloud entièrement
 * vide ; la synchro retombe alors sur l'union, comme avant.
 */
export function planMerge(local: Set<string>, cloud: Set<string>, baseline: Baseline): MergePlan {
  const plan: MergePlan = { pullToLocal: [], pushToCloud: [], removeLocal: [], removeCloud: [], inBoth: [], stale: [] };
  for (const key of local) {
    if (cloud.has(key)) plan.inBoth.push(key);
    else if (baseline.has(key)) plan.removeLocal.push(key);
    else plan.pushToCloud.push(key);
  }
  for (const key of cloud) {
    if (local.has(key)) continue;
    if (baseline.has(key)) plan.removeCloud.push(key);
    else plan.pullToLocal.push(key);
  }
  for (const key of baseline.keys()) {
    if (!local.has(key) && !cloud.has(key)) plan.stale.push(key);
  }
  // Côté local, un retrait à tort se rattrape (la ligne est encore dans le cloud) : seul un cloud
  // entièrement vide bloque, et des retraits groupés faits ailleurs (vider « Reprendre ») s'appliquent
  if (cloud.size === 0 && plan.removeLocal.length > EMPTY_SIDE_REMOVAL_LIMIT) {
    log.warn(`Cloud empty: ${plan.removeLocal.length} local removals skipped`);
    plan.pushToCloud.push(...plan.removeLocal);
    plan.removeLocal = [];
  }
  if (isMassRemoval(plan.removeCloud.length, cloud.size)) {
    log.warn(`${plan.removeCloud.length}/${cloud.size} cloud removals skipped (mass removal)`);
    plan.pullToLocal.push(...plan.removeCloud);
    plan.removeCloud = [];
  }
  return plan;
}

/**
 * Oublie ces éléments du dernier accord du compte connecté. Pour les retraits locaux qui ne viennent
 * pas de l'utilisateur (nettoyage après lecture du catalogue, re-liaison) : la synchro suivante les
 * recopie depuis le cloud au lieu de les retirer du cloud et des autres appareils.
 */
export function forgetForCurrentAccount(scope: BaselineScope, keys: string[]): Promise<void> {
  const userId = getCurrentSyncUserId();
  if (!userId || keys.length === 0) return Promise.resolve();
  bumpGeneration([scope]); // une synchro en cours de ce type ne remet pas ces éléments dans le dernier accord
  return updateBaseline(userId, scope, { remove: keys });
}
