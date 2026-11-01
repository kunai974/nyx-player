# Contributing to Nyx Player

Thank you for your interest in Nyx Player! This guide explains how to propose a change.

## Before you start

- For a bug, open an issue with the steps to reproduce, your platform (Windows, Android phone,
  Android TV) and the app version. Never paste your provider's address, username or password.
- For a new feature or a large change, open an issue first so we can agree on the approach before
  you write code.

## Development setup

See “Build from source” in the [README](README.md). Run `pnpm verify` before every pull request: it
runs the type check, the tests, ESLint, the CSS rules and the web build. For Rust changes, also run
`cargo test --locked` in `src-tauri/`.

## Rules the codebase follows

- **One codebase, three targets.** Platform-specific behaviour goes through the detection helpers in
  `src/utils/platform.ts` (`isMobile()`, `isTv()`, `isAndroid()`), never through a copy of the code.
  A change to shared code must keep Windows, phone and TV working.
- **CSS** follows [`docs/CSS_RULES.md`](docs/CSS_RULES.md), enforced by Stylelint (`pnpm lint:css`).
  Phone and TV overrides live in `src/styles/mobile.css` (under `.nyx-mobile`) and
  `src/styles/tv.css` (under `.nyx-tv`).
- **Playback** always goes through `src/services/player/mpvApi.ts`.
- **Text** shown to users is translated: add every new string in English and French under `src/i18n`.
- **Privacy**: never log a stream address or a provider credential; use `sanitizeIptvUrl`.
- **One bug, one test**: a bug fix comes with a test that fails without the fix.
- Code conventions: [`docs/CONVENTIONS.md`](docs/CONVENTIONS.md).

## Commits and pull requests

- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) in English:
  `type(scope): description`, for example `fix(tv): keep focus on the last played channel`.
- One topic per pull request, based on the `main` branch.
- Describe what changes for the user, how you tested it, and on which platforms.
- CI must be green before a pull request is reviewed. For a first-time contributor, the maintainer
  starts it by hand.
- Sign off every commit (`git commit -s`). This adds a `Signed-off-by:` line, by which you certify
  the [Developer Certificate of Origin](https://developercertificate.org/): the code is yours to
  contribute, under the project's licence.
- Replies are best effort: this is a small project, and a pull request may be declined or
  reworked, in particular when it touches accounts, sync, the player or security.

## Licence

By contributing, you agree that your contribution is released under the project's licence
(GPL-3.0-or-later).
