# Contributing to Minecraft Server Manager

Thanks for your interest in improving MSM! This guide covers how to get a development
environment running, the project conventions, and how to submit changes.

## Development setup

```bash
git clone https://github.com/wllamasr/minecraft-server-mgr.git
cd minecraft-server-mgr
npm install        # runs electron-builder install-app-deps (rebuilds better-sqlite3)
npm run dev
```

If `better-sqlite3` fails to load after switching Node/Electron versions, rebuild the
native module:

```bash
npm run postinstall
```

## Before you open a pull request

Run the full local check — all three must pass:

```bash
npm run typecheck   # tsc --build across main, preload, and renderer
npm test            # Vitest unit tests
npm run build       # electron-vite production bundle
```

CI runs the same checks on every push and pull request (see
[`.github/workflows/ci.yml`](.github/workflows/ci.yml)).

## Project layout

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for a full tour. In short:

- `src/main` — Node-side logic. Never import Electron-only modules into code you want to
  unit test; keep pure logic in small, dependency-light functions.
- `src/preload` — the **only** bridge between renderer and main. Every new capability the
  UI needs must be added here and backed by an IPC handler in `src/main/ipc`.
- `src/renderer` — React UI. Routes live in `src/renderer/src/routes` (file-based, via
  TanStack Router). Do not touch `routeTree.gen.ts` by hand — it is generated.
- `src/shared` — types and constants imported by more than one process.

### Adding an IPC endpoint

1. Add the channel name to `src/shared/constants/ipc-channels.ts`.
2. Register a handler in `src/main/ipc/index.ts`.
3. Expose a typed method on `window.api` in `src/preload/index.ts`.
4. Document it in [docs/IPC.md](docs/IPC.md).

## Testing

- Tests use **Vitest** and live next to the code as `*.test.ts`.
- Prefer testing pure functions with no Electron dependency. When a module transitively
  imports the Electron-based logger, mock it:

  ```ts
  vi.mock('../utils/logger', () => ({
    default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  }))
  ```

- Run a single file: `npx vitest run src/main/services/java-detector.test.ts`.

## Coding style

- **TypeScript strict mode** is on. Avoid `any`; if an external type is genuinely missing,
  isolate the cast and add a short comment explaining why.
- Match the existing style of the file you are editing (naming, spacing, comment density).
- Keep the renderer free of Node APIs — go through `window.api`.

## Commit messages

This project follows [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(mods): add Quilt loader version resolution
fix(ipc): return null instead of throwing when a server is missing
docs(readme): document the packaging steps
```

Common types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`.

## Reporting bugs

Open an issue with:

- OS and app version (`npm run dev` prints the version on startup).
- Steps to reproduce.
- Relevant log output. Logs are written by `electron-log` — on Windows they live under
  `%APPDATA%/minecraft-server-manager/logs`.

## License

By contributing, you agree that your contributions will be licensed under the project's
[MIT License](LICENSE).
