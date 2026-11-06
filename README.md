<p align="center">
  <img src="src-tauri/icons/128x128.png" alt="Nyx Player" width="96" />
</p>

<h1 align="center">Nyx Player</h1>

<p align="center">
  A modern IPTV player for Windows, Android phones and Android TV.<br />
  Bring your own Xtream Codes subscription (login details or the provider's M3U link); Nyx makes it look and feel like a streaming service.
</p>

---

> [!IMPORTANT]
> ## ⚠️ VERY IMPORTANT — macOS: do this FIRST
>
> **On every Mac you install Nyx Player on, run this in Terminal before opening the app:**
>
> ```bash
> brew install mpv
> ```
>
> Nyx Player on macOS does **not** bundle the video engine (libmpv) yet. Without Homebrew's mpv
> installed, **videos will not play**. Don't have Homebrew? Get it at <https://brew.sh> first.
>
> The macOS build is also **not signed yet**: the first time you open it, right-click the app and
> choose **Open** (or run `xattr -cr "/Applications/Nyx Player.app"`).

## What Nyx is (and is not)

Nyx Player is a **player**. It does **not** provide, sell or link to any TV channel, film or series.
You need an existing IPTV subscription from a provider you are legally allowed to use. Nyx connects
to it, enriches the catalogue with posters, synopses and cast from [TMDB](https://www.themoviedb.org/),
and plays it with [mpv](https://mpv.io/).

## Features

- **Live TV** with a programme guide (EPG), favourites and quick channel switching.
- **Films and series** with artwork, synopses, cast, seasons and episodes, matched with TMDB.
- **Resume where you left off**, “My list”, and per-profile settings.
- **A Nyx account** syncs your list, progress and settings across devices.
- **One codebase, three targets**: a mouse-and-keyboard desktop app, a touch phone app, and a
  remote-control TV interface (Android TV, Chromecast with Google TV), from the same APK.
- **mpv everywhere**: mpv on Windows, a native LGPL build of libmpv on Android.
- Interface in English and French.

## Download

Builds for Windows and Android are published on the [Releases](../../releases) page and on
[nyxplayer.app](https://nyxplayer.app).

## Build from source

Requirements: Node.js 20.19+ or 22.12+ (22.12+ recommended), [pnpm](https://pnpm.io/) 10,
[Rust](https://rustup.rs/) (stable), and for Android the
[Tauri 2 Android prerequisites](https://v2.tauri.app/start/prerequisites/) (Android SDK, NDK, JDK 17).
Android 8.0 (API 26) or later is required to run the app.

```sh
pnpm install
pnpm dev          # web interface only, in the browser
pnpm tauri dev    # native desktop app
pnpm verify       # type check, tests, lint, CSS rules and web build
```

Rust tests: `cargo test --locked` in `src-tauri/`. Android build: see
[`docs/BUILDING.md`](docs/BUILDING.md), which also explains how to fetch the native
binaries (mpv, libmpv) that are not stored in git.

### Configuration

Copy `.env.example` to `.env`. `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are required: the
app signs in to a Nyx account (Supabase) before anything else. Use the address and **publishable**
key of your own [Supabase](https://supabase.com/) project; the database schema it needs is not
published in this repository yet. With placeholder values (`https://example.invalid`, as the CI
does), the tests and the web build run, and the app stops at the sign-in screen. `VITE_SENTRY_DSN`
(crash reports) is optional. Never put a secret key in `.env`: the variables starting with `VITE_`
end up in the app.

## Tech stack

React, TypeScript and Vite for the interface; [Tauri 2](https://v2.tauri.app/) (Rust) for the native
core; SQLite for the local catalogue; Kotlin for the Android player bridge; Supabase for accounts and
sync.

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) and our
[Code of Conduct](CODE_OF_CONDUCT.md). To report a security issue, follow [SECURITY.md](SECURITY.md)
and do **not** open a public issue.

## How this project is built

Nyx Player is developed by one maintainer with extensive help from AI coding assistants (Anthropic's
Claude). Every change goes through automated tests, an independent review and a check on real
devices before release.

## Credits and licences

- Nyx Player is released under the **GPL-3.0-or-later** licence.
- The name “Nyx Player” and its logo are not covered by that licence. If you publish a modified
  version, please give it a different name and logo.
- This product uses the TMDB API but is not endorsed or certified by TMDB.
- Video playback by [mpv](https://mpv.io/) and [FFmpeg](https://ffmpeg.org/). The full list of
  third-party components and their licences is shown in the app (Settings › About › Open source
  licences).
