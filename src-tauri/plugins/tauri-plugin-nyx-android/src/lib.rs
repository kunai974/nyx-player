use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

// Swift entry point of the iOS side (ios/Sources/NyxIosPlugin/NyxPlugin.swift)
#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_nyx_android);

/// On desktop the plugin registers nothing: the frontend only calls it on Android and iOS.
/// Android uses the Kotlin plugin, iOS the Swift package; both under the JS name `nyx-android`.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("nyx-android")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            _api.register_android_plugin("com.nyxplayer.nativebridge", "NyxAndroidPlugin")?;
            #[cfg(target_os = "ios")]
            _api.register_ios_plugin(init_plugin_nyx_android)?;
            Ok(())
        })
        .build()
}
