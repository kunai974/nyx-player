//! Coffre des identifiants IPTV sur ordinateur (Gestionnaire d'identifiants Windows, trousseau
//! macOS, Secret Service Linux) : seule porte de la page vers le coffre du système.
//!
//! Avant, la page appelait le plugin keyring (`keyring:default`) avec un couple (service, compte)
//! de son choix. Sous Windows, keyring forme la cible `"{compte}.{service}"` : en coupant un nom
//! autour d'un point (`compte = "git:https://github"`, `service = "com"`), la page pouvait lire,
//! remplacer ou effacer l'identifiant d'un autre logiciel. Ici le service est fixé côté Rust et le
//! compte n'accepte que les noms de Nyx : `iptv_credentials` ou `iptv_credentials_<uuid>`.
//!
//! Mêmes service, compte et bibliothèque qu'en 0.7.6 : les identifiants déjà enregistrés sont
//! retrouvés tels quels (même cible Windows).

use std::sync::OnceLock;

use regex::Regex;

/// Service du coffre. La version d'audit Windows (option Cargo « audit ») a le sien, pour ne jamais
/// lire ni réécrire les identifiants de l'app installée (comme `VITE_AUDIT` côté page avant).
#[cfg_attr(mobile, allow(dead_code))]
pub const VAULT_SERVICE: &str = if cfg!(feature = "audit") { "nyxplayer-audit" } else { "nyxplayer" };

/// Accepte seulement les comptes de Nyx : `iptv_credentials` (aucun utilisateur connecté),
/// `iptv_credentials_<uuid>` (identifiant Supabase en minuscules, forme 8-4-4-4-12), ou l'entrée
/// d'une source `iptv_source_<espace>_<uuid de la source>`, l'espace étant l'uuid d'un compte
/// Supabase ou d'un invité (même forme). Rien d'autre : ni point, ni majuscule, ni chemin.
#[cfg_attr(mobile, allow(dead_code))]
pub fn validate_vault_user(user: &str) -> Result<(), String> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        const UUID: &str = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
        Regex::new(&format!(
            r"^(?:iptv_credentials(?:_{UUID})?|iptv_source_{UUID}_{UUID})$"
        ))
        .unwrap()
    });
    if !re.is_match(user) {
        return Err("Compte du coffre refusé".to_string());
    }
    Ok(())
}

#[cfg(desktop)]
fn entry(user: &str) -> Result<keyring::Entry, String> {
    validate_vault_user(user)?;
    keyring::Entry::new(VAULT_SERVICE, user).map_err(|e| e.to_string())
}

/// Lit l'entrée ; `None` si elle est absente ou illisible (comme le plugin keyring en 0.7.6).
#[tauri::command]
pub async fn nyx_secret_get(user: String) -> Result<Option<String>, String> {
    #[cfg(desktop)]
    {
        Ok(entry(&user)?.get_password().ok())
    }
    #[cfg(mobile)]
    {
        let _ = user;
        Err("Coffre du système indisponible sur mobile".to_string())
    }
}

#[tauri::command]
pub async fn nyx_secret_set(user: String, value: String) -> Result<(), String> {
    #[cfg(desktop)]
    {
        entry(&user)?.set_password(&value).map_err(|e| e.to_string())
    }
    #[cfg(mobile)]
    {
        let _ = (user, value);
        Err("Coffre du système indisponible sur mobile".to_string())
    }
}

/// Entrée déjà absente : rien à effacer, ce n'est pas un échec (une source supprimée efface sa
/// ligne seulement si l'entrée est partie) ; une vraie panne du coffre remonte.
/// Bureau seulement : la crate keyring n'est pas une dépendance d'Android ni d'iOS (Cargo.toml).
#[cfg(desktop)]
fn deletion_outcome(result: keyring::Result<()>) -> Result<(), String> {
    match result {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub async fn nyx_secret_delete(user: String) -> Result<(), String> {
    #[cfg(desktop)]
    {
        deletion_outcome(entry(&user)?.delete_credential())
    }
    #[cfg(mobile)]
    {
        let _ = user;
        Err("Coffre du système indisponible sur mobile".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const UID: &str = "0f8b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d";

    #[test]
    fn accepts_nyx_accounts() {
        assert!(validate_vault_user("iptv_credentials").is_ok());
        assert!(validate_vault_user(&format!("iptv_credentials_{UID}")).is_ok());
    }

    #[test]
    fn rejects_accounts_of_other_programs() {
        // Découpage autour d'un point qui visait la cible d'un autre logiciel sous Windows
        for user in [
            "git:https://github",
            "git:https://github.com",
            "",
            "iptv_credentials_",
            "iptv_credentials.nyxplayer",
            "iptv_credentials_0F8B1C2D-3E4F-4A5B-8C6D-7E8F9A0B1C2D",
            &format!("iptv_credentials_{UID}.x"),
            &format!("iptv_credentials_{UID}\n"),
            &format!("x_iptv_credentials_{UID}"),
            "iptv_credentials_------------------------------------",
        ] {
            assert!(validate_vault_user(user).is_err(), "accepté à tort : {user:?}");
        }
    }

    const SOURCE: &str = "6a1e5c3b-9d2f-4e7a-b8c1-0d2e4f6a8b9c";

    #[test]
    fn accepts_source_entries_of_a_space() {
        // Compte ou invité : même forme d'identifiant d'espace (services/localSpace.ts)
        assert!(validate_vault_user(&format!("iptv_source_{UID}_{SOURCE}")).is_ok());
    }

    #[test]
    fn rejects_malformed_source_entries() {
        for user in [
            format!("iptv_source_{UID}"),
            format!("iptv_source_{UID}_"),
            format!("iptv_source__{SOURCE}"),
            format!("iptv_source_{UID}_{SOURCE}.nyxplayer"),
            format!("iptv_source_{UID}_{SOURCE}\n"),
            format!("iptv_source_{UID}_{}", SOURCE.to_uppercase()),
            format!("iptv_source_guest_{UID}_{SOURCE}"),
            format!("iptv_source_guest-{UID}_{SOURCE}"),
            format!("iptv_source_guest-{UID}-x_{SOURCE}"),
            format!("iptv_source_{UID}_{SOURCE}_{SOURCE}"),
            format!("iptv_credentials_{UID}_{SOURCE}"),
            format!("x_iptv_source_{UID}_{SOURCE}"),
            format!("iptv_source_../{UID}_{SOURCE}"),
        ] {
            assert!(validate_vault_user(&user).is_err(), "accepté à tort : {user:?}");
        }
    }

    #[cfg(desktop)]
    #[test]
    fn deleting_a_missing_entry_succeeds_but_a_vault_failure_is_reported() {
        assert_eq!(deletion_outcome(Ok(())), Ok(()));
        assert_eq!(deletion_outcome(Err(keyring::Error::NoEntry)), Ok(()));
        assert!(deletion_outcome(Err(keyring::Error::PlatformFailure("coffre verrouillé".into()))).is_err());
        assert!(deletion_outcome(Err(keyring::Error::NoStorageAccess("refusé".into()))).is_err());
    }

    #[test]
    fn service_is_the_one_of_0_7_6() {
        // Identifiants déjà enregistrés par la version publiée : cible Windows « iptv_credentials_<uid>.nyxplayer »
        if cfg!(feature = "audit") {
            assert_eq!(VAULT_SERVICE, "nyxplayer-audit");
        } else {
            assert_eq!(VAULT_SERVICE, "nyxplayer");
        }
    }
}
