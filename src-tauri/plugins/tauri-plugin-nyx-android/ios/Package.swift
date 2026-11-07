// swift-tools-version:5.9
// iOS side of the nyx-android plugin. The library product carries the crate's name: the plugin's
// build script (tauri-plugin, `.ios_path("ios")`) links it under that name. `.tauri/tauri-api` is
// written by that build script.
import PackageDescription

let package = Package(
    name: "tauri-plugin-nyx-android",
    platforms: [
        .iOS(.v15),
    ],
    products: [
        .library(
            name: "tauri-plugin-nyx-android",
            type: .static,
            targets: ["NyxIosPlugin"]),
    ],
    dependencies: [
        .package(name: "Tauri", path: "../.tauri/tauri-api"),
    ],
    targets: [
        .target(
            name: "NyxIosPlugin",
            dependencies: [
                .byName(name: "Tauri"),
            ],
            path: "Sources/NyxIosPlugin"),
    ]
)
