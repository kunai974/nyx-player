/**
 * androidExitReport.ts — Raison de la dernière fermeture anormale de l'app Android, envoyée à Sentry
 * au lancement suivant.
 *
 * Un plantage du lecteur (libmpv, décodeur), le moteur de la page tué par Android ou une app figée
 * ferment l'app sans laisser à la page le temps de prévenir Sentry. Android retient la raison :
 * le plugin natif la relit au lancement suivant, une seule fois (ExitReports.kt), avec ce que
 * faisait le lecteur à ce moment (direct ou film, extension, codec, décodeur). Rien n'y contient
 * d'adresse ni d'identifiant ; le nettoyage commun de Sentry (utils/sentryScrub.ts) passe en plus.
 *
 * Cas d'origine : sur un boîtier Google TV, l'app se fermait à l'ouverture d'un flux
 * sans aucune trace.
 */

import { invoke } from '@tauri-apps/api/core';
import * as Sentry from '@sentry/react';
import { isAndroid } from '../utils/platform';
import { createLogger } from '../utils/logger';

const log = createLogger('ExitReport');

export interface ExitPlayerState {
  /** live, movie, series ou stream */
  kind: string;
  extension: string;
  /** opening : flux en cours d'ouverture ; playing : en lecture */
  phase: string;
  codec: string | null;
  hwdec: string | null;
}

export interface ExitReport {
  /** crash_native, crash, anr, low_memory, signaled… (ExitReportPolicy.reasonName) */
  reason: string;
  /** Signal ou code de sortie */
  status: number;
  /** L'app était à l'écran */
  foreground: boolean;
  timestamp: number;
  description: string | null;
  pssKb: number;
  rssKb: number;
  television: boolean;
  player: ExitPlayerState | null;
}

/** Titre de l'événement : un groupe Sentry par raison et par moment de la lecture. */
export function exitReportTitle(report: ExitReport): string {
  const moment = report.player
    ? `${report.player.phase === 'opening' ? 'ouverture' : 'lecture'} ${report.player.kind}`
    : 'hors lecture';
  return `Fermeture anormale Android : ${report.reason} (${moment})`;
}

/** Envoie le rapport à Sentry. Exporté pour les tests. */
export function sendExitReport(report: ExitReport): void {
  const player = report.player;
  Sentry.captureMessage(exitReportTitle(report), {
    level: 'error',
    fingerprint: ['android-exit', report.reason, player?.phase ?? 'none', player?.kind ?? 'none'],
    tags: {
      exit_reason: report.reason,
      exit_foreground: String(report.foreground),
      device_tv: String(report.television),
      player_phase: player?.phase ?? 'none',
      player_kind: player?.kind ?? 'none',
      player_extension: player?.extension ?? 'none',
      player_codec: player?.codec ?? 'none',
      player_hwdec: player?.hwdec ?? 'none',
    },
    contexts: {
      android_exit: {
        reason: report.reason,
        status: report.status,
        foreground: report.foreground,
        description: report.description,
        pss_kb: report.pssKb,
        rss_kb: report.rssKb,
        exited_at: new Date(report.timestamp).toISOString(),
      },
    },
  });
}

/**
 * Retour à la racine, juste avant `exit(0)` : la fermeture qui suit n'est pas signalée comme une panne
 * (l'`exit()` de Tauri peut finir en SIGABRT sous Android, voir appRestart.ts). Jamais levé.
 */
export async function noteExitRequested(): Promise<void> {
  if (!isAndroid()) return;
  try {
    await invoke('plugin:nyx-android|note_exit_requested');
  } catch (e) {
    log.warn('Exit note unavailable:', e);
  }
}

/**
 * Au lancement, Android seulement : lit la dernière fermeture anormale (rendue une seule fois par le
 * plugin) et l'envoie. Appelé seulement quand Sentry est actif (main.tsx) : sinon le rapport serait
 * consommé sans être envoyé. Jamais bloquant ni levé : un échec ici ne doit rien changer au démarrage.
 */
export async function reportLastAbnormalExit(): Promise<void> {
  if (!isAndroid()) return;
  try {
    const result = await invoke<{ report: ExitReport | null }>('plugin:nyx-android|last_exit_report');
    const report = result?.report;
    if (!report) return;
    log.warn(exitReportTitle(report));
    sendExitReport(report);
  } catch (e) {
    log.warn('Last exit report unavailable:', e);
  }
}
