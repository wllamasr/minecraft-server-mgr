# msmd — Minecraft Server Manager daemon

A small Go agent that runs on a host and manages Minecraft servers there on
behalf of the desktop manager. This is the **Phase B MVP** from
[../docs/DAEMON.md](../docs/DAEMON.md): server lifecycle + live console over an
authenticated TLS API. It has **no external dependencies** (Go standard library
only), so it builds to a single static binary and cross-compiles trivially.

## What works today

The daemon is self-sufficient — it handles everything a Minecraft server needs
on the host:

- **Java, automatically.** Detects installed JDKs (JAVA_HOME, PATH, common
  locations); if none matches the server's Minecraft version it downloads and
  installs an Eclipse Temurin JDK (8/17/21/25) into its data dir. No manual setup.
- **Servers.** Create (async provisioning), start, stop, delete, list, get, with
  a live console (history + SSE) and command input. Crash **auto-restart**
  (capped 3/min) when `autoStart` is set. **Restart** on request, and a daily
  **scheduled restart** per server (`restartSchedule`, `HH:MM` on the host's
  clock) with chat warnings 5 minutes and 1 minute before; only running
  servers are restarted, and a restart missed while the host was down or
  suspended is skipped.
- **Mod loaders.** Fabric, Quilt, Forge, NeoForge — installed with each
  project's official installer; the right launch command is used per loader.
- **Plugin platforms.** Paper, Purpur and Folia: pass `modLoader` (`paper`, `purpur`, `folia`),
  `modLoaderVersion` (the build number) and a release `minecraftVersion`. The build is downloaded
  as `server.jar` and verified (SHA-256 for Paper and Folia, MD5 for Purpur); a mismatching file is
  removed and provisioning fails. Builds are listed with `GET /v1/loaders/{loader}/versions?mc=`
  and Minecraft versions with `GET /v1/software/{platform}/versions`.
- **JVM profile.** Optional `jvmProfile` on create: `default` or `aikar` (Aikar's G1GC flags with
  `-Xms` equal to `-Xmx`; works with every engine, Forge/NeoForge via `user_jvm_args.txt`).
- **Input validation.** Create returns HTTP 400 for a bad `minRam`/`maxRam` (e.g. `4G`, `4096M`),
  min above max, an unknown `jvmProfile`, or a malformed `modLoaderVersion`.
- **Modpacks.** Deploy a Modrinth `.mrpack` (pass its URL): the daemon installs
  the exact loader it pins, downloads the server files, and applies overrides.
- **Security.** TLS with a self-signed cert (pinned by the manager, TOFU) and
  **bearer-token** auth. Get/rotate the token with `msmd auth`.

**Not yet** (see the RFC): telemetry, CurseForge modpacks, mutual TLS. The
desktop manager's remote-host UI is landing separately (Phase A/C).

## Build & run

Requires Go 1.22+.

```bash
make build            # -> ./msmd (static binary)
./msmd -data ./msmd-data          # serve: listens on :8443, prints the pairing token
# or: make run
```

Subcommands:

```bash
msmd serve            # run the daemon (default when no subcommand is given)
msmd auth             # print the pairing token + certificate fingerprint
msmd auth --token     # print just the raw token (scriptable)
msmd auth --rotate    # generate a new token, invalidating the old one
msmd version
```

Cross-compile release binaries:

```bash
make cross            # dist/msmd-linux-amd64, -linux-arm64, -windows-amd64.exe
```

Configuration (flags or environment):

| Flag     | Env                 | Default        | Meaning                         |
| -------- | ------------------- | -------------- | ------------------------------- |
| `-addr`  | `MSMD_ADDR`         | `:8443`        | listen address                  |
| `-data`  | `MSMD_DATA`         | `./msmd-data`  | state dir (cert, token, db)     |
|          | `MSMD_SERVERS_ROOT` | `<data>/servers` | where servers live            |
|          | `MSMD_JAVA`         | `java`         | java binary to launch servers   |
|          | `MSMD_STOP_GRACE`   | `2m`           | how long a server gets to save and exit after `stop` before it is killed (a duration such as `90s` or `5m`) |

**Shutdown.** On `SIGTERM`, `SIGINT` or a hangup (the terminal or SSH session closing), msmd stops every running server before it exits: each
one gets the `stop` command and up to `MSMD_STOP_GRACE` to save; whatever is still running after
that is killed together with its child processes. The API keeps answering during the shutdown,
and no server is started or auto-restarted any more. The systemd unit in `deploy/` uses
`KillMode=mixed` (signal only msmd, not the servers) and `TimeoutStopSec=180`; if you raise
`MSMD_STOP_GRACE`, raise `TimeoutStopSec` above it too, or systemd kills the servers first. If
you installed the unit before this change, copy the new `deploy/msmd.service` over
`/etc/systemd/system/msmd.service` and run `systemctl daemon-reload`.

## Try it (no manager needed yet)

Read the token the daemon printed (also in `<data>/token`), then:

```bash
TOKEN=$(cat ./msmd-data/token)
curl -sk https://localhost:8443/v1/health
curl -sk -X POST -d "{\"token\":\"$TOKEN\"}" https://localhost:8443/v1/pair
curl -sk -H "Authorization: Bearer $TOKEN" https://localhost:8443/v1/info
curl -sk -H "Authorization: Bearer $TOKEN" \
     -d '{"name":"Test","minecraftVersion":"1.20.1","maxRam":"2G"}' \
     https://localhost:8443/v1/servers
# watch it provision, then run, via SSE:
curl -sk -N -H "Authorization: Bearer $TOKEN" https://localhost:8443/v1/servers/<id>/console
```

`-k` is fine here: the manager pins the certificate by fingerprint (TOFU), it is
not validated against a CA.

## Testing: WSL2 vs a VM

You asked how to test this. Both work; use them for different purposes.

### WSL2 — best for day-to-day development (recommended first)

A real Linux environment on your Windows machine, with almost no overhead and
`localhost` shared with Windows, so the manager (running on Windows) can reach
the daemon at `https://localhost:8443`.

```bash
# inside Ubuntu on WSL2
sudo apt update && sudo apt install -y golang-go openjdk-21-jre-headless
cd /mnt/e/code/minecraft-win-manager/daemon
make run                     # prints the pairing token
```

Then from Windows: `curl.exe -k https://localhost:8443/v1/health` (WSL2 forwards
localhost). This is the fastest loop for building the daemon and, later, the
manager's remote-host integration. WSL2 even supports systemd (enable it in
`/etc/wsl.conf`) if you want to try the service unit.

Caveat: WSL2 is not a separate machine, so it does not exercise a real network
boundary, firewall, or a distinct IP the way a remote host does.

### A VM or a cheap VPS — best for validating the "remote" path

Use a small Linux VM (multipass, Hyper-V, VirtualBox) or a throwaway VPS to test
the realistic scenario: a separate host/IP, a firewall, and the systemd install
flow end to end.

```bash
# on the VM
scp dist/msmd-linux-amd64 user@vm:/tmp/
scp -r deploy user@vm:/tmp/
ssh user@vm
sudo apt install -y openjdk-21-jre-headless
sudo /tmp/deploy/install.sh /tmp/msmd-linux-amd64    # creates user, installs service, prints token
sudo ufw allow 8443/tcp                               # if a firewall is on
```

Then point the manager at `https://<vm-ip>:8443` with the printed token.

**Recommendation:** iterate on **WSL2** (fast, zero-cost), then do a final
validation on a **VM/VPS** (real network + systemd) before relying on it.

For a full step-by-step VM walkthrough (Multipass or Hyper-V), see
[TESTING.md](TESTING.md).

## Testing (automated)

```bash
make test     # go test ./...  (API routing/auth + helpers)
make smoke    # build the real binary, run it over TLS, and assert on auth, pairing and the API
```

`make smoke` needs `go` and `curl`, works on Linux and on Windows (Git Bash), and exits
non-zero on the first failed check. It also asserts input validation (offline). Set
`MSMD_SMOKE_LIVE=1` to additionally provision, boot, stop and delete a real Paper server with the
`aikar` profile (needs network; not run in CI; optional `MSMD_SMOKE_MC`, default `1.21.11`, and
`MSMD_SMOKE_GAME_PORT`, default `25598`). The default checks run in CI on every push and pull request, on Linux
(minimum and latest Go, with the race detector) and on Windows.

## Layout

```
cmd/msmd/           entrypoint (flags, TLS server, shutdown)
internal/config/    config, self-signed cert + token generation
internal/store/     JSON-backed server records
internal/console/   log buffers + SSE pub/sub
internal/server/    server engine: provisioning, lifecycle, supervision
internal/api/       HTTP handlers, auth middleware, SSE
api/openapi.yaml    the HTTP contract
deploy/             systemd unit + install script
```
