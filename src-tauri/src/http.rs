use crate::dns::CascadeDohResolver;
use std::sync::Arc;

/// User-Agent navigateur, le même que celui du lecteur (mpv) et de la sonde de lecture.
/// À garder aligné avec `mpvBridge.ts` et `MpvEngine.kt`. reqwest n'en envoie AUCUN par défaut : beaucoup de fournisseurs (ou leur protection
/// Cloudflare) répondent alors par une page web au lieu du JSON de `player_api.php`.
pub const IPTV_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/// Construit un reqwest::Client avec DNS DoH cascade si provider != "system".
/// - connect_timeout: échec rapide si serveur injoignable
/// - timeout: durée totale maximale de la requête
pub fn build_http_client(
    provider: &str,
    connect_timeout_secs: u64,
    total_timeout_secs: u64,
) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .user_agent(IPTV_USER_AGENT)
        .connect_timeout(std::time::Duration::from_secs(connect_timeout_secs))
        .timeout(std::time::Duration::from_secs(total_timeout_secs))
        // The provider addresses carry the subscriber's credentials (`?username=…&password=…`):
        // never sent on to the host of a redirection in a `Referer` header
        .referer(false);

    if let Some(resolver) = CascadeDohResolver::new(provider) {
        log::info!(
            "[HTTP] Client catalogue/guide avec DNS DoH cascade (provider: {})",
            provider
        );
        builder = builder.dns_resolver(Arc::new(resolver));
    } else {
        log::info!("[HTTP] Client catalogue/guide avec DNS système");
    }

    builder
        .build()
        .map_err(|e| format!("HTTP client build failed: {}", e))
}

#[cfg(test)]
mod tests {
    use super::build_http_client;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::time::{Duration, Instant};

    /// Petit serveur local à une connexion : `Some(réponse)` est envoyée après la requête,
    /// `None` = connexion acceptée mais jamais de réponse (fournisseur figé).
    fn serve_once(response: Option<&'static str>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
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
            match response {
                Some(r) => {
                    let _ = stream.write_all(r.as_bytes());
                }
                None => std::thread::sleep(Duration::from_secs(30)),
            }
        });
        // Adresse IP littérale : aucun DNS consulté, ni système ni DoH (pas de réseau réel)
        format!("http://{}/player_api.php", addr)
    }

    const OK: &str = "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok";

    /// The host a provider redirects to never receives the provider address (credentials included)
    /// in a `Referer` header.
    #[tokio::test]
    async fn no_referer_is_sent_to_the_host_of_a_redirection() {
        // Host of the redirection: keeps the request it receives
        let target = TcpListener::bind("127.0.0.1:0").unwrap();
        let target_addr = target.local_addr().unwrap();
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        std::thread::spawn(move || {
            let Ok((mut stream, _)) = target.accept() else { return };
            let mut buf = [0u8; 4096];
            let mut request = Vec::new();
            while !request.windows(4).any(|w| w == b"\r\n\r\n") {
                match stream.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(k) => request.extend_from_slice(&buf[..k]),
                }
            }
            let _ = tx.send(String::from_utf8_lossy(&request).to_lowercase());
            let _ = stream.write_all(OK.as_bytes());
        });
        let redirect: &'static str = Box::leak(
            format!("HTTP/1.1 302 Found\r\nLocation: http://{}/list\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", target_addr)
                .into_boxed_str(),
        );
        let provider = serve_once(Some(redirect));
        let client = build_http_client("system", 2, 5).unwrap();
        let response = client.get(format!("{}?username=jean&password=s3cret", provider)).send().await.unwrap();
        assert_eq!(response.status(), 200);
        let request = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(!request.contains("referer"), "{request}");
        assert!(!request.contains("s3cret"), "{request}");
    }

    /// Les trois choix du réglage « DNS » (preferencesService.ts), et une valeur inconnue qui
    /// retombe sur le DNS système : le client se construit toujours.
    #[tokio::test]
    async fn every_dns_setting_builds_a_client() {
        for provider in ["system", "cloudflare", "quad9", "", "inconnu"] {
            assert!(build_http_client(provider, 10, 60).is_ok(), "provider {:?}", provider);
        }
    }

    /// Le client configuré avec ou sans DNS sécurisé fonctionne sur une adresse IP (le résolveur
    /// DoH n'est pas consulté pour une IP : le tester sur un nom demanderait le vrai réseau).
    #[tokio::test]
    async fn a_normal_answer_goes_through_with_each_dns_setting() {
        for provider in ["system", "cloudflare", "quad9"] {
            let url = serve_once(Some(OK));
            let client = build_http_client(provider, 5, 5).unwrap();
            let response = client.get(&url).send().await.unwrap();
            assert_eq!(response.status().as_u16(), 200, "provider {}", provider);
            assert_eq!(response.text().await.unwrap(), "ok", "provider {}", provider);
        }
    }

    /// Fournisseur qui accepte la connexion puis ne répond plus : la requête s'arrête au délai
    /// total demandé au lieu de bloquer le catalogue ou le guide indéfiniment.
    #[tokio::test]
    async fn a_frozen_provider_stops_at_the_total_timeout() {
        let url = serve_once(None);
        let client = build_http_client("system", 5, 1).unwrap();
        let started = Instant::now();
        let err = client.get(&url).send().await.unwrap_err();
        let elapsed = started.elapsed();
        assert!(err.is_timeout(), "{}", err);
        assert!(elapsed >= Duration::from_millis(900), "arrêt trop tôt : {:?}", elapsed);
        assert!(elapsed < Duration::from_secs(5), "délai non respecté : {:?}", elapsed);
    }

    /// Le délai total couvre aussi la lecture du corps : un envoi qui s'interrompt en cours de
    /// route ne bloque pas plus longtemps.
    #[tokio::test]
    async fn a_body_that_stops_midway_stops_at_the_total_timeout() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            let Ok((mut stream, _)) = listener.accept() else { return };
            let mut buf = [0u8; 4096];
            let _ = stream.read(&mut buf);
            let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 1000000\r\n\r\n{\"debut\":");
            std::thread::sleep(Duration::from_secs(30));
        });
        let client = build_http_client("system", 5, 1).unwrap();
        let started = Instant::now();
        let response = client.get(format!("http://{}/", addr)).send().await.unwrap();
        let err = response.text().await.unwrap_err();
        assert!(err.is_timeout(), "{}", err);
        assert!(started.elapsed() < Duration::from_secs(5), "{:?}", started.elapsed());
    }

    /// Serveur éteint (port fermé) : erreur de connexion rapide, sans attendre le délai de
    /// connexion (30 s ici ; Windows met environ 2 s à abandonner après un refus, d'où la marge).
    #[tokio::test]
    async fn a_closed_port_fails_fast() {
        let port = {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.local_addr().unwrap().port()
        };
        let client = build_http_client("system", 30, 60).unwrap();
        let started = Instant::now();
        let err = client.get(format!("http://127.0.0.1:{}/", port)).send().await.unwrap_err();
        assert!(err.is_connect(), "{}", err);
        assert!(started.elapsed() < Duration::from_secs(10), "{:?}", started.elapsed());
    }

    /// Le client présente un User-Agent navigateur : reqwest n'en envoie aucun par défaut, et des
    /// fournisseurs (ou Cloudflare) répondent alors par une page web au lieu du JSON.
    #[tokio::test]
    async fn the_client_sends_a_browser_user_agent() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buf = [0u8; 4096];
            let k = stream.read(&mut buf).unwrap();
            let _ = tx.send(String::from_utf8_lossy(&buf[..k]).to_lowercase());
            let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n[]");
        });
        let client = build_http_client("system", 5, 10).unwrap();
        client.get(format!("http://{}/player_api.php", addr)).send().await.unwrap();
        let request = rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(request.contains(&format!("user-agent: {}\r\n", super::IPTV_USER_AGENT.to_lowercase())), "{}", request);
    }
}
