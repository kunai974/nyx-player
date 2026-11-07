//! Nyx Player — Tauri application entry point.
//!
//! This is the hub module that registers all plugins and Tauri commands. Business logic is split into dedicated modules.

mod app_settings;
mod app_update;
mod catalog_light;
mod catalog_parser;
mod catalog_refresh;
mod catalog_split;
mod db_activity;
mod dns;
mod epg_parser;
mod fusion_index;
mod fusion_rules;
mod http;
mod ingestion;
mod logging;
mod m3u_ingest;
mod m3u_local_file;
mod m3u_parser;
mod memory;
// Historical schema journal, kept only to check old database layouts in tests
#[cfg(test)]
mod migrations;
mod mpv_guard;
mod mpv_tls;
mod navigation;
mod playback;
mod poster_thumbs;
mod public_net;
mod schema;
mod secret_vault;
mod secure_db;
mod storage;
mod transparency;
#[cfg(test)]
mod test_alloc;

// ============= App Entry Point =============

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Initialize log backend — makes log::info!/warn!/error! visible in terminal (logging.rs)
    logging::init();

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_nyx_android::init());

    // MPV (external process) and the self-updater only exist on desktop. The OS keyring is reached
    // through nyx_secret_* only (secret_vault.rs). Android uses the nyx-android plugin (libmpv
    // player + Keystore) and APK updates.
    #[cfg(desktop)]
    let builder = builder
        // A newer version only, and only when its signature was made for it (app_update.rs)
        .plugin(
            tauri_plugin_updater::Builder::new()
                .default_version_comparator(|current, release| {
                    release.version > current && app_update::signed_for_announced_version(&release)
                })
                .build(),
        )
        .plugin(tauri_plugin_mpv::init());

    // Affiches réduites (poster_thumbs.rs) : servies du disque seulement, la réponse part tout de suite
    let builder = builder.register_asynchronous_uri_scheme_protocol(poster_thumbs::SCHEME, |ctx, request, responder| {
        let cache = poster_thumbs::cache_dir_of(ctx.app_handle());
        let path_and_query = request.uri().path_and_query().map(|p| p.as_str().to_owned()).unwrap_or_default();
        tauri::async_runtime::spawn_blocking(move || {
            let reply = match cache {
                Some(dir) => poster_thumbs::serve_cached(&dir, &path_and_query),
                None => poster_thumbs::Reply { status: 500, content_type: "text/plain", body: Vec::new() },
            };
            // Une affiche absente ne doit pas rester en mémoire de la page : elle sera prête plus tard
            let cache = if reply.status == 200 { "max-age=604800" } else { "no-store" };
            let response = tauri::http::Response::builder()
                .status(reply.status)
                .header("Content-Type", reply.content_type)
                .header("Cache-Control", cache)
                .body(reply.body)
                .unwrap_or_default();
            responder.respond(response);
        });
    });

    builder
        .manage(secure_db::NyxDatabases::default())
        .setup(|app| {
            use tauri::Manager;
            use tauri::WebviewUrl;

            // ── Read app-level settings (before WebView2 init) ──
            let config_dir = app.path().app_config_dir()
                .expect("Failed to resolve app config dir");
            let app_settings = app_settings::read_settings(&config_dir);
            log::info!(
                "[App] hardware_acceleration = {}",
                app_settings.hardware_acceleration
            );

            // A guide download left by an app killed during a sync (up to ≈ 200 MB)
            epg_parser::remove_leftover_download(app.handle());
            // Catalogues de sources supprimées que Windows tenait encore : effacés maintenant
            storage::sweep_pending_catalog_deletions(&storage::get_data_dir(app.handle()));
            // Affiches réduites : le dossier est rangé à la première demande, avant le lancement des fils
            poster_thumbs::install(app.handle());

            // ── Create main window programmatically ──
            // Needed to set scroll_bar_style(FluentOverlay) which requires builder API
            #[allow(unused_mut)]
            // Only the app's own pages load in the window (navigation.rs); the dev server in dev only
            let dev_url = if tauri::is_dev() { app.config().build.dev_url.clone() } else { None };
            let mut builder = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::App("index.html".into()),
            )
            .on_navigation(navigation::guard(dev_url));

            #[cfg(desktop)]
            {
                builder = builder
                    .title("Nyx Player")
                    .inner_size(1280.0, 800.0)
                    .transparent(true)
                    .visible(false)
                    .decorations(true)
                    .resizable(true);

                // Disable GPU acceleration if user toggled it off
                if !app_settings.hardware_acceleration {
                    builder = builder.additional_browser_args("--disable-gpu");
                    log::info!("[App] WebView2 GPU acceleration DISABLED (--disable-gpu)");
                }
            }

            // Audit build only (Cargo feature "audit", never in a distributed .exe): the display
            // audit tool drives the WebView through the DevTools protocol on a local port, and sets
            // the window size and the display scale at launch (NYX_AUDIT_WINDOW=1366x768@1.25).
            #[cfg(all(feature = "audit", target_os = "windows"))]
            {
                let port = std::env::var("NYX_AUDIT_PORT").unwrap_or_else(|_| "9333".into());
                let mut args = format!(
                    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --remote-debugging-port={port}"
                );
                if !app_settings.hardware_acceleration {
                    args.push_str(" --disable-gpu");
                }
                if let Ok(spec) = std::env::var("NYX_AUDIT_WINDOW") {
                    let (size, scale) = spec.split_once('@').map_or((spec.as_str(), None), |(s, k)| (s, Some(k)));
                    if let Some((w, h)) = size.split_once('x') {
                        if let (Ok(w), Ok(h)) = (w.parse::<f64>(), h.parse::<f64>()) {
                            builder = builder.inner_size(w, h);
                        }
                    }
                    if let Some(k) = scale {
                        args.push_str(&format!(" --force-device-scale-factor={k}"));
                    }
                }
                log::info!("[App] Audit build: WebView2 args {args}");
                builder = builder.additional_browser_args(&args);
            }

            // FluentOverlay: overlay scrollbar native Windows (Tauri ≥ 2.8, WebView2 ≥ 125)
            #[cfg(target_os = "windows")]
            {
                builder = builder.scroll_bar_style(tauri::webview::ScrollBarStyle::FluentOverlay);
            }

            let _window = builder.build()?;

            // Auto-purge mémoire WebView2 toutes les 60 secondes (fallback)
            // La purge intelligente est gérée côté frontend (memoryService.ts)
            #[cfg(target_os = "windows")]
            memory::setup_auto_purge(app);
            // An mpv.exe left by a crashed instance would keep a provider connection busy
            #[cfg(target_os = "windows")]
            playback::kill_orphan_mpv();
            // Force opaque WebView2 background before first frame
            transparency::init_opaque_background(app);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // IPTV API
            ingestion::iptv_fetch,
            ingestion::iptv_fetch_public,
            // Catalog Ingestion (SQLite-First)
            ingestion::ingest_catalog,
            ingestion::cancel_catalog_ingestion,
            m3u_ingest::ingest_m3u,
            m3u_ingest::cancel_m3u_ingestion,
            m3u_local_file::m3u_file_write,
            m3u_local_file::m3u_file_finish,
            m3u_local_file::m3u_file_abort,
            // Actualisation en arrière-plan, par comparaison
            catalog_refresh::refresh_catalog,
            catalog_refresh::abort_catalog_refresh,
            // Lecture compacte du catalogue au démarrage
            catalog_light::load_light_catalog,
            // Base SQLite de la page : seule porte, gardée (plus de plugin:sql depuis le web)
            secure_db::nyx_db_load,
            secure_db::nyx_db_execute,
            secure_db::nyx_db_select,
            secure_db::nyx_db_close,
            secure_db::nyx_db_check,
            // Coffre des identifiants IPTV (ordinateur) : service fixe, comptes de Nyx seulement
            secret_vault::nyx_secret_get,
            secret_vault::nyx_secret_set,
            secret_vault::nyx_secret_delete,
            // Full Reset
            storage::full_reset,
            // Catalogue d'une source supprimée
            storage::delete_source_catalog,
            // Recopie du catalogue du compte dans le fichier de sa première source
            catalog_split::copy_catalog_to_source,
            // Index commun aux sources d'un espace (construction, arrêt pendant une vidéo)
            fusion_index::build_fusion_index,
            fusion_index::abort_fusion_index,
            // Playback (HTTP status of a stream mpv failed to load)
            playback::probe_stream_status,
            // Lecteur Windows : seule porte vers mpv, en liste blanche
            mpv_guard::nyx_mpv_init,
            mpv_guard::nyx_mpv_command,
            mpv_guard::nyx_mpv_set_margins,
            mpv_guard::nyx_mpv_alive,
            mpv_tls::nyx_mpv_tls_ready,
            // Memory Management
            // Clears all browsing data (signed-in session included): only the dev tools call it,
            // so it exists in dev and audit builds only
            #[cfg(any(debug_assertions, feature = "audit"))]
            memory::purge_webview_cache,
            memory::trim_memory,
            memory::trim_memory_in_player,
            memory::set_memory_low,
            memory::set_memory_normal,
            // Transparency toggle (opaque at startup, transparent for MPV)
            transparency::set_webview_opaque,
            transparency::set_webview_transparent,
            // App-level settings (pre-boot JSON)
            app_settings::get_app_setting,
            app_settings::set_app_setting,
            // Mise à jour Windows : vérification avec les réglages de l'app seulement
            app_update::nyx_update_check,
            // EPG XMLTV parser
            epg_parser::fetch_and_parse_epg,
            epg_parser::abort_epg_sync,
            epg_parser::cancel_epg_abort,
            epg_parser::remap_epg,
            // Affiches réduites : préparées hors de l'écran, effacées pour une mesure de première ouverture
            poster_thumbs::poster_prepare,
            poster_thumbs::poster_cache_clear,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            // Bases de la page fermées à la sortie, comme le faisait le plugin SQL (journal WAL vidé)
            if let tauri::RunEvent::Exit = event {
                secure_db::close_all_on_exit(app);
            }
        });
}
