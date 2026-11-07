/**
 * Adresses du banc de tests automatiques, côté page.
 *
 * Utilisé seulement par les versions d'audit (VITE_AUDIT=1) et du banc (VITE_BANC=1) : verrou « jamais
 * de vrai flux » du lecteur, version du banc seulement, (services/player/mpvApi.ts) et pont d'audit (dev/auditBridge.tsx). Dans une version
 * normale, rien ne l'appelle et le module disparaît du bundle (vérifié par
 * le contrôle du bundle du banc).
 *
 * Même valeurs que celles du banc (en Node) : un test vérifie qu'elles sont
 * identiques. Les ports sont fixes : une option pour les changer serait un moyen d'élargir le verrou.
 */

/** Hôtes admis, en adresses IP littérales : le PC (Windows) et le PC vu depuis un émulateur. */
export const BANC_HOTES = Object.freeze(['127.0.0.1', '10.0.2.2'] as const);
/**
 * Faux fournisseurs Xtream 1 à 4 de chaque compte de test du banc, A, B puis C (une plage par
 * compte pour les passages en parallèle ; le 4 de chaque plage : https au certificat invalide).
 */
export const BANC_PORTS_FAUX = Object.freeze([8765, 8766, 8767, 8768, 8775, 8776, 8777, 8778, 8785, 8786, 8787, 8788] as const);
/** Relais du vrai fournisseur : hors de la plage des faux, le lecteur le refuse toujours. */
export const BANC_PORT_RELAIS = 8790;

/** Code de l'erreur rendue quand le verrou refuse une lecture. */
export const BANC_LECTURE_REFUSEE = 'BANC_LECTURE_REFUSEE';

export type NatureAdresse = 'faux' | 'relais' | 'autre';

/**
 * Motifs construits au premier appel, jamais au chargement du module : un calcul fait au chargement
 * resterait dans le bundle d'une version normale, même sans appelant (vu par
 * le contrôle du bundle du banc).
 */
let motifs: { faux: RegExp; relais: RegExp } | null = null;

function lesMotifs(): { faux: RegExp; relais: RegExp } {
  if (!motifs) {
    const hotes = BANC_HOTES.map((h) => h.replace(/\./g, '\\.')).join('|');
    const motif = (ports: readonly number[]) => new RegExp(`^https?://(?:${hotes}):(?:${ports.join('|')})(?:[/?#][A-Za-z0-9._~/%?&=#-]*)?$`);
    motifs = { faux: motif(BANC_PORTS_FAUX), relais: motif([BANC_PORT_RELAIS]) };
  }
  return motifs;
}

/**
 * Nature d'une adresse, d'après son texte brut (jamais d'après une adresse « normalisée » : le
 * lecteur, ffmpeg, ne lit pas les adresses comme le navigateur). L'hôte et le port doivent suivre
 * immédiatement `http://` ou `https://`, et être suivis d'un `/`, `?`, `#` ou de la fin ; la suite
 * n'admet que des caractères sans ambiguïté (lettres, chiffres, `. _ ~ / % ? & = # -`) : ni `@`
 * nulle part (un autre lecteur d'adresses, Java par exemple, pourrait y voir des identifiants), ni
 * barre oblique inverse, ni espace, ni port par défaut.
 */
export function natureAdresse(adresse: unknown): NatureAdresse {
  if (typeof adresse !== 'string') return 'autre';
  const { faux, relais } = lesMotifs();
  if (faux.test(adresse)) return 'faux';
  if (relais.test(adresse)) return 'relais';
  return 'autre';
}

/**
 * Faux relais TMDB des versions du banc (VITE_BANC=1 seulement) : celui que sert le faux fournisseur
 * de la source (audit/nyx/faux-fournisseur/tmdb.mjs, sous /__tmdb), au lieu du relais de production
 * (chaque appel du banc comptait dans le quota de Supabase). Rien si la source n'est pas un faux
 * fournisseur : la version du banc ne demande alors rien à TMDB, jamais à la production.
 */
export function adresseRelaisTmdbBanc(source: { host: string } | null): string | null {
  if (!source) return null;
  const hote = source.host.replace(/\/+$/, '');
  return natureAdresse(hote) === 'faux' ? `${hote}/__tmdb` : null;
}

/** Erreur rendue par le verrou : reconnaissable à son code, sans l'adresse. */
export function erreurLectureRefusee(): Error & { code: string } {
  return Object.assign(new Error(`${BANC_LECTURE_REFUSEE} : adresse hors du faux fournisseur`), {
    code: BANC_LECTURE_REFUSEE,
  });
}

export function estLectureRefusee(e: unknown): boolean {
  return (e as { code?: unknown } | null)?.code === BANC_LECTURE_REFUSEE;
}

/** Une tentative de lecture vue par le verrou (jamais l'adresse). */
export interface TentativeLecture {
  quand: string;
  cible: NatureAdresse;
  acceptee: boolean;
  /**
   * Lecture admise (faux fournisseur) : genre et numéro du titre lancé, publics et fictifs. Le banc
   * vérifie ainsi QUEL film « Reprendre » a lancé. Jamais pour une adresse refusée.
   */
  titre?: { genre: 'movie' | 'series' | 'live'; numero: number };
}

/** Genre et numéro du titre d'une adresse de flux du faux fournisseur, ou undefined. */
function titreLance(adresse: unknown): TentativeLecture['titre'] {
  const m = typeof adresse === 'string' ? /\/(movie|series|live)\/[^/]+\/[^/]+\/(\d{1,9})\.[a-z0-9]{1,5}$/.exec(adresse) : null;
  return m ? { genre: m[1] as 'movie' | 'series' | 'live', numero: Number(m[2]) } : undefined;
}

const tentatives: TentativeLecture[] = [];

/**
 * Garde au plus 200 tentatives (un parcours complet en fait quelques dizaines). Au-delà, c'est la
 * plus ancienne lecture **acceptée** qui part : un refus reste jusqu'au bout, le banc le relit
 * après coup (verrou 3).
 */
export function noterTentative(cible: NatureAdresse, acceptee: boolean, adresse?: unknown): void {
  const titre = acceptee && cible === 'faux' ? titreLance(adresse) : undefined;
  tentatives.push({ quand: new Date().toISOString(), cible, acceptee, ...(titre ? { titre } : {}) });
  if (tentatives.length > 200) {
    const i = tentatives.findIndex((t) => t.acceptee);
    tentatives.splice(i >= 0 ? i : 0, 1);
  }
}

/** Tentatives depuis le lancement, en copie (le pont d'audit est en lecture seule). */
export function tentativesLecture(): TentativeLecture[] {
  return tentatives.map((t) => ({ ...t, ...(t.titre ? { titre: { ...t.titre } } : {}) }));
}

/**
 * Guide TV des versions du banc (VITE_BANC=1 seulement) : le xmltv du faux
 * fournisseur qui sert de source, au lieu de la source publique (≈ 205 Mo, chaînes réelles que le faux
 * fournisseur n'a pas). Rien si la source n'est pas un faux fournisseur : la version du banc garde
 * alors la source publique, comme une version normale. Les identifiants du faux fournisseur sont faux
 * et fixes, sans valeur.
 */
export function adresseGuideBanc(source: { host: string; username: string; password: string } | null): string | null {
  if (!source) return null;
  const hote = source.host.replace(/\/+$/, '');
  if (natureAdresse(hote) !== 'faux') return null;
  return `${hote}/xmltv.php?username=${encodeURIComponent(source.username)}&password=${encodeURIComponent(source.password)}`;
}
