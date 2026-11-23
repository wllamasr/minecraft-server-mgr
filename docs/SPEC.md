# Functional Specification

This document describes **what** Minecraft Server Manager (MSM) does, independent of how it
is implemented. For the *how*, see [ARCHITECTURE.md](ARCHITECTURE.md).

## 1. Purpose & scope

MSM is a single-user desktop application for creating and operating **local** Minecraft:
Java Edition servers on a personal machine. It manages multiple server instances, their
mods, configuration, runtime lifecycle, and live diagnostics.

Managing servers on **remote hosts** through the `msmd` daemon is an additive, early-stage
capability specified separately in [DAEMON.md](DAEMON.md); this document covers local servers.
Remote hosts support Paper, Purpur, Folia and the JVM profile too (the host needs an up-to-date
`msmd`); plugin management through the app is local-only.

Out of scope: Bedrock edition, proxy networks (BungeeCord/Velocity), and multi-user access
control.

## 2. Personas

- **Casual host** — wants to spin up a vanilla or modded world for friends without touching
  a terminal.
- **Modpack tinkerer** — assembles a server around Forge/Fabric mods and iterates on config.

## 3. Definitions

| Term          | Meaning                                                                    |
| ------------- | -------------------------------------------------------------------------- |
| Server        | One managed Minecraft server instance with its own directory and DB row.   |
| Mod loader    | Forge, NeoForge, Fabric, or Quilt — the runtime that loads mods.           |
| Plugin platform | Paper, Purpur, or Folia — a complete server jar that loads plugins from `plugins/`. |
| Vanilla       | A server with no mod loader.                                               |
| JVM profile   | `default` or `aikar` (Aikar's G1GC flags, `-Xms` equal to `-Xmx`).         |
| Servers root  | The parent directory that holds every server's folder (configurable).      |

## 4. Functional requirements

### 4.1 Server creation

- **FR-1** The user can create a server by providing a **name** and a **Minecraft version**,
  and optionally a mod loader (+ loader version), port, min/max RAM, a server-list **MOTD**,
  and an **auto-restart** preference.
- **FR-1b** Server creation is **asynchronous**: the server is registered immediately in a
  `provisioning` state and the jar download + mod-loader install run in the background,
  streaming progress to the server console. On failure the server enters an `error` state
  with the reason in its console.
- **FR-2** The server name is sanitized to a filesystem-safe folder name; characters outside
  `[A-Za-z0-9_-]` become `_`.
- **FR-3** Creation fails if the target directory already exists.
- **FR-4** The vanilla `server.jar` is downloaded from Mojang's official version manifest
  for the chosen version and verified against Mojang's SHA-1. An unknown version is rejected.
- **FR-4b** The user can instead choose a plugin platform: **Paper**, **Purpur**, or **Folia**.
  The Minecraft version list is fetched live from the project (release versions only), and the
  user picks a build; the newest stable build is preselected and non-stable builds are labelled
  "(experimental)". The build is a complete jar saved as `server.jar` (no installer step). It
  is verified against the project's published checksum (SHA-256 for Paper/Folia, MD5 for
  Purpur); on mismatch the file is deleted and provisioning fails. Folia only runs plugins
  that explicitly support Folia.
- **FR-4c** The user can choose a **JVM profile**: `default`, or `aikar` (Aikar's G1GC flags
  as published in the PaperMC docs, with `-Xms` equal to `-Xmx`). It works with every engine;
  for Forge/NeoForge the flags are written to `user_jvm_args.txt`. It defaults to on when a
  plugin platform is selected and off otherwise. The RAM choice goes up to 32 GB.
- **FR-5** A default `server.properties` and `eula.txt` (`eula=true`) are written.
- **FR-6** If a mod loader is chosen, it is installed into the server directory before the
  server is considered created.
- **FR-7** Defaults when unspecified: port `25565`, min RAM `1G`, max RAM `2G`,
  `autoStart` off.

### 4.2 Server lifecycle

- **FR-8** The user can **start**, **stop**, and **delete** a server, and list all servers
  with live status.
- **FR-9** A server has exactly one status at a time:
  `stopped → starting → running → stopping → stopped`, with `crashed` reachable from a
  non-zero exit or process error.
- **FR-10** Starting a running server, or stopping a stopped one, is rejected with an error.
- **FR-11** Start uses loader-appropriate launch logic: vanilla/Fabric/Quilt/Paper/Purpur/Folia launch a jar;
  Forge/NeoForge use the generated `run.bat`/`run.sh` and write RAM into
  `user_jvm_args.txt`.
- **FR-12** Stop issues the `stop` console command for a graceful shutdown and force-kills
  the server's whole process tree after 2 minutes (override: `MSM_STOP_GRACE_MS`) if it has not
  exited, logging a warning to the console. Stop completes only when the process is gone.
  Repeated stop requests share one shutdown. A server that exits after a stop request is
  `stopped`, never `crashed`, whatever its exit code.
- **FR-12a** Quitting the app with servers running stops all of them (FR-12) before the app
  exits, cancels pending auto-restarts, and starts no server from then on. With no server
  running, quitting is immediate. This covers every way out: closing the window (where that
  quits the app), quitting, installing an update, the end of the Windows session (shutdown,
  restart, log-off; the app asks Windows to wait) and a system shutdown on Linux and macOS.
  While it waits, the window stays open and shows how many servers are being stopped.
- **FR-12b** When **auto-restart** is enabled, a server that exits with a non-zero code
  (a crash, not an intentional stop) is restarted after a short delay, up to 3 times per
  minute before giving up, with each attempt logged to the console. Stopping, starting or
  deleting the server cancels a restart that is still pending.
- **FR-12c** The user can **restart** a running server: it is stopped (FR-12) and started again
  once its process has exited. Concurrent restart requests for one server are one restart.
  Restarting a stopped server starts it.
- **FR-12d** A server can have a **scheduled restart**: a daily wall-clock time `HH:MM`
  (24-hour, local time zone; `servers.restart_schedule`, null when off). A scheduler in the main
  process checks every 15 seconds. It warns players (`say`) 5 minutes and 1 minute before and
  restarts the server (FR-12c) at the scheduled time. It only acts on a server that is running at
  that moment; an occurrence noticed more than 60 seconds late is skipped; each occurrence is
  handled at most once; a warning whose lead time had already passed by more than 30 seconds when the
  schedule was set is skipped. The schedule keeps its wall-clock time across daylight-saving changes (a time
  that does not exist that day fires once, an hour later). Schedules only run while the app is
  running. The `msmd` daemon applies the same rules on the host's clock.
- **FR-13** Delete stops the server if running, removes its DB row, and deletes its
  directory and its backups. Failure to delete files is logged but does not abort the row
  removal.
- **FR-13a** The user can **back up** a local server on demand. A backup is a zip archive of
  the server directory without the top-level entries `logs`, `crash-reports`, `debug`, `cache`,
  `libraries`, `versions`, `modpack.mrpack` and without `session.lock` files; symbolic links are
  skipped. It is stored under `<userData>/backups/<server id>/<id>.zip`, written as `.part` and
  renamed when complete, and carries a manifest (server, Minecraft version, file count) in the
  zip comment. Archives are streamed, never held in memory, and use zip64 when needed. A backup
  is refused when the free space on the backup volume is below the size of the files plus a
  margin; the check is skipped when the free space cannot be read.
- **FR-13b** A **running** server is backed up consistently: `save-off`, `save-all flush`, wait
  for the server's own confirmation line (chat cannot fake it), copy, then `save-on` (not sent
  if the server answered that saving was already off; sent if the answer was never seen). No confirmation within the time limit fails the backup.
- **FR-13c** The user can **restore** a backup onto a stopped server. The archive is validated
  (no links, no paths outside the server directory, no entries backups do not cover) and
  unpacked to a staging directory beside the server directory; then the covered top-level
  entries are moved aside and the staged ones moved in. A failure moves everything back;
  if that cannot be done, or the replaced files cannot be removed afterwards, they stay in
  `<server dir>.restore-aside`, the error names that folder, and the server cannot be started
  until it is gone. An archive without the app's manifest, with no files, or with a file count
  that differs from its manifest is refused.
  Covered files missing from the backup do not survive (this includes links and files that
  could not be read when the backup was made); uncovered entries are untouched. By
  default a `pre-restore` backup of the current files is made first. After a restore, mods the
  app had on record whose files are no longer there are dropped from the list and the enabled
  flag of the rest follows the files; files the app did not know about are not added.
- **FR-13d** One backup or restore per server at a time. Stop, restart, delete and app exit
  cancel a backup in flight (saving is turned back on before the stop command is sent); a
  restore that has begun replacing files runs to completion first. A server cannot be started
  during a restore, nor during a backup made while it was stopped.

### 4.3 Java resolution

- **FR-14** The app discovers JDKs from `JAVA_HOME`, `PATH`, and common Windows install
  locations, reporting version, major version, and 32/64-bit.
- **FR-15** Required Java major version by Minecraft version: **25** for 26.x, **21** for
  1.20.5–1.21.x, **17** for 1.17–1.20.4, **8** for 1.16.5 and older.
- **FR-16** When no per-server Java path is set, the app picks the best compatible JDK:
  64-bit preferred, then highest major version that meets the minimum. If none qualifies,
  it falls back to `java` on `PATH`.

### 4.4 Configuration

- **FR-17** The user can read and edit `server.properties` through the UI.
- **FR-18** Saving preserves comments and any keys not present in the edit set; new keys are
  appended.
- **FR-19** App-wide settings (e.g. the servers root directory) persist in a key-value store.

### 4.5 Mods

- **FR-20** For non-vanilla servers, the user can search mods on **Modrinth** and
  **CurseForge**, filtered by loader and game version.
- **FR-21** The user can install, uninstall, and enable/disable a mod; installed mods are
  tracked per server.
- **FR-22** Vanilla servers block mod installation and surface guidance to set a loader.
- **FR-22d** Paper, Purpur, and Folia servers load add-ons from `plugins/` instead of `mods/`.
  The server's "Mods" tab is shown as "Plugins" and the browser as "Plugin Browser". Plugins
  come from Modrinth only; CurseForge is disabled for these servers. For Paper and Purpur the
  search matches projects tagged paper, purpur, spigot, or bukkit; for Folia only projects
  tagged folia.

### 4.5b Modpacks

- **FR-22a** The user can search Modrinth modpacks or paste a Modrinth modpack link,
  pick a version, and **deploy** it as a new server in one action.
- **FR-22b** Deploying a `.mrpack` provisions the server with the exact Minecraft
  version and loader the pack pins, downloads the pack's server-relevant files,
  and applies the pack's config overrides. Client-only files are skipped, and any
  path that would escape the server directory is rejected (zip-slip safe). The
  `.mrpack` must be an `https` URL on `cdn.modrinth.com`, and the files it lists are
  only fetched over `https` from `cdn.modrinth.com`, `github.com`,
  `raw.githubusercontent.com` or `gitlab.com` (the hosts of the Modrinth pack format).
- **FR-22c** The server records the modpack it was deployed from (source, project,
  version) so the pack can later be updated.
- *Deferred:* CurseForge modpack deploy and in-app "update to a newer pack version"
  (the model and provenance fields are in place; adding individual mods on top of a
  deployed pack already works through the mod browser).

### 4.6 Runtime diagnostics

- **FR-23** While running, the server streams stdout/stderr to a live console, and the user
  can send commands to stdin.
- **FR-24** While running, the app reports the server's CPU % and memory usage.

### 4.7 Application

- **FR-25** Packaged builds check for and apply updates via an NSIS installer; the user
  confirms installation.
- **FR-26** The UI is a frameless window with custom minimize/maximize/close controls.
- **FR-27** UI strings are localizable (i18next).

## 5. Data model

Persisted in SQLite (see [schema.ts](../src/main/database/schema.ts)).

### `servers`

| Column               | Type    | Notes                                  |
| -------------------- | ------- | -------------------------------------- |
| `id`                 | text PK | UUID v4                                |
| `name`               | text    | user-facing name                       |
| `absolute_path`      | text    | unique; server directory               |
| `minecraft_version`  | text    |                                        |
| `mod_loader`         | text    | nullable; forge/neoforge/fabric/quilt/paper/purpur/folia |
| `mod_loader_version` | text    | nullable                               |
| `java_path`          | text    | nullable; overrides auto-detection     |
| `port`               | int     | default 25565                          |
| `min_ram`/`max_ram`  | text    | e.g. `1G` / `2G`                       |
| `auto_start`         | int     | boolean; default 0                     |
| `jvm_profile`        | text    | `default`/`aikar`; NOT NULL, default `default` |
| `created_at`/`updated_at` | text | ISO 8601                             |

### `installed_mods`

| Column                                 | Type    | Notes                              |
| -------------------------------------- | ------- | ---------------------------------- |
| `id`                                   | text PK | UUID                               |
| `server_id`                            | text FK | → `servers.id`, cascade delete     |
| `source`                               | text    | `curseforge`/`modrinth`/`manual`   |
| `source_project_id`/`source_file_id`   | text    | nullable provider identifiers      |
| `name`/`file_name`                     | text    |                                    |
| `version`                              | text    | nullable                           |
| `enabled`                              | int     | boolean; default 1                 |
| `installed_at`                         | text    | ISO 8601                           |

### `app_settings`

| Column  | Type    | Notes            |
| ------- | ------- | ---------------- |
| `key`   | text PK |                  |
| `value` | text    |                  |

## 6. Key user flows

### Create and run a modded server

1. Open **Create Server**, enter a name and pick a Minecraft version.
2. Choose a mod loader and loader version.
3. Set RAM/port if desired, confirm → jar downloads, loader installs.
4. From the server view, add mods via the Modrinth/CurseForge browser.
5. **Start** → watch the live console; the status chip turns to *Running*.
6. Type `op <player>` or other commands into the console as needed.
7. **Stop** for a graceful shutdown.

### Edit server settings

1. Open the server's **Properties** tab.
2. Change values (difficulty, MOTD, max players, …).
3. Save → `server.properties` is rewritten with comments intact. Restart to apply.

## 7. Non-functional requirements

- **Security** — the renderer runs with `contextIsolation` on and `nodeIntegration` off;
  all privileged actions cross the preload bridge. External links open in the system
  browser, not in-app.
- **Isolation** — each server is confined to its own directory under the servers root.
- **Resilience** — startup migrations are idempotent; a failed directory delete does not
  corrupt the database.
- **Portability of logic** — pure logic (parsing, Java selection, sanitization) is kept free
  of Electron imports so it can be unit-tested and reused.
