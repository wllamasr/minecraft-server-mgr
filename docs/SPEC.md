# Functional Specification

This document describes **what** Minecraft Server Manager (MSM) does, independent of how it
is implemented. For the *how*, see [ARCHITECTURE.md](ARCHITECTURE.md).

## 1. Purpose & scope

MSM is a single-user desktop application for creating and operating **local** Minecraft:
Java Edition servers on a personal machine. It manages multiple server instances, their
mods, configuration, runtime lifecycle, and live diagnostics.

Out of scope: remote/headless server orchestration, Bedrock edition, proxy networks
(BungeeCord/Velocity), and multi-user access control.

## 2. Personas

- **Casual host** — wants to spin up a vanilla or modded world for friends without touching
  a terminal.
- **Modpack tinkerer** — assembles a server around Forge/Fabric mods and iterates on config.

## 3. Definitions

| Term          | Meaning                                                                    |
| ------------- | -------------------------------------------------------------------------- |
| Server        | One managed Minecraft server instance with its own directory and DB row.   |
| Mod loader    | Forge, NeoForge, Fabric, or Quilt — the runtime that loads mods.           |
| Vanilla       | A server with no mod loader.                                               |
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
  for the chosen version. An unknown version is rejected.
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
- **FR-11** Start uses loader-appropriate launch logic: vanilla/Fabric/Quilt launch a jar;
  Forge/NeoForge use the generated `run.bat`/`run.sh` and write RAM into
  `user_jvm_args.txt`.
- **FR-12** Stop issues the `stop` console command for a graceful shutdown and force-kills
  after 30 seconds if the process has not exited.
- **FR-12b** When **auto-restart** is enabled, a server that exits with a non-zero code
  (a crash, not an intentional stop) is restarted after a short delay, up to 3 times per
  minute before giving up, with each attempt logged to the console.
- **FR-13** Delete stops the server if running, removes its DB row, and deletes its
  directory. Failure to delete files is logged but does not abort the row removal.

### 4.3 Java resolution

- **FR-14** The app discovers JDKs from `JAVA_HOME`, `PATH`, and common Windows install
  locations, reporting version, major version, and 32/64-bit.
- **FR-15** Required Java major version by Minecraft version: **21** for 1.20.5+/1.21+,
  **17** for 1.17–1.20, **8** for older.
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
| `mod_loader`         | text    | nullable; forge/neoforge/fabric/quilt  |
| `mod_loader_version` | text    | nullable                               |
| `java_path`          | text    | nullable; overrides auto-detection     |
| `port`               | int     | default 25565                          |
| `min_ram`/`max_ram`  | text    | e.g. `1G` / `2G`                       |
| `auto_start`         | int     | boolean; default 0                     |
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
