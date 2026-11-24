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

### Backups

Open a server and choose the **Backups** tab.

- **Back up now** makes a backup of the world, the settings (`server.properties`, ops, whitelist,
  configuration folders) and the mods or plugins. You can do this while the server is running:
  the app pauses world saving for the copy and turns it back on afterwards, and players can keep
  playing. The console shows when the backup starts and finishes.
- **Restore** replaces the server's files with those of a backup. Stop the server first. Leave
  "Back up the current files first" ticked and the state before the restore is kept as a backup
  marked *before restore*, so you can go back. Everything that changed after the chosen backup is
  otherwise lost, including mods or plugins added since.
- **Delete** removes a backup for good.

A backup is an ordinary `.zip` file; you can open it or copy it elsewhere. Logs, crash reports and
the files the server software downloads for itself (`libraries`, `versions`, `cache`) are not in
it, and a restore leaves those alone. Links (symbolic links, junctions) inside the server folder
are not backed up either, and a restore removes them.

If a restore fails, the server's files are put back as they were. In the rare case that this is
not possible, the error message names a folder ending in `.restore-aside` next to the server
folder: it holds the files that were being replaced, and the server will not start until you
have moved back what you need and removed it.

Things to know:

- Each backup is about the size of the world. Backups you make by hand, and the ones made before
  a restore, are never deleted automatically, so keep an eye on disk space.
- Backups are stored on the same computer (see
  [Settings and data locations](#11-settings-and-data-locations)). They protect against a broken
  world or a bad change, not against a failed disk; copy the zip files somewhere else for that.
- Stopping or restarting the server, or closing the app, cancels a backup that is in progress.
- Deleting a server deletes its backups.
- Servers on remote hosts have backups too, with some differences: see
  [Backups on a remote host](#backups-on-a-remote-host).

#### Scheduled backups

Below the list, **Scheduled backups** makes a backup every day without you asking:

1. Turn on **Back up every day** and pick the **Time** (this computer's local time).
2. Set **Backups to keep** (7 by default) and click **Save**.

After each scheduled backup, the oldest scheduled backups beyond that number are deleted. Only
backups marked *scheduled* are ever deleted this way. If you lower the number, the extra ones go
after the next scheduled backup, not when you save.

- Scheduled backups only run while the app is open and the computer is awake. One whose time
  passed more than 10 minutes ago is not made later.
- If the server is starting, stopping or already being backed up at that time, the app keeps
  trying for 10 minutes and then gives that day's backup up.
- A stopped server is backed up only if its files changed since its last scheduled backup.
- A server that crashed and restarts by itself is backed up once it is running again.
- The line under the settings tells how the last scheduled backup went, including the reason
  when it failed or was missed. Check it now and then: nobody is watching at night.
- If the server also has a scheduled restart, set the backup some time before it. A restart that
  comes due during a backup waits up to 15 minutes for it; after that the restart goes ahead and
  the backup is cancelled.

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
loads the engine's version list. Plugins of a server on a remote host are managed from its
**Plugins** button (see section 8).

Each server on a remote host has a **Restart** button while it runs and a clock button for its
**scheduled restart**. A remote schedule works like a local one, with two differences: the time
is on the host's clock (the dialog shows the host's time zone, which on a VPS is often UTC), and
the restart is carried out by `msmd` on the host, so it happens even when this app is closed. A
host with an older `msmd` answers that it needs an update.

#### Backups on a remote host

Each server on a remote host has a **Backups** button (the archive icon). It opens a window with
**Back up now**, the list of backups, **Restore** and **Delete**, which work as described under
[Backups](#backups) for local servers, with these differences:

- The backup is made by `msmd` on the host and **stays on the host**, in `backups/<server id>/`
  under msmd's data folder. It is not copied to this computer. To keep a copy somewhere else,
  copy the `.zip` files from the host yourself.
- A backup or a restore keeps running when you close the window or the app. Open the window
  again to see the progress or, if the last one failed or was cancelled, why. (msmd forgets
  that when it is restarted; the list of backups always shows what is there.)
- Stopping or restarting the server by hand cancels a backup in progress, and so does stopping
  `msmd`. A restore that has started replacing files is always finished first.
- Backups you make by hand are never deleted for you. Each one is about the size of the world:
  delete the ones you no longer need.
- Deleting the server deletes its backups on the host. The app asks before deleting.
- The host needs `msmd` 0.2.0 or newer (0.3.0 for scheduled backups). With an older one the
  window says that msmd must be updated.

**Scheduled backups** are in the same window, under the **Back up now** button. They work as
described under [Scheduled backups](#scheduled-backups) for local servers: a time of day, a
number of scheduled backups to keep (7 unless you change it), only *scheduled* backups are ever
deleted automatically, a stopped server is backed up only if its files changed, and the line
under the settings tells how the last one went. What is different on a host:

- The time is **on the host's clock**; the window shows the host's time zone (on a VPS it is
  often UTC).
- The host makes the backup itself, so it happens **even when this app is closed** or this
  computer is off. It is only missed if the host is down or suspended at that time, or if the
  server stays busy (starting, stopping, another backup, a restore or the installation of a
  plugin) for 10 minutes; a missed
  backup is not caught up.
- If the server also has a scheduled restart, set the backup some time before it. A scheduled
  restart that comes due during a backup waits for it, up to 15 minutes, and then restarts
  anyway, which cancels the backup.

If a restore fails, the server's files are put back as they were. In the rare case that this is
not possible, the message names a folder ending in `.restore-aside` next to the server folder
**on the host**: it holds the files that were being replaced, and the server will not start
until that folder has been removed there.

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
- **Plugins on remote hosts.** A Paper, Purpur or Folia server on the **Remote Hosts** page has a
  **Plugins** button (the puzzle piece). Its window shows every jar in the server's `plugins/`
  folder, with the name and version the plugin declares; jars you copied to the host yourself are
  listed too, unless their name has characters other than letters, digits, spaces and
  `. _ + - ( ) [ ]` (rename such a file on the host to manage it here).
  - **Install:** search Modrinth in the window and press **Install**. The newest version for the
    server's Minecraft version is chosen (a release if there is one). The host downloads it from
    Modrinth itself and keeps it only if its checksum matches. You can install while the server
    runs; the plugin is loaded the next time the server starts.
  - **Turn off / on** and **Remove** need the server to be stopped. A plugin that is turned off
    stays on the host as `<name>.jar.disabled`. Removing a plugin deletes its jar only: the folder
    with its settings and data stays in `plugins/`.
  - **Update:** a plugin the host installed from Modrinth shows an **Update to …** button when
    Modrinth has a newer release of it for this server. The server must be stopped. The new file
    keeps the state of the old one: a plugin that is off stays off. A plugin you copied to the host
    by hand cannot be updated here.
  - A plugin the host installed is not installed a second time in another version: remove it
    first. The host does not recognise a plugin you copied there by hand as the same plugin. Plugins that a plugin depends on are not installed with it; install them the same way.
  - The host needs `msmd` 0.5.0 or newer. Mods of Fabric, Forge, NeoForge and Quilt servers on
    remote hosts are not managed by the app.
- **Enable or disable** an installed mod with its switch. Disabled mods stay on disk but are not loaded.
- **Remove** a mod to delete its file.
- The **Modpacks** page deploys a modpack as a whole, which sets up the loader and the pack's mods in
  one step. Modrinth modpacks are supported; CurseForge modpacks are not yet.

Restart the server after changing mods.

## 9. Resource usage

While a server runs, MSM shows its **CPU** and **memory** use. Use this to tune the RAM limits:
if the server regularly reaches its max RAM, raise it; if it stays far below, you can lower it to
leave more memory for the rest of your system.

Next to them are the **players online** and the **tick time**: how many milliseconds the server
needs for one game tick. A server has 50 ms per tick (20 ticks per second); while the tick time
stays below that the game runs at full speed, and above it the game slows down — the line under
the number shows the ticks per second the server can keep up and the 95th percentile ("P95"),
which tells you about spikes the average hides.

- The tick time comes from the server's own `tick query` command, so it needs **Minecraft 1.20.3
  or newer**. On older versions, or with server software that does not answer the command, the
  panel shows a dash and says why.
- MSM asks the server every 15 seconds, and only while that server's page is open. Each question
  leaves four lines in the server's `logs/latest.log`; they are kept out of the console in MSM.

**Servers on remote hosts** show the same numbers in one line under their name on the **Remote
Hosts** page while they run: `Players 3/20 · Tick 12.5 ms / 50 ms · 20.0 TPS · P95 20.5 ms ·
CPU 140% · RAM 2.10 GB`.

- They are measured by the host and asked for every 5 seconds while that host is on screen.
  CPU is in percent of one core (140% is one core and a half), and CPU and RAM cover the server
  with everything it started.
- A dash means the host could not measure that value: the tick time on Minecraft older than
  1.20.3, the players when the server's status is turned off (`enable-status=false`), CPU and RAM
  on a host that is neither Linux nor Windows.
- While a host is on screen, each of its running servers is asked for its tick time every 15
  seconds, with the same four lines in its `logs/latest.log`.
- The host needs `msmd` 0.4.0 or newer; with an older one the line is not shown.

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
| Backups                  | `%APPDATA%\minecraft-server-manager\backups\`         |

**Back up before big changes.** Use the **Backups** tab of the server (see
[Starting and stopping](#4-starting-and-stopping)). Backups live on the same disk as the app data,
so copy the zip files elsewhere if you need to survive a disk failure.

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
| Server is slow or lags                    | Check CPU, memory and tick time on the server page. Raise RAM or reduce mods. |
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
