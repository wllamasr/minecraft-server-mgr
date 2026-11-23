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
7. [Mod loaders and server engines](#7-mod-loaders-and-server-engines)
8. [Mods, plugins, and modpacks](#8-mods-plugins-and-modpacks)
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
  - Minecraft **26.x**: Java **25**.
  - Minecraft **1.20.5 to 1.21.x**: Java **21**.
  - Minecraft **1.17 to 1.20.4**: Java **17**.
  - Minecraft **1.16.5 and older**: Java **8**.

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
   - **Mod loader** (optional): Forge, NeoForge, Fabric, Quilt, Paper, Purpur, or Folia, plus a
     loader version (for Paper, Purpur, and Folia, a build). Leave it empty for a vanilla server.
     See [Mod loaders and server engines](#7-mod-loaders-and-server-engines).
   - **Port** (default `25565`), **RAM** (the slider sets the maximum, `4G` by default; the minimum is half of it, up to
     32 GB in the wizard).
   - **Optimized JVM flags**: see [Running a large server](#running-a-large-server).
   - **MOTD** and **auto-restart**, if you want them.
3. Confirm. The server appears immediately in the list with a *provisioning* status. MSM downloads
   the jar and installs the loader in the background; progress appears in the server console.
   If something fails, the server shows an *error* status and the reason is in its console.

Creating a server does not start it. Start it when you are ready.

## 4. Starting and stopping

- **Start** launches the server with its Java runtime and RAM settings.
- **Stop** asks the server to shut down cleanly, so the world is saved. The server gets up to
  2 minutes to save and exit; if it is still running after that it is killed, and the console
  shows a warning because recent changes may not have been saved.
- **Restart** (shown while the server is running) stops the server cleanly and starts it again.
  Use it to apply configuration or mod changes.
- **Delete** removes the server and its folder, including the world. This cannot be undone, so
  back up first (see [Settings and data locations](#11-settings-and-data-locations)).

A server has one status at a time: `stopped`, `starting`, `running`, `stopping`, or `crashed`.
A *crashed* server exited unexpectedly; check its console for the reason.

### Scheduled restart

Busy servers run better when they are restarted regularly. In the server's **Settings** tab,
turn on **Restart every day**, pick a time, and save. Every day at that time the server is
restarted the same way the **Restart** button does it. Players get a chat message 5 minutes and
1 minute before, and one when the restart begins.

- The time is this computer's local time, in 24-hour format.
- The restart only happens while the app is open and the computer is awake. If the time passes
  while the app is closed or the computer sleeps, that day's restart is skipped.
- Only a running server is restarted. A stopped server stays stopped.
- If you set a time that is clearly less than 5 minutes away, the 5-minute warning is skipped
  rather than sent late.
- On the one day a year when the clocks skip the scheduled time, the restart happens an hour
  later.

**Quitting the app stops your servers.** Local servers run as part of the app, so when you quit
while servers are running, the app stops each of them the same way **Stop** does and closes once
they are down. With a large world this can take up to two minutes: the window stays open and
shows "Stopping N servers…" until they have saved, then the app closes by itself. The same
happens when Windows shuts down, restarts or logs you off: the app asks Windows to wait for the
servers. Windows may still offer to shut down anyway; doing so cuts the servers off, so wait
if you can. Once this has started, the servers stop and the app closes even if you cancel the
shutdown. Servers on a remote host are not affected: they keep running
when you quit the app, and are stopped cleanly when the `msmd` service on that host is stopped.

## 5. The live console

The console streams the server log in real time. Type a command in the input box at the bottom and
press Enter to send it to the server, for example `op PlayerName` or `whitelist add PlayerName`.

## 6. Configuring `server.properties`

Open a server and go to **Configuration**. The editor lists the settings in `server.properties` with
input controls. Save to write the file. Comments already in the file are preserved.

Changes take effect the next time the server starts. Restart a running server to apply them.

## 7. Mod loaders and server engines

| Engine    | Typical use                                           |
| --------- | ----------------------------------------------------- |
| Vanilla   | No mods. Pure Minecraft.                              |
| Fabric    | Lightweight mods, quick to adopt new versions.        |
| Quilt     | Fabric-compatible, with its own ecosystem.            |
| Forge     | Large, long-established mod library.                  |
| NeoForge  | Forge's modern successor for recent Minecraft versions. |
| Paper     | Plugin platform aimed at large player counts.         |
| Purpur    | Plugin platform aimed at large player counts, with extra options. |
| Folia     | Plugin platform for very large player counts. Only runs plugins that explicitly support Folia. |

Use the same loader that your mods target. A mod built for Forge will not load on Fabric.

For Paper, Purpur, and Folia the Minecraft version list is fetched live from the project and
shows release versions only. You then pick a **build**: the newest stable build is preselected,
and non-stable builds are labelled "(experimental)" (Purpur has no release channels, so all of its builds count as stable). The build is a complete server jar saved as
`server.jar`. MSM checks the download against the checksum the project publishes (SHA-256 for
Paper and Folia, MD5 for Purpur, which only publishes MD5); if it does not match, the file is
deleted and the server shows an *error* status. The vanilla jar is checked against Mojang's SHA-1.

Paper, Purpur, and Folia are also available on remote hosts (the `msmd` daemon). In the **Deploy**
dialog on the Remote Hosts page, pick the **Engine**; the Minecraft versions are loaded from the
host, the newest stable build is preselected, and the **Optimized JVM flags** switch is on by
default. The host must run an up-to-date `msmd`: with an older one the app shows an error when it
loads the engine's version list. Installing plugins through the app works for local servers only;
remote hosts have no mod or plugin browser.

Each server on a remote host has a **Restart** button while it runs and a clock button for its
**scheduled restart**. A remote schedule works like a local one, with two differences: the time
is on the host's clock (the dialog shows the host's time zone, which on a VPS is often UTC), and
the restart is carried out by `msmd` on the host, so it happens even when this app is closed. A
host with an older `msmd` answers that it needs an update.

### Running a large server

- Choose **Paper**. For very large player counts, choose **Folia** if all your plugins support it.
- Turn on **Optimized JVM flags** (wizard step 3). It is on by default for Paper, Purpur, and
  Folia. It applies Aikar's G1GC flags and starts the JVM with its initial heap equal to the maximum (`-Xms` = `-Xmx`), so the full
  heap is reserved up front: the machine needs that much free RAM. It works with every engine.
  The server **Overview** shows "JVM flags: Optimized (Aikar's flags)" or "Default".
- Give the server enough RAM. The wizard slider goes up to 32 GB.
- Put plugins in the server's `plugins/` folder, or install them from the **Plugin Browser**.

## 8. Mods, plugins, and modpacks

- The **Mods** page lets you search **Modrinth** and **CurseForge** and install mods onto a server.
  Browsing CurseForge requires a free API key: paste it in **Settings** (CurseForge API Key). Modrinth
  needs no key.
- On Paper, Purpur, and Folia servers, add-ons are **plugins** and load from `plugins/` instead of
  `mods/`. The server's "Mods" tab becomes "Plugins" and the browser becomes "Plugin Browser".
  Plugins come from Modrinth only; CurseForge is not available for these servers. For Paper and
  Purpur the search matches projects tagged paper, purpur, spigot, or bukkit; for Folia it matches
  only projects tagged folia.
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
| "Java not found"                          | Install the Java version listed in section 1 (25, 21, 17, or 8) and restart MSM.                 |
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
