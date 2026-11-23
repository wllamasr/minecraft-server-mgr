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
- **Every change is reviewed.** Contributions land through a pull request that passes the
  **CI passed** check and is reviewed by the code owner (see [`.github/CODEOWNERS`](.github/CODEOWNERS)).
  Only the maintainer pushes to `main` directly.

## Requirements

| Tool      | Version                                                        |
| --------- | -------------------------------------------------------------- |
| Node.js   | 24 LTS (CI uses 24). 22.22.2+ also satisfies `engines`.          |
| npm       | 11 or newer (bundled with Node.js 24)                          |
| Go        | 1.22 or newer (daemon work only)                               |
| Java      | 21 (to run servers during manual testing)                      |
| OS        | Windows 10/11 for the Electron app; Linux or Windows for the daemon |

No C++ toolchain is needed: `better-sqlite3` ships prebuilt binaries.

## Development setup

```bash
git clone https://github.com/wllamasr/minecraft-server-mgr.git
cd minecraft-server-mgr
npm ci             # reproducible install from package-lock.json
npm run dev
```

`npm ci` finishes by running `install-electron` (the project's `postinstall`), which downloads
the Electron binary. If Electron is missing afterwards (`Error: Electron uninstall`), run
`npm run postinstall` again.

Install scripts of dependencies are reviewed and listed in the `allowScripts` field of
`package.json`. `better-sqlite3` is set to `false` there on purpose: its bundled prebuilt
binary is used, so its `node-gyp` build is skipped. With an npm older than 11 that field is
ignored and the build needs Visual Studio's C++ workload.

### Daemon (Go)

```bash
cd daemon
go vet ./...
go test ./...
make build       # pure Go, CGO_ENABLED=0
make smoke       # builds the binary, runs it over TLS and checks the API (needs curl)
```

See [daemon/README.md](daemon/README.md) and [daemon/TESTING.md](daemon/TESTING.md) for running it.

## Before you open a pull request

All of these must pass locally. CI runs the same checks.

```bash
# Electron app
npm run typecheck   # tsc --build across main, preload and renderer
npm test            # Vitest unit tests
npm run test:e2e    # production build + Playwright tests against the real app

# Daemon (only if daemon/ changed)
cd daemon && gofmt -l . && go vet ./... && go test ./... && make smoke
```

`npm run check` runs the three app commands in order.

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
- Never inject third-party HTML without `sanitizeRemoteHtml`, and do not weaken the renderer's
  Content-Security-Policy (`RENDERER_CSP` in `electron.vite.config.ts`). The renderer does not call
  remote APIs itself (`connect-src 'self'`); fetch through the main process.
- Never pass a filesystem path from the renderer to a privileged operation; pass a server id and
  resolve the path in the main process.
- Only `http(s)` URLs may reach `shell.openExternal` (use `isSafeExternalUrl`).
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
- Tests that need a DOM opt in per file with `// @vitest-environment jsdom`.
- **UI tests** live in `e2e/` and use Playwright to launch the built Electron app with a
  temporary profile (`--user-data-dir`), so they never touch your real servers or database.
  They need no browser download. Add a test there when you add a page or change the preload
  bridge. Keep them independent of the network.
- **Live end-to-end test** (`e2e/live/paper-server.spec.ts`) creates a real Paper server through
  the wizard, boots it with the optimized JVM flags, installs a plugin from Modrinth, and stops
  it; it also provisions a Purpur server and checks that every engine lists its versions. It needs network access and Java 21, is
  skipped unless `MSM_E2E_LIVE=1`, and never runs in CI. Run it with `npm run build`, then
  (PowerShell):

  ```powershell
  $env:MSM_E2E_LIVE = '1'; npx playwright test e2e/live
  ```

  Optional environment variables: `MSM_E2E_LIVE_MC` (Minecraft version, default `1.21.11`) and
  `MSM_E2E_LIVE_PORT` (server port, default `25599`; the next port is used too).
- **Daemon end-to-end checks** live in `daemon/scripts/smoke.sh`. Every check must assert
  (exit non-zero on failure), not just print.
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

1. CI must be green. One workflow ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs on
   every push and pull request: the **Desktop app** job (type-check, unit tests, build, end-to-end
   UI tests on Windows) and the **Daemon** jobs (gofmt, vet, race-enabled tests, cross-compile,
   smoke test on Linux and Windows). **CI passed** summarizes them.
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
