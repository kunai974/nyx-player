/**
 * Capteurs du test de mesure intégré (audit performance) — **version de mesure uniquement**
 * (`VITE_PERF=1`, compilation de mesure Android ou Windows). Absent de
 * toute version publiée : `PERF_ENABLED` vaut false à la compilation et le code disparaît du bundle.
 *
 * Doit être importé avant React (main.tsx) : le crochet des outils de développement de React n'est
 * lu qu'au chargement de react-dom. Ne change pas le comportement de Nyx ; note seulement :
 * - tâches longues (plus de 50 ms : l'app ne répond plus) ;
 * - mises à jour de l'écran par React (commits) ;
 * - appels au cœur natif (Rust : base locale, fichiers…), nombre et durée, par commande ;
 * - et fige le hasard (photo de fond des fiches) pour que chaque passage affiche la même chose.
 */

import { VERSION_MESURE } from '../services/outilsTest';

export const PERF_ENABLED = VERSION_MESURE;

export interface PerfCounters {
  longTasks: { start: number; duration: number }[];
  commits: number;
  ipcCount: number;
  ipcMs: number;
}

declare global {
  interface Window {
    __nyxPerfCounters?: PerfCounters;
  }
}

if (PERF_ENABLED && typeof window !== 'undefined' && !window.__nyxPerfCounters) {
  const counters: PerfCounters = { longTasks: [], commits: 0, ipcCount: 0, ipcMs: 0 };
  window.__nyxPerfCounters = counters;

  let seed = 0x2f6b1d3a;
  Math.random = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 4294967296;
  };

  (window as unknown as Record<string, unknown>).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    isDisabled: false,
    renderers: new Map(),
    inject(this: { renderers: Map<number, unknown> }, renderer: unknown) {
      const id = this.renderers.size + 1;
      this.renderers.set(id, renderer);
      return id;
    },
    onCommitFiberRoot() { counters.commits += 1; },
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    checkDCE() {},
  };

  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) counters.longTasks.push({ start: e.startTime, duration: e.duration });
    }).observe({ type: 'longtask', buffered: true });
  } catch {
    // Moteur sans tâches longues : la colonne restera vide dans les résultats
  }

  // Appels au cœur natif, observés sans rien modifier : sous Windows, ils passent par des requêtes vers
  // ipc.localhost, que le navigateur note comme les autres. Sur Android, Tauri utilise postMessage :
  // pas de compte possible (colonne « — » dans les résultats). (L'objet de Tauri est verrouillé : le
  // remplacer faisait planter le démarrage.)
  try {
    performance.setResourceTimingBufferSize(20000);
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (!/^(https?:\/\/ipc\.localhost|ipc:)/.test(e.name)) continue;
        counters.ipcCount += 1;
        counters.ipcMs += e.duration;
      }
    }).observe({ type: 'resource', buffered: true });
  } catch {
    // Moteur sans observation des requêtes : la colonne restera vide dans les résultats
  }
}
