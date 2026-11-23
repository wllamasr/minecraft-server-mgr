# Contributing to Minecraft Server Manager

Thanks for helping improve MSM! This guide explains how to set up a development environment,
the checks every change must pass, and how we review and merge work.

By participating you agree to abide by the [Code of Conduct](CODE_OF_CONDUCT.md).

## Ground rules

- **Discuss first.** For anything beyond a small fix, open an issue (or a discussion) and agree
  on the approach before writing code. Pull requests that arrive without prior discussion for a
  large change may be asked to split up or wait.
- **Security issues are private.** Never report vulnerabilities in a public issue or PR. Follow
  [SECURITY.md](SECURITY.md).
- **One concern per pull request.** Keep changes focused; avoid unrelated refactors.
- **Every change is reviewed.** `main` is protected: changes land through a pull request that
  passes CI and has an approving review from the code owner (see [`.github/CODEOWNERS`](.github/CODEOWNERS)).
  Direct pushes to `main` are reserved for the maintainer.

## Requirements

| Tool      | Version                              |
| --------- | ------------------------------------ |
| Node.js   | 20 LTS or newer (CI uses 20)         |
| npm       | Bundled with Node.js                 |
| Go        | 1.22 or newer (daemon work only)     |
| Java      | 21 (to run servers during manual testing) |
| OS        | Windows 10/11 for the Electron app; Linux for the daemon |

## Development setup

```bash
git clone https://github.com/wllamasr/minecraft-server-mgr.git
cd minecraft-server-mgr
npm ci             # reproducible install from package-lock.json
npm run dev
```

`npm ci` runs `electron-builder install-app-deps`, which rebuilds the native `better-sqlite3`
module. If it fails to load after switching Node or Electron versions, run:

```bash
npm run postinstall
```

Electron downloads its binary during install. If it is missing (`Error: Electron uninstall`),
run `node node_modules/electron/install.js`.

### Daemon (Go)

```bash
cd daemon
go vet ./...
go test ./...
make build       # pure Go, CGO_ENABLED=0
```

See [daemon/README.md](daemon/README.md) and [daemon/TESTING.md](daemon/TESTING.md) for running it.

## Before you open a pull request

All of these must pass locally. CI runs the same checks.

```bash
# Electron app
npm run typecheck   # tsc --build across main, preload and renderer
npm test            # Vitest unit tests
npm run build       # electron-vite production bundle

# Daemon (only if daemon/ changed)
cd daemon && go vet ./... && go test ./...
```

## Project layout

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for a full tour. In short:

- `src/main` — Node-side logic. Keep pure logic in small, dependency-light functions so it can be
  unit tested without Electron.
- `src/preload` — the **only** bridge between renderer and main. Every new capability the UI
  needs must be added here and backed by an IPC handler in `src/main/ipc`.
- `src/renderer` — React UI. Routes live in `src/renderer/src/routes` (file-based, via TanStack
  Router). Do not edit `routeTree.gen.ts` by hand — it is generated.
- `src/shared` — types and constants imported by more than one process.
- `daemon/` — the `msmd` Go agent for managing servers on remote hosts. See [docs/DAEMON.md](docs/DAEMON.md).

### Adding an IPC endpoint

1. Add the channel name to `src/shared/constants/ipc-channels.ts`.
2. Register a handler in `src/main/ipc/index.ts`.
3. Expose a typed method on `window.api` in `src/preload/index.ts`.
4. Document it in [docs/IPC.md](docs/IPC.md).

## Security rules for contributions

These are hard requirements; reviewers will request changes if they are not met.

- The renderer must not use Node APIs. Go through `window.api`.
- Keep `contextIsolation: true` and `nodeIntegration: false` on every `BrowserWindow`.
- Never execute shell strings built from user input. Spawn processes with an argument array.
- Validate all paths that originate from the renderer or the network; stay within the server's
  data directory.
- Never log tokens, passwords, or the daemon's API token.
- Do not commit secrets, `.env` files, local databases, or built binaries (`out/`, `dist/`, `msmd-data/`).
- Do not add a dependency without a clear reason. Prefer maintained, widely used packages and
  state the reason in the PR.

## Testing

- Tests use **Vitest** and live next to the code as `*.test.ts`. Go tests use `go test`.
- Prefer testing pure functions with no Electron dependency. When a module transitively imports
  the Electron-based logger, mock it:

  ```ts
  vi.mock('../utils/logger', () => ({
    default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  }))
  ```

- Run a single file: `npx vitest run src/main/services/java-detector.test.ts`.
- Bug fixes should include a regression test whenever practical.

## Coding style

- **TypeScript strict mode** is on. Avoid `any`; if an external type is genuinely missing, isolate
  the cast and add a short comment explaining why.
- Go code must be `gofmt`-formatted (`make fmt`).
- Match the existing style of the file you are editing (naming, spacing, comment density).
- Documentation is written in **English**.

## Commit messages

This project follows [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(mods): add Quilt loader version resolution
fix(ipc): return null instead of throwing when a server is missing
docs(readme): document the packaging steps
```

Common types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `ci`, `build`.
Use the scope of the area you changed (`servers`, `mods`, `daemon`, `ipc`, `ci`, ...).

## Dependencies

- Dependabot opens weekly update PRs for npm, Go modules, and GitHub Actions. Minor and patch
  updates are grouped.
- Major upgrades (Electron, Vite tooling, React ecosystem) must be verified with the full local
  check list above, and the PR must describe what was tested beyond CI, especially on Windows.
- `npm audit` findings that only affect development tooling (for example `esbuild` through
  `drizzle-kit`, or `minimatch` through `electron-builder`) are tracked; fixing them with
  `npm audit fix --force` would downgrade build tools and is not done without a reviewed plan.

## Pull request review

1. CI must be green (typecheck, tests, and build for the app; vet, test, and cross-compile for the daemon).
2. The code owner reviews the change. Expect requests for changes on style, scope, and tests.
3. Squash-merge is preferred so `main` keeps one Conventional Commit per change.

## Reporting bugs

Use the **Bug report** template. Include:

- OS, app version, and Java version.
- Steps to reproduce.
- Relevant log output. Logs are written by `electron-log` — on Windows they live under
  `%APPDATA%\minecraft-server-manager\logs`.

## License

By contributing, you agree that your contributions will be licensed under the project's
[MIT License](LICENSE).
