/**
 * Lien entre un titre de liste IPTV et une fiche TMDB, sans numéro fourni par la liste.
 *
 * Règle « lien sûr ou rien » : une fausse fiche (mauvaise affiche, mauvais résumé) est pire que
 * pas de fiche du tout. Le titre trouvé doit donc être le même que le nôtre (accents, casse et
 * ponctuation ignorés), et l'année doit concorder à un an près quand on la connaît. Sans année,
 * un seul résultat doit porter ce titre. Au moindre doute : aucun lien.
 */

export interface TitleQuery {
    /** Titre nettoyé, envoyé à la recherche TMDB */
    query: string;
    /** Année lue dans le nom (ou fournie par la liste), sinon absente */
    year?: number;
    /**
     * Titre complet quand l'année retirée était collée à la fin sans parenthèses : « Blade Runner
     * 2049 » est peut-être un titre entier. Comparé aussi, sans condition d'année.
     */
    withYear?: string;
}

/** Une proposition de TMDB, ramenée à ce qui sert à comparer (film ou série) */
export interface TitleCandidate {
    id: number;
    titles: string[];
    year?: number;
    /** Chemin de l'affiche chez TMDB (« /abc.jpg »), gardé pour les cartes d'une liste sans image */
    poster?: string | null;
}

/**
 * Préfixe de langue ou de pays : « FR: », « FR - », « |FR| », « [FR] », « VF - ». Liste fermée de
 * codes en majuscules : « Thor: Ragnarok » ou « Up: Là-haut » gardent leur premier mot.
 */
const LANGUAGE_CODES = 'FR|EN|UK|US|USA|VF|VFF|VFQ|VO|VOST|VOSTFR|MULTI|AR|DE|ES|IT|PT|NL|TR|PL|BE|CA|QC|CH|AF|EU|LAT|NF|4K';
const LANG_PREFIX = new RegExp(`^\\s*(?:\\|[^|]{1,10}\\||\\[[^\\]]{1,10}\\]|(${LANGUAGE_CODES})\\s*[:|\\-–]\\s*)`);
/**
 * Codes qui sont aussi des mots de titre (« IT: CHAPTER TWO », « Made in USA ») : en tête, retirés
 * seulement si la suite n'est pas tout en majuscules ; en fin de nom, seulement après un séparateur.
 */
const AMBIGUOUS_PREFIX = /^(?:IT|US|USA)$/;
/** Code de langue en fin de nom, en majuscules, après un séparateur : « Elf - FR », « Elf | FR » */
const TRAILING_LANGUAGE = new RegExp(`^(?:${LANGUAGE_CODES})$`);
/**
 * Préfixe de catégorie « XX| » inconnu de la liste fermée (« EX-YU| », « TOP 10 | », « VOD| ») : 1 à 10
 * caractères tout en majuscules, chiffres, espaces, « - » ou « + », suivis de « | ». Retiré seulement si
 * la suite n'est pas elle-même un simple code (« ELF | FR » garde « ELF »). La comparaison finale exige
 * le titre exact : un préfixe retiré à tort donne au pire aucune fiche.
 */
const GENERIC_PREFIX = /^\s*[\p{Lu}\d][\p{Lu}\d +-]{0,9}\|\s*/u;
/** Marque de saison ou d'épisode en fin de nom : « S01 », « S01E03 », « S11 » (deux chiffres : « S1 » peut faire partie d'un titre) */
const SEASON_TOKEN = /^S\d{2}(?:E\d{2,3})?$/i;
/**
 * Mot « Saison » (ou son équivalent) devant un numéro final, seulement après un séparateur
 * (« Titre - Saison 1 ») : « Open Season 2 » ou « Hunting Season 2 » sont des titres entiers.
 */
const SEASON_WORD = /^(?:saisons?|seasons?|temporada|staffel|stagione)$/i;
/**
 * Étiquette de pays ou de catégorie en tête du nom : « SE - Titre », « AR-SUBS - Titre », « ANM-D - Titre ».
 * Liste FERMÉE : code de pays à deux lettres (ISO 3166) ou service connu, suivi d'un suffixe
 * facultatif en majuscules (« -SUBS », « -D »), puis « - » entouré d'espaces. Un sigle de trois lettres
 * ou plus qui fait partie d'un vrai titre (« NCIS - Sydney », « CSI - Miami », « WWE - Raw ») n'est
 * donc JAMAIS retiré : « Sydney » aurait pu être pris pour une autre série.
 */
const COUNTRY_CODES = new Set('AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TW TZ UA UG UK UM US UY UZ VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW'.split(' '));
const SERVICE_TAGS = new Set(['AMZ', 'D+', 'DSNP', 'ATVP', 'NFX', 'ANM', 'HULU', 'PCOK', 'KU', 'NICK', 'TOP']);
/** Qualité en tête de nom, avant ou entre des codes de pays : « 4K-DE-DV - Titre » */
const QUALITY_TAGS = new Set(['4K', 'UHD', 'FHD', 'HD', 'HDR', 'DV']);
// Jusqu'à trois suffixes en majuscules : « AR-IN-S - », « 4K-DE-DV - ». Le premier élément doit être dans la liste fermée.
const DASH_PREFIX = /^\s*([A-Z0-9+]{2,4})((?:-[A-Z0-9]{1,5}){0,3})\s+[-–]\s+(?=\S)/;
/** Codes de pays qui sont aussi des mots courants : retirés seulement si la suite n'est pas tout en majuscules */
const WORD_CODES = new Set(['IT', 'US', 'IN', 'IS', 'NO', 'DO', 'AS', 'AT', 'BE', 'BY', 'SO', 'TO', 'ME', 'ID', 'AM', 'OM', 'LA', 'UK', 'MY', 'HE', 'NA', 'ES', 'DE']);
/** Année entre parenthèses ou crochets : « (2001) », « [2001] » */
const BRACKET_YEAR = /[([]\s*((?:19|20)\d{2})\s*[)\]]/g;
/**
 * Autres groupes entre crochets ou parenthèses (qualité, langue). Un groupe collé à la lettre qui précède fait
 * partie du titre (« Norbert(a) ») : seul un groupe après un espace ou en tête est retiré.
 */
const BRACKETS = /(?<![\p{L}\p{N}])[[(][^\])]{0,20}[\])]/gu;
/** Groupe collé à la lettre qui précède : retiré seulement si c'est une étiquette connue (« Film(FR) », « Titre[4K] ») */
const GLUED_BRACKETS = /(?<=[\p{L}\p{N}])[[(]([^\])]{0,20})[\])]/gu;
/** Étiquettes techniques ou de langue, retirées seulement en fin de nom (« French Connection » reste entier) */
const TAG = /^(?:4k|uhd|fhd|hd|sd|hdr10\+?|hdr|dv|2160p|1080p|720p|480p|x26[45]|h\.?26[45]|hevc|av1|multi|multisub|vf|vff|vfq|vfi|vo|vost|vostfr|truefrench|french|subfrench|dual|web|web-?dl|webrip|bluray|brrip|bdrip|dvdrip|hdrip|hdlight|remux|imax|3d|10bit)$/i;
const YEAR_TOKEN = /^(?:19|20)\d{2}$/;

const tidy = (text: string) => text.replace(/\s+/g, ' ').replace(/^[\s\-–|:.]+|[\s\-–|:.]+$/g, '').trim();

/**
 * Titre et année à chercher, tirés d'un nom de film ou de série d'une liste.
 * `null` si rien d'utilisable ne reste (nom vide ou seulement des étiquettes).
 */
export function cleanTitleForSearch(name: string, knownYear?: number): TitleQuery | null {
    let text = name.normalize('NFC');
    // Étiquette de pays ou de catégorie (« SE - », « AR-SUBS - », « 4K-DE-DV - ») : au plus trois, liste fermée
    for (let i = 0; i < 3; i++) {
        const tag = DASH_PREFIX.exec(text);
        if (!tag || !(COUNTRY_CODES.has(tag[1]) || SERVICE_TAGS.has(tag[1]) || QUALITY_TAGS.has(tag[1]))) break;
        const rest = text.slice(tag[0].length);
        const bare = rest.trim();
        if (bare === '' || /^\d+$/.test(bare) || TAG.test(bare) || TRAILING_LANGUAGE.test(bare)) break;
        if (WORD_CODES.has(tag[1]) && !/\p{Ll}/u.test(rest)) break;
        text = rest;
    }
    // Préfixes enchaînés (« |FR| VF - Titre ») : retirés un par un
    for (let i = 0; i < 3; i++) {
        const prefix = LANG_PREFIX.exec(text);
        if (!prefix) break;
        const rest = text.slice(prefix[0].length);
        if (prefix[1] && AMBIGUOUS_PREFIX.test(prefix[1]) && !/\p{Ll}/u.test(rest)) break;
        text = rest;
    }
    // Préfixe « XX| » hors liste (une fois) : seulement si la suite n'est pas un simple code ou étiquette
    const generic = GENERIC_PREFIX.exec(text);
    if (generic) {
        const rest = text.slice(generic[0].length);
        const bare = rest.trim();
        const head = generic[0].replace(/\|\s*$/, '').trim();
        // Codes de la liste fermée (dont « IT », « US » qui sont aussi des mots de titre) : déjà traités
        // plus haut, jamais retirés ici ; reste réduit à un nombre : « SCREAM | 2022 » garde son nom
        if (bare !== '' && !TRAILING_LANGUAGE.test(bare) && !TAG.test(bare) && !/^\d+$/.test(bare) && !TRAILING_LANGUAGE.test(head)) text = rest;
    }

    let year = knownYear !== undefined && knownYear >= 1900 && knownYear < 2100 ? knownYear : undefined;
    const bracketYears = [...text.matchAll(BRACKET_YEAR)].map((m) => Number(m[1]));
    if (year === undefined && bracketYears.length > 0) year = bracketYears[bracketYears.length - 1];
    text = text.replace(BRACKET_YEAR, ' ').replace(BRACKETS, ' ')
        .replace(GLUED_BRACKETS, (group, inner: string) => (TAG.test(inner.trim()) || TRAILING_LANGUAGE.test(inner.trim()) ? ' ' : group));
    // Titre en deux écritures (latin + arabe/persan) : on garde la partie latine
    if (/\p{Script=Arabic}/u.test(text) && /\p{Script=Latin}/u.test(text)) {
        // Mots latins gardés ; un nombre isolé juste après du texte arabe appartient à ce texte (« Lost Bullet 2 … 2 »)
        const latin: string[] = [];
        let inArabic = false;
        for (const w of text.split(/\s+/)) {
            if (/\p{Script=Arabic}/u.test(w)) inArabic = true;
            else if (/\p{Script=Latin}/u.test(w)) { inArabic = false; latin.push(w); }
            else if (!inArabic && w !== '') latin.push(w);
        }
        // Partie latine trop courte (« X », « It », « Up ») : trop ambiguë, le nom reste tel quel et ne trouve rien
        const letters = latin.join('').replace(/[^\p{Script=Latin}]/gu, '').length;
        if (latin.length >= 2 || letters >= 4) text = latin.join(' ');
    }
    // Nom de fichier (« Le.Film.2001.MULTI ») : points et soulignés deviennent des espaces
    if (!/\s/.test(text.trim()) && /[._]/.test(text)) text = text.replace(/[._]+/g, ' ');

    // Fin du nom : étiquettes et année collée, retirées mot par mot
    const words = tidy(text).split(' ').filter(Boolean);
    let withYear: string | undefined;
    while (words.length > 1) {
        const raw = words[words.length - 1];
        const last = raw.replace(/^[-–|:.]+|[-–|:.]+$/g, '');
        // Code de langue final : après un séparateur (« Elf - FR »), ou dans un nom qui n'est pas
        // tout en majuscules (« Inception FR »). « AMONG US » et « LET IT BE » restent entiers.
        const previous = words[words.length - 2];
        const afterSeparator = /^[-–|]/.test(raw) || /^[-–|:]+$/.test(previous) || /:$/.test(previous);
        const languageTag = TRAILING_LANGUAGE.test(last) && (afterSeparator || (!AMBIGUOUS_PREFIX.test(last) && /\p{Ll}/u.test(words.join(' '))));
        if (TAG.test(last) || last === '' || languageTag || SEASON_TOKEN.test(last)) {
            words.pop();
        } else if (words.length > 3 && /^\d{1,2}$/.test(last) && SEASON_WORD.test(previous) && /^[-–|:]+$/.test(words[words.length - 3])) {
            // « Saison 1 » : le mot et son numéro partent ensemble (« Shrek 2 » reste entier)
            words.pop();
            words.pop();
        } else if (YEAR_TOKEN.test(last) && withYear === undefined && (year === undefined || Number(last) === year)) {
            // « 1917 » seul reste un titre (boucle arrêtée à un mot) ; « Blade Runner 2049 » est
            // peut-être un titre entier : gardé à côté pour la comparaison
            withYear = tidy(words.join(' '));
            year = Number(last);
            words.pop();
        } else {
            break;
        }
    }
    text = tidy(words.join(' '));
    if (text === '' || normalizeTitle(text) === '' || TAG.test(text)) return null;
    if (withYear && normalizeTitle(withYear) === normalizeTitle(text)) withYear = undefined;
    return { query: text, ...(year !== undefined ? { year } : {}), ...(withYear ? { withYear } : {}) };
}

/** Titre ramené à sa forme de comparaison : minuscules, sans accents, sans ponctuation */
export function normalizeTitle(title: string): string {
    return title
        .normalize('NFD')
        .replace(/\p{Diacritic}/gu, '')
        .toLowerCase()
        // Lettres sans décomposition : « Kiralık Aşk » = « Kiralik Ask »
        .replace(/ı/g, 'i').replace(/ø/g, 'o').replace(/ł/g, 'l').replace(/đ/g, 'd')
        .replace(/&/g, ' and ')
        .replace(/['’`]/g, '')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();
}

/** Un titre « Début - Fin » coupé en deux (normalisés) ; sans séparateur, tout est le début et la fin est vide */
function splitHeadTail(normalized: string, raw: string): [string, string] {
    const parts = raw.split(/\s+[-–:]\s+/);
    if (parts.length !== 2) return ['', normalized];
    return [normalizeTitle(parts[0]), normalizeTitle(parts[1])];
}

/** Année d'une date TMDB (« 2001-05-16 »), sinon absente */
export function yearOf(date: string | undefined | null): number | undefined {
    const year = Number(date?.slice(0, 4));
    return Number.isInteger(year) && year >= 1800 ? year : undefined;
}

/**
 * Numéro TMDB du seul résultat sûr, sinon 0.
 * - même titre (traduit ou original) une fois normalisé ;
 * - année connue : écart d'un an au plus ; plusieurs à égalité : celle de la même année, si elle est seule ;
 * - année inconnue : un seul résultat porte ce titre ;
 * - aucun avec cette année et un nombre final retiré du nom : un seul résultat au titre complet.
 */
export function pickConfidentMatch(query: TitleQuery, candidates: TitleCandidate[]): number {
    const wanted = normalizeTitle(query.query);
    if (!wanted) return 0;
    // Sans année et sans aucune lettre latine (« ثمن الخيانة ») : trop de séries portent le même titre, on ne tranche pas
    if (query.year === undefined && /\p{L}/u.test(query.query) && !/\p{Script=Latin}/u.test(query.query)) return 0;
    const [head, tail] = splitHeadTail(wanted, query.query);
    const sameTitle = candidates.filter((c) => {
        if (c.id <= 0) return false;
        const titles = c.titles.flatMap((t) => t.split(' / '));
        if (titles.some((t) => normalizeTitle(t) === wanted)) return true;
        // « Suzhal - The Vortex » : début lu dans un titre de la fiche, fin dans un autre (titre en deux écritures)
        return head !== '' && titles.some((t) => splitHeadTail(normalizeTitle(t), t)[0] === head) && titles.some((t) => { const [h, e] = splitHeadTail(normalizeTitle(t), t); return h !== '' && e === tail; });
    });
    if (query.year === undefined) return sameTitle.length === 1 ? sameTitle[0].id : 0;
    const close = sameTitle.filter((c) => c.year !== undefined && Math.abs(c.year - query.year!) <= 1);
    if (close.length === 1) return close[0].id;
    const exact = close.filter((c) => c.year === query.year);
    if (exact.length === 1) return exact[0].id;
    if (close.length > 0 || !query.withYear) return 0;
    // « Blade Runner 2049 » : le nombre final faisait partie du titre
    const whole = normalizeTitle(query.withYear);
    const sameWhole = candidates.filter((c) => c.id > 0 && c.titles.some((t) => normalizeTitle(t) === whole));
    return sameWhole.length === 1 ? sameWhole[0].id : 0;
}
