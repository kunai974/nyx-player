/**
 * mpvApi.ts — Point d'entrée unique du lecteur vidéo.
 *
 * Même API que `tauri-plugin-mpv-api` :
 * - Desktop : lancement et commandes via la garde Rust `nyx_mpv_init` / `nyx_mpv_command`
 *   (`src-tauri/src/mpv_guard.rs`) : chemin de mpv fixe, commandes et propriétés en liste blanche,
 *   marges vidéo via `nyx_mpv_set_margins`. Les événements restent servis par le plugin.
 * - Android : délègue au plugin natif libmpv (androidPlayer.ts).
 *
 * Tous les hooks/services lecteur importent depuis ce module, jamais directement
 * depuis `tauri-plugin-mpv-api`.
 *
 * Versions du banc de tests automatiques (VITE_BANC=1, posée avec VITE_AUDIT=1 par le banc) : verrou
 * « jamais de vrai flux ». Les versions d'audit ordinaires (VITE_AUDIT=1 seul, tests à la main) lisent
 * normalement.
 * Tout `loadfile` vers une adresse qui n'est pas celle d'un faux fournisseur local est refusé, sur
 * Windows comme sur Android. Aucun moyen de le lever. Une adresse
 * admise n'est pas lue non plus : le lecteur simulé (dev/lecteurSimule.ts, branché sur la prise
 * `bancLecteur` de services/outilsTest.ts) remplace mpv, sans aucune
 * requête vers le flux. Seule exception, la variante « vrai lecteur » du banc (VITE_BANC_LECTEUR=reel) :
 * le même verrou, puis mpv lit l'adresse admise (les vidéos de test du faux fournisseur local).
 * Dans une version normale, la condition vaut false à la compilation : verrou et lecteur simulé
 * disparaissent. Dans une version du banc dont la prise est restée vide, tout est refusé.
 */

import * as mpv from 'tauri-plugin-mpv-api';
import type { MpvEvent, MpvPropertyEventFor, MpvPropertyValue, VideoMarginRatio } from 'tauri-plugin-mpv-api';
import { invoke } from '@tauri-apps/api/core';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { isAndroid } from '../../utils/platform';
import * as android from './androidPlayer';
import { cancelForcedUnpause } from './forcedUnpause';
import { prises, VERSION_BANC, type LecteurSimule, type PriseBancLecteur } from '../outilsTest';

/** Version du banc : évalué à la compilation (services/outilsTest.ts). */
const VERROU_BANC = VERSION_BANC;
/**
 * Lecteur simulé : toute version du banc, sauf la variante « vrai lecteur » (VITE_BANC_LECTEUR=reel,
 * zone 6 bis). Celle-ci garde le verrou (seule l'adresse d'un faux fournisseur local passe) mais
 * laisse mpv (Windows) ou libmpv (Android) lire cette adresse : les vidéos de test du banc, fabriquées
 * par lui, jamais un vrai flux.
 */
const LECTEUR_SIMULE = VERROU_BANC && import.meta.env.VITE_BANC_LECTEUR !== 'reel';

/** Version du banc dont les outils de test ne sont pas branchés : rien ne doit lire. */
function outilsNonBranches(): Error {
  return new Error('[BANC] outils de test non branchés : lecteur refusé');
}

/**
 * Verrou du banc (branché par src/dev/prisesBanc.ts) : l'adresse n'est jamais écrite (ni console, ni erreur), seule sa
 * nature est notée, pour le pont d'audit. Prise vide : un verrou qui refuse tout.
 */
function verrou(): Pick<PriseBancLecteur, 'verrouLecture' | 'refuser'> {
  return prises.bancLecteur ?? { verrouLecture: outilsNonBranches, refuser: outilsNonBranches };
}

/** Lecteur simulé du banc ; prise vide : chaque appel est refusé. */
function simule(): LecteurSimule {
  const branche = prises.bancLecteur?.simule;
  if (branche) return branche;
  const refus = () => Promise.reject(outilsNonBranches());
  return { commande: refus, ecrire: refus, lire: refus, observer: refus, ecouterEvenements: refus };
}

/** Lancement de mpv.exe : le chemin du programme est fixé côté Rust (ressource `mpv/mpv.exe`). */
export interface MpvConfig {
  /** Options en liste blanche côté Rust (`--vo=…`, `--hwdec=…`…) */
  args: string[];
  observedProperties: readonly string[];
  ipcTimeoutMs: number;
}

export function init(config?: MpvConfig): Promise<string> {
  if (LECTEUR_SIMULE) return Promise.resolve('banc');
  if (isAndroid()) return android.init();
  if (!config) return Promise.reject(new Error('mpv config required'));
  return invoke<string>('nyx_mpv_init', {
    args: config.args,
    observedProperties: config.observedProperties,
    ipcTimeoutMs: config.ipcTimeoutMs,
  });
}

/** Commande mpv desktop, vérifiée par la garde Rust ; renvoie la donnée de la réponse. */
function desktopCommand(name: string, args: unknown[] = []): Promise<unknown> {
  return invoke<unknown>('nyx_mpv_command', { name, args });
}

export function command(name: string, args?: unknown[]): Promise<unknown> {
  if (VERROU_BANC && (name === 'loadfile' || name === 'loadlist')) {
    // loadlist et les options de fichier de loadfile (3e argument et suivants) ne servent pas dans
    // l'app : refusés dans le banc, pour qu'un ajout futur ne passe jamais sous le verrou.
    const refus = name === 'loadlist' || (args?.length ?? 0) > 2 ? verrou().refuser() : verrou().verrouLecture(args);
    if (refus) return Promise.reject(refus);
  }
  // Pause basculée par l'utilisateur : la reprise automatique d'après chargement ne doit pas l'annuler
  if (name === 'cycle' && args?.[0] === 'pause') cancelForcedUnpause();
  if (LECTEUR_SIMULE) {
    // Android : le lancement met l'app en paysage plein écran par le plugin natif (usePlaybackSession),
    // et seul le « stop » natif l'en sort. Le lecteur simulé ne l'envoyait pas : l'app du banc restait
    // en paysage après le lecteur (téléphone réel). Sortie du plein écran seule, aucun moteur touché.
    if (name === 'stop' && isAndroid()) {
      android.setFullscreen(false).catch((e) => console.warn('[BANC] sortie du plein écran impossible :', e));
    }
    return simule().commande(name, args);
  }
  return isAndroid() ? android.command(name, args) : desktopCommand(name, args);
}

export function setProperty<T = never, K extends string = string>(
  name: K,
  value: [T] extends [never] ? MpvPropertyValue<K> : T,
): Promise<void> {
  // Banc : aucune propriété qui ouvrirait une adresse sans passer par loadfile
  if (VERROU_BANC && /^(stream-open-filename|path|playlist)/.test(name)) {
    return Promise.reject(verrou().refuser());
  }
  if (name === 'pause') cancelForcedUnpause();
  if (LECTEUR_SIMULE) return simule().ecrire(name, value);
  if (isAndroid()) return android.setProperty(name, value);
  return desktopCommand('set_property', [name, value]).then(() => undefined);
}

export function getProperty<T = never, K extends string = string>(
  name: K,
): Promise<[T] extends [never] ? MpvPropertyValue<K> : T> {
  if (LECTEUR_SIMULE) return simule().lire(name) as Promise<[T] extends [never] ? MpvPropertyValue<K> : T>;
  if (isAndroid()) {
    return android.getProperty(name) as Promise<[T] extends [never] ? MpvPropertyValue<K> : T>;
  }
  return desktopCommand('get_property', [name]) as Promise<[T] extends [never] ? MpvPropertyValue<K> : T>;
}

export function observeProperties<T extends ReadonlyArray<string>>(
  properties: T,
  callback: (event: MpvPropertyEventFor<T[number]>) => void,
): Promise<UnlistenFn> {
  if (LECTEUR_SIMULE) return simule().observer(properties, callback as (event: { name: string; data: unknown }) => void);
  if (isAndroid()) {
    return android.observeProperties(properties, callback as (event: { name: string; data: unknown }) => void);
  }
  return mpv.observeProperties(properties, callback);
}

/**
 * mpv.exe tourne-t-il encore ? (desktop : état du processus lu côté Rust, sans passer par mpv).
 * Android : libmpv vit dans le processus de l'app, un plantage emporte l'app entière ; toujours vrai.
 */
export function isEngineAlive(): Promise<boolean> {
  if (LECTEUR_SIMULE) return Promise.resolve(true);
  if (isAndroid()) return Promise.resolve(true);
  return invoke<boolean>('nyx_mpv_alive');
}

/**
 * mpv.exe peut-il vérifier un flux HTTPS ? Faux seulement si l'export des certificats du système a
 * échoué (Rust, `mpv_tls.rs`) : le flux est alors refusé par mpv. Android : libmpv signale
 * lui-même ce cas (`TLS_CA_UNAVAILABLE`) ; toujours vrai.
 */
export function isHttpsVerifiable(): Promise<boolean> {
  if (LECTEUR_SIMULE) return Promise.resolve(true);
  if (isAndroid()) return Promise.resolve(true);
  return invoke<boolean>('nyx_mpv_tls_ready');
}

/** Événements bruts mpv (desktop). Android remonte ses erreurs via le plugin natif (androidPlayer). */
export function listenDesktopEvents(callback: (event: MpvEvent) => void): Promise<UnlistenFn> {
  if (LECTEUR_SIMULE) return isAndroid() ? Promise.resolve(() => {}) : simule().ecouterEvenements(callback as unknown as Parameters<LecteurSimule['ecouterEvenements']>[0]);
  if (isAndroid()) return Promise.resolve(() => {});
  return mpv.listenEvents(callback);
}

/** Chaîne suivante / précédente demandée par l'Assistant ou un casque (Android seulement). */
export function listenMediaCommands(callback: (command: android.MediaCommand) => void): Promise<UnlistenFn> {
  if (!isAndroid()) return Promise.resolve(() => {});
  return android.listenMediaCommands(callback);
}

export function setVideoMarginRatio(ratio: VideoMarginRatio): Promise<void> {
  if (LECTEUR_SIMULE) return Promise.resolve();
  if (isAndroid()) return android.setVideoMarginRatio(ratio);
  return invoke<void>('nyx_mpv_set_margins', {
    left: ratio.left ?? null,
    right: ratio.right ?? null,
    top: ratio.top ?? null,
    bottom: ratio.bottom ?? null,
  });
}
