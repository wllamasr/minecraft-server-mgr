# Minecraft Server Manager

> **Command Core** — a desktop app for creating, running, and managing local Minecraft servers on Windows.

[![CI](https://github.com/wllamasr/minecraft-server-mgr/actions/workflows/ci.yml/badge.svg)](https://github.com/wllamasr/minecraft-server-mgr/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Electron](https://img.shields.io/badge/Electron-45-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)

Minecraft Server Manager (MSM) turns the tedious, terminal-driven chore of running a
Minecraft server into a point-and-click experience. Download a server jar, pick a mod
loader, tweak `server.properties`, watch the live console, and monitor CPU/RAM — all
from a single window. No batch scripts, no manual EULA edits.

## ✨ Features

- **Server lifecycle** — create, start, stop, and delete servers. The vanilla `server.jar`
  is downloaded straight from Mojang's official version manifest and the EULA is accepted
  for you.
- **Mod loaders** — install **Forge**, **NeoForge**, **Fabric**, or **Quilt** with the
  correct launch logic per loader.
- **Plugin platforms** — run **Paper**, **Purpur**, or **Folia** (aimed at large player
  counts), locally or on remote hosts (`msmd`). Builds are chosen in the wizard and verified
  against the project's published checksum. An optional "Optimized JVM flags" profile applies
  Aikar's G1GC flags. Plugin management in the app is local-only.
- **Mod, plugin & modpack management** — search and install mods from **Modrinth** and
  **CurseForge** (plugins from Modrinth only), toggle them on/off, and remove them.
- **Live console** — real-time log streaming with command input, straight to the server's stdin.
- **Telemetry** — per-server CPU, memory, players online and tick time (Minecraft 1.20.3+) while
  it runs, for local servers and for servers on remote hosts.
- **Smart Java detection** — scans `JAVA_HOME`, `PATH`, and common install locations and
  picks the best JDK for the target Minecraft version (Java 8 / 17 / 21 / 25).
- **`server.properties` editor** — edit settings through the UI; comments in the file are
  preserved on save.
- **Auto-updates** — packaged builds update themselves via an NSIS installer.
- **Internationalization** — UI strings are driven by i18next.
- **Remote hosts** — pair with the `msmd` daemon on another machine to deploy and control
  servers there (early stage; see the [daemon docs](daemon/README.md)).

## 🖥️ Tech stack

| Layer            | Technology                                             |
| ---------------- | ------------------------------------------------------ |
| Shell            | Electron 45 (frameless, custom title bar)              |
| UI               | React 19 + Mantine UI 9 + Tabler Icons                 |
| Routing / data   | TanStack Router + TanStack Query                       |
| Build            | electron-vite + electron-builder                       |
| Persistence      | SQLite (better-sqlite3) + Drizzle ORM                  |
| Testing          | Vitest (unit) + Playwright (end-to-end UI)             |
| Remote agent     | `msmd`, a dependency-free Go daemon (`daemon/`)         |
| Language         | TypeScript (strict)                                    |

## 🚀 Getting started

### Prerequisites

- **Node.js 24 LTS** with npm 11 (CI runs on Node 24; Node 22.22.2+ also satisfies `engines`).
  No C++ toolchain is required.
- **A Java runtime** to actually run servers — Java 25 for Minecraft 26.x, Java 21 for
  1.20.5–1.21.x, Java 17 for 1.17–1.20.4, Java 8 for 1.16.5 and older. The app detects installed JDKs and links to
  [Adoptium](https://adoptium.net/) if none is found.
- **Windows** — packaging targets Windows (NSIS). Development also runs on the other
  platforms Electron supports.

### Install & run (development)

```bash
git clone https://github.com/wllamasr/minecraft-server-mgr.git
cd minecraft-server-mgr
npm ci
npm run dev
```

`npm run dev` starts electron-vite with hot-module reload for the renderer.

### Build & package

```bash
npm run build      # bundle main / preload / renderer into out/ (no type-check; run npm run typecheck)
npm run package    # build + produce a Windows installer via electron-builder
```

## 🧰 Scripts

| Script               | What it does                                             |
| -------------------- | ------------------------------------------------------- |
| `npm run dev`        | Launch the app in development with HMR                   |
| `npm run build`      | Bundle main, preload, and renderer into `out/`          |
| `npm run package`    | Build and produce a Windows installer                   |
| `npm run typecheck`  | Full TypeScript project build (`tsc --build`)            |
| `npm test`           | Run the Vitest unit tests once                          |
| `npm run test:watch` | Run Vitest in watch mode                                |
| `npm run test:e2e`   | Build, then run the Playwright UI tests against the real app |
| `npm run check`      | Type-check, unit tests, and UI tests in one go          |
| `npm run db:generate`| Generate Drizzle migrations from the schema             |

## 📁 Project structure

```
src/
├── main/            # Electron main process (Node)
│   ├── database/    # Drizzle schema, client, and migrations
│   ├── ipc/         # IPC handler registration
│   ├── services/    # Business logic (servers, mods, java, telemetry, ...)
│   └── utils/       # Paths, downloads, logging
├── preload/         # contextBridge — the typed `window.api` surface
├── renderer/        # React UI (routes, components, theme, i18n)
└── shared/          # Types and constants shared across processes
```

## ✅ Testing & CI

Every push and pull request runs one pipeline ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)):

| Job | What it checks |
| --- | --- |
| **Desktop app (Windows)** | Type-check, Vitest unit tests, production build, and Playwright tests that launch the built app, walk every page, and verify the security boundaries (preload-only bridge, CSP, URL filtering). |
| **Daemon** (Linux on the minimum and latest Go, plus Windows) | `gofmt`, `go vet`, unit tests with the race detector, cross-compilation, and a smoke test that runs the real binary over TLS and asserts on auth, pairing, and the API. |
| **CI passed** | Single summary status to require in branch protection. |

Run the same checks locally with `npm run check` and, in `daemon/`, `go test ./... && make smoke`.

## 📚 Documentation

- [User guide](docs/USER_GUIDE.md) — install, create servers, mods, troubleshooting.
- [Architecture](docs/ARCHITECTURE.md) — process model, data flow, and how the pieces fit.
- [Specification](docs/SPEC.md) — functional spec, data model, and user flows.
- [IPC contract](docs/IPC.md) — every channel and event between main and renderer.
- [Remote daemon (RFC)](docs/DAEMON.md) — design for managing servers on remote hosts.
- [Daemon (`daemon/`)](daemon/README.md) — the Go agent (Phase B MVP): build, run, and test it.
- [Design system](DESIGN.md) — the "Command Core" visual language.
- [Contributing](CONTRIBUTING.md) — how to set up, test, and submit changes.

## 🗺️ Status & roadmap

MSM is under active development. Core server management, mod loaders, mods, console, and
telemetry are implemented. Areas open for contribution:

- Automated tests for the mod-manager and server-manager services (currently only pure
  helpers are covered).
- World import & export, copying backups off a remote host.
- Crash-recovery policies.
- Cross-platform packaging (macOS / Linux).

## 🤝 Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Please open an issue to
discuss substantial changes before starting. All participants follow the
[Code of Conduct](CODE_OF_CONDUCT.md).

To report a security vulnerability, do not open a public issue; follow [SECURITY.md](SECURITY.md).

## 📄 License

[MIT](LICENSE) © Wilmer Llamas

---

*Not affiliated with Mojang or Microsoft. "Minecraft" is a trademark of Mojang AB.*
