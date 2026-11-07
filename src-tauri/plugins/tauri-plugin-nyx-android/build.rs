// Commands are implemented in Kotlin only; JS invokes are routed to the native plugin.
// This list exists so tauri-plugin generates one ACL permission per command.
const COMMANDS: &[&str] = &[
    "play",
    "stop",
    "set_paused",
    "seek",
    "set_volume",
    "set_muted",
    "set_speed",
    "select_track",
    "set_resize_mode",
    "set_video_margins",
    "set_subtitle_scale",
    "set_fullscreen",
    "get_property",
    "network_status",
    "note_exit_requested",
    "device_info",
    "last_exit_report",
    "secure_get",
    "secure_set",
    "secure_delete",
    "update_info",
    "fetch_update_manifest",
    "request_install_permission",
    "download_update",
    "install_update",
    "register_listener",
    "remove_listener",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
