/**
 * sanitizeUrl.ts — Masquage des credentials IPTV dans les URLs
 *
 * Couvre les formats Xtream Codes :
 * - Stream    : http://host/{live|movie|series|timeshift|hls|play}/USER/PASS/123.ext
 * - Court     : http://host:port/USER/PASS/123 (redirections de fournisseurs, port explicite)
 * - Court sans port : http://host/USER/PASS/123, seul dans son adresse (une adresse d'API
 *               versionnée comme `/3/movie/550` reste lisible : premier segment d'un seul chiffre ;
 *               limites connues : un identifiant d'un seul chiffre, un double encodage `%253D`)
 * - API       : http://host/player_api.php?username=X&password=Y, et les jetons d'une adresse tierce
 *               (guide EPG, flux HLS) : `token`, `key`, `apikey`, `auth`, `pass`, `pwd`,
 *               `signature`
 * - API encodée : …%3Fusername%3DX%26password%3DY (adresse placée dans une autre adresse)
 * - Stream encodé : …%2Flive%2FUSER%2FPASS%2F123.ts (même cas)
 *               (limites connues : la forme courte encodée `%3A8080%2FUSER%2FPASS%2F123`, un
 *               double encodage `%252F`)
 * - Userinfo  : http://USER:PASS@host/... et http://USER@host/... (sans mot de passe)
 * - JSON      : "username":"X", "password":"Y" (réponse player_api journalisée)
 * Toutes les occurrences d'un message sont masquées, pas seulement la première, et le chemin des
 * flux se reconnaît quelle que soit sa casse (`/LIVE/`), y compris la forme
 * courte sans port, en majuscules ou avec des paramètres encodés.
 * Miroir Rust : `sanitize_url_for_log()` dans src-tauri/src/storage.rs.
 *
 * Usage :
 *   import { sanitizeIptvUrl } from '../utils/sanitizeUrl';
 *   console.info('[MPV] loadfile →', sanitizeIptvUrl(url));
 */

/**
 * Masque les credentials IPTV dans une URL Xtream (ou un message qui en contient).
 * Retourne le texte tel quel s'il ne correspond à aucun pattern connu.
 */
export function sanitizeIptvUrl(url: string): string {
  return url
    .replace(/\/(live|movie|series|timeshift|hls|play)\/[^/\s]+\/[^/\s]+\//gi, '/$1/***/***/')
    // Même chemin encodé (`%2F` = « / ») : adresse de flux placée dans une autre adresse
    .replace(/(%2F(?:live|movie|series|timeshift|hls|play)%2F)(?:[^%/\s&]|%(?:[013-9A-F][0-9A-F]|2[0-9A-E]))+%2F(?:[^%/\s&]|%(?:[013-9A-F][0-9A-F]|2[0-9A-E]))+%2F/gi, '$1***%2F***%2F')
    .replace(/(:\/\/[^/\s:@]+:\d+)\/[^/\s?#]+\/[^/\s?#]+\/(\d+(?:\.[A-Za-z0-9]{1,8})?)\b/g, '$1/***/***/$2')
    .replace(/(:\/\/[^/\s:@]+)\/(?:[^/\s?#\d][^/\s?#]*|\d[^/\s?#]+)\/[^/\s?#]+\/(\d+(?:\.[A-Za-z0-9]{1,8})?)(\.?(?:$|[^A-Za-z0-9_.~%/-])|\/(?:$|\s))/g, '$1/***/***/$2$3')
    .replace(/(:\/\/)[^/\s:@]+:[^/\s@]+@/g, '$1***:***@')
    .replace(/(:\/\/)[^/\s:@]+@/g, '$1***@')
    .replace(/([?&])(username|password|token|key|apikey|auth|pass|pwd|signature)=[^&\s"'#]*/gi, '$1$2=***')
    // Valeur encodée : tout jusqu'au `%26` (« & ») suivant, les autres caractères encodés compris
    .replace(/(%3F|%26|^|[^A-Za-z0-9_%])((?:username|password|token|key|apikey|auth|pass|pwd|signature)%3D)(?:[^&\s"'#%]|%(?:[013-9A-F][0-9A-F]|2[0-57-9A-F]))*/gi, '$1$2***')
    .replace(/("(?:username|password)"\s*:\s*")(?:[^"\\]|\\.)*"/gi, '$1***"');
}

/**
 * Adresse de flux réduite pour les journaux : protocole, hôte, type Xtream (`live`, `movie`…) et
 * dernier élément s'il n'est qu'un numéro ou une extension. Le reste du chemin et les paramètres
 * sont retirés : une adresse de liste M3U peut cacher un secret n'importe où, sous une forme que
 * `sanitizeIptvUrl` ne connaît pas.
 */
export function describeStreamForLog(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return '(adresse illisible)';
  }
  const segments = parsed.pathname.split('/').filter(Boolean);
  const kind = /^(live|movie|series|timeshift|hls|play)$/i.test(segments[0] ?? '') ? `${segments[0]}/` : '';
  const last = segments[segments.length - 1] ?? '';
  const tail = /^\d+(\.[A-Za-z0-9]{1,8})?$/.test(last) ? last : (/\.[A-Za-z0-9]{1,8}$/.exec(last)?.[0] ?? '');
  return `${parsed.protocol}//${parsed.host}/${kind}…/${tail}`;
}
