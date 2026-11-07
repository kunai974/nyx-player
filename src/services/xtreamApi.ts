/**
 * Xtream Codes API Service
 *
 * Client pour l'API Xtream Codes (IPTV providers).
 *
 * ANTI-HALLUCINATION:
 * ⚠️ Créer une NOUVELLE instance à chaque utilisation: `new XtreamApiService(creds)`.
 * ⚠️ Les credentials viennent de StorageService.getCredentials().
 * ⚠️ getVodStreams/getSeries normalisent AUTOMATIQUEMENT les TMDB IDs (via normalizeTmdbId).
 * ⚠️ getSeriesInfo() retourne épisodes + info Xtream, PAS les détails TMDB.
 * ⚠️ Les URLs de stream sont construites par getStreamUrl() - ne pas hardcoder.
 */

import type { XtreamCredentials, IptvCategory, IptvStream, IptvSeries } from '../types/iptv';
import type { XtreamAuthResponse, XtreamSeriesInfo, XtreamUserInfo, XtreamVodInfo } from '../types/xtream';
import { iptvFetch, iptvFetchPublic, isProviderHttpServerError } from './networkService';
import { normalizeTmdbId } from '../utils/normalizeTmdb';
import { sanitizeIptvUrl } from '../utils/sanitizeUrl';
import { encodeXtreamPathSegment, safeContainerExtension } from '../utils/xtreamCredentials';
import { getCachedXtreamSeries, setCachedXtreamSeries } from './xtreamSeriesCache';
import { createLogger } from '../utils/logger';
import { normalizeSeriesInfo } from '../utils/seriesInfoNormalize';

const log = createLogger('XtreamApi');
const streamUrlLog = createLogger('XtreamApi.getStreamUrl');

/** Au moins un épisode dans la réponse `get_series_info` */
function hasEpisodes(info: XtreamSeriesInfo): boolean {
  const episodes = info.episodes;
  if (!episodes || typeof episodes !== 'object') return false;
  return Object.values(episodes).some((season) => Array.isArray(season) && season.length > 0);
}

/** Message de l'erreur levée quand le fournisseur refuse l'identifiant ou le mot de passe. */
const CREDENTIALS_REJECTED = 'Authentication failed';

/**
 * Vrai si l'erreur dit que le fournisseur a refusé l'identifiant ou le mot de passe (`authenticate`),
 * y compris un refus rendu par une erreur 5xx : Réglages > Sources le dit clairement.
 */
export function isCredentialsRejectedError(error: unknown): boolean {
  return error instanceof Error && error.message === CREDENTIALS_REJECTED;
}

/**
 * Le fournisseur répond par une page web (maintenance, protection Cloudflare) au lieu des
 * informations du compte. On ne peut pas savoir si les identifiants sont bons : certains panneaux
 * refusent aussi un mauvais mot de passe par une page HTML. Le message dit les deux, au lieu de
 * « vérifiez vos identifiants » seul. Un corps vide reste un refus des identifiants (réponse
 * habituelle d'un panneau à un mauvais mot de passe).
 */
const PROVIDER_HTML_RESPONSE = 'provider_html_response';

export function isProviderHtmlResponseError(error: unknown): boolean {
  return error instanceof Error && error.message === PROVIDER_HTML_RESPONSE;
}

/**
 * Le fournisseur dit que l'abonnement est expiré, suspendu ou désactivé (`user_info.status`).
 * Avant, la connexion passait puis rien ne se lisait, sans explication. Seuls ces états écrits en
 * toutes lettres comptent : la date d'expiration seule ne suffit pas (certains panneaux la laissent
 * dans le passé pour un abonnement illimité).
 */
const PROVIDER_ACCOUNT_INACTIVE = 'provider_account_inactive';
const INACTIVE_ACCOUNT_STATUSES = new Set(['expired', 'banned', 'disabled']);

export function isProviderAccountInactiveError(error: unknown): boolean {
  return error instanceof Error && error.message === PROVIDER_ACCOUNT_INACTIVE;
}

/** Infos du compte jointes à l'erreur « abonnement expiré ou suspendu », sinon `undefined`. */
export function inactiveAccountInfo(error: unknown): Partial<XtreamUserInfo> | undefined {
  if (!isProviderAccountInactiveError(error)) return undefined;
  return (error as Error & { userInfo?: Partial<XtreamUserInfo> }).userInfo;
}

/** Vrai si la réponse est une page web plutôt que du JSON */
function looksLikeHtml(text: string): boolean {
  return /^\s*</.test(text);
}

/**
 * JSON précédé d'avertissements PHP (vieux panneaux : `<br /><b>Deprecated</b>: … <br />{"user_info":…}`),
 * sinon `null`. Une vraie page web (Cloudflare, maintenance) n'est jamais lue comme une réponse : son
 * début contient `<html`, `<body` ou `<!doctype`, et ce qui suit doit être un JSON complet.
 */
/** Longueur maximale des avertissements cherchés avant le JSON (même borne que le code natif) */
const MAX_PHP_NOTICE_CHARS = 64 * 1024;

function jsonAfterPhpNotice(text: string): unknown {
  const start = text.slice(0, MAX_PHP_NOTICE_CHARS).search(/[[{]\s*["{[\]}]/);
  if (start <= 0) return null;
  if (/<\s*(?:!doctype|html|head|body|script|style)\b/i.test(text.slice(0, start))) return null;
  try {
    return JSON.parse(text.slice(start)) as unknown;
  } catch {
    return null;
  }
}

/**
 * Liste du fournisseur : un tableau, ou un objet à clés numériques (`{"0":{…},"7":{…}}`, forme que
 * PHP écrit quand des éléments ont été retirés), lu comme la même liste. Autre chose : liste vide.
 * Même règle que le code natif (`catalog_parser.rs`), sauf l'ordre : JavaScript range les clés
 * numériques par ordre croissant, le natif garde l'ordre reçu.
 */
function listFromResponse(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    const entries = Object.entries(data);
    if (entries.every(([key]) => /^\d+$/.test(key))) return entries.map(([, value]) => value);
  }
  return [];
}

/**
 * Format du direct à demander d'après `user_info.allowed_output_formats` : `m3u8` quand le
 * fournisseur n'autorise que le HLS (il refuse alors `…/123.ts`, la chaîne ne se lançait pas),
 * sinon rien (format habituel `ts`). Liste absente, vide ou illisible : rien, comme avant.
 */
export function liveExtensionFor(allowed: unknown): 'm3u8' | undefined {
  if (!Array.isArray(allowed)) return undefined;
  const formats = allowed.filter((f): f is string => typeof f === 'string').map((f) => f.trim().toLowerCase());
  return !formats.includes('ts') && formats.includes('m3u8') ? 'm3u8' : undefined;
}

/** Format du direct retenu pour chaque compte (serveur + identifiant), noté à l'authentification. */
const liveExtensions = new Map<string, 'm3u8' | undefined>();

export class XtreamApiService {
  private host: string;
  private username: string;
  private password: string;
  private fetchText: (url: string) => Promise<string>;

  /**
   * `publicOnly` : serveur reçu d'un autre appareil (QR code), joint seulement à une adresse
   * publique, redirections comprises, pour que la TV ne serve pas à sonder le réseau de la maison.
   */
  constructor(creds: XtreamCredentials, options: { publicOnly?: boolean } = {}) {
    this.host = creds.host.endsWith('/') ? creds.host.slice(0, -1) : creds.host;
    this.username = creds.username;
    this.password = creds.password;
    this.fetchText = options.publicOnly ? iptvFetchPublic : iptvFetch;
  }

  private getBaseUrl(): string {
    return `${this.host}/player_api.php?username=${encodeURIComponent(this.username)}&password=${encodeURIComponent(this.password)}`;
  }

  private get accountKey(): string {
    return `${this.host}\n${this.username}`;
  }

  /** Extension du direct pour ce compte (`m3u8` si le fournisseur n'autorise que le HLS), sinon rien. */
  preferredLiveExtension(): 'm3u8' | undefined {
    return liveExtensions.get(this.accountKey);
  }

  getStreamUrl(type: 'live' | 'movie' | 'series', id: string | number, extension?: string): string {
    // ⚠️ Log quand le fallback extension est déclenché pour VOD
    if (!extension && type !== 'live' && import.meta.env.DEV) {
      streamUrlLog.warn(`No extension for ${type}/${id} — defaulting to mp4`);
    }
    const ext = safeContainerExtension(extension) ?? (type === 'live' ? 'ts' : 'mp4');
    return `${this.host}/${type}/${encodeXtreamPathSegment(this.username)}/${encodeXtreamPathSegment(this.password)}/${id}.${ext}`;
  }

  /**
   * Masque les identifiants dans un texte à journaliser : formes Xtream connues, puis valeurs
   * exactes de ce compte (couvre les réponses où elles apparaissent sous une autre forme).
   */
  private maskForLog(text: string): string {
    let masked = sanitizeIptvUrl(text);
    // Forme brute puis formes encodées dans les adresses
    const secrets = new Set<string>();
    for (const secret of [this.password, this.username]) {
      if (!secret) continue;
      secrets.add(secret);
      secrets.add(encodeURIComponent(secret));
      secrets.add(encodeXtreamPathSegment(secret));
    }
    for (const secret of secrets) {
      masked = masked.split(secret).join('***');
    }
    return masked;
  }

  // Use Tauri backend to bypass CORS
  private async safeFetch<T = unknown>(url: string): Promise<T | null> {
    return this.parseJson<T>(await this.fetchText(url));
  }

  /** Réponse lue en JSON ; vide ou illisible : null (rien n'est levé) */
  private parseJson<T>(result: string | null | undefined): T | null {
    // Handle empty or invalid responses
    if (!result || result.trim() === '') {
      return null;
    }
    try {
      return JSON.parse(result) as T;
    } catch {
      const afterNotice = looksLikeHtml(result) ? jsonAfterPhpNotice(result) : null;
      if (afterNotice !== null) return afterNotice as T;
      // Masquer AVANT de tronquer : une coupure au milieu de `"password":"…` empêcherait le masquage.
      // Fenêtre de 2000 caractères : une réponse coupée peut peser des Mo ; tout ce qui entre dans les 100 premiers y tient.
      log.warn('Invalid JSON response:', this.maskForLog(result.slice(0, 2000)).substring(0, 100));
      return null;
    }
  }

  async authenticate(): Promise<XtreamAuthResponse> {
    let data: XtreamAuthResponse | null;
    try {
      const raw = await this.fetchText(this.getBaseUrl());
      const afterNotice = raw && looksLikeHtml(raw) ? jsonAfterPhpNotice(raw) : undefined;
      if (afterNotice === null) {
        log.warn('Page web reçue au lieu des informations du compte (maintenance du fournisseur ?)');
        throw new Error(PROVIDER_HTML_RESPONSE);
      }
      data = afterNotice !== undefined ? (afterNotice as XtreamAuthResponse) : this.parseJson<XtreamAuthResponse>(raw);
    } catch (error) {
      if (isProviderHtmlResponseError(error)) throw error;
      // Certains fournisseurs refusent un mauvais mot de passe par une erreur 5xx : si leur
      // serveur répond normalement sans identifiants, il est en marche et ce sont eux qui sont refusés.
      if (isProviderHttpServerError(error) && (await this.serverAnswersWithoutCredentials())) {
        throw new Error(CREDENTIALS_REJECTED);
      }
      throw error;
    }
    // `auth` envoyé en nombre ou en texte selon le panneau : « 0 » est aussi un refus
    const auth: unknown = data?.user_info?.auth;
    if (!data?.user_info || auth === 0 || auth === '0') {
      throw new Error(CREDENTIALS_REJECTED);
    }
    liveExtensions.set(this.accountKey, liveExtensionFor(data.user_info.allowed_output_formats));
    const status = typeof data.user_info.status === 'string' ? data.user_info.status.trim().toLowerCase() : '';
    if (INACTIVE_ACCOUNT_STATUSES.has(status)) {
      log.warn(`Abonnement refusé par le fournisseur (état : ${status})`);
      // Infos du compte gardées avec l'erreur : la carte « Compte » des Paramètres affiche l'état
      // Sans l'identifiant ni le mot de passe (que le fournisseur renvoie en clair), et propriété
      // non énumérable : jamais recopiée par les journaux qui affichent l'erreur
      const { username: _username, password: _password, ...shownInfo } = data.user_info;
      const error = new Error(PROVIDER_ACCOUNT_INACTIVE);
      Object.defineProperty(error, 'userInfo', { value: shownInfo, enumerable: false });
      throw error;
    }
    return data;
  }

  /** Vrai si la racine du serveur répond sans erreur 5xx ni panne réseau (aucun identifiant envoyé). */
  private async serverAnswersWithoutCredentials(): Promise<boolean> {
    try {
      await this.fetchText(`${this.host}/`);
      return true;
    } catch {
      return false;
    }
  }

  async getCategories(
    action: 'get_live_categories' | 'get_vod_categories' | 'get_series_categories'
  ): Promise<IptvCategory[]> {
    const data = await this.safeFetch(`${this.getBaseUrl()}&action=${action}`);
    return listFromResponse(data) as IptvCategory[];
  }

  async getLiveStreams(): Promise<IptvStream[]> {
    const data = await this.safeFetch(`${this.getBaseUrl()}&action=get_live_streams`);
    return listFromResponse(data) as IptvStream[];
  }

  /**
   * Get VOD streams (movies) with normalized TMDB IDs.
   * ⚠️ ATTENTION: La normalisation TmdbId se fait ICI, à la réception.
   * Ne jamais re-normaliser ailleurs dans le code.
   */
  async getVodStreams(): Promise<IptvStream[]> {
    const data = listFromResponse(await this.safeFetch(`${this.getBaseUrl()}&action=get_vod_streams`));

    // Normaliser le champ tmdb à la réception
    return data.map((item) => {
      const stream = item as IptvStream;
      return {
        ...stream,
        tmdb: normalizeTmdbId((stream as { tmdb?: unknown }).tmdb),
      };
    });
  }

  /**
   * Get series list with normalized TMDB IDs.
   * ⚠️ ATTENTION: La normalisation TmdbId se fait ICI, à la réception.
   * Ne jamais re-normaliser ailleurs dans le code.
   */
  async getSeries(): Promise<IptvSeries[]> {
    const data = listFromResponse(await this.safeFetch(`${this.getBaseUrl()}&action=get_series`));

    // Normaliser le champ tmdb à la réception
    return data.map((item) => {
      const series = item as IptvSeries;
      return {
        ...series,
        tmdb: normalizeTmdbId((series as { tmdb?: unknown }).tmdb),
      };
    });
  }

  async getSeriesInfo(seriesId: number | string): Promise<XtreamSeriesInfo | null> {
    // Check SQLite cache first (Phase C3)
    const cached = await getCachedXtreamSeries<XtreamSeriesInfo>(Number(seriesId));
    if (cached) {
      return normalizeSeriesInfo(cached);
    }

    // Fetch from API
    const raw = await this.safeFetch<XtreamSeriesInfo>(
      `${this.getBaseUrl()}&action=get_series_info&series_id=${seriesId}`
    );
    // Numéros d'épisode en texte, saisons en tableaux, quelle que soit la forme du fournisseur
    const data = raw && typeof raw === 'object' ? normalizeSeriesInfo(raw) : raw;

    // Mise en cache 24 h seulement si la série a des épisodes : une réponse vide (erreur passagère
    // du fournisseur) laissait la fiche vide pendant 24 h. Elle est redemandée ensuite.
    if (data && hasEpisodes(data)) {
      await setCachedXtreamSeries(Number(seriesId), data);
    }

    return data;
  }

  /**
   * Get VOD info - may contain tmdb_id if provider configured it
   */
  async getVodInfo(vodId: number | string): Promise<XtreamVodInfo | null> {
    return await this.safeFetch<XtreamVodInfo>(
      `${this.getBaseUrl()}&action=get_vod_info&vod_id=${vodId}`
    );
  }

  async *fetchMassiveData(
    action: string,
    onProgress?: (percent: number) => void
  ): AsyncGenerator<unknown[]> {
    onProgress?.(0);
    const data = listFromResponse(await this.safeFetch(`${this.getBaseUrl()}&action=${action}`));
    onProgress?.(100);

    const chunkSize = 5000;
    for (let i = 0; i < data.length; i += chunkSize) {
      yield data.slice(i, i + chunkSize);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
}
