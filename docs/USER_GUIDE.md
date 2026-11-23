# User Guide

This guide walks you through installing Minecraft Server Manager (MSM), creating your first
server, and using its main features. For developer documentation see the
[README](../README.md) and [CONTRIBUTING](../CONTRIBUTING.md).

## Contents

1. [Before you start](#1-before-you-start)
2. [Installing](#2-installing)
3. [Creating a server](#3-creating-a-server)
4. [Starting and stopping](#4-starting-and-stopping)
5. [The live console](#5-the-live-console)
6. [Configuring `server.properties`](#6-configuring-serverproperties)
7. [Mod loaders](#7-mod-loaders)
8. [Mods and modpacks](#8-mods-and-modpacks)
9. [Resource usage](#9-resource-usage)
10. [Java](#10-java)
11. [Settings and data locations](#11-settings-and-data-locations)
12. [Updates](#12-updates)
13. [Troubleshooting](#13-troubleshooting)
14. [FAQ](#14-faq)

---

## 1. Before you start

- **Windows 10 or 11** (64-bit).
- **Java**. Minecraft servers need a Java runtime:
  - Minecraft **1.20.5 and newer**: Java **21**.
  - Minecraft **1.17 to 1.20.4**: Java **17**.
  - Older releases: Java **8**.

  MSM detects installed JDKs automatically. If none is found it links you to
  [Adoptium](https://adoptium.net/), which offers free installers.
- **Accept the Minecraft EULA.** MSM writes `eula=true` for servers it creates, which means you
  agree to the [Minecraft EULA](https://www.minecraft.net/eula). Only do this if you agree to it.
- **Network access**, the first time you create a server (MSM downloads the server jar from
  Mojang, and mods from Modrinth or CurseForge).

## 2. Installing

Download the latest `MinecraftServerManager-Setup-<version>.exe` from the
[Releases page](https://github.com/wllamasr/minecraft-server-mgr/releases) and run it.
The installer lets you choose the installation folder.

To run from source instead, see [CONTRIBUTING.md](../CONTRIBUTING.md#development-setup).

## 3. Creating a server

1. Open **Servers** → **Create**.
2. Fill in:
   - **Name**: letters, numbers, `-` and `_` are safest. Other characters are replaced with `_`
     for the folder name.
   - **Minecraft version**: pick from the list.
   - **Mod loader** (optional): Forge, NeoForge, Fabric, or Quilt, plus a loader version. Leave it
     empty for a vanilla server.
   - **Port** (default `25565`), **min RAM** (default `1G`), **max RAM** (default `2G`).
   - **MOTD** and **auto-restart**, if you want them.
3. Confirm. The server appears immediately in the list with a *provisioning* status. MSM downloads
   the jar and installs the loader in the background; progress appears in the server console.
   If something fails, the server shows an *error* status and the reason is in its console.

Creating a server does not start it. Start it when you are ready.

## 4. Starting and stopping

- **Start** launches the server with its Java runtime and RAM settings.
- **Stop** asks the server to shut down cleanly, so the world is saved.
- **Restart** stops and starts the server again. Use it to apply configuration or mod changes.
- **Delete** removes the server and its folder, including the world. This cannot be undone, so
  back up first (see [Settings and data locations](#11-settings-and-data-locations)).

A server has one status at a time: `stopped`, `starting`, `running`, `stopping`, or `crashed`.
A *crashed* server exited unexpectedly; check its console for the reason.

## 5. The live console

The console streams the server log in real time. Type a command in the input box at the bottom and
press Enter to send it to the server, for example `op PlayerName` or `whitelist add PlayerName`.

## 6. Configuring `server.properties`

Open a server and go to **Configuration**. The editor lists the settings in `server.properties` with
input controls. Save to write the file. Comments already in the file are preserved.

Changes take effect the next time the server starts. Restart a running server to apply them.

## 7. Mod loaders

| Loader    | Typical use                                           |
| --------- | ----------------------------------------------------- |
| Vanilla   | No mods. Pure Minecraft.                              |
| Fabric    | Lightweight mods, quick to adopt new versions.        |
| Quilt     | Fabric-compatible, with its own ecosystem.            |
| Forge     | Large, long-established mod library.                  |
| NeoForge  | Forge's modern successor for recent Minecraft versions. |

Use the same loader that your mods target. A mod built for Forge will not load on Fabric.

## 8. Mods and modpacks

- The **Mods** page lets you search **Modrinth** and **CurseForge** and install mods onto a server.
  Browsing CurseForge requires a free API key: paste it in **Settings** (CurseForge API Key). Modrinth
  needs no key.
- **Enable or disable** an installed mod with its switch. Disabled mods stay on disk but are not loaded.
- **Remove** a mod to delete its file.
- The **Modpacks** page deploys a modpack as a whole, which sets up the loader and the pack's mods in
  one step. Modrinth modpacks are supported; CurseForge modpacks are not yet.

Restart the server after changing mods.

## 9. Resource usage

While a server runs, MSM shows its **CPU** and **memory** use. Use this to tune the RAM limits:
if the server regularly reaches its max RAM, raise it; if it stays far below, you can lower it to
leave more memory for the rest of your system.

## 10. Java

MSM scans for JDKs in `JAVA_HOME`, your `PATH`, and common install folders, then picks a suitable
one for each server's Minecraft version. The **Java** tab in Settings shows what was detected.
If a server fails to start because of Java, install the version listed above and restart MSM.

## 11. Settings and data locations

Open **Settings** to change:

- **Servers Directory**: the folder where new servers are created.
- **CurseForge API Key**: required only for CurseForge mod search and downloads.
- **Java**: the detected runtimes.
- **Language**: the interface language.

| What                     | Where (default)                                       |
| ------------------------ | ----------------------------------------------------- |
| Servers (worlds, jars)   | The Servers Directory set in Settings                 |
| Logs                     | `%APPDATA%\minecraft-server-manager\logs\`            |

**Back up before big changes.** To back up a server, stop it and copy its folder from the Servers
Directory. Automated backups are on the roadmap.

## 12. Updates

Installed builds check for updates automatically and offer to install them. Updates come from the
project's GitHub releases.

## 13. Troubleshooting

| Symptom                                   | What to check                                                                 |
| ----------------------------------------- | ----------------------------------------------------------------------------- |
| Server stays in *provisioning*            | Network connection. The console shows which download is stuck or failed.     |
| Server goes straight to *crashed*         | The console. Usually a wrong Java version, or a mod that does not match the loader. |
| "Java not found"                          | Install Java 21 (or 17/8 for older versions) and restart MSM.                 |
| CurseForge search returns nothing or fails | Add your CurseForge API key in Settings.                                     |
| Players cannot connect                    | Port forwarding and the Windows firewall. The port must be open in both.     |
| Server is slow or lags                    | Check CPU and memory on the server page. Raise RAM or reduce mods.           |
| Mod does not load                         | Confirm the mod matches the Minecraft version and loader, and read the console. |

When reporting a problem, include the relevant log lines from the logs folder (redact anything
private) and your Java and app versions. See the [bug report template](../.github/ISSUE_TEMPLATE/bug_report.md).

## 14. FAQ

**Can I run a server on another computer?**
Yes, if that computer runs the `msmd` daemon. It is in the [daemon documentation](../daemon/README.md).
Remote management is still being built out; see the [remote daemon RFC](DAEMON.md).

**Does MSM support Bedrock Edition?**
No. MSM manages Java Edition servers only.

**Is MSM affiliated with Mojang or Microsoft?**
No. "Minecraft" is a trademark of Mojang AB.
