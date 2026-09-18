# IPC Contract

All communication between the renderer and the main process goes through the preload
bridge. The renderer calls **methods on `window.api`** (typed as `ElectronAPI`); it never
uses `ipcRenderer` directly. This document lists the underlying channels so the surface is
easy to audit and extend.

- **Invoke channels** are request/response (`ipcRenderer.invoke` ↔ `ipcMain.handle`).
- **Events** are one-way, main → renderer (`webContents.send` ↔ `ipcRenderer.on`), exposed
  as `on*` subscription methods that return an unsubscribe function.

Channel-name constants live in
[`src/shared/constants/ipc-channels.ts`](../src/shared/constants/ipc-channels.ts). A few
newer channels are still raw strings (noted below) and are good first cleanup candidates.

## Server lifecycle

| `window.api` method            | Channel           | Request               | Response                     |
| ------------------------------ | ----------------- | --------------------- | ---------------------------- |
| `listServers()`                | `server:list`     | —                     | `ServerWithStatus[]`         |
| `getServer(id)`                | `server:get`      | `string`              | `ServerWithStatus \| null`   |
| `createServer(input)`          | `server:create`   | `CreateServerInput`   | `ServerInstance`             |
| `startServer(id)`              | `server:start`    | `string`              | `void`                       |
| `stopServer(id)`               | `server:stop`     | `string`              | `void` (graceful, 30s kill)  |
| `deleteServer(id)`             | `server:delete`   | `string`              | `void`                       |

`createServer` downloads the vanilla jar from Mojang, writes `server.properties` + `eula.txt`,
and installs the mod loader if one was requested.

## Console

| `window.api` method             | Channel                  | Request                        | Response            |
| ------------------------------- | ------------------------ | ------------------------------ | ------------------- |
| `sendCommand(id, command)`      | `console:send-command`   | `{ serverId, command }`        | `boolean`           |
| `getServerLogs(id)`             | `console:get-logs` ¹     | `string`                       | `ServerLogEntry[]`  |

¹ raw-string channel.

## Configuration

| `window.api` method                       | Channel                            | Request                    | Response                    |
| ----------------------------------------- | ---------------------------------- | -------------------------- | --------------------------- |
| `readServerProperties(id)`                | `config:read-server-properties`    | `string`                   | `Record<string,string>`     |
| `writeServerProperties(id, properties)`   | `config:write-server-properties`   | `{ serverId, properties }` | `void`                      |
| `getSetting(key)`                         | `settings:get`                     | `string`                   | `string \| null`            |
| `setSetting(key, value)`                  | `settings:set`                     | `{ key, value }`           | `void`                      |

`writeServerProperties` preserves comments and untouched keys in the existing file.

## System

| `window.api` method          | Channel                    | Request  | Response                |
| ---------------------------- | -------------------------- | -------- | ----------------------- |
| `getJavaInstallations()`     | `system:get-java`          | —        | `JavaInstallation[]`    |
| `selectDirectory()`          | `system:select-directory`  | —        | `string \| null`        |
| `openExternal(url)`          | `system:open-external`     | `string` | `void`                  |

## Mod loaders & mods

| `window.api` method                                   | Channel                        | Notes                          |
| ----------------------------------------------------- | ------------------------------ | ------------------------------ |
| `getModLoaderVersions(loader, mcVersion)`             | `modloader:get-versions`       | `{ version, stable }[]`        |
| `installModLoader(loader, loaderVersion, mc, dir)`    | `modloader:install`            | `void`                         |
| `searchMods(options)`                                 | `mod-manager:search` ¹         | `ModSearchResponse`            |
| `getMod(source, id)`                                  | `mod-manager:get` ¹            | `UnifiedMod` + `descriptionHtml` |
| `getModVersions(source, id, gameVersion?, loader?)`   | `mod-manager:get-versions` ¹   | `UnifiedModVersion[]`          |
| `getInstalledMods(id)`                                | `mod-manager:get-installed` ¹  | installed mod rows             |
| `installMod(id, source, projectId, versionId)`        | `mod-manager:install` ¹        | `void`                         |
| `uninstallMod(id, modDbId)`                           | `mod-manager:uninstall` ¹      | `void`                         |
| `toggleMod(id, modDbId, enable)`                      | `mod-manager:toggle` ¹         | `void`                         |

¹ raw-string channel. `source` is `'modrinth' | 'curseforge'`.

## App & window

| `window.api` method     | Channel                | Response  |
| ----------------------- | ---------------------- | --------- |
| `getVersion()`          | `app:get-version`      | `string`  |
| `windowMinimize()`      | `app:window-minimize`  | `void`    |
| `windowMaximize()`      | `app:window-maximize`  | `void`    |
| `windowClose()`         | `app:window-close`     | `void`    |
| `installUpdate()`       | `app:install-update`   | `void`    |

## Events (main → renderer)

Each `on*` method registers a listener and returns an unsubscribe function.

| `window.api` method                | Channel / pattern                | Payload                            |
| ---------------------------------- | -------------------------------- | ---------------------------------- |
| `onServerLog(cb)`                  | `event:server-log`               | `ServerLogEntry`                   |
| `onServerStatusChanged(cb)`        | `event:server-status-changed`    | `{ serverId, status }`             |
| `onTelemetry(serverId, cb)`        | `server-telemetry:<serverId>` ¹  | `ServerTelemetry`                  |
| `onUpdateDownloaded(cb)`           | `event:app-update-downloaded`    | `version: string`                  |

¹ per-server raw-string channel.

## Types

The shapes referenced above are defined in `src/shared/types`:

- `ServerInstance`, `ServerWithStatus`, `CreateServerInput`, `ServerStatus`,
  `JavaInstallation`, `ServerLogEntry` — [`server.types.ts`](../src/shared/types/server.types.ts)
- `ModSource`, `ModSearchOptions`, `ModSearchResponse`, `UnifiedMod`, `UnifiedModVersion`
  — [`mod.types.ts`](../src/shared/types/mod.types.ts)
- `ServerTelemetry` — [`telemetry.types.ts`](../src/shared/types/telemetry.types.ts)
