# Remote Daemon — Design Document

> Status: **Design / RFC.** This document proposes how Minecraft Server Manager
> (MSM) will manage servers running on *remote* hosts through a lightweight agent
> ("the daemon"), in addition to the local servers it manages today.
>
> **Phase B (daemon MVP) is implemented** in [`../daemon/`](../daemon/): a Go
> agent with server lifecycle, live console over TLS, and token auth. See
> [daemon/README.md](../daemon/README.md) to build, run, and test it. The
> manager-side integration (Phases A/C) is still to come.

## 1. Motivation

Today MSM manages only servers on the same machine: the Electron **main process**
spawns `java`, downloads jars, and reads files directly (see
[ARCHITECTURE.md](ARCHITECTURE.md)). Many people run their actual Minecraft
servers on a VPS, a home server, or a spare box. The goal is to manage those the
same way as local ones — create, start/stop, edit config, install mods, watch the
console and telemetry — from the same desktop app.

We do this by installing a small **daemon** on the remote host that exposes a
secure API. The manager talks to that API instead of touching local files and
processes.

### Goals

- Manage remote servers with the same feature set as local ones.
- One daemon per host, managing many servers on that host.
- Secure by default: encrypted transport, authenticated, least privilege.
- Trivial to deploy: a single static binary + a service unit.
- The local experience is unchanged; "local" becomes just one kind of host.

### Non-goals (for v1)

- Multi-user accounts / RBAC (single owner per manager install).
- Orchestrating a cluster / load balancing across hosts.
- Proxy networks (Velocity/BungeeCord) awareness.
- Managing non-Minecraft workloads.

## 2. Language choice — Go (recommended)

| Criterion | Go | Rust |
| --- | --- | --- |
| Single static binary, easy cross-compile (linux/win, amd64/arm64) | ✅ first-class (`GOOS`/`GOARCH`) | ✅ (needs targets/toolchain) |
| Process management & concurrency (spawn, stream stdout, many servers) | ✅ goroutines + `os/exec` | ✅ but more ceremony (async runtime) |
| HTTP/TLS/WebSocket in stdlib | ✅ `net/http`, `crypto/tls` | ⚠️ crates (axum/tokio/rustls) |
| systemd / Windows service integration | ✅ mature | ✅ |
| Memory safety | GC, safe enough for an agent | ✅ strongest |
| Development velocity for this scope | ✅ high | ⚠️ slower |
| Binary size / footprint | small | smallest |

**Decision: Go.** The daemon is I/O-bound glue (spawn processes, stream logs,
download files, serve an API). Go's standard library covers all of it, cross-
compilation is a single command, and the process/goroutine model is a natural fit.
Rust's extra safety does not outweigh the added friction for this workload. We
revisit only if a hot path proves CPU-bound (it should not).

## 3. High-level architecture

```
┌──────────────────────────────┐         TLS (HTTPS + WSS)        ┌───────────────────────────────┐
│  MSM Manager (Electron)       │  ───────────────────────────▶   │  msmd (Go daemon) — remote host │
│                               │      REST for commands          │                                 │
│  Renderer (React)             │      WebSocket for streams      │  HTTP API  ── auth ── handlers  │
│      │ window.api             │  ◀───────────────────────────   │      │                          │
│  Main process                 │      events: logs, status,      │  server engine (spawn java,     │
│   ServerProvider (interface)  │             telemetry           │   download jars, install        │
│    ├─ LocalProvider  (today)  │                                 │   loaders, edit properties)     │
│    └─ RemoteProvider (new) ───┼────────────▶                    │  SQLite (its own server list)   │
│  hosts table + token vault    │                                 │  data dir /var/lib/msmd         │
└──────────────────────────────┘                                 └───────────────────────────────┘
```

The daemon is, essentially, the current `src/main/services` layer re-implemented in
Go and put behind an authenticated network API. The manager keeps its services for
local hosts and adds a network client for remote ones.

## 4. Manager-side design

### 4.1 Provider abstraction

Introduce a `ServerProvider` interface that both a local and a remote
implementation satisfy. The IPC handlers call the provider for the server's host
instead of calling `server-manager` directly.

```ts
interface ServerProvider {
  listServers(): Promise<ServerWithStatus[]>
  createServer(input: CreateServerInput): Promise<ServerInstance>   // async provisioning
  startServer(id: string): Promise<void>
  stopServer(id: string): Promise<void>
  deleteServer(id: string): Promise<void>
  readProperties(id: string): Promise<Record<string, string>>
  writeProperties(id: string, props: Record<string, string>): Promise<void>
  sendCommand(id: string, command: string): Promise<boolean>
  // streams surface through the existing event channels (server-log, status, telemetry)
  subscribe(id: string, sink: EventSink): Unsubscribe
}
```

- **LocalProvider** wraps the existing services (a thin adapter; no behavior change).
- **RemoteProvider** is an HTTP/WebSocket client for one daemon.

This refactor is **Phase A** and ships with zero user-visible change — it just makes
"where a server runs" a first-class concept.

### 4.2 Data model additions

```
hosts
  id            text pk
  name          text                -- user label, e.g. "Hetzner VPS"
  kind          text                -- 'local' | 'remote'
  base_url      text                -- https://host:8443 (null for local)
  tls_fpr       text                -- pinned certificate SHA-256 (TOFU)
  token_ref     text                -- key into the OS secret store, never the token itself
  agent_version text
  status        text                -- 'online' | 'offline' | 'unauthorized' | 'unreachable'
  created_at    text

servers  -- gains:
  host_id       text  references hosts(id)   -- 'local' host seeded on first run
```

A `local` host row is seeded at startup so existing servers attach to it.

### 4.3 Secrets

The daemon token is **never** stored in the SQLite DB or in plaintext. It is kept
in the OS secret store via Electron's `safeStorage` (DPAPI on Windows, Keychain on
macOS, libsecret on Linux). The DB stores only a reference/handle.

### 4.4 UI

- A **host switcher** in the sidebar/fleet view; servers show a host badge.
- **Add Remote Host** flow: enter `host:port` + a pairing token (printed by the
  daemon installer). The manager fetches the daemon's TLS cert, shows its
  fingerprint for confirmation (TOFU), stores it pinned, and verifies the token.
- Host health indicator (online/offline/unauthorized).

## 5. Daemon-side design

### 5.1 Responsibilities

Same as the local `services/` layer, on the remote host:

- Server lifecycle (create → async provision, start, stop, delete).
- Jar download from Mojang; mod-loader install (Forge/NeoForge/Fabric/Quilt).
- Process supervision, crash auto-restart.
- Console buffering + stdin command injection; live log stream.
- `server.properties` read/write (comment-preserving).
- CPU/RAM telemetry.
- Mod install/uninstall/toggle (files land on the remote host).
- Java detection on the host.

### 5.2 Layout (Go module)

```
daemon/
  go.mod
  cmd/msmd/main.go            # entrypoint, flags, config load
  internal/api/               # HTTP handlers, WS hubs, auth middleware
  internal/server/            # server engine: lifecycle, provisioning
  internal/loader/            # mod-loader installers
  internal/mods/              # Modrinth/CurseForge clients
  internal/telemetry/         # pidusage-equivalent (gopsutil)
  internal/store/             # SQLite (modernc.org/sqlite — pure Go, no cgo)
  internal/config/            # config file + env
  api/openapi.yaml            # single source of truth for the contract
```

`modernc.org/sqlite` keeps the daemon **cgo-free**, so cross-compilation stays a
one-liner and the binary is fully static.

### 5.3 State

The daemon owns a SQLite database mirroring the manager's `servers`/`installed_mods`
schema, scoped to that host. The manager treats the daemon as the source of truth
for remote servers and caches a projection.

### 5.4 Filesystem & privilege

- Runs as a dedicated unprivileged user `msmd`.
- All servers live under a configured base dir (e.g. `/var/lib/msmd/servers/<id>`),
  path-sanitized exactly like the local `sanitizeServerName`.
- The daemon exposes only a fixed set of **typed operations** — it never runs
  arbitrary shell or arbitrary paths supplied by the manager.

## 6. Protocol

**Transport: TLS everywhere.** Two channels:

1. **REST/JSON over HTTPS** for request/response operations (commands, CRUD, config).
2. **WebSocket (WSS)** for server→manager streams (console logs, status changes,
   telemetry, provisioning progress) and manager→server console input.

Rationale: REST is trivially debuggable (curl, logs) and maps 1:1 onto the existing
[IPC contract](IPC.md); WebSocket handles the streaming the console and telemetry
need. gRPC (bidirectional streaming, codegen) is stronger and typed but heavier to
operate and debug; it is a **v2** option, not needed for the MVP.

> **Implementation note (MVP):** the daemon streams with **Server-Sent Events**
> (`text/event-stream`) rather than WebSocket, keeping it standard-library-only
> and dependency-free. Console input (stdin) is a plain `POST .../command`.
> Server→client streaming is the only direction that needs pushing, so SSE is a
> good fit; WebSocket can replace it later if bidirectional streaming is wanted.

### 6.1 API sketch (`/v1`)

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/health` | Liveness (no auth). |
| `POST` | `/v1/pair` | One-time pairing: exchange bootstrap token → long-lived API token. |
| `GET` | `/v1/info` | Host info: OS, CPU/RAM, Java installs, agent version, API versions. |
| `GET` | `/v1/servers` | List servers on this host. |
| `POST` | `/v1/servers` | Create (returns immediately; provisions async). |
| `GET` | `/v1/servers/{id}` | Get one server + status. |
| `POST` | `/v1/servers/{id}/start` \| `/stop` | Lifecycle. |
| `DELETE` | `/v1/servers/{id}` | Delete. |
| `GET`/`PUT` | `/v1/servers/{id}/properties` | Read/write `server.properties`. |
| `POST` | `/v1/servers/{id}/command` | Send a console command. |
| `GET` | `/v1/servers/{id}/logs` | Historical log buffer. |
| `GET` (WS) | `/v1/servers/{id}/console` | Live console stream + stdin. |
| `GET` (WS) | `/v1/events` | Host-wide event stream (status, telemetry, provisioning). |
| `*` | `/v1/servers/{id}/mods...` | Mod search/install/uninstall/toggle. |

The contract lives in `daemon/api/openapi.yaml`; the manager's `RemoteProvider` is
generated from (or validated against) it so both sides cannot drift.

### 6.2 Streaming shape

Events reuse the existing payloads (`ServerLogEntry`, status change, `ServerTelemetry`)
so the manager can feed them into the **same** renderer event channels
(`event:server-log`, `event:server-status-changed`, per-server telemetry) that
local servers already use. From the UI's perspective, a remote server behaves
identically to a local one.

## 7. Authentication & security

### 7.1 Pairing (trust on first use)

1. The installer generates a self-signed TLS cert and a random **bootstrap token**,
   and prints the token + cert fingerprint.
2. In the manager, the user enters `host:port` + bootstrap token.
3. The manager connects, pins the cert fingerprint (shown for confirmation), and
   calls `POST /v1/pair` with the bootstrap token.
4. The daemon returns a long-lived **API token**; the bootstrap token is then void.
5. The manager stores the API token in the OS secret store and the pinned
   fingerprint in the `hosts` row.

### 7.2 Ongoing requests

- Every request carries `Authorization: Bearer <api-token>` over the pinned-TLS
  channel. Tokens are long, random, revocable, and rotatable.
- Constant-time token comparison; per-IP rate limiting on `/v1/pair` and auth
  failures; structured audit log of privileged operations.

### 7.3 Threat model & mitigations

| Threat | Mitigation |
| --- | --- |
| Eavesdropping / MITM | TLS + cert pinning (TOFU); reject on fingerprint change. |
| Stolen token | Revoke/rotate; short-lived option; audit log; bind token to pinned cert. |
| Daemon RCE surface | Only typed operations; no shell passthrough; path sanitization; runs unprivileged. |
| Brute force pairing | One-time bootstrap token, short TTL, rate-limited, single-use. |
| Manager machine compromise | Token in OS secret store, not plaintext; per-host tokens limit blast radius. |

**v2 hardening:** mutual TLS (client certs) to authenticate the manager to the
daemon cryptographically, replacing/augmenting the bearer token.

## 8. Deployment

- **Binaries:** publish `msmd` for `linux-amd64`, `linux-arm64`, `windows-amd64`
  on GitHub Releases (built by CI with a release workflow).
- **Linux install:** `curl -fsSL https://.../install.sh | sh` — downloads the
  binary to `/usr/local/bin/msmd`, creates the `msmd` user + data dir, writes a
  `systemd` unit, starts it, and prints the pairing token + fingerprint.
- **Windows install:** an installer that registers `msmd` as a Windows service.
- **Config** (`/etc/msmd/config.yaml`): listen address/port, TLS cert/key paths
  (auto-generated on first run), data dir, servers root, allowed origins, log level.
- **Updates:** the manager reports the daemon version and links to the release; a
  later phase adds daemon self-update (verified download + restart).

## 9. Compatibility & versioning

- API is versioned under `/v1`. `GET /v1/info` returns the agent version and the
  set of supported API versions.
- The manager checks the daemon version on connect and warns on mismatch; breaking
  changes bump to `/v2` and the manager supports both during a transition window.

## 10. Phased delivery

| Phase | Scope | Ships |
| --- | --- | --- |
| **A** | Manager: extract `ServerProvider`; wrap current services in `LocalProvider`; add `hosts` table with a seeded `local` host. | No user-visible change. |
| **B** ✅ | Daemon MVP (Go): health, info, server CRUD + lifecycle, console stream (SSE), TLS + token auth, systemd install script. | **Done** — see [`../daemon/`](../daemon/); pair and run servers via curl. |
| **C** 🟡 | Manager: daemon client (TLS fingerprint pinning) + "Add Remote Host" UI + secret storage (safeStorage) + a **Remote Hosts** page to pair a host and deploy/start/stop/delete servers and view their console. | **Partial** — shipped as an additive Remote Hosts section (`hosts` table, `remote-client`, `hosts-manager`, `/hosts` route). The full unified `ServerProvider` (Phase A, so local + remote appear together) and live SSE streaming to the manager are still to come. |
| **D** | Parity: mods, properties editor, telemetry, crash auto-restart over the wire. | Feature parity with local. |
| **E** | Hardening: mTLS, token rotation, daemon self-update, release CI for daemon binaries. | Production-ready. |

## 11. Open questions

- **Server import:** should the daemon adopt pre-existing server folders on the host
  (scan + register), not only ones it created?
- **File transfer:** large uploads (worlds, manual mods) — chunked HTTP vs a
  dedicated endpoint vs resumable protocol.
- **Mod source credentials:** does the daemon hold the CurseForge API key, or does
  the manager proxy mod downloads? (Leaning: daemon holds its own key so files land
  locally on the host.)
- **NAT / no public IP:** hosts behind NAT need port-forwarding or a future
  reverse-tunnel/relay mode. Out of scope for v1 (assume reachable host:port).
- **Monorepo vs split repo** for `daemon/` (leaning: `daemon/` subdirectory with its
  own `go.mod`, shared OpenAPI spec).
