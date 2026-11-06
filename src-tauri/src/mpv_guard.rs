//! Garde du lecteur mpv (Windows) : seule porte d'entrée du code web vers `tauri-plugin-mpv`.
//!
//! Les commandes brutes du plugin (`plugin:mpv|init`, `plugin:mpv|command`) laissaient le
//! JavaScript choisir le programme lancé, ses arguments et n'importe quelle commande mpv (`run`,
//! `subprocess`, `load-script`…) : une seule faille XSS devenait une exécution de programme sur le
//! PC. Elles ne sont plus autorisées (`capabilities/desktop.json`) ; le web passe par :
//!
//! - `nyx_mpv_init` : chemin de mpv fixe (`mpv/mpv.exe` des ressources ; version d'audit Linux du
//!   banc seulement : `/usr/bin/mpv`), options en liste blanche,
//!   vérification des certificats HTTPS imposée (`mpv_tls.rs`) ;
//! - `nyx_mpv_command` : liste blanche des commandes et des propriétés modifiables par l'app ;
//! - `nyx_mpv_set_margins` : marges vidéo bornées, seulement quand mpv est lancé ;
//! - `nyx_mpv_alive` : mpv.exe tourne-t-il encore (plantage ou arrêt forcé pendant une lecture).
//!
//! Les événements mpv (`mpv-event-<fenêtre>`) restent de simples événements Tauri émis par le plugin.

// Android : libmpv passe par le plugin nyx-android, les vérifications ne servent qu'aux tests
#![cfg_attr(any(mobile, target_os = "macos"), allow(dead_code))]

use serde_json::Value;

/// Options de lancement acceptées, avec les seules valeurs que l'app envoie
/// (`src/services/mpvBridge.ts`). Toute autre option (`--script`, `--include`, `--input-conf`,
/// `--vo=image`…) ou valeur est refusée.
fn is_allowed_init_arg(arg: &str) -> bool {
    let Some(option) = arg.strip_prefix("--") else {
        return false;
    };
    let (name, value) = match option.split_once('=') {
        Some((name, value)) => (name, Some(value)),
        None => (option, None),
    };
    let mebibytes = |v: &str| {
        v.strip_suffix("MiB")
            .and_then(|n| n.parse::<u32>().ok())
            .is_some_and(|n| (1..=512).contains(&n))
    };
    match (name, value) {
        ("vo", Some(v)) => v == "gpu-next" || v == "gpu-next,gpu",
        ("hwdec", Some(v)) => v == "auto-safe" || v == "no",
        ("keep-open", Some(v)) | ("cache", Some(v)) => v == "yes" || v == "no",
        ("force-window", None) => true,
        ("force-window", Some(v)) => v == "yes",
        ("user-agent", Some(v)) => v.len() <= 300 && !v.chars().any(char::is_control),
        ("network-timeout", Some(v)) => v.parse::<u32>().is_ok_and(|n| (1..=120).contains(&n)),
        ("demuxer-max-bytes", Some(v)) | ("demuxer-max-back-bytes", Some(v)) => mebibytes(v),
        // `stream-lavf-o` ouvre toutes les options réseau de FFmpeg : une seule valeur permise
        ("stream-lavf-o", Some(v)) => v == "multiple_requests=0",
        ("ytdl", Some(v)) => v == "no",
        _ => false,
    }
}

/// Options de sécurité ajoutées par Rust après celles du web (mpv garde la dernière valeur) :
/// ni yt-dlp, ni scripts (intégrés ou du dossier de l'utilisateur), ni liste de lecture distante
/// pointant vers des fichiers locaux, même si le web ne les envoie pas.
/// Ni fichiers de réglages personnels (`mpv.conf`, `input.conf` de `%APPDATA%\mpv` ou de
/// `portable_config`) : l'app lance mpv avec sa propre configuration. Le profil `libmpv` que
/// le plugin demande contient déjà `config=no`, mais un profil s'applique après la lecture de ces
/// fichiers : seule l'option en ligne de commande l'empêche (mpv la lit avant toute autre).
const FORCED_INIT_ARGS: &[&str] = &["--ytdl=no", "--load-scripts=no", "--load-unsafe-playlists=no", "--config=no"];

/// Propriétés que l'app modifie (`set_property`, `cycle`). Une propriété comme `script-opts`
/// (chemin de yt-dlp) ou `ytdl` permettrait de lancer un programme au chargement suivant.
const SETTABLE_PROPERTIES: &[&str] = &[
    "aid",
    "sid",
    "mute",
    "pause",
    "panscan",
    "speed",
    "start",
    "sub-scale",
    "time-pos",
    "video-aspect-override",
    "volume",
];

/// Protocoles de flux IPTV acceptés par `loadfile` : clients seulement (pas de fichier local, ni
/// `av://`, `lavfi://`, ni `udp://` ou `srt://` qui ouvriraient un port d'écoute sur le PC).
const ALLOWED_STREAM_SCHEMES: &[&str] = &["http", "https", "rtmp", "rtmps", "rtsp", "rtsps"];

const LOADFILE_MODES: &[&str] = &["replace", "append", "append-play"];

/// Délai de réponse de mpv accepté (ms).
const IPC_TIMEOUT_RANGE: (u64, u64) = (500, 10_000);

/// Nom de propriété mpv : minuscules, chiffres, `-`, `/` (`track-list/count`). Le plugin insère
/// les propriétés observées telles quelles dans du JSON : un guillemet y injecterait une commande.
fn is_property_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'/')
        && name.as_bytes()[0].is_ascii_lowercase()
}

/// Vérifie les options de lancement de mpv envoyées par le web.
pub fn validate_init_args(args: &[String]) -> Result<(), String> {
    match args.iter().find(|arg| !is_allowed_init_arg(arg)) {
        Some(arg) => Err(format!("mpv option not allowed: {}", name_for_error(arg))),
        None => Ok(()),
    }
}

/// Options transmises à mpv : celles du web (vérifiées), puis les options de sécurité, dont la
/// vérification des certificats HTTPS avec le fichier d'autorités exporté (`mpv_tls.rs`).
/// Version d'audit Linux (banc cloud : écran virtuel sans carte graphique, où `gpu-next` et `gpu`
/// échouent) : la sortie vidéo X11 en dernier recours, et une sortie audio factice (aucune carte son :
/// sans elle, le changement de piste audio échoue). Jamais ailleurs.
const LINUX_AUDIT_ARGS: &[&str] = &["--vo=gpu-next,gpu,x11", "--ao=null"];

/// macOS: shorter stream probing so a title opens (and resumes) sooner. FFmpeg otherwise reads up to
/// 5 s / 5 MB of an IPTV stream before showing the first frame.
#[cfg(target_os = "macos")]
const MACOS_FAST_START_ARGS: &[&str] = &["--demuxer-lavf-analyzeduration=2", "--demuxer-lavf-probesize=1048576"];

fn platform_args(linux_audit: bool) -> &'static [&'static str] {
    if linux_audit {
        LINUX_AUDIT_ARGS
    } else {
        #[cfg(target_os = "macos")]
        {
            return MACOS_FAST_START_ARGS;
        }
        #[allow(unreachable_code)]
        &[]
    }
}

pub fn launch_args(args: Vec<String>, ca_bundle: Option<&std::path::Path>) -> Vec<String> {
    let mut all = args;
    all.extend(platform_args(cfg!(all(target_os = "linux", feature = "audit"))).iter().map(|a| a.to_string()));
    all.extend(FORCED_INIT_ARGS.iter().map(|a| a.to_string()));
    all.extend(crate::mpv_tls::tls_args(ca_bundle));
    all
}

/// Marges vidéo (panneau des chaînes) : une fraction de l'écran entre 0 et 0,9.
pub fn clamp_margin(value: Option<f64>) -> Option<f64> {
    value.filter(|v| v.is_finite()).map(|v| v.clamp(0.0, 0.9))
}

/// Vérifie la liste des propriétés observées.
pub fn validate_observed_properties(properties: &[String]) -> Result<(), String> {
    match properties.iter().find(|p| !is_property_name(p)) {
        Some(p) => Err(format!("mpv property not allowed: {}", name_for_error(p))),
        None => Ok(()),
    }
}

pub fn clamp_ipc_timeout(ms: u64) -> u64 {
    ms.clamp(IPC_TIMEOUT_RANGE.0, IPC_TIMEOUT_RANGE.1)
}

/// Nom d'option ou de commande cité dans une erreur, sans sa valeur (une adresse de flux
/// contient les identifiants du compte).
fn name_for_error(text: &str) -> String {
    text.split('=')
        .next()
        .unwrap_or("")
        .chars()
        .take(40)
        .collect()
}

fn is_allowed_stream_url(url: &str) -> bool {
    match url.split_once("://") {
        Some((scheme, rest)) => {
            ALLOWED_STREAM_SCHEMES.contains(&scheme.to_ascii_lowercase().as_str()) && !rest.is_empty()
        }
        None => false,
    }
}

fn is_scalar(value: &Value) -> bool {
    matches!(value, Value::String(_) | Value::Number(_) | Value::Bool(_))
}

/// Vérifie une commande mpv et renvoie la commande complète pour le tube de mpv.
pub fn validate_command(name: &str, args: &[Value]) -> Result<Vec<Value>, String> {
    let refused = || Err(format!("mpv command not allowed: {}", name_for_error(name)));
    let ok = match name {
        "stop" => args.is_empty(),
        "loadfile" => match args {
            [Value::String(url)] => is_allowed_stream_url(url),
            [Value::String(url), Value::String(mode)] => {
                is_allowed_stream_url(url) && LOADFILE_MODES.contains(&mode.as_str())
            }
            _ => false,
        },
        "seek" => {
            let amount_ok = match args.first() {
                Some(Value::Number(_)) => true,
                Some(Value::String(s)) => s.trim().parse::<f64>().is_ok_and(f64::is_finite),
                _ => false,
            };
            let flags_ok = match args.get(1) {
                None => true,
                Some(Value::String(flags)) => flags.split('+').all(|f| {
                    matches!(
                        f,
                        "relative" | "absolute" | "absolute-percent" | "relative-percent"
                            | "keyframes" | "exact"
                    )
                }),
                _ => false,
            };
            amount_ok && flags_ok && args.len() <= 2
        }
        "get_property" => matches!(args, [Value::String(p)] if is_property_name(p)),
        "set_property" => matches!(
            args,
            [Value::String(p), value] if SETTABLE_PROPERTIES.contains(&p.as_str()) && is_scalar(value)
        ),
        "cycle" => match args {
            [Value::String(p)] => SETTABLE_PROPERTIES.contains(&p.as_str()),
            [Value::String(p), Value::String(dir)] => {
                SETTABLE_PROPERTIES.contains(&p.as_str()) && (dir == "up" || dir == "down")
            }
            _ => false,
        },
        _ => false,
    };
    if !ok {
        return refused();
    }
    let mut command = Vec::with_capacity(args.len() + 1);
    command.push(Value::String(name.to_string()));
    command.extend(args.iter().cloned());
    Ok(command)
}

// ============= Commandes Tauri =============

/// Lance mpv (ou réutilise le processus vivant) pour la fenêtre appelante.
#[cfg(all(desktop, not(target_os = "macos")))]
#[tauri::command]
pub async fn nyx_mpv_init<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    window: tauri::Window<R>,
    args: Vec<String>,
    observed_properties: Vec<String>,
    ipc_timeout_ms: u64,
) -> Result<String, String> {
    use tauri_plugin_mpv::MpvExt;

    validate_init_args(&args)?;
    validate_observed_properties(&observed_properties)?;
    let path = mpv_path(&app)?;

    let label = window.label().to_string();
    // Le plugin attend la réponse de mpv de façon bloquante ; l'export des certificats lit le
    // magasin de Windows au premier lancement : hors du fil principal aussi
    tauri::async_runtime::spawn_blocking(move || {
        let ca_bundle = crate::mpv_tls::ensure_bundle(&app);
        let config = tauri_plugin_mpv::MpvConfig {
            path: path.to_string_lossy().into_owned(),
            args: launch_args(args, ca_bundle.as_deref()),
            observed_properties,
            ipc_timeout_ms: clamp_ipc_timeout(ipc_timeout_ms),
            // Dev builds: surface mpv's own stderr so embedding/crash causes are visible in the terminal
            show_mpv_output: cfg!(debug_assertions),
        };
        app.mpv().init(config, &label)
    })
        .await
        .map_err(|_| "mpv process failed: init interrupted".to_string())?
        .map_err(|e| e.to_string())
}

/// Programme mpv lancé : toujours un chemin fixe, jamais choisi par le web. Windows : `mpv/mpv.exe`
/// des ressources de l'app. Linux : seulement la version d'audit (banc cloud, vrai lecteur de la zone
/// 6 bis), avec le mpv du système ; l'app n'est pas publiée pour Linux.
#[cfg(desktop)]
fn mpv_path<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<std::path::PathBuf, String> {
    #[cfg(all(target_os = "linux", feature = "audit"))]
    {
        let _ = app;
        Ok(std::path::PathBuf::from(LINUX_AUDIT_MPV))
    }
    #[cfg(target_os = "macos")]
    {
        use tauri::Manager;
        // mpv embarqué dans l'app s'il existe, sinon celui de Homebrew (développement)
        let bundled = app
            .path()
            .resolve("mpv/mpv", tauri::path::BaseDirectory::Resource)
            .map_err(|e| format!("mpv process failed: {}", e))?;
        if bundled.is_file() {
            return Ok(bundled);
        }
        MACOS_SYSTEM_MPV
            .iter()
            .map(std::path::PathBuf::from)
            .find(|p| p.is_file())
            .ok_or_else(|| "mpv process failed: mpv not found (brew install mpv)".to_string())
    }
    #[cfg(not(any(target_os = "macos", all(target_os = "linux", feature = "audit"))))]
    {
        use tauri::Manager;
        app.path()
            .resolve("mpv/mpv.exe", tauri::path::BaseDirectory::Resource)
            .map_err(|e| format!("mpv process failed: {}", e))
    }
}

/// mpv de Homebrew (Apple Silicon puis Intel), repli quand l'app n'embarque pas son propre mpv.
#[cfg(target_os = "macos")]
const MACOS_SYSTEM_MPV: &[&str] = &["/opt/homebrew/bin/mpv", "/usr/local/bin/mpv"];

/// mpv du système, pour la seule version d'audit Linux (banc cloud).
#[cfg_attr(not(all(target_os = "linux", feature = "audit")), allow(dead_code))]
const LINUX_AUDIT_MPV: &str = "/usr/bin/mpv";

/// Envoie une commande mpv autorisée ; renvoie la donnée de la réponse (ex. `get_property`).
#[cfg(all(desktop, not(target_os = "macos")))]
#[tauri::command]
pub async fn nyx_mpv_command<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    window: tauri::Window<R>,
    name: String,
    args: Vec<Value>,
) -> Result<Option<Value>, String> {
    use tauri_plugin_mpv::MpvExt;

    let command = validate_command(&name, &args)?;
    let label = window.label().to_string();
    let response = tauri::async_runtime::spawn_blocking(move || {
        // Le plugin ne connaît pas encore la fenêtre (mpv jamais lancé) : il paniquerait
        let known = app
            .mpv()
            .instances
            .lock()
            .map(|i| i.contains_key(&label))
            .unwrap_or(false);
        if !known {
            return Err("mpv process failed: not started".to_string());
        }
        app.mpv()
            .command(
                tauri_plugin_mpv::MpvCommand {
                    command,
                    request_id: None,
                },
                &label,
            )
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|_| "mpv process failed: command interrupted".to_string())??;

    if response.error != "success" {
        return Err(format!("mpv command failed: {}", response.error));
    }
    Ok(response.data)
}

/// Marges vidéo (panneau des chaînes). Remplace `plugin:mpv|set_video_margin_ratio`, qui plantait
/// en gardant le verrou du plugin si mpv n'était pas encore lancé (lecteur bloqué jusqu'au
/// redémarrage).
#[cfg(all(desktop, not(target_os = "macos")))]
#[tauri::command]
pub async fn nyx_mpv_set_margins<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    window: tauri::Window<R>,
    left: Option<f64>,
    right: Option<f64>,
    top: Option<f64>,
    bottom: Option<f64>,
) -> Result<(), String> {
    use tauri_plugin_mpv::MpvExt;

    let ratio = tauri_plugin_mpv::VideoMarginRatio {
        left: clamp_margin(left),
        right: clamp_margin(right),
        top: clamp_margin(top),
        bottom: clamp_margin(bottom),
    };
    let label = window.label().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let known = app
            .mpv()
            .instances
            .lock()
            .map(|i| i.contains_key(&label))
            .unwrap_or(false);
        if !known {
            return Err("mpv process failed: not started".to_string());
        }
        app.mpv()
            .set_video_margin_ratio(ratio, &label)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|_| "mpv process failed: margins interrupted".to_string())?
}

/// État du processus mpv lu par `try_wait` : seul « pas encore terminé » compte comme vivant.
fn is_still_running(status: std::io::Result<Option<std::process::ExitStatus>>) -> bool {
    matches!(status, Ok(None))
}

/// mpv.exe tourne-t-il encore pour la fenêtre appelante ? Le plugin ne prévient pas quand le
/// processus s'arrête (plantage, arrêt forcé) : le lecteur resterait ouvert, transparent et muet.
/// Le web interroge cette commande pendant la lecture (`mpvBridge.ts`). Aucune communication avec
/// mpv, seulement l'état du processus ; verrou déjà pris (lancement en cours) = supposé vivant.
#[cfg(all(desktop, not(target_os = "macos")))]
#[tauri::command]
pub async fn nyx_mpv_alive<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    window: tauri::Window<R>,
) -> Result<bool, String> {
    use tauri_plugin_mpv::MpvExt;

    let label = window.label().to_string();
    let mpv = app.mpv();
    let mut instances = match mpv.instances.try_lock() {
        Ok(instances) => instances,
        Err(std::sync::TryLockError::WouldBlock) => return Ok(true),
        Err(std::sync::TryLockError::Poisoned(_)) => return Ok(false),
    };
    Ok(instances
        .get_mut(&label)
        .is_some_and(|instance| is_still_running(instance.process.try_wait())))
}

// ---- macOS: libmpv inside the app (mpv_macos.rs), same commands for the web side ----

#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn nyx_mpv_init(
    app: tauri::AppHandle,
    window: tauri::Window,
    args: Vec<String>,
    observed_properties: Vec<String>,
    ipc_timeout_ms: u64,
) -> Result<String, String> {
    let _ = ipc_timeout_ms;
    validate_init_args(&args)?;
    validate_observed_properties(&observed_properties)?;
    let ca_bundle = crate::mpv_tls::ensure_bundle(&app);
    crate::mpv_macos::init(app, window, launch_args(args, ca_bundle.as_deref()), observed_properties).await
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn nyx_mpv_command(name: String, args: Vec<Value>) -> Result<Option<Value>, String> {
    let command = validate_command(&name, &args)?;
    tauri::async_runtime::spawn_blocking(move || crate::mpv_macos::command(&name, &command[1..]))
        .await
        .map_err(|_| "mpv process failed: command interrupted".to_string())?
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn nyx_mpv_set_margins(
    left: Option<f64>,
    right: Option<f64>,
    top: Option<f64>,
    bottom: Option<f64>,
) -> Result<(), String> {
    crate::mpv_macos::set_margins(clamp_margin(left), clamp_margin(right), clamp_margin(top), clamp_margin(bottom))
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn nyx_mpv_alive() -> Result<bool, String> {
    Ok(crate::mpv_macos::alive())
}

/// Android : libmpv passe par le plugin nyx-android, jamais par ces commandes.
#[cfg(mobile)]
#[tauri::command]
pub async fn nyx_mpv_init(
    args: Vec<String>,
    observed_properties: Vec<String>,
    ipc_timeout_ms: u64,
) -> Result<String, String> {
    let _ = (args, observed_properties, ipc_timeout_ms);
    Err("mpv desktop player unavailable on this platform".to_string())
}

#[cfg(mobile)]
#[tauri::command]
pub async fn nyx_mpv_set_margins(
    left: Option<f64>,
    right: Option<f64>,
    top: Option<f64>,
    bottom: Option<f64>,
) -> Result<(), String> {
    let _ = (left, right, top, bottom);
    Err("mpv desktop player unavailable on this platform".to_string())
}

#[cfg(mobile)]
#[tauri::command]
pub async fn nyx_mpv_alive() -> Result<bool, String> {
    Err("mpv desktop player unavailable on this platform".to_string())
}

#[cfg(mobile)]
#[tauri::command]
pub async fn nyx_mpv_command(name: String, args: Vec<Value>) -> Result<Option<Value>, String> {
    let _ = (name, args);
    Err("mpv desktop player unavailable on this platform".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn strings(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn mpv_vivant_seulement_si_le_processus_n_est_pas_termine() {
        assert!(is_still_running(Ok(None)));
        assert!(!is_still_running(Err(std::io::Error::other("wait failed"))));
        let exited = std::process::Command::new(if cfg!(windows) { "cmd" } else { "sh" })
            .args(if cfg!(windows) { ["/C", "exit"] } else { ["-c", "exit"] })
            .status()
            .expect("shell available");
        assert!(!is_still_running(Ok(Some(exited))));
    }

    #[test]
    fn accepte_les_options_envoyees_par_l_app() {
        let args = strings(&[
            "--vo=gpu-next,gpu",
            "--hwdec=auto-safe",
            "--keep-open=yes",
            "--force-window",
            "--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0",
            "--network-timeout=30",
            "--stream-lavf-o=multiple_requests=0",
            "--cache=yes",
            "--demuxer-max-bytes=50MiB",
            "--demuxer-max-back-bytes=25MiB",
            "--ytdl=no",
        ]);
        assert_eq!(validate_init_args(&args), Ok(()));
    }

    #[test]
    fn refuse_les_options_qui_lancent_un_programme_ou_un_script() {
        for arg in [
            "--script=C:\\evil.lua",
            "--scripts=a.lua",
            "--include=C:\\evil.conf",
            "--input-conf=evil.conf",
            "--ytdl=yes",
            "--script-opts=ytdl_hook-ytdl_path=C:\\evil.exe",
            "--stream-lavf-o=protocol_whitelist=file",
            "--input-ipc-server=\\\\.\\pipe\\autre",
            "-vo=gpu",
            "fichier.mkv",
            "--vo=image",
            "--hwdec=vaapi",
            "--demuxer-max-bytes=100GiB",
            "--demuxer-max-bytes=4096MiB",
            "--network-timeout=0",
            "--user-agent=a\nb",
            "--load-scripts=yes",
            "--config=yes",
            "--no-config",
            "--config-dir=C:/x",
        ] {
            assert!(validate_init_args(&strings(&[arg])).is_err(), "{arg}");
        }
    }

    #[test]
    fn options_de_securite_toujours_ajoutees_apres_celles_du_web() {
        let args = launch_args(strings(&["--keep-open=yes"]), None);
        assert_eq!(args[0], "--keep-open=yes");
        for forced in ["--ytdl=no", "--load-scripts=no", "--load-unsafe-playlists=no", "--config=no", "--tls-verify=yes"] {
            assert!(args.contains(&forced.to_string()), "{forced}");
        }
        // Liste vide : mêmes protections
        let platform = platform_args(cfg!(all(target_os = "linux", feature = "audit"))).len();
        assert_eq!(launch_args(vec![], None).len(), 6 + platform);
    }

    #[test]
    fn x11_output_only_for_the_linux_audit_build() {
        assert_eq!(platform_args(true), &["--vo=gpu-next,gpu,x11", "--ao=null"]);
        #[cfg(not(target_os = "macos"))]
        assert!(platform_args(false).is_empty());
        #[cfg(target_os = "macos")]
        assert_eq!(platform_args(false).len(), 2);
        // Hors version d'audit Linux, les options de lancement ne changent pas
        #[cfg(not(all(target_os = "linux", feature = "audit")))]
        assert!(!launch_args(vec![], None).iter().any(|a| a.starts_with("--vo=") || a.starts_with("--ao=")));
    }

    #[test]
    fn certificats_https_toujours_verifies_avec_le_fichier_exporte() {
        // Sans ces options, mpv.exe acceptait n'importe quel certificat HTTPS
        let bundle = std::path::Path::new("C:/data/mpv-cacerts.pem");
        let args = launch_args(strings(&["--keep-open=yes"]), Some(bundle));
        assert_eq!(
            args[args.len() - 2..],
            strings(&["--tls-verify=yes", "--tls-ca-file=C:/data/mpv-cacerts.pem"])
        );
        // Le web ne peut ni couper la vérification ni choisir le fichier d'autorités
        for arg in ["--tls-verify=no", "--tls-verify", "--tls-ca-file=C:/evil.pem", "--stream-lavf-o=tls_verify=0"] {
            assert!(validate_init_args(&strings(&[arg])).is_err(), "{arg}");
        }
    }

    #[test]
    fn marges_bornees() {
        assert_eq!(clamp_margin(Some(0.4)), Some(0.4));
        assert_eq!(clamp_margin(Some(-1.0)), Some(0.0));
        assert_eq!(clamp_margin(Some(5.0)), Some(0.9));
        assert_eq!(clamp_margin(Some(f64::NAN)), None);
        assert_eq!(clamp_margin(None), None);
    }

    #[test]
    fn refuse_une_propriete_observee_qui_casserait_le_json_du_plugin() {
        assert!(validate_observed_properties(&strings(&["pause", "track-list", "track-list/count"])).is_ok());
        assert!(validate_observed_properties(&strings(&["x\"]}\n{\"command\":[\"run\",\"calc\"]}"])).is_err());
        assert!(validate_observed_properties(&strings(&[""])).is_err());
        assert!(validate_observed_properties(&strings(&["Pause"])).is_err());
    }

    #[test]
    fn delai_de_reponse_borne() {
        assert_eq!(clamp_ipc_timeout(0), 500);
        assert_eq!(clamp_ipc_timeout(3_000), 3_000);
        assert_eq!(clamp_ipc_timeout(u64::MAX), 10_000);
    }

    #[test]
    fn accepte_les_commandes_de_l_app() {
        let url = "http://fournisseur.invalid:8080/live/u/p/1.ts";
        assert_eq!(
            validate_command("loadfile", &[json!(url), json!("replace")]),
            Ok(vec![json!("loadfile"), json!(url), json!("replace")])
        );
        assert!(validate_command("loadfile", &[json!("https://h.invalid/movie/u/p/2.mkv")]).is_ok());
        assert!(validate_command("stop", &[]).is_ok());
        assert!(validate_command("seek", &[json!("12.5"), json!("absolute")]).is_ok());
        assert!(validate_command("seek", &[json!("-10"), json!("relative")]).is_ok());
        assert!(validate_command("seek", &[json!(30), json!("absolute+exact")]).is_ok());
        assert!(validate_command("get_property", &[json!("track-list")]).is_ok());
        assert!(validate_command("get_property", &[json!("demuxer-cache-state")]).is_ok());
        for (name, value) in [
            ("pause", json!(true)),
            ("volume", json!(80)),
            ("aid", json!("auto")),
            ("sid", json!("no")),
            ("start", json!("none")),
            ("speed", json!(1.5)),
            ("video-aspect-override", json!("16:9")),
        ] {
            assert!(validate_command("set_property", &[json!(name), value]).is_ok(), "{name}");
        }
        assert!(validate_command("cycle", &[json!("pause")]).is_ok());
    }

    #[test]
    fn refuse_les_commandes_qui_lancent_un_programme() {
        for (name, args) in [
            ("run", vec![json!("calc.exe")]),
            ("subprocess", vec![json!({"args": ["calc.exe"]})]),
            ("load-script", vec![json!("C:\\evil.lua")]),
            ("script-message", vec![json!("x")]),
            ("keypress", vec![json!("q")]),
            ("quit", vec![]),
            ("set_property", vec![json!("script-opts"), json!("ytdl_hook-ytdl_path=C:\\evil.exe")]),
            ("set_property", vec![json!("ytdl"), json!(true)]),
            ("set_property", vec![json!("input-ipc-server"), json!("x")]),
            ("set_property", vec![json!("volume"), json!({"a": 1})]),
            ("cycle", vec![json!("ytdl")]),
            ("loadfile", vec![json!("C:\\Windows\\evil.m3u")]),
            ("loadfile", vec![json!("file:///C:/evil.m3u")]),
            ("loadfile", vec![json!("av://lavfi:testsrc")]),
            ("loadfile", vec![json!("udp://@:5000")]),
            ("loadfile", vec![json!("srt://:9000?mode=listener")]),
            ("loadfile", vec![json!("http://h.invalid/1.ts"), json!("replace"), json!(0), json!("script=evil.lua")]),
            ("loadfile", vec![json!("http://h.invalid/1.ts"), json!("replace,script=x")]),
            ("seek", vec![json!("abc")]),
            ("seek", vec![json!("10"), json!("absolute"), json!("x")]),
            ("get_property", vec![json!("x\"y")]),
            ("stop", vec![json!("keep-playlist")]),
        ] {
            assert!(validate_command(name, &args).is_err(), "{name} {args:?}");
        }
    }

    #[test]
    fn une_erreur_ne_cite_jamais_l_adresse_du_flux() {
        let err = validate_init_args(&strings(&["--script=http://h/live/user/pass/1.ts"])).unwrap_err();
        assert!(!err.contains("pass"), "{err}");
        let err = validate_command("run", &[json!("http://h/live/user/pass/1.ts")]).unwrap_err();
        assert!(!err.contains("pass"), "{err}");
    }
}
