/**
 * useBackHandler.ts — Bouton retour Android (et tout "retour" matériel).
 *
 * Pile de handlers : l'élément ouvert le plus récemment (menu, switcher, modal)
 * est fermé en premier, puis le player, puis la navigation (App).
 * Un handler qui retourne `false` passe la main au suivant.
 */

import { useEffect, useRef } from 'react';
import { onBackButtonPress } from '@tauri-apps/api/app';
import { exit } from '@tauri-apps/plugin-process';
import { isAndroid } from '../utils/platform';
import { createLogger } from '../utils/logger';
import { noteExitRequested } from '../services/androidExitReport';

const log = createLogger('BackButton');

type BackHandler = () => boolean | void;

const stack: Array<{ current: BackHandler }> = [];

/**
 * Dernier recours quand plus rien n'est à fermer (Android TV : focus sur la barre latérale).
 * Retourne false pour laisser le retour suivre son cours (sortie de l'app).
 */
let rootFallback: (() => boolean) | null = null;

/** Exécute le handler le plus haut dans la pile. Retourne false si rien ne l'a consommé. */
export function dispatchBack(): boolean {
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i].current() !== false) return true;
  }
  return rootFallback?.() ?? false;
}

/** Installe le dernier recours de `dispatchBack`. Retourne la fonction de retrait. */
export function setRootBackFallback(fallback: () => boolean): () => void {
  rootFallback = fallback;
  return () => {
    if (rootFallback === fallback) rootFallback = null;
  };
}

/**
 * Version hors composant de `useBackHandler`, pour un état ouvert en dehors de React
 * (défilement d'une zone à la télécommande). Retourne la fonction de retrait.
 */
export function pushBackHandler(handler: BackHandler): () => void {
  const entry = { current: handler };
  stack.push(entry);
  return () => {
    const index = stack.lastIndexOf(entry);
    if (index >= 0) stack.splice(index, 1);
  };
}

export function useBackHandler(active: boolean, handler: BackHandler): void {
  const ref = useRef<BackHandler>(handler);

  useEffect(() => {
    ref.current = handler;
  }, [handler]);

  useEffect(() => {
    if (!active) return;
    const entry = ref;
    stack.push(entry);
    return () => {
      const index = stack.lastIndexOf(entry);
      if (index >= 0) stack.splice(index, 1);
    };
  }, [active]);
}

/** À monter une seule fois (App) : relie le bouton retour Android à la pile. */
export function useAndroidBackButton(): void {
  useEffect(() => {
    if (!isAndroid()) return;
    let disposed = false;
    let unregister: (() => void) | undefined;

    onBackButtonPress(() => {
      if (!dispatchBack()) {
        // Sortie voulue : si elle finit en plantage (exit() de Tauri sous Android), ce n'est pas une panne
        void noteExitRequested().catch(() => undefined).then(() => exit(0));
      }
    })
      .then((listener) => {
        if (disposed) void listener.unregister();
        else unregister = () => void listener.unregister();
      })
      .catch((e) => log.warn('listener registration failed:', e));

    return () => {
      disposed = true;
      unregister?.();
    };
  }, []);
}
