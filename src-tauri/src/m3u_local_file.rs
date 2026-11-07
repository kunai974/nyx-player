//! Liste M3U ouverte depuis un fichier de l'appareil (ordinateur ou téléphone), au lieu d'une
//! adresse web.
//!
//! La page n'a pas accès au disque : elle lit le fichier choisi par l'utilisateur et en envoie le
//! contenu par morceaux. Il est recopié dans le dossier de l'app (`m3u_files/<numéro>.m3u`), puis
//! la source garde l'adresse `nyx-file://<numéro>/<nom du fichier>`. La lecture M3U ouvre alors
//! cette copie au lieu de télécharger une liste ; « Actualiser » la relit telle quelle.
//!
//! Le numéro (32 chiffres hexadécimaux) est tiré du nom du fichier par la page : le même fichier
//! choisi de nouveau remplace sa copie au lieu d'en ajouter une. Il est vérifié avant tout accès au
//! disque : aucun autre fichier ne peut être lu, écrit ou effacé par ces commandes. Une copie
//! terminée n'est jamais effacée par la page ; seules les moins récemment lues le sont, au-delà de
//! `MAX_LOCAL_LISTS`, et toutes par la remise à zéro complète.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use base64::Engine;

use crate::m3u_ingest::MAX_M3U_DOWNLOAD_BYTES;

/// Début de l'adresse d'une liste recopiée depuis un fichier de l'appareil.
pub const LOCAL_LIST_SCHEME: &str = "nyx-file://";
/// Dossier des listes recopiées, dans le dossier de l'app.
pub const LOCAL_LISTS_DIR: &str = "m3u_files";
/// Erreur rendue quand la copie n'est plus là (données de l'app effacées) : la page demande de
/// choisir le fichier de nouveau.
pub const LOCAL_LIST_MISSING: &str = "local list missing";
/// Morceau le plus gros accepté en un envoi (texte base64 de quelques Mo).
const MAX_CHUNK_BASE64: usize = 8 * 1024 * 1024;
/// Copies gardées au plus : au-delà, la plus ancienne est effacée au début d'une nouvelle copie
/// (le disque d'un téléphone ne se remplit pas de listes oubliées).
const MAX_LOCAL_LISTS: usize = 4;
/// Copie interrompue (app fermée en route) effacée passé ce délai.
const ABANDONED_AFTER: Duration = Duration::from_secs(60 * 60);

/// Une seule opération à la fois sur le dossier : deux morceaux envoyés ensemble ne passent pas
/// tous deux la vérification de position, et la fin d'une copie n'arrive pas pendant une écriture.
static LOCK: Mutex<()> = Mutex::new(());

fn io_error(e: std::io::Error) -> String {
    format!("local list: {}", e.kind())
}

/// Numéro d'une liste recopiée : exactement 32 chiffres hexadécimaux en minuscules.
fn checked_id(id: &str) -> Result<&str, String> {
    if id.len() == 32 && id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        Ok(id)
    } else {
        Err("invalid local list id".to_string())
    }
}

fn lists_dir(data_dir: &Path) -> PathBuf {
    data_dir.join(LOCAL_LISTS_DIR)
}

/// Copie terminée d'une liste.
pub fn local_list_path(data_dir: &Path, id: &str) -> Result<PathBuf, String> {
    Ok(lists_dir(data_dir).join(format!("{}.m3u", checked_id(id)?)))
}

/// Copie en cours d'écriture.
fn partial_path(data_dir: &Path, id: &str) -> Result<PathBuf, String> {
    Ok(lists_dir(data_dir).join(format!("{}.part", checked_id(id)?)))
}

/// Refuse un lien symbolique posé à la place d'une copie (il ferait écrire ailleurs).
fn refuse_link(path: &Path) -> Result<(), String> {
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => Err("local list: unexpected link".to_string()),
        _ => Ok(()),
    }
}

/// Numéro de la liste si `url` désigne une liste recopiée (`None` pour une adresse web). Une
/// adresse `nyx-file://` mal formée est une erreur, jamais prise pour une adresse web.
pub fn local_list_id(url: &str) -> Result<Option<String>, String> {
    let Some(rest) = url
        .get(..LOCAL_LIST_SCHEME.len())
        .filter(|start| start.eq_ignore_ascii_case(LOCAL_LIST_SCHEME))
        .map(|_| &url[LOCAL_LIST_SCHEME.len()..])
    else {
        return Ok(None);
    };
    let id = rest.split('/').next().unwrap_or("");
    Ok(Some(checked_id(id)?.to_string()))
}

/// Fichier à lire pour `url` : la copie d'une liste de l'appareil (erreur `LOCAL_LIST_MISSING` si
/// elle n'est plus là), ou `None` pour une adresse web à télécharger.
pub fn local_list_source(url: &str, data_dir: &Path) -> Result<Option<PathBuf>, String> {
    let Some(id) = local_list_id(url)? else { return Ok(None) };
    let path = local_list_path(data_dir, &id)?;
    refuse_link(&path)?;
    if !path.is_file() {
        return Err(LOCAL_LIST_MISSING.to_string());
    }
    // Copie lue : datée de maintenant, pour que le ménage efface d'abord les copies qui ne servent plus
    if let Ok(file) = std::fs::OpenOptions::new().append(true).open(&path) {
        let _ = file.set_modified(SystemTime::now());
    }
    Ok(Some(path))
}

/// Ménage : copies interrompues depuis longtemps et, quand `trim_lists` (une nouvelle copie vient de
/// réussir), les copies terminées les moins récemment lues au-delà de `MAX_LOCAL_LISTS` (celle du
/// même numéro sera remplacée, pas comptée).
fn sweep(dir: &Path, id: &str, trim_lists: bool) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let now = SystemTime::now();
    let mut lists: Vec<(SystemTime, PathBuf)> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = std::fs::symlink_metadata(&path) else { continue };
        if !meta.is_file() {
            continue;
        }
        let modified = meta.modified().unwrap_or(now);
        let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
        match path.extension().and_then(|e| e.to_str()) {
            Some("part") if stem != id && now.duration_since(modified).unwrap_or_default() > ABANDONED_AFTER => {
                let _ = std::fs::remove_file(&path);
            }
            Some("m3u") if stem != id => lists.push((modified, path)),
            _ => {}
        }
    }
    if trim_lists && lists.len() >= MAX_LOCAL_LISTS {
        lists.sort();
        for (_, path) in &lists[..=lists.len() - MAX_LOCAL_LISTS] {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// Écrit un morceau de la copie : `offset` 0 commence une nouvelle copie, les suivants doivent
/// reprendre exactement où la copie s'est arrêtée (un morceau perdu ou en double est refusé).
pub fn write_chunk(data_dir: &Path, id: &str, offset: u64, data: &str) -> Result<u64, String> {
    if data.len() > MAX_CHUNK_BASE64 {
        return Err("chunk too large".to_string());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|_| "invalid chunk".to_string())?;
    let path = partial_path(data_dir, id)?;
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut file = if offset == 0 {
        let dir = lists_dir(data_dir);
        std::fs::create_dir_all(&dir).map_err(io_error)?;
        refuse_link(&dir)?;
        sweep(&dir, id, false);
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(io_error(e)),
        }
        std::fs::OpenOptions::new().write(true).create_new(true).open(&path).map_err(io_error)?
    } else {
        refuse_link(&path)?;
        let file = std::fs::OpenOptions::new().append(true).open(&path).map_err(io_error)?;
        let len = file.metadata().map_err(io_error)?.len();
        if len != offset {
            return Err("chunk out of order".to_string());
        }
        file
    };
    let total = offset + bytes.len() as u64;
    if total > MAX_M3U_DOWNLOAD_BYTES {
        drop(file);
        let _ = std::fs::remove_file(&path);
        return Err("list too large".to_string());
    }
    file.write_all(&bytes).map_err(io_error)?;
    Ok(total)
}

/// Termine la copie : elle remplace la copie précédente du même fichier.
pub fn finish(data_dir: &Path, id: &str) -> Result<(), String> {
    let partial = partial_path(data_dir, id)?;
    let done = local_list_path(data_dir, id)?;
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    refuse_link(&partial)?;
    refuse_link(&done)?;
    let size = std::fs::metadata(&partial).map_err(io_error)?.len();
    if size == 0 {
        let _ = std::fs::remove_file(&partial);
        return Err("empty list".to_string());
    }
    std::fs::rename(&partial, &done).map_err(io_error)?;
    // Seulement après une copie réussie : un choix qui échoue n'efface aucune ancienne copie
    sweep(&lists_dir(data_dir), id, true);
    Ok(())
}

/// Abandonne une copie en cours (la copie terminée du même fichier, si elle existe, reste).
pub fn abort(data_dir: &Path, id: &str) -> Result<(), String> {
    let partial = partial_path(data_dir, id)?;
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    match std::fs::remove_file(&partial) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(io_error(e)),
    }
}

/// Efface toutes les copies (remise à zéro complète).
pub fn remove_all(data_dir: &Path) {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let dir = lists_dir(data_dir);
    if refuse_link(&dir).is_ok() {
        let _ = std::fs::remove_dir_all(&dir);
    }
}

/// Reçoit un morceau du fichier choisi (texte base64). Rend la taille déjà recopiée.
#[tauri::command]
pub async fn m3u_file_write(app: tauri::AppHandle, id: String, offset: u64, data: String) -> Result<u64, String> {
    let data_dir = crate::storage::get_data_dir(&app);
    tokio::task::spawn_blocking(move || write_chunk(&data_dir, &id, offset, &data))
        .await
        .map_err(|e| format!("local list task failed: {}", e))?
}

/// Termine la copie du fichier choisi.
#[tauri::command]
pub async fn m3u_file_finish(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let data_dir = crate::storage::get_data_dir(&app);
    tokio::task::spawn_blocking(move || finish(&data_dir, &id))
        .await
        .map_err(|e| format!("local list task failed: {}", e))?
}

/// Abandonne la copie en cours après un échec.
#[tauri::command]
pub async fn m3u_file_abort(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let data_dir = crate::storage::get_data_dir(&app);
    tokio::task::spawn_blocking(move || abort(&data_dir, &id))
        .await
        .map_err(|e| format!("local list task failed: {}", e))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::STANDARD;

    const ID: &str = "0123456789abcdef0123456789abcdef";

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "nyx-local-list-{}-{}",
            std::process::id(),
            SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn copy(dir: &Path, id: &str, text: &[u8]) {
        write_chunk(dir, id, 0, &STANDARD.encode(text)).unwrap();
        finish(dir, id).unwrap();
    }

    #[test]
    fn only_well_formed_ids_reach_the_disk() {
        let dir = temp_dir();
        for bad in ["", "../../etc/passwd", "0123456789ABCDEF0123456789ABCDEF", "0123456789abcdef0123456789abcde", "0123456789abcdef0123456789abcdef0", "0123456789abcdef/123456789abcdef"] {
            assert!(local_list_path(&dir, bad).is_err(), "{bad}");
            assert!(write_chunk(&dir, bad, 0, "YQ==").is_err(), "{bad}");
            assert!(abort(&dir, bad).is_err(), "{bad}");
        }
        assert!(!lists_dir(&dir).exists());
    }

    #[test]
    fn reads_the_id_of_a_local_address() {
        assert_eq!(local_list_id("http://example.com/list.m3u").unwrap(), None);
        assert_eq!(local_list_id(&format!("nyx-file://{ID}/Ma%20liste.m3u")).unwrap(), Some(ID.to_string()));
        assert_eq!(local_list_id(&format!("NYX-FILE://{ID}")).unwrap(), Some(ID.to_string()));
        assert!(local_list_id("nyx-file://../secret/x.m3u").is_err());
        assert!(local_list_id("nyx-file://").is_err());
    }

    #[test]
    fn the_reading_opens_the_copy_or_says_it_is_missing() {
        let dir = temp_dir();
        let url = format!("nyx-file://{ID}/liste.m3u");
        assert_eq!(local_list_source("https://example.com/l.m3u", &dir).unwrap(), None);
        assert_eq!(local_list_source(&url, &dir).unwrap_err(), LOCAL_LIST_MISSING);
        assert!(local_list_source("nyx-file://pas-un-numero/x.m3u", &dir).is_err());
        copy(&dir, ID, b"#EXTM3U\n");
        assert_eq!(local_list_source(&url, &dir).unwrap(), Some(local_list_path(&dir, ID).unwrap()));
    }

    #[test]
    fn copies_in_order_then_replaces_the_previous_copy() {
        let dir = temp_dir();
        let first = STANDARD.encode(b"#EXTM3U\n");
        let second = STANDARD.encode(b"#EXTINF:-1,Une\nhttp://192.0.2.1/1.ts\n");
        assert_eq!(write_chunk(&dir, ID, 0, &first).unwrap(), 8);
        // Morceau rejoué ou perdu : refusé
        assert!(write_chunk(&dir, ID, 3, &second).is_err());
        let total = write_chunk(&dir, ID, 8, &second).unwrap();
        finish(&dir, ID).unwrap();
        let path = local_list_path(&dir, ID).unwrap();
        assert_eq!(std::fs::metadata(&path).unwrap().len(), total);

        // Même fichier choisi de nouveau : sa copie est remplacée
        copy(&dir, ID, b"#EXTM3U\n");
        assert_eq!(std::fs::read(&path).unwrap(), b"#EXTM3U\n");
    }

    #[test]
    fn an_aborted_copy_keeps_the_finished_one() {
        let dir = temp_dir();
        copy(&dir, ID, b"#EXTM3U\n");
        write_chunk(&dir, ID, 0, &STANDARD.encode(b"autre")).unwrap();
        abort(&dir, ID).unwrap();
        assert!(!partial_path(&dir, ID).unwrap().exists());
        assert_eq!(std::fs::read(local_list_path(&dir, ID).unwrap()).unwrap(), b"#EXTM3U\n");
        // Rien à abandonner : pas une erreur
        abort(&dir, ID).unwrap();
    }

    #[test]
    fn keeps_only_the_most_recent_copies() {
        let dir = temp_dir();
        let ids: Vec<String> = (0..MAX_LOCAL_LISTS + 1).map(|i| format!("{i:032x}")).collect();
        for id in &ids {
            copy(&dir, id, b"#EXTM3U\n");
            // Dates de modification distinctes
            std::thread::sleep(Duration::from_millis(20));
        }
        let kept: Vec<bool> = ids.iter().map(|id| local_list_path(&dir, id).unwrap().exists()).collect();
        assert_eq!(kept.iter().filter(|k| **k).count(), MAX_LOCAL_LISTS);
        assert!(!kept[0], "la plus ancienne copie est effacée");
        assert!(kept[MAX_LOCAL_LISTS], "la nouvelle copie reste");
    }

    #[test]
    fn a_copy_still_read_is_kept_and_a_failed_pick_deletes_nothing() {
        let dir = temp_dir();
        let ids: Vec<String> = (0..MAX_LOCAL_LISTS + 1).map(|i| format!("{i:032x}")).collect();
        copy(&dir, &ids[0], b"#EXTM3U\n");
        std::thread::sleep(Duration::from_millis(20));
        for id in &ids[1..MAX_LOCAL_LISTS] {
            copy(&dir, id, b"#EXTM3U\n");
            std::thread::sleep(Duration::from_millis(20));
        }
        // La plus ancienne copie est encore la source : sa lecture la rend récente
        local_list_source(&format!("nyx-file://{}/a.m3u", ids[0]), &dir).unwrap();
        std::thread::sleep(Duration::from_millis(20));
        // Choix qui échoue : rien d'effacé
        write_chunk(&dir, &ids[MAX_LOCAL_LISTS], 0, &STANDARD.encode(b"x")).unwrap();
        abort(&dir, &ids[MAX_LOCAL_LISTS]).unwrap();
        assert!(ids[..MAX_LOCAL_LISTS].iter().all(|id| local_list_path(&dir, id).unwrap().exists()));
        // Choix réussi : la copie la moins récemment lue part, pas celle en usage
        copy(&dir, &ids[MAX_LOCAL_LISTS], b"#EXTM3U\n");
        assert!(local_list_path(&dir, &ids[0]).unwrap().exists());
        assert!(!local_list_path(&dir, &ids[1]).unwrap().exists());
    }

    #[test]
    fn refuses_bad_chunks_and_empty_lists() {
        let dir = temp_dir();
        assert!(write_chunk(&dir, ID, 0, "pas du base64 !").is_err());
        assert!(write_chunk(&dir, ID, 5, "YQ==").is_err(), "suite d'une copie jamais commencée");
        write_chunk(&dir, ID, 0, "").unwrap();
        assert!(finish(&dir, ID).is_err());
        assert!(!local_list_path(&dir, ID).unwrap().exists());
    }

    #[test]
    fn the_full_reset_removes_every_copy() {
        let dir = temp_dir();
        copy(&dir, ID, b"#EXTM3U\n");
        remove_all(&dir);
        assert!(!lists_dir(&dir).exists());
    }
}
