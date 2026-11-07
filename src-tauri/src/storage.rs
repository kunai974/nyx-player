use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use regex::Regex;
use tauri::Manager;

/// Returns the app data directory path for IPTV data storage.
pub fn get_data_dir(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .expect("Failed to get app data dir")
}

/// Valide que db_name est un nom de fichier SQLite légitime (anti-path-traversal).
/// Format attendu : `nyxplayer_{uuid}.db`, uuid en minuscules sous sa forme 8-4-4-4-12
/// (identifiant Supabase) : 36 tirets ou un autre découpage sont refusés.
pub fn validate_db_name(db_name: &str) -> Result<(), String> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"^nyxplayer_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.db$").unwrap());
    if !re.is_match(db_name) {
        return Err(format!("Invalid database name rejected: {}", db_name));
    }
    Ok(())
}

/// Valide le nom du fichier catalogue d'une source : `nyxcat_<espace>_<source>.db`, l'espace et la
/// source étant deux uuid en minuscules (forme 8-4-4-4-12). Rien d'autre : ni chemin, ni majuscule.
pub fn validate_source_catalog_name(db_name: &str) -> Result<(), String> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        const UUID: &str = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
        Regex::new(&format!(r"^nyxcat_{UUID}_{UUID}\.db$")).unwrap()
    });
    if !re.is_match(db_name) {
        return Err(format!("Invalid database name rejected: {}", db_name));
    }
    Ok(())
}

/// Valide le nom de l'index commun aux sources d'un espace : `nyxidx_<espace>.db`, l'espace étant
/// un uuid en minuscules (forme 8-4-4-4-12). Les commandes du catalogue ne l'acceptent pas : il ne
/// s'écrit que par sa propre construction.
pub fn validate_index_db_name(db_name: &str) -> Result<(), String> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r"^nyxidx_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.db$").unwrap()
    });
    if !re.is_match(db_name) {
        // Sans le nom refusé : il peut porter l'identifiant du compte
        return Err("Invalid index name rejected".to_string());
    }
    Ok(())
}

/// Suffixe du fichier provisoire d'une construction de l'index commun (fusion_index.rs)
pub const INDEX_BUILD_TMP_SUFFIX: &str = ".build-tmp";

/// Fichiers où les commandes du catalogue (chargement, actualisation, guide, catalogue compact)
/// peuvent lire et écrire : la base du compte, qui porte encore le catalogue de l'unique source,
/// ou le fichier catalogue d'une source.
pub fn validate_catalog_db_name(db_name: &str) -> Result<(), String> {
    if validate_source_catalog_name(db_name).is_ok() {
        return Ok(());
    }
    validate_db_name(db_name)
}

/// Chemin du fichier catalogue demandé. Refusé si c'est le fichier d'une source dont la
/// suppression est en attente : une actualisation lancée juste avant ne le recrée pas.
pub fn catalog_db_path(dir: &Path, db_name: &str) -> Result<PathBuf, String> {
    validate_catalog_db_name(db_name)?;
    let path = dir.join(db_name);
    if catalog_deletion_pending(&path) {
        return Err(SOURCE_CATALOG_DELETED.to_string());
    }
    Ok(path)
}

/// Suffixe du fichier provisoire d'une recopie du catalogue (catalog_split.rs) : il ne vit que le
/// temps de la recopie, et un reste d'app tuée est effacé avec la source ou au lancement suivant.
pub const COPY_TMP_SUFFIX: &str = ".copy-tmp";

/// Efface le fichier provisoire d'une recopie restée en plan pour ce catalogue, et son journal (il
/// est écrit en journal classique : jamais de fichier WAL à côté).
fn remove_copy_leftovers(dir: &Path, db_name: &str) {
    let tmp = format!("{db_name}{COPY_TMP_SUFFIX}");
    for file in [tmp.clone(), format!("{tmp}-journal")] {
        let path = dir.join(file);
        if path.exists() && fs::remove_file(&path).is_err() {
            log::warn!("[Storage] Reste d'une recopie du catalogue encore tenu : nouvel essai au prochain lancement");
        }
    }
}

/// Efface le fichier provisoire d'une construction de l'index commun restée en plan, et son journal
pub fn remove_index_build_leftovers(dir: &Path, index_db_name: &str) {
    let tmp = format!("{index_db_name}{INDEX_BUILD_TMP_SUFFIX}");
    for file in [tmp.clone(), format!("{tmp}-journal")] {
        let path = dir.join(file);
        if path.exists() && fs::remove_file(&path).is_err() {
            log::warn!("[Storage] Reste d'une construction de l'index encore tenu : nouvel essai au prochain lancement");
        }
    }
}

/// Erreur rendue par une commande du catalogue sur le fichier d'une source supprimée
pub const SOURCE_CATALOG_DELETED: &str = "Source catalogue deleted";

/// Le fichier est le catalogue d'une source dont la suppression est demandée : à revérifier juste
/// avant d'ouvrir le fichier en écriture (l'ouverture le recréerait).
pub fn catalog_deletion_pending(db_path: &Path) -> bool {
    let Some(name) = db_path.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    validate_source_catalog_name(name).is_ok() && db_path.with_file_name(format!("{name}.delete-pending")).exists()
}

/// Masque les chemins filesystem dans les messages d'erreur IPC.
/// Remplace `C:\Users\xxx\AppData\...\` par `[…]/` pour éviter de fuiter
/// le nom d'utilisateur Windows dans les erreurs retournées au frontend.
pub fn sanitize_error_path(msg: String) -> String {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        // Match Windows paths (C:\...\) et Unix paths (/home/.../...)
        Regex::new(r"[A-Za-z]:\\(?:[^\s\\]+\\)+|/(?:[^\s/]+/){2,}").unwrap()
    });
    re.replace_all(&msg, "[…]/").to_string()
}

/// Masque les credentials Xtream dans les URLs pour le logging Rust.
/// Miroir de `sanitizeIptvUrl()` du frontend TypeScript.
/// Couvre : `?username=X&password=Y` (aussi encodé : `%3Fusername%3DX%26password%3DY`), les jetons
/// d'une adresse tierce (guide EPG, flux HLS : `token`, `key`, `apikey`, `auth`, `pass`, `pwd`,
/// `signature`), `/{live|movie|series|timeshift|hls|play}/USER/PASS/…` quelle que soit la casse (aussi encodé : `%2Flive%2F…`), la forme courte
/// `host:port/USER/PASS/123` et sa variante sans port (seule dans son adresse ; un premier segment
/// fait d'un seul chiffre est épargné : `/3/movie/550` reste lisible), `USER:PASS@host`, `USER@host` et `"password":"…"`
/// (JSON), y compris la forme sans port, en majuscules ou encodée.
pub fn sanitize_url_for_log(url: &str) -> String {
    static RE_QUERY: OnceLock<Regex> = OnceLock::new();
    static RE_QUERY_ENCODED: OnceLock<Regex> = OnceLock::new();
    static RE_PATH: OnceLock<Regex> = OnceLock::new();
    static RE_PATH_ENCODED: OnceLock<Regex> = OnceLock::new();
    static RE_SHORT: OnceLock<Regex> = OnceLock::new();
    static RE_SHORT_NO_PORT: OnceLock<Regex> = OnceLock::new();
    static RE_USERINFO: OnceLock<Regex> = OnceLock::new();
    static RE_USER_ONLY: OnceLock<Regex> = OnceLock::new();
    static RE_JSON: OnceLock<Regex> = OnceLock::new();
    let re_query = RE_QUERY.get_or_init(|| {
        Regex::new(r#"(?i)([?&])(username|password|token|key|apikey|auth|pass|pwd|signature)=[^&\s"'#]*"#).unwrap()
    });
    // Valeur encodée : tout jusqu'au `%26` (« & ») suivant, les autres caractères encodés compris
    let re_query_encoded = RE_QUERY_ENCODED.get_or_init(|| {
        Regex::new(r#"(?i)(%3F|%26|^|[^A-Za-z0-9_%])((?:username|password|token|key|apikey|auth|pass|pwd|signature)%3D)(?:[^&\s"'#%]|%(?:[013-9A-F][0-9A-F]|2[0-57-9A-F]))*"#).unwrap()
    });
    let re_path = RE_PATH.get_or_init(|| {
        Regex::new(r"(?i)/(live|movie|series|timeshift|hls|play)/[^/\s]+/[^/\s]+/").unwrap()
    });
    // Même chemin encodé (`%2F` = « / ») : adresse de flux placée dans une autre adresse
    let re_path_encoded = RE_PATH_ENCODED.get_or_init(|| {
        Regex::new(r"(?i)(%2F(?:live|movie|series|timeshift|hls|play)%2F)(?:[^%/\s&]|%(?:[013-9A-F][0-9A-F]|2[0-9A-E]))+%2F(?:[^%/\s&]|%(?:[013-9A-F][0-9A-F]|2[0-9A-E]))+%2F").unwrap()
    });
    let re_short = RE_SHORT.get_or_init(|| {
        Regex::new(r"(://[^/\s:@]+:\d+)/[^/\s?#]+/[^/\s?#]+/(\d+(?:\.[A-Za-z0-9]{1,8})?)\b").unwrap()
    });
    let re_short_no_port = RE_SHORT_NO_PORT.get_or_init(|| {
        Regex::new(r#"(://[^/\s:@]+)/(?:[^/\s?#\d][^/\s?#]*|\d[^/\s?#]+)/[^/\s?#]+/(\d+(?:\.[A-Za-z0-9]{1,8})?)(\.?(?:$|[^A-Za-z0-9_.~%/-])|/(?:$|\s))"#).unwrap()
    });
    let re_userinfo = RE_USERINFO.get_or_init(|| {
        Regex::new(r"(://)[^/\s:@]+:[^/\s@]+@").unwrap()
    });
    let re_user_only = RE_USER_ONLY.get_or_init(|| Regex::new(r"(://)[^/\s:@]+@").unwrap());
    let re_json = RE_JSON.get_or_init(|| {
        Regex::new(r#"(?i)("(?:username|password)"\s*:\s*")(?:[^"\\]|\\.)*""#).unwrap()
    });
    let result = re_path.replace_all(url, "/$1/***/***/");
    let result = re_path_encoded.replace_all(&result, "${1}***%2F***%2F");
    let result = re_short.replace_all(&result, "$1/***/***/$2");
    let result = re_short_no_port.replace_all(&result, "$1/***/***/$2$3");
    let result = re_userinfo.replace_all(&result, "$1***:***@");
    let result = re_user_only.replace_all(&result, "$1***@");
    let result = re_query.replace_all(&result, "$1$2=***");
    let result = re_query_encoded.replace_all(&result, "$1$2***");
    re_json.replace_all(&result, "$1***\"").to_string()
}

/// Marque laissée quand la réinitialisation n'a pas pu supprimer la base (fichier tenu par un autre
/// programme sous Windows) : la suppression est terminée au chargement suivant de cette base.
fn pending_delete_marker(dir: &Path, db_name: &str) -> PathBuf {
    dir.join(format!("{}.delete-pending", db_name))
}

/// Fichiers SQLite d'une base : la base, son journal WAL et sa mémoire partagée.
fn database_files(db_name: &str) -> [String; 3] {
    [db_name.to_string(), format!("{}-wal", db_name), format!("{}-shm", db_name)]
}

/// Termine une réinitialisation restée à moitié : appelé au chargement de la base par la
/// page, avant toute ouverture. Sans marque, ne fait rien. Un seul essai : la marque est retirée même
/// si un fichier résiste encore, sinon elle effacerait au lancement suivant la base remplie entre-temps
/// (reprises pas encore envoyées, effacement du cloud en attente).
pub fn finish_pending_reset(dir: &Path, db_name: &str) {
    if validate_db_name(db_name).is_err() {
        return;
    }
    let marker = pending_delete_marker(dir, db_name);
    if !marker.exists() {
        return;
    }
    let mut all_removed = true;
    for file in database_files(db_name) {
        let path = dir.join(&file);
        if path.exists() && fs::remove_file(&path).is_err() {
            all_removed = false;
        }
    }
    let _ = fs::remove_file(&marker);
    if all_removed {
        log::info!("[Full Reset] Suppression de la base terminée au lancement");
    } else {
        log::warn!("[Full Reset] Base toujours tenue au lancement : elle est gardée telle quelle");
    }
}

/// Supprime une base (fichier, journal WAL, mémoire partagée), trois essais par fichier à 200 ms
/// d'écart (poignée Windows relâchée avec un peu de retard). Un fichier qui résiste : la marque de
/// suppression en attente est écrite, et l'erreur remonte.
async fn remove_database_files(data_dir: &Path, db_name: &str) -> Result<(), String> {
    // Journal : la sorte de fichier seulement, jamais son nom (il porte l'identifiant du compte)
    for (file, kind) in database_files(db_name).iter().zip(["base", "journal WAL", "mémoire partagée"]) {
        let path = data_dir.join(file);
        if !path.exists() {
            continue;
        }
        for attempt in 1..=3 {
            match fs::remove_file(&path) {
                Ok(_) => {
                    log::info!("[Storage] Supprimé : {}", kind);
                    break;
                }
                Err(e) if attempt < 3 => {
                    log::warn!("[Storage] Essai {}/3 pour {} ({})", attempt, kind, e.kind());
                    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                }
                Err(e) => {
                    if let Err(marker_err) = fs::write(pending_delete_marker(data_dir, db_name), b"") {
                        log::warn!("[Storage] Marque de suppression non écrite : {}", sanitize_error_path(marker_err.to_string()));
                    }
                    return Err(sanitize_error_path(format!("Failed to delete {} after 3 attempts: {}", file, e)));
                }
            }
        }
    }
    Ok(())
}

/// Fichiers catalogue des sources d'un espace (`nyxcat_<espace>_*.db`) présents dans le dossier,
/// pour la base de compte `nyxplayer_<espace>.db`. Seuls les noms exacts sont retenus.
fn source_catalogs_of_space(dir: &Path, account_db_name: &str) -> Vec<String> {
    let Some(space) = account_db_name.strip_prefix("nyxplayer_").and_then(|r| r.strip_suffix(".db")) else {
        return Vec::new();
    };
    if validate_db_name(account_db_name).is_err() {
        return Vec::new();
    }
    let prefix = format!("nyxcat_{}_", space);
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    // Un catalogue dont seule une recopie en cours (ou restée en plan) existe compte aussi
    let mut names: Vec<String> = entries
        .flatten()
        .filter_map(|e| e.file_name().into_string().ok())
        .map(|n| n.strip_suffix(COPY_TMP_SUFFIX).map(str::to_string).unwrap_or(n))
        .filter(|n| n.starts_with(&prefix) && validate_source_catalog_name(n).is_ok())
        .collect();
    names.sort();
    names.dedup();
    names
}

/// Termine au lancement les suppressions de fichiers catalogue restées en attente (fichier tenu
/// sous Windows). Contrairement à la base du compte, la marque reste tant qu'un fichier résiste :
/// le fichier d'une source supprimée ne se remplit plus (les commandes du catalogue le refusent).
pub fn sweep_pending_catalog_deletions(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(name) = entry.file_name().into_string() else { continue };
        // Recopie du catalogue tuée en route : au lancement, aucune recopie ne tourne encore
        let copy_of = name.strip_suffix("-journal").unwrap_or(&name).strip_suffix(COPY_TMP_SUFFIX);
        if let Some(db_name) = copy_of {
            if validate_source_catalog_name(db_name).is_ok() {
                remove_copy_leftovers(dir, db_name);
            }
            continue;
        }
        // Construction de l'index commun tuée en route : même chose
        let build_of = name.strip_suffix("-journal").unwrap_or(&name).strip_suffix(INDEX_BUILD_TMP_SUFFIX);
        if let Some(db_name) = build_of {
            if validate_index_db_name(db_name).is_ok() {
                remove_index_build_leftovers(dir, db_name);
            }
            continue;
        }
        let Some(db_name) = name.strip_suffix(".delete-pending") else { continue };
        if validate_source_catalog_name(db_name).is_err() && validate_index_db_name(db_name).is_err() {
            continue;
        }
        let mut all_removed = true;
        for file in database_files(db_name) {
            let path = dir.join(&file);
            if path.exists() && fs::remove_file(&path).is_err() {
                all_removed = false;
            }
        }
        if all_removed {
            let _ = fs::remove_file(entry.path());
            log::info!("[Storage] Catalogue d'une source supprimée effacé au lancement");
        } else {
            log::warn!("[Storage] Catalogue d'une source supprimée encore tenu : nouvel essai au prochain lancement");
        }
    }
}

/// Supprime le fichier catalogue d'une source (`nyxcat_<espace>_<source>.db`) : la page referme
/// d'abord sa connexion à ce fichier, s'il en a une. Un fichier tenu est effacé au lancement suivant,
/// et ne peut plus être rempli d'ici là.
#[tauri::command]
pub async fn delete_source_catalog(
    app: tauri::AppHandle,
    databases: tauri::State<'_, crate::secure_db::NyxDatabases>,
    db_name: String,
) -> Result<(), String> {
    validate_source_catalog_name(&db_name)?;
    let data_dir = get_data_dir(&app);
    mark_catalog_deleted(&data_dir, &db_name)?;
    // Les écritures lourdes en cours (chargement, guide) finissent d'abord. L'actualisation de fond,
    // elle, ne s'arrête qu'entre deux lots : un fichier qu'elle tient encore sous Windows est effacé
    // au lancement suivant ; ailleurs, ses dernières écritures vont dans un fichier déjà effacé.
    let _heavy = crate::db_activity::HeavyWriteGuard::new();
    let _turn = crate::db_activity::exclusive_write().await;
    databases.forget(&db_name).await;
    remove_copy_leftovers(&data_dir, &db_name);
    // Message fixe rendu à la page : celui de l'échec cite le nom du fichier (identifiant du compte)
    remove_database_files(&data_dir, &db_name)
        .await
        .map_err(|_| "Source catalogue still held: deleted at next launch".to_string())
}

/// Marque posée avant d'effacer le catalogue d'une source, et gardée jusqu'au balayage du lancement
/// suivant : une écriture qui attendait son tour (chargement, guide, actualisation) la voit et ne
/// recrée pas le fichier.
fn mark_catalog_deleted(data_dir: &Path, db_name: &str) -> Result<(), String> {
    fs::write(pending_delete_marker(data_dir, db_name), b"")
        .map_err(|e| sanitize_error_path(format!("Failed to mark a source catalogue for deletion: {}", e)))
}

/// Efface les catalogues des sources d'un espace, comme une source supprimée : marque gardée
/// jusqu'au lancement suivant, connexions de la page fermées, écritures lourdes finies d'abord. Un
/// fichier tenu est effacé au lancement suivant, sans bloquer la réinitialisation.
async fn delete_space_catalogs(data_dir: &Path, databases: &crate::secure_db::NyxDatabases, account_db_name: &str) {
    // Aucune construction de l'index ne démarre tant que l'espace s'efface
    let _builds = crate::fusion_index::hold_builds().await;
    delete_space_index(data_dir, databases, account_db_name).await;
    let catalogs = source_catalogs_of_space(data_dir, account_db_name);
    if catalogs.is_empty() {
        return;
    }
    for catalog in &catalogs {
        if let Err(e) = mark_catalog_deleted(data_dir, catalog) {
            log::warn!("[Full Reset] {}", e);
        }
    }
    let _heavy = crate::db_activity::HeavyWriteGuard::new();
    let _turn = crate::db_activity::exclusive_write().await;
    for catalog in &catalogs {
        databases.forget(catalog).await;
        remove_copy_leftovers(data_dir, catalog);
        if let Err(e) = remove_database_files(data_dir, catalog).await {
            // Texte fixe : l'erreur cite le nom du fichier, qui porte l'identifiant du compte
            let _ = e;
            log::warn!("[Full Reset] Catalogue d'une source gardé jusqu'au prochain lancement");
        }
    }
}

/// Nom de l'index commun de l'espace d'une base de compte (`nyxplayer_<espace>.db`)
fn index_of_space(account_db_name: &str) -> Option<String> {
    validate_db_name(account_db_name).ok()?;
    let space = account_db_name.strip_prefix("nyxplayer_")?.strip_suffix(".db")?;
    Some(format!("nyxidx_{space}.db"))
}

/// Efface l'index commun d'un espace (données dérivées des catalogues), constructions bloquées par
/// l'appelant. Un fichier tenu est effacé au lancement suivant.
async fn delete_space_index(data_dir: &Path, databases: &crate::secure_db::NyxDatabases, account_db_name: &str) {
    let Some(index) = index_of_space(account_db_name) else { return };
    databases.forget(&index).await;
    remove_index_build_leftovers(data_dir, &index);
    if remove_database_files(data_dir, &index).await.is_err() {
        // Texte fixe : l'erreur cite le nom du fichier, qui porte l'identifiant du compte
        log::warn!("[Full Reset] Index commun gardé jusqu'au prochain lancement");
    }
}

/// Supprime physiquement tous les fichiers de données (SQLite + legacy JSON).
/// Le frontend doit d'abord fermer la connexion SQLite (closeDatabaseConnection),
/// nettoyer localStorage/keychain/Cache API, puis appeler cette commande.
/// Après retour, le frontend relance l'app via tauri-plugin-process.
///
/// Commande asynchrone : une commande synchrone tourne sur le fil principal, et les
/// attentes entre deux essais de suppression y figeaient l'écran.
#[tauri::command]
pub async fn full_reset(
    app: tauri::AppHandle,
    databases: tauri::State<'_, crate::secure_db::NyxDatabases>,
    db_name: String,
) -> Result<(), String> {
    validate_db_name(&db_name)?;
    let data_dir = get_data_dir(&app);

    // Supprimer les fichiers SQLite (DB + WAL + SHM). WebView2 ou la connexion de la page peut
    // encore tenir le fichier un instant après closeDatabaseConnection() côté page : trois essais.
    // Un fichier qui résiste : base gardée alors que le coffre et les réglages sont vidés, sa
    // suppression est notée pour le prochain chargement de la base.
    let account = remove_database_files(&data_dir, &db_name).await;

    // Catalogues des sources de cet espace : effacés avec lui, même si la base du compte résiste
    delete_space_catalogs(&data_dir, &databases, &db_name).await;
    account?;

    // Copies des listes M3U ouvertes depuis un fichier de l'appareil : rien ne reste après la remise à zéro
    crate::m3u_local_file::remove_all(&data_dir);

    // Supprimer le fichier legacy
    let legacy = data_dir.join("iptv_data.json");
    if legacy.exists() {
        fs::remove_file(&legacy).map_err(|e| sanitize_error_path(format!("Failed to delete iptv_data.json: {}", e)))?;
        log::info!("[Full Reset] Deleted: iptv_data.json");
    }

    log::info!("[Full Reset] All data files removed");
    Ok(())
}

// =============================================================================
// TESTS
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_db_name_accepted() {
        assert!(validate_db_name("nyxplayer_550e8400-e29b-41d4-a716-446655440000.db").is_ok());
    }

    #[test]
    fn valid_db_name_lowercase_hex() {
        assert!(validate_db_name("nyxplayer_abcdef01-2345-6789-abcd-ef0123456789.db").is_ok());
    }

    #[test]
    fn path_traversal_rejected() {
        assert!(validate_db_name("../../Windows/system32.dll").is_err());
    }

    #[test]
    fn dotdot_in_name_rejected() {
        assert!(validate_db_name("nyxplayer_../../../etc.db").is_err());
    }

    #[test]
    fn empty_name_rejected() {
        assert!(validate_db_name("").is_err());
    }

    #[test]
    fn uppercase_uuid_rejected() {
        assert!(validate_db_name("nyxplayer_550E8400-E29B-41D4-A716-446655440000.db").is_err());
    }

    #[test]
    fn wrong_prefix_rejected() {
        assert!(validate_db_name("malicious_550e8400-e29b-41d4-a716-446655440000.db").is_err());
    }

    #[test]
    fn no_extension_rejected() {
        assert!(validate_db_name("nyxplayer_550e8400-e29b-41d4-a716-446655440000").is_err());
    }

    #[test]
    fn slash_in_name_rejected() {
        assert!(validate_db_name("nyxplayer_abc/def01-2345-6789-abcd-ef0123456789.db").is_err());
    }

    #[test]
    fn name_not_shaped_like_a_uuid_rejected() {
        assert!(validate_db_name("nyxplayer_------------------------------------.db").is_err());
        assert!(validate_db_name("nyxplayer_550e8400e29b-41d4-a716-446655440000-.db").is_err());
        assert!(validate_db_name("nyxplayer_550e8400-e29b-41d4-a716-446655440000\n.db").is_err());
    }

    #[test]
    fn backslash_in_name_rejected() {
        assert!(validate_db_name("nyxplayer_abc\\def01-2345-6789-abcd-ef012345678.db").is_err());
    }

    // ===== fichiers catalogue des sources =====

    const SPACE: &str = "550e8400-e29b-41d4-a716-446655440000";
    const SOURCE: &str = "6a1e5c3b-9d2f-4e7a-b8c1-0d2e4f6a8b9c";

    fn catalog_name() -> String {
        format!("nyxcat_{SPACE}_{SOURCE}.db")
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nyx-storage-{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn source_catalogue_name_accepted() {
        assert!(validate_source_catalog_name(&catalog_name()).is_ok());
        // Les commandes du catalogue prennent la base du compte (catalogue actuel) ou celui d'une source
        assert!(validate_catalog_db_name(&catalog_name()).is_ok());
        assert!(validate_catalog_db_name(&format!("nyxplayer_{SPACE}.db")).is_ok());
        // La base du compte reste seule acceptée là où un catalogue n'a rien à faire (réinitialisation)
        assert!(validate_db_name(&catalog_name()).is_err());
        assert!(validate_source_catalog_name(&format!("nyxplayer_{SPACE}.db")).is_err());
    }

    #[test]
    fn malformed_source_catalogue_names_rejected() {
        for name in [
            format!("nyxcat_{SPACE}.db"),
            format!("nyxcat_{SPACE}_.db"),
            format!("nyxcat__{SOURCE}.db"),
            format!("nyxcat_{SPACE}_{SOURCE}"),
            format!("nyxcat_{SPACE}_{SOURCE}.db-wal"),
            format!("nyxcat_{SPACE}_{SOURCE}.db\n"),
            format!("nyxcat_{SPACE}_{SOURCE}_{SOURCE}.db"),
            format!("nyxcat_{SPACE}_{}.db", SOURCE.to_uppercase()),
            format!("nyxcat_guest-{SPACE}_{SOURCE}.db"),
            format!("nyxcat_../{SPACE}_{SOURCE}.db"),
            format!("dir/nyxcat_{SPACE}_{SOURCE}.db"),
            format!("x_nyxcat_{SPACE}_{SOURCE}.db"),
            format!("nyxidx_{SPACE}.db"),
            "nyxcat_------------------------------------_------------------------------------.db".to_string(),
        ] {
            assert!(validate_catalog_db_name(&name).is_err(), "accepté à tort : {name:?}");
        }
    }

    #[test]
    fn a_source_catalogue_being_deleted_is_never_reopened() {
        let dir = temp_dir("pending");
        let name = catalog_name();
        assert_eq!(catalog_db_path(&dir, &name).unwrap(), dir.join(&name));
        fs::write(pending_delete_marker(&dir, &name), b"").unwrap();
        assert!(catalog_deletion_pending(&dir.join(&name)));
        assert_eq!(catalog_db_path(&dir, &name).unwrap_err(), SOURCE_CATALOG_DELETED);
        // La base du compte garde sa règle à elle (suppression finie à son chargement)
        let account = format!("nyxplayer_{SPACE}.db");
        fs::write(pending_delete_marker(&dir, &account), b"").unwrap();
        assert!(catalog_db_path(&dir, &account).is_ok());
        assert!(!catalog_deletion_pending(&dir.join(&account)));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_catalogues_of_a_space_are_found_exactly() {
        let dir = temp_dir("space");
        let other_space = "0f8b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d";
        let second = "1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d";
        for file in [
            catalog_name(),
            format!("nyxcat_{SPACE}_{second}.db"),
            format!("nyxcat_{SPACE}_{SOURCE}.db-wal"),
            format!("nyxcat_{other_space}_{SOURCE}.db"),
            format!("nyxcat_{SPACE}_pas-un-uuid.db"),
            format!("nyxplayer_{SPACE}.db"),
        ] {
            fs::write(dir.join(file), b"").unwrap();
        }
        let mut expected = vec![catalog_name(), format!("nyxcat_{SPACE}_{second}.db")];
        expected.sort();
        assert_eq!(source_catalogs_of_space(&dir, &format!("nyxplayer_{SPACE}.db")), expected);
        assert!(source_catalogs_of_space(&dir, "../x.db").is_empty());
        assert!(source_catalogs_of_space(&dir, &catalog_name()).is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn removing_a_database_takes_its_journal_files_too() {
        let dir = temp_dir("remove");
        let name = catalog_name();
        for file in database_files(&name) {
            fs::write(dir.join(file), b"x").unwrap();
        }
        fs::write(dir.join(format!("nyxcat_{SPACE}_1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d.db")), b"x").unwrap();
        remove_database_files(&dir, &name).await.unwrap();
        for file in database_files(&name) {
            assert!(!dir.join(file).exists());
        }
        // L'autre source n'est pas touchée, et un fichier déjà absent n'est pas une erreur
        assert!(dir.join(format!("nyxcat_{SPACE}_1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d.db")).exists());
        remove_database_files(&dir, &name).await.unwrap();
        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_reset_deletes_the_catalogues_of_its_space_and_keeps_them_from_coming_back() {
        let dir = temp_dir("reset");
        let other_space = "0f8b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d";
        let mine = catalog_name();
        let theirs = format!("nyxcat_{other_space}_{SOURCE}.db");
        for file in database_files(&mine).iter().chain([&theirs]) {
            fs::write(dir.join(file), b"x").unwrap();
        }
        let databases = crate::secure_db::NyxDatabases::default();
        delete_space_catalogs(&dir, &databases, &format!("nyxplayer_{SPACE}.db")).await;
        for file in database_files(&mine) {
            assert!(!dir.join(file).exists());
        }
        // Une actualisation qui attendait ne recrée pas le fichier : marque gardée jusqu'au lancement
        assert!(catalog_deletion_pending(&dir.join(&mine)));
        assert_eq!(catalog_db_path(&dir, &mine).unwrap_err(), SOURCE_CATALOG_DELETED);
        // L'autre espace n'est pas touché
        assert!(dir.join(&theirs).exists());
        assert!(!catalog_deletion_pending(&dir.join(&theirs)));
        sweep_pending_catalog_deletions(&dir);
        assert!(!catalog_deletion_pending(&dir.join(&mine)));
        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn leftovers_of_a_killed_catalogue_copy_never_stay() {
        let dir = temp_dir("copy-leftovers");
        let name = catalog_name();
        let tmp = format!("{name}{COPY_TMP_SUFFIX}");
        let write_leftovers = || {
            fs::write(dir.join(&tmp), b"x").unwrap();
            fs::write(dir.join(format!("{tmp}-journal")), b"x").unwrap();
        };
        // Au lancement
        write_leftovers();
        fs::write(dir.join("autre.db.copy-tmp"), b"x").unwrap();
        sweep_pending_catalog_deletions(&dir);
        assert!(!dir.join(&tmp).exists());
        assert!(!dir.join(format!("{tmp}-journal")).exists());
        assert!(dir.join("autre.db.copy-tmp").exists());
        // Avec la réinitialisation de l'espace, même quand seul le fichier provisoire existe
        write_leftovers();
        assert_eq!(source_catalogs_of_space(&dir, &format!("nyxplayer_{SPACE}.db")), vec![name.clone()]);
        let databases = crate::secure_db::NyxDatabases::default();
        delete_space_catalogs(&dir, &databases, &format!("nyxplayer_{SPACE}.db")).await;
        assert!(!dir.join(&tmp).exists());
        assert!(!dir.join(format!("{tmp}-journal")).exists());
        assert!(catalog_deletion_pending(&dir.join(&name)));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_launch_sweep_finishes_catalogue_deletions_only() {
        let dir = temp_dir("sweep");
        let name = catalog_name();
        let account = format!("nyxplayer_{SPACE}.db");
        for file in database_files(&name) {
            fs::write(dir.join(file), b"x").unwrap();
        }
        fs::write(dir.join(&account), b"x").unwrap();
        fs::write(pending_delete_marker(&dir, &name), b"").unwrap();
        fs::write(pending_delete_marker(&dir, &account), b"").unwrap();
        // Nom inventé à côté d'une marque : jamais suivi
        fs::write(dir.join("autre.db"), b"x").unwrap();
        fs::write(dir.join("autre.db.delete-pending"), b"").unwrap();
        sweep_pending_catalog_deletions(&dir);
        for file in database_files(&name) {
            assert!(!dir.join(file).exists());
        }
        assert!(!pending_delete_marker(&dir, &name).exists());
        // La base du compte suit sa propre règle (au chargement par la page), pas celle-ci
        assert!(dir.join(&account).exists());
        assert!(pending_delete_marker(&dir, &account).exists());
        assert!(dir.join("autre.db").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn only_the_exact_index_name_is_accepted() {
        assert!(validate_index_db_name(&format!("nyxidx_{SPACE}.db")).is_ok());
        for name in [
            format!("nyxidx_{SPACE}"),
            format!("nyxidx_{SPACE}.db-wal"),
            format!("nyxidx_{SPACE}.db{INDEX_BUILD_TMP_SUFFIX}"),
            format!("nyxidx_{}.db", SPACE.to_uppercase()),
            format!("nyxidx_{SPACE}_{SOURCE}.db"),
            format!("nyxidx_guest-{SPACE}.db"),
            format!("../nyxidx_{SPACE}.db"),
            format!("nyxplayer_{SPACE}.db"),
            catalog_name(),
            "nyxidx_------------------------------------.db".to_string(),
        ] {
            assert!(validate_index_db_name(&name).is_err(), "accepté à tort : {name:?}");
        }
        // Les commandes du catalogue (chargement, guide, actualisation) n'y écrivent jamais
        assert!(validate_catalog_db_name(&format!("nyxidx_{SPACE}.db")).is_err());
    }

    #[tokio::test]
    async fn a_reset_deletes_the_index_of_its_space_only() {
        let dir = temp_dir("reset-index");
        let other_space = "0f8b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d";
        let mine = format!("nyxidx_{SPACE}.db");
        let theirs = format!("nyxidx_{other_space}.db");
        let tmp = format!("{mine}{INDEX_BUILD_TMP_SUFFIX}");
        for file in database_files(&mine).iter().chain([&theirs, &tmp, &format!("{tmp}-journal")]) {
            fs::write(dir.join(file), b"x").unwrap();
        }
        let databases = crate::secure_db::NyxDatabases::default();
        delete_space_catalogs(&dir, &databases, &format!("nyxplayer_{SPACE}.db")).await;
        for file in database_files(&mine).iter().chain([&tmp, &format!("{tmp}-journal")]) {
            assert!(!dir.join(file).exists(), "{file}");
        }
        assert!(dir.join(&theirs).exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_launch_sweep_removes_index_build_leftovers_and_held_indexes() {
        let dir = temp_dir("sweep-index");
        let index = format!("nyxidx_{SPACE}.db");
        let tmp = format!("{index}{INDEX_BUILD_TMP_SUFFIX}");
        fs::write(dir.join(&tmp), b"x").unwrap();
        fs::write(dir.join(format!("{tmp}-journal")), b"x").unwrap();
        fs::write(dir.join("autre.db.build-tmp"), b"x").unwrap();
        // Index tenu pendant une réinitialisation : effacé au lancement suivant
        let held = "nyxidx_0f8b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d.db".to_string();
        fs::write(dir.join(&held), b"x").unwrap();
        fs::write(pending_delete_marker(&dir, &held), b"").unwrap();
        fs::write(dir.join(&index), b"x").unwrap();
        sweep_pending_catalog_deletions(&dir);
        assert!(!dir.join(&tmp).exists());
        assert!(!dir.join(format!("{tmp}-journal")).exists());
        assert!(dir.join("autre.db.build-tmp").exists());
        assert!(!dir.join(&held).exists());
        assert!(!pending_delete_marker(&dir, &held).exists());
        // Un index sans marque reste
        assert!(dir.join(&index).exists());
        let _ = fs::remove_dir_all(&dir);
    }

    // ===== sanitize_error_path =====

    #[test]
    fn sanitize_strips_windows_path() {
        let msg = "Failed to open DB: C:\\Users\\jdupont\\AppData\\Roaming\\com.nyxplayer.app\\nyxplayer_xxx.db".to_string();
        let result = sanitize_error_path(msg);
        assert!(!result.contains("jdupont"), "Username should be stripped");
        assert!(result.contains("nyxplayer_xxx.db"), "Filename should be kept");
        assert!(result.contains("[…]/"), "Path should be replaced with marker");
    }

    #[test]
    fn sanitize_no_path_unchanged() {
        let msg = "Transaction commit failed: database is locked".to_string();
        let result = sanitize_error_path(msg.clone());
        assert_eq!(result, msg);
    }

    #[test]
    fn sanitize_strips_unix_path() {
        let msg = "Failed: /home/user/.local/share/com.nyxplayer.app/test.db".to_string();
        let result = sanitize_error_path(msg);
        assert!(!result.contains("/home/user"), "Unix path should be stripped");
    }

    #[test]
    fn sanitize_multiple_paths() {
        let msg = "Copy C:\\Users\\a\\src.db to C:\\Users\\a\\dst.db failed".to_string();
        let result = sanitize_error_path(msg);
        assert!(!result.contains("Users\\a"), "Both paths should be stripped");
    }

    #[test]
    fn sanitize_preserves_error_context() {
        let msg = "Failed to delete file after 3 attempts: C:\\Users\\test\\AppData\\x.db (os error 32)".to_string();
        let result = sanitize_error_path(msg);
        assert!(result.contains("Failed to delete file"), "Prefix kept");
        assert!(result.contains("os error 32"), "Error code kept");
        assert!(!result.contains("Users\\test"), "Path stripped");
    }

    // ===== sanitize_url_for_log =====

    #[test]
    fn sanitize_url_query_params() {
        let url = "http://provider.com/xmltv.php?username=john&password=secret123";
        let result = sanitize_url_for_log(url);
        assert_eq!(result, "http://provider.com/xmltv.php?username=***&password=***");
    }

    #[test]
    fn sanitize_url_xtream_path() {
        let url = "http://host.com/live/myuser/mypass/12345.ts";
        let result = sanitize_url_for_log(url);
        assert!(result.contains("/live/***/***/"), "Credentials stripped from path");
        assert!(result.contains("12345.ts"), "Stream ID kept");
    }

    #[test]
    fn sanitize_url_no_credentials() {
        let url = "http://epg.provider.com/guide.xml.gz";
        let result = sanitize_url_for_log(url);
        assert_eq!(result, url, "URL without credentials unchanged");
    }

    #[test]
    fn sanitize_url_case_insensitive() {
        let url = "http://host.com/api?Username=admin&Password=123";
        let result = sanitize_url_for_log(url);
        assert!(!result.contains("admin"), "Username stripped (case insensitive)");
        assert!(!result.contains("123"), "Password stripped (case insensitive)");
    }

    #[test]
    fn sanitize_url_timeshift_short_userinfo_and_json_forms() {
        assert_eq!(
            sanitize_url_for_log("http://h.com:8080/timeshift/john/secret/60/2026-09-28:20-00/1.ts"),
            "http://h.com:8080/timeshift/***/***/60/2026-09-28:20-00/1.ts"
        );
        assert_eq!(
            sanitize_url_for_log("http://h.com/john/secret/123.mpegts"),
            "http://h.com/***/***/123.mpegts"
        );
        assert_eq!(
            sanitize_url_for_log("http://h.com:8080/john/secret/123.ts"),
            "http://h.com:8080/***/***/123.ts"
        );
        assert_eq!(
            sanitize_url_for_log("http://john:secret@h.com:8080/get.php"),
            "http://***:***@h.com:8080/get.php"
        );
        assert_eq!(
            sanitize_url_for_log(r#"{"username":"john","password":"secret","auth":1}"#),
            r#"{"username":"***","password":"***","auth":1}"#
        );
        let msg = "a http://h.com/live/u1/p1/1.ts b http://h.com/live/u2/p2/2.ts";
        let out = sanitize_url_for_log(msg);
        assert!(!out.contains("u1") && !out.contains("p2"), "All URLs masked: {out}");
        // Escaped quote inside the value: the whole password is masked, not just its start.
        assert_eq!(
            sanitize_url_for_log(r#"{"password":"ab\"cdSECRET","auth":1}"#),
            r#"{"password":"***","auth":1}"#
        );
        let tmdb = "https://api.themoviedb.org/3/tv/1399/season/1";
        assert_eq!(sanitize_url_for_log(tmdb), tmdb, "TMDB URL unchanged");
    }

    /// Jetons d'une adresse tierce, identifiant sans mot de passe, chemins `/hls/` et `/play/` :
    /// miroir des tests TypeScript.
    #[test]
    fn sanitize_url_tokens_user_only_and_hls_play_forms() {
        assert_eq!(
            sanitize_url_for_log("http://h.example/live/U/P/1.ts?token=X"),
            "http://h.example/live/***/***/1.ts?token=***"
        );
        assert_eq!(
            sanitize_url_for_log("https://epg.example/guide.xml?key=Abc123&lang=fr"),
            "https://epg.example/guide.xml?key=***&lang=fr"
        );
        assert_eq!(
            sanitize_url_for_log("https://epg.example/g.xml?AUTH=a&apikey=b&pass=d&pwd=e&signature=f"),
            "https://epg.example/g.xml?AUTH=***&apikey=***&pass=***&pwd=***&signature=***"
        );
        assert_eq!(
            sanitize_url_for_log("go?u=http%3A%2F%2Fepg.example%2Fg.xml%3Ftoken%3DSecret%26lang%3Dfr"),
            "go?u=http%3A%2F%2Fepg.example%2Fg.xml%3Ftoken%3D***%26lang%3Dfr"
        );
        // Un paramètre dont le nom ne fait que contenir « key » reste lisible
        let plain = "https://h.example/x?monkey=1&sort_key=2";
        assert_eq!(sanitize_url_for_log(plain), plain);
        assert_eq!(
            sanitize_url_for_log("http://John@h.example/get.php"),
            "http://***@h.example/get.php"
        );
        assert_eq!(
            sanitize_url_for_log("http://John:Secret@h.example/x"),
            "http://***:***@h.example/x"
        );
        assert_eq!(
            sanitize_url_for_log("http://h.example/hls/John/Secret/1.m3u8"),
            "http://h.example/hls/***/***/1.m3u8"
        );
        assert_eq!(
            sanitize_url_for_log("http://h.example:8080/play/John/Secret/42"),
            "http://h.example:8080/play/***/***/42"
        );
        assert_eq!(
            sanitize_url_for_log("go?u=http%3A%2F%2Fh.example%2Fhls%2FJohn%2FSecret%2F1.m3u8"),
            "go?u=http%3A%2F%2Fh.example%2Fhls%2F***%2F***%2F1.m3u8"
        );
        let tmdb = "https://api.themoviedb.org/3/tv/1399/season/1?language=fr-FR";
        assert_eq!(sanitize_url_for_log(tmdb), tmdb, "TMDB URL unchanged");
    }

    // Réinitialisation restée à moitié, terminée au chargement suivant

    fn reset_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nyx-storage-{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    const DB: &str = "nyxplayer_550e8400-e29b-41d4-a716-446655440000.db";

    #[test]
    fn pending_reset_deletes_the_base_kept_by_a_locked_file() {
        let dir = reset_dir("pending");
        for file in database_files(DB) {
            fs::write(dir.join(file), b"x").unwrap();
        }
        fs::write(pending_delete_marker(&dir, DB), b"").unwrap();
        finish_pending_reset(&dir, DB);
        for file in database_files(DB) {
            assert!(!dir.join(file).exists());
        }
        assert!(!pending_delete_marker(&dir, DB).exists());
    }

    #[test]
    fn a_file_still_held_keeps_the_base_and_forgets_the_mark() {
        let dir = reset_dir("held");
        // Un dossier au nom du journal : sa suppression comme fichier échoue, comme un fichier tenu
        fs::create_dir_all(dir.join(format!("{}-wal", DB))).unwrap();
        fs::write(dir.join(DB), b"x").unwrap();
        fs::write(pending_delete_marker(&dir, DB), b"").unwrap();
        finish_pending_reset(&dir, DB);
        // Un seul essai : la base remplie ensuite ne sera pas effacée au lancement suivant
        assert!(!pending_delete_marker(&dir, DB).exists());
        fs::write(dir.join(DB), b"base neuve").unwrap();
        finish_pending_reset(&dir, DB);
        assert_eq!(fs::read(dir.join(DB)).unwrap(), b"base neuve");
    }

    #[test]
    fn without_a_pending_reset_the_base_is_kept() {
        let dir = reset_dir("kept");
        fs::write(dir.join(DB), b"x").unwrap();
        finish_pending_reset(&dir, DB);
        assert!(dir.join(DB).exists());
    }

    /// Formes sans port, en majuscules ou encodées, miroir des tests TypeScript.
    #[test]
    fn sanitize_url_short_uppercase_and_encoded_forms() {
        // Forme courte sans port
        assert_eq!(
            sanitize_url_for_log("http://provider.example/john/secret/123.ts"),
            "http://provider.example/***/***/123.ts"
        );
        assert_eq!(
            sanitize_url_for_log("erreur http://provider.example/john/secret/123 ici"),
            "erreur http://provider.example/***/***/123 ici"
        );
        assert_eq!(
            sanitize_url_for_log("http://provider.example/12345678/87654321/42.m3u8?t=1"),
            "http://provider.example/***/***/42.m3u8?t=1"
        );
        let tmdb = "https://api.themoviedb.org/3/movie/550";
        assert_eq!(sanitize_url_for_log(tmdb), tmdb, "TMDB URL unchanged");
        // Fin de phrase ou erreur ffmpeg relayée par mpv : « 123.ts: », « 123.ts. »
        assert_eq!(
            sanitize_url_for_log("http://provider.example/jdoe/p4ss/123.ts: Server returned 404"),
            "http://provider.example/***/***/123.ts: Server returned 404"
        );
        assert_eq!(
            sanitize_url_for_log("Échec de http://provider.example/jdoe/p4ss/123.ts."),
            "Échec de http://provider.example/***/***/123.ts."
        );
        assert_eq!(
            sanitize_url_for_log("http://provider.example/jdoe/p4ss/123/"),
            "http://provider.example/***/***/123/"
        );
        let longer = "http://provider.example/a/b/123/suite";
        assert_eq!(sanitize_url_for_log(longer), longer);
        // Majuscules
        assert_eq!(
            sanitize_url_for_log("http://provider.example/LIVE/John/Secret/1.ts"),
            "http://provider.example/LIVE/***/***/1.ts"
        );
        // Paramètres encodés
        assert_eq!(
            sanitize_url_for_log("username%3DJohn%26password%3DSecret"),
            "username%3D***%26password%3D***"
        );
        assert_eq!(
            sanitize_url_for_log("http://proxy.example/go?u=http%3A%2F%2Fh.example%2Fplayer_api.php%3Fusername%3DJohn%26password%3DS%40cret%26action%3Dx"),
            "http://proxy.example/go?u=http%3A%2F%2Fh.example%2Fplayer_api.php%3Fusername%3D***%26password%3D***%26action%3Dx"
        );
        assert_eq!(sanitize_url_for_log("x%3fUSERNAME%3dJohn"), "x%3fUSERNAME%3d***");
        // Chemin de flux encodé (adresse de flux dans une autre adresse)
        assert_eq!(
            sanitize_url_for_log("go?u=http%3A%2F%2Fh.example%2Flive%2FJohn%2FSecret%2F1.ts"),
            "go?u=http%3A%2F%2Fh.example%2Flive%2F***%2F***%2F1.ts"
        );
        assert_eq!(
            sanitize_url_for_log("u=http%3a%2f%2fh.example%2fMOVIE%2fJo%40hn%2fS%2Bcret%2f2.mkv"),
            "u=http%3a%2f%2fh.example%2fMOVIE%2f***%2F***%2F2.mkv"
        );
    }
}
