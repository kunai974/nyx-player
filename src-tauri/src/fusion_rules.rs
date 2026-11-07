//! Règles de regroupement de l'index commun à toutes les sources (`fusion_index.rs`).
//!
//! Règle d'or : **regrouper seulement quand on est sûr**. Un film affiché deux fois gêne un peu ;
//! deux films différents fondus en un (on lance le mauvais) gêne beaucoup. Dans le doute, une
//! entrée garde sa propre ligne.
//!
//! Les numéros donnés par les fournisseurs ne disent rien : le n° 5 de deux fournisseurs n'est pas
//! le même contenu. On ne réunit que sur un identifiant qui ne dépend pas du fournisseur.
//!
//! - Film ou série : même fiche TMDB, et rien d'autre (même titre et même année ne suffisent pas).
//!   Sans fiche : jamais regroupé.
//! - Chaîne : même identifiant de guide, même nom nettoyé (certains fournisseurs donnent le même
//!   identifiant à toutes les éditions régionales), même pays et même langue quand ils sont écrits.
//!   Sans identifiant de guide : jamais regroupée.
//! - Catégorie : même nom nettoyé, pour le même type (films, séries, chaînes).
//!
//! Le nom nettoyé retire les étiquettes des fournisseurs (« FR | », « [VIP] », « 4K », « MULTI »,
//! « VOSTFR »…), les accents et les majuscules. Les étiquettes retirées ne sont pas perdues : elles
//! donnent la qualité et la langue de l'offre. Une étiquette n'est retirée qu'en position
//! d'étiquette (entre crochets ou parenthèses, préfixe avant un séparateur, ou à la fin du nom) :
//! « The French Connection » garde son « French ».

use std::sync::OnceLock;

use regex::Regex;

use crate::epg_parser::strip_accents;

/// Qualité lue dans les étiquettes, de la meilleure à la moins bonne
const QUALITIES: [(&str, &[&str]); 4] = [
    ("4K", &["4k", "uhd", "2160p", "8k"]),
    ("FHD", &["fhd", "1080p", "1080"]),
    ("HD", &["hd", "720p", "720"]),
    ("SD", &["sd", "480p", "576p"]),
];

/// Langue lue dans les étiquettes, par ordre de préférence quand plusieurs sont écrites
const LANGUAGES: [(&str, &[&str]); 4] = [
    ("MULTI", &["multi", "multisub", "multi sub"]),
    ("VOSTFR", &["vostfr", "vost", "stfr", "subfr"]),
    ("VF", &["vf", "vff", "vfq", "vfi", "truefrench", "french", "fr"]),
    ("VO", &["vo", "en", "eng", "english"]),
];

/// Étiquettes techniques sans effet sur le contenu
const NOISE: [&str; 16] = [
    "vip", "hevc", "h264", "h265", "x264", "x265", "10bit", "hdr", "hdr10", "dv", "web", "webrip",
    "webdl", "bluray", "remux", "new",
];

/// Étiquettes qui sont aussi des mots courants d'un titre (« The English », « The VIP »,
/// « Room 1080 ») : dans un titre, elles ne sont retirées qu'entre crochets ou parenthèses, ou en
/// préfixe écrites en majuscules. Le nom d'une chaîne, lui, les perd aussi en fin de nom.
const AMBIGUOUS: [&str; 13] = [
    "english", "french", "en", "fr", "eng", "vo", "vip", "web", "new", "dv", "1080", "720", "8k",
];

/// Codes de pays ou de langue acceptés en préfixe (« FR | Titre »), liste fermée
const COUNTRY_CODES: [&str; 24] = [
    "fr", "be", "ch", "ca", "qc", "lu", "mc", "en", "uk", "gb", "us", "ie", "au", "de", "at", "es", "it", "pt",
    "nl", "pl", "tr", "ar", "ma", "dz",
];

/// Ce qu'on tire du nom d'un film ou d'une série
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TitleParts {
    /// Nom nettoyé : minuscules, sans accents, sans étiquettes, mots séparés par une espace
    pub key: String,
    /// Année écrite comme une étiquette
    pub year: Option<u16>,
    pub quality: Option<&'static str>,
    pub language: Option<&'static str>,
    /// Code de pays écrit en tête du nom et retiré (« FR | », « [UK] », « DE: »)
    pub country: Option<String>,
}

fn is_two_letters(word: &str) -> bool {
    word.len() == 2 && word.chars().all(|c| c.is_ascii_alphabetic())
}

fn is_year(word: &str) -> Option<u16> {
    if word.len() != 4 {
        return None;
    }
    let year: u16 = word.parse().ok()?;
    (1900..=2099).contains(&year).then_some(year)
}

fn quality_of(token: &str) -> Option<&'static str> {
    QUALITIES.iter().find(|(_, words)| words.contains(&token)).map(|(q, _)| *q)
}

fn language_of(token: &str) -> Option<&'static str> {
    LANGUAGES.iter().find(|(_, words)| words.contains(&token)).map(|(l, _)| *l)
}

fn rank(list: &[(&'static str, &[&str])], value: &'static str) -> usize {
    list.iter().position(|(v, _)| *v == value).unwrap_or(usize::MAX)
}

/// Garde la meilleure valeur des deux selon l'ordre de la liste
fn better(list: &[(&'static str, &[&str])], current: Option<&'static str>, found: &'static str) -> Option<&'static str> {
    match current {
        Some(c) if rank(list, c) <= rank(list, found) => Some(c),
        _ => Some(found),
    }
}

/// Exposants Unicode que certains fournisseurs mettent dans les noms (ᴴᴰ, ᵁᴴᴰ, ˢᴰ, ᶠᴴᴰ)
fn plain_letters(name: &str) -> String {
    name.chars()
        .map(|c| match c {
            'ᴬ' => 'A', 'ᴮ' => 'B', 'ᴰ' => 'D', 'ᴱ' => 'E', 'ᴳ' => 'G', 'ᴴ' => 'H', 'ᴵ' => 'I',
            'ᴶ' => 'J', 'ᴷ' => 'K', 'ᴸ' => 'L', 'ᴹ' => 'M', 'ᴺ' => 'N', 'ᴼ' => 'O', 'ᴾ' => 'P',
            'ᴿ' => 'R', 'ˢ' => 'S', 'ᵀ' => 'T', 'ᵁ' => 'U', 'ⱽ' => 'V', 'ᵂ' => 'W', 'ᶠ' => 'F',
            _ => c,
        })
        .collect()
}

/// Mots d'un texte : minuscules, sans accents, lettres et chiffres seulement
fn words(text: &str) -> Vec<String> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"[^\p{L}\p{N}]+").unwrap());
    let lowered = strip_accents(&plain_letters(text).to_lowercase());
    re.split(&lowered).filter(|w| !w.is_empty()).map(str::to_string).collect()
}

#[derive(Clone, Copy)]
struct Tags {
    year: Option<u16>,
    quality: Option<&'static str>,
    language: Option<&'static str>,
}

impl Tags {
    /// Lit un mot en position d'étiquette sûre (fin de nom d'un titre) : les mots courants d'un
    /// titre n'en sont pas
    fn take_strict(&mut self, word: &str, allow_year: bool) -> bool {
        !AMBIGUOUS.contains(&word) && self.take(word, allow_year)
    }

    /// Lit un mot en position d'étiquette ; faux s'il n'en est pas une
    fn take(&mut self, word: &str, allow_year: bool) -> bool {
        if allow_year {
            if let Some(y) = is_year(word) {
                self.year = Some(y);
                return true;
            }
        }
        if let Some(q) = quality_of(word) {
            self.quality = better(&QUALITIES, self.quality, q);
            return true;
        }
        if let Some(l) = language_of(word) {
            self.language = better(&LANGUAGES, self.language, l);
            return true;
        }
        NOISE.contains(&word)
    }
}

/// Nom d'un film ou d'une série découpé en nom nettoyé, année, qualité et langue.
pub fn title_parts(name: &str) -> TitleParts {
    parts(name, true)
}

/// Découpe commune. `strict` (titres) : en fin de nom, seules les étiquettes sans ambiguïté partent.
fn parts(name: &str, strict: bool) -> TitleParts {
    static RE_BRACKETS: OnceLock<Regex> = OnceLock::new();
    static RE_PREFIX: OnceLock<Regex> = OnceLock::new();
    static RE_SUFFIX: OnceLock<Regex> = OnceLock::new();
    let re_brackets = RE_BRACKETS.get_or_init(|| Regex::new(r"[\[\(\{]([^\]\)\}]*)[\]\)\}]").unwrap());
    // « FR | Titre », « |FR| Titre », « FR: Titre », « [FR] Titre », « VOD - FR - Titre »
    let re_prefix = RE_PREFIX.get_or_init(|| {
        Regex::new(r"^\s*(?:\|?\s*[\p{L}\p{N} ]{1,12}?\s*[\|:]|[\p{L}\p{N}]{1,6}\s+-\s+)+\s*").unwrap()
    });
    // « Titre - 2019 », « Titre | 4K », « Titre - MULTI »
    let re_suffix = RE_SUFFIX.get_or_init(|| Regex::new(r"\s+[\-\|]\s+([^\-\|]+)$").unwrap());

    let mut tags = Tags { year: None, quality: None, language: None };
    let mut country: Option<String> = None;
    let mut text = plain_letters(name);

    // 1. Groupes entre crochets ou parenthèses : étiquettes s'ils n'en contiennent que ; sinon gardés
    let mut kept = String::with_capacity(text.len());
    let mut last = 0;
    for m in re_brackets.captures_iter(&text) {
        let whole = m.get(0).unwrap();
        let inner = words(&m[1]);
        let all_tags = !inner.is_empty() && {
            let mut probe = tags;
            let ok = inner.iter().all(|w| probe.take(w, true));
            if ok {
                tags = probe;
            }
            ok
        };
        // « [FR] Titre » : un code de pays seul entre crochets, en tête du nom
        if all_tags && country.is_none() && text[..whole.start()].trim().is_empty() && inner.len() == 1 && COUNTRY_CODES.contains(&inner[0].as_str()) {
            country = Some(inner[0].clone());
        }
        kept.push_str(&text[last..whole.start()]);
        kept.push(' ');
        if !all_tags {
            kept.push_str(&m[1]);
            kept.push(' ');
        }
        last = whole.end();
    }
    kept.push_str(&text[last..]);
    text = kept;

    // 2. Préfixes avant un séparateur, s'ils ne sont faits que d'étiquettes ou d'un code court
    if let Some(m) = re_prefix.find(&text) {
        let prefix_words = words(m.as_str());
        let rest_words = words(&text[m.end()..]);
        let mut probe = tags;
        // Étiquette sûre ; code de pays ou mot ambigu, avant « | » ou écrit en majuscules (« FR: »,
        // mais pas « It: Chapitre Deux » ni « Us - Eux ») ; mot du fournisseur (« VOD »)
        let piped = m.as_str().contains('|');
        let written = |w: &str| {
            m.as_str()
                .split(|c: char| !c.is_alphanumeric())
                .any(|o| o.to_lowercase() == w && o.chars().any(char::is_alphabetic) && !o.chars().any(char::is_lowercase))
        };
        // Pays : un code de la liste fermée, avant « | » ou écrit en majuscules. Puis les étiquettes
        // (« VF | », « HD | » gardent leur sens). Enfin, pour une chaîne seulement, avant « | », un
        // autre code de deux lettres écrit en majuscules (« SE | ») : dans un titre, « OK | Corral »
        // reste un titre. « It: Chapitre Deux » et « Us - Eux » restent des titres.
        let mut code = None;
        let mut only_tags = true;
        for w in &prefix_words {
            let country = (piped || written(w)) && COUNTRY_CODES.contains(&w.as_str());
            if country {
                code.get_or_insert_with(|| w.clone());
            } else if probe.take_strict(w, false) || ((piped || written(w)) && probe.take(w, false)) || w == "vod" {
                continue;
            } else if !strict && piped && written(w) && is_two_letters(w) {
                code.get_or_insert_with(|| w.clone());
            } else {
                only_tags = false;
                break;
            }
        }
        if only_tags && !rest_words.is_empty() {
            tags = probe;
            if code.is_some() {
                country = code;
            }
            text = text[m.end()..].to_string();
        }
    }

    // 3. Suffixes après un séparateur, s'ils ne sont faits que d'étiquettes (année comprise)
    while let Some(c) = re_suffix.captures(&text) {
        let suffix_words = words(&c[1]);
        let mut probe = tags;
        if suffix_words.is_empty() || !suffix_words.iter().all(|w| if strict { probe.take_strict(w, true) } else { probe.take(w, true) }) {
            break;
        }
        tags = probe;
        text.truncate(c.get(0).unwrap().start());
    }

    // 4. Étiquettes nues en fin de nom (« Avatar 4K MULTI »), jamais l'année ni le premier mot
    let mut all = words(&text);
    while all.len() > 1 {
        let last_word = all.last().unwrap().clone();
        let mut probe = tags;
        let taken = if strict { probe.take_strict(&last_word, false) } else { probe.take(&last_word, false) };
        if !taken {
            break;
        }
        tags = probe;
        all.pop();
    }

    TitleParts { key: all.join(" "), year: tags.year, quality: tags.quality, language: tags.language, country }
}

/// Clé de regroupement d'un film ou d'une série ; None : jamais regroupé (ligne à part)
pub fn title_group_key(tmdb_id: Option<i64>) -> Option<String> {
    tmdb_id.filter(|id| *id > 0).map(|id| format!("tmdb:{id}"))
}

/// Nom d'une chaîne nettoyé (sans préfixe de pays, sans qualité ni étiquette, sans accents), avec
/// sa qualité et sa langue. Un nom de chaîne finit souvent par « HD » ou « EN » : ils partent aussi.
pub fn channel_clean_name(name: &str) -> (String, Option<&'static str>, Option<&'static str>) {
    let parts = parts(name, false);
    (parts.key, parts.quality, parts.language)
}

/// Code pays d'une chaîne : indice du guide (`geo_hint`), sinon code écrit en tête du nom
pub fn channel_country(name: &str, geo_hint: Option<&str>) -> Option<String> {
    if let Some(hint) = geo_hint.map(str::trim).filter(|h| is_two_letters(h)) {
        return Some(hint.to_ascii_lowercase());
    }
    parts(name, false).country
}

/// Clé de regroupement d'une chaîne ; None : jamais regroupée
pub fn channel_group_key(name: &str, epg_channel_id: Option<&str>, geo_hint: Option<&str>) -> Option<String> {
    // Sans identifiant de guide : jamais réunie, même nom et même pays compris
    let epg = epg_channel_id.map(str::trim).filter(|e| !e.is_empty())?;
    let (clean, _, language) = channel_clean_name(name);
    if clean.is_empty() {
        return None;
    }
    // La langue écrite reste dans la clé : « France 24 EN » et « France 24 FR » sont deux chaînes
    let clean = match language {
        Some(l) => format!("{clean}:{l}"),
        None => clean,
    };
    // Le pays connu reste aussi : « EN | France 24 » et « FR | France 24 » sont deux éditions.
    // Sans pays écrit, celui de l'identifiant (« tf1.fr ») : un fournisseur qui n'écrit aucun
    // préfixe rejoint ainsi celui qui écrit « FR | ».
    let tail = epg.rsplit('.').next().filter(|t| epg.contains('.') && is_two_letters(t)).map(str::to_ascii_lowercase);
    let country = channel_country(name, geo_hint).or(tail);
    let country = country.as_deref().unwrap_or("-");
    Some(format!("epg:{}:{country}:{clean}", epg.to_lowercase()))
}

/// Clé d'une catégorie (même type) : nom nettoyé, précédé du pays écrit en préfixe (« FR | Sport »
/// et « UK | Sport » restent deux catégories) ; None si le nom ne garde aucun mot
pub fn category_key(name: &str) -> Option<String> {
    let key = words(name).join(" ");
    let parts = title_parts(name);
    let from_tags = !parts.key.is_empty();
    let cleaned = if from_tags { parts.key.clone() } else { key };
    if cleaned.is_empty() {
        return None;
    }
    Some(match parts.country {
        Some(country) if from_tags => format!("{country}:{cleaned}"),
        _ => cleaned,
    })
}

#[cfg(test)]
#[path = "fusion_rules_tests.rs"]
mod tests;
