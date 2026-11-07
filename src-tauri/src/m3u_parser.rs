//! Lecture d'une liste M3U / M3U8 (format `#EXTM3U` étendu des listes IPTV).
//!
//! La liste est lue ligne par ligne depuis un flux : jamais entière en mémoire, même pour une liste
//! de plusieurs centaines de milliers d'entrées (un petit boîtier TV n'a que quelques centaines de
//! Mo libres). Chaque entrée lue est rendue aussitôt à l'appelant, qui l'écrit où il veut.
//!
//! Pour chaque entrée, la lecture donne :
//! - sa sorte (chaîne, film ou épisode), d'après son adresse et son nom ;
//! - un numéro entier stable d'un téléchargement à l'autre : le numéro du fournisseur quand
//!   l'adresse a la forme Xtream (`/live/u/p/123.ts`), sinon une empreinte de l'adresse sans ses
//!   paramètres changeants (jetons, signatures, expirations) ;
//! - ses attributs utiles : nom, groupe, logo, identifiant et nom du guide, numéro de chaîne ;
//! - pour un épisode, la série, la saison et le numéro tirés du nom (`S01E03`, `Saison 1 Épisode 3`, `1x03`).
//!
//! L'en-tête `#EXTM3U` peut donner l'adresse d'un guide des programmes (`url-tvg`, `x-tvg-url`).
//!
//! Tolérances : marque d'ordre des octets, fins de ligne Windows, `#EXTINF` sans attribut ou sans
//! durée, attributs entre guillemets ou non, lignes `#EXTGRP`, `#EXTVLCOPT` et commentaires, adresse
//! seule sans `#EXTINF`. Une entrée illisible ou une adresse autre que `http`/`https` est sautée et
//! comptée, jamais une erreur pour toute la liste.
//!
//! Limite connue : quand une liste mêle plusieurs serveurs qui donnent le même numéro Xtream, le
//! premier lu garde ce numéro et les autres prennent leur empreinte. Si le fournisseur inverse
//! l'ordre de ses serveurs, le numéro passe à l'autre chaîne (une lecture en flux ne peut pas voir
//! la suite de la liste avant de donner un numéro).
//!
//! Aucune adresse n'est écrite dans les journaux : elles portent souvent un identifiant et un mot de
//! passe.


use std::collections::{HashMap, HashSet};
use std::io::BufRead;

/// Longueur au-delà de laquelle une ligne est sautée sans être gardée en mémoire. Une ligne
/// `#EXTINF` normale fait quelques centaines d'octets ; une ligne de plusieurs Mo n'est pas une
/// entrée, et la garder entière permettrait à une liste malveillante d'occuper toute la mémoire.
pub const MAX_LINE_BYTES: usize = 64 * 1024;

/// Plafonds de longueur des champs rendus, coupés sur une frontière de caractère : une liste
/// fabriquée ne peut pas faire grossir la base bien au-delà de sa propre taille.
pub const MAX_NAME_CHARS: usize = 512;
pub const MAX_GROUP_CHARS: usize = 256;
/// Au-delà, une adresse de lecture fait sauter l'entrée (une adresse coupée ne se lirait pas).
pub const MAX_URL_BYTES: usize = 8192;
/// Au-delà, un logo est oublié.
pub const MAX_LOGO_BYTES: usize = 4096;
/// Valeurs d'en-tête HTTP (agent, page d'origine) et identifiant du guide.
pub const MAX_HEADER_CHARS: usize = 512;
/// Adresses de guide gardées au plus depuis l'en-tête.
pub const MAX_EPG_URLS: usize = 3;
/// Essais au plus pour trouver un numéro libre après une collision d'empreintes.
const MAX_ID_PROBES: usize = 64;

/// Paramètres d'adresse qui changent d'un téléchargement à l'autre (jetons, signatures,
/// expirations) : hors de l'empreinte. Les autres (`id=`, `channel=`…) désignent souvent la chaîne
/// elle-même et en font partie.
const VOLATILE_QUERY_KEYS: &[&str] = &[
    "token", "auth", "key", "sig", "signature", "exp", "expires", "expiry", "e", "st", "hash",
    "hdnts", "hdnea", "wmsauthsign", "md5", "time", "ts", "t", "nonce", "session", "sid",
    "password", "pass", "pwd", "username", "user", "uid", "_", "ticket", "play_token", "policy",
    "key-pair-id", "hmac", "hdntl",
];

/// Préfixes de paramètres changeants (signatures des stockages en ligne : `x-amz-signature`…).
const VOLATILE_QUERY_PREFIXES: &[&str] = &["x-amz-", "x-goog-"];

fn is_volatile_query_key(name: &str) -> bool {
    VOLATILE_QUERY_KEYS.iter().any(|v| v.eq_ignore_ascii_case(name))
        || VOLATILE_QUERY_PREFIXES.iter().any(|p| starts_with_ignore_case(name, p))
}

/// Plus petit numéro donné par empreinte. Les numéros d'un fournisseur Xtream restent bien en
/// dessous : une empreinte ne peut donc jamais prendre le numéro d'une entrée de forme Xtream de la
/// même liste.
pub const HASH_ID_MIN: i64 = 1 << 40;
/// Plus grand numéro (exclu) : 2^53, la limite des entiers exacts en JavaScript, où ces numéros
/// sont relus.
pub const HASH_ID_END: i64 = 1 << 53;

/// Sorte d'une entrée de la liste.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntryKind {
    Live,
    Movie,
    Episode,
}

/// Série, saison et numéro d'un épisode, tirés de son nom.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EpisodeInfo {
    pub series_name: String,
    pub season: u32,
    pub episode: u32,
}

/// Une entrée lue dans la liste.
#[derive(Debug, Clone, PartialEq)]
pub struct M3uEntry {
    /// Numéro stable, unique dans cette liste.
    pub id: i64,
    pub kind: EntryKind,
    /// Nom affiché (texte après la virgule de `#EXTINF`, sinon `tvg-name`, sinon fin de l'adresse).
    pub name: String,
    /// Adresse de lecture, telle quelle (avec ses paramètres).
    pub url: String,
    /// Groupe (`group-title`, sinon `#EXTGRP`), vide si aucun.
    pub group: String,
    pub logo: Option<String>,
    /// Identifiant de la chaîne dans le guide des programmes (`tvg-id`).
    pub tvg_id: Option<String>,
    pub tvg_name: Option<String>,
    /// Numéro de chaîne (`tvg-chno`, `channel-number`), qui peut avoir une partie décimale.
    pub chno: Option<f64>,
    /// Extension du fichier de l'adresse (`ts`, `m3u8`, `mkv`…), en minuscules.
    pub extension: Option<String>,
    pub episode: Option<EpisodeInfo>,
    /// En-têtes HTTP demandés par la liste pour lire ce flux (`#EXTVLCOPT:http-user-agent`,
    /// `http-referrer`, ou la forme `adresse|User-Agent=…&Referer=…`).
    pub user_agent: Option<String>,
    pub referrer: Option<String>,
    /// Année tirée du nom (`Titre (2019)`, `Titre [2019]`), pour un film ou un épisode.
    pub year: Option<u32>,
}

/// En-tête et compteurs d'une lecture complète.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct M3uSummary {
    /// La première ligne utile est `#EXTM3U`.
    pub has_header: bool,
    /// Adresses de guide données par l'en-tête, dans l'ordre (sans doublon).
    pub epg_urls: Vec<String>,
    /// Entrées rendues à l'appelant.
    pub entries: usize,
    /// Entrées sautées : adresse vide ou illisible.
    pub skipped_invalid: usize,
    /// Entrées sautées : adresse autre que `http` ou `https`.
    pub skipped_scheme: usize,
    /// Entrées sautées : même adresse exacte déjà lue plus haut dans la liste.
    pub skipped_duplicate: usize,
    /// Lignes sautées car trop longues.
    pub skipped_long_lines: usize,
    /// Entrées sautées : aucun numéro libre trouvé près de leur empreinte (liste fabriquée).
    pub skipped_no_free_id: usize,
    /// Numéros d'empreinte déjà pris par une autre adresse, décalés.
    pub id_collisions: usize,
    /// La lecture s'est arrêtée au plafond d'entrées : la liste est plus longue.
    pub truncated: bool,
    /// La lecture a été arrêtée par l'appelant avant la fin de la liste.
    pub stopped: bool,
}

/// Erreur de lecture du flux lui-même (coupure réseau, disque). Le contenu de la liste n'en
/// produit jamais.
#[derive(Debug)]
pub struct M3uReadError(pub std::io::Error);

impl std::fmt::Display for M3uReadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "M3U read error: {}", self.0)
    }
}

/// Attributs de la dernière ligne `#EXTINF` lue, en attente de l'adresse qui la suit.
#[derive(Default)]
struct Pending {
    name: String,
    attrs: HashMap<String, String>,
    group: Option<String>,
    /// Vient d'une ligne `#EXTINF` (et pas seulement d'un `#EXTGRP` ou d'un `#EXTVLCOPT`).
    from_extinf: bool,
    user_agent: Option<String>,
    referrer: Option<String>,
}

impl Pending {
    /// Seulement des lignes `#EXTGRP` / `#EXTVLCOPT` placées avant leur `#EXTINF`.
    fn is_options_only(&self) -> bool {
        !self.from_extinf
    }
}

/// Lit toute la liste depuis `reader` et rend chaque entrée à `on_entry`, dans l'ordre de la liste.
/// S'arrête après `max_entries` entrées (`truncated` le dit). Seule une erreur du flux est une
/// erreur.
// Forme simple, sans arrêt : les tests et les outils la gardent, l'app passe par `read_m3u_until`
#[cfg_attr(not(test), allow(dead_code))]
pub fn read_m3u<R: BufRead>(
    reader: R,
    max_entries: usize,
    mut on_entry: impl FnMut(M3uEntry),
) -> Result<M3uSummary, M3uReadError> {
    read_m3u_until(reader, max_entries, |entry| {
        on_entry(entry);
        true
    })
}

/// Comme `read_m3u`, mais `on_entry` peut arrêter la lecture en rendant `false` (`stopped` le
/// dit) : une déconnexion n'attend pas la fin d'une très grosse liste.
pub fn read_m3u_until<R: BufRead>(
    mut reader: R,
    max_entries: usize,
    mut on_entry: impl FnMut(M3uEntry) -> bool,
) -> Result<M3uSummary, M3uReadError> {
    let mut summary = M3uSummary::default();
    // Numéros déjà donnés
    let mut taken: HashSet<i64> = HashSet::new();
    // Empreintes déjà rendues : une même adresse plus bas dans la liste est un doublon
    let mut seen: HashSet<u64> = HashSet::new();
    let mut pending: Option<Pending> = None;
    let mut first_useful_line = true;
    let mut buf: Vec<u8> = Vec::with_capacity(1024);

    loop {
        buf.clear();
        match read_bounded_line(&mut reader, &mut buf).map_err(M3uReadError)? {
            LineRead::End => break,
            LineRead::TooLong => {
                summary.skipped_long_lines += 1;
                continue;
            }
            LineRead::Line => {}
        }
        let text = String::from_utf8_lossy(&buf);
        let mut line = text.trim();
        if first_useful_line {
            line = line.trim_start_matches('\u{feff}').trim();
        }
        if line.is_empty() {
            continue;
        }

        if starts_with_ignore_case(line, "#EXTM3U") {
            // Plus loin qu'en tête : deux listes collées l'une à l'autre, leurs guides comptent
            summary.has_header |= first_useful_line;
            first_useful_line = false;
            read_header(&line[7..], &mut summary.epg_urls);
            continue;
        }
        first_useful_line = false;

        if starts_with_ignore_case(line, "#EXTINF") {
            let mut next = read_extinf(&line[7..]);
            match pending.take() {
                // Un #EXTGRP placé avant son #EXTINF : le groupe est gardé
                Some(previous) if previous.is_options_only() => {
                    next.group = previous.group;
                    next.user_agent = previous.user_agent;
                    next.referrer = previous.referrer;
                }
                // Une ligne #EXTINF sans adresse avant la suivante : cette entrée n'existe pas
                Some(_) => summary.skipped_invalid += 1,
                None => {}
            }
            pending = Some(next);
        } else if starts_with_ignore_case(line, "#EXTGRP:") {
            let group = line[8..].trim();
            if !group.is_empty() {
                pending.get_or_insert_with(Pending::default).group = Some(group.to_string());
            }
        } else if starts_with_ignore_case(line, "#EXTVLCOPT:") {
            // Seuls l'agent et la page d'origine sont repris : aucune autre option du lecteur ne
            // vient de la liste
            let option = &line[11..];
            if let Some((name, value)) = option.split_once('=') {
                let value = clean_header(value);
                let slot = pending.get_or_insert_with(Pending::default);
                match name.trim().to_ascii_lowercase().as_str() {
                    "http-user-agent" => slot.user_agent = value.or(slot.user_agent.take()),
                    "http-referrer" | "http-referer" => slot.referrer = value.or(slot.referrer.take()),
                    _ => {}
                }
            }
        } else if line.starts_with('#') {
            // #KODIPROP, commentaires : sans effet sur l'entrée
        } else {
            if summary.entries >= max_entries {
                summary.truncated = true;
                break;
            }
            let info = pending.take().unwrap_or_default();
            if let Some(entry) = build_entry(line, info, &mut taken, &mut seen, &mut summary) {
                summary.entries += 1;
                if !on_entry(entry) {
                    summary.stopped = true;
                    return Ok(summary);
                }
            }
        }
    }
    if pending.is_some_and(|p| p.from_extinf) {
        summary.skipped_invalid += 1;
    }
    Ok(summary)
}

enum LineRead {
    Line,
    TooLong,
    End,
}

/// Lit une ligne (jusqu'à `\n`) dans `buf`, sans jamais y garder plus de `MAX_LINE_BYTES` octets :
/// le reste d'une ligne trop longue est lu et jeté.
fn read_bounded_line<R: BufRead>(reader: &mut R, buf: &mut Vec<u8>) -> std::io::Result<LineRead> {
    let mut too_long = false;
    let mut read_any = false;
    loop {
        let available = match reader.fill_buf() {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        };
        if available.is_empty() {
            return Ok(if !read_any {
                LineRead::End
            } else if too_long {
                LineRead::TooLong
            } else {
                LineRead::Line
            });
        }
        read_any = true;
        let (chunk, found_end) = match available.iter().position(|&b| b == b'\n') {
            Some(i) => (&available[..i], i + 1),
            None => (available, 0),
        };
        if !too_long {
            if buf.len() + chunk.len() > MAX_LINE_BYTES {
                too_long = true;
                buf.clear();
            } else {
                buf.extend_from_slice(chunk);
            }
        }
        let used = if found_end > 0 { found_end } else { chunk.len() };
        reader.consume(used);
        if found_end > 0 {
            return Ok(if too_long { LineRead::TooLong } else { LineRead::Line });
        }
    }
}

fn starts_with_ignore_case(text: &str, prefix: &str) -> bool {
    text.len() >= prefix.len()
        && text.is_char_boundary(prefix.len())
        && text[..prefix.len()].eq_ignore_ascii_case(prefix)
}

/// Adresses de guide de l'en-tête : `url-tvg`, `x-tvg-url`, `tvg-url`, chacune pouvant en donner
/// plusieurs séparées par des virgules.
fn read_header(rest: &str, epg_urls: &mut Vec<String>) {
    let attrs = read_attributes(rest);
    for key in ["url-tvg", "x-tvg-url", "tvg-url"] {
        if let Some(value) = attrs.get(key) {
            for url in value.split(',') {
                let url = url.trim();
                if epg_urls.len() < MAX_EPG_URLS
                    && is_clean_http_url(url)
                    && url.len() <= MAX_URL_BYTES
                    && !epg_urls.iter().any(|u| u == url)
                {
                    epg_urls.push(url.to_string());
                }
            }
        }
    }
}

/// Lit la suite d'une ligne `#EXTINF` : `:<durée> attr="valeur" …,<nom>`.
fn read_extinf(rest: &str) -> Pending {
    let rest = rest.strip_prefix(':').unwrap_or(rest);
    let comma = find_name_comma(rest);
    let (head, name) = match comma {
        Some(i) => (&rest[..i], rest[i + 1..].trim()),
        None => (rest, ""),
    };
    Pending { name: name.to_string(), attrs: read_attributes(head), from_extinf: true, ..Pending::default() }
}

/// Position de la virgule qui sépare les attributs du nom : la première hors d'une valeur entre
/// guillemets. Une apostrophe n'ouvre une valeur que juste après `=` (`group-title='Rock, Pop'`) :
/// dans `tvg-name="L'Équipe"`, elle reste une lettre.
fn find_name_comma(text: &str) -> Option<usize> {
    let mut quote: Option<char> = None;
    let mut previous = ' ';
    for (i, c) in text.char_indices() {
        match quote {
            Some(q) if c == q => quote = None,
            Some(_) => {}
            None => match c {
                '"' => quote = Some('"'),
                '\'' if previous == '=' => quote = Some('\''),
                ',' => return Some(i),
                _ => {}
            },
        }
        previous = c;
    }
    None
}

/// Attributs `clé="valeur"`, `clé='valeur'` ou `clé=valeur` ; clés en minuscules. La durée en
/// tête (`-1`, `0`) n'est pas un attribut et est ignorée.
fn read_attributes(text: &str) -> HashMap<String, String> {
    let mut attrs = HashMap::new();
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        let key_start = i;
        while i < bytes.len() && !bytes[i].is_ascii_whitespace() && bytes[i] != b'=' {
            i += 1;
        }
        let key = &text[key_start..i];
        if i >= bytes.len() || bytes[i] != b'=' {
            // Mot sans valeur (la durée) : passé
            continue;
        }
        i += 1;
        let value = if i < bytes.len() && (bytes[i] == b'"' || bytes[i] == b'\'') {
            let quote = bytes[i];
            i += 1;
            let start = i;
            while i < bytes.len() && bytes[i] != quote {
                i += 1;
            }
            let v = &text[start..i];
            i += 1;
            v
        } else {
            let start = i;
            while i < bytes.len() && !bytes[i].is_ascii_whitespace() {
                i += 1;
            }
            &text[start..i]
        };
        if !key.is_empty() {
            attrs.insert(key.to_ascii_lowercase(), value.trim().to_string());
        }
    }
    attrs
}

fn is_http_url(url: &str) -> bool {
    starts_with_ignore_case(url, "http://") || starts_with_ignore_case(url, "https://")
}

/// Adresse `http`/`https` sans espace ni caractère de contrôle (le lecteur ne doit recevoir
/// qu'une adresse d'un seul tenant).
fn is_clean_http_url(url: &str) -> bool {
    is_http_url(url) && !url.chars().any(|c| c.is_control() || c.is_whitespace())
}

/// Schéma en minuscules (`HTTP://` → `http://`) : certains lecteurs comparent le nom du protocole
/// en respectant la casse.
fn lowercase_scheme(url: &str) -> String {
    match url.find("://") {
        Some(i) => format!("{}{}", url[..i].to_ascii_lowercase(), &url[i..]),
        None => url.to_string(),
    }
}

/// Espaces encodées en `%20` après l'hôte ; rien si l'hôte lui-même en contient (ligne qui n'est
/// pas une adresse).
fn encode_path_spaces(url: &str) -> Option<String> {
    if !url.contains(' ') {
        return Some(url.to_string());
    }
    let start = url.find("://").map_or(0, |i| i + 3);
    let host_end = url[start..].find(['/', '?', '#']).map_or(url.len(), |i| start + i);
    if url[..host_end].contains(' ') {
        return None;
    }
    Some(format!("{}{}", &url[..host_end], url[host_end..].replace(' ', "%20")))
}

/// Coupe à `max` caractères au plus.
fn truncate_chars(text: &str, max: usize) -> String {
    match text.char_indices().nth(max) {
        Some((i, _)) => text[..i].to_string(),
        None => text.to_string(),
    }
}

/// Valeur d'en-tête HTTP : sans caractère de contrôle (qui ouvrirait un autre en-tête), bornée,
/// vide = aucune.
fn clean_header(value: &str) -> Option<String> {
    let value = value.trim().trim_matches('"').trim();
    if value.is_empty() || value.chars().any(char::is_control) {
        return None;
    }
    Some(truncate_chars(value, MAX_HEADER_CHARS))
}

/// Forme `adresse|User-Agent=…&Referer=…` : l'adresse seule, et les en-têtes demandés.
fn split_pipe_headers(raw: &str) -> (&str, Option<String>, Option<String>) {
    let Some((url, options)) = raw.split_once('|') else {
        return (raw, None, None);
    };
    let mut user_agent = None;
    let mut referrer = None;
    for pair in options.split('&') {
        if let Some((name, value)) = pair.split_once('=') {
            let value = percent_decode(value);
            match name.trim().to_ascii_lowercase().as_str() {
                "user-agent" => user_agent = clean_header(&value),
                "referer" | "referrer" => referrer = clean_header(&value),
                _ => {}
            }
        }
    }
    (url, user_agent, referrer)
}

/// Décodage `%XX` d'une valeur ; une séquence invalide reste telle quelle.
fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok());
            if let Some(b) = hex {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Attribut non vide.
fn attr(attrs: &HashMap<String, String>, key: &str) -> Option<String> {
    attrs.get(key).map(|v| v.trim()).filter(|v| !v.is_empty()).map(str::to_string)
}

fn build_entry(
    raw: &str,
    info: Pending,
    taken: &mut HashSet<i64>,
    seen: &mut HashSet<u64>,
    summary: &mut M3uSummary,
) -> Option<M3uEntry> {
    let (url, pipe_agent, pipe_referrer) = split_pipe_headers(raw);
    // Espaces dans le chemin (listes faites à la main : `/films/Mon Film.mkv`) : encodées, le
    // lecteur reçoit une adresse d'un seul tenant
    let Some(encoded) = encode_path_spaces(url.trim()) else {
        summary.skipped_invalid += 1;
        return None;
    };
    let url = encoded.as_str();
    if !is_http_url(url) {
        if url.contains("://") {
            summary.skipped_scheme += 1;
        } else {
            summary.skipped_invalid += 1;
        }
        return None;
    }
    if !is_clean_http_url(url) || url.len() > MAX_URL_BYTES {
        summary.skipped_invalid += 1;
        return None;
    }
    let Some(parts) = UrlParts::parse(url) else {
        summary.skipped_invalid += 1;
        return None;
    };

    let tvg_name = attr(&info.attrs, "tvg-name");
    let tvg_name = tvg_name.map(|n| truncate_chars(&n, MAX_NAME_CHARS));
    let name = if !info.name.is_empty() {
        truncate_chars(&info.name, MAX_NAME_CHARS)
    } else if let Some(n) = &tvg_name {
        n.clone()
    } else {
        truncate_chars(&percent_decode(parts.file_stem()), MAX_NAME_CHARS)
    };
    let extension = parts.extension();
    let episode = parse_episode(&name);
    let kind = classify(&parts, extension.as_deref(), episode.is_some(), parse_year(&name).is_some());
    let episode = if kind == EntryKind::Episode { episode } else { None };
    let year = if kind == EntryKind::Live { None } else { parse_year(&name) };

    // Doublon sur l'adresse exacte : un paramètre classé à tort comme changeant ne fait alors qu'une
    // collision de numéros (rattrapée plus bas), jamais une chaîne perdue
    let key = parts.identity_hash();
    if !seen.insert(parts.exact_hash()) {
        summary.skipped_duplicate += 1;
        return None;
    }
    // Numéro Xtream déjà pris par une autre adresse (liste qui mêle plusieurs serveurs) : celui de
    // l'empreinte, qui ne dépend pas de l'ordre de la liste
    let id = match parts.xtream_number() {
        Some(n) if !taken.contains(&n) => n,
        _ => hash_id(key),
    };
    let id = if taken.contains(&id) {
        summary.id_collisions += 1;
        let Some(free) = next_free_id(id, taken) else {
            // Aucun numéro libre près de l'empreinte : entrée valable mais impossible à ranger
            summary.skipped_no_free_id += 1;
            return None;
        };
        free
    } else {
        id
    };
    taken.insert(id);

    let group = attr(&info.attrs, "group-title").or(info.group).unwrap_or_default();
    let group = truncate_chars(&group, MAX_GROUP_CHARS);
    let logo = attr(&info.attrs, "tvg-logo")
        .or_else(|| attr(&info.attrs, "logo"))
        .filter(|l| is_clean_http_url(l) && l.len() <= MAX_LOGO_BYTES);
    let chno = attr(&info.attrs, "tvg-chno")
        .or_else(|| attr(&info.attrs, "channel-number"))
        .and_then(|v| v.replace(',', ".").parse::<f64>().ok())
        .filter(|n| n.is_finite() && *n >= 0.0);

    Some(M3uEntry {
        id,
        kind,
        name,
        url: lowercase_scheme(url),
        group,
        logo,
        tvg_id: attr(&info.attrs, "tvg-id").map(|v| truncate_chars(&v, MAX_HEADER_CHARS)),
        tvg_name,
        chno,
        extension,
        episode,
        user_agent: pipe_agent.or(info.user_agent),
        referrer: pipe_referrer.or(info.referrer),
        year,
    })
}

/// Numéro libre suivant quand deux adresses différentes ont la même empreinte (très rare : de
/// l'ordre d'une chance sur dix milliards pour une liste de 100 000 entrées). Rien si la plage est
/// encombrée au point qu'aucun numéro proche n'est libre : l'entrée est alors sautée.
fn next_free_id(start: i64, taken: &HashSet<i64>) -> Option<i64> {
    let span = HASH_ID_END - HASH_ID_MIN;
    let mut candidate = start.clamp(HASH_ID_MIN, HASH_ID_END - 1);
    for _ in 0..MAX_ID_PROBES {
        candidate = HASH_ID_MIN + (candidate - HASH_ID_MIN + 1).rem_euclid(span);
        if !taken.contains(&candidate) {
            return Some(candidate);
        }
    }
    None
}

/// Numéro d'empreinte dans `[HASH_ID_MIN, HASH_ID_END)`.
pub(crate) fn hash_id(key: u64) -> i64 {
    let span = (HASH_ID_END - HASH_ID_MIN) as u64;
    HASH_ID_MIN + (key % span) as i64
}

/// FNV-1a sur 64 bits : stable entre versions, plateformes et lancements (contrairement au hachage
/// de la bibliothèque standard, qui change à chaque lancement).
pub(crate) fn fnv1a(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for &b in bytes {
        hash ^= u64::from(b);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// Morceaux d'une adresse `http(s)://hôte[:port]/chemin?paramètres#fragment`.
struct UrlParts<'a> {
    /// Hôte et port, en minuscules pour l'empreinte.
    authority: String,
    /// Chemin, sans paramètres ni fragment (commence par `/` ou vide).
    path: &'a str,
    /// Paramètres (après `?`, sans le fragment), vide si aucun.
    query: &'a str,
}

impl<'a> UrlParts<'a> {
    fn parse(url: &'a str) -> Option<Self> {
        let after_scheme = &url[url.find("://")? + 3..];
        let end_authority = after_scheme.find(['/', '?', '#']).unwrap_or(after_scheme.len());
        let authority = &after_scheme[..end_authority];
        // Identifiants éventuels avant `@` : hors de l'empreinte
        let host = authority.rsplit('@').next().unwrap_or(authority);
        if host.is_empty() {
            return None;
        }
        let rest = &after_scheme[end_authority..];
        let rest = rest.split('#').next().unwrap_or("");
        let (path, query) = rest.split_once('?').unwrap_or((rest, ""));
        Some(UrlParts { authority: host.to_ascii_lowercase(), path, query })
    }

    fn segments(&self) -> Vec<&'a str> {
        self.path.split('/').filter(|s| !s.is_empty()).collect()
    }

    fn last_segment(&self) -> &'a str {
        self.path.rsplit('/').find(|s| !s.is_empty()).unwrap_or("")
    }

    fn file_stem(&self) -> &'a str {
        let last = self.last_segment();
        match last.rfind('.') {
            Some(i) if i > 0 => &last[..i],
            _ => last,
        }
    }

    fn extension(&self) -> Option<String> {
        let last = self.last_segment();
        let i = last.rfind('.')?;
        let ext = &last[i + 1..];
        if ext.is_empty() || ext.len() > 5 || !ext.bytes().all(|b| b.is_ascii_alphanumeric()) {
            return None;
        }
        Some(ext.to_ascii_lowercase())
    }

    /// Sorte dite par le chemin des listes faites par un panneau Xtream : le morceau placé trois
    /// crans avant le numéro (`/live/u/p/123.ts`).
    fn type_segment(&self) -> Option<EntryKind> {
        let segments = self.segments();
        if segments.len() < 4 {
            return None;
        }
        match segments[segments.len() - 4].to_ascii_lowercase().as_str() {
            "live" => Some(EntryKind::Live),
            "movie" => Some(EntryKind::Movie),
            "series" => Some(EntryKind::Episode),
            _ => None,
        }
    }

    /// Numéro du fournisseur pour une adresse de forme Xtream : `/<type>/<u>/<p>/<n>[.ext]` avec
    /// `<type>` = live, movie ou series, ou `/<u>/<p>/<n>` sans extension, en `.ts` ou `.m3u8`
    /// (chaînes, chemin de trois morceaux exactement). Le numéro tient alors dans la plage des
    /// numéros Xtream.
    fn xtream_number(&self) -> Option<i64> {
        let segments = self.segments();
        let live_extension = matches!(self.extension().as_deref(), None | Some("ts") | Some("m3u8"));
        let shaped = (self.type_segment().is_some() && segments.len() == 4)
            || (segments.len() == 3 && live_extension);
        if !shaped {
            return None;
        }
        let stem = self.file_stem();
        if stem.is_empty() || stem.len() > 12 || !stem.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        stem.parse::<i64>().ok().filter(|n| *n > 0 && *n < HASH_ID_MIN)
    }

    /// Empreinte de l'adresse : hôte, chemin et paramètres qui désignent le contenu, triés ; sans
    /// les paramètres changeants (`VOLATILE_QUERY_KEYS`, `VOLATILE_QUERY_PREFIXES`), le fragment ni les identifiants avant `@`.
    /// Une adresse sans paramètre garde exactement l'empreinte « hôte + chemin ».
    fn identity_hash(&self) -> u64 {
        let mut text = String::with_capacity(self.authority.len() + self.path.len() + self.query.len());
        text.push_str(&self.authority);
        text.push_str(self.path);
        let mut kept: Vec<&str> = self
            .query
            .split('&')
            .filter(|pair| !pair.is_empty())
            .filter(|pair| {
                let name = pair.split('=').next().unwrap_or("");
                !is_volatile_query_key(name)
            })
            .collect();
        if !kept.is_empty() {
            kept.sort_unstable();
            text.push('?');
            text.push_str(&kept.join("&"));
        }
        fnv1a(text.as_bytes())
    }

    /// Empreinte de l'adresse exacte (hôte en minuscules, tous les paramètres dans leur ordre,
    /// sans fragment) : repère une adresse répétée dans la liste.
    fn exact_hash(&self) -> u64 {
        let mut text = String::with_capacity(self.authority.len() + self.path.len() + self.query.len() + 1);
        text.push_str(&self.authority);
        text.push_str(self.path);
        if !self.query.is_empty() {
            text.push('?');
            text.push_str(self.query);
        }
        fnv1a(text.as_bytes())
    }
}

/// Extensions d'un fichier vidéo (film ou épisode), par opposition à un flux en direct.
const VIDEO_FILE_EXTENSIONS: &[&str] =
    &["mp4", "mkv", "avi", "mov", "wmv", "m4v", "webm", "flv", "mpg", "mpeg", "3gp", "ogv", "divx", "xvid"];

/// Sorte d'une entrée. Sans type dans le chemin, un fichier vidéo est un film ou un épisode, et un
/// flux `.ts` une chaîne. Un flux HLS (`.m3u8`) ou une adresse sans extension est une chaîne, sauf si
/// son nom porte une marque d'épisode (épisode) ou une année entre parenthèses ou crochets (film) :
/// beaucoup de fournisseurs servent leurs films et leurs épisodes en `.m3u8`. Le groupe seul ne suffit
/// pas : les listes rangent aussi des chaînes de cinéma dans des groupes « Films ».
fn classify(parts: &UrlParts<'_>, extension: Option<&str>, has_episode_marker: bool, has_year: bool) -> EntryKind {
    if let Some(kind) = parts.type_segment() {
        return kind;
    }
    let is_video_file = extension.is_some_and(|e| VIDEO_FILE_EXTENSIONS.contains(&e));
    let maybe_on_demand = matches!(extension, None | Some("m3u8"));
    if !is_video_file && !(maybe_on_demand && (has_episode_marker || has_year)) {
        return EntryKind::Live;
    }
    if has_episode_marker {
        EntryKind::Episode
    } else {
        EntryKind::Movie
    }
}

/// Marque d'épisode dans un nom, sous les formes courantes des listes :
/// - `S01E03`, `s1e3`, `S01 E03`, `S01.E03`, `S01EP03`, `S01xE03`, `S01 Episode 03` ;
/// - `Saison 1 Épisode 3`, `Season 1 Episode 3`, `Saison 1 Ep 3` ;
/// - `1x03` : x minuscule et exactement deux chiffres après (« 4x4 », « 4x100 », « 1920x1080 » restent
///   des titres), et jamais dans un nom qui porte une année entre parenthèses (« Les 4x100 (2023) »).
/// Numéro d'épisode jusqu'à quatre chiffres (séries de plus de mille épisodes). La marque doit être
/// un mot à part : « BOSS01E02 » n'en est pas une.
fn episode_marker() -> &'static regex::Regex {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| {
        regex::Regex::new(
            r"(?xi)
            (?:^|[^\p{L}\p{N}])
            (?P<marker>
                s(?P<s1>[0-9]{1,2}) [\ ._x-]* (?:[ée]\p{Mn}?pisode|ep|e) [\ ._]* (?P<e1>[0-9]{1,4})
              | (?:saison|season) [\ ._]* (?P<s2>[0-9]{1,2}) [\ ,._-]* (?:[ée]\p{Mn}?pisode|ep|e) [\ ._]* (?P<e2>[0-9]{1,4})
              | (?P<s3>[0-9]{1,2}) (?-i:x) (?P<e3>[0-9]{2})
            )
            (?:$|[^\p{L}\p{N}])",
        )
        .expect("motif d'épisode valide")
    })
}

/// Série, saison et épisode tirés du nom (formes de `episode_marker`). Rien si le nom ne porte pas
/// de marque ou si le nom de série serait vide.
fn parse_episode(name: &str) -> Option<EpisodeInfo> {
    let caps = episode_marker().captures(name)?;
    let marker = caps.name("marker")?;
    let number = |a: &str, b: &str, c: &str| -> Option<u32> {
        caps.name(a).or_else(|| caps.name(b)).or_else(|| caps.name(c))?.as_str().parse().ok()
    };
    // `1x03` dans un nom de film daté : un titre, pas un épisode
    if caps.name("s3").is_some() && parse_year(name).is_some() {
        return None;
    }
    let season = number("s1", "s2", "s3")?;
    let episode = number("e1", "e2", "e3")?;
    let series_name = name[..marker.start()].trim_end_matches(|c: char| c.is_whitespace() || "-_.|:([".contains(c));
    let series_name = series_name.trim();
    if series_name.is_empty() {
        return None;
    }
    Some(EpisodeInfo { series_name: series_name.to_string(), season, episode })
}

/// Année entre parenthèses ou crochets dans le nom (la dernière), de 1900 à 2099.
fn parse_year(name: &str) -> Option<u32> {
    let bytes = name.as_bytes();
    let mut found = None;
    let mut i = 0;
    while i + 6 <= bytes.len() {
        let open = bytes[i];
        let close = bytes[i + 5];
        let paired = (open == b'(' && close == b')') || (open == b'[' && close == b']');
        if paired && bytes[i + 1..i + 5].iter().all(u8::is_ascii_digit) {
            let year: u32 = std::str::from_utf8(&bytes[i + 1..i + 5]).ok()?.parse().ok()?;
            if (1900..2100).contains(&year) {
                found = Some(year);
            }
        }
        i += 1;
    }
    found
}

#[cfg(test)]
#[path = "m3u_parser_tests.rs"]
mod tests;
