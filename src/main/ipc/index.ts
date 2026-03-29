import { ipcMain, dialog, shell, BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import * as serverManager from '../services/server-manager'
import * as consoleManager from '../services/console-manager'
import * as configManager from '../services/config-manager'
import { detectJavaInstallations } from '../services/java-detector'
import { app } from 'electron'
import log from '../utils/logger'

export function registerIpcHandlers(): void {
  log.info('[IPC] Registering handlers...')

  // ─── Server ────────────────────────────────────────────
  ipcMain.handle(IPC_CHANNELS.SERVER_LIST, () => {
    return serverManager.listServers()
  })

  ipcMain.handle(IPC_CHANNELS.SERVER_GET, (_e, serverId: string) => {
    return serverManager.getServer(serverId)
  })

  ipcMain.handle(IPC_CHANNELS.SERVER_CREATE, async (_e, input) => {
    return await serverManager.createServer(input)
  })

  ipcMain.handle(IPC_CHANNELS.SERVER_START, (_e, serverId: string) => {
    serverManager.startServer(serverId)
  })

  ipcMain.handle(IPC_CHANNELS.SERVER_STOP, async (_e, serverId: string) => {
    await serverManager.stopServer(serverId)
  })

  ipcMain.handle(IPC_CHANNELS.SERVER_DELETE, async (_e, serverId: string) => {
    await serverManager.deleteServer(serverId)
  })

  // ─── Console ───────────────────────────────────────────
  ipcMain.handle(IPC_CHANNELS.CONSOLE_SEND_COMMAND, (_e, { serverId, command }: { serverId: string; command: string }) => {
    return consoleManager.sendCommand(serverId, command)
  })

  // ─── Config ────────────────────────────────────────────
  ipcMain.handle(IPC_CHANNELS.CONFIG_READ_SERVER_PROPERTIES, (_e, serverId: string) => {
    return configManager.readServerProperties(serverId)
  })

  ipcMain.handle(IPC_CHANNELS.CONFIG_WRITE_SERVER_PROPERTIES, (_e, { serverId, properties }: { serverId: string; properties: Record<string, string> }) => {
    configManager.writeServerProperties(serverId, properties)
  })

  // ─── Settings ──────────────────────────────────────────
  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET, (_e, key: string) => {
    return configManager.getSetting(key)
  })

  ipcMain.handle(IPC_CHANNELS.SETTINGS_SET, (_e, { key, value }: { key: string; value: string }) => {
    configManager.setSetting(key, value)
  })

  // ─── System ────────────────────────────────────────────
  ipcMain.handle(IPC_CHANNELS.SYSTEM_GET_JAVA, () => {
    return detectJavaInstallations()
  })

  ipcMain.handle(IPC_CHANNELS.SYSTEM_SELECT_DIRECTORY, async () => {
    const win = BrowserWindow.getFocusedWindow()
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory']
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle(IPC_CHANNELS.SYSTEM_OPEN_EXTERNAL, (_e, url: string) => {
    shell.openExternal(url)
  })

  // ─── App / Window controls ─────────────────────────────
  ipcMain.handle(IPC_CHANNELS.APP_GET_VERSION, () => {
    return app.getVersion()
  })

  ipcMain.handle(IPC_CHANNELS.APP_WINDOW_MINIMIZE, () => {
    BrowserWindow.getFocusedWindow()?.minimize()
  })

  ipcMain.handle(IPC_CHANNELS.APP_WINDOW_MAXIMIZE, () => {
    const win = BrowserWindow.getFocusedWindow()
    if (win?.isMaximized()) {
      win.unmaximize()
    } else {
      win?.maximize()
    }
  })

  ipcMain.handle(IPC_CHANNELS.APP_WINDOW_CLOSE, () => {
    BrowserWindow.getFocusedWindow()?.close()
  })

  log.info('[IPC] All handlers registered')
}
