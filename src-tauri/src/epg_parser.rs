//! EPG Parser Module
//!
//! Télécharge et parse un fichier XMLTV gzippé, puis insère les programmes
//! dans la table `epg_programs` de la base SQLite.
//!
//! Isolation totale : AUCUN lien avec catalog_parser.rs ou ingestion.rs.

use crate::http::build_http_client;
use crate::storage::{catalog_deletion_pending, validate_catalog_db_name, sanitize_error_path, sanitize_url_for_log, SOURCE_CATALOG_DELETED};
use rusqlite::{params, Connection};
use std::io::BufReader;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Emitter, Manager};
use regex::Regex;

// =============================================================================
// ABORT FLAG — checked in download/parse/insert loops for true cancellation
// =============================================================================

static EPG_ABORT_FLAG: AtomicBool = AtomicBool::new(false);

/// Parse progress sent to the screen every N kept programs.
const PROGRESS_EVERY_PROGRAMS: usize = 5_000;
/// Abort checked every N XML events, even while every program is filtered out.
const ABORT_CHECK_EVERY_EVENTS: u64 = 65_536;
/// XML slips written one by one to the logs; beyond, only their total
const MAX_LOGGED_XML_SLIPS: usize = 5;
/// Largest guide file downloaded, same cap as the catalogue lists (catalog_refresh.rs); the
/// worldwide guide is ≈ 205 MB.
const MAX_EPG_DOWNLOAD_BYTES: u64 = 512 * 1024 * 1024;
/// Largest guide once decompressed (the worldwide guide is ≈ 2 GB).
const MAX_EPG_XML_BYTES: u64 = 8 * 1024 * 1024 * 1024;
/// Longest run of the XML without any "<" (a real description is a few KB).
const MAX_XML_RUN_BYTES: u64 = 16 * 1024 * 1024;
/// Longest title or channel name kept, and longest description (bytes).
const MAX_TITLE_BYTES: usize = 1024;
const MAX_DESC_BYTES: usize = 8 * 1024;
/// Most channels one guide may list. The worldwide guide lists ≈ 27 000; a trapped file with
/// millions of tiny `<channel>` (a few MB once compressed) used to fill the memory and kill the app.
/// Beyond, the guide is refused and the old one stays.
const MAX_EPG_CHANNELS: usize = 100_000;
/// Longest channel id kept (bytes), on `<channel id>` and `<programme channel>`. Real ids are a few
/// dozen characters ("France2.fr"); a longer one is ignored, its channel or program skipped.
const MAX_EPG_ID_BYTES: usize = 256;
/// One guide sync at a time (a reloaded page loses the app's own guard).
static EPG_RUNNING: AtomicBool = AtomicBool::new(false);
/// Temporary download file, in the app cache folder.
const EPG_DOWNLOAD_FILE: &str = "epg_download.tmp";

/// Contenu d'un événement texte XML (décodage de l'encodage du flux).
///
/// quick-xml 0.41 remonte les entités (`&amp;`, `&#233;`) dans des événements `GeneralRef`
/// distincts : un titre comme « Tom & Jerry » arrive en trois morceaux, d'où l'accumulation
/// dans le tampon plutôt qu'une affectation (sinon seul le dernier morceau était gardé).
fn decode_text(event: &quick_xml::events::BytesText<'_>) -> Option<String> {
    event.xml10_content().ok().map(|text| text.into_owned())
}

/// Texte correspondant à une entité : `&amp;` → `&`, `&#233;` → `é`.
/// Entité inconnue (fichiers XMLTV parfois approximatifs) : on la garde telle quelle.
fn decode_entity(event: &quick_xml::events::BytesRef<'_>) -> Option<String> {
    let name = event.decode().ok()?;
    if let Some(number) = name.strip_prefix('#') {
        let code = if let Some(hex) = number.strip_prefix('x').or_else(|| number.strip_prefix('X')) {
            u32::from_str_radix(hex, 16).ok()
        } else {
            number.parse::<u32>().ok()
        };
        return Some(match code.and_then(char::from_u32) {
            Some(c) => c.to_string(),
            None => format!("&{name};"),
        });
    }
    Some(match quick_xml::escape::resolve_predefined_entity(&name) {
        Some(text) => text.to_string(),
        None => format!("&{name};"),
    })
}

/// Ajoute un morceau de texte au champ en cours de lecture (titre, description, nom de chaîne).
#[allow(clippy::too_many_arguments)]
fn append_text(
    text: &str,
    reading_title: bool,
    reading_desc: bool,
    reading_display_name: bool,
    current_title: &mut String,
    current_desc: &mut Option<String>,
    current_channel_name: &mut String,
) {
    if reading_title {
        push_capped(current_title, text, MAX_TITLE_BYTES);
    } else if reading_desc {
        push_capped(current_desc.get_or_insert_with(String::new), text, MAX_DESC_BYTES);
    } else if reading_display_name {
        push_capped(current_channel_name, text, MAX_TITLE_BYTES);
    }
}

/// Adds `text` without going beyond `max` bytes (cut on a character boundary): a trapped guide
/// (endless title made of entities) cannot fill the memory.
fn push_capped(field: &mut String, text: &str, max: usize) {
    let room = max.saturating_sub(field.len());
    if room == 0 {
        return;
    }
    let mut end = text.len().min(room);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    field.push_str(&text[..end]);
}

/// Reader of the guide XML with two limits: total size once decompressed (a small gzip cannot
/// unpack into hundreds of GB), and length of a run without any "<" (one endless text or tag would
/// otherwise grow the XML reader buffer without limit).
struct BoundedXml<R> {
    inner: R,
    left: u64,
    run: u64,
}

impl<R> BoundedXml<R> {
    fn new(inner: R, max_total: u64) -> Self {
        Self { inner, left: max_total, run: 0 }
    }
}

impl<R: std::io::Read> std::io::Read for BoundedXml<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.inner.read(buf)?;
        if n as u64 > self.left {
            return Err(std::io::Error::other("EPG file too large once decompressed"));
        }
        self.left -= n as u64;
        self.run = match buf[..n].iter().rposition(|&b| b == b'<') {
            Some(pos) => (n - 1 - pos) as u64,
            None => self.run + n as u64,
        };
        if self.run > MAX_XML_RUN_BYTES {
            return Err(std::io::Error::other("EPG file holds an endless text"));
        }
        Ok(n)
    }
}

/// Tauri command: signal the Rust EPG sync to stop ASAP
#[tauri::command]
pub fn abort_epg_sync() {
    log::info!("[EPG] Abort requested by frontend");
    EPG_ABORT_FLAG.store(true, Ordering::Relaxed);
}

/// Tauri command: cancel a pending abort (user re-enabled EPG before Rust stopped)
#[tauri::command]
pub fn cancel_epg_abort() {
    log::info!("[EPG] Abort cancelled by frontend");
    EPG_ABORT_FLAG.store(false, Ordering::Relaxed);
}

/// Check if abort was requested
#[inline]
fn is_aborted() -> bool {
    EPG_ABORT_FLAG.load(Ordering::Relaxed)
}

// =============================================================================
// TYPES
// =============================================================================

/// Résultat de l'ingestion EPG retourné au frontend
#[derive(Debug, serde::Serialize)]
pub struct EpgIngestResult {
    pub programs_count: usize,
    pub channels_count: usize,
    pub duration_ms: u128,
    pub filtered_out: usize,
}

/// Programme EPG parsé depuis le XML
#[derive(Debug)]
struct EpgProgram {
    channel_id: String,
    title: String,
    start_ts: i64,
    stop_ts: i64,
    description: Option<String>,
}

/// Chaîne EPG parsée depuis le XML (Mapping)
#[derive(Debug)]
pub struct EpgChannel {
    pub id: String,
    pub display_name: String,
}

// =============================================================================
// TIMESTAMP PARSING
// =============================================================================

/// Parse un timestamp XMLTV au format "YYYYMMDDHHMMSS +HHMM" en epoch seconds UTC.
///
/// Formats supportés :
/// - "20260404170000 +0200"  (avec offset positif)
/// - "20260404170000 -0500"  (avec offset négatif)
/// - "20260404170000"        (sans offset → UTC)
/// - "202604041700 +0200"    (sans secondes → assume 00)
pub fn parse_xmltv_timestamp(s: &str) -> Result<i64, String> {
    let s = s.trim();
    if s.is_empty() {
        return Err("Empty timestamp".to_string());
    }

    // Split on space to separate datetime from optional offset
    let parts: Vec<&str> = s.splitn(2, ' ').collect();
    let datetime_str = parts[0];
    let offset_str = if parts.len() > 1 { parts[1].trim() } else { "" };

    // Parse datetime components. A provider date is untrusted: non-ASCII text used to panic on the
    // byte slices below (and stop the whole sync), a month 0 gave an absurd date.
    if datetime_str.len() < 12 || !datetime_str.is_ascii() {
        return Err(format!("Invalid timestamp: '{}'", datetime_str));
    }

    let year = timestamp_field(datetime_str, 0..4, "year", s)?;
    let month = timestamp_field(datetime_str, 4..6, "month", s)?;
    let day = timestamp_field(datetime_str, 6..8, "day", s)?;
    let hour = timestamp_field(datetime_str, 8..10, "hour", s)?;
    let minute = timestamp_field(datetime_str, 10..12, "minute", s)?;
    let second = if datetime_str.len() >= 14 {
        timestamp_field(datetime_str, 12..14, "second", s)?
    } else {
        0
    };
    if !(1..=12).contains(&month) || day < 1 || day > days_in_month(year, month) {
        return Err(format!("Invalid date in '{}'", s));
    }
    // 60: leap second, allowed by XMLTV
    if hour > 23 || minute > 59 || second > 60 {
        return Err(format!("Invalid time in '{}'", s));
    }

    // Convert to epoch using a simplified calendar calculation
    // days_from_epoch calculates days since 1970-01-01
    let epoch_days = days_from_civil(year, month, day);
    let epoch_secs: i64 =
        (epoch_days as i64) * 86400 + (hour as i64) * 3600 + (minute as i64) * 60 + (second as i64);

    // Parse timezone offset
    let offset_secs = if offset_str.is_empty() {
        0i64
    } else {
        parse_tz_offset(offset_str)?
    };

    // The timestamp in the XML is in local time with offset
    // To get UTC: utc = local - offset
    Ok(epoch_secs - offset_secs)
}

/// Digits `range` of an ASCII timestamp; signs and spaces refused ("-1" is not a month).
fn timestamp_field(datetime_str: &str, range: std::ops::Range<usize>, what: &str, s: &str) -> Result<i32, String> {
    datetime_str
        .get(range)
        .filter(|part| part.bytes().all(|b| b.is_ascii_digit()))
        .and_then(|part| part.parse().ok())
        .ok_or_else(|| format!("Invalid {} in '{}'", what, s))
}

fn days_in_month(year: i32, month: i32) -> i32 {
    match month {
        2 if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

/// Parse timezone offset string like "+0200" or "-0500" into seconds
fn parse_tz_offset(s: &str) -> Result<i64, String> {
    let sign: i64 = match s.get(0..1) {
        Some("+") => 1,
        Some("-") => -1,
        _ => return Err(format!("Invalid timezone offset: '{}'", s)),
    };
    let hours = timestamp_field(s, 1..3, "offset hours", s)? as i64;
    let minutes = timestamp_field(s, 3..5, "offset minutes", s)? as i64;
    if hours > 14 || minutes > 59 {
        return Err(format!("Invalid timezone offset: '{}'", s));
    }

    Ok(sign * (hours * 3600 + minutes * 60))
}

/// Civil date to days since 1970-01-01 (Howard Hinnant's algorithm)
fn days_from_civil(year: i32, month: i32, day: i32) -> i32 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u32;
    let m = month as u32;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + (day as u32) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe as i32 - 719468
}

// =============================================================================
// XML PARSING (internal, testable)
// =============================================================================

/// Parse XML streams directly (no full-memory decompression needed), collecting every program.
/// Kept for tests; the sync streams programs to SQLite instead (`parse_xml_stream`).
#[cfg(test)]
fn parse_xml_programs<R: std::io::BufRead>(
    reader_buf: R,
    estimated_size: u64,
) -> Result<(Vec<EpgProgram>, Vec<EpgChannel>, usize), String> {
    let mut programs = Vec::new();
    let (channels, _kept, filtered_out) = parse_xml_stream(reader_buf, estimated_size, |_, _| {}, |_| Ok(()), |p| {
        programs.push(p);
        Ok(())
    })?;
    Ok((programs, channels, filtered_out))
}

/// Parse XML streams directly, handing each kept program to `on_program` as soon as it is read.
/// Filters programs to the time window: (now - 1h) to (now + 7 days).
/// Streaming: the sync used to keep every program in memory
/// (≈ 1.9 million with the worldwide source, ≈ 800 MB on a Chromecast, which then killed the app).
/// `on_channels` is called once, with the guide channels read so far, just before the first program
/// (XMLTV lists every channel before the programs): the sync uses it to keep only the programs of the
/// user's own channels.
/// `on_progress(percent, kept)` is called once every `PROGRESS_EVERY_PROGRAMS` kept programs.
/// A file that is cut (XML or gzip error, no closing `</tv>`) is an error: the sync then keeps the
/// old guide instead of a half-empty one announced as complete.
/// Returns (channels, kept programs, filtered out).
fn parse_xml_stream<R, P, C, F>(
    reader_buf: R,
    estimated_size: u64,
    mut on_progress: P,
    mut on_channels: C,
    mut on_program: F,
) -> Result<(Vec<EpgChannel>, usize, usize), String>
where
    R: std::io::BufRead,
    P: FnMut(u32, usize),
    C: FnMut(&[EpgChannel]) -> Result<(), String>,
    F: FnMut(EpgProgram) -> Result<(), String>,
{
    use quick_xml::events::Event;
    use quick_xml::Reader;

    let mut reader = Reader::from_reader(reader_buf);
    // Text not trimmed piece by piece: an entity or a stray "&" splits a title in several pieces, and
    // trimming each one lost the spaces around it ("Tom & Jerry" became "Tom&Jerry"). Each field is
    // trimmed once complete.
    reader.config_mut().trim_text(false);
    // The worldwide guide gathers many sources: a stray "&" in a title ("Tom & Jerry") or a badly
    // closed tag somewhere must not refuse the whole file now that XML errors are fatal.
    // Only a real cut (read or gzip error, no closing </tv>) stops the sync.
    reader.config_mut().allow_dangling_amp = true;
    reader.config_mut().check_end_names = false;
    // An end tag in excess ("</title></title>") shifts the nesting: the closing </tv> then has no
    // opening tag left and used to fail the whole guide. Tags are handled by name, not depth.
    reader.config_mut().allow_unmatched_ends = true;

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let window_start = now - 3600; // 1 hour ago
    let window_end = now + 604800; // +7 days

    let mut kept: usize = 0;
    let mut channels: Vec<EpgChannel> = Vec::with_capacity(5000);
    let mut filtered_out: usize = 0;

    // SAX state
    let mut in_programme = false;
    let mut current_channel = String::new();
    let mut current_start: i64 = 0;
    let mut current_stop: i64 = 0;
    let mut current_title = String::new();
    let mut current_desc: Option<String> = None;
    let mut reading_title = false;
    let mut reading_desc = false;

    let mut in_channel = false;
    let mut current_channel_def_id = String::new();
    let mut current_channel_name = String::new();
    let mut reading_display_name = false;

    let mut buf = Vec::with_capacity(4096);
    let mut channels_announced = false;
    let mut complete = false;
    // Progress sent once per step (the test ran on every XML event, same step sent in bursts)
    let mut last_reported: usize = 0;
    let mut events: u64 = 0;
    let mut ill_formed: usize = 0;
    let mut last_ill_formed_at: u64 = 0;

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) => {
                match e.name().as_ref() {
                    b"programme" => {
                        if !channels_announced {
                            channels_announced = true;
                            on_channels(&channels)?;
                        }
                        in_programme = true;
                        // A badly closed title or description of the previous program stops here
                        reading_title = false;
                        reading_desc = false;
                        current_channel.clear();
                        current_start = 0;
                        current_stop = 0;
                        current_title.clear();
                        current_desc = None;

                        // Read attributes: start, stop, channel
                        for attr in e.attributes().flatten() {
                            match attr.key.as_ref() {
                                b"start" => {
                                    let val = String::from_utf8_lossy(&attr.value);
                                    current_start =
                                        parse_xmltv_timestamp(&val).unwrap_or(0);
                                }
                                b"stop" => {
                                    let val = String::from_utf8_lossy(&attr.value);
                                    current_stop =
                                        parse_xmltv_timestamp(&val).unwrap_or(0);
                                }
                                // Oversized id: left empty, the program is then filtered out
                                b"channel" if attr.value.len() <= MAX_EPG_ID_BYTES => {
                                    current_channel =
                                        String::from_utf8_lossy(&attr.value).to_string();
                                }
                                _ => {}
                            }
                        }
                    }
                    b"channel" => {
                        in_channel = true;
                        current_channel_def_id.clear();
                        current_channel_name.clear();
                        for attr in e.attributes().flatten() {
                            // Oversized id: left empty, the channel is then skipped
                            if attr.key.as_ref() == b"id" && attr.value.len() <= MAX_EPG_ID_BYTES {
                                current_channel_def_id =
                                    String::from_utf8_lossy(&attr.value).to_string();
                            }
                        }
                    }
                    // Plusieurs <display-name> possibles : seul le premier est retenu
                    b"display-name" if in_channel && current_channel_name.is_empty() => {
                        reading_display_name = true;
                    }
                    b"title" if in_programme => {
                        reading_title = true;
                        reading_desc = false;
                    }
                    b"desc" if in_programme => {
                        reading_desc = true;
                        reading_title = false;
                    }
                    // Another element (category, credits…): its text is not part of the title or
                    // description, even when their end tag is misspelt (check_end_names is off)
                    _ if in_programme => {
                        reading_title = false;
                        reading_desc = false;
                    }
                    _ => {}
                }
            }
            // Spaces between tags are not decoded (trim_text is off): only a field being read is
            Ok(Event::Text(ref e)) if reading_title || reading_desc || reading_display_name => {
                if let Some(text) = decode_text(e) {
                    append_text(
                        &text,
                        reading_title,
                        reading_desc,
                        reading_display_name,
                        &mut current_title,
                        &mut current_desc,
                        &mut current_channel_name,
                    );
                }
            }
            Ok(Event::GeneralRef(ref e)) if reading_title || reading_desc || reading_display_name => {
                if let Some(text) = decode_entity(e) {
                    append_text(
                        &text,
                        reading_title,
                        reading_desc,
                        reading_display_name,
                        &mut current_title,
                        &mut current_desc,
                        &mut current_channel_name,
                    );
                }
            }
            Ok(Event::End(ref e)) => {
                match e.name().as_ref() {
                    b"title" => reading_title = false,
                    b"desc" => reading_desc = false,
                    // A </programme> in excess: the program was already handed over
                    b"programme" if in_programme => {
                        in_programme = false;
                        reading_title = false;
                        reading_desc = false;

                        let trimmed = current_title.trim();
                        if trimmed.len() != current_title.len() {
                            current_title = trimmed.to_string();
                        }
                        if let Some(desc) = current_desc.as_mut() {
                            let trimmed = desc.trim();
                            if trimmed.len() != desc.len() {
                                *desc = trimmed.to_string();
                            }
                        }
                        if current_desc.as_deref() == Some("") {
                            current_desc = None;
                        }

                        // Filter: only keep programs in the time window
                        if current_stop > window_start && current_start < window_end
                            && !current_channel.is_empty()
                            && !current_title.is_empty()
                            && current_start > 0
                            && current_stop > 0
                        {
                            on_program(EpgProgram {
                                channel_id: std::mem::take(&mut current_channel),
                                title: std::mem::take(&mut current_title),
                                start_ts: current_start,
                                stop_ts: current_stop,
                                description: current_desc.take(),
                            })?;
                            kept += 1;
                        } else {
                            filtered_out += 1;
                        }
                    }
                    b"channel" => {
                        in_channel = false;
                        reading_display_name = false;
                        if !current_channel_def_id.is_empty() {
                            if channels.len() >= MAX_EPG_CHANNELS {
                                log::warn!("[EPG] Guide above {} channels: refused, old guide kept", MAX_EPG_CHANNELS);
                                return Err(format!(
                                    "EPG: the guide received lists more than {} channels, old guide kept",
                                    MAX_EPG_CHANNELS
                                ));
                            }
                            channels.push(EpgChannel {
                                id: std::mem::take(&mut current_channel_def_id),
                                display_name: std::mem::take(&mut current_channel_name).trim().to_string(),
                            });
                        }
                    }
                    b"display-name" => reading_display_name = false,
                    b"tv" => complete = true,
                    _ => {}
                }
            }
            Ok(Event::Eof) => break,
            // Not well-formed, but nothing is lost (DOCTYPE without name): quick_xml skipped the
            // faulty markup and can go on. A cut file ends in
            // a syntax or read error instead, still fatal below.
            Err(quick_xml::Error::IllFormed(e)) if reader.buffer_position() > last_ill_formed_at => {
                last_ill_formed_at = reader.buffer_position();
                ill_formed += 1;
                if ill_formed <= MAX_LOGGED_XML_SLIPS {
                    log::warn!("[EPG] XML slip skipped after {} programs: {}", kept, e);
                }
            }
            Err(e) => {
                // quick_xml state is undefined after an error (looping never ends). A cut download
                // or gzip stream lands here: the programs read so far are not a complete guide.
                log::warn!("[EPG] XML parse error after {} programs: {}", kept, e);
                return Err(format!("EPG file unreadable after {} programs: {}", kept, e));
            }
            _ => {}
        }
        buf.clear();
        events += 1;

        // Abort also checked while programs are filtered out (kept then stays the same)
        if events.is_multiple_of(ABORT_CHECK_EVERY_EVENTS) && is_aborted() {
            log::info!("[EPG] Parse aborted by user after {} programs", kept);
            return Err("EPG sync aborted by user".to_string());
        }

        if kept > last_reported && kept.is_multiple_of(PROGRESS_EVERY_PROGRAMS) {
            last_reported = kept;
            if is_aborted() {
                log::info!("[EPG] Parse aborted by user after {} programs", kept);
                return Err("EPG sync aborted by user".to_string());
            }

            let pos = reader.buffer_position();
            // Handle div by zero if estimated_size is 0
            let pct = if estimated_size > 0 {
                (pos as f64 / estimated_size as f64 * 100.0) as u32
            } else { 0 };
            on_progress(pct.min(99), kept);
        }
    }

    if ill_formed > MAX_LOGGED_XML_SLIPS {
        log::warn!("[EPG] {} XML slips skipped in all", ill_formed);
    }

    if !complete {
        log::warn!("[EPG] Guide file ends without </tv> after {} programs: cut download", kept);
        return Err(format!("EPG file incomplete (cut after {} programs)", kept));
    }

    Ok((channels, kept, filtered_out))
}

// =============================================================================
// DATABASE INSERT
// =============================================================================

/// Writes programs to SQLite in batches WHILE the XML is parsed:
/// memory stays flat instead of holding every program until the end.
/// The new guide is written aside, in `epg_programs_staging`, and replaces the old one only in
/// `finish`, once the whole file was read and holds programs: a cut download, an empty
/// answer or an error page keeps the old guide, which stays on screen during the whole sync.
/// Batches stay small transactions, so the rest of the app can still write to the database.
struct ProgramWriter<'a> {
    conn: &'a Connection,
    batch: Vec<EpgProgram>,
    inserted: usize,
    /// Rows whose write failed (they used to be counted as written)
    failed: usize,
    channel_ids: std::collections::HashSet<String>,
    /// Guide channels linked to the user's own channels (None = keep everything)
    keep: Option<std::collections::HashSet<String>>,
    skipped: usize,
    /// Programs handed to the staging table so far (after the channel filter, duplicates included),
    /// bounded by `max_programs`
    accepted: usize,
    max_programs: usize,
    swapped: bool,
}

/// Most programs one guide may bring (without a cap, a huge guide could fill the disk and the memory).
/// The worldwide guide holds ≈ 1.9 million programs in the window (−1 h to +7 days), all channels together, and
/// far fewer once limited to the user's channels: real guides stay well below, the guide screen loses
/// nothing. A trapped or broken source with more is refused before it fills the staging table and the
/// disk, and the old guide stays.
const MAX_EPG_PROGRAMS: usize = 5_000_000;

/// Beyond this share of rows that could not be written, the new guide is refused (old one kept).
const MAX_FAILED_WRITES_RATIO: f64 = 0.01;

/// True when too many of `attempted` writes failed.
fn too_many_failures(failed: usize, attempted: usize) -> bool {
    failed > 0 && failed as f64 > attempted as f64 * MAX_FAILED_WRITES_RATIO
}

impl<'a> ProgramWriter<'a> {
    const BATCH_SIZE: usize = 5_000;

    /// Starts a new staging table (a leftover of a killed sync is dropped first).
    fn new(conn: &'a Connection) -> Result<Self, String> {
        conn.execute_batch(crate::schema::EPG_PROGRAMS_STAGING)
            .map_err(|e| format!("Failed to create EPG staging table: {}", e))?;
        Ok(Self {
            conn,
            batch: Vec::with_capacity(Self::BATCH_SIZE),
            inserted: 0,
            failed: 0,
            channel_ids: Default::default(),
            keep: None,
            skipped: 0,
            accepted: 0,
            max_programs: MAX_EPG_PROGRAMS,
            swapped: false,
        })
    }

    fn set_filter(&mut self, keep: Option<std::collections::HashSet<String>>) {
        self.keep = keep;
    }

    fn push(&mut self, program: EpgProgram) -> Result<(), String> {
        if let Some(keep) = &self.keep {
            if !keep.contains(&program.channel_id) {
                self.skipped += 1;
                return Ok(());
            }
        }
        if self.accepted >= self.max_programs {
            log::warn!("[EPG] Guide above {} programs: refused, old guide kept", self.max_programs);
            return Err(format!("EPG: the guide received holds more than {} programs, old guide kept", self.max_programs));
        }
        if !self.channel_ids.contains(&program.channel_id) {
            // Without a channel filter (no guide channel linked yet), a trapped guide could give each
            // program its own channel: same cap as the channel list
            if self.channel_ids.len() >= MAX_EPG_CHANNELS {
                log::warn!("[EPG] Programs for more than {} channels: refused, old guide kept", MAX_EPG_CHANNELS);
                return Err(format!("EPG: the guide received has programs for more than {} channels, old guide kept", MAX_EPG_CHANNELS));
            }
            self.channel_ids.insert(program.channel_id.clone());
        }
        self.accepted += 1;
        self.batch.push(program);
        if self.batch.len() >= Self::BATCH_SIZE {
            self.flush()?;
        }
        Ok(())
    }

    fn flush(&mut self) -> Result<(), String> {
        if is_aborted() {
            log::info!("[EPG] Insert aborted by user after {} programs", self.inserted);
            return Err("EPG sync aborted by user".to_string());
        }
        if self.batch.is_empty() {
            return Ok(());
        }
        let tx = self
            .conn
            .unchecked_transaction()
            .map_err(|e| format!("Failed to begin transaction: {}", e))?;
        let mut written = 0;
        let mut failed = 0;
        {
            let mut stmt = tx
                .prepare_cached(
                    "INSERT OR REPLACE INTO epg_programs_staging (channel_id, title, start_ts, stop_ts, description)
                     VALUES (?, ?, ?, ?, ?)",
                )
                .map_err(|e| format!("Failed to prepare EPG statement: {}", e))?;
            for p in &self.batch {
                match stmt.execute(params![p.channel_id, p.title, p.start_ts, p.stop_ts, p.description]) {
                    Ok(_) => written += 1,
                    Err(e) => {
                        if failed == 0 {
                            log::warn!("[EPG] Program write failed: {}", e);
                        }
                        failed += 1;
                    }
                }
            }
        }
        tx.commit().map_err(|e| format!("Failed to commit EPG batch: {}", e))?;
        self.inserted += written;
        self.failed += failed;
        self.batch.clear();
        Ok(())
    }

    /// Last batch, checks, then the new guide replaces the old one in one short transaction.
    /// Refused (old guide kept): no program at all (empty answer, error page), too many
    /// failed writes, abort requested.
    fn finish(mut self) -> Result<(usize, usize), String> {
        self.flush()?;
        if too_many_failures(self.failed, self.inserted + self.failed) {
            return Err(format!(
                "EPG: {} of {} programs could not be written, old guide kept",
                self.failed,
                self.inserted + self.failed
            ));
        }
        if self.failed > 0 {
            log::warn!("[EPG] {} programs could not be written (of {})", self.failed, self.inserted + self.failed);
        }
        if self.inserted == 0 {
            log::warn!("[EPG] New guide without any program: old guide kept");
            return Err("EPG: the guide received holds no program, old guide kept".to_string());
        }
        if is_aborted() {
            return Err("EPG sync aborted by user".to_string());
        }
        let tx = self
            .conn
            .unchecked_transaction()
            .map_err(|e| format!("Failed to begin EPG swap: {}", e))?;
        tx.execute_batch(
            "DROP TABLE IF EXISTS epg_programs;
             ALTER TABLE epg_programs_staging RENAME TO epg_programs;",
        )
        .map_err(|e| format!("Failed to replace the EPG guide: {}", e))?;
        // Indexes of the new table (dropped with the old one)
        tx.execute_batch(crate::schema::EPG_TABLES)
            .map_err(|e| format!("Failed to index the EPG guide: {}", e))?;
        // Channels kept, recorded with the guide they describe (flag_guide_if_links_lack_programs)
        tx.execute("DELETE FROM epg_kept_channels", [])
            .map_err(|e| format!("Failed to clear kept EPG channels: {}", e))?;
        if let Some(keep) = &self.keep {
            let mut insert = tx
                .prepare_cached("INSERT OR IGNORE INTO epg_kept_channels (id) VALUES (?)")
                .map_err(|e| format!("Failed to prepare kept EPG channels: {}", e))?;
            for id in keep {
                insert
                    .execute(params![id])
                    .map_err(|e| format!("Failed to write kept EPG channels: {}", e))?;
            }
        }
        tx.execute(
            "INSERT OR REPLACE INTO meta (key, value) VALUES ('epg_filtered', ?)",
            params![if self.keep.is_some() { "1" } else { "0" }],
        )
        .map_err(|e| format!("Failed to write EPG state: {}", e))?;
        tx.execute("DELETE FROM meta WHERE key = 'epg_needs_resync'", [])
            .map_err(|e| format!("Failed to write EPG state: {}", e))?;
        // Written with the guide: the app may no longer be on this account when the sync ends,
        // and a guide in place must not be downloaded again at the next start
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        tx.execute(
            "INSERT OR REPLACE INTO meta (key, value) VALUES ('epg_sync_status', 'complete'), ('last_epg_sync', ?1)",
            params![now_ms.to_string()],
        )
        .map_err(|e| format!("Failed to write EPG state: {}", e))?;
        tx.commit().map_err(|e| format!("Failed to commit the new EPG guide: {}", e))?;
        self.swapped = true;
        Ok((self.inserted, self.channel_ids.len()))
    }
}

impl Drop for ProgramWriter<'_> {
    /// A refused or failed guide leaves no staging table behind (≈ the size of a guide).
    fn drop(&mut self) {
        if !self.swapped {
            let _ = self.conn.execute("DROP TABLE IF EXISTS epg_programs_staging", []);
        }
    }
}

/// Guide channels linked to the user's own live channels, computed from the channels of the guide
/// being read (the worldwide guide holds ≈ 1.9 million programs, ≈ 60 % of them
/// for channels no provider channel of this user uses). Each device keeps only what its own provider
/// needs, so the guide adapts to every user. None (keep everything) when nothing is linked yet, e.g.
/// before the first catalogue load.
fn linked_guide_channels(
    conn: &Connection,
    channels: &[EpgChannel],
    app: Option<&tauri::AppHandle>,
) -> Result<Option<std::collections::HashSet<String>>, String> {
    if channels.is_empty() {
        // Guide without channel list: refused after reading (fetch_and_parse_epg), links untouched
        return Ok(None);
    }
    insert_epg_channels(conn, channels)?;
    build_epg_mapping(conn, app);
    let mut stmt = conn
        .prepare("SELECT DISTINCT matched_epg_id FROM live WHERE matched_epg_id IS NOT NULL")
        .map_err(|e| format!("Failed to read EPG links: {}", e))?;
    let linked: std::collections::HashSet<String> = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| format!("Failed to read EPG links: {}", e))?
        .filter_map(Result::ok)
        .collect();
    if linked.is_empty() {
        log::info!("[EPG] No channel linked yet: keeping the whole guide");
        return Ok(None);
    }
    log::info!("[EPG] Keeping programs of {} linked guide channels (of {})", linked.len(), channels.len());
    Ok(Some(linked))
}

/// After a remap (catalogue refresh, provider change): a guide written for other channels lacks the
/// programs of newly linked ones. Flag it; the next auto-sync (epgService.checkAndAutoSync) reloads it.
/// Compared with the channels kept at the last sync, not with programs: a kept channel can have no
/// program this week (Chromecast: 483 of 3 890), and that must not reload the guide every time.
fn flag_guide_if_links_lack_programs(conn: &Connection) {
    let missing = linked_channels_missing_from_guide(conn);
    if missing > 0 {
        log::info!("[EPG] {} newly linked guide channels were not kept: guide to reload", missing);
        set_guide_needs_resync(conn);
    }
}

/// Linked guide channels whose programs were not kept at the last sync (0 when the guide keeps
/// every channel).
fn linked_channels_missing_from_guide(conn: &Connection) -> i64 {
    let filtered: bool = conn
        .query_row("SELECT value FROM meta WHERE key = 'epg_filtered'", [], |r| r.get::<_, String>(0))
        .map(|v| v == "1")
        .unwrap_or(false);
    if !filtered {
        return 0;
    }
    conn.query_row(
        "SELECT COUNT(DISTINCT l.matched_epg_id) FROM live l WHERE l.matched_epg_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM epg_kept_channels k WHERE k.id = l.matched_epg_id)",
        [],
        |r| r.get(0),
    )
    .unwrap_or(0)
}

fn set_guide_needs_resync(conn: &Connection) {
    let _ = conn.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('epg_needs_resync', '1')", []);
}

/// Background catalogue refresh (every 12 h): a few new channels without programs must not reload
/// the whole guide (≈ 205 MB, 562 MB peak seen on the Chromecast) at almost every start. The guide
/// is flagged only from `min_missing` channels, or when it is older than `max_guide_age_ms`;
/// otherwise the channels get their programs at the next normal guide update. The count is kept in
/// `meta.epg_missing_links` for the logs. Returns true when the guide was flagged.
pub fn flag_guide_if_many_links_lack_programs(conn: &Connection, now_ms: i64, min_missing: i64, max_guide_age_ms: i64) -> bool {
    let missing = linked_channels_missing_from_guide(conn);
    let _ = conn.execute(
        "INSERT OR REPLACE INTO meta (key, value) VALUES ('epg_missing_links', ?1)",
        params![missing.to_string()],
    );
    if missing == 0 {
        return false;
    }
    let last_sync_ms: Option<i64> = conn
        .query_row("SELECT value FROM meta WHERE key = 'last_epg_sync'", [], |r| r.get::<_, String>(0))
        .ok()
        .and_then(|v| v.trim().parse::<i64>().ok());
    let guide_old = last_sync_ms.is_none_or(|t| now_ms - t > max_guide_age_ms);
    if missing >= min_missing || guide_old {
        log::info!("[EPG] {} linked guide channels without programs: guide to reload", missing);
        set_guide_needs_resync(conn);
        true
    } else {
        log::info!("[EPG] {} linked guide channels without programs: left for the next guide update", missing);
        false
    }
}

fn insert_epg_channels(
    conn: &Connection,
    channels: &[EpgChannel],
) -> Result<usize, String> {
    const BATCH_SIZE: usize = 15_000;
    let mut total_inserted: usize = 0;
    let mut failed: usize = 0;
    #[cfg(test)]
    tests::CHANNEL_WRITES.with(|n| n.set(n.get() + 1));

    conn.execute("DELETE FROM epg_channels", [])
        .map_err(|e| format!("Failed to clear epg_channels: {}", e))?;

    for chunk in channels.chunks(BATCH_SIZE) {
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| format!("Failed to begin transaction for channels: {}", e))?;

        {
            let mut stmt = tx
                .prepare_cached(
                    "INSERT OR REPLACE INTO epg_channels (id, display_name)
                     VALUES (?, ?)",
                )
                .map_err(|e| format!("Failed to prepare epg_channels stmt: {}", e))?;

            for c in chunk {
                match stmt.execute(params![c.id, c.display_name]) {
                    Ok(_) => total_inserted += 1,
                    Err(e) => {
                        if failed == 0 {
                            log::warn!("[EPG] Guide channel write failed: {}", e);
                        }
                        failed += 1;
                    }
                }
            }
        }

        tx.commit()
            .map_err(|e| format!("Failed to commit epg_channels batch: {}", e))?;
    }

    // Lost channels also lose their links to the user's channels
    if too_many_failures(failed, channels.len()) {
        return Err(format!("EPG: {} of {} guide channels could not be written", failed, channels.len()));
    }
    if failed > 0 {
        log::warn!("[EPG] {} guide channels could not be written (of {})", failed, channels.len());
    }
    Ok(total_inserted)
}

// =============================================================================
// MATCHING ENGINE
// =============================================================================

/// Supprime les diacritiques/accents courants (sans dépendance externe).
/// "Cinéma" → "Cinema", "Série" → "Serie", "Télé" → "Tele"
pub(crate) fn strip_accents(s: &str) -> String {
    s.chars().map(|c| match c {
        'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' => 'a',
        'è' | 'é' | 'ê' | 'ë' => 'e',
        'ì' | 'í' | 'î' | 'ï' => 'i',
        'ò' | 'ó' | 'ô' | 'õ' | 'ö' => 'o',
        'ù' | 'ú' | 'û' | 'ü' => 'u',
        'ý' | 'ÿ' => 'y',
        'ñ' => 'n',
        'ç' => 'c',
        'æ' => 'a', // simplification
        'œ' => 'o', // simplification
        'ð' => 'd',
        'ß' => 's',
        'À' | 'Á' | 'Â' | 'Ã' | 'Ä' | 'Å' => 'a',
        'È' | 'É' | 'Ê' | 'Ë' => 'e',
        'Ì' | 'Í' | 'Î' | 'Ï' => 'i',
        'Ò' | 'Ó' | 'Ô' | 'Õ' | 'Ö' => 'o',
        'Ù' | 'Ú' | 'Û' | 'Ü' => 'u',
        'Ý' => 'y',
        'Ñ' => 'n',
        'Ç' => 'c',
        _ => c,
    }).collect()
}

fn clean_name(name: &str) -> String {
    static RE_PUNCT: OnceLock<Regex> = OnceLock::new();
    static RE_QUALITIES: OnceLock<Regex> = OnceLock::new();
    static RE_SPACE: OnceLock<Regex> = OnceLock::new();
    static RE_SEMANTIC: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
    static RE_PREFIXES: OnceLock<Vec<Regex>> = OnceLock::new();
    static RE_PLURAL: OnceLock<Regex> = OnceLock::new();
    static RE_TRAILING_S: OnceLock<Regex> = OnceLock::new();

    // Remplacer tout ce qui n'est pas lettre ou chiffre par un espace
    let re_punct = RE_PUNCT.get_or_init(|| Regex::new(r"[^\p{L}\p{N}]+").unwrap());
    
    // Supprimer les mots parasites de qualité et résolutions
    let re_qualities = RE_QUALITIES.get_or_init(|| 
        Regex::new(r"(?i)\b(fhd|uhd|4k|8k|hd|sd|hevc|h264|h265|hq|vip|vod|1080p|720p|50fps|60fps|tv|local|ch|channel|network)\b").unwrap()
    );
    
    // Sémantique: Remplacer les numéros lettrés
    let re_semantic = RE_SEMANTIC.get_or_init(|| vec![
        (Regex::new(r"(?i)\b(?:un|une)\b").unwrap(), "1"),
        (Regex::new(r"(?i)\bdeux\b").unwrap(), "2"),
        (Regex::new(r"(?i)\btrois\b").unwrap(), "3"),
        (Regex::new(r"(?i)\bquatre\b").unwrap(), "4"),
        (Regex::new(r"(?i)\bcinq\b").unwrap(), "5"),
    ]);

    let re_space = RE_SPACE.get_or_init(|| Regex::new(r"\s+").unwrap());

    // 0. Convertir les caractères Unicode superscript en ASCII (IPTV providers)
    // ᴴᴰ → HD, ᵁᴴᴰ → UHD, ˢᴰ → SD, ᶠᴴᴰ → FHD
    let mut cleaned = name.to_string();
    cleaned = cleaned
        .replace('ᴬ', "A").replace('ᴮ', "B").replace('ᴰ', "D").replace('ᴱ', "E")
        .replace('ᴳ', "G").replace('ᴴ', "H").replace('ᴵ', "I").replace('ᴶ', "J")
        .replace('ᴷ', "K").replace('ᴸ', "L").replace('ᴹ', "M").replace('ᴺ', "N")
        .replace('ᴼ', "O").replace('ᴾ', "P").replace('ᴿ', "R").replace('ˢ', "S")
        .replace('ᵀ', "T").replace('ᵁ', "U").replace('ⱽ', "V").replace('ᵂ', "W")
        .replace('ᶠ', "F");
    
    // 1. Lowercase + symboles spéciaux
    cleaned = cleaned.to_lowercase();
    cleaned = cleaned.replace("+", "plus");
    cleaned = cleaned.replace("&", "et");

    // 1.1. Supprimer les suffixes pluriels optionnels: "Cinéma(s)" → "Cinéma"
    let re_plural = RE_PLURAL.get_or_init(|| Regex::new(r"\(s\)").unwrap());
    cleaned = re_plural.replace_all(&cleaned, "").to_string();

    // 1.2. Supprimer les accents/diacritiques AVANT le nettoyage
    // "ciné" → "cine", "série" → "serie"
    cleaned = strip_accents(&cleaned);

    // 1.5. Supprimer les préfixes géo/providers parasites
    // Gère IPTV ("FR | TF1") et EPG display_names ("FR: Ciné Nanar", "FR:.Ciné.Nanar.be")
    let re_prefixes = RE_PREFIXES.get_or_init(|| vec![
        Regex::new(r"^(?:[a-z]{2,3})\s*[:\|\-]\s*\.?\s*").unwrap(), // "fr | ", "uk: ", "fr:.", "fr:. "
        Regex::new(r"^\[[a-z]{2,3}\]\s*").unwrap(),          // "[fr] "
        Regex::new(r"^\([a-z]{2,3}\)\s*").unwrap(),          // "(fr) "
    ]);
    for re in re_prefixes {
        cleaned = re.replace(&cleaned, "").to_string();
    }

    // 2. Traduction des mots sémantiques ("un" -> "1")
    for (re, replacement) in re_semantic {
        cleaned = re.replace_all(&cleaned, *replacement).to_string();
    }
    // 3. Transformer toute ponctuation en espace
    cleaned = re_punct.replace_all(&cleaned, " ").to_string();
    // 4. Purger les tags non-sémantiques
    cleaned = re_qualities.replace_all(&cleaned, " ").to_string();
    
    // 4.1. Supprimer le "s" isole residuel (de "CINEMA.S" -> "cinema s" -> "cinema")
    let re_trailing_s = RE_TRAILING_S.get_or_init(|| Regex::new(r"\bs\b").unwrap());
    cleaned = re_trailing_s.replace_all(&cleaned, " ").to_string();
    
    // 5. Nettoyer les espaces residuels
    cleaned = re_space.replace_all(&cleaned, " ").to_string();
    
    cleaned.trim().to_string()
}

/// Version relaxée: supprime tout trailing "plus" pour élargir le matching.
/// Ex: "cine nanarplus" → "cine nanar", "canalplus" → "canal".
/// Safe car utilisé uniquement en pass 6 (les matches exacts sont résolus avant).
fn strip_plus_word(name: &str) -> String {
    static RE_PLUS_WORD: OnceLock<Regex> = OnceLock::new();
    let re = RE_PLUS_WORD.get_or_init(|| Regex::new(r"plus$").unwrap());
    let cleaned = re.replace(name, "").to_string();
    cleaned.trim().to_string()
}

/// Extrait le suffixe géographique d'un channel_id EPG.
/// "WarnerTV.fr" → Some("fr"), "bbc1" → None
fn extract_geo_suffix(channel_id: &str) -> Option<String> {
    if let Some(pos) = channel_id.rfind('.') {
        let suffix = &channel_id[pos + 1..];
        if suffix.len() == 2 && suffix.chars().all(|c| c.is_alphabetic()) {
            return Some(suffix.to_lowercase());
        }
    }
    None
}

/// Extrait un code pays 2 lettres depuis le nom d'une catégorie M3U.
/// "|FR| Films & Series" → Some("fr"), "Sports" → None
fn extract_geo_from_category(cat_name: &str) -> Option<String> {
    static RE_CAT_GEO: OnceLock<Regex> = OnceLock::new();
    let re = RE_CAT_GEO.get_or_init(|| Regex::new(r"\|([A-Za-z]{2})\|").unwrap());
    re.captures(cat_name).map(|caps| caps[1].to_lowercase())
}

/// Type alias for the complex EPG channel tuple to satisfy clippy::type_complexity.
type EpgEntry = (String, String, String, String, String, String, Option<String>);

/// Parmi les candidats EPG, choisit celui dont le suffixe géo correspond.
/// Si aucun candidat ne matche géographiquement, retourne le premier (comportement legacy).
fn pick_geo_best<'a>(
    candidates: &[&'a EpgEntry],
    geo_hint: &Option<String>,
) -> &'a EpgEntry {
    if candidates.len() == 1 {
        return candidates[0];
    }
    // Multiple candidates → prefer the one whose geo_suffix matches our hint
    if let Some(hint) = geo_hint {
        if let Some(ec) = candidates.iter().find(|e| {
            e.6.as_deref() == Some(hint.as_str())
        }) {
            return ec;
        }
    }
    // Fallback: first candidate (legacy behavior)
    candidates[0]
}

pub fn build_epg_mapping(conn: &Connection, app: Option<&tauri::AppHandle>) {
    map_live_channels(conn, app, false);
}

/// Marque d'une chaîne à relier au guide, posée par l'actualisation en arrière-plan
/// (`catalog_refresh.rs`) sur les chaînes ajoutées ou modifiées. Jamais affichée : la liaison la
/// remplace par sa méthode, ou par NULL si la chaîne reste sans guide.
pub const PENDING_LINK: &str = "__pending";

/// Relie au guide les seules chaînes marquées `PENDING_LINK`, sans toucher aux liens des autres.
/// La liaison d'une chaîne ne dépend que d'elle, du nom de sa catégorie et des chaînes du guide :
/// même résultat qu'un calcul complet pour ces chaînes. Aucun événement `epg-progress` (les
/// Paramètres croiraient à une mise à jour du guide). Renvoie le nombre de chaînes reliées.
pub fn map_pending_live_channels(conn: &Connection) -> usize {
    let matched = map_live_channels(conn, None, true);
    // Chaînes restées sans guide (ou guide vide) : plus rien en attente
    let _ = conn.execute(
        "UPDATE live SET match_method = NULL WHERE match_method = ?1",
        params![PENDING_LINK],
    );
    matched
}

fn map_live_channels(conn: &Connection, app: Option<&tauri::AppHandle>, pending_only: bool) -> usize {
    let start = std::time::Instant::now();
    log::info!("[EPG MAPPING] Starting mapping phase{}...", if pending_only { " (pending channels)" } else { "" });

    // Auto-repair: ensure EPG columns exist on live (safe for pre-existing DBs)
    crate::schema::run_auto_repair(conn, crate::schema::EPG_LIVE_AUTO_REPAIR);

    // 1. Fetch EPG Channels (with precomputed geo suffix from channel_id)
    let mut epg_stmt = match conn.prepare("SELECT id, display_name FROM epg_channels") {
        Ok(stmt) => stmt,
        Err(_) => {
            log::warn!("[EPG MAPPING] epg_channels table doesn't exist yet, skipping mapping.");
            return 0;
        }
    };

    let epg_channels_iter = match epg_stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    }) {
        Ok(iter) => iter,
        Err(e) => {
            log::warn!("[EPG MAPPING] Error querying epg_channels: {}", e);
            return 0;
        }
    };

    // EPG tuple: (id, display_name, norm_id, norm_name, no_space_norm_name, padded_norm_name, geo_suffix)
    let mut epg_list: Vec<EpgEntry> = Vec::new();
    
    // HashMaps for fast O(1) lookups
    let mut id_map: std::collections::HashMap<String, Vec<usize>> = std::collections::HashMap::new();
    let mut norm_id_map: std::collections::HashMap<String, Vec<usize>> = std::collections::HashMap::new();
    let mut nospace_id_map: std::collections::HashMap<String, Vec<usize>> = std::collections::HashMap::new();
    let mut name_map: std::collections::HashMap<String, Vec<usize>> = std::collections::HashMap::new();
    let mut norm_name_map: std::collections::HashMap<String, Vec<usize>> = std::collections::HashMap::new();
    let mut no_space_map: std::collections::HashMap<String, Vec<usize>> = std::collections::HashMap::new();
    let mut noplus_name_map: std::collections::HashMap<String, Vec<usize>> = std::collections::HashMap::new();

    for (id, name) in epg_channels_iter.flatten() {
        let norm_id = clean_name(&id);
        let norm_name = clean_name(&name);
        let no_space_norm_name = norm_name.replace(" ", "");
        let padded_norm_name = format!(" {} ", norm_name);
        let noplus_name = strip_plus_word(&norm_name);
        // Extract geo suffix from channel_id: "WarnerTV.fr" → Some("fr")
        let geo_suffix = extract_geo_suffix(&id);
        
        epg_list.push((id.clone(), name.clone(), norm_id.clone(), norm_name.clone(), no_space_norm_name.clone(), padded_norm_name.clone(), geo_suffix));
        let idx = epg_list.len() - 1;
        
        if !id.is_empty() { id_map.entry(id).or_default().push(idx); }
        if !norm_id.is_empty() {
            let nospace_id = norm_id.replace(" ", "");
            nospace_id_map.entry(nospace_id).or_default().push(idx);
            norm_id_map.entry(norm_id).or_default().push(idx);
        }
        if !name.is_empty() { name_map.entry(name).or_default().push(idx); }
        if !norm_name.is_empty() {
            let is_different = noplus_name != norm_name;
            norm_name_map.entry(norm_name).or_default().push(idx);
            if !noplus_name.is_empty() && is_different { noplus_name_map.entry(noplus_name).or_default().push(idx); }
        }
        if !no_space_norm_name.is_empty() { no_space_map.entry(no_space_norm_name).or_default().push(idx); }
    }

    if epg_list.is_empty() {
        // Links kept: without guide channels they would all be lost
        log::warn!("[EPG MAPPING] No EPG channels available, links left as they are.");
        return 0;
    }

    // 2. Fetch Live Channels (with geo_hint + category fallback)
    let live_sql = if pending_only {
        "SELECT l.id, l.epg_channel_id, l.name, l.geo_hint, c.name
         FROM live l LEFT JOIN categories c ON l.category_id = c.id AND c.type = 'live'
         WHERE l.match_method = ?1"
    } else {
        "SELECT l.id, l.epg_channel_id, l.name, l.geo_hint, c.name 
         FROM live l LEFT JOIN categories c ON l.category_id = c.id AND c.type = 'live'"
    };
    let mut live_stmt = match conn.prepare(live_sql) {
        Ok(stmt) => stmt,
        Err(e) => {
            log::warn!("[EPG MAPPING] Error preparing live query: {}", e);
            return 0;
        }
    };
    let live_params: Vec<&dyn rusqlite::ToSql> = if pending_only { vec![&PENDING_LINK] } else { vec![] };

    let live_iter = match live_stmt.query_map(live_params.as_slice(), |row| {
        let epg_id: Option<String> = row.get(1)?;
        let geo_hint: Option<String> = row.get(3).unwrap_or(None);
        let cat_name: Option<String> = row.get(4).unwrap_or(None);
        Ok((
            row.get::<_, i64>(0)?,
            epg_id.unwrap_or_default(),
            row.get::<_, String>(2)?,
            geo_hint,
            cat_name,
        ))
    }) {
        Ok(iter) => iter,
        Err(e) => {
            log::warn!("[EPG MAPPING] Error querying live: {}", e);
            return 0;
        }
    };

    let mut live_channels = Vec::new();
    for ch in live_iter.flatten() {
        live_channels.push(ch);
    }
    let total_live = live_channels.len();

    // Collect matches
    // Vec of (live_id, matched_id, match_method)
    let mut updates: Vec<(i64, String, String)> = Vec::new();
    let mut matched_count = 0;
    let mut last_pct = 0;

    for (i, (live_id, live_epg_id, live_name, live_geo, cat_name)) in live_channels.into_iter().enumerate() {
        if total_live > 0 {
            let pct = (i as f64 / total_live as f64 * 100.0) as u32;
            if pct > last_pct && pct.is_multiple_of(5) {
                last_pct = pct;
                if let Some(app_handle) = app {
                    let _ = app_handle.emit(
                        "epg-progress",
                        serde_json::json!({ "phase": "mapping", "progress": pct, "count": 0 }),
                    );
                }
            }
        }

        // Resolve effective geo hint: channel tag → category fallback
        let effective_geo = live_geo.or_else(|| {
            cat_name.as_deref().and_then(extract_geo_from_category)
        });

        let live_norm_id = clean_name(&live_epg_id);
        let live_norm_name = clean_name(&live_name);
        let live_no_space = live_norm_name.replace(" ", "");
        
        let mut best_match: Option<(&str, String)> = None;

        // Pass 1: Strict ID match (no geo needed — exact match is definitive)
        if !live_epg_id.is_empty() {
            if let Some(indices) = id_map.get(&live_epg_id) {
                best_match = Some((&epg_list[indices[0]].0, "Passe 1 : TVG ID strict".to_string()));
            }
            // Pass 2: Normalized ID match
            else if let Some(indices) = norm_id_map.get(&live_norm_id) {
                best_match = Some((&epg_list[indices[0]].0, format!("Passe 2 : TVG ID norm ({})", live_norm_id)));
            }
            // Pass 2b: No-Space Normalized ID match (canalpluscinema vs canalplus cinema)
            else {
                let live_nospace_id = live_norm_id.replace(" ", "");
                if !live_nospace_id.is_empty() {
                    if let Some(indices) = nospace_id_map.get(&live_nospace_id) {
                        best_match = Some((&epg_list[indices[0]].0, format!("Passe 2b : TVG ID sans espace ({})", live_nospace_id)));
                    }
                }
            }
        }

        // Pass 3-5: Name matching WITH geo disambiguation
        if best_match.is_none() && !live_name.is_empty() {
            
            // Helper macro for O(1) hash lookup and collection
            macro_rules! resolve_best {
                ($map:expr, $key:expr, $method_name:expr) => {
                    if let Some(indices) = $map.get($key) {
                        let candidates: Vec<_> = indices.iter().map(|&idx| &epg_list[idx]).collect();
                        if !candidates.is_empty() {
                            best_match = Some((&pick_geo_best(&candidates, &effective_geo).0, $method_name));
                        }
                    }
                };
            }

            // Pass 3: Strict Name match
            resolve_best!(name_map, &live_name, format!("Passe 3 : Nom strict"));
            
            // Pass 4: Normalized Name match
            if best_match.is_none() && !live_norm_name.is_empty() {
                resolve_best!(norm_name_map, &live_norm_name, format!("Passe 4 : Nom norm ({})", live_norm_name));
            }
            
            // Pass 4b: No-Space Normalized Name match
            if best_match.is_none() && !live_no_space.is_empty() {
                resolve_best!(no_space_map, &live_no_space, format!("Passe 5 : Nom sans espace ({})", live_no_space));
            }
            
            // Pass 6: Name match without trailing "plus" (NANAR+ → nanarplus → nanar)
            if best_match.is_none() {
                let live_noplus = strip_plus_word(&live_norm_name);
                if !live_noplus.is_empty() && live_noplus != live_norm_name {
                    resolve_best!(noplus_name_map, &live_noplus, format!("Passe 6 : Nom sans plus ({})", live_noplus));
                    // Also try the live without plus against the normal norm_name_map
                    if best_match.is_none() {
                        resolve_best!(norm_name_map, &live_noplus, format!("Passe 6 : Nom sans plus ({})", live_noplus));
                    }
                }
            }
        }

        if let Some((m_id, m_method)) = best_match {
            updates.push((live_id, m_id.to_string(), m_method));
            matched_count += 1;
        }
    }

    // 4. Batch Update, in one transaction with the purge of previous automated matches (if we do
    // not clear them, channels that fail to match in the new algorithm silently keep their old and
    // potentially faulty EPG mappings). Done only once the guide channel list is known not to be
    // empty, and all or nothing: a failure keeps the previous links.
    // (Pending channels already had their link cleared when they were marked.)
    match write_channel_links(conn, &updates, !pending_only) {
        Ok(failed) if failed > 0 => {
            log::warn!("[EPG MAPPING] {} of {} links could not be written", failed, updates.len());
            matched_count -= failed;
        }
        Ok(_) => {}
        Err(e) => {
            log::warn!("[EPG MAPPING] Links not updated, previous ones kept: {}", e);
            return 0;
        }
    }

    log::info!("[EPG MAPPING] Completed in {}ms. Matched {}/{} live channels.", start.elapsed().as_millis(), matched_count, total_live);
    matched_count
}

/// Writes the links found by the matching (live id, guide channel id, method), after clearing every
/// previous link when `reset`. One transaction: an error leaves the previous links. Returns the
/// number of links that could not be written.
fn write_channel_links(conn: &Connection, updates: &[(i64, String, String)], reset: bool) -> Result<usize, String> {
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("Failed to begin link update: {}", e))?;
    if reset {
        tx.execute("UPDATE live SET matched_epg_id = NULL, match_method = NULL", [])
            .map_err(|e| format!("Failed to reset links: {}", e))?;
    }
    let mut failed = 0;
    {
        let mut stmt = tx
            .prepare_cached("UPDATE live SET matched_epg_id = ?, match_method = ? WHERE id = ?")
            .map_err(|e| format!("Failed to prepare link update: {}", e))?;
        for (id, matched_id, match_method) in updates {
            if let Err(e) = stmt.execute(params![matched_id, match_method, id]) {
                if failed == 0 {
                    log::warn!("[EPG MAPPING] Link write failed: {}", e);
                }
                failed += 1;
            }
        }
    }
    if too_many_failures(failed, updates.len()) {
        // Dropping the transaction rolls it back
        return Err(format!("{} of {} links could not be written", failed, updates.len()));
    }
    tx.commit().map_err(|e| format!("Failed to commit links: {}", e))?;
    Ok(failed)
}

// =============================================================================
// TAURI COMMANDS
// =============================================================================

#[tauri::command]
pub async fn remap_epg(app: tauri::AppHandle, db_name: String) -> Result<(), String> {
    validate_catalog_db_name(&db_name)?;
    // A background catalogue refresh gives way to the remap (db_activity.rs)
    let _heavy = crate::db_activity::HeavyWriteGuard::new();
    log::info!("[EPG] Background remap triggered by frontend.");
    
    // Tell the frontend that we are mapping, so it shows a spinner
    let _ = app.emit(
        "epg-progress",
        serde_json::json!({
            "phase": "mapping",
            "progress": 0,
            "count": 0
        }),
    );
    
    let db_path = {
        let app_data = app
            .path()
            .app_data_dir()
            .map_err(|e| sanitize_error_path(format!("Failed to get app data dir: {}", e)))?;
        app_data.join(&db_name)
    };
    
    let app_clone = app.clone();

    // Run all synchronous SQLite work on a blocking thread to avoid stalling the tokio runtime
    // Waits for a catalogue write or a guide sync writing the same links
    let _turn = crate::db_activity::exclusive_write().await;
    // Source supprimée pendant l'attente : son fichier n'est pas recréé
    if catalog_deletion_pending(&db_path) {
        return Err(SOURCE_CATALOG_DELETED.to_string());
    }
    let epg_programs_count = tokio::task::spawn_blocking(move || {
        let conn = Connection::open(&db_path)
            .map_err(|e| sanitize_error_path(format!("Failed to open DB for remapping: {}", e)))?;
        conn.execute_batch(crate::schema::PRAGMAS_WAL)
            .map_err(|e| format!("Failed to set remap pragmas: {}", e))?;

        // Ensure EPG tables exist (remap can be called before first full sync)
        conn.execute_batch(crate::schema::EPG_TABLES)
            .map_err(|e| format!("Failed to ensure EPG tables: {}", e))?;
            
        build_epg_mapping(&conn, Some(&app_clone));
        
        flag_guide_if_links_lack_programs(&conn);
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM epg_programs", [], |r| r.get(0)).unwrap_or(0);
        Ok::<_, String>(count)
    })
    .await
    .map_err(|e| format!("Remap task panicked: {}", e))??;
    
    // Publish success event (back on async runtime, non-blocking)
    let _ = app.emit(
        "epg-progress",
        serde_json::json!({
            "phase": "done",
            "progress": 100,
            "count": epg_programs_count
        }),
    );
    
    Ok(())
}

/// Reads a downloaded guide (gzip or plain XMLTV) into the database: programs of the user's
/// channels, guide channels, links. Nothing of the old guide changes when the file is cut, empty or
/// an error page. Returns (programs, channels with programs, programs out of the window).
fn ingest_guide<R: std::io::BufRead>(
    conn: &Connection,
    reader: R,
    is_gzip: bool,
    file_len: u64,
    app: Option<&tauri::AppHandle>,
) -> Result<(usize, usize, usize), String> {
    let writer = std::cell::RefCell::new(ProgramWriter::new(conn)?);
    // Guide channels already written and linked before the programs (their number: the list only grows)
    let linked_before = std::cell::Cell::new(None::<usize>);
    let on_channels = |channels: &[EpgChannel]| -> Result<(), String> {
        let keep = linked_guide_channels(conn, channels, app)?;
        if !channels.is_empty() {
            linked_before.set(Some(channels.len()));
        }
        writer.borrow_mut().set_filter(keep);
        Ok(())
    };
    let on_program = |p: EpgProgram| writer.borrow_mut().push(p);
    let on_progress = |pct: u32, kept: usize| {
        emit_progress(app, "parse", pct, kept);
    };
    let (epg_channels, _kept, filtered_out) = if is_gzip {
        log::info!("[EPG] GZIP detected, streaming decompression + parsing...");
        // Several gzip members one after the other are read to the end (GzDecoder stops after the first)
        let decoder = BoundedXml::new(flate2::read::MultiGzDecoder::new(reader), MAX_EPG_XML_BYTES);
        parse_xml_stream(BufReader::new(decoder), file_len * 8, on_progress, on_channels, on_program)?
    } else {
        log::info!("[EPG] Plain XML detected, streaming parsing...");
        let bounded = BoundedXml::new(reader, MAX_EPG_XML_BYTES);
        parse_xml_stream(BufReader::new(bounded), file_len, on_progress, on_channels, on_program)?
    };
    let writer = writer.into_inner();
    // A guide without channel list could not be linked to any channel: old guide and links kept
    if epg_channels.is_empty() {
        log::warn!("[EPG] Guide without any channel: old guide kept");
        return Err("EPG: the guide received lists no channel, old guide kept".to_string());
    }
    let filtered = writer.keep.is_some();
    let skipped = writer.skipped;
    // The new guide replaces the old one here, only if it is complete and not empty
    let (programs_count, channels_count) = writer.finish()?;
    if filtered {
        log::info!("[EPG] {} programs of unlinked channels not stored", skipped);
    }

    log::info!(
        "[EPG] Parsed {} programs ({} filtered out), {} channels",
        programs_count,
        filtered_out,
        channels_count
    );
    emit_progress(app, "insert", 100, programs_count);

    // Guide channels and links: already done before the programs when the file lists every channel
    // first (XMLTV, the usual case). Nothing changed the user's channels since: logins, remaps and
    // syncs wait for the write turn this sync holds, and the background catalogue refresh gives way
    // to it (HeavyWriteGuard).
    // Redone only for channels that came after the first program (no more double linking).
    if linked_before.get() != Some(epg_channels.len()) {
        insert_epg_channels(conn, &epg_channels)?;
        emit_progress(app, "mapping", 0, 0);
        build_epg_mapping(conn, app);
    }

    Ok((programs_count, channels_count, filtered_out))
}

fn emit_progress(app: Option<&tauri::AppHandle>, phase: &str, progress: u32, count: usize) {
    if let Some(app) = app {
        let _ = app.emit("epg-progress", serde_json::json!({ "phase": phase, "progress": progress, "count": count }));
    }
}

/// Frees the one-sync-at-a-time slot, whatever the exit.
struct RunningGuard;

impl Drop for RunningGuard {
    fn drop(&mut self) {
        EPG_RUNNING.store(false, Ordering::Release);
    }
}

/// Deletes the temporary download file when dropped (every exit of the sync, error included).
struct TempFileGuard(std::path::PathBuf);

impl Drop for TempFileGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// App start: a guide download left by an app killed during a sync (frequent on the Chromecast)
/// would keep up to ≈ 200 MB on the disk until the next sync. No sync runs at this point.
pub fn remove_leftover_download(app: &tauri::AppHandle) {
    let Ok(dir) = app.path().app_cache_dir() else { return };
    remove_leftover_download_in(&dir);
}

fn remove_leftover_download_in(dir: &std::path::Path) {
    let path = dir.join(EPG_DOWNLOAD_FILE);
    if path.exists() {
        match std::fs::remove_file(&path) {
            Ok(()) => log::info!("[EPG] Leftover guide download deleted"),
            Err(e) => log::warn!("[EPG] Could not delete leftover guide download: {}", sanitize_error_path(e.to_string())),
        }
    }
}

/// Source of downloaded pieces (the HTTP answer; a list of pieces in the tests).
trait ChunkSource {
    async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>, String>;
}

impl ChunkSource for reqwest::Response {
    async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>, String> {
        self.chunk()
            .await
            .map(|chunk| chunk.map(|bytes| bytes.to_vec()))
            .map_err(|e| e.without_url().to_string())
    }
}

/// Writes the download to `file`. Error (the old guide is then kept) when the connection breaks,
/// when fewer bytes than announced arrive (the loop used to stop silently and the guide was
/// half empty but "complete"), beyond `max_bytes` or when the user aborts.
/// Returns the number of bytes written.
async fn download_to_file<S, W, P>(source: &mut S, mut file: W, total_size: u64, max_bytes: u64, mut on_progress: P) -> Result<u64, String>
where
    S: ChunkSource,
    W: tokio::io::AsyncWrite + Unpin,
    P: FnMut(u64),
{
    use tokio::io::AsyncWriteExt;
    if total_size > max_bytes {
        log::warn!("[EPG] Guide announced at {} bytes, above the {} bytes limit", total_size, max_bytes);
        return Err(format!("EPG file too large ({} MB announced)", total_size / 1_000_000));
    }
    let mut downloaded: u64 = 0;
    loop {
        if is_aborted() {
            log::info!("[EPG] Download aborted by user after {} bytes", downloaded);
            return Err("EPG sync aborted by user".to_string());
        }
        let chunk = match source.next_chunk().await {
            Ok(Some(chunk)) => chunk,
            Ok(None) => break,
            Err(e) => {
                log::warn!("[EPG] Download interrupted after {} bytes: {}", downloaded, e);
                return Err(format!("EPG download interrupted: {}", e));
            }
        };
        downloaded += chunk.len() as u64;
        if downloaded > max_bytes {
            log::warn!("[EPG] Guide above the {} bytes limit: download stopped", max_bytes);
            return Err(format!("EPG file too large (over {} MB)", max_bytes / 1_000_000));
        }
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("Failed to write EPG temp file: {}", e))?;
        on_progress(downloaded);
    }
    file.flush().await.map_err(|e| format!("Failed to write EPG temp file: {}", e))?;
    if total_size > 0 && downloaded < total_size {
        log::warn!("[EPG] Download cut: {} of {} bytes", downloaded, total_size);
        return Err(format!("EPG download incomplete ({} of {} bytes)", downloaded, total_size));
    }
    Ok(downloaded)
}

#[tauri::command]
pub async fn fetch_and_parse_epg(
    app: tauri::AppHandle,
    epg_url: String,
    db_name: String,
    dns_provider: String,
) -> Result<EpgIngestResult, String> {
    validate_catalog_db_name(&db_name)?;
    // Two syncs would share the temporary file and the staging table
    if EPG_RUNNING.swap(true, Ordering::AcqRel) {
        log::warn!("[EPG] A guide sync is already running: second one refused");
        return Err("EPG sync already running".to_string());
    }
    let _running = RunningGuard;
    // A background catalogue refresh gives way to the guide sync (db_activity.rs)
    let _heavy = crate::db_activity::HeavyWriteGuard::new();
    let start = std::time::Instant::now();

    // Reset abort flag at start of each sync
    EPG_ABORT_FLAG.store(false, Ordering::Relaxed);

    log::info!("[EPG] Starting EPG sync from: {}", sanitize_url_for_log(&epg_url));

    // 1. Build HTTP client with 5-minute timeout (50MB file, slow connections)
    let client = build_http_client(&dns_provider, 15, 300)?;

    // 2. Download the gzipped XMLTV file (chunked with progress)
    let _ = app.emit(
        "epg-progress",
        serde_json::json!({ "phase": "download", "progress": 0, "count": 0 }),
    );

    let mut response = client
        .get(&epg_url)
        .send()
        .await
        .map_err(|e| format!("EPG download failed: {}", e.without_url()))?;

    if !response.status().is_success() {
        return Err(format!("EPG download HTTP error: {}", response.status()));
    }

    let total_size = response.content_length().unwrap_or(0);
    log::info!("[EPG] Download started, content-length: {} bytes", total_size);

    // Download to a temporary file on disk, not in memory (the
    // whole file, 200 MB with the worldwide source, used to stay in memory during the whole parse).
    // The guard deletes it whatever happens next; a leftover of a killed app is deleted at
    // the next start (remove_leftover_download).
    let tmp_path = app
        .path()
        .app_cache_dir()
        .map_err(|e| sanitize_error_path(format!("Failed to get app cache dir: {}", e)))?
        .join(EPG_DOWNLOAD_FILE);
    if let Some(dir) = tmp_path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let tmp_guard = TempFileGuard(tmp_path.clone());
    let file = tokio::fs::File::create(&tmp_path)
        .await
        .map_err(|e| sanitize_error_path(format!("Failed to create EPG temp file: {}", e)))?;

    let mut last_emitted_pct: u32 = 0;
    let downloaded = download_to_file(&mut response, file, total_size, MAX_EPG_DOWNLOAD_BYTES, |downloaded| {
        // Emit progress every ~2% or every ~1MB
        let pct = if total_size > 0 {
            (downloaded as f64 / total_size as f64 * 100.0) as u32
        } else {
            // Unknown size — emit every 1MB
            (downloaded / 1_000_000) as u32 % 100
        };
        if pct > last_emitted_pct {
            last_emitted_pct = pct;
            let _ = app.emit(
                "epg-progress",
                serde_json::json!({ "phase": "download", "progress": pct.min(99), "count": 0 }),
            );
        }
    })
    .await
    .map_err(sanitize_error_path)?;

    log::info!("[EPG] Downloaded {} bytes", downloaded);

    let _ = app.emit(
        "epg-progress",
        serde_json::json!({ "phase": "parse", "progress": 0, "count": 0 }),
    );

    // 3. Decompress + parse + insert in a blocking task (CPU-bound), programs written while parsed
    let db_path = {
        let app_data = app
            .path()
            .app_data_dir()
            .map_err(|e| sanitize_error_path(format!("Failed to get app data dir: {}", e)))?;
        app_data.join(&db_name)
    };

    let app_clone = app.clone();
    let tmp_for_task = tmp_path.clone();
    let downloaded_for_task = downloaded;

    // Programs and channel links are written below: waits for a catalogue write or a remap
    let turn = crate::db_activity::exclusive_write().await;
    // Source supprimée pendant le téléchargement : son fichier n'est pas recréé
    if catalog_deletion_pending(&db_path) {
        return Err(SOURCE_CATALOG_DELETED.to_string());
    }
    let result = tokio::task::spawn_blocking(move || {
        use std::io::BufRead;
        let file = std::fs::File::open(&tmp_for_task)
            .map_err(|e| sanitize_error_path(format!("Failed to open EPG temp file: {}", e)))?;
        let file_len = file.metadata().map(|m| m.len()).unwrap_or(downloaded_for_task);
        let mut reader = BufReader::new(file);
        // Detect gzip magic number (0x1F, 0x8B)
        let is_gzip = {
            let head = reader.fill_buf().map_err(|e| format!("Failed to read EPG temp file: {}", e))?;
            head.len() >= 2 && head[0] == 0x1F && head[1] == 0x8B
        };

        // Open SQLite connection with busy timeout (before parsing: programs are written as they come)
        let conn = Connection::open(&db_path)
            .map_err(|e| sanitize_error_path(format!("Failed to open EPG database: {}", e)))?;
        conn.execute_batch(crate::schema::PRAGMAS_WAL)
            .map_err(|e| format!("Failed to set EPG pragmas: {}", e))?;

        // Ensure tables + indexes exist (auto-repair after full reset)
        conn.execute_batch(crate::schema::EPG_TABLES)
            .map_err(|e| format!("Failed to ensure EPG tables: {}", e))?;
        conn.execute_batch("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);")
            .map_err(|e| format!("Failed to ensure meta table: {}", e))?;

        let (programs_count, channels_count, filtered_out) =
            ingest_guide(&conn, reader, is_gzip, file_len, Some(&app_clone))?;

        // Checkpoint WAL for clean state
        let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)");

        Ok::<_, String>((programs_count, channels_count, filtered_out))
    })
    .await;
    drop(turn);
    drop(tmp_guard);
    let result = result.map_err(|e| format!("EPG task panicked: {}", e))??;

    let duration_ms = start.elapsed().as_millis();

    log::info!(
        "[EPG] Sync complete: {} programs, {} channels, {}ms",
        result.0,
        result.1,
        duration_ms
    );

    let _ = app.emit(
        "epg-progress",
        serde_json::json!({
            "phase": "done",
            "progress": 100,
            "count": result.0
        }),
    );

    Ok(EpgIngestResult {
        programs_count: result.0,
        channels_count: result.1,
        duration_ms,
        filtered_out: result.2,
    })
}

// =============================================================================
// TESTS
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // ── Écriture au fil de la lecture ──

    fn program(channel: &str, title: &str, start: i64) -> EpgProgram {
        EpgProgram { channel_id: channel.into(), title: title.into(), start_ts: start, stop_ts: start + 3600, description: None }
    }

    fn epg_conn_with_old_guide() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::schema::EPG_TABLES).unwrap();
        conn.execute_batch("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);").unwrap();
        conn.execute(
            "INSERT INTO epg_programs (channel_id, title, start_ts, stop_ts) VALUES ('old.fr', 'Ancien', 1, 2)",
            [],
        )
        .unwrap();
        conn
    }

    fn count(conn: &Connection, sql: &str) -> i64 {
        conn.query_row(sql, [], |r| r.get(0)).unwrap()
    }

    fn staging_exists(conn: &Connection) -> bool {
        count(conn, "SELECT COUNT(*) FROM sqlite_master WHERE name = 'epg_programs_staging'") > 0
    }

    #[test]
    fn test_program_writer_replaces_old_guide_in_batches() {
        let conn = epg_conn_with_old_guide();
        let mut writer = ProgramWriter::new(&conn).unwrap();
        for i in 0..(ProgramWriter::BATCH_SIZE as i64 + 7) {
            writer.push(program(if i % 2 == 0 { "tf1.fr" } else { "f2.fr" }, "Titre", 1_000 + i * 10)).unwrap();
        }
        // Premier paquet écrit à part pendant la lecture : l'ancien guide reste affiché
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM epg_programs_staging"), ProgramWriter::BATCH_SIZE as i64);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM epg_programs"), 1);
        let (inserted, channels) = writer.finish().unwrap();
        assert_eq!(inserted, ProgramWriter::BATCH_SIZE + 7);
        assert_eq!(channels, 2);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM epg_programs WHERE channel_id = 'old.fr'"), 0);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM epg_programs"), ProgramWriter::BATCH_SIZE as i64 + 7);
        assert!(!staging_exists(&conn));
        // Index du guide recréés sur la nouvelle table
        assert_eq!(
            count(&conn, "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name IN ('idx_epg_start', 'idx_epg_channel_stop') AND tbl_name = 'epg_programs'"),
            2
        );
        // Le guide suivant remplace encore le précédent (table d'attente recréée)
        let mut next = ProgramWriter::new(&conn).unwrap();
        next.push(program("tf1.fr", "Suivant", 50)).unwrap();
        assert_eq!(next.finish().unwrap().0, 1);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM epg_programs"), 1);
    }

    /// Réponse vide ou page d'erreur, aucun programme : l'ancien guide reste.
    #[test]
    fn test_program_writer_without_programs_keeps_old_guide() {
        let conn = epg_conn_with_old_guide();
        assert!(ProgramWriter::new(&conn).unwrap().finish().is_err());
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM epg_programs WHERE channel_id = 'old.fr'"), 1);
        assert!(!staging_exists(&conn));
    }

    /// Synchro abandonnée en route (erreur de lecture, arrêt) : l'ancien guide reste, rien ne traîne.
    #[test]
    fn test_program_writer_dropped_keeps_old_guide() {
        let conn = epg_conn_with_old_guide();
        {
            let mut writer = ProgramWriter::new(&conn).unwrap();
            for i in 0..(ProgramWriter::BATCH_SIZE as i64 + 1) {
                writer.push(program("tf1.fr", "Titre", 1_000 + i * 10)).unwrap();
            }
        }
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM epg_programs"), 1);
        assert!(!staging_exists(&conn));
    }

    /// Nombre de programmes du guide plafonné : au-delà du plafond, le guide est
    /// refusé pendant la lecture, l'ancien reste et la table d'attente disparaît. Les programmes des
    /// chaînes non liées (non gardés) ne comptent pas.
    #[test]
    fn test_program_writer_refuses_guide_above_program_cap() {
        let conn = epg_conn_with_old_guide();
        let mut writer = ProgramWriter::new(&conn).unwrap();
        assert_eq!(writer.max_programs, MAX_EPG_PROGRAMS);
        writer.max_programs = ProgramWriter::BATCH_SIZE + 2;
        writer.set_filter(Some(["tf1.fr".to_string()].into_iter().collect()));
        for i in 0..(ProgramWriter::BATCH_SIZE as i64 + 2) {
            writer.push(program("tf1.fr", "Titre", 1_000 + i * 10)).unwrap();
            writer.push(program("bbc.uk", "Ignoré", 1_000 + i * 10)).unwrap();
        }
        let err = writer.push(program("tf1.fr", "De trop", 999_999)).unwrap_err();
        assert!(err.contains("more than"), "{}", err);
        drop(writer);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM epg_programs"), 1);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM epg_programs WHERE channel_id = 'old.fr'"), 1);
        assert!(!staging_exists(&conn));

        // Juste au plafond : le guide passe
        let mut writer = ProgramWriter::new(&conn).unwrap();
        writer.max_programs = 3;
        for i in 0..3 {
            writer.push(program("tf1.fr", "Titre", 1_000 + i * 10)).unwrap();
        }
        assert_eq!(writer.finish().unwrap().0, 3);
    }

    /// Une écriture refusée n'est plus comptée comme écrite ; au-delà de 1 %, guide refusé.
    #[test]
    fn test_program_writer_counts_failed_writes() {
        let refuse = "CREATE TRIGGER refuse BEFORE INSERT ON epg_programs_staging WHEN NEW.channel_id = 'bad'
                      BEGIN SELECT RAISE(ABORT, 'disk error'); END;";
        // 1 échec sur 200 : guide gardé, 199 programmes comptés
        let conn = epg_conn_with_old_guide();
        let mut writer = ProgramWriter::new(&conn).unwrap();
        conn.execute_batch(refuse).unwrap();
        writer.push(program("bad", "Titre", 1)).unwrap();
        for i in 0..199 {
            writer.push(program("tf1.fr", "Titre", 1_000 + i)).unwrap();
        }
        assert_eq!(writer.finish().unwrap().0, 199);
        // 1 échec sur 10 : nouveau guide refusé, l'ancien reste
        let conn = epg_conn_with_old_guide();
        let mut writer = ProgramWriter::new(&conn).unwrap();
        conn.execute_batch(refuse).unwrap();
        writer.push(program("bad", "Titre", 1)).unwrap();
        for i in 0..9 {
            writer.push(program("tf1.fr", "Titre", 1_000 + i)).unwrap();
        }
        assert!(writer.finish().is_err());
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM epg_programs WHERE channel_id = 'old.fr'"), 1);
    }

    #[test]
    fn test_insert_epg_channels_counts_failed_writes() {
        let conn = epg_conn_with_old_guide();
        conn.execute_batch(
            "CREATE TRIGGER refuse BEFORE INSERT ON epg_channels WHEN NEW.id = 'bad'
             BEGIN SELECT RAISE(ABORT, 'disk error'); END;",
        )
        .unwrap();
        let channel = |id: &str| EpgChannel { id: id.into(), display_name: id.into() };
        let many: Vec<EpgChannel> = std::iter::once(channel("bad")).chain((0..199).map(|i| channel(&format!("c{i}")))).collect();
        assert_eq!(insert_epg_channels(&conn, &many).unwrap(), 199);
        assert!(insert_epg_channels(&conn, &[channel("bad"), channel("ok")]).is_err());
    }

    // ── Texte XML : quick-xml 0.41 sépare texte et entités (GeneralRef) ──

    /// Reconstitue un texte coupé par les entités : « Envoyé spécial & Cash <investigation> ».
    #[test]
    fn test_text_with_entities_is_reassembled() {
        use quick_xml::events::Event;
        use quick_xml::Reader;

        let mut reader = Reader::from_str(
            "<title>Envoyé spécial &amp; Cash &lt;investigation&gt; &#233;dition &#x26; suite</title>",
        );
        let mut title = String::new();
        let mut desc = None;
        let mut channel = String::new();
        loop {
            match reader.read_event() {
                Ok(Event::Text(e)) => {
                    if let Some(text) = decode_text(&e) {
                        append_text(&text, true, false, false, &mut title, &mut desc, &mut channel);
                    }
                }
                Ok(Event::GeneralRef(e)) => {
                    if let Some(text) = decode_entity(&e) {
                        append_text(&text, true, false, false, &mut title, &mut desc, &mut channel);
                    }
                }
                Ok(Event::Eof) => break,
                Ok(_) => {}
                Err(e) => panic!("parse error: {e:?}"),
            }
        }
        assert_eq!(title, "Envoyé spécial & Cash <investigation> édition & suite");
    }

    /// Entité inconnue : gardée telle quelle plutôt que de perdre le texte.
    #[test]
    fn test_unknown_entity_is_kept() {
        use quick_xml::events::BytesRef;
        assert_eq!(decode_entity(&BytesRef::new("nbsp")).as_deref(), Some("&nbsp;"));
        assert_eq!(decode_entity(&BytesRef::new("amp")).as_deref(), Some("&"));
        assert_eq!(decode_entity(&BytesRef::new("#8364")).as_deref(), Some("€"));
    }

    fn epoch_to_xmltv(ts: i64) -> String {
        let secs_per_day: i64 = 86400;
        // Simple: use days_from_civil in reverse is complex, just use a direct approach
        // For test purposes, we'll construct the XML with epoch-friendly timestamps

        // We need to convert epoch to "YYYYMMDDHHMMSS +0000"
        // Simple conversion using basic math (UTC)
        let days = ts / secs_per_day;
        let time_of_day = ts % secs_per_day;
        let hour = time_of_day / 3600;
        let minute = (time_of_day % 3600) / 60;
        let second = time_of_day % 60;

        // Civil date from days since epoch (reverse of days_from_civil)
        // Howard Hinnant's algorithm (inverse)
        let z = days + 719468;
        let era = (if z >= 0 { z } else { z - 146096 }) / 146097;
        let doe = (z - era * 146097) as u32;
        let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
        let y = (yoe as i64) + era * 400;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let d = doy - (153 * mp + 2) / 5 + 1;
        let m = if mp < 10 { mp + 3 } else { mp - 9 };
        let y = if m <= 2 { y + 1 } else { y };

        format!("{:04}{:02}{:02}{:02}{:02}{:02} +0000", y, m, d, hour, minute, second)
    }

    // ── T1b: parse_xmltv_timestamp — 5 cas ──

    #[test]
    fn test_timestamp_positive_offset() {
        // 2026-04-04 17:00:00 +0200 → UTC = 15:00:00
        let result = parse_xmltv_timestamp("20260404170000 +0200").unwrap();
        // Verify: 17:00 local with +0200 = 15:00 UTC
        // 15:00 UTC = days_from_civil(2026,4,4) * 86400 + 15*3600
        let expected = parse_xmltv_timestamp("20260404150000").unwrap();
        assert_eq!(result, expected);
    }

    #[test]
    fn test_timestamp_negative_offset() {
        // 2026-04-04 12:00:00 -0500 → UTC = 12:00 + 5h = 17:00 UTC
        let result = parse_xmltv_timestamp("20260404120000 -0500").unwrap();
        let expected = parse_xmltv_timestamp("20260404170000").unwrap();
        assert_eq!(result, expected);
    }

    #[test]
    fn test_timestamp_no_offset() {
        // 2026-04-04 17:00:00 (no offset = UTC)
        let result = parse_xmltv_timestamp("20260404170000").unwrap();
        // Should equal days_from_civil(2026,4,4) * 86400 + 17*3600
        let days = days_from_civil(2026, 4, 4) as i64;
        let expected = days * 86400 + 17 * 3600;
        assert_eq!(result, expected);
    }

    #[test]
    fn test_timestamp_short_format() {
        // Without seconds: 202604041700 +0200 → same as 20260404170000 +0200
        let result = parse_xmltv_timestamp("202604041700 +0200").unwrap();
        let expected = parse_xmltv_timestamp("20260404170000 +0200").unwrap();
        assert_eq!(result, expected);
    }

    #[test]
    fn test_timestamp_invalid() {
        assert!(parse_xmltv_timestamp("").is_err());
        assert!(parse_xmltv_timestamp("abc").is_err());
        assert!(parse_xmltv_timestamp("2026").is_err());
    }

    // ── T1c: Mini XML parse — 3 programmes ──

    #[test]
    fn test_parse_xml_programs_mini() {
        // Create a mini XMLTV snippet with 3 programmes
        // Use far-future dates to ensure they pass the time window filter
        let xml = String::from(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<tv>
  <programme start="20300101080000 +0000" stop="20300101090000 +0000" channel="TF1.fr">
    <title>Journal du matin</title>
    <desc>Les news du jour</desc>
  </programme>
  <programme start="20300101090000 +0000" stop="20300101100000 +0000" channel="TF1.fr">
    <title>Magazine santé</title>
  </programme>
  <programme start="20300101080000 +0000" stop="20300101110000 +0000" channel="France2.fr">
    <title>Documentaire nature</title>
    <desc>La vie sauvage en Afrique</desc>
  </programme>
</tv>"#
        );

        let (programs, _channels, filtered_out) = parse_xml_programs(xml.as_bytes(), xml.len() as u64).unwrap();

        // All 3 are in far future — within the 7-day window? No, 2030 is far beyond.
        // Our filter: start_ts < now + 604800. 2030 is way beyond that.
        // So they should all be filtered OUT.
        // Let's use timestamps relative to "now" instead.
        // Actually, let's test with a large window: our code uses now + 7 days.
        // For unit test, let's verify the parser works correctly by checking
        // that programs outside the window ARE filtered.
        assert_eq!(programs.len(), 0);
        assert_eq!(filtered_out, 3);
    }

    #[test]
    fn test_parse_xml_structure() {
        // Test that XML parsing correctly extracts fields.
        // We'll use a timestamp that's "now" to ensure it passes the filter.
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;

        // Create timestamps around "now" to pass the window filter
        let start_ts = now - 1800; // 30 min ago
        let stop_ts = now + 1800;  // 30 min from now

        // Convert to XMLTV format (YYYYMMDDHHMMSS +0000)
        let start_str = epoch_to_xmltv(start_ts);
        let stop_str = epoch_to_xmltv(stop_ts);

        let xml = format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<tv>
  <programme start="{}" stop="{}" channel="CNN.us">
    <title>Breaking News</title>
    <desc>Latest world events</desc>
  </programme>
</tv>"#,
            start_str, stop_str
        );

        let (programs, _channels, filtered_out) = parse_xml_programs(xml.as_bytes(), xml.len() as u64).unwrap();

        assert_eq!(programs.len(), 1, "Expected 1 program in time window");
        assert_eq!(filtered_out, 0);

        let p = &programs[0];
        assert_eq!(p.channel_id, "CNN.us");
        assert_eq!(p.title, "Breaking News");
        assert_eq!(p.description.as_deref(), Some("Latest world events"));
        // Timestamps should be close to what we set (within 1 second due to rounding)
        assert!((p.start_ts - start_ts).abs() <= 1);
        assert!((p.stop_ts - stop_ts).abs() <= 1);
    }

    // ── Guide limité aux chaînes de l'utilisateur ──

    #[test]
    fn test_program_writer_keeps_only_linked_channels() {
        let conn = epg_conn_with_old_guide();
        let mut writer = ProgramWriter::new(&conn).unwrap();
        writer.set_filter(Some(["tf1.fr".to_string()].into_iter().collect()));
        writer.push(program("tf1.fr", "Journal", 1_000)).unwrap();
        writer.push(program("bbc.uk", "News", 1_000)).unwrap();
        assert_eq!(writer.skipped, 1);
        let (inserted, _) = writer.finish().unwrap();
        assert_eq!(inserted, 1);
        let other: i64 = conn.query_row("SELECT COUNT(*) FROM epg_programs WHERE channel_id = 'bbc.uk'", [], |r| r.get(0)).unwrap();
        assert_eq!(other, 0);
    }

    #[test]
    fn test_parse_announces_channels_before_first_program() {
        // Dates anciennes : programmes hors fenêtre (écartés), l'annonce des chaînes a lieu quand même
        let xml = r#"<tv><channel id="a"><display-name>A</display-name></channel><channel id="b"><display-name>B</display-name></channel>
            <programme start="20200101000000 +0000" stop="20200101010000 +0000" channel="a"><title>T1</title></programme>
            <programme start="20200101000000 +0000" stop="20200101010000 +0000" channel="b"><title>T2</title></programme></tv>"#;
        let mut announced: Vec<usize> = Vec::new();
        let (channels, _, filtered_out) =
            parse_xml_stream(xml.as_bytes(), xml.len() as u64, |_, _| {}, |c| { announced.push(c.len()); Ok(()) }, |_| Ok(())).unwrap();
        assert_eq!(announced, vec![2]);
        assert_eq!(channels.len(), 2);
        assert_eq!(filtered_out, 2);
    }

    #[test]
    fn test_remap_flags_guide_when_newly_linked_channel_was_not_kept() {
        let conn = epg_conn_with_old_guide();
        conn.execute_batch("CREATE TABLE live (id INTEGER, matched_epg_id TEXT);").unwrap();
        conn.execute("INSERT INTO live (id, matched_epg_id) VALUES (1, 'old.fr')", []).unwrap();
        conn.execute("INSERT INTO epg_kept_channels (id) VALUES ('old.fr'), ('quiet.fr')", []).unwrap();
        // Chaîne gardée sans programme cette semaine : ne doit pas recharger le guide
        conn.execute("INSERT INTO live (id, matched_epg_id) VALUES (3, 'quiet.fr')", []).unwrap();
        // Guide complet (non filtré) : rien à signaler
        flag_guide_if_links_lack_programs(&conn);
        let flagged = |c: &Connection| c.query_row("SELECT COUNT(*) FROM meta WHERE key = 'epg_needs_resync'", [], |r| r.get::<_, i64>(0)).unwrap();
        assert_eq!(flagged(&conn), 0);
        // Guide filtré, chaînes liées toutes gardées (avec ou sans programme) : rien à signaler
        conn.execute("INSERT INTO meta (key, value) VALUES ('epg_filtered', '1')", []).unwrap();
        flag_guide_if_links_lack_programs(&conn);
        assert_eq!(flagged(&conn), 0);
        // Nouvelle chaîne liée (autre fournisseur), absente des chaînes gardées : guide à recharger
        conn.execute("INSERT INTO live (id, matched_epg_id) VALUES (2, 'new.fr')", []).unwrap();
        flag_guide_if_links_lack_programs(&conn);
        assert_eq!(flagged(&conn), 1);
    }

    // ── Lot 1 « Guide TV fiable » ──

    fn now_secs() -> i64 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64
    }

    /// Guide XMLTV de `n` programmes sur la chaîne `tf1.fr`, dans la fenêtre gardée.
    fn guide_xml(n: usize) -> String {
        let now = now_secs();
        let mut xml = String::from(r#"<?xml version="1.0" encoding="UTF-8"?><tv><channel id="tf1.fr"><display-name>TF1</display-name></channel>"#);
        for i in 0..n as i64 {
            let start = now - 1800 + i * 60;
            xml.push_str(&format!(
                r#"<programme start="{}" stop="{}" channel="tf1.fr"><title>Programme {i}</title><desc>Résumé</desc></programme>"#,
                epoch_to_xmltv(start),
                epoch_to_xmltv(start + 60)
            ));
        }
        xml.push_str("</tv>");
        xml
    }

    /// Dates exotiques refusées sans panique (octets non ASCII, jour 0, mois négatif…).
    #[test]
    fn test_timestamp_rejects_malformed_dates() {
        for bad in [
            "2026é404170000 +0200",
            "20260004170000",
            "20261304170000",
            "20260400170000",
            "20260431170000",
            "20250229170000",
            "2026-1041700000",
            "20260404250000",
            "20260404176000",
            "20260404170000 −0200",
            "20260404170000 +02é0",
            "20260404170000 +2500",
            "€€€€€€€€€€€€",
        ] {
            assert!(parse_xmltv_timestamp(bad).is_err(), "should be refused: {bad}");
        }
        // Valides : 29 février d'une année bissextile, seconde intercalaire
        assert!(parse_xmltv_timestamp("20280229120000 +0100").is_ok());
        assert!(parse_xmltv_timestamp("20261231235960").is_ok());
    }

    /// Un seul programme à date mal formée est ignoré, le reste du guide passe.
    #[test]
    fn test_bad_program_date_skips_only_that_program() {
        let good = guide_xml(2);
        let xml = good.replace(
            "</channel>",
            r#"</channel><programme start="2026é404170000 +0200" stop="20261304170000" channel="tf1.fr"><title>Cassé</title></programme>"#,
        );
        let (programs, _, filtered_out) = parse_xml_programs(xml.as_bytes(), xml.len() as u64).unwrap();
        assert_eq!(programs.len(), 2);
        assert_eq!(filtered_out, 1);
    }

    /// Fichier coupé (sans `</tv>`, erreur XML, gzip tronqué) = échec, pas un demi-guide.
    #[test]
    fn test_cut_guide_file_is_an_error() {
        let xml = guide_xml(20);
        let cut = &xml[..xml.len() / 2];
        assert!(parse_xml_programs(cut.as_bytes(), cut.len() as u64).is_err());
        let broken = xml.replacen("<title>", "<!-- <title>", 1);
        assert!(parse_xml_programs(broken.as_bytes(), broken.len() as u64).is_err());

        use std::io::Write;
        let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        enc.write_all(xml.as_bytes()).unwrap();
        let gz = enc.finish().unwrap();
        let cut_gz = &gz[..gz.len() - 12];
        let decoder = std::io::BufReader::new(flate2::read::GzDecoder::new(cut_gz));
        assert!(parse_xml_programs(decoder, xml.len() as u64).is_err());
        let decoder = std::io::BufReader::new(flate2::read::GzDecoder::new(&gz[..]));
        assert_eq!(parse_xml_programs(decoder, xml.len() as u64).unwrap().0.len(), 20);
    }

    /// Fautes courantes du fichier mondial (« & » seul, balise mal fermée) : le guide passe quand même.
    #[test]
    fn test_common_xml_slips_are_tolerated() {
        let xml = guide_xml(3)
            .replacen("<title>Programme 0</title>", "<title>Tom & Jerry</title>", 1)
            .replacen("<desc>Résumé</desc>", "<desc>Résumé</description>", 1)
            .replacen("<title>Programme 1</title>", "<title> Envoyé spécial &amp; Cash </title>", 1);
        let (programs, _, _) = parse_xml_programs(xml.as_bytes(), xml.len() as u64).unwrap();
        assert_eq!(programs.len(), 3);
        assert_eq!(programs[0].title, "Tom & Jerry");
        // Espaces autour d'une entité gardés, bords du titre enlevés
        assert_eq!(programs[1].title, "Envoyé spécial & Cash");
    }

    /// Plusieurs membres gzip à la suite : lus jusqu'au bout.
    #[test]
    fn test_multi_member_gzip_is_read_to_the_end() {
        use std::io::Write;
        let xml = guide_xml(10);
        let (head, tail) = xml.split_at(xml.len() / 2);
        let mut gz = Vec::new();
        for part in [head, tail] {
            let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
            enc.write_all(part.as_bytes()).unwrap();
            gz.extend(enc.finish().unwrap());
        }
        let conn = catalog_conn_with_old_guide();
        let (programs, _, _) = ingest_guide(&conn, &gz[..], true, gz.len() as u64, None).unwrap();
        assert_eq!(programs, 10);
    }

    /// Guide piégé : champs bornés, texte sans fin ou fichier démesuré refusés.
    #[test]
    fn test_trapped_guide_is_bounded() {
        let long_title = "&amp;".repeat(10_000);
        let xml = guide_xml(1).replacen("<title>Programme 0</title>", &format!("<title>é{long_title}</title>"), 1);
        let (programs, _, _) = parse_xml_programs(xml.as_bytes(), xml.len() as u64).unwrap();
        assert!(programs[0].title.len() <= MAX_TITLE_BYTES);
        assert!(programs[0].title.starts_with("é&&"));

        use std::io::Read;
        let endless = format!("<tv><title>{}", "x".repeat(MAX_XML_RUN_BYTES as usize + 10));
        let mut out = Vec::new();
        assert!(BoundedXml::new(endless.as_bytes(), MAX_EPG_XML_BYTES).read_to_end(&mut out).is_err());
        let mut out = Vec::new();
        assert!(BoundedXml::new(&b"<a/><b/><c/>"[..], 5).read_to_end(&mut out).is_err());
        let mut out = Vec::new();
        let normal = guide_xml(50);
        BoundedXml::new(normal.as_bytes(), MAX_EPG_XML_BYTES).read_to_end(&mut out).unwrap();
        assert_eq!(out, normal.as_bytes());
    }

    /// Fautes de forme rares mais sans perte (DOCTYPE sans nom, balise fermante en trop) : le
    /// guide passe, au lieu d'être refusé en entier. Déclaration sans version ou `version="2.0"`
    /// passaient déjà : gardés contre une régression.
    #[test]
    fn test_rare_ill_formed_xml_is_tolerated() {
        let decl = r#"<?xml version="1.0" encoding="UTF-8"?>"#;
        for (what, xml) in [
            ("declaration without version", guide_xml(3).replacen(decl, r#"<?xml encoding="UTF-8"?>"#, 1)),
            ("unknown XML version", guide_xml(3).replacen(decl, r#"<?xml version="2.0" encoding="UTF-8"?>"#, 1)),
            ("DOCTYPE without name", guide_xml(3).replacen("<tv>", "<!DOCTYPE><tv>", 1)),
            ("extra end tag", guide_xml(3).replacen("</title>", "</title></title>", 1)),
            ("end tag before any start", guide_xml(3).replacen(decl, &format!("{decl}</junk>"), 1)),
        ] {
            let (programs, _, _) = parse_xml_programs(xml.as_bytes(), xml.len() as u64)
                .unwrap_or_else(|e| panic!("{what}: {e}"));
            assert_eq!(programs.len(), 3, "{what}");
            assert_eq!(programs[1].title, "Programme 1", "{what}");
        }
        // Une balise fermante en trop n'enregistre pas deux fois le même programme
        let xml = guide_xml(2).replacen("</programme>", "</programme></programme>", 1);
        let (programs, _, filtered_out) = parse_xml_programs(xml.as_bytes(), xml.len() as u64).unwrap();
        assert_eq!((programs.len(), filtered_out), (2, 0));
    }

    /// Titre ou description mal fermés : le texte des balises suivantes ne s'y ajoute pas.
    #[test]
    fn test_misclosed_fields_do_not_swallow_other_tags() {
        let xml = guide_xml(2)
            .replacen("<desc>Résumé</desc>", "<desc>Résumé</description><category>Sport</category>", 1)
            .replacen("<title>Programme 1</title>", "<title>Programme 1</titre>", 1);
        let (programs, _, _) = parse_xml_programs(xml.as_bytes(), xml.len() as u64).unwrap();
        assert_eq!(programs[0].description.as_deref(), Some("Résumé"));
        assert_eq!(programs[1].title, "Programme 1");
        assert_eq!(programs[1].description.as_deref(), Some("Résumé"));
    }

    /// Un seul message de progression par palier de programmes gardés.
    #[test]
    fn test_parse_progress_sent_once_per_step() {
        let xml = guide_xml(2 * PROGRESS_EVERY_PROGRAMS + 10);
        let mut sent: Vec<usize> = Vec::new();
        let (_, kept, _) = parse_xml_stream(xml.as_bytes(), xml.len() as u64, |_, kept| sent.push(kept), |_| Ok(()), |_| Ok(())).unwrap();
        assert_eq!(kept, 2 * PROGRESS_EVERY_PROGRAMS + 10);
        assert_eq!(sent, vec![PROGRESS_EVERY_PROGRAMS, 2 * PROGRESS_EVERY_PROGRAMS]);
    }

    struct FakeDownload(std::collections::VecDeque<Result<Option<Vec<u8>>, String>>);

    impl ChunkSource for FakeDownload {
        async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>, String> {
            self.0.pop_front().unwrap_or(Ok(None))
        }
    }

    fn fake(pieces: Vec<Result<Option<Vec<u8>>, String>>) -> FakeDownload {
        FakeDownload(pieces.into())
    }

    /// Coupure réseau, taille annoncée non atteinte, fichier trop gros = échec.
    #[tokio::test]
    async fn test_download_errors_are_reported() {
        let piece = |n: usize| Ok(Some(vec![b'x'; n]));
        let mut out = Vec::new();
        assert_eq!(download_to_file(&mut fake(vec![piece(10), piece(5)]), &mut out, 15, 100, |_| {}).await.unwrap(), 15);
        assert_eq!(out.len(), 15);
        // Connexion coupée en route
        let cut = download_to_file(&mut fake(vec![piece(10), Err("connection reset".into())]), Vec::new(), 0, 100, |_| {}).await;
        assert!(cut.unwrap_err().contains("interrupted"));
        // Moins d'octets que la taille annoncée
        let short = download_to_file(&mut fake(vec![piece(10)]), Vec::new(), 50, 100, |_| {}).await;
        assert!(short.unwrap_err().contains("incomplete"));
        // Au-delà du plafond, annoncé ou non
        assert!(download_to_file(&mut fake(vec![piece(10)]), Vec::new(), 500, 100, |_| {}).await.is_err());
        let big = download_to_file(&mut fake(vec![piece(60), piece(60)]), Vec::new(), 0, 100, |_| {}).await;
        assert!(big.unwrap_err().contains("too large"));
        assert_eq!(MAX_EPG_DOWNLOAD_BYTES, 512 * 1024 * 1024);
    }

    /// Fichier temporaire supprimé en sortie (erreur comprise) et reste supprimé au démarrage.
    #[test]
    fn test_temp_download_is_removed() {
        let dir = std::env::temp_dir().join(format!("nyx-epg-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(EPG_DOWNLOAD_FILE);
        std::fs::write(&path, b"reste").unwrap();
        remove_leftover_download_in(&dir);
        assert!(!path.exists());
        std::fs::write(&path, b"en cours").unwrap();
        drop(TempFileGuard(path.clone()));
        assert!(!path.exists());
        remove_leftover_download_in(&dir);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Base avec un ancien guide de `tf1.fr` et une chaîne de l'utilisateur liée à ce guide.
    fn catalog_conn_with_old_guide() -> Connection {
        let conn = epg_conn_with_old_guide();
        conn.execute_batch(crate::schema::CATALOG_TABLES).unwrap();
        conn.execute_batch(
            "INSERT INTO epg_channels (id, display_name) VALUES ('tf1.fr', 'TF1');
             INSERT INTO live (id, name, epg_channel_id, matched_epg_id, match_method) VALUES (1, 'TF1', 'tf1.fr', 'tf1.fr', 'Passe 1 : TVG ID strict');
             INSERT INTO epg_kept_channels (id) VALUES ('tf1.fr');
             INSERT INTO meta (key, value) VALUES ('epg_filtered', '1');",
        )
        .unwrap();
        conn
    }

    fn assert_old_guide_intact(conn: &Connection) {
        assert_eq!(count(conn, "SELECT COUNT(*) FROM epg_programs WHERE channel_id = 'old.fr'"), 1);
        assert_eq!(count(conn, "SELECT COUNT(*) FROM epg_channels"), 1);
        assert_eq!(count(conn, "SELECT COUNT(*) FROM live WHERE matched_epg_id = 'tf1.fr'"), 1);
        assert_eq!(count(conn, "SELECT COUNT(*) FROM epg_kept_channels"), 1);
        assert!(!staging_exists(conn));
    }

    /// Guide coupé, vide, page d'erreur, sans chaînes : l'ancien guide et les liens restent.
    #[test]
    fn test_refused_guides_keep_old_guide_and_links() {
        let xml = guide_xml(30);
        let refused = [
            xml[..xml.len() * 2 / 3].to_string(),
            r#"<?xml version="1.0"?><tv></tv>"#.to_string(),
            r#"<?xml version="1.0"?><tv/>"#.to_string(),
            "<html><body><h1>502 Bad Gateway</h1></body></html>".to_string(),
            String::new(),
            xml.replace(r#"<channel id="tf1.fr"><display-name>TF1</display-name></channel>"#, ""),
        ];
        for body in refused {
            let conn = catalog_conn_with_old_guide();
            assert!(ingest_guide(&conn, body.as_bytes(), false, body.len() as u64, None).is_err(), "should be refused: {body:.60}");
            assert_old_guide_intact(&conn);
        }
    }

    /// Guide complet : remplace l'ancien, liens et chaînes gardées à jour.
    #[test]
    fn test_complete_guide_replaces_old_one() {
        let conn = catalog_conn_with_old_guide();
        let xml = guide_xml(30);
        let (programs, channels, _) = ingest_guide(&conn, xml.as_bytes(), false, xml.len() as u64, None).unwrap();
        assert_eq!((programs, channels), (30, 1));
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM epg_programs WHERE channel_id = 'old.fr'"), 0);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM epg_programs WHERE channel_id = 'tf1.fr'"), 30);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM live WHERE matched_epg_id = 'tf1.fr'"), 1);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM epg_kept_channels WHERE id = 'tf1.fr'"), 1);
        assert!(!staging_exists(&conn));
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM meta WHERE key = 'epg_sync_status' AND value = 'complete'"), 1);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM meta WHERE key = 'last_epg_sync'"), 1);
    }

    thread_local! {
        /// Écritures des chaînes du guide (insert_epg_channels) sur ce fil de test
        pub(super) static CHANNEL_WRITES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    }

    fn channel_writes() -> usize {
        CHANNEL_WRITES.with(|n| n.get())
    }

    /// Chaînes listées avant les programmes (cas habituel) : chaînes du guide et liens faits une
    /// seule fois par synchro, avant les programmes.
    #[test]
    fn test_guide_channels_linked_once_per_sync() {
        let conn = catalog_conn_with_old_guide();
        let before = channel_writes();
        let xml = guide_xml(5);
        ingest_guide(&conn, xml.as_bytes(), false, xml.len() as u64, None).unwrap();
        assert_eq!(channel_writes() - before, 1);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM epg_channels"), 1);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM live WHERE matched_epg_id = 'tf1.fr'"), 1);
    }

    /// Une chaîne listée après les programmes est quand même écrite et reliée, à la fin.
    #[test]
    fn test_guide_channel_after_programs_is_still_linked() {
        let conn = catalog_conn_with_old_guide();
        conn.execute(
            "INSERT INTO live (id, name, epg_channel_id) VALUES (2, 'France 2', 'france2.fr')",
            [],
        )
        .unwrap();
        let before = channel_writes();
        let xml = guide_xml(5).replace(
            "</tv>",
            r#"<channel id="france2.fr"><display-name>France 2</display-name></channel></tv>"#,
        );
        ingest_guide(&conn, xml.as_bytes(), false, xml.len() as u64, None).unwrap();
        assert_eq!(channel_writes() - before, 2);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM epg_channels"), 2);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM live WHERE id = 2 AND matched_epg_id = 'france2.fr'"), 1);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM live WHERE id = 1 AND matched_epg_id = 'tf1.fr'"), 1);
    }

    /// Liaison sans aucune chaîne de guide : les liens existants ne sont pas effacés.
    #[test]
    fn test_mapping_without_guide_channels_keeps_links() {
        let conn = catalog_conn_with_old_guide();
        conn.execute("DELETE FROM epg_channels", []).unwrap();
        assert_eq!(map_live_channels(&conn, None, false), 0);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM live WHERE matched_epg_id = 'tf1.fr'"), 1);
    }
    /// A trapped guide with more `<channel>` than any real guide is refused, old guide kept, instead
    /// of filling the memory until the app is killed (it then crashed again at each launch).
    #[test]
    fn test_guide_with_too_many_channels_is_refused() {
        let conn = catalog_conn_with_old_guide();
        let mut xml = String::from("<tv>");
        for i in 0..=MAX_EPG_CHANNELS {
            xml.push_str(&format!(r#"<channel id="c{i}"></channel>"#));
        }
        xml.push_str(&guide_xml(3)["<?xml version=\"1.0\" encoding=\"UTF-8\"?><tv>".len()..]);
        let err = ingest_guide(&conn, xml.as_bytes(), false, xml.len() as u64, None).unwrap_err();
        assert!(err.contains("channels"), "{err}");
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM live WHERE id = 1 AND matched_epg_id = 'tf1.fr'"), 1);

        // Exactly the cap: still accepted
        let mut xml = String::from("<tv>");
        for i in 0..MAX_EPG_CHANNELS - 1 {
            xml.push_str(&format!(r#"<channel id="c{i}"></channel>"#));
        }
        xml.push_str(&guide_xml(3)["<?xml version=\"1.0\" encoding=\"UTF-8\"?><tv>".len()..]);
        let (channels, kept, _) = parse_xml_stream(xml.as_bytes(), xml.len() as u64, |_, _| {}, |_| Ok(()), |_| Ok(())).unwrap();
        assert_eq!(channels.len(), MAX_EPG_CHANNELS);
        assert_eq!(kept, 3);
    }

    /// A 1 MB channel id is not kept (neither on `<channel>` nor on `<programme>`): real ids are a
    /// few dozen characters, and millions of programs each holding such an id filled the memory.
    #[test]
    fn test_oversized_channel_ids_are_ignored() {
        let huge = "x".repeat(1024 * 1024);
        let now = now_secs();
        let xml = format!(
            r#"<tv><channel id="{huge}"><display-name>Piège</display-name></channel><channel id="tf1.fr"><display-name>TF1</display-name></channel><programme start="{s}" stop="{e}" channel="{huge}"><title>A</title></programme><programme start="{s}" stop="{e}" channel="tf1.fr"><title>B</title></programme></tv>"#,
            s = epoch_to_xmltv(now - 60),
            e = epoch_to_xmltv(now + 600),
        );
        let mut ids = Vec::new();
        let (channels, kept, filtered_out) = parse_xml_stream(xml.as_bytes(), xml.len() as u64, |_, _| {}, |_| Ok(()), |p| {
            ids.push(p.channel_id);
            Ok(())
        })
        .unwrap();
        assert_eq!(channels.len(), 1);
        assert_eq!(channels[0].id, "tf1.fr");
        assert_eq!((kept, filtered_out), (1, 1));
        assert_eq!(ids, vec!["tf1.fr".to_string()]);
        // Exactly the longest id allowed is still kept
        let long = "y".repeat(MAX_EPG_ID_BYTES);
        let xml = format!(r#"<tv><channel id="{long}"></channel></tv>"#);
        let (channels, _, _) = parse_xml_stream(xml.as_bytes(), xml.len() as u64, |_, _| {}, |_| Ok(()), |_| Ok(())).unwrap();
        assert_eq!(channels[0].id, long);
    }
    /// Programs spread over more distinct channels than any real guide are refused, even without
    /// any `<channel>` to filter them (each id was kept in memory).
    #[test]
    fn test_programs_for_too_many_channels_are_refused() {
        let conn = epg_conn_with_old_guide();
        let mut writer = ProgramWriter::new(&conn).unwrap();
        for i in 0..MAX_EPG_CHANNELS {
            writer.channel_ids.insert(format!("c{i}"));
        }
        // A program of a channel already seen still passes
        writer.push(program("c0", "Journal", 1_000)).unwrap();
        let err = writer.push(program("c-new", "Journal", 1_000)).unwrap_err();
        assert!(err.contains("channels"), "{err}");
    }
}
