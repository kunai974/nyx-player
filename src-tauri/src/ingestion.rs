use crate::catalog_parser::*;
use crate::http::build_http_client;
use crate::storage::{catalog_db_path, get_data_dir, validate_catalog_db_name};
use std::collections::HashMap;
use std::future::Future;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::Emitter;

// ============= IPTV API Commands =============

/// Début du message d'erreur quand le serveur du fournisseur répond par une erreur 5xx : la page le
/// reconnaît pour afficher « le serveur ne répond pas » plutôt que « identifiants faux ».
pub const PROVIDER_SERVER_ERROR: &str = "provider_server_error";

/// Début du message d'erreur quand le serveur du fournisseur est injoignable (délai dépassé, adresse
/// introuvable, connexion refusée) : même message « le serveur ne répond pas » côté page.
pub const PROVIDER_UNREACHABLE: &str = "provider_unreachable";

/// Début du message d'erreur quand le certificat https du fournisseur est refusé (expiré, signé par
/// lui-même, autre nom) : la page le dit au lieu de « le serveur ne répond pas ». La vérification
/// n'est jamais désactivée : l'utilisateur peut essayer l'adresse en http si son fournisseur l'offre.
pub const PROVIDER_CERTIFICATE_ERROR: &str = "provider_certificate_error";

/// Vrai si l'erreur, ou une de ses causes, parle du certificat. rustls (Android) écrit « invalid
/// peer certificate », Windows écrit son message dans la langue du système (« certificate »,
/// « certificat ») : une autre langue, ou un message Windows sans ce mot (nom de serveur qui ne
/// correspond pas : « The target principal name is incorrect »), retombe sur « le serveur ne
/// répond pas », comme avant.
fn is_certificate_error(error: &(dyn std::error::Error + 'static)) -> bool {
    let mut current = Some(error);
    while let Some(e) = current {
        if e.to_string().to_lowercase().contains("certificat") {
            return true;
        }
        current = e.source();
    }
    false
}

/// Version du banc de tests automatiques : mode audit ET `VITE_BANC=1` à la compilation,
/// comme le verrou « jamais de vrai flux ». Une version publiée n'a jamais la fonction `audit` :
/// pour elle, cette valeur est fausse et les délais ci-dessous restent ceux de l'app.
const BANC: bool = cfg!(feature = "audit")
    && match option_env!("VITE_BANC") {
        Some(v) => v.len() == 1 && v.as_bytes()[0] == b'1',
        None => false,
    };

/// Délai total d'une requête au fournisseur (`iptv_fetch`) : 60 s ; 15 s dans la version du banc,
/// dont le faux fournisseur répond tout de suite ou se tait exprès (« ne répond pas » vu plus tôt).
const FETCH_TOTAL_TIMEOUT_SECS: u64 = if BANC { 15 } else { 60 };

/// Attente entre deux essais d'une liste divisée par ce nombre dans la version du banc (même
/// nombre d'essais, même ordre : seule l'horloge va plus vite).
const BANC_BACKOFF_DIVISOR: u64 = if BANC { 10 } else { 1 };

/// Taille maximale d'une réponse d'`iptv_fetch` (fiches, authentification) : les grandes listes du
/// catalogue passent par `ingest_catalog`, jamais par ici.
const IPTV_FETCH_MAX_BYTES: usize = 64 * 1024 * 1024;

/// Taille maximale d'une liste du catalogue lue au chargement complet, même borne que l'actualisation
/// de fond (`catalog_refresh.rs`). Les plus grosses listes réelles (100 000 films) font environ 100 Mo ;
/// une réponse sans fin d'un fournisseur hostile ou en panne remplissait la mémoire jusqu'à faire
/// tomber l'app.
const MAX_LIST_DOWNLOAD_BYTES: usize = 512 * 1024 * 1024;

/// Taille maximale d'une liste de catégories (quelques milliers de noms : moins d'1 Mo en vrai).
const MAX_CATEGORY_LIST_BYTES: usize = 16 * 1024 * 1024;

/// Total des six listes gardées en mémoire au chargement complet : elles partent en même temps, et
/// six fois la borne d'une liste dépasserait la mémoire d'une TV de 1 à 2 Go.
const MAX_CATALOG_DOWNLOAD_BYTES: usize = 768 * 1024 * 1024;

/// Bornes d'une liste : la sienne, et la part restante du total commun aux six listes.
#[derive(Clone, Copy)]
struct ListBudget<'a> {
    max_bytes: usize,
    shared: &'a AtomicUsize,
}

/// Octets pris sur le total commun, rendus à la fin d'un essai qui n'a pas gardé sa liste.
struct Reserved<'a> {
    shared: &'a AtomicUsize,
    bytes: usize,
}

impl Reserved<'_> {
    fn take(&mut self, n: usize) -> bool {
        let ok = self
            .shared
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |left| left.checked_sub(n))
            .is_ok();
        if ok {
            self.bytes += n;
        }
        ok
    }
}

impl Drop for Reserved<'_> {
    fn drop(&mut self) {
        self.shared.fetch_add(self.bytes, Ordering::SeqCst);
    }
}

/// Début de l'erreur d'une liste refusée car trop grosse : la page l'annonce à l'utilisateur.
pub const LIST_TOO_LARGE: &str = "list_too_large";

/// Un client réseau par réglage DNS, réutilisé d'un appel à l'autre (connexions et résolution DNS
/// gardées) au lieu d'un client neuf à chaque appel.
fn shared_client(dns_provider: &str) -> Result<reqwest::Client, String> {
    static CLIENTS: OnceLock<Mutex<HashMap<String, reqwest::Client>>> = OnceLock::new();
    let mut clients = CLIENTS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if let Some(client) = clients.get(dns_provider) {
        return Ok(client.clone());
    }
    let client = build_http_client(dns_provider, 10, FETCH_TOTAL_TIMEOUT_SECS)?;
    clients.insert(dns_provider.to_string(), client.clone());
    Ok(client)
}

#[tauri::command]
pub async fn iptv_fetch(url: String, dns_provider: String) -> Result<String, String> {
    let client = shared_client(&dns_provider)?;
    fetch_text(&client, &url, IPTV_FETCH_MAX_BYTES).await
}

/// Comme `iptv_fetch`, pour une adresse reçue d'un autre appareil (connexion de la TV par QR code) :
/// seules les adresses publiques sont jointes, redirections comprises (`public_net.rs`).
#[tauri::command]
pub async fn iptv_fetch_public(url: String, dns_provider: String) -> Result<String, String> {
    crate::public_net::check_start_url(&url)?;
    static CLIENTS: OnceLock<Mutex<HashMap<String, reqwest::Client>>> = OnceLock::new();
    let client = {
        let mut clients = CLIENTS
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        match clients.get(&dns_provider) {
            Some(client) => client.clone(),
            None => {
                let client = crate::public_net::build_public_only_client(&dns_provider, 10, FETCH_TOTAL_TIMEOUT_SECS)?;
                clients.insert(dns_provider.clone(), client.clone());
                client
            }
        }
    };
    fetch_text(&client, &url, IPTV_FETCH_MAX_BYTES).await
}

/// Message d'une erreur réseau. Délai dépassé ou serveur injoignable (DNS, connexion refusée) :
/// préfixe `PROVIDER_UNREACHABLE`, pour que la page ne parle pas d'identifiants refusés.
fn request_error(context: &str, e: reqwest::Error) -> String {
    // without_url(): the reqwest error text embeds the full URL, Xtream credentials included.
    let e = e.without_url();
    if is_certificate_error(&e) {
        format!("{}: {}", PROVIDER_CERTIFICATE_ERROR, e)
    } else if e.is_timeout() || e.is_connect() {
        format!("{}: {}", PROVIDER_UNREACHABLE, e)
    } else {
        format!("{}: {}", context, e)
    }
}

/// Lit une réponse du fournisseur en texte. Une erreur 5xx devient une erreur (avant, la page
/// d'erreur du serveur était rendue comme une vraie réponse), de même qu'un 429 (trop de demandes) :
/// son corps souvent vide passait pour un refus des identifiants. Les autres réponses 4xx sont
/// rendues telles quelles, car certains fournisseurs y mettent la réponse JSON d'authentification.
async fn fetch_text(client: &reqwest::Client, url: &str, max_bytes: usize) -> Result<String, String> {
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|e| request_error("Request failed", e))?;

    let status = response.status();
    if status.is_server_error() || status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Err(format!("{}: HTTP {}", PROVIDER_SERVER_ERROR, status.as_u16()));
    }
    // Jeu de caractères annoncé par le serveur, lu avant de consommer la réponse (comme `text()`)
    let encoding = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .and_then(charset_label)
        .and_then(|label| encoding_rs::Encoding::for_label(label.as_bytes()))
        .unwrap_or(encoding_rs::UTF_8);
    let too_large = || format!("Response too large (over {} bytes)", max_bytes);
    if response.content_length().is_some_and(|len| len > max_bytes as u64) {
        return Err(too_large());
    }
    let mut body: Vec<u8> = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| request_error("Failed to read response", e))?
    {
        if body.len() + chunk.len() > max_bytes {
            return Err(too_large());
        }
        body.extend_from_slice(&chunk);
    }
    // Même décodage que `reqwest::Response::text()` : BOM retiré, jeu de caractères respecté
    let (text, _, _) = encoding.decode(&body);
    Ok(text.into_owned())
}

/// `charset` d'un en-tête `Content-Type` (`application/json; charset=ISO-8859-1` → `ISO-8859-1`).
fn charset_label(content_type: &str) -> Option<String> {
    content_type.split(';').skip(1).find_map(|param| {
        let (key, value) = param.split_once('=')?;
        key.trim()
            .eq_ignore_ascii_case("charset")
            .then(|| value.trim().trim_matches('"').to_string())
    })
}

// ============= Backoff Helper =============

/// Compute exponential backoff delay with pseudo-jitter.
/// Used by fetch_list to avoid retry storms.
fn compute_backoff(attempt: u8) -> std::time::Duration {
    let backoff_ms = (1u64 << attempt) * 1000;
    let jitter_ms = (std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .subsec_millis() as u64)
        % 1000;
    std::time::Duration::from_millis((backoff_ms + jitter_ms) / BANC_BACKOFF_DIVISOR)
}

// ============= Délai et arrêt du téléchargement =============

/// Durée maximale du téléchargement des six listes. Avant, 600 s × 5 essais par liste pouvaient
/// bloquer la connexion ≈ 50 min ; une liste encore en cours à l'échéance échoue, les listes déjà
/// reçues sont écrites et l'ancienne version des autres est gardée (garde-fous habituels).
const FETCH_PHASE_LIMIT: Duration = Duration::from_secs(10 * 60);

/// Numéro de chargement : `cancel_catalog_ingestion` l'augmente, un chargement qui voit le numéro
/// changer s'arrête sans rien écrire.
static INGEST_GENERATION: AtomicU64 = AtomicU64::new(0);

/// Arrête le chargement du catalogue en cours (déconnexion) : avant, la déconnexion ignorait
/// seulement son résultat et le téléchargement continuait.
#[tauri::command]
pub fn cancel_catalog_ingestion() {
    INGEST_GENERATION.fetch_add(1, Ordering::SeqCst);
    log::info!("[Ingestion] Arrêt demandé");
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum Interrupt {
    Deadline,
    Cancelled,
}

/// Échéance et arrêt d'un chargement, appliqués à chaque attente réseau.
#[derive(Clone, Copy)]
pub(crate) struct Stopper {
    deadline: tokio::time::Instant,
    generation: u64,
    source: &'static AtomicU64,
}

impl Stopper {
    pub(crate) fn new(limit: Duration, source: &'static AtomicU64) -> Self {
        Stopper {
            deadline: tokio::time::Instant::now() + limit,
            generation: source.load(Ordering::SeqCst),
            source,
        }
    }

    pub(crate) fn cancelled(&self) -> bool {
        self.source.load(Ordering::SeqCst) != self.generation
    }

    /// Attend `fut`, sauf si l'échéance passe ou si un arrêt est demandé entre-temps.
    pub(crate) async fn run<F: Future>(&self, fut: F) -> Result<F::Output, Interrupt> {
        self.wait(fut, Some(self.deadline)).await
    }

    /// Attend `fut` sans échéance, sauf si un arrêt est demandé (attente de son tour d'écriture :
    /// une déconnexion l'interrompt, la durée du téléchargement ne compte pas).
    pub(crate) async fn run_until_cancelled<F: Future>(&self, fut: F) -> Result<F::Output, Interrupt> {
        self.wait(fut, None).await
    }

    async fn wait<F: Future>(&self, fut: F, deadline: Option<tokio::time::Instant>) -> Result<F::Output, Interrupt> {
        if self.cancelled() {
            return Err(Interrupt::Cancelled);
        }
        tokio::pin!(fut);
        let mut tick = tokio::time::interval(Duration::from_millis(200));
        loop {
            tokio::select! {
                out = &mut fut => return Ok(out),
                _ = async {
                    match deadline {
                        Some(d) => tokio::time::sleep_until(d).await,
                        None => std::future::pending().await,
                    }
                } => return Err(Interrupt::Deadline),
                _ = tick.tick() => {
                    if self.cancelled() {
                        return Err(Interrupt::Cancelled);
                    }
                }
            }
        }
    }
}

// ============= Téléchargement d'une liste =============

/// Résultat d'un essai de téléchargement.
enum Attempt<T> {
    Received(LenientList<T>),
    Http(reqwest::StatusCode),
    Fetch(String),
    Content(ListError),
    /// Réponse au-delà de la taille maximale (annoncée ou reçue) : lecture arrêtée aussitôt
    TooLarge,
}

async fn download_list<T: crate::catalog_parser::ListItem>(client: &reqwest::Client, url: &str, budget: ListBudget<'_>) -> Attempt<T> {
    let max_bytes = budget.max_bytes;
    let mut reserved = Reserved { shared: budget.shared, bytes: 0 };
    let mut response = match client.get(url).send().await {
        Ok(r) => r,
        Err(e) => return Attempt::Fetch(e.without_url().to_string()),
    };
    let status = response.status();
    if !status.is_success() {
        return Attempt::Http(status);
    }
    if response.content_length().is_some_and(|len| len > max_bytes as u64) {
        return Attempt::TooLarge;
    }
    // Lecture par morceaux, coupée dès la borne dépassée (même sans taille annoncée)
    let mut bytes: Vec<u8> = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                if bytes.len() + chunk.len() > max_bytes || !reserved.take(chunk.len()) {
                    return Attempt::TooLarge;
                }
                bytes.extend_from_slice(&chunk);
            }
            Ok(None) => break,
            Err(e) => return Attempt::Fetch(e.without_url().to_string()),
        }
    }
    // Lecture élément par élément : un élément mal formé est écarté
    match parse_list_lenient::<T>(&bytes) {
        Ok(list) => {
            // Liste gardée : sa place reste prise sur le total (la liste lue pèse autant que sa réponse).
            // Une liste vide (essai suivant à venir) la rend, même si sa réponse était énorme.
            if !list.items.is_empty() {
                reserved.bytes = 0;
            }
            Attempt::Received(list)
        }
        Err(e) => Attempt::Content(e),
    }
}

fn warn(logs: &mut Vec<String>, msg: String) {
    log::warn!("[Ingestion] {}", msg);
    logs.push(msg);
}

fn interrupted(endpoint_name: &str, interrupt: Interrupt) -> String {
    match interrupt {
        Interrupt::Deadline => format!("{} timed out", endpoint_name),
        Interrupt::Cancelled => format!("{} cancelled", endpoint_name),
    }
}

/// Télécharge une liste avec nouveaux essais. Retourne la liste (ou l'erreur) et le journal.
async fn fetch_list<T: crate::catalog_parser::ListItem>(
    client: &reqwest::Client,
    url: &str,
    endpoint_name: &str,
    stopper: &Stopper,
    emit: &(dyn Fn(serde_json::Value) + Sync),
    budget: ListBudget<'_>,
) -> (Result<Vec<T>, String>, Vec<String>) {
    fetch_list_with_backoff(client, url, endpoint_name, stopper, emit, compute_backoff, budget).await
}

/// `fetch_list` avec l'attente entre deux essais en paramètre (les tests n'attendent pas).
async fn fetch_list_with_backoff<T: crate::catalog_parser::ListItem>(
    client: &reqwest::Client,
    url: &str,
    endpoint_name: &str,
    stopper: &Stopper,
    emit: &(dyn Fn(serde_json::Value) + Sync),
    backoff: fn(u8) -> std::time::Duration,
    budget: ListBudget<'_>,
) -> (Result<Vec<T>, String>, Vec<String>) {
    const MAX_RETRIES: u8 = 5;
    // Liste lisible mais vide : un seul nouvel essai pour la confirmer (fournisseur instable qui
    // répond vide une fois). Un compte sans chaînes, ou sans films, perdait sinon un quart de minute
    // à chaque chargement sur cinq essais espacés.
    const EMPTY_TRIES: u8 = 2;
    let mut logs: Vec<String> = Vec::new();
    // Vrai tant que chaque essai a reçu une liste lisible mais vide
    let mut always_empty = true;
    let fail = |mut logs: Vec<String>, error: String| {
        warn(&mut logs, format!("⚠ {}", error));
        emit(serde_json::json!({ "endpoint": endpoint_name, "status": "failed", "error": error }));
        (Err(error), logs)
    };

    for attempt in 1..=MAX_RETRIES {
        let outcome = match stopper.run(download_list::<T>(client, url, budget)).await {
            Ok(outcome) => outcome,
            Err(interrupt) => return fail(logs, interrupted(endpoint_name, interrupt)),
        };
        if !matches!(&outcome, Attempt::Received(list) if list.items.is_empty()) {
            always_empty = false;
        }
        match outcome {
            Attempt::Received(list) if !list.items.is_empty() => {
                if list.skipped > 0 {
                    warn(&mut logs, format!("⚠ {}: {} élément(s) illisible(s) écarté(s)", endpoint_name, list.skipped));
                }
                let msg = format!("✓ {} OK ({} items)", endpoint_name, list.items.len());
                log::info!("[Ingestion] {}", msg);
                logs.push(msg);
                emit(serde_json::json!({ "endpoint": endpoint_name, "status": "done", "count": list.items.len() }));
                return (Ok(list.items), logs);
            }
            // Vide à chaque essai, confirmé : rien de ce type chez ce fournisseur
            Attempt::Received(_) if always_empty && attempt >= EMPTY_TRIES => break,
            // Retry si réponse vide (provider flaky)
            Attempt::Received(_) => warn(&mut logs, format!("⚠ {} réponse vide (attempt {}/{})", endpoint_name, attempt, MAX_RETRIES)),
            Attempt::Http(status) => warn(&mut logs, format!("⚠ {} HTTP {} (attempt {}/{})", endpoint_name, status, attempt, MAX_RETRIES)),
            Attempt::Fetch(e) => warn(&mut logs, format!("⚠ {} fetch error (attempt {}/{}): {}", endpoint_name, attempt, MAX_RETRIES, e)),
            // Le fournisseur renverrait la même liste démesurée : pas de nouvel essai
            Attempt::TooLarge => {
                return fail(logs, format!("{}: {} refused (over {} MB, or the catalogue over {} MB)", LIST_TOO_LARGE, endpoint_name, budget.max_bytes / (1024 * 1024), MAX_CATALOG_DOWNLOAD_BYTES / (1024 * 1024)));
            }
            // Trop d'éléments : refusée comme une liste trop grosse (la page l'annonce), pas de nouvel essai
            Attempt::Content(e @ ListError::TooManyItems { .. }) => {
                return fail(logs, format!("{}: {} refused ({})", LIST_TOO_LARGE, endpoint_name, e));
            }
            // Trop d'éléments mal formés : le fournisseur renverrait la même liste, pas de nouvel essai
            Attempt::Content(e @ ListError::TooManyUnreadable { .. }) => {
                return fail(logs, format!("{} refused: {}", endpoint_name, e));
            }
            // Réponse coupée ou qui n'est pas une liste : un nouvel essai peut réussir
            Attempt::Content(e) => warn(&mut logs, format!("⚠ {} parse error (attempt {}/{}): {}", endpoint_name, attempt, MAX_RETRIES, e)),
        }
        if attempt < MAX_RETRIES {
            let delay = backoff(attempt);
            log::warn!("[Ingestion] Retry {}/{} dans {:?}", attempt, MAX_RETRIES, delay);
            if let Err(interrupt) = stopper.run(tokio::time::sleep(delay)).await {
                return fail(logs, interrupted(endpoint_name, interrupt));
            }
        }
    }
    // Liste vide à chaque essai : le fournisseur ne propose pas ce contenu (offre « chaînes
    // seulement »). Ce n'est pas une panne ; write_catalog garde quand même une liste déjà en base.
    if always_empty {
        let msg = format!("✓ {} vide ({} essais) : rien de ce type chez ce fournisseur", endpoint_name, EMPTY_TRIES);
        log::info!("[Ingestion] {}", msg);
        logs.push(msg);
        emit(serde_json::json!({ "endpoint": endpoint_name, "status": "done", "count": 0 }));
        return (Ok(Vec::new()), logs);
    }
    // Tous les retries échoués
    fail(logs, format!("{} failed after {} retries", endpoint_name, MAX_RETRIES))
}

// ============= Catalog Ingestion (SQLite-First) =============

/// Les six listes reçues (vides pour celles qui ont échoué).
#[derive(Default)]
struct FetchedLists {
    movies: Vec<XtreamMovie>,
    series: Vec<XtreamSeries>,
    live: Vec<XtreamLive>,
    vod_cats: Vec<XtreamCategory>,
    series_cats: Vec<XtreamCategory>,
    live_cats: Vec<XtreamCategory>,
}

/// Nombre de lignes écrites par table.
#[derive(Debug, Default, PartialEq)]
struct WriteCounts {
    movies: usize,
    series: usize,
    live: usize,
    categories: usize,
    /// Liste des films reçue et installée en entier (aucun garde-fou n'a gardé l'ancienne)
    movies_replaced: bool,
}

/// Ingère le catalogue IPTV depuis l'API Xtream directement dans SQLite.
/// Remplace le flux JS: fetch → parse → insert par Rust natif.
///
/// ## Arguments
/// * `host` - URL du serveur Xtream (ex: http://provider.com:8080)
/// * `username` - Nom d'utilisateur Xtream
/// * `password` - Mot de passe Xtream
/// * `dns_provider` - Provider DNS ("system", "cloudflare", "quad9")
///
/// ## Returns
/// IngestResult avec les compteurs et durée d'exécution
#[tauri::command]
pub async fn ingest_catalog(
    app: tauri::AppHandle,
    host: String,
    username: String,
    password: String,
    db_name: String,
    dns_provider: String,
) -> Result<IngestResult, String> {
    validate_catalog_db_name(&db_name)?;
    // Pris avant tout : une déconnexion demandée à partir d'ici arrête ce chargement
    let stopper = Stopper::new(FETCH_PHASE_LIMIT, &INGEST_GENERATION);
    // A background catalogue refresh gives way to this full write (db_activity.rs)
    let _heavy = crate::db_activity::HeavyWriteGuard::new();
    let start = std::time::Instant::now();
    let mut all_logs: Vec<String> = Vec::new();
    let mut failed_endpoints: Vec<String> = Vec::new();
    let mut too_large_endpoints: Vec<String> = Vec::new();

    // URL-encode credentials to handle special characters (&, =, #, +, space, @)
    let encoded_user: String = form_urlencoded::byte_serialize(username.as_bytes()).collect();
    let encoded_pass: String = form_urlencoded::byte_serialize(password.as_bytes()).collect();
    let base_url = format!(
        "{}/player_api.php?username={}&password={}",
        host.trim_end_matches('/'),
        encoded_user,
        encoded_pass
    );

    all_logs.push("▶ Démarrage ingestion catalogue".to_string());
    log::info!("[Ingestion] Démarrage ingestion catalogue");

    // Client HTTP avec DNS DoH cascade si configuré
    let client = build_http_client(&dns_provider, 10, 600)?;

    // =========================================================================
    // PHASE 1: Fetch en parallèle avec retry
    // =========================================================================
    let phase_msg = format!(
        "[1/4] Fetch des données (connect 10s, total 600s, 4 retries expo backoff, {} min au plus)...",
        FETCH_PHASE_LIMIT.as_secs() / 60
    );
    all_logs.push(phase_msg.clone());
    log::info!("[Ingestion] {}", phase_msg);
    let _ = app.emit(
        "ingest-progress",
        serde_json::json!({
            "phase": "fetch",
            "status": "started"
        }),
    );

    let movies_url = format!("{}&action=get_vod_streams", base_url);
    let series_url = format!("{}&action=get_series", base_url);
    let live_url = format!("{}&action=get_live_streams", base_url);
    let vod_cats_url = format!("{}&action=get_vod_categories", base_url);
    let series_cats_url = format!("{}&action=get_series_categories", base_url);
    let live_cats_url = format!("{}&action=get_live_categories", base_url);

    let emit = |payload: serde_json::Value| {
        let _ = app.emit("ingest-progress", payload);
    };
    let shared = AtomicUsize::new(MAX_CATALOG_DOWNLOAD_BYTES);
    let list = ListBudget { max_bytes: MAX_LIST_DOWNLOAD_BYTES, shared: &shared };
    let categories = ListBudget { max_bytes: MAX_CATEGORY_LIST_BYTES, shared: &shared };
    let (
        (movies_result, movies_logs),
        (series_result, series_logs),
        (live_result, live_logs),
        (vod_cats_result, vod_cats_logs),
        (series_cats_result, series_cats_logs),
        (live_cats_result, live_cats_logs),
    ) = tokio::join!(
        fetch_list::<XtreamMovie>(&client, &movies_url, "movies", &stopper, &emit, list),
        fetch_list::<XtreamSeries>(&client, &series_url, "series", &stopper, &emit, list),
        fetch_list::<XtreamLive>(&client, &live_url, "live", &stopper, &emit, list),
        fetch_list::<XtreamCategory>(&client, &vod_cats_url, "vod_categories", &stopper, &emit, categories),
        fetch_list::<XtreamCategory>(&client, &series_cats_url, "series_categories", &stopper, &emit, categories),
        fetch_list::<XtreamCategory>(&client, &live_cats_url, "live_categories", &stopper, &emit, categories),
    );

    // Collecter tous les logs des fetches
    all_logs.extend(movies_logs);
    all_logs.extend(series_logs);
    all_logs.extend(live_logs);
    all_logs.extend(vod_cats_logs);
    all_logs.extend(series_cats_logs);
    all_logs.extend(live_cats_logs);

    if stopper.cancelled() {
        log::info!("[Ingestion] Arrêté avant l'écriture (déconnexion)");
        return Err("Catalogue loading cancelled".to_string());
    }

    // =========================================================================
    // PHASE 2: Collecter résultats (graceful sur erreurs)
    // =========================================================================
    all_logs.push("[2/4] Collecte des résultats...".to_string());
    log::info!("[Ingestion] [2/4] Collecte des résultats...");

    let lists = FetchedLists {
        movies: received(movies_result, "movies", &mut failed_endpoints, &mut too_large_endpoints),
        series: received(series_result, "series", &mut failed_endpoints, &mut too_large_endpoints),
        live: received(live_result, "live", &mut failed_endpoints, &mut too_large_endpoints),
        vod_cats: received(vod_cats_result, "vod_categories", &mut failed_endpoints, &mut too_large_endpoints),
        series_cats: received(series_cats_result, "series_categories", &mut failed_endpoints, &mut too_large_endpoints),
        live_cats: received(live_cats_result, "live_categories", &mut failed_endpoints, &mut too_large_endpoints),
    };

    let collected_msg = format!(
        "Collected: {} movies, {} series, {} live, {} categories",
        lists.movies.len(),
        lists.series.len(),
        lists.live.len(),
        lists.vod_cats.len() + lists.series_cats.len() + lists.live_cats.len()
    );
    all_logs.push(collected_msg.clone());
    log::info!("[Ingestion] {}", collected_msg);

    // =========================================================================
    // PHASE 3: Insert SQLite (batch transaction)
    // =========================================================================
    // Waits for a guide write or a channel ↔ guide remap touching the same tables;
    // a logout during the wait stops the load
    let Ok(_turn) = stopper.run_until_cancelled(crate::db_activity::exclusive_write()).await else {
        log::info!("[Ingestion] Arrêté avant l'écriture (déconnexion)");
        return Err("Catalogue loading cancelled".to_string());
    };
    all_logs.push("[3/4] Insertion SQLite...".to_string());
    log::info!("[Ingestion] [3/4] Insertion SQLite...");
    let _ = app.emit(
        "ingest-progress",
        serde_json::json!({
            "phase": "sqlite",
            "status": "started"
        }),
    );

    // Vérifié après l'attente du tour : une source supprimée entre-temps n'est pas recréée
    let db_path = catalog_db_path(&get_data_dir(&app), &db_name)?;
    let mut conn = open_connection(&db_path)?;
    let counts = write_catalog(&mut conn, &lists, &mut failed_endpoints, &mut all_logs)?;
    note_source_provider(&conn, &db_name, &host);
    let progress_relinks = relink_progress_after_write(&mut conn, &counts);

    // =========================================================================
    // PHASE 4: Résultat
    // =========================================================================
    let duration_ms = start.elapsed().as_millis();
    let partial = !failed_endpoints.is_empty();

    let result_msg = if partial {
        format!(
            "⚠ Terminé PARTIELLEMENT en {}ms: {} movies, {} series, {} live (échecs: {:?})",
            duration_ms, counts.movies, counts.series, counts.live, failed_endpoints
        )
    } else {
        format!(
            "✅ Terminé en {}ms: {} movies, {} series, {} live, {} categories",
            duration_ms, counts.movies, counts.series, counts.live, counts.categories
        )
    };
    log::info!("[Ingestion] {}", result_msg);
    all_logs.push(result_msg);
    let _ = app.emit(
        "ingest-progress",
        serde_json::json!({
            "phase": "done",
            "status": if partial { "partial" } else { "complete" },
            "durationMs": duration_ms
        }),
    );

    Ok(IngestResult {
        movies_count: counts.movies,
        series_count: counts.series,
        live_count: counts.live,
        categories_count: counts.categories,
        duration_ms,
        partial,
        failed_endpoints,
        too_large_endpoints,
        logs: all_logs,
        progress_relinks,
    })
}

/// Fichier catalogue d'une source : il note l'adresse avec laquelle il a été rempli, comme la page
/// le fait pour la base du compte. L'actualisation de fond s'arrête si on lui donne une autre
/// adresse (`check_provider`), au lieu de mêler deux fournisseurs dans le même fichier.
fn note_source_provider(conn: &rusqlite::Connection, db_name: &str, host: &str) {
    if crate::storage::validate_source_catalog_name(db_name).is_err() {
        return;
    }
    let noted = conn
        .execute_batch("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);")
        .and_then(|_| crate::catalog_refresh::meta_set(conn, "lastProvider", host));
    if let Err(e) = noted {
        log::warn!("[Ingestion] Adresse de la source non notée : {}", e);
    }
}

/// Reprises de films dont le numéro n'existe plus : re-liées au film de même numéro TMDB, avec la
/// règle de l'actualisation automatique (`relink_orphan_progress`), jamais effacées.
/// Seulement si la liste des films a été reçue et installée en entier :
/// une liste en échec, vide ou gardée par un garde-fou ne dit rien des titres disparus.
fn relink_progress_after_write(
    conn: &mut rusqlite::Connection,
    counts: &WriteCounts,
) -> Vec<crate::catalog_refresh::ProgressRelink> {
    if !counts.movies_replaced {
        return Vec::new();
    }
    crate::catalog_refresh::relink_orphan_progress(conn)
}

/// Liste reçue, ou liste vide notée en échec (graceful sur erreurs).
fn received<T>(
    result: Result<Vec<T>, String>,
    name: &str,
    failed_endpoints: &mut Vec<String>,
    too_large_endpoints: &mut Vec<String>,
) -> Vec<T> {
    result.unwrap_or_else(|e| {
        failed_endpoints.push(name.to_string());
        if e.starts_with(LIST_TOO_LARGE) {
            too_large_endpoints.push(name.to_string());
        }
        Vec::new()
    })
}

fn guard_log(all_logs: &mut Vec<String>, msg: String) {
    log::info!("[Ingestion] {}", msg);
    all_logs.push(msg);
}

/// Écrit les listes reçues dans une transaction unique. Une table n'est remplacée que si sa
/// nouvelle liste est là et saine (garde-fous) ; sinon ses lignes actuelles sont gardées.
fn write_catalog(
    conn: &mut rusqlite::Connection,
    lists: &FetchedLists,
    failed_endpoints: &mut Vec<String>,
    all_logs: &mut Vec<String>,
) -> Result<WriteCounts, String> {
    // Transaction unique pour performance. Prise en écriture dès le début (IMMEDIATE), elle attend
    // qu'une autre écriture se termine. Avant, elle commençait par lire (garde-fou TMDB) puis montait
    // en écriture : si un autre écrivain validait entre les deux, la montée était refusée aussitôt
    // (« database is locked »), quelle que soit l'attente réglée.
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| format!("Transaction start failed: {}", e))?;

    // ===================================================================
    // Guard per-table : ne pas écraser avec du vide (provider flaky)
    // Si un endpoint a retourné [], on conserve les données existantes.
    // Liste vide et table vide : le fournisseur n'a pas ce type de contenu (offre « chaînes
    // seulement »), rien n'est gardé, ce n'est donc pas un échec.
    // ===================================================================
    let has_rows = |sql: &str, params: &[&dyn rusqlite::ToSql]| -> bool {
        tx.query_row(sql, params, |r| r.get::<_, i64>(0)).map(|n| n > 0).unwrap_or(true)
    };
    // Une liste dont le téléchargement a échoué n'est jamais « absente »
    let absent = |items_empty: bool, endpoint: &str, table_sql: &str| -> bool {
        items_empty && !failed_endpoints.iter().any(|f| f == endpoint) && !has_rows(table_sql, &[])
    };
    let movies_absent = absent(lists.movies.is_empty(), "movies", "SELECT EXISTS(SELECT 1 FROM movies)");
    let series_absent = absent(lists.series.is_empty(), "series", "SELECT EXISTS(SELECT 1 FROM series)");
    let live_absent = absent(lists.live.is_empty(), "live", "SELECT EXISTS(SELECT 1 FROM live)");

    // --- movies ---
    let movies_inserted = if !lists.movies.is_empty() {
        // Guard qualité TMDB: vérifier que les nouvelles données ne sont pas dégradées
        let new_tmdb_count = lists
            .movies
            .iter()
            .filter(|m| normalize_tmdb(&m.tmdb).is_some())
            .count() as i64;
        let existing_tmdb: i64 = tx
            .query_row(
                "SELECT COUNT(*) FROM movies WHERE tmdb_id IS NOT NULL AND tmdb_id > 0",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0);

        if existing_tmdb > 0 && new_tmdb_count < existing_tmdb / 2 {
            // Dégradation TMDB > 50% → garder l'existant
            guard_log(all_logs, format!(
                "⛔ GUARD TMDB: movies dégradé ({} → {} TMDB IDs, seuil {}), données conservées",
                existing_tmdb, new_tmdb_count, existing_tmdb / 2
            ));
            failed_endpoints.push("movies_tmdb_guarded".to_string());
            None
        } else {
            guard_log(all_logs, format!(
                "✓ TMDB quality OK: movies {} → {} TMDB IDs",
                existing_tmdb, new_tmdb_count
            ));
            tx.execute("DROP INDEX IF EXISTS idx_movies_tmdb", []).ok();
            tx.execute("DROP INDEX IF EXISTS idx_movies_category", [])
                .ok();
            tx.execute("DROP INDEX IF EXISTS idx_movies_added", []).ok();
            tx.execute("DELETE FROM movies", [])
                .map_err(|e| format!("Failed to clear movies: {}", e))?;
            Some(insert_movies(&tx, &lists.movies)?)
        }
    } else if movies_absent {
        guard_log(all_logs, "✓ movies vide et aucun en base : pas de films chez ce fournisseur".to_string());
        None
    } else {
        guard_log(all_logs, "⛔ GUARD: movies vide → données existantes conservées".to_string());
        failed_endpoints.push("movies_guarded".to_string());
        None
    };

    // --- series ---
    let series_inserted = if !lists.series.is_empty() {
        // Guard qualité TMDB
        let new_tmdb_count = lists
            .series
            .iter()
            .filter(|s| normalize_tmdb(&s.tmdb_id).is_some())
            .count() as i64;
        let existing_tmdb: i64 = tx
            .query_row(
                "SELECT COUNT(*) FROM series WHERE tmdb_id IS NOT NULL AND tmdb_id > 0",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0);

        if existing_tmdb > 0 && new_tmdb_count < existing_tmdb / 2 {
            guard_log(all_logs, format!(
                "⛔ GUARD TMDB: series dégradé ({} → {} TMDB IDs, seuil {}), données conservées",
                existing_tmdb, new_tmdb_count, existing_tmdb / 2
            ));
            failed_endpoints.push("series_tmdb_guarded".to_string());
            None
        } else {
            guard_log(all_logs, format!(
                "✓ TMDB quality OK: series {} → {} TMDB IDs",
                existing_tmdb, new_tmdb_count
            ));
            tx.execute("DROP INDEX IF EXISTS idx_series_tmdb", []).ok();
            tx.execute("DROP INDEX IF EXISTS idx_series_category", [])
                .ok();
            tx.execute("DELETE FROM series", [])
                .map_err(|e| format!("Failed to clear series: {}", e))?;
            Some(insert_series(&tx, &lists.series)?)
        }
    } else if series_absent {
        guard_log(all_logs, "✓ series vide et aucun en base : pas de séries chez ce fournisseur".to_string());
        None
    } else {
        guard_log(all_logs, "⛔ GUARD: series vide → données existantes conservées".to_string());
        failed_endpoints.push("series_guarded".to_string());
        None
    };

    // --- live ---
    let live_inserted = if !lists.live.is_empty() {
        tx.execute("DROP INDEX IF EXISTS idx_live_category", [])
            .ok();
        tx.execute("DELETE FROM live", [])
            .map_err(|e| format!("Failed to clear live: {}", e))?;
        Some(insert_live(&tx, &lists.live)?)
    } else if live_absent {
        guard_log(all_logs, "✓ live vide et aucun en base : pas de chaînes chez ce fournisseur".to_string());
        None
    } else {
        guard_log(all_logs, "⛔ GUARD: live vide → données existantes conservées".to_string());
        failed_endpoints.push("live_guarded".to_string());
        None
    };

    // --- categories per-type ---
    // Les catégories d'un type ne sont remplacées qu'avec ses éléments : quand un garde-fou garde
    // les anciens films, leurs anciennes catégories restent aussi, sinon des films gardés
    // pointeraient vers des catégories disparues et deviendraient invisibles.
    let mut categories_to_write = |cats: &[XtreamCategory], items_replaced: bool, items_absent: bool, cat_type: &str, endpoint: &str| -> Result<bool, String> {
        if cats.is_empty() && items_absent && !has_rows("SELECT EXISTS(SELECT 1 FROM categories WHERE type = ?1)", &[&cat_type]) {
            guard_log(all_logs, format!("✓ {} vide : type absent chez ce fournisseur", endpoint));
            return Ok(false);
        }
        if cats.is_empty() {
            guard_log(all_logs, format!("⛔ GUARD: {} vide → conservé", endpoint));
            failed_endpoints.push(format!("{}_guarded", endpoint));
            return Ok(false);
        }
        if !items_replaced {
            guard_log(all_logs, format!("⛔ GUARD: {} gardées avec leurs éléments", endpoint));
            return Ok(false);
        }
        tx.execute("DELETE FROM categories WHERE type = ?1", [cat_type])
            .map_err(|e| format!("Failed to clear {}: {}", endpoint, e))?;
        Ok(true)
    };
    let vod_ok = categories_to_write(&lists.vod_cats, movies_inserted.is_some(), movies_absent, "movie", "vod_categories")?;
    let series_ok = categories_to_write(&lists.series_cats, series_inserted.is_some(), series_absent, "series", "series_categories")?;
    let live_ok = categories_to_write(&lists.live_cats, live_inserted.is_some(), live_absent, "live", "live_categories")?;
    // insert_categories insère uniquement les listes non vides
    let cats_inserted = insert_categories(
        &tx,
        if vod_ok { &lists.vod_cats } else { &[] },
        if series_ok { &lists.series_cats } else { &[] },
        if live_ok { &lists.live_cats } else { &[] },
    )?;

    // DIAG: Vérifier le contenu avant commit
    let count = |table: &str| -> i64 {
        tx.query_row(&format!("SELECT COUNT(*) FROM {}", table), [], |r| r.get(0))
            .unwrap_or(-1)
    };
    let diag_msg = format!(
        "[DIAG] Avant commit: {} movies, {} series, {} live en DB",
        count("movies"),
        count("series"),
        count("live")
    );
    log::debug!("[Ingestion] {}", diag_msg);
    all_logs.push(diag_msg);

    // Commit transaction
    tx.commit()
        .map_err(|e| format!("Transaction commit failed: {}", e))?;

    // Recreate indexes after bulk insert (performance optimization). If the app is killed right
    // here, the page recreates them at the next start (MERGED_SCHEMA in dbCore.ts).
    recreate_indexes(conn)?;

    // CRITICAL: Force WAL checkpoint to flush data into the main .db file.
    // Without this, data stays in the WAL file and may not be visible
    // to the page's database connection on next app restart.
    conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
        .map_err(|e| format!("WAL checkpoint failed: {}", e))?;

    Ok(WriteCounts {
        movies_replaced: movies_inserted.is_some(),
        movies: movies_inserted.unwrap_or(0),
        series: series_inserted.unwrap_or(0),
        live: live_inserted.unwrap_or(0),
        categories: cats_inserted,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    /// Petit serveur local : chaque connexion reçoit la réponse brute suivante de `responses`
    /// (la dernière est répétée) ; `None` = connexion acceptée mais jamais de réponse (serveur figé).
    fn serve(responses: Vec<Option<Vec<u8>>>) -> (String, std::sync::Arc<std::sync::atomic::AtomicUsize>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let hits = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = hits.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let n = counter.fetch_add(1, Ordering::SeqCst);
                let response = responses[n.min(responses.len() - 1)].clone();
                std::thread::spawn(move || {
                    let mut buf = [0u8; 4096];
                    let mut request = Vec::new();
                    while !request.windows(4).any(|w| w == b"\r\n\r\n") {
                        match stream.read(&mut buf) {
                            Ok(0) | Err(_) => return,
                            Ok(k) => request.extend_from_slice(&buf[..k]),
                        }
                    }
                    match response {
                        Some(r) => {
                            let _ = stream.write_all(&r);
                        }
                        None => std::thread::sleep(Duration::from_secs(30)),
                    }
                });
            }
        });
        (format!("http://{}/player_api.php", addr), hits)
    }

    fn http(status: &str, body: &str) -> Option<Vec<u8>> {
        Some(format!(
            "HTTP/1.1 {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            status,
            body.len(),
            body
        ).into_bytes())
    }

    fn client() -> reqwest::Client {
        reqwest::Client::builder().no_proxy().build().unwrap()
    }

    fn no_emit(_: serde_json::Value) {}

    // ---------- Horloge du banc ----------

    #[test]
    fn publication_keeps_app_delays() {
        // cargo test compile sans la fonction `audit` : les délais sont ceux de l'app publiée
        const { assert!(!BANC) };
        assert_eq!(FETCH_TOTAL_TIMEOUT_SECS, 60);
        assert_eq!(BANC_BACKOFF_DIVISOR, 1);
        let d = compute_backoff(1);
        assert!(d >= Duration::from_secs(2) && d < Duration::from_secs(3), "{:?}", d);
    }

    // ---------- Erreur serveur ----------

    #[tokio::test]
    async fn server_error_is_an_error_not_a_response() {
        let (url, _) = serve(vec![http("500 Internal Server Error", "<html>oops</html>")]);
        let err = fetch_text(&client(), &url, 1024).await.unwrap_err();
        assert!(err.starts_with(PROVIDER_SERVER_ERROR), "{}", err);
        assert!(err.contains("500"));
    }

    #[tokio::test]
    async fn too_many_requests_is_an_error_not_a_refusal() {
        // Trop de demandes, corps vide : lu avant comme une réponse vide, donc « identifiants refusés »
        let (url, _) = serve(vec![http("429 Too Many Requests", "")]);
        let err = fetch_text(&client(), &url, 1024).await.unwrap_err();
        assert!(err.starts_with(PROVIDER_SERVER_ERROR), "{}", err);
        assert!(err.contains("429"));
    }

    // ---------- Serveur injoignable : même message « ne répond pas » que la panne 5xx ----------

    /// Adresse avec des identifiants : l'erreur rendue à la page ne doit jamais les contenir.
    const SECRET_QUERY: &str = "?username=john&password=s3cret";

    fn assert_unreachable(err: &str) {
        assert!(err.starts_with(PROVIDER_UNREACHABLE), "{}", err);
        assert!(!err.contains("s3cret") && !err.contains("john"), "{}", err);
    }

    #[tokio::test]
    async fn timeout_is_reported_as_unreachable() {
        let (url, _) = serve(vec![None]);
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_millis(300))
            .build()
            .unwrap();
        let err = fetch_text(&client, &format!("{}{}", url, SECRET_QUERY), 1024).await.unwrap_err();
        assert_unreachable(&err);
    }

    #[tokio::test]
    async fn refused_connection_is_reported_as_unreachable() {
        // Port libéré juste après : plus personne n'écoute dessus
        let addr = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap();
        let url = format!("http://{}/player_api.php{}", addr, SECRET_QUERY);
        assert_unreachable(&fetch_text(&client(), &url, 1024).await.unwrap_err());
    }

    /// Résolveur qui ne trouve jamais l'adresse, comme un nom de serveur inexistant.
    struct NoSuchHost;
    impl reqwest::dns::Resolve for NoSuchHost {
        fn resolve(&self, _: reqwest::dns::Name) -> reqwest::dns::Resolving {
            Box::pin(async { Err("no record found".into()) })
        }
    }

    #[tokio::test]
    async fn unknown_host_is_reported_as_unreachable() {
        let client = reqwest::Client::builder()
            .no_proxy()
            .dns_resolver(std::sync::Arc::new(NoSuchHost))
            .build()
            .unwrap();
        let url = format!("http://fournisseur-inexistant.invalid/player_api.php{}", SECRET_QUERY);
        assert_unreachable(&fetch_text(&client, &url, 1024).await.unwrap_err());
    }

    /// Erreur réseau imbriquée, comme celles de reqwest (cause dans `source`)
    #[derive(Debug)]
    struct Layer(&'static str, Option<Box<Layer>>);
    impl std::fmt::Display for Layer {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str(self.0)
        }
    }
    impl std::error::Error for Layer {
        fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
            self.1.as_deref().map(|e| e as _)
        }
    }

    #[test]
    fn a_refused_certificate_is_told_apart_from_an_unreachable_server() {
        let chain = |cause: &'static str| Layer("error sending request", Some(Box::new(Layer("client error (Connect)", Some(Box::new(Layer(cause, None)))))));
        // rustls (Android), Windows en anglais et en français
        for cause in [
            "invalid peer certificate: UnknownIssuer",
            "The certificate chain was issued by an authority that is not trusted.",
            "La chaîne de certificats a été émise par une autorité qui n'est pas approuvée.",
        ] {
            assert!(super::is_certificate_error(&chain(cause)), "{}", cause);
        }
        for cause in ["Connection refused (os error 111)", "dns error: failed to lookup address", "operation timed out"] {
            assert!(!super::is_certificate_error(&chain(cause)), "{}", cause);
        }
    }

    #[tokio::test]
    async fn client_error_body_is_still_returned() {
        // Réponse d'authentification refusée envoyée avec un 401 : la page la lit comme avant
        let body = r#"{"user_info":{"auth":0}}"#;
        let (url, _) = serve(vec![http("401 Unauthorized", body)]);
        assert_eq!(fetch_text(&client(), &url, 1024).await.unwrap(), body);
    }

    #[tokio::test]
    async fn body_is_decoded_like_before_bom_and_charset() {
        // Réponse commençant par un BOM (panneaux PHP) : retiré, sinon JSON.parse échoue côté page
        let (url, _) = serve(vec![http("200 OK", "\u{FEFF}{\"user_info\":{\"auth\":1}}")]);
        assert_eq!(fetch_text(&client(), &url, 1024).await.unwrap(), "{\"user_info\":{\"auth\":1}}");
        // Serveur en latin-1 : « é » envoyé en un seul octet 0xE9
        let raw = b"HTTP/1.1 200 OK\r\nContent-Type: application/json; charset=ISO-8859-1\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{\"n\":\"\xE9t\xE9\"}".to_vec();
        let (url, _) = serve(vec![Some(raw)]);
        assert_eq!(fetch_text(&client(), &url, 1024).await.unwrap(), "{\"n\":\"été\"}");
    }

    #[test]
    fn charset_is_read_from_the_content_type() {
        assert_eq!(charset_label("application/json; charset=\"ISO-8859-1\""), Some("ISO-8859-1".to_string()));
        assert_eq!(charset_label("text/html;Charset=utf-8"), Some("utf-8".to_string()));
        assert_eq!(charset_label("application/json"), None);
    }

    #[tokio::test]
    async fn oversized_response_is_refused() {
        let body = "x".repeat(2048);
        let (url, _) = serve(vec![http("200 OK", &body)]);
        assert!(fetch_text(&client(), &url, 1024).await.unwrap_err().contains("too large"));
        let (url, _) = serve(vec![http("200 OK", &body)]);
        assert_eq!(fetch_text(&client(), &url, 4096).await.unwrap(), body);
    }

    // ---------- Délai global et arrêt ----------

    #[tokio::test]
    async fn a_frozen_provider_stops_at_the_deadline() {
        static SOURCE: AtomicU64 = AtomicU64::new(0);
        let (url, _) = serve(vec![None]);
        let stopper = Stopper::new(Duration::from_millis(400), &SOURCE);
        let started = std::time::Instant::now();
        let (result, _) = fetch_list::<XtreamLive>(&client(), &url, "live", &stopper, &no_emit, budget(MAX_LIST_DOWNLOAD_BYTES, &unlimited())).await;
        assert_eq!(result.unwrap_err(), "live timed out");
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[tokio::test]
    async fn a_cancel_stops_the_download() {
        static SOURCE: AtomicU64 = AtomicU64::new(0);
        let (url, _) = serve(vec![None]);
        let stopper = Stopper::new(Duration::from_secs(600), &SOURCE);
        let started = std::time::Instant::now();
        tokio::spawn(async {
            tokio::time::sleep(Duration::from_millis(300)).await;
            SOURCE.fetch_add(1, Ordering::SeqCst);
        });
        let (result, _) = fetch_list::<XtreamLive>(&client(), &url, "live", &stopper, &no_emit, budget(MAX_LIST_DOWNLOAD_BYTES, &unlimited())).await;
        assert_eq!(result.unwrap_err(), "live cancelled");
        assert!(stopper.cancelled());
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[tokio::test]
    async fn a_cancel_also_stops_the_wait_between_two_tries() {
        static SOURCE: AtomicU64 = AtomicU64::new(0);
        let (url, hits) = serve(vec![http("503 Service Unavailable", "")]);
        let stopper = Stopper::new(Duration::from_secs(600), &SOURCE);
        tokio::spawn(async {
            tokio::time::sleep(Duration::from_millis(500)).await;
            SOURCE.fetch_add(1, Ordering::SeqCst);
        });
        let (result, _) = fetch_list::<XtreamLive>(&client(), &url, "live", &stopper, &no_emit, budget(MAX_LIST_DOWNLOAD_BYTES, &unlimited())).await;
        assert_eq!(result.unwrap_err(), "live cancelled");
        assert_eq!(hits.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn a_logout_interrupts_the_wait_for_the_write_turn() {
        static SOURCE: AtomicU64 = AtomicU64::new(0);
        // Une écriture du guide tient son tour ; la déconnexion arrive pendant l'attente
        let lock = tokio::sync::Mutex::new(());
        let held = lock.lock().await;
        let stopper = Stopper::new(Duration::from_millis(50), &SOURCE);
        tokio::spawn(async {
            tokio::time::sleep(Duration::from_millis(300)).await;
            SOURCE.fetch_add(1, Ordering::SeqCst);
        });
        // L'échéance du téléchargement (50 ms) ne compte pas pour cette attente : seul l'arrêt la coupe
        let waited = stopper.run_until_cancelled(lock.lock()).await;
        assert_eq!(waited.err(), Some(Interrupt::Cancelled));
        drop(held);
    }

    #[test]
    fn cancel_command_changes_the_generation() {
        let stopper = Stopper::new(Duration::from_secs(600), &INGEST_GENERATION);
        assert!(!stopper.cancelled());
        cancel_catalog_ingestion();
        assert!(stopper.cancelled());
        // Un chargement lancé après l'arrêt n'est pas touché par lui
        assert!(!Stopper::new(Duration::from_secs(600), &INGEST_GENERATION).cancelled());
    }

    // ---------- Un élément mal formé ne fait plus refuser la liste ----------

    fn live_list(n: usize, bad: usize) -> String {
        let mut items: Vec<String> = (0..n)
            .map(|i| format!(r#"{{"stream_id":{},"name":"Chaîne {}","category_id":"1"}}"#, i + 1, i + 1))
            .collect();
        for item in items.iter_mut().take(bad) {
            *item = r#"{"stream_id":"pas-un-numero","name":"Cassée"}"#.to_string();
        }
        format!("[{}]", items.join(","))
    }

    #[tokio::test]
    async fn one_bad_item_is_skipped_and_the_list_kept() {
        static SOURCE: AtomicU64 = AtomicU64::new(0);
        let (url, hits) = serve(vec![http("200 OK", &live_list(200, 1))]);
        let stopper = Stopper::new(Duration::from_secs(60), &SOURCE);
        let (result, logs) = fetch_list::<XtreamLive>(&client(), &url, "live", &stopper, &no_emit, budget(MAX_LIST_DOWNLOAD_BYTES, &unlimited())).await;
        assert_eq!(result.unwrap().len(), 199);
        assert!(logs.iter().any(|l| l.contains("1 élément(s) illisible(s)")));
        assert_eq!(hits.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn too_many_bad_items_refuse_the_list_without_downloading_it_again() {
        static SOURCE: AtomicU64 = AtomicU64::new(0);
        let (url, hits) = serve(vec![http("200 OK", &live_list(100, 5))]);
        let stopper = Stopper::new(Duration::from_secs(60), &SOURCE);
        let (result, _) = fetch_list::<XtreamLive>(&client(), &url, "live", &stopper, &no_emit, budget(MAX_LIST_DOWNLOAD_BYTES, &unlimited())).await;
        assert_eq!(result.unwrap_err(), "live refused: 5 unreadable items of 100");
        assert_eq!(hits.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn a_list_over_the_item_cap_is_refused_as_too_large_without_retry() {
        // Une réponse de petits éléments sous la borne en octets
        static SOURCE: AtomicU64 = AtomicU64::new(0);
        let body = format!("[{}]", vec!["0"; 500_001].join(","));
        let (url, hits) = serve(vec![http("200 OK", &body)]);
        let stopper = Stopper::new(Duration::from_secs(60), &SOURCE);
        let (result, _) = fetch_list_with_backoff::<XtreamMovie>(&client(), &url, "movies", &stopper, &no_emit, no_wait, budget(MAX_LIST_DOWNLOAD_BYTES, &unlimited())).await;
        let err = result.unwrap_err();
        assert!(err.starts_with(LIST_TOO_LARGE), "{}", err);
        assert!(err.contains("movies") && err.contains("500000"), "{}", err);
        assert_eq!(hits.load(Ordering::SeqCst), 1);
    }

    // ---------- Liste démesurée au chargement complet ----------

    /// Réponse sans `Content-Length`, terminée par la fermeture de la connexion.
    fn http_unsized(body: &str) -> Option<Vec<u8>> {
        Some(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{}", body).into_bytes())
    }

    #[tokio::test]
    async fn a_list_announced_over_the_cap_is_refused_without_retry() {
        static SOURCE: AtomicU64 = AtomicU64::new(0);
        let body = live_list(50, 0);
        let (url, hits) = serve(vec![http("200 OK", &body)]);
        let stopper = Stopper::new(Duration::from_secs(60), &SOURCE);
        let (result, _) = fetch_list_with_backoff::<XtreamLive>(&client(), &url, "live", &stopper, &no_emit, no_wait, budget(body.len() - 1, &unlimited())).await;
        let err = result.unwrap_err();
        assert!(err.starts_with(LIST_TOO_LARGE), "{}", err);
        assert!(err.contains("live"), "{}", err);
        // Le fournisseur renverrait la même liste : un seul téléchargement
        assert_eq!(hits.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn a_list_growing_over_the_cap_without_announced_size_is_cut() {
        static SOURCE: AtomicU64 = AtomicU64::new(0);
        let body = live_list(50, 0);
        let (url, _) = serve(vec![http_unsized(&body)]);
        let stopper = Stopper::new(Duration::from_secs(60), &SOURCE);
        let (result, _) = fetch_list_with_backoff::<XtreamLive>(&client(), &url, "live", &stopper, &no_emit, no_wait, budget(body.len() - 1, &unlimited())).await;
        assert!(result.unwrap_err().starts_with(LIST_TOO_LARGE));
    }

    #[tokio::test]
    async fn a_list_at_the_cap_is_still_received() {
        static SOURCE: AtomicU64 = AtomicU64::new(0);
        let body = live_list(50, 0);
        let (url, _) = serve(vec![http_unsized(&body)]);
        let stopper = Stopper::new(Duration::from_secs(60), &SOURCE);
        let (result, _) = fetch_list_with_backoff::<XtreamLive>(&client(), &url, "live", &stopper, &no_emit, no_wait, budget(body.len(), &unlimited())).await;
        assert_eq!(result.unwrap().len(), 50);
    }

    fn unlimited() -> AtomicUsize {
        AtomicUsize::new(usize::MAX)
    }

    fn budget(max_bytes: usize, shared: &AtomicUsize) -> ListBudget<'_> {
        ListBudget { max_bytes, shared }
    }

    /// Six listes en même temps : leur total aussi est borné, et la place d'une liste refusée ou
    /// d'un essai raté est rendue.
    #[tokio::test]
    async fn the_lists_together_share_one_cap() {
        static SOURCE: AtomicU64 = AtomicU64::new(0);
        let body = live_list(50, 0);
        let (url, _) = serve(vec![http_unsized(&body)]);
        let stopper = Stopper::new(Duration::from_secs(60), &SOURCE);
        // Room for one list, not two
        let shared = AtomicUsize::new(body.len() + body.len() / 2);
        let (first, _) = fetch_list_with_backoff::<XtreamLive>(&client(), &url, "live", &stopper, &no_emit, no_wait, budget(body.len(), &shared)).await;
        assert_eq!(first.unwrap().len(), 50);
        let (second, _) = fetch_list_with_backoff::<XtreamLive>(&client(), &url, "series", &stopper, &no_emit, no_wait, budget(body.len(), &shared)).await;
        assert!(second.unwrap_err().starts_with(LIST_TOO_LARGE));
        // The refused list gave back what it had taken; the kept one still holds its share
        assert_eq!(shared.load(Ordering::SeqCst), body.len() / 2);
    }

    /// A list read as empty (a huge answer of blanks) gives its share back: the next try and the
    /// other lists are not refused for it.
    #[tokio::test]
    async fn an_empty_list_gives_its_share_back() {
        static SOURCE: AtomicU64 = AtomicU64::new(0);
        let body = format!("[{}]", " ".repeat(10_000));
        let (url, _) = serve(vec![http_unsized(&body)]);
        let stopper = Stopper::new(Duration::from_secs(60), &SOURCE);
        let shared = AtomicUsize::new(body.len() + 10);
        let (result, _) = fetch_list_with_backoff::<XtreamLive>(&client(), &url, "live", &stopper, &no_emit, no_wait, budget(body.len(), &shared)).await;
        assert!(result.unwrap().is_empty());
        assert_eq!(shared.load(Ordering::SeqCst), body.len() + 10);
    }

    #[test]
    fn a_too_large_list_is_reported_apart() {
        let (mut failed, mut too_large) = (Vec::new(), Vec::new());
        received::<u8>(Err(format!("{}: movies refused (over 512 MB)", LIST_TOO_LARGE)), "movies", &mut failed, &mut too_large);
        received::<u8>(Err("series failed after 5 retries".into()), "series", &mut failed, &mut too_large);
        assert_eq!(failed, vec!["movies", "series"]);
        assert_eq!(too_large, vec!["movies"]);
    }

    // ---------- Fournisseur « chaînes seulement » ----------

    fn no_wait(_: u8) -> Duration {
        Duration::ZERO
    }

    #[tokio::test]
    async fn a_list_empty_on_every_try_is_received_empty_not_failed() {
        static SOURCE: AtomicU64 = AtomicU64::new(0);
        let (url, hits) = serve(vec![http("200 OK", "[]")]);
        let stopper = Stopper::new(Duration::from_secs(60), &SOURCE);
        let (result, _) = fetch_list_with_backoff::<XtreamMovie>(&client(), &url, "movies", &stopper, &no_emit, no_wait, budget(MAX_LIST_DOWNLOAD_BYTES, &unlimited())).await;
        // Avant le correctif : Err("movies failed after 5 retries"), donc chargement « partiel »
        assert!(result.unwrap().is_empty());
        // Un seul nouvel essai pour confirmer (fournisseur instable qui répond vide une fois) ; cinq
        // essais espacés faisaient perdre un quart de minute à un compte sans ce type de contenu
        assert_eq!(hits.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn a_list_empty_then_failing_is_still_a_failure() {
        static SOURCE: AtomicU64 = AtomicU64::new(0);
        let (url, _) = serve(vec![http("200 OK", "[]"), http("503 Service Unavailable", "")]);
        let stopper = Stopper::new(Duration::from_secs(60), &SOURCE);
        let (result, _) = fetch_list_with_backoff::<XtreamMovie>(&client(), &url, "movies", &stopper, &no_emit, no_wait, budget(MAX_LIST_DOWNLOAD_BYTES, &unlimited())).await;
        assert_eq!(result.unwrap_err(), "movies failed after 5 retries");
    }

    #[tokio::test]
    async fn an_empty_list_after_retries_returns_the_items_received_later() {
        static SOURCE: AtomicU64 = AtomicU64::new(0);
        let (url, hits) = serve(vec![http("200 OK", "[]"), http("200 OK", &live_list(3, 0))]);
        let stopper = Stopper::new(Duration::from_secs(60), &SOURCE);
        let (result, _) = fetch_list_with_backoff::<XtreamLive>(&client(), &url, "live", &stopper, &no_emit, no_wait, budget(MAX_LIST_DOWNLOAD_BYTES, &unlimited())).await;
        assert_eq!(result.unwrap().len(), 3);
        assert_eq!(hits.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn a_channels_only_provider_is_not_a_partial_catalogue() {
        let (path, mut conn) = temp_db("channels-only");
        let lists = FetchedLists {
            live: serde_json::from_str(r#"[{"stream_id":1,"name":"Chaîne 1","category_id":"1"}]"#).unwrap(),
            live_cats: cats(r#"[{"category_id":"1","category_name":"Infos"}]"#),
            ..Default::default()
        };
        let mut failed = Vec::new();
        let counts = write_catalog(&mut conn, &lists, &mut failed, &mut Vec::new()).unwrap();
        assert_eq!(counts.live, 1);
        // Avant le correctif : movies_guarded, series_guarded, vod_categories_guarded, series_categories_guarded
        assert!(failed.is_empty(), "{:?}", failed);

        // Une seconde fois : toujours rien à garder, toujours pas d'échec
        let mut failed = Vec::new();
        write_catalog(&mut conn, &lists, &mut failed, &mut Vec::new()).unwrap();
        assert!(failed.is_empty(), "{:?}", failed);

        drop(conn);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_failed_download_is_never_taken_for_an_absent_type() {
        let (path, mut conn) = temp_db("failed-not-absent");
        let lists = FetchedLists {
            live: serde_json::from_str(r#"[{"stream_id":1,"name":"Chaîne 1","category_id":"1"}]"#).unwrap(),
            ..Default::default()
        };
        // Les films ont échoué au téléchargement (noté par `received`), base encore vide
        let mut failed = vec!["movies".to_string()];
        write_catalog(&mut conn, &lists, &mut failed, &mut Vec::new()).unwrap();
        assert!(failed.contains(&"movies_guarded".to_string()));
        assert!(!failed.contains(&"series_guarded".to_string()));

        drop(conn);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn films_that_vanish_are_still_kept_and_reported() {
        let (path, mut conn) = temp_db("vanish");
        let first = FetchedLists {
            movies: movies(r#"[{"stream_id":1,"name":"A","category_id":"10"}]"#),
            vod_cats: cats(r#"[{"category_id":"10","category_name":"Action"}]"#),
            live: serde_json::from_str(r#"[{"stream_id":2,"name":"Chaîne","category_id":"1"}]"#).unwrap(),
            ..Default::default()
        };
        write_catalog(&mut conn, &first, &mut Vec::new(), &mut Vec::new()).unwrap();
        // Films déjà en base, puis liste vide : garde-fou (fournisseur instable), signalé comme avant
        let only_live = FetchedLists {
            live: serde_json::from_str(r#"[{"stream_id":2,"name":"Chaîne","category_id":"1"}]"#).unwrap(),
            ..Default::default()
        };
        let mut failed = Vec::new();
        write_catalog(&mut conn, &only_live, &mut failed, &mut Vec::new()).unwrap();
        assert!(failed.contains(&"movies_guarded".to_string()));
        assert!(failed.contains(&"vod_categories_guarded".to_string()));
        assert_eq!(movie_categories(&conn), vec!["10".to_string()]);

        drop(conn);
        let _ = std::fs::remove_file(&path);
    }

    // ---------- Catégories gardées avec leurs éléments ----------

    fn temp_db(name: &str) -> (std::path::PathBuf, rusqlite::Connection) {
        let path = std::env::temp_dir().join(format!(
            "nyx-ingestion-{}-{}-{}.db",
            name,
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        let conn = open_connection(&path).unwrap();
        (path, conn)
    }

    fn movies(json: &str) -> Vec<XtreamMovie> {
        serde_json::from_str(json).unwrap()
    }

    fn cats(json: &str) -> Vec<XtreamCategory> {
        serde_json::from_str(json).unwrap()
    }

    fn movie_categories(conn: &rusqlite::Connection) -> Vec<String> {
        let mut stmt = conn
            .prepare("SELECT id FROM categories WHERE type = 'movie' ORDER BY id")
            .unwrap();
        stmt.query_map([], |r| r.get(0)).unwrap().map(Result::unwrap).collect()
    }

    #[test]
    fn categories_are_kept_when_their_movies_are_kept() {
        let (path, mut conn) = temp_db("guard");
        // Base actuelle : deux films avec TMDB, dans la catégorie 10
        let first = FetchedLists {
            movies: movies(
                r#"[{"stream_id":1,"name":"A","category_id":"10","tmdb":"100"},
                    {"stream_id":2,"name":"B","category_id":"10","tmdb":"200"}]"#,
            ),
            vod_cats: cats(r#"[{"category_id":"10","category_name":"Action"}]"#),
            ..Default::default()
        };
        write_catalog(&mut conn, &first, &mut Vec::new(), &mut Vec::new()).unwrap();

        // Nouvelle liste dégradée (plus aucun TMDB) : le garde-fou garde les films ; le fournisseur a
        // renuméroté ses catégories (10 → 99)
        let degraded = FetchedLists {
            movies: movies(r#"[{"stream_id":3,"name":"C","category_id":"99"}]"#),
            vod_cats: cats(r#"[{"category_id":"99","category_name":"Action"}]"#),
            ..Default::default()
        };
        let mut failed = Vec::new();
        let counts = write_catalog(&mut conn, &degraded, &mut failed, &mut Vec::new()).unwrap();
        assert_eq!(counts.movies, 0);
        assert!(failed.contains(&"movies_tmdb_guarded".to_string()));
        // Avant le correctif : ["99"], les films gardés (catégorie 10) devenaient invisibles
        assert_eq!(movie_categories(&conn), vec!["10".to_string()]);

        drop(conn);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn categories_are_replaced_with_their_movies() {
        let (path, mut conn) = temp_db("replace");
        let first = FetchedLists {
            movies: movies(r#"[{"stream_id":1,"name":"A","category_id":"10"}]"#),
            vod_cats: cats(r#"[{"category_id":"10","category_name":"Action"}]"#),
            ..Default::default()
        };
        write_catalog(&mut conn, &first, &mut Vec::new(), &mut Vec::new()).unwrap();
        let second = FetchedLists {
            movies: movies(r#"[{"stream_id":2,"name":"B","category_id":"99"}]"#),
            vod_cats: cats(r#"[{"category_id":"99","category_name":"Action"}]"#),
            ..Default::default()
        };
        let counts = write_catalog(&mut conn, &second, &mut Vec::new(), &mut Vec::new()).unwrap();
        assert_eq!(counts.movies, 1);
        assert_eq!(counts.categories, 1);
        assert_eq!(movie_categories(&conn), vec!["99".to_string()]);

        drop(conn);
        let _ = std::fs::remove_file(&path);
    }

    // ---------- Fichier catalogue d'une source ----------

    const SOURCE_FILE: &str = "nyxcat_550e8400-e29b-41d4-a716-446655440000_6a1e5c3b-9d2f-4e7a-b8c1-0d2e4f6a8b9c.db";

    #[test]
    fn a_source_file_holds_its_catalogue_and_its_address_and_nothing_personal() {
        let dir = std::env::temp_dir().join(format!("nyx-ingestion-source-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // Fichier neuf, sans aucune table de la page : le chargement s'y fait en entier
        let path = crate::storage::catalog_db_path(&dir, SOURCE_FILE).unwrap();
        let mut conn = open_connection(&path).unwrap();
        let lists = FetchedLists {
            movies: movies(r#"[{"stream_id":5,"name":"A","category_id":"10","tmdb":"777"}]"#),
            vod_cats: cats(r#"[{"category_id":"10","category_name":"Action"}]"#),
            ..Default::default()
        };
        let (failed, relinks) = write_then_relink(&mut conn, &lists);
        assert!(!failed.iter().any(|f| f == "movies"), "{failed:?}");
        assert!(relinks.is_empty());
        note_source_provider(&conn, SOURCE_FILE, "http://provider.example:8080");
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM movies", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 1);
        // Aucune donnée perso créée dans le fichier de la source
        let personal: i64 = conn
            .query_row("SELECT COUNT(*) FROM sqlite_master WHERE name IN ('playback_progress', 'watchlist', 'user_preferences')", [], |r| r.get(0))
            .unwrap();
        assert_eq!(personal, 0);
        // Même adresse : l'actualisation continue ; autre adresse : elle s'arrête, sans mêler deux fournisseurs
        assert!(crate::catalog_refresh::check_provider(&conn, "http://provider.example:8080").is_ok());
        assert!(crate::catalog_refresh::check_provider(&conn, "http://other.example").is_err());
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_account_base_keeps_its_address_written_by_the_page() {
        let (path, conn) = temp_db("account-provider");
        conn.execute_batch("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);").unwrap();
        crate::catalog_refresh::meta_set(&conn, "lastProvider", "http://provider.example/").unwrap();
        note_source_provider(&conn, "nyxplayer_550e8400-e29b-41d4-a716-446655440000.db", "http://provider.example:80");
        assert_eq!(
            crate::catalog_refresh::meta_get(&conn, "lastProvider").unwrap().as_deref(),
            Some("http://provider.example/")
        );
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }

    // ---------- Reprises jamais effacées ----------

    fn with_progress(conn: &rusqlite::Connection, rows: &[(i64, i64)]) {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS playback_progress (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                content_type TEXT NOT NULL CHECK(content_type IN ('movie', 'episode')),
                stream_id INTEGER NOT NULL, tmdb_id INTEGER DEFAULT 0, title TEXT NOT NULL,
                time_seconds REAL NOT NULL, duration_seconds REAL NOT NULL, updated_at INTEGER NOT NULL,
                container_extension TEXT, UNIQUE(stream_id));",
        )
        .unwrap();
        for (stream, tmdb) in rows {
            conn.execute(
                "INSERT INTO playback_progress (content_type, stream_id, tmdb_id, title, time_seconds, duration_seconds, updated_at)
                 VALUES ('movie', ?1, ?2, 'Titre', 60, 3600, 1)",
                rusqlite::params![stream, tmdb],
            )
            .unwrap();
        }
    }

    fn progress_ids(conn: &rusqlite::Connection) -> Vec<i64> {
        let mut stmt = conn.prepare("SELECT stream_id FROM playback_progress ORDER BY stream_id").unwrap();
        stmt.query_map([], |r| r.get(0)).unwrap().map(Result::unwrap).collect()
    }

    fn write_then_relink(conn: &mut rusqlite::Connection, lists: &FetchedLists) -> (Vec<String>, Vec<crate::catalog_refresh::ProgressRelink>) {
        let mut failed = Vec::new();
        let counts = write_catalog(conn, lists, &mut failed, &mut Vec::new()).unwrap();
        let relinks = relink_progress_after_write(conn, &counts);
        (failed, relinks)
    }

    #[test]
    fn complete_movie_list_relinks_progress_and_erases_nothing() {
        let (path, mut conn) = temp_db("relink");
        let first = FetchedLists {
            movies: movies(r#"[{"stream_id":5,"name":"A","category_id":"10","tmdb":"777"}]"#),
            ..Default::default()
        };
        write_catalog(&mut conn, &first, &mut Vec::new(), &mut Vec::new()).unwrap();
        // Reprise du film 5 (TMDB 777) et reprise d'un film déjà retiré (TMDB 999)
        with_progress(&conn, &[(5, 777), (6, 999)]);

        // Le fournisseur renumérote le film 5 en 51
        let renumbered = FetchedLists {
            movies: movies(r#"[{"stream_id":51,"name":"A","category_id":"10","tmdb":"777"}]"#),
            ..Default::default()
        };
        let (failed, relinks) = write_then_relink(&mut conn, &renumbered);
        assert!(failed.iter().all(|f| !f.starts_with("movies")));
        assert_eq!(relinks, vec![crate::catalog_refresh::ProgressRelink { from: 5, to: 51 }]);
        // La reprise suit le film ; celle sans remplaçant est gardée (« Introuvable » à l'écran)
        assert_eq!(progress_ids(&conn), vec![6, 51]);

        drop(conn);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn failed_or_empty_movie_list_touches_no_progress() {
        let (path, mut conn) = temp_db("failed");
        let first = FetchedLists {
            movies: movies(
                r#"[{"stream_id":5,"name":"A","category_id":"10","tmdb":"777"},
                    {"stream_id":8,"name":"C","category_id":"10","tmdb":"888"}]"#,
            ),
            ..Default::default()
        };
        write_catalog(&mut conn, &first, &mut Vec::new(), &mut Vec::new()).unwrap();
        // Reprises renumérotée (TMDB 777 existe au numéro 5) et orpheline : rien ne doit bouger
        with_progress(&conn, &[(4, 777), (6, 999)]);

        // Liste des films en échec ou vide : ancienne liste gardée, aucune re-liaison
        let (failed, relinks) = write_then_relink(&mut conn, &FetchedLists::default());
        assert!(failed.contains(&"movies_guarded".to_string()));
        assert!(relinks.is_empty());
        assert_eq!(progress_ids(&conn), vec![4, 6]);

        // Liste dégradée (plus de TMDB) gardée par le garde-fou : pas de re-liaison non plus
        let degraded = FetchedLists {
            movies: movies(r#"[{"stream_id":7,"name":"B","category_id":"10"}]"#),
            ..Default::default()
        };
        let (failed, relinks) = write_then_relink(&mut conn, &degraded);
        assert!(failed.contains(&"movies_tmdb_guarded".to_string()));
        assert!(relinks.is_empty());
        assert_eq!(progress_ids(&conn), vec![4, 6]);

        drop(conn);
        let _ = std::fs::remove_file(&path);
    }

    // ---------- L'écriture attend une autre écriture au lieu d'échouer ----------

    #[test]
    fn catalogue_write_waits_for_another_writer() {
        let (path, mut conn) = temp_db("busy");
        // Une autre connexion (guide, page) tient l'écriture pendant 300 ms
        let other = rusqlite::Connection::open(&path).unwrap();
        other
            .execute_batch("BEGIN IMMEDIATE; INSERT INTO categories (id, name, type) VALUES ('1', 'x', 'live');")
            .unwrap();
        let holder = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            other.execute_batch("COMMIT;").unwrap();
        });
        let lists = FetchedLists {
            movies: movies(r#"[{"stream_id":1,"name":"A","category_id":"10"}]"#),
            ..Default::default()
        };
        // Avant le correctif (transaction différée : lecture du garde-fou TMDB, puis montée en
        // écriture refusée après la validation de l'autre) : « database is locked »
        let counts = write_catalog(&mut conn, &lists, &mut Vec::new(), &mut Vec::new()).unwrap();
        assert_eq!(counts.movies, 1);
        holder.join().unwrap();

        drop(conn);
        let _ = std::fs::remove_file(&path);
    }
}
