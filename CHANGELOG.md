# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- End-to-end UI tests (`e2e/`, Playwright) that launch the built Electron app with an isolated
  profile, walk every page, and verify the security boundaries. They can also run against the
  packaged app via `MSM_E2E_EXECUTABLE`.
- Unit tests for downloads, external-URL filtering, and HTML sanitizing.
- A single CI pipeline that tests the desktop app (Windows) and the daemon (Linux and Windows),
  with a `CI passed` summary check.
- Community files: `SECURITY.md`, `CODE_OF_CONDUCT.md`, issue and pull request templates,
  `CODEOWNERS`, and Dependabot configuration.
- User guide (`docs/USER_GUIDE.md`).

### Security

- Packaged builds now ship a Content-Security-Policy: bundled scripts only, no inline script,
  no fetch/XHR/WebSocket connections from the renderer.
- CurseForge mod descriptions (third-party HTML) are sanitized before rendering.
- `openExternal` and `window.open` only accept `http(s)` URLs; the window can no longer navigate
  away from the bundled UI.
- Removed the `modloader:install` IPC channel, which let the renderer run a loader installer in
  an arbitrary directory. Loaders are installed by the main process during server creation.
- Downloads follow at most 5 redirects, refuse https-to-http downgrades, detect truncated
  bodies, and delete partial files on failure.

### Changed

- Only one instance of the app can run at a time; launching it again focuses the open window.
- The daemon smoke test (`make smoke`) now asserts on every check, is portable (Linux and
  Windows), and covers wrong-token and TLS-only cases.
- Installing no longer needs a C++ toolchain: the prebuilt `better-sqlite3` binary is used
  (`allowScripts` in `package.json`, `npmRebuild: false` for packaging). `postinstall` now
  downloads the Electron binary.
- Contributing guide expanded with requirements, security rules, dependency policy, and the review process.
- Dependencies updated: Electron 45, electron-vite 6, `@vitejs/plugin-react` 6, i18next 27,
  react-i18next 18, adm-zip 0.6, and in-range updates across the Mantine, TanStack, and
  other packages.
- `engines.node` set to `^22.22.2 || ^24.15.0 || >=26.0.0`; CI runs on Node 24 and current GitHub Actions.
