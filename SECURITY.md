# Security Policy

## Supported versions

Only the latest release and the `main` branch receive security fixes.

| Version        | Supported |
| -------------- | --------- |
| `main`         | ✅        |
| latest release | ✅        |
| older releases | ❌        |

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately through GitHub's
[private vulnerability reporting](https://github.com/wllamasr/minecraft-server-mgr/security/advisories/new)
("Security" tab → "Report a vulnerability"). Include:

- A description of the issue and its impact.
- Steps to reproduce, or a proof of concept.
- The affected component (Electron app, preload/IPC, daemon, installer) and version or commit.

You can expect:

- An acknowledgement within **5 business days**.
- An initial assessment within **10 business days**.
- Coordinated disclosure: we will agree on a fix and a disclosure date with you, and credit
  you in the advisory unless you prefer otherwise.

## Scope

In scope:

- The Electron app: main process, preload bridge and IPC handlers (`src/main`, `src/preload`).
- The Go daemon (`daemon/`): its HTTP API, pairing flow, TLS and token handling.
- Download and archive handling (server jars, mods, modpacks, zip extraction).
- Auto-update delivery.

Out of scope:

- Vulnerabilities in Minecraft itself, Forge/Fabric/NeoForge/Quilt, Modrinth or CurseForge.
- Issues that require an attacker who already has local administrator or the daemon API token.
- Findings from automated scanners without a demonstrated impact.

## Security design notes

- The renderer runs with `contextIsolation: true` and `nodeIntegration: false`. It may only
  reach the main process through the typed `window.api` surface in `src/preload`.
- The daemon authenticates every API route except health and pairing with a bearer token,
  compared in constant time, and serves over TLS with a pinned certificate fingerprint.

If you find a deviation from these guarantees, that is a valid report.
