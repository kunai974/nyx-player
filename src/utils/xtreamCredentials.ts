/**
 * Identifiants Xtream dans les adresses : un mot de passe contenant & # + ? / % ou une
 * espace cassait la connexion ou la lecture.
 */

/**
 * Identifiant placé dans le chemin d'un flux (`/live/USER/PASS/123.ts`). Seuls les caractères qui
 * cassent l'adresse sont encodés : un identifiant ordinaire donne exactement la même adresse
 * qu'avant (les adresses de flux déjà enregistrées restent valables).
 */
export function encodeXtreamPathSegment(value: string): string {
  return value.replace(/[%/?#\s]/g, (c) => encodeURIComponent(c));
}

/**
 * Valeur d'un paramètre d'un lien M3U (`get.php?username=…&password=…`) collé par l'utilisateur.
 * Les séquences %XX sont décodées, mais un « + » reste un « + » : `URLSearchParams` le changeait en
 * espace, ce qui cassait un mot de passe comme « ab+cd ».
 */
export function readM3uParam(url: URL, name: string): string {
  const query = url.search.startsWith('?') ? url.search.slice(1) : url.search;
  for (const pair of query.split('&')) {
    const eq = pair.indexOf('=');
    const key = eq === -1 ? pair : pair.slice(0, eq);
    if (key !== name) continue;
    const raw = eq === -1 ? '' : pair.slice(eq + 1);
    try {
      return decodeURIComponent(raw);
    } catch {
      // Séquence % invalide (« 100%sur ») : la valeur telle quelle
      return raw;
    }
  }
  return '';
}

/**
 * Extension d'un flux (`container_extension` du fournisseur, ou d'une position reçue du cloud),
 * collée à la fin du chemin (`…/123.mkv`). Seule une extension ordinaire (lettres et chiffres,
 * 8 caractères au plus, comme `mpegts`) est gardée, sans son éventuel point initial (`.mkv` → `mkv`) :
 * une valeur comme `mkv/../x` ou `ts?a=b` changerait l'adresse demandée au fournisseur et casserait
 * la lecture. `undefined` sinon (extension par défaut).
 */
export function safeContainerExtension(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return /^\.?([a-z0-9]{1,8})$/i.exec(value)?.[1];
}

/** Fichiers de l'API Xtream qu'un utilisateur colle parfois à la fin de l'adresse du serveur */
const XTREAM_ENDPOINT_FILE = /\/(?:player_api|get|xmltv|panel_api)\.php$/i;

/**
 * Adresse saisie dans le champ « serveur » d'une connexion Xtream. Une adresse complète copiée du
 * courriel du fournisseur (`http://x:8080/player_api.php?username=…&password=…`, ou un lien `get.php`)
 * faisait demander `…/player_api.php/player_api.php` : la connexion échouait. Le fichier de l'API,
 * les paramètres et l'ancre sont retirés de l'adresse ; l'identifiant et le mot de passe trouvés dans
 * les paramètres sont rendus (vides sinon), pour remplir les champs laissés vides. Une adresse
 * ordinaire (`http://x:8080`, `http://x/iptv/`) est rendue telle quelle.
 */
export function splitPastedXtreamAddress(input: string): { host: string; username: string; password: string } {
  const trimmed = input.trim();
  const fileMatch = /^(.*?\/(?:player_api|get|xmltv|panel_api)\.php)(?:[?#].*)?$/i.exec(trimmed);
  if (!fileMatch) return { host: input, username: '', password: '' };
  let username = '';
  let password = '';
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    const url = new URL(withScheme);
    username = readM3uParam(url, 'username');
    password = readM3uParam(url, 'password');
  } catch {
    // Adresse illisible : seul le fichier de l'API est retiré
  }
  return { host: fileMatch[1].replace(XTREAM_ENDPOINT_FILE, ''), username, password };
}
