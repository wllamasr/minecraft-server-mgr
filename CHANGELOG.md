# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Backups** for local servers: a new **Backups** tab on the server page with **Back up now**,
  the list of backups, **Restore** and **Delete**.
  - A backup is a standard zip of the server folder (world, settings, mods or plugins, the server
    jar), without `logs`, `crash-reports`, `debug`, `cache`, `libraries`, `versions`,
    `modpack.mrpack` and `session.lock` files; links are skipped. Backups are kept outside the server folder, in
    `backups/<server id>/` under the app data folder.
  - A running server can be backed up: the app sends `save-off` and `save-all flush`, waits for
    the server to confirm, copies, and sends `save-on`. If the server does not confirm, the backup
    fails instead of producing an unreliable copy.
  - Restoring needs the server to be stopped. The backup is unpacked completely first and then
    swapped in; if anything fails the server files are put back as they were (if even
    that cannot be done, the error names the folder that holds the replaced files). Files that are not
    part of backups (logs, libraries) are left alone, and everything else is replaced, so no file
    from after the backup survives. By default the current files are backed up first ("before
    restore" in the list), so a restore can be undone.
  - Stopping, restarting or deleting a server, or closing the app, cancels a backup in progress.
    A server cannot be started while a backup of it (stopped) or a restore is in progress.
  - Deleting a server deletes its backups too; the confirmation says so.
  - Not included yet: backups of servers on remote hosts.
- **Scheduled backups** for local servers, in the same tab: back a server up every day at a fixed
  time and keep only the last N scheduled backups (7 by default).
  - Only scheduled backups are deleted automatically, and only after a new one is complete.
    Backups made by hand or before a restore are never deleted for you.
  - A backup that cannot start at its time (the server is starting or stopping, another backup is
    running) is tried again for 10 minutes and then counts as missed. Like scheduled restarts,
    schedules only run while the app is open and the computer is awake; a missed backup is not
    caught up.
  - A stopped server is backed up only if its files changed since its last scheduled backup, so
    identical copies do not push the useful ones out.
  - A scheduled restart that comes due while a backup is running waits for it, for up to 15
    minutes, instead of cancelling it.
  - The tab shows how the last scheduled backup went (made, skipped, missed or failed, and why),
    and follows backups it did not start itself: progress, the list and the buttons update.
- IPC channels `backup:list`, `backup:create`, `backup:delete`, `backup:restore` and the event
  `event:backup-progress`; `server:update-settings` accepts `backupSchedule` and `backupKeep`.
  See [docs/IPC.md](docs/IPC.md).

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
- Remote hosts (the `msmd` daemon) support **Paper**, **Purpur** and **Folia** and the JVM profile.
  `POST /v1/servers` accepts `modLoader` `paper`, `purpur` or `folia` (`modLoaderVersion` is the
  build number) and an optional `jvmProfile` (`default` or `aikar`, returned in server objects).
  The daemon downloads the build as `server.jar` and verifies it (SHA-256 for Paper and Folia,
  MD5 for Purpur). `GET /v1/loaders/{loader}/versions` also accepts these platforms. A host
  running an older `msmd` must be updated. Plugin management through the app stays local-only.
- Daemon endpoint `GET /v1/software/{platform}/versions` (paper, purpur, folia): Minecraft release
  versions, newest first.
- The Deploy dialog on the Remote Hosts page offers the engines Paper, Purpur and Folia, loads
  versions from the host, preselects the newest stable build, and has an "Optimized JVM flags"
  switch. New IPC channel `hosts:software-versions` (`remoteSoftwareVersions(hostId, platform)`);
  `CreateRemoteServerInput` has an optional `jvmProfile`. See [docs/IPC.md](docs/IPC.md).
- Opt-in live daemon smoke test: `MSMD_SMOKE_LIVE=1` in `daemon/scripts/smoke.sh` provisions,
  boots, stops and deletes a real Paper server with the `aikar` profile (needs network; never
  runs in CI). `daemon/scripts/smoke.sh` also asserts input validation offline.
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
- **Restart** button for running servers, local and remote: the server is stopped cleanly and
  started again once its process is gone.
- **Scheduled restart**: a server can restart every day at a fixed time (`HH:MM`, 24-hour).
  Players are warned in chat 5 minutes and 1 minute before; a stopped server is left stopped,
  and a restart that was missed (computer asleep, app closed) is skipped, not caught up. Set it
  in the server's **Settings** tab for local servers (this computer's time; only runs while the
  app is open) or with the clock button on a remote host's server (the host's time; runs in
  `msmd`, also while the app is closed).
- IPC channels `server:restart`, `server:update-settings`, `hosts:restart` and
  `hosts:update-server`; column `servers.restart_schedule`. See [docs/IPC.md](docs/IPC.md).
- `msmd`: `POST /v1/servers/{id}/restart`, `PATCH /v1/servers/{id}` (`restartSchedule`), and
  `time` / `timeZone` in `GET /v1/info`.
- Quitting the app with servers running now stops them first: each server gets the `stop`
  command and time to save, and the app exits once they are down. The same happens in `msmd` on
  `SIGTERM`/`SIGINT` (for example `systemctl stop msmd`); the API keeps answering while the
  servers shut down. `msmd` reads the grace period from `MSMD_STOP_GRACE` (a duration such as
  `90s` or `5m`, default `2m`).

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
- Modpack downloads are restricted, in the app and in the daemon. The `.mrpack` itself must be an
  `https` URL on `cdn.modrinth.com`; anything else is refused when the server is created (HTTP 400
  from `POST /v1/servers`), so a create request can no longer make the machine fetch an arbitrary
  address. The files a pack lists are only downloaded from the hosts the Modrinth pack format
  allows (`cdn.modrinth.com`, `github.com`, `raw.githubusercontent.com`, `gitlab.com`), over
  `https`; a pack with a file hosted elsewhere fails to deploy.
- The daemon refuses redirects from `https` to plain `http` on all its downloads.

### Changed

- Closing the app while servers are running no longer hides the window during the wait. The
  window stays open with a "Stopping N servers…" screen and the app closes by itself once they
  are down. Opening the app again during that time brings this window to the front.
- Windows shutdown, restart and log-off: the app asks Windows to wait and tells its servers to
  stop at once, instead of being cut off with the servers running. Windows still lets the user
  force the shutdown. On Linux and macOS the app does the same when the system shuts down.
- Daemon: `DELETE /v1/servers/{id}` on a running server answers `202` at once. The server stops
  first and is removed once its process is gone (watch for `GET` to answer 404). A server that is
  not running is still deleted before the call returns (`204`). A daemon that is shut down in
  the middle of such a delete finishes it before it exits.
- Downloaded server jars are verified against the checksum the project publishes: SHA-256 for
  Paper and Folia, MD5 for Purpur (Purpur only publishes MD5), SHA-1 for the vanilla jar from
  Mojang. On a mismatch the file is deleted and provisioning fails.
- `server:create` now validates its input in the main process (name, version, RAM format such as
  `4G` or `4096M`, min RAM not above max RAM, known engine, known JVM profile, and a build number
  for plugin platforms).
- The app sends a descriptive `User-Agent` (`minecraft-server-mgr/<app version>`) to the APIs it
  calls: the project name and version, with no account name or URL in it.
- Daemon: `POST /v1/servers` now validates its input and answers HTTP 400 for a bad `minRam` or
  `maxRam` format (`4G`, `4096M`), min RAM above max RAM, an unknown `jvmProfile`, or a malformed
  `modLoaderVersion`.
- When only one of `minRam` / `maxRam` is given and it crosses the other's default, the other
  bound follows it (for example `maxRam: 512M` alone gives `minRam: 512M`), locally and on remote
  hosts.
- The daemon sends `User-Agent: minecraft-server-mgr-msmd/<daemon version>` on its outgoing
  requests.
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
- **Stop** waits up to 2 minutes (was 30 seconds) for a server to save and exit before killing
  it, in the app and in `msmd`. A forced stop is logged as a warning in the server console.
  For local servers, `MSM_STOP_GRACE_MS` overrides the wait.
- `msmd`: `POST /v1/servers/{id}/stop` answers `202` at once with the server in status
  `stopping`, instead of blocking until the server is down (which could outlast the manager's
  30-second request timeout). Clients watch the status until it is `stopped`.
- The `msmd` systemd unit sets `KillMode=mixed` and `TimeoutStopSec=180`, so stopping the
  service signals only `msmd`, which shuts its servers down itself. Existing installs need the
  updated unit file to get this.

### Fixed

- Deleting a running server on a remote host reported "Daemon request timed out" when the server
  took more than 30 seconds to stop, although the daemon did delete it.
- The window's close button did nothing when the window was not the focused one.
- Quitting the app (or stopping `msmd`) left running servers behind as orphaned Java processes
  with no console attached. They are now shut down cleanly first.
- A stop that had to kill the server returned before the process was gone, so an immediate
  start or delete could collide with the old process. Stop now returns only once it has exited.
- A forced stop killed only the launcher script of a Forge or NeoForge server (`run.bat` /
  `run.sh`) and left its JVM running. The whole process tree is killed now.
- A server that was stopped on purpose is no longer reported as `crashed` when it exits with a
  non-zero code or has to be killed.
- A crash auto-restart that was already scheduled could start a server again after it was
  stopped or deleted, or while the app was quitting. Pending auto-restarts are now cancelled.
- Java requirement mapping: Minecraft 26.x now requires Java 25 (it was mapped to Java 8), and
  1.20.5 and 1.20.6 now require Java 21 (they were mapped to Java 17). The full mapping is 26.x:
  Java 25; 1.20.5 to 1.21.x: Java 21; 1.17 to 1.20.4: Java 17; 1.16.5 and older: Java 8.
- Daemon Java mapping: Minecraft 26.x now maps to Java 25 (it was Java 8), and the daemon installs
  that Temurin JDK automatically when it is missing.
