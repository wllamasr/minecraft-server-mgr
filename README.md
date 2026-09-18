# Minecraft Server Manager

> **Command Core** — a desktop app for creating, running, and managing local Minecraft servers on Windows.

[![CI](https://github.com/wllamasr/minecraft-server-mgr/actions/workflows/ci.yml/badge.svg)](https://github.com/wllamasr/minecraft-server-mgr/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Electron](https://img.shields.io/badge/Electron-44-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)

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
- **Mod & modpack management** — search and install mods from **Modrinth** and **CurseForge**,
  toggle them on/off, and remove them.
- **Live console** — real-time log streaming with command input, straight to the server's stdin.
- **Resource telemetry** — per-server CPU and memory usage while it runs.
- **Smart Java detection** — scans `JAVA_HOME`, `PATH`, and common install locations and
  picks the best JDK for the target Minecraft version (Java 8 / 17 / 21).
- **`server.properties` editor** — edit settings through the UI; comments in the file are
  preserved on save.
- **Auto-updates** — packaged builds update themselves via an NSIS installer.
- **Internationalization** — UI strings are driven by i18next.

## 🖥️ Tech stack

| Layer            | Technology                                             |
| ---------------- | ------------------------------------------------------ |
| Shell            | Electron 44 (frameless, custom title bar)              |
| UI               | React 19 + Mantine UI 9 + Tabler Icons                 |
| Routing / data   | TanStack Router + TanStack Query                       |
| Build            | electron-vite (Vite 7) + electron-builder              |
| Persistence      | SQLite (better-sqlite3) + Drizzle ORM                  |
| Testing          | Vitest                                                 |
| Language         | TypeScript (strict)                                    |

## 🚀 Getting started

### Prerequisites

- **Node.js 18+** (developed on Node 24).
- **A Java runtime** to actually run servers — Java 21 for Minecraft 1.20.5+, Java 17 for
  1.17–1.20, Java 8 for older releases. The app detects installed JDKs and links to
  [Adoptium](https://adoptium.net/) if none is found.
- **Windows** — packaging targets Windows (NSIS). Development also runs on the other
  platforms Electron supports.

### Install & run (development)

```bash
git clone https://github.com/wllamasr/minecraft-server-mgr.git
cd minecraft-server-mgr
npm install
npm run dev
```

`npm run dev` starts electron-vite with hot-module reload for the renderer.

### Build & package

```bash
npm run build      # type-check-free bundle of main / preload / renderer into out/
npm run package    # build + produce a Windows installer via electron-builder
```

## 🧰 Scripts

| Script               | What it does                                             |
| -------------------- | ------------------------------------------------------- |
| `npm run dev`        | Launch the app in development with HMR                   |
| `npm run build`      | Bundle main, preload, and renderer into `out/`          |
| `npm run package`    | Build and produce a Windows installer                   |
| `npm run typecheck`  | Full TypeScript project build (`tsc --build`)            |
| `npm test`           | Run the Vitest suite once                               |
| `npm run test:watch` | Run Vitest in watch mode                                |
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

## 📚 Documentation

- [Architecture](docs/ARCHITECTURE.md) — process model, data flow, and how the pieces fit.
- [Specification](docs/SPEC.md) — functional spec, data model, and user flows.
- [IPC contract](docs/IPC.md) — every channel and event between main and renderer.
- [Design system](DESIGN.md) — the "Command Core" visual language.
- [Contributing](CONTRIBUTING.md) — how to set up, test, and submit changes.

## 🗺️ Status & roadmap

MSM is under active development. Core server management, mod loaders, mods, console, and
telemetry are implemented. Areas open for contribution:

- Automated tests for the mod-manager and server-manager services (currently only pure
  helpers are covered).
- Backup / world import & export.
- Scheduled restarts and crash-recovery policies.
- Cross-platform packaging (macOS / Linux).

## 🤝 Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Please open an issue to
discuss substantial changes before starting.

## 📄 License

[MIT](LICENSE) © Wilmer Llamas

---

*Not affiliated with Mojang or Microsoft. "Minecraft" is a trademark of Mojang AB.*
