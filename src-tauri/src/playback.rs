//! Playback helpers shared by the player front-end.
//!
//! - `probe_stream_status`: HTTP status of a stream that MPV failed to load. mpv reports
//!   `end-file: error` without the provider's answer, which is needed to tell a connection
//!   limit (Xtream HTTP 458) from an expired account or a removed title.
//! - `kill_orphan_mpv` (Windows): an mpv.exe left behind by a crashed app instance keeps
//!   the IPTV stream open, i.e. a provider connection slot stays busy.
//!
//! Stream URLs embed the account credentials: never log them.

use std::time::Duration;

/// Same User-Agent as the mpv process (providers reject unknown clients).
const PROBE_USER_AGENT: &str = crate::http::IPTV_USER_AGENT;

/// One request per load failure (Range 0-0, body never read) — no retry here: automatic
/// reconnection is paced by the front-end to stay far below provider anti-flood limits.
#[tauri::command]
pub async fn probe_stream_status(url: String) -> Result<u16, String> {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(10))
        .user_agent(PROBE_USER_AGENT)
        // The stream address carries the subscriber's credentials: not sent on to a redirection host
        .referer(false)
        .build()
        .map_err(|e| format!("HTTP client build failed: {}", e.without_url()))?;

    let response = client
        .get(&url)
        .header(reqwest::header::RANGE, "bytes=0-0")
        .send()
        .await
        .map_err(|e| {
            let e = e.without_url();
            log::warn!("[Playback] Stream probe failed: {}", e);
            format!("unreachable: {}", e)
        })?;

    let status = response.status().as_u16();
    // Dropping the unread response closes the connection immediately (frees the provider slot).
    drop(response);
    log::info!("[Playback] Stream probe status: {}", status);
    Ok(status)
}

/// Full path of Windows PowerShell under the system folder. Launching it by its bare name would
/// search the app's own folder and the PATH first, where another `powershell.exe` could be placed.
/// `SystemRoot` is only used when it is an absolute drive path; otherwise the default folder is used.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn powershell_path(system_root: Option<&str>) -> String {
    let root = system_root
        .map(|r| r.trim_end_matches('\\'))
        .filter(|r| {
            let b = r.as_bytes();
            b.len() >= 3
                && b[0].is_ascii_alphabetic()
                && b[1] == b':'
                && b[2] == b'\\'
                && !r.contains("..")
                && !r.contains('/')
        })
        .unwrap_or(r"C:\Windows");
    format!(r"{}\System32\WindowsPowerShell\v1.0\powershell.exe", root)
}

/// Kills mpv.exe processes started by tauri-plugin-mpv whose parent app is gone.
/// Runs in the background at startup (PowerShell/CIM gives access to command lines).
#[cfg(target_os = "windows")]
pub fn kill_orphan_mpv() {
    std::thread::spawn(|| {
        use std::os::windows::process::CommandExt;
        use std::process::Command;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;

        let script = r#"Get-CimInstance Win32_Process -Filter "Name='mpv.exe'" |
  Where-Object { $_.CommandLine -like '*tauri_plugin_mpv_socket*' -and -not (Get-Process -Id $_.ParentProcessId -ErrorAction SilentlyContinue) } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $_.ProcessId }"#;

        let powershell = powershell_path(std::env::var("SystemRoot").ok().as_deref());
        match Command::new(powershell)
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
        {
            Ok(output) => {
                let killed = String::from_utf8_lossy(&output.stdout)
                    .lines()
                    .filter(|line| !line.trim().is_empty())
                    .count();
                if killed > 0 {
                    log::warn!("[Playback] Killed {} orphan mpv process(es)", killed);
                }
            }
            Err(e) => log::warn!("[Playback] Orphan mpv check failed: {}", e),
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{powershell_path, probe_stream_status, PROBE_USER_AGENT};

    #[test]
    fn powershell_is_launched_from_the_system_folder() {
        let expected = r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe";
        assert_eq!(powershell_path(Some(r"C:\Windows")), expected);
        assert_eq!(powershell_path(Some(r"C:\Windows\")), expected);
        assert_eq!(
            powershell_path(Some(r"D:\WINNT")),
            r"D:\WINNT\System32\WindowsPowerShell\v1.0\powershell.exe"
        );
        // Missing, relative or odd values: the default system folder, never a bare name
        for odd in [None, Some(""), Some("Windows"), Some(r"\\server\share"), Some(r"C:\x\..\y"), Some("C:/Windows")] {
            assert_eq!(powershell_path(odd), expected, "{odd:?}");
        }
    }
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    /// Faux fournisseur local à une connexion : renvoie la requête reçue (pour vérifier les
    /// en-têtes) et répond `response` ; `None` = connexion acceptée mais jamais de réponse.
    /// L'URL imite une adresse Xtream avec de faux identifiants : ils ne doivent apparaître nulle part.
    fn fake_provider(response: Option<String>) -> (String, mpsc::Receiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let Ok((mut stream, _)) = listener.accept() else { return };
            let mut buf = [0u8; 4096];
            let mut request = Vec::new();
            while !request.windows(4).any(|w| w == b"\r\n\r\n") {
                match stream.read(&mut buf) {
                    Ok(0) | Err(_) => return,
                    Ok(k) => request.extend_from_slice(&buf[..k]),
                }
            }
            let _ = tx.send(String::from_utf8_lossy(&request).to_string());
            match response {
                Some(r) => {
                    let _ = stream.write_all(r.as_bytes());
                    // Corps annoncé mais jamais envoyé en entier : la sonde ne doit pas l'attendre
                    std::thread::sleep(Duration::from_secs(30));
                }
                None => std::thread::sleep(Duration::from_secs(30)),
            }
        });
        (format!("http://{}/live/faux_user/faux_mdp/1234.ts", addr), rx)
    }

    fn head(status_line: &str) -> Option<String> {
        Some(format!(
            "HTTP/1.1 {}\r\nContent-Type: video/mp2t\r\nContent-Length: 50000000\r\n\r\n",
            status_line
        ))
    }

    /// Codes que le lecteur distingue (mpvBridge.ts) : 458 = trop de connexions chez
    /// le fournisseur Xtream, 401/403 = abonnement expiré ou refusé, 404 = titre retiré. Les
    /// codes sont rendus tels quels, même le 458 hors norme, et sans lire le flux.
    #[tokio::test]
    async fn provider_status_codes_are_returned_as_is() {
        for (line, code) in [
            ("458 Unknown", 458u16),
            ("401 Unauthorized", 401),
            ("403 Forbidden", 403),
            ("404 Not Found", 404),
            ("206 Partial Content", 206),
            ("200 OK", 200),
        ] {
            let (url, _) = fake_provider(head(line));
            let started = Instant::now();
            assert_eq!(probe_stream_status(url).await, Ok(code), "réponse {}", line);
            assert!(started.elapsed() < Duration::from_secs(3), "corps attendu pour {} : {:?}", line, started.elapsed());
        }
    }

    /// Une seule petite requête, présentée comme mpv : premier octet seulement (Range), même
    /// User-Agent (les fournisseurs refusent les clients inconnus).
    #[tokio::test]
    async fn the_probe_asks_for_one_byte_with_the_player_user_agent() {
        let (url, request) = fake_provider(head("206 Partial Content"));
        probe_stream_status(url).await.unwrap();
        let request = request.recv_timeout(Duration::from_secs(2)).unwrap().to_lowercase();
        assert!(request.starts_with("get /live/faux_user/faux_mdp/1234.ts "), "{}", request);
        assert!(request.contains("range: bytes=0-0\r\n"), "{}", request);
        assert!(request.contains(&format!("user-agent: {}\r\n", PROBE_USER_AGENT.to_lowercase())), "{}", request);
    }

    /// Fournisseur injoignable : erreur « unreachable », sans l'adresse du flux (elle contient
    /// les identifiants de l'abonné) dans le message remonté à la page.
    #[tokio::test]
    async fn an_unreachable_provider_is_reported_without_the_credentials() {
        let port = {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.local_addr().unwrap().port()
        };
        let url = format!("http://127.0.0.1:{}/live/faux_user/faux_mdp/1234.ts", port);
        let err = probe_stream_status(url).await.unwrap_err();
        assert!(err.starts_with("unreachable: "), "{}", err);
        for secret in ["faux_user", "faux_mdp", "1234.ts", "127.0.0.1"] {
            assert!(!err.contains(secret), "« {} » dans l'erreur : {}", secret, err);
        }
    }

    /// Fournisseur qui ne répond jamais : la sonde abandonne au bout de 10 s au plus (le lecteur
    /// attend ce résultat pour choisir son message).
    #[tokio::test]
    async fn a_silent_provider_gives_up_after_ten_seconds() {
        let (url, _) = fake_provider(None);
        let started = Instant::now();
        let err = probe_stream_status(url).await.unwrap_err();
        let elapsed = started.elapsed();
        assert!(err.starts_with("unreachable: "), "{}", err);
        assert!(!err.contains("faux_mdp"), "{}", err);
        assert!(elapsed >= Duration::from_secs(9), "abandon trop tôt : {:?}", elapsed);
        assert!(elapsed < Duration::from_secs(15), "délai non respecté : {:?}", elapsed);
    }

    /// Journaux : jamais l'adresse du flux (identifiants) citée directement. Ne voit pas une erreur
    /// qui contiendrait encore l'adresse : ce cas est couvert par les tests « unreachable » plus
    /// haut, car le journal et le message renvoyé utilisent la même erreur (`without_url`).
    #[test]
    fn logs_never_mention_the_stream_url() {
        let source = include_str!("playback.rs");
        let code = &source[..source.find("#[cfg(test)]").unwrap()];
        let mut checked = 0;
        for level in ["log::info!(", "log::warn!(", "log::error!(", "log::debug!("] {
            for (start, _) in code.match_indices(level) {
                let call = &code[start..start + code[start..].find(");").unwrap()];
                assert!(!call.contains("url"), "{call} cite l'adresse du flux");
                checked += 1;
            }
        }
        assert!(checked >= 2, "journaux trouvés : {checked}");
    }
}
