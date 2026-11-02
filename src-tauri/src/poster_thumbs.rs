//! Affiches réduites : certaines affiches du fournisseur font plus de 600 px de large pour une carte qui en
//! affiche 185. La page demande à l'appli native de les préparer (`poster_prepare`) : chaque affiche est téléchargée,
//! réduite par des fils de faible priorité, puis gardée sur le disque ; un évènement prévient la page, qui la lit
//! alors en petit JPEG par `nyxposter` (`/<largeur>?u=<adresse>`).
//!
//! `nyxposter` ne sert que ce qui est déjà sur le disque, tout de suite. Sur Android, la WebView traite les demandes
//! de ses protocoles propres une à la fois et attend chaque réponse : une réponse qui attendrait un téléchargement
//! retiendrait aussi les fichiers de l'appli et les autres images pendant ce temps.
//!
//! Aucune adresse n'est écrite dans le journal (elles peuvent porter les identifiants du fournisseur).

use std::collections::{HashMap, VecDeque};
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, Once, OnceLock};
use std::time::Instant;

use image::{ImageReader, Limits};

pub const SCHEME: &str = "nyxposter";

const MIN_WIDTH: u32 = 92;
const MAX_WIDTH: u32 = 500;
/// Une affiche plus lourde n'en est pas une (ou ne vaut pas la peine) : refusée sans être décodée
const MAX_DOWNLOAD_BYTES: usize = 3 * 1024 * 1024;
const JPEG_QUALITY: u8 = 85;
/// Au-delà, le dossier est vidé au démarrage (une petite affiche pèse 10 à 20 Ko)
const MAX_CACHED_FILES: usize = 8000;
/// Fils de préparation : chacun télécharge une affiche à la fois ; au plus quatre affiches entières en mémoire
const WORKERS: usize = 4;
/// Réductions en même temps : le reste de l'appli garde des cœurs pour défiler
const DECODE_SLOTS: u32 = 2;
/// Affiches à l'écran en attente : au-delà, les plus anciennes (rangées dépassées) sont jetées
const MAX_URGENT: usize = 200;
/// Redirections suivies pour une affiche
const MAX_REDIRECTS: usize = 3;

pub struct Reply {
    pub status: u16,
    pub content_type: &'static str,
    pub body: Vec<u8>,
}

impl Reply {
    fn error(status: u16) -> Self {
        Reply { status, content_type: "text/plain", body: Vec::new() }
    }
}

fn is_web_address(source: &str) -> bool {
    let lower = source.to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

/// `/<largeur>?u=<adresse encodée>` → (largeur bornée, adresse http(s) d'origine)
pub fn parse_request(path_and_query: &str) -> Option<(u32, String)> {
    let (path, query) = path_and_query.split_once('?')?;
    let width: u32 = path.trim_matches('/').parse().ok()?;
    let source = form_urlencoded::parse(query.as_bytes()).find(|(k, _)| k == "u").map(|(_, v)| v.into_owned())?;
    if !is_web_address(&source) {
        return None;
    }
    Some((width.clamp(MIN_WIDTH, MAX_WIDTH), source))
}

/// Nom de fichier stable d'une affiche réduite (FNV-1a 64 bits : même nom d'une version de Rust à l'autre)
pub fn cache_name(width: u32, source: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in format!("{width}|{source}").bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}-{width}.jpg")
}

/// Image décodée (bornes contre les images piégées), réduite à `width` de large si elle est plus grande, en JPEG
pub fn shrink(bytes: &[u8], width: u32) -> Result<Vec<u8>, String> {
    let mut reader = ImageReader::new(Cursor::new(bytes)).with_guessed_format().map_err(|e| e.to_string())?;
    let mut limits = Limits::default();
    // Deux réductions à la fois sur un boîtier de 1 à 2 Go : 64 Mo chacune au plus
    limits.max_image_width = Some(4096);
    limits.max_image_height = Some(4096);
    limits.max_alloc = Some(64 * 1024 * 1024);
    reader.limits(limits);
    let image = reader.decode().map_err(|e| e.to_string())?;
    let image = if image.width() > width { image.thumbnail(width, u32::MAX) } else { image };
    let mut out = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, JPEG_QUALITY)
        .encode_image(&on_black(image))
        .map_err(|e| e.to_string())?;
    Ok(out)
}

/// Le JPEG n'a pas de transparence : une affiche transparente est posée sur du noir, comme le fond de la carte (sans
/// cela, ses parties transparentes prendraient la couleur cachée sous la transparence, souvent du blanc)
fn on_black(image: image::DynamicImage) -> image::RgbImage {
    if !image.color().has_alpha() {
        return image.to_rgb8();
    }
    let rgba = image.to_rgba8();
    image::RgbImage::from_fn(rgba.width(), rgba.height(), |x, y| {
        let [r, g, b, a] = rgba.get_pixel(x, y).0;
        let over = |c: u8| ((u16::from(c) * u16::from(a) + 127) / 255) as u8;
        image::Rgb([over(r), over(g), over(b)])
    })
}

fn download(client: &reqwest::Client, source: &str) -> Result<Vec<u8>, String> {
    tauri::async_runtime::block_on(async {
        let mut response = client.get(source).send().await.map_err(|e| e.without_url().to_string())?;
        if !response.status().is_success() {
            return Err(format!("statut {}", response.status().as_u16()));
        }
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|e| e.without_url().to_string())? {
            if body.len() + chunk.len() > MAX_DOWNLOAD_BYTES {
                return Err("affiche trop lourde".into());
            }
            body.extend_from_slice(&chunk);
        }
        Ok(body)
    })
}

/// Places de réduction partagées par les fils de préparation
struct DecodeGate {
    free: Mutex<u32>,
    released: Condvar,
}

impl DecodeGate {
    fn enter(&self) -> DecodeSlot<'_> {
        let mut free = self.free.lock().unwrap_or_else(|e| e.into_inner());
        while *free == 0 {
            free = self.released.wait(free).unwrap_or_else(|e| e.into_inner());
        }
        *free -= 1;
        DecodeSlot(self)
    }
}

struct DecodeSlot<'a>(&'a DecodeGate);

impl Drop for DecodeSlot<'_> {
    fn drop(&mut self) {
        *self.0.free.lock().unwrap_or_else(|e| e.into_inner()) += 1;
        self.0.released.notify_one();
    }
}

fn decode_gate() -> &'static DecodeGate {
    static GATE: DecodeGate = DecodeGate { free: Mutex::new(DECODE_SLOTS), released: Condvar::new() };
    &GATE
}

/// Temps passés, relevés dans le journal toutes les 25 affiches réduites (aucune adresse) : attente d'une place de
/// réduction, téléchargement, réduction, en millisecondes
fn record_timing(wait_ms: u128, download_ms: u128, shrink_ms: u128) {
    static STATS: Mutex<(u32, u128, u128, u128, u128)> = Mutex::new((0, 0, 0, 0, 0));
    let mut s = STATS.lock().unwrap_or_else(|e| e.into_inner());
    s.0 += 1;
    s.1 += wait_ms;
    s.2 += download_ms;
    s.3 += shrink_ms;
    s.4 = s.4.max(shrink_ms);
    if s.0 >= 25 {
        let n = u128::from(s.0);
        log::debug!(
            "[Affiches] {} réduites : attente {} ms, téléchargement {} ms, réduction {} ms en moyenne (au plus {} ms)",
            s.0, s.1 / n, s.2 / n, s.3 / n, s.4
        );
        *s = (0, 0, 0, 0, 0);
    }
}

/// Un JPEG complet finit par la marque de fin d'image ; un fichier coupé (arrêt brutal) est jeté puis refait
fn is_complete_jpeg(body: &[u8]) -> bool {
    body.len() > 4 && body.starts_with(&[0xFF, 0xD8]) && body.ends_with(&[0xFF, 0xD9])
}

/// Échecs signalés une fois par lancement : un fournisseur hors ligne ne remplit pas le journal
fn warn_once(message: String) {
    static WARNED: OnceLock<()> = OnceLock::new();
    if WARNED.set(()).is_ok() {
        log::warn!("[Affiches] {message} (les échecs suivants ne sont plus signalés)");
    }
}

/// Affiche déjà réduite sur le disque ; un fichier coupé est jeté
fn read_cached(file: &Path) -> Option<Vec<u8>> {
    let body = std::fs::read(file).ok()?;
    if is_complete_jpeg(&body) {
        return Some(body);
    }
    let _ = std::fs::remove_file(file);
    None
}

/// Réponse de `nyxposter` : l'affiche réduite si elle est sur le disque, sinon 404 tout de suite (la page reprend
/// alors l'adresse d'origine)
pub fn serve_cached(cache_dir: &Path, path_and_query: &str) -> Reply {
    let Some((width, source)) = parse_request(path_and_query) else { return Reply::error(400) };
    match read_cached(&cache_dir.join(cache_name(width, &source))) {
        Some(body) => Reply { status: 200, content_type: "image/jpeg", body },
        None => Reply::error(404),
    }
}

struct Job {
    width: u32,
    source: String,
    name: String,
}

enum Status {
    Queued,
    Working,
    Failed,
}

#[derive(Default)]
struct State {
    /// Affiches des cartes à l'écran : préparées avant les autres, la dernière demande d'abord (la descente va
    /// plus vite que la file ; les rangées déjà dépassées attendent)
    urgent: VecDeque<Job>,
    /// Affiches des rangées suivantes, remplacées à chaque nouvelle liste
    ahead: VecDeque<Job>,
    /// Par nom de fichier : en attente, en cours, ou en échec pendant ce lancement
    known: HashMap<String, Status>,
}

/// Réponse de `poster_prepare` : adresses d'origine déjà prêtes sur le disque, et celles à demander telles quelles
#[derive(Default, Debug, serde::Serialize)]
pub struct Prepared {
    pub ready: Vec<String>,
    pub failed: Vec<String>,
    /// Jetées de la file urgente, trop longue : la page les redemandera si leur carte revient
    pub dropped: Vec<String>,
}

/// Prévient la page qu'une affiche est prête (`true`) ou qu'elle ne le sera pas (`false`)
pub type Notify = Arc<dyn Fn(&str, bool) + Send + Sync>;

pub struct PosterQueue {
    cache_dir: PathBuf,
    state: Mutex<State>,
    wake: Condvar,
    /// Remplacé quand l'appli est recréée dans le même processus (`install`)
    notify: Mutex<Notify>,
    started: Once,
}

impl PosterQueue {
    pub fn new(cache_dir: PathBuf, notify: Notify) -> Arc<Self> {
        Arc::new(PosterQueue {
            cache_dir,
            state: Mutex::new(State::default()),
            wake: Condvar::new(),
            notify: Mutex::new(notify),
            started: Once::new(),
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Ne bloque jamais sur le réseau : regarde le disque, met le reste en file, rend la main
    pub fn prepare(&self, sources: &[String], width: u32, urgent: bool) -> Prepared {
        let width = width.clamp(MIN_WIDTH, MAX_WIDTH);
        let mut out = Prepared::default();
        let mut missing = Vec::new();
        for source in sources {
            if !is_web_address(source) {
                out.failed.push(source.clone());
                continue;
            }
            let name = cache_name(width, source);
            if self.cache_dir.join(&name).is_file() {
                out.ready.push(source.clone());
            } else {
                missing.push(Job { width, source: source.clone(), name });
            }
        }
        let mut state = self.lock();
        // Demande urgente : placée en tête, dans son ordre (une rangée de gauche à droite)
        let mut first = Vec::new();
        if !urgent {
            // Nouvelle liste (autre onglet, accueil rouvert) : les préparations pas encore parties de l'ancienne n'ont
            // plus cours
            let dropped: Vec<Job> = state.ahead.drain(..).collect();
            for job in dropped {
                state.known.remove(&job.name);
            }
        }
        for job in missing {
            match state.known.get(&job.name) {
                Some(Status::Failed) => out.failed.push(job.source),
                Some(Status::Working) => {}
                Some(Status::Queued) => {
                    if urgent {
                        if let Some(at) = state.ahead.iter().position(|j| j.name == job.name) {
                            first.extend(state.ahead.remove(at));
                        } else if let Some(at) = state.urgent.iter().position(|j| j.name == job.name) {
                            first.extend(state.urgent.remove(at));
                        }
                    }
                }
                None => {
                    state.known.insert(job.name.clone(), Status::Queued);
                    if urgent { first.push(job) } else { state.ahead.push_back(job) }
                }
            }
        }
        for job in first.into_iter().rev() {
            state.urgent.push_front(job);
        }
        // Longue descente : les affiches des rangées dépassées depuis longtemps sont jetées, redemandées si elles
        // reviennent à l'écran
        while state.urgent.len() > MAX_URGENT {
            if let Some(job) = state.urgent.pop_back() {
                state.known.remove(&job.name);
                out.dropped.push(job.source);
            }
        }
        drop(state);
        self.wake.notify_all();
        out
    }

    /// Échecs oubliés : les affiches seront retentées (mesure d'une première ouverture)
    pub fn forget_failures(&self) {
        self.lock().known.retain(|_, status| !matches!(status, Status::Failed));
    }

    fn next_job(&self) -> Job {
        let mut state = self.lock();
        loop {
            if let Some(job) = state.urgent.pop_front().or_else(|| state.ahead.pop_front()) {
                state.known.insert(job.name.clone(), Status::Working);
                return job;
            }
            state = self.wake.wait(state).unwrap_or_else(|e| e.into_inner());
        }
    }

    /// Une préparation, puis son résultat noté et signalé à la page
    fn finish(&self, job: &Job, run: impl FnOnce() -> bool) {
        // Décodeur qui plante sur une image piégée : un échec comme un autre, le fil continue (sinon l'affiche
        // resterait « en cours » pour toute la séance, et chaque plantage retirerait un fil)
        let ok = std::panic::catch_unwind(std::panic::AssertUnwindSafe(run)).unwrap_or(false);
        {
            let mut state = self.lock();
            if ok {
                state.known.remove(&job.name);
            } else {
                state.known.insert(job.name.clone(), Status::Failed);
            }
        }
        // Copié avant l'appel : jamais d'appel à la page sous verrou
        let notify = Arc::clone(&self.notify.lock().unwrap_or_else(|e| e.into_inner()));
        notify(&job.source, ok);
    }

    /// Fils de préparation, lancés à la première demande, après le ménage du dossier (un vidage pendant qu'un fil
    /// écrit ferait échouer son affiche). Peut prendre quelques secondes : jamais sur un fil de tâches
    pub fn start(self: &Arc<Self>, client: &'static reqwest::Client) {
        self.started.call_once(|| {
            trim_cache(&self.cache_dir);
            for index in 0..WORKERS {
                let queue = Arc::clone(self);
                let spawned = std::thread::Builder::new().name(format!("nyx-affiches-{index}")).spawn(move || {
                    lower_thread_priority();
                    loop {
                        let job = queue.next_job();
                        queue.finish(&job, || make(&queue.cache_dir, client, &job));
                    }
                });
                if let Err(e) = spawned {
                    log::warn!("[Affiches] Fil de préparation non lancé : {e}");
                }
            }
        });
    }
}

/// Fils de préparation derrière ceux de la page : la réduction ne prend que le temps de calcul laissé libre
fn lower_thread_priority() {
    #[cfg(any(target_os = "linux", target_os = "android"))]
    // SAFETY : appels système sans pointeur ; sous Linux, setpriority sur l'identifiant du fil ne vise que lui
    unsafe {
        let tid = libc::syscall(libc::SYS_gettid) as libc::id_t;
        libc::setpriority(libc::PRIO_PROCESS, tid, 10);
    }
}

/// Une affiche : téléchargée, réduite, écrite sur le disque. `false` si elle ne peut pas l'être
fn make(cache_dir: &Path, client: &reqwest::Client, job: &Job) -> bool {
    let file = cache_dir.join(&job.name);
    if read_cached(&file).is_some() {
        return true;
    }
    let begin = Instant::now();
    let bytes = match download(client, &job.source) {
        Ok(bytes) => bytes,
        Err(e) => {
            warn_once(format!("Téléchargement impossible : {e}"));
            return false;
        }
    };
    let download_ms = begin.elapsed().as_millis();
    let queued = Instant::now();
    let slot = decode_gate().enter();
    let wait_ms = queued.elapsed().as_millis();
    let begin = Instant::now();
    // Format inconnu (GIF, AVIF…) : la page reprend l'adresse d'origine
    let small = shrink(&bytes, job.width);
    drop(slot);
    drop(bytes);
    let Ok(small) = small else { return false };
    record_timing(wait_ms, download_ms, begin.elapsed().as_millis());
    if std::fs::create_dir_all(cache_dir).is_err() {
        return false;
    }
    // Écrit à côté sous un nom unique puis renommé : une lecture ne voit jamais un fichier à moitié écrit
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let partial = file.with_extension(format!("{}.part", NEXT.fetch_add(1, Ordering::Relaxed)));
    if std::fs::write(&partial, &small).is_ok() && std::fs::rename(&partial, &file).is_ok() {
        return true;
    }
    let _ = std::fs::remove_file(&partial);
    false
}

/// Dossier trop rempli (catalogues changés au fil des mois) : vidé, il se remplit de nouveau à l'usage
fn trim_cache(cache_dir: &Path) {
    let Ok(entries) = std::fs::read_dir(cache_dir) else { return };
    let mut count = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        // Écriture interrompue par un arrêt brutal : jamais renommée, jetée
        if path.extension().is_some_and(|ext| ext == "part") {
            let _ = std::fs::remove_file(&path);
        } else {
            count += 1;
        }
    }
    if count > MAX_CACHED_FILES {
        let _ = std::fs::remove_dir_all(cache_dir);
    }
}

pub fn cache_dir_of(app: &tauri::AppHandle) -> Option<PathBuf> {
    use tauri::Manager;
    app.path().app_cache_dir().ok().map(|dir| dir.join("posters"))
}

/// Redirection suivie (`done` : adresses déjà visitées) : au plus MAX_REDIRECTS, et jamais d'une adresse chiffrée (https) vers une adresse en clair
/// (http), qu'un intermédiaire du réseau pourrait lire ou remplacer
fn redirect_allowed(done: usize, from: &reqwest::Url, to: &reqwest::Url) -> bool {
    done <= MAX_REDIRECTS && !(from.scheme() == "https" && to.scheme() == "http")
}

pub fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    // DNS du système, comme la page quand elle chargeait l'affiche elle-même. Délais courts : une affiche en retard
    // retient un fil de préparation, et la page reprend l'adresse d'origine en cas d'échec
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            // Même User-Agent navigateur que le reste de l'app (sans lui, certains fournisseurs répondent par une page web)
            .user_agent(crate::http::IPTV_USER_AGENT)
            .connect_timeout(std::time::Duration::from_secs(4))
            .timeout(std::time::Duration::from_secs(10))
            // L'adresse d'une affiche peut porter les identifiants de l'abonné : jamais transmise à l'hôte d'une redirection
            .referer(false)
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                let allowed = attempt.previous().last().is_none_or(|from| redirect_allowed(attempt.previous().len(), from, attempt.url()));
                if allowed { attempt.follow() } else { attempt.error("redirection refusée") }
            }))
            .build()
            .unwrap_or_default()
    })
}

static QUEUE: OnceLock<Arc<PosterQueue>> = OnceLock::new();

/// File de l'appli : chaque affiche préparée (ou en échec) est signalée à la page par un évènement
pub fn install(app: &tauri::AppHandle) {
    use tauri::Emitter;
    let Some(dir) = cache_dir_of(app) else { return };
    let handle = app.clone();
    let notify: Notify = Arc::new(move |source, ok| {
        let event = if ok { "poster-ready" } else { "poster-failed" };
        let _ = handle.emit(event, serde_json::json!({ "u": source }));
    });
    install_into(&QUEUE, dir, notify);
}

/// Première installation : la file ; les suivantes (Android peut recréer l'appli dans le même processus, après Retour
/// puis réouverture) gardent la file et ses fils, mais signalent désormais à la nouvelle appli : l'ancienne ne reçoit
/// plus rien, et ses cartes en attente auraient pris l'affiche d'origine au bout du délai de la page
fn install_into(cell: &OnceLock<Arc<PosterQueue>>, dir: PathBuf, notify: Notify) {
    if cell.set(PosterQueue::new(dir, Arc::clone(&notify))).is_err() {
        if let Some(queue) = cell.get() {
            *queue.notify.lock().unwrap_or_else(|e| e.into_inner()) = notify;
        }
    }
}

/// Affiches à préparer, dans l'ordre donné. `urgent` : cartes à l'écran, avant tout le reste ; sinon la liste
/// remplace celle des rangées suivantes. Rend la main tout de suite
#[tauri::command]
pub async fn poster_prepare(urls: Vec<String>, width: u32, urgent: bool) -> Result<Prepared, String> {
    let queue = Arc::clone(QUEUE.get().ok_or("affiches réduites indisponibles")?);
    // Ménage du dossier (première demande) et un regard sur le disque par affiche : hors des fils de tâches
    tauri::async_runtime::spawn_blocking(move || {
        queue.start(client());
        queue.prepare(&urls, width, urgent)
    })
    .await
    .map_err(|e| e.to_string())
}

/// Version de mesure : affiches réduites effacées, pour mesurer une première ouverture
#[tauri::command]
pub async fn poster_cache_clear(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(queue) = QUEUE.get() {
        queue.forget_failures();
    }
    if let Some(dir) = cache_dir_of(&app) {
        if dir.exists() {
            tokio::fs::remove_dir_all(&dir).await.map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::atomic::AtomicUsize;
    use std::sync::mpsc;
    use std::time::Duration;

    fn png(width: u32, height: u32) -> Vec<u8> {
        let image = image::RgbImage::from_fn(width, height, |x, y| image::Rgb([(x % 256) as u8, (y % 256) as u8, 90]));
        let mut out = Vec::new();
        image::DynamicImage::ImageRgb8(image).write_to(&mut Cursor::new(&mut out), image::ImageFormat::Png).unwrap();
        out
    }

    fn size_of(jpeg: &[u8]) -> (u32, u32) {
        let image = image::load_from_memory(jpeg).unwrap();
        (image.width(), image.height())
    }

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nyx-posters-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn silent() -> Notify {
        Arc::new(|_, _| {})
    }

    fn recorder() -> (Notify, mpsc::Receiver<(String, bool)>) {
        let (tx, rx) = mpsc::channel();
        let tx = Mutex::new(tx);
        let notify: Notify = Arc::new(move |source, ok| {
            let _ = tx.lock().unwrap().send((source.to_owned(), ok));
        });
        (notify, rx)
    }

    fn client_for_tests() -> &'static reqwest::Client {
        static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
        CLIENT.get_or_init(|| crate::http::build_http_client("system", 2, 5).unwrap())
    }

    #[test]
    fn request_is_parsed_and_width_bounded() {
        let (w, u) = parse_request("/185?u=http%3A%2F%2F192.0.2.1%2Fp.jpg%3Fa%3D1").unwrap();
        assert_eq!((w, u.as_str()), (185, "http://192.0.2.1/p.jpg?a=1"));
        assert_eq!(parse_request("/5000?u=https%3A%2F%2Fexample.com%2Fa.png").unwrap().0, MAX_WIDTH);
        assert_eq!(parse_request("/1?u=https%3A%2F%2Fexample.com%2Fa.png").unwrap().0, MIN_WIDTH);
    }

    #[test]
    fn only_web_addresses_are_fetched() {
        assert!(parse_request("/185?u=file%3A%2F%2F%2Fetc%2Fpasswd").is_none());
        assert!(parse_request("/185?u=").is_none());
        assert!(parse_request("/abc?u=http%3A%2F%2Fexample.com%2F").is_none());
        assert!(parse_request("/185").is_none());
        let queue = PosterQueue::new(temp_dir("file"), silent());
        let out = queue.prepare(&["file:///etc/passwd".to_owned()], 185, true);
        assert_eq!(out.failed, vec!["file:///etc/passwd".to_owned()]);
        assert!(queue.lock().urgent.is_empty());
    }

    #[test]
    fn cache_name_is_stable_and_distinct() {
        assert_eq!(cache_name(185, "http://a/b.jpg"), cache_name(185, "http://a/b.jpg"));
        assert_ne!(cache_name(185, "http://a/b.jpg"), cache_name(342, "http://a/b.jpg"));
        assert_ne!(cache_name(185, "http://a/b.jpg"), cache_name(185, "http://a/c.jpg"));
    }

    #[test]
    fn large_poster_is_shrunk_to_card_width() {
        assert_eq!(size_of(&shrink(&png(667, 1000), 185).unwrap()), (185, 277));
    }

    #[test]
    fn small_poster_is_never_enlarged() {
        assert_eq!(size_of(&shrink(&png(120, 180), 185).unwrap()), (120, 180));
    }

    #[test]
    fn truncated_cache_file_is_not_served() {
        let full = shrink(&png(300, 450), 185).unwrap();
        assert!(is_complete_jpeg(&full));
        assert!(!is_complete_jpeg(&full[..full.len() / 2]));
    }

    #[test]
    fn non_image_is_refused() {
        assert!(shrink(b"<html>not a poster</html>", 185).is_err());
    }

    #[test]
    fn scheme_answers_at_once_from_disk_only() {
        let dir = temp_dir("serve");
        // Adresse jamais jointe : une réponse qui irait la télécharger ne reviendrait pas avant le délai
        let source = "http://192.0.2.1/p.jpg";
        let query: String = form_urlencoded::Serializer::new(String::new()).append_pair("u", source).finish();
        let request = format!("/185?{query}");
        let started = Instant::now();
        assert_eq!(serve_cached(&dir, &request).status, 404);
        assert!(started.elapsed() < Duration::from_millis(500));

        let small = shrink(&png(300, 450), 185).unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join(cache_name(185, source));
        std::fs::write(&file, &small).unwrap();
        let reply = serve_cached(&dir, &request);
        assert_eq!((reply.status, reply.body.len()), (200, small.len()));

        // Fichier coupé par un arrêt brutal : jeté, jamais servi abîmé
        std::fs::write(&file, &small[..small.len() / 2]).unwrap();
        assert_eq!(serve_cached(&dir, &request).status, 404);
        assert!(!file.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn posters_on_screen_go_first_and_a_new_list_replaces_the_old_one() {
        let queue = PosterQueue::new(temp_dir("order"), silent());
        let urls = |names: &[&str]| names.iter().map(|n| format!("http://192.0.2.1/{n}.jpg")).collect::<Vec<_>>();
        queue.prepare(&urls(&["a", "b", "c"]), 185, false);
        queue.prepare(&urls(&["c", "x"]), 185, true);
        // Rangée suivante pendant la descente : passe devant la précédente, dans son ordre
        queue.prepare(&urls(&["y", "z", "x"]), 185, true);
        let order: Vec<String> = (0..6).map(|_| queue.next_job().source).collect();
        assert_eq!(order, urls(&["y", "z", "x", "c", "a", "b"]));

        // Liste suivante : les préparations pas encore parties de l'ancienne n'ont plus cours
        queue.prepare(&urls(&["d", "e"]), 185, false);
        queue.prepare(&urls(&["f"]), 185, false);
        assert_eq!(queue.next_job().source, urls(&["f"])[0]);
        assert!(queue.lock().ahead.is_empty());
    }

    #[test]
    fn already_shrunk_poster_is_ready_without_queueing() {
        let dir = temp_dir("ready");
        std::fs::create_dir_all(&dir).unwrap();
        let source = "http://192.0.2.1/ready.jpg".to_owned();
        std::fs::write(dir.join(cache_name(185, &source)), shrink(&png(300, 450), 185).unwrap()).unwrap();
        let queue = PosterQueue::new(dir.clone(), silent());
        let out = queue.prepare(std::slice::from_ref(&source), 185, true);
        assert_eq!(out.ready, vec![source]);
        assert!(queue.lock().urgent.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Serveur local qui compte ses requêtes et renvoie toujours la même affiche
    fn serve_poster(body: Vec<u8>) -> (String, Arc<AtomicUsize>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let hits = Arc::new(AtomicUsize::new(0));
        let counter = hits.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { return };
                let mut buf = [0u8; 4096];
                let mut request = Vec::new();
                while !request.windows(4).any(|w| w == b"\r\n\r\n") {
                    match stream.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(k) => request.extend_from_slice(&buf[..k]),
                    }
                }
                counter.fetch_add(1, Ordering::SeqCst);
                let head = format!("HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
                let _ = stream.write_all(head.as_bytes());
                let _ = stream.write_all(&body);
            }
        });
        (format!("http://{addr}/poster.png"), hits)
    }

    #[test]
    fn poster_is_prepared_once_then_ready_from_disk() {
        let dir = temp_dir("make");
        let (url, hits) = serve_poster(png(667, 1000));
        let (notify, events) = recorder();
        let queue = PosterQueue::new(dir.clone(), notify);
        queue.start(client_for_tests());

        // Demandée deux fois avant d'être prête (rangée d'avance puis carte à l'écran) : une seule préparation
        queue.prepare(std::slice::from_ref(&url), 185, false);
        queue.prepare(std::slice::from_ref(&url), 185, true);
        assert_eq!(events.recv_timeout(Duration::from_secs(10)).unwrap(), (url.clone(), true));
        let query: String = form_urlencoded::Serializer::new(String::new()).append_pair("u", &url).finish();
        let reply = serve_cached(&dir, &format!("/185?{query}"));
        assert_eq!(reply.status, 200);
        assert_eq!(size_of(&reply.body).0, 185);

        assert_eq!(queue.prepare(std::slice::from_ref(&url), 185, true).ready, vec![url]);
        assert!(events.recv_timeout(Duration::from_millis(300)).is_err());
        assert_eq!(hits.load(Ordering::SeqCst), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unreachable_poster_is_reported_failed_and_not_retried() {
        let dir = temp_dir("ko");
        // Port fermé sur la machine elle-même : refus immédiat, sans réseau réel
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let url = format!("http://127.0.0.1:{port}/p.png");
        let (notify, events) = recorder();
        let queue = PosterQueue::new(dir.clone(), notify);
        queue.start(client_for_tests());
        queue.prepare(std::slice::from_ref(&url), 185, true);
        assert_eq!(events.recv_timeout(Duration::from_secs(10)).unwrap(), (url.clone(), false));
        assert_eq!(queue.prepare(std::slice::from_ref(&url), 185, true).failed, vec![url.clone()]);

        queue.forget_failures();
        assert!(queue.prepare(std::slice::from_ref(&url), 185, true).failed.is_empty());
        assert_eq!(events.recv_timeout(Duration::from_secs(10)).unwrap(), (url, false));
    }

    #[test]
    fn interrupted_writes_are_cleaned_at_start() {
        let dir = temp_dir("part");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("abc-185.3.part"), b"x").unwrap();
        std::fs::write(dir.join("abc-185.jpg"), b"x").unwrap();
        trim_cache(&dir);
        assert!(!dir.join("abc-185.3.part").exists());
        assert!(dir.join("abc-185.jpg").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_crashing_preparation_is_reported_failed_and_the_worker_keeps_going() {
        let (notify, events) = recorder();
        let queue = PosterQueue::new(temp_dir("panic"), notify);
        let job = Job { width: 185, source: "http://192.0.2.1/trap.jpg".into(), name: cache_name(185, "http://192.0.2.1/trap.jpg") };
        queue.lock().known.insert(job.name.clone(), Status::Working);
        // Décodeur qui plante sur une image piégée : le fil de préparation n'en meurt pas
        queue.finish(&job, || panic!("décodeur en échec"));
        assert_eq!(events.recv_timeout(Duration::from_secs(1)).unwrap(), (job.source.clone(), false));
        assert!(matches!(queue.lock().known.get(&job.name), Some(Status::Failed)));
    }

    #[test]
    fn urgent_queue_stays_bounded_and_keeps_the_latest_requests() {
        let queue = PosterQueue::new(temp_dir("bounded"), silent());
        let urls: Vec<String> = (0..(MAX_URGENT + 50)).map(|i| format!("http://192.0.2.1/{i}.jpg")).collect();
        for url in &urls {
            queue.prepare(std::slice::from_ref(url), 185, true);
        }
        let state = queue.lock();
        assert_eq!(state.urgent.len(), MAX_URGENT);
        assert_eq!(state.urgent.front().unwrap().source, urls[urls.len() - 1]);
        // Les plus anciennes, jetées, seront redemandées si leur carte revient à l'écran
        assert!(!state.known.contains_key(&cache_name(185, &urls[0])));
        assert_eq!(state.known.len(), MAX_URGENT);
    }

    #[test]
    fn dropped_urgent_requests_are_reported_to_the_page() {
        let queue = PosterQueue::new(temp_dir("dropped"), silent());
        let urls: Vec<String> = (0..(MAX_URGENT + 3)).map(|i| format!("http://192.0.2.1/{i}.jpg")).collect();
        let mut dropped = Vec::new();
        for url in &urls {
            dropped.extend(queue.prepare(std::slice::from_ref(url), 185, true).dropped);
        }
        // Sans ce signal, la page attendait 12 s puis gardait l'affiche d'origine toute la séance
        assert_eq!(dropped, urls[..3].to_vec());
    }

    #[test]
    fn a_second_install_sends_events_to_the_new_app() {
        // Android peut recréer l'appli dans le même processus (Retour puis réouverture) : les affiches prêtes sont
        // signalées à la nouvelle, pas à l'ancienne
        let cell = OnceLock::new();
        let (first, first_events) = recorder();
        let (second, second_events) = recorder();
        install_into(&cell, temp_dir("reinstall"), first);
        install_into(&cell, temp_dir("reinstall"), second);
        let queue = cell.get().unwrap();
        let job = Job { width: 185, source: "http://192.0.2.1/again.jpg".into(), name: cache_name(185, "http://192.0.2.1/again.jpg") };
        queue.lock().known.insert(job.name.clone(), Status::Working);
        queue.finish(&job, || true);
        assert_eq!(second_events.recv_timeout(Duration::from_secs(1)).unwrap(), (job.source.clone(), true));
        assert!(first_events.try_recv().is_err());
    }

    #[test]
    fn overfull_cache_is_emptied_before_any_poster_is_written() {
        let dir = temp_dir("trim-first");
        std::fs::create_dir_all(&dir).unwrap();
        for i in 0..=MAX_CACHED_FILES {
            std::fs::write(dir.join(format!("{i:016x}-185.jpg")), b"x").unwrap();
        }
        let (url, _) = serve_poster(png(300, 450));
        let (notify, events) = recorder();
        let queue = PosterQueue::new(dir.clone(), notify);
        queue.start(client_for_tests());
        queue.prepare(std::slice::from_ref(&url), 185, true);
        assert_eq!(events.recv_timeout(Duration::from_secs(10)).unwrap(), (url.clone(), true));
        // La nouvelle affiche a survécu au vidage, les anciennes sont parties
        assert!(dir.join(cache_name(185, &url)).is_file());
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn transparent_poster_is_laid_on_black() {
        let image = image::RgbaImage::from_pixel(200, 300, image::Rgba([255, 255, 255, 0]));
        let mut png = Vec::new();
        image::DynamicImage::ImageRgba8(image).write_to(&mut Cursor::new(&mut png), image::ImageFormat::Png).unwrap();
        let out = image::load_from_memory(&shrink(&png, 185).unwrap()).unwrap().to_rgb8();
        let pixel = out.get_pixel(10, 10);
        assert!(pixel.0.iter().all(|&c| c < 16), "pixel transparent devenu {pixel:?} au lieu de noir");
    }

    #[test]
    fn redirection_from_https_to_http_is_refused() {
        let url = |s: &str| reqwest::Url::parse(s).unwrap();
        assert!(!redirect_allowed(1, &url("https://192.0.2.1/a.jpg"), &url("http://192.0.2.1/a.jpg")));
        assert!(redirect_allowed(1, &url("http://192.0.2.1/a.jpg"), &url("https://192.0.2.1/a.jpg")));
        assert!(redirect_allowed(1, &url("http://192.0.2.1/a.jpg"), &url("http://192.0.2.2/a.jpg")));
        assert!(redirect_allowed(MAX_REDIRECTS, &url("http://192.0.2.1/a.jpg"), &url("http://192.0.2.2/a.jpg")));
        assert!(!redirect_allowed(MAX_REDIRECTS + 1, &url("http://192.0.2.1/a.jpg"), &url("http://192.0.2.2/a.jpg")));
    }

    #[test]
    fn redirections_are_followed_three_times_at_most() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let hits = Arc::new(AtomicUsize::new(0));
        let counter = hits.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { return };
                let mut buf = [0u8; 4096];
                let _ = stream.read(&mut buf);
                counter.fetch_add(1, Ordering::SeqCst);
                let head = format!("HTTP/1.1 302 Found\r\nLocation: http://{addr}/again\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                let _ = stream.write_all(head.as_bytes());
            }
        });
        assert!(download(client(), &format!("http://{addr}/start")).is_err());
        assert_eq!(hits.load(Ordering::SeqCst), 1 + MAX_REDIRECTS);
    }

    #[test]
    fn redirection_does_not_pass_the_first_address_on() {
        // L'adresse d'une affiche du fournisseur peut porter les identifiants de l'abonné (chemin ou paramètres) :
        // l'hôte vers lequel elle renvoie ne doit pas les recevoir dans l'en-tête Referer
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let (sent, requests) = mpsc::channel::<String>();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { return };
                let mut buf = [0u8; 4096];
                let k = stream.read(&mut buf).unwrap_or(0);
                let request = String::from_utf8_lossy(&buf[..k]).into_owned();
                let head = if request.starts_with("GET /start") {
                    format!("HTTP/1.1 302 Found\r\nLocation: http://{addr}/final\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                } else {
                    "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_string()
                };
                let _ = sent.send(request);
                let _ = stream.write_all(head.as_bytes());
            }
        });
        let _ = download(client(), &format!("http://{addr}/start/abonne/secret/p.jpg?password=secret"));
        requests.recv_timeout(Duration::from_secs(5)).unwrap();
        let second = requests.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(second.starts_with("GET /final"));
        assert!(!second.to_ascii_lowercase().contains("referer"), "{second}");
    }
}
