import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS, IPC_EVENTS } from '../shared/constants'
import type { CreateServerInput, ServerWithStatus, JavaInstallation, ServerLogEntry } from '../shared/types'

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
