import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS, IPC_EVENTS } from '../shared/constants'
import type { CreateServerInput, ServerWithStatus, JavaInstallation, ServerLogEntry, ModLoaderType } from '../shared/types'

/** Typed API exposed to the renderer process via contextBridge */
const api = {
  // ─── Server ───────────────────────────────────────────
  listServers: (): Promise<ServerWithStatus[]> => ipcRenderer.invoke(IPC_CHANNELS.SERVER_LIST),

  getServer: (serverId: string): Promise<ServerWithStatus | null> => ipcRenderer.invoke(IPC_CHANNELS.SERVER_GET, serverId),

  createServer: (input: CreateServerInput): Promise<ServerWithStatus> => ipcRenderer.invoke(IPC_CHANNELS.SERVER_CREATE, input),

  startServer: (serverId: string): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.SERVER_START, serverId),

  stopServer: (serverId: string): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.SERVER_STOP, serverId),

  deleteServer: (serverId: string): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.SERVER_DELETE, serverId),

  // ─── Console ──────────────────────────────────────────
  sendCommand: (serverId: string, command: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC_CHANNELS.CONSOLE_SEND_COMMAND, { serverId, command }),

  // ─── Config ───────────────────────────────────────────
  readServerProperties: (serverId: string): Promise<Record<string, string>> =>
    ipcRenderer.invoke(IPC_CHANNELS.CONFIG_READ_SERVER_PROPERTIES, serverId),

  writeServerProperties: (serverId: string, properties: Record<string, string>): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.CONFIG_WRITE_SERVER_PROPERTIES, { serverId, properties }),

  // ─── Settings ─────────────────────────────────────────
  getSetting: (key: string): Promise<string | null> => ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_GET, key),

  setSetting: (key: string, value: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_SET, { key, value }),

  // ─── System ───────────────────────────────────────────
  getJavaInstallations: (): Promise<JavaInstallation[]> => ipcRenderer.invoke(IPC_CHANNELS.SYSTEM_GET_JAVA),

  selectDirectory: (): Promise<string | null> => ipcRenderer.invoke(IPC_CHANNELS.SYSTEM_SELECT_DIRECTORY),

  openExternal: (url: string): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.SYSTEM_OPEN_EXTERNAL, url),

  // ─── Mod Loaders & Mods ───────────────────────────────
  getModLoaderVersions: (loader: ModLoaderType, mcVersion: string): Promise<{ version: string; stable: boolean }[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.MODLOADER_GET_VERSIONS, { loader, mcVersion }),

  installModLoader: (loader: ModLoaderType, loaderVersion: string, mcVersion: string, serverDir: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.MODLOADER_INSTALL, { loader, loaderVersion, mcVersion, serverDir }),

  searchMods: (options: import('../shared/types/mod.types').ModSearchOptions): Promise<import('../shared/types/mod.types').ModSearchResponse> =>
    ipcRenderer.invoke('mod-manager:search', options),

  getMod: (source: import('../shared/types/mod.types').ModSource, id: string): Promise<import('../shared/types/mod.types').UnifiedMod & { descriptionHtml: string }> =>
    ipcRenderer.invoke('mod-manager:get', { source, id }),

  getModVersions: (source: import('../shared/types/mod.types').ModSource, id: string, gameVersion?: string, loader?: string): Promise<import('../shared/types/mod.types').UnifiedModVersion[]> =>
    ipcRenderer.invoke('mod-manager:get-versions', { source, id, gameVersion, loader }),

  getInstalledMods: (serverId: string): Promise<any[]> =>
    ipcRenderer.invoke('mod-manager:get-installed', serverId),

  installMod: (serverId: string, source: import('../shared/types/mod.types').ModSource, projectId: string, versionId: string): Promise<void> =>
    ipcRenderer.invoke('mod-manager:install', { serverId, source, projectId, versionId }),

  uninstallMod: (serverId: string, modDbId: string): Promise<void> =>
    ipcRenderer.invoke('mod-manager:uninstall', { serverId, modDbId }),

  toggleMod: (serverId: string, modDbId: string, enable: boolean): Promise<void> =>
    ipcRenderer.invoke('mod-manager:toggle', { serverId, modDbId, enable }),

  // ─── App / Window ─────────────────────────────────────
  getVersion: (): Promise<string> => ipcRenderer.invoke(IPC_CHANNELS.APP_GET_VERSION),

  windowMinimize: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.APP_WINDOW_MINIMIZE),

  windowMaximize: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.APP_WINDOW_MAXIMIZE),

  windowClose: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.APP_WINDOW_CLOSE),

  // ─── Event listeners (Main → Renderer) ────────────────
  onServerLog: (callback: (entry: ServerLogEntry) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, entry: ServerLogEntry) => callback(entry)
    ipcRenderer.on(IPC_EVENTS.SERVER_LOG, handler)
    return () => ipcRenderer.removeListener(IPC_EVENTS.SERVER_LOG, handler)
  },

  onServerStatusChanged: (callback: (data: { serverId: string; status: string }) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, data: { serverId: string; status: string }) => callback(data)
    ipcRenderer.on(IPC_EVENTS.SERVER_STATUS_CHANGED, handler)
    return () => ipcRenderer.removeListener(IPC_EVENTS.SERVER_STATUS_CHANGED, handler)
  }
}

contextBridge.exposeInMainWorld('api', api)

export type ElectronAPI = typeof api
