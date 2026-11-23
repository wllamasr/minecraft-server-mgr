# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Paper**, **Purpur** and **Folia** server engines (plugin platforms aimed at large player
  counts) in the create-server wizard, for local servers. The Minecraft version list is fetched
  live from the project (PaperMC Fill v3 API, Purpur API) and lists release versions only. You
  pick a build; the newest stable build is preselected and non-stable builds are labelled
  "(experimental)". The build is a complete `server.jar`; no installer step. Folia only runs
  plugins that explicitly support Folia.
- Plugin support for these servers: add-ons load from `plugins/`, the server's "Mods" tab becomes
  "Plugins" and the browser becomes "Plugin Browser". Plugins come from Modrinth only (CurseForge
  is disabled for these servers). Paper and Purpur search projects tagged paper, purpur, spigot or
  bukkit; Folia searches projects tagged folia.
- Per-server JVM profile (`jvmProfile`: `default` or `aikar`, column `servers.jvm_profile`),
  exposed in wizard step 3 as "Optimized JVM flags" (on by default for plugin platforms). `aikar`
  applies Aikar's G1GC flags and sets `-Xms` equal to `-Xmx`; it works with every engine (for
  Forge/NeoForge the flags go to `user_jvm_args.txt`). The server Overview shows the active
  profile. The wizard RAM slider now goes up to 32 GB.
- IPC channel `server-software:get-versions` (`getServerSoftwareVersions(platform)`).
  `modloader:get-versions` now also accepts paper, purpur and folia and returns build numbers.
  `server:create` accepts an optional `jvmProfile`. See [docs/IPC.md](docs/IPC.md).
- Opt-in live end-to-end test `e2e/live/paper-server.spec.ts` (needs network and Java 21; skipped
  unless `MSM_E2E_LIVE=1`; never runs in CI).
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

- Downloaded server jars are verified against the checksum the project publishes: SHA-256 for
  Paper and Folia, MD5 for Purpur (Purpur only publishes MD5), SHA-1 for the vanilla jar from
  Mojang. On a mismatch the file is deleted and provisioning fails.
- `server:create` now validates its input in the main process (name, version, RAM format such as
  `4G` or `4096M`, min RAM not above max RAM, known engine, known JVM profile, and a build number
  for plugin platforms).
- The app sends a descriptive `User-Agent` (`MinecraftServerManager (+https://github.com/wllamasr/minecraft-server-mgr)`)
  to the metadata APIs it calls.
- Remote hosts (the `msmd` daemon) do not support Paper, Purpur, Folia or the JVM profile yet.
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

### Fixed

- Java requirement mapping: Minecraft 26.x now requires Java 25 (it was mapped to Java 8), and
  1.20.5 and 1.20.6 now require Java 21 (they were mapped to Java 17). The full mapping is 26.x:
  Java 25; 1.20.5 to 1.21.x: Java 21; 1.17 to 1.20.4: Java 17; 1.16.5 and older: Java 8.
