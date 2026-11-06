/**
 * Time Helpers — Utilitaires de temps pour le cache.
 *
 * Extraits de tmdbCacheSqlite.ts et xtreamSeriesCache.ts
 * pour éliminer la duplication.
 */

/** Get current Unix timestamp in seconds */
export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Check if a cache entry is still valid based on TTL */
export function isCacheValid(cachedAt: number, ttlSeconds: number): boolean {
  return (cachedAt + ttlSeconds) > nowSeconds();
}

/**
 * Temps écoulé en clair, dans la langue de l'interface : « il y a 3 heures », « il y a 3 jours »…
 * (Paramètres, « Dernière actualisation »). Minutes sous une heure, heures sous deux jours, jours
 * au-delà.
 */
export function formatTimeAgo(pastMs: number, nowMs: number, language: string): string {
  const rtf = new Intl.RelativeTimeFormat(language, { numeric: 'auto' });
  const minutes = Math.max(0, Math.round((nowMs - pastMs) / 60_000));
  // « maintenant » plutôt que « cette minute-ci »
  if (minutes < 1) return rtf.format(0, 'second');
  if (minutes < 60) return rtf.format(-minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (hours < 48) return rtf.format(-hours, 'hour');
  return rtf.format(-Math.round(hours / 24), 'day');
}

/**
 * Heure locale « HH:MM » sur 24 h, quelle que soit la langue de l'appareil : guide TV, grille des
 * chaînes et bandeau du lecteur affichent la même heure (un appareil anglais passait
 * la grille en 12 h).
 */
export function formatClock(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 75 -> "1:15", 3725 -> "1:02:05" (where the viewer stopped, for Resume buttons) */
export function formatResumeTime(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}
