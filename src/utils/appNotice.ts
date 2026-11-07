/**
 * Message bref affiché quelques secondes en bas de l'écran, sur toutes les plateformes
 * (composant `components/Common/AppNotice.tsx`, monté une fois dans main.tsx).
 *
 * Le message est une clé de traduction de `common` : il suit la langue de l'app.
 */

/** Messages possibles : clés de common.json (fr et en) */
export type AppNoticeKey =
  | 'watchlist_update_failed'
  | 'progress_reset_failed'
  | 'tvlink_connected_account'
  | 'tvlink_connected_account_provider'
  | 'tvlink_connected_provider';

/** Message, valeurs à insérer dans le texte, et durée d'affichage propre au message */
export interface AppNoticeDetail {
  key: AppNoticeKey;
  values?: Record<string, string>;
  ms?: number;
}

export const APP_NOTICE_EVENT = 'nyx:app-notice';

/** Durée d'affichage d'un message */
export const APP_NOTICE_MS = 4000;

export function showAppNotice(messageKey: AppNoticeKey, options: { values?: Record<string, string>; ms?: number } = {}): void {
  // Message simple : la clé seule (forme d'origine de l'événement) ; avec valeurs ou durée : le détail
  const detail: AppNoticeKey | AppNoticeDetail = options.values || options.ms ? { key: messageKey, ...options } : messageKey;
  window.dispatchEvent(new CustomEvent(APP_NOTICE_EVENT, { detail }));
}
