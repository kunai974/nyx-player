//! Build script. The app declares its own commands (app manifest): Tauri then checks each call
//! against the capabilities (`capabilities/default.json`) instead of letting any page loaded in the
//! window call them. A test checks this list against `generate_handler!` in `src/lib.rs`.

const APP_COMMANDS: &[&str] = &[
    "iptv_fetch",
    "iptv_fetch_public",
    "ingest_catalog",
    "cancel_catalog_ingestion",
    "ingest_m3u",
    "cancel_m3u_ingestion",
    "m3u_file_write",
    "m3u_file_finish",
    "m3u_file_abort",
    "refresh_catalog",
    "abort_catalog_refresh",
    "load_light_catalog",
    "nyx_db_load",
    "nyx_db_execute",
    "nyx_db_select",
    "nyx_db_close",
    "nyx_db_check",
    "nyx_secret_get",
    "nyx_secret_set",
    "nyx_secret_delete",
    "full_reset",
    "delete_source_catalog",
    "copy_catalog_to_source",
    "build_fusion_index",
    "abort_fusion_index",
    "probe_stream_status",
    "nyx_mpv_init",
    "nyx_mpv_command",
    "nyx_mpv_set_margins",
    "nyx_mpv_alive",
    "nyx_mpv_tls_ready",
    "purge_webview_cache",
    "trim_memory",
    "trim_memory_in_player",
    "set_memory_low",
    "set_memory_normal",
    "set_webview_opaque",
    "set_webview_transparent",
    "get_app_setting",
    "set_app_setting",
    "nyx_update_check",
    "fetch_and_parse_epg",
    "abort_epg_sync",
    "cancel_epg_abort",
    "remap_epg",
    "poster_prepare",
    "poster_cache_clear",
];

/// Windows application manifest (Common Controls v6, same content as the tauri-build default).
const WINDOWS_MANIFEST: &str = "windows-app-manifest.xml";

fn main() {
    let mut attributes = tauri_build::Attributes::new()
        .app_manifest(tauri_build::AppManifest::new().commands(APP_COMMANDS));
    if embed_windows_manifest_with_linker() {
        // The linker embeds the manifest instead: no second copy in the resource file.
        attributes = attributes
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
    }
    tauri_build::try_build(attributes).expect("failed to run tauri-build");
}

/// On Windows (MSVC), tauri-build puts the manifest in a resource linked into the app binaries only.
/// The unit-test binary then has no manifest, loads the old Common Controls (v5) without
/// `TaskDialogIndirect`, and Windows refuses to start it (0xc0000139, STATUS_ENTRYPOINT_NOT_FOUND).
/// Cargo has no link instruction for library unit tests alone (`rustc-link-arg-tests` only covers
/// `tests/`), so the linker embeds the same manifest in every binary, the app included. This is the
/// workaround Tauri uses for its own tests (tauri/build.rs, `embed_manifest_for_tests`). The cdylib
/// (nyxplayer_lib.dll) gets it too, as resource 2: intended and without effect.
/// `/MANIFESTUAC:NO` keeps the app's manifest identical to the one tauri-build embedded so far.
fn embed_windows_manifest_with_linker() -> bool {
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_env = std::env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
    if target_os != "windows" || target_env != "msvc" {
        return false;
    }
    let manifest =
        std::path::Path::new(&std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"))
            .join(WINDOWS_MANIFEST);
    println!("cargo:rerun-if-changed={}", manifest.display());
    println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
    println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    println!("cargo:rustc-link-arg=/MANIFESTUAC:NO");
    true
}
