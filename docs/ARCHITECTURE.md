# Architecture

Minecraft Server Manager is an Electron application. Like every Electron app it runs in
three cooperating contexts, and MSM keeps a strict separation between them.

```
┌──────────────────────────────────────────────────────────────────────┐
│                          Electron application                          │
│                                                                        │
│  ┌────────────────┐    contextBridge     ┌──────────────────────────┐  │
│  │  Renderer      │  window.api (typed)  │  Preload                 │  │
│  │  (React UI)    │ ───────────────────▶ │  src/preload/index.ts    │  │
│  │  Chromium      │ ◀─────────────────── │  ipcRenderer.invoke/on   │  │
│  └────────────────┘   events (Main→UI)   └────────────┬─────────────┘  │
│                                                        │ IPC            │
│                                          ┌─────────────▼─────────────┐  │
│                                          │  Main process (Node)      │  │
│                                          │  ipc → services → utils   │  │
│                                          │  SQLite · child_process   │  │
│                                          └───────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
```

## Processes

### Main (`src/main`)

The Node.js side. It owns everything privileged: the filesystem, the SQLite database,
spawning `java` child processes, and network downloads. It has no direct knowledge of the
UI; it only responds to IPC requests and broadcasts events.

Entry point: [`src/main/index.ts`](../src/main/index.ts) — creates the frameless
`BrowserWindow`, runs database migrations, registers IPC handlers, and (in production)
starts the auto-updater.

**Services** (`src/main/services`) hold the business logic:

| Service                 | Responsibility                                                        |
| ----------------------- | -------------------------------------------------------------------- |
| `server-manager`        | Server CRUD, jar download, spawning/stopping the Java process        |
| `config-manager`        | Read/write `server.properties`; app settings key-value store         |
| `console-manager`       | Buffers server stdout/stderr, forwards commands to stdin             |
| `telemetry-manager`     | Samples CPU/RAM of a running server via `pidusage`                   |
| `java-detector`         | Discovers JDKs and picks the best one per Minecraft version          |
| `mod-loader-installer`  | Installs Forge / NeoForge / Fabric / Quilt                           |
| `mod-manager`           | Unifies Modrinth + CurseForge search/install/uninstall              |
| `modrinth`, `curseforge`| Provider-specific API clients                                        |
| `properties-parser`     | Comment-preserving `server.properties` (de)serialization             |
| `auto-updater`          | electron-updater integration                                        |

**Utils** (`src/main/utils`): `paths` (server directory resolution + name sanitization),
`download` (streamed HTTP download with progress + redirect handling), `logger`
(electron-log wrapper).

### Preload (`src/preload`)

The security boundary. `contextIsolation` is **on** and `nodeIntegration` is **off**, so
the renderer cannot touch Node directly. [`src/preload/index.ts`](../src/preload/index.ts)
exposes a single frozen object, `window.api`, whose methods wrap `ipcRenderer.invoke`
(request/response) and `ipcRenderer.on` (event subscriptions). The exported `ElectronAPI`
type is the contract the renderer codes against.

### Renderer (`src/renderer`)

A standard React 19 SPA served by Vite. It never imports Node modules — all side effects go
through `window.api`. Structure:

- `routes/` — file-based routes (TanStack Router). `routeTree.gen.ts` is generated at build
  time by the router Vite plugin.
- `components/` — layout (title bar, sidebar, status bar) and feature components (console,
  mods, properties editor).
- `components/theme/` + `styles/` — the "Command Core" Mantine theme.
- `i18n/` — i18next setup and locale JSON.

Server state (lists, status, mods) is fetched and cached with TanStack Query; live data
(logs, status changes, telemetry) arrives via `window.api.on*` event subscriptions.

## Data flow: starting a server

1. User clicks **Start** → `window.api.startServer(id)` (renderer).
2. Preload forwards it as `ipcRenderer.invoke('server:start', id)`.
3. The IPC handler calls `serverManager.startServer(id)`.
4. `server-manager` looks up the server row, resolves Java, and `spawn`s the process with
   the right args for the loader.
5. `console-manager` attaches to stdout/stderr; `telemetry-manager` begins sampling.
6. Status transitions (`starting → running → stopped/crashed`) are broadcast to every
   window via `event:server-status-changed`; logs stream via `event:server-log`.
7. The renderer's subscriptions update the UI in real time.

See [IPC.md](IPC.md) for the full channel and event catalog.

## Persistence

SQLite lives at `%APPDATA%/minecraft-server-manager/data/minecraft-server-manager.db`
(WAL mode, foreign keys on). Two access paths share the same file:

- [`database/client.ts`](../src/main/database/client.ts) — a lazily-initialized Drizzle
  instance used by services for typed queries.
- [`database/migrate.ts`](../src/main/database/migrate.ts) — idempotent
  `CREATE TABLE IF NOT EXISTS` statements run at startup. This avoids shipping Drizzle Kit
  migration files inside a packaged app.

The schema ([`database/schema.ts`](../src/main/database/schema.ts)) defines three tables:
`servers`, `installed_mods`, and `app_settings`. See [SPEC.md](SPEC.md#data-model) for the
column-level model.

Server files themselves live outside the database, under a configurable servers root
(default `%APPDATA%/minecraft-server-manager/servers/<sanitized-name>`), one directory per
server.

## Build & packaging

`electron-vite` bundles the three targets independently (see
[`electron.vite.config.ts`](../electron.vite.config.ts)). `better-sqlite3` is marked
external and native-rebuilt for Electron via `electron-builder install-app-deps`.
`electron-builder` ([`electron-builder.yml`](../electron-builder.yml)) produces the Windows
NSIS installer, which the in-app auto-updater consumes.
