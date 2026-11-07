//! Demandes réseau vers une adresse reçue d'un autre appareil (connexion de la TV par QR code).
//!
//! Quiconque voit le QR code peut envoyer une adresse de serveur : la TV ne doit pas devenir un
//! outil pour sonder les appareils de la maison (box, NAS, caméras). Le client de ce module refuse
//! toute adresse qui n'est pas publique : adresse IP écrite telle quelle, nom qui se résout vers une
//! adresse privée (`192-168-1-1.exemple`), et chaque saut d'une redirection. Aucune connexion n'est
//! ouverte vers une adresse refusée, et la TV répond alors au téléphone « serveur injoignable »,
//! comme pour un serveur éteint : rien n'est appris sur le réseau local.
//!
//! Limites connues : un appareil de la maison qui a une adresse IPv6 publique, ou l'adresse IPv4
//! publique de la box, passent pour publics ; de même un préfixe NAT64 propre à un opérateur.

use crate::dns::CascadeDohResolver;
use crate::http::IPTV_USER_AGENT;
use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::Arc;

/// Redirections suivies au plus (http → https, répartiteur de charge) ; chacune est contrôlée.
const MAX_REDIRECTS: usize = 5;

/// Vrai pour une adresse joignable sur Internet ; faux pour le réseau local, l'appareil lui-même,
/// les plages réservées, de documentation ou de multidiffusion.
pub fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_public_v4(v4),
        IpAddr::V6(v6) => is_public_v6(v6),
    }
}

fn is_public_v4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    !(a == 0
        || a == 10
        || a == 127
        || (a == 100 && (64..=127).contains(&b))
        || (a == 169 && b == 254)
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && b == 0 && (c == 0 || c == 2))
        || (a == 192 && b == 88 && c == 99)
        || (a == 192 && b == 168)
        || (a == 198 && (b == 18 || b == 19))
        || (a == 198 && b == 51 && c == 100)
        || (a == 203 && b == 0 && c == 113)
        || a >= 224)
}

fn is_public_v6(ip: Ipv6Addr) -> bool {
    let s = ip.segments();
    // IPv4 encapsulée (::ffff:a.b.c.d), compatible (::a.b.c.d), NAT64 (64:ff9b::a.b.c.d) ou 6to4
    // (2002:abcd:…) : c'est l'adresse IPv4 qui compte
    let embedded = |hi: u16, lo: u16| Ipv4Addr::new((hi >> 8) as u8, hi as u8, (lo >> 8) as u8, lo as u8);
    if s[..5] == [0, 0, 0, 0, 0] && (s[5] == 0xffff || s[5] == 0) {
        return s[5] == 0xffff && is_public_v4(embedded(s[6], s[7]));
    }
    if s[..6] == [0x64, 0xff9b, 0, 0, 0, 0] {
        return is_public_v4(embedded(s[6], s[7]));
    }
    if s[0] == 0x2002 {
        return is_public_v4(embedded(s[1], s[2]));
    }
    !(ip.is_unspecified()
        || ip.is_loopback()
        || (s[0] & 0xfe00) == 0xfc00 // locale unique fc00::/7
        || (s[0] & 0xffc0) == 0xfe80 // lien local fe80::/10
        || (s[0] & 0xffc0) == 0xfec0 // site local (ancien) fec0::/10
        || (s[0] & 0xff00) == 0xff00 // multidiffusion
        || (s[0] == 0x2001 && s[1] == 0x0db8) // documentation
        || (s[0] == 0x2001 && s[1] == 0) // Teredo : tunnel vers une adresse quelconque
        || s[..4] == [0x100, 0, 0, 0]) // à jeter, 100::/64
}

/// Vrai si l'adresse demandée peut être essayée : http ou https, et pas d'adresse IP non publique
/// écrite telle quelle (un nom est contrôlé à la résolution, par `PublicOnlyResolver`).
fn url_allowed(url: &reqwest::Url) -> bool {
    if url.scheme() != "http" && url.scheme() != "https" {
        return false;
    }
    let Some(host) = url.host_str() else { return false };
    // IPv6 écrite entre crochets ; IPv4 déjà normalisée par l'analyse de l'adresse (`0x7f.1` → `127.0.0.1`)
    match host.trim_start_matches('[').trim_end_matches(']').parse::<IpAddr>() {
        Ok(ip) => is_public_ip(ip),
        Err(_) => !host.is_empty(),
    }
}

/// Résolveur qui ne rend que les adresses publiques. Un nom dont aucune adresse n'est publique
/// échoue comme un nom introuvable. Toutes les adresses non publiques sont retirées, pas seulement
/// la première : le client ne peut pas se rabattre sur l'une d'elles.
struct PublicOnlyResolver {
    doh: Option<Arc<CascadeDohResolver>>,
}

impl Resolve for PublicOnlyResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let doh = self.doh.clone();
        Box::pin(async move {
            let found: Vec<SocketAddr> = match doh {
                Some(resolver) => resolver.resolve(name).await?.collect(),
                None => tokio::net::lookup_host(format!("{}:0", name.as_str())).await?.collect(),
            };
            let public: Vec<SocketAddr> = found.into_iter().filter(|a| is_public_ip(a.ip())).collect();
            if public.is_empty() {
                return Err("no public address".into());
            }
            Ok(Box::new(public.into_iter()) as Addrs)
        })
    }
}

/// Client pour une adresse reçue d'un autre appareil : mêmes réglages que le client du catalogue
/// (User-Agent, pas de `Referer`, DNS choisi), plus le refus des adresses non publiques, à chaque
/// saut de redirection, et sans proxy (un proxy résoudrait les noms à notre place, sans contrôle).
pub fn build_public_only_client(
    dns_provider: &str,
    connect_timeout_secs: u64,
    total_timeout_secs: u64,
) -> Result<reqwest::Client, String> {
    let resolver = PublicOnlyResolver { doh: CascadeDohResolver::new(dns_provider).map(Arc::new) };
    reqwest::Client::builder()
        .user_agent(IPTV_USER_AGENT)
        .connect_timeout(std::time::Duration::from_secs(connect_timeout_secs))
        .timeout(std::time::Duration::from_secs(total_timeout_secs))
        .referer(false)
        .no_proxy()
        .dns_resolver(Arc::new(resolver))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= MAX_REDIRECTS {
                attempt.error("too many redirects")
            } else if !url_allowed(attempt.url()) {
                attempt.error("redirect to a non-public address")
            } else {
                attempt.follow()
            }
        }))
        .build()
        .map_err(|e| format!("HTTP client build failed: {}", e))
}

/// Contrôle de l'adresse de départ, avant toute connexion.
pub fn check_start_url(url: &str) -> Result<(), String> {
    match reqwest::Url::parse(url) {
        Ok(parsed) if url_allowed(&parsed) => Ok(()),
        _ => Err(format!("{}: address not allowed", crate::ingestion::PROVIDER_UNREACHABLE)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::time::Duration;

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn private_reserved_and_local_addresses_are_not_public() {
        for s in [
            "0.0.0.0", "10.1.2.3", "100.64.0.1", "127.0.0.1", "169.254.1.1", "172.16.0.1", "172.31.255.255",
            "192.0.0.8", "192.0.2.10", "192.168.0.1", "198.18.0.1", "198.19.255.1", "198.51.100.7",
            "203.0.113.9", "224.0.0.1", "239.255.255.250", "240.0.0.1", "255.255.255.255",
            "::", "::1", "::ffff:192.168.0.1", "::c0a8:1", "64:ff9b::c0a8:1", "2002:c0a8:0101::1",
            "fc00::1", "fd12:3456::1", "fe80::1", "fec0::1", "ff02::1", "2001:db8::1", "2001:0:4136::1",
            "100::1",
        ] {
            assert!(!is_public_ip(ip(s)), "{s} passe pour publique");
        }
    }

    #[test]
    fn internet_addresses_are_public() {
        for s in ["1.1.1.1", "8.8.8.8", "172.32.0.1", "100.128.0.1", "198.20.0.1", "::ffff:8.8.8.8",
            "64:ff9b::808:808", "2606:4700:4700::1111", "2a00:1450:4007::200e"]
        {
            assert!(is_public_ip(ip(s)), "{s} refusée");
        }
    }

    #[test]
    fn start_address_written_as_a_private_ip_is_refused_before_any_connection() {
        for url in ["http://192.168.0.1/", "http://127.0.0.1:8080/x", "http://[::1]/", "http://[::ffff:c0a8:1]/",
            "http://2130706433/", "http://0x7f.1/", "file:///etc/passwd", "pas une adresse"]
        {
            let err = check_start_url(url).unwrap_err();
            assert!(err.starts_with(crate::ingestion::PROVIDER_UNREACHABLE), "{url} : {err}");
        }
        assert!(check_start_url("https://serveur.example:8080/player_api.php").is_ok());
        assert!(check_start_url("http://8.8.8.8/").is_ok());
    }

    /// Un nom qui ne se résout que vers l'appareil lui-même (`localhost`) est refusé à la
    /// résolution : aucune connexion n'est ouverte vers le serveur qui écoute sur ce port.
    #[tokio::test]
    async fn a_name_resolving_to_a_local_address_is_never_contacted() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let client = build_public_only_client("system", 2, 5).unwrap();
        let err = client.get(format!("http://localhost:{port}/")).send().await.unwrap_err();
        assert!(err.is_connect(), "{err}");
        std::thread::sleep(Duration::from_millis(100));
        assert!(listener.accept().is_err(), "connexion ouverte vers l'adresse locale");
    }

    /// Saut de redirection vers la box, le NAS ou l'appareil : refusé ; vers un autre serveur public : suivi.
    #[test]
    fn a_redirect_hop_to_the_home_network_is_refused() {
        for target in ["http://192.168.0.1/admin", "http://[fe80::1]/", "http://10.0.0.1:8080/"] {
            assert!(!url_allowed(&reqwest::Url::parse(target).unwrap()), "{target}");
        }
        assert!(url_allowed(&reqwest::Url::parse("https://cdn.serveur.example/x").unwrap()));
    }

    /// De bout en bout : un serveur renvoie vers une adresse locale ; la chaîne s'arrête à ce saut
    /// et la cible ne reçoit aucune connexion. Le serveur de départ écoute sur l'appareil, faute de
    /// réseau dans les tests : une IP écrite telle quelle n'est jugée que par `check_start_url`,
    /// que la commande appelle avant le client, et que ce test ne fait pas.
    #[tokio::test]
    async fn the_redirect_policy_stops_at_a_local_hop() {
        let target = TcpListener::bind("127.0.0.1:0").unwrap();
        target.set_nonblocking(true).unwrap();
        let target_addr = target.local_addr().unwrap();
        let origin = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin_addr = origin.local_addr().unwrap();
        std::thread::spawn(move || {
            let Ok((mut stream, _)) = origin.accept() else { return };
            let mut buf = [0u8; 2048];
            let _ = stream.read(&mut buf);
            let answer = format!("HTTP/1.1 302 Found\r\nLocation: http://{target_addr}/admin\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            let _ = stream.write_all(answer.as_bytes());
        });
        let client = build_public_only_client("system", 2, 5).unwrap();
        let err = client.get(format!("http://{origin_addr}/")).send().await.unwrap_err();
        assert!(err.is_redirect(), "{err}");
        std::thread::sleep(Duration::from_millis(100));
        assert!(target.accept().is_err(), "la cible de la redirection a été contactée");
    }
}
