import { autoUpdater } from 'electron-updater'
import { BrowserWindow, ipcMain } from 'electron'
import { IPC_EVENTS, IPC_CHANNELS } from '../../shared/constants'
import log from '../utils/logger'

export function initializeAutoUpdater(): void {
  log.info('[AutoUpdater] Initializing auto updater...')

  // Prevent auto-download if we want to ask the user, but per instructions we want silent download
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  // Pipe updater logs to our logger
  autoUpdater.logger = log

  // Check for updates
  autoUpdater.checkForUpdatesAndNotify()

  // Handle updater events
  autoUpdater.on('update-available', (info) => {
    log.info(`[AutoUpdater] Update available: ${info.version}`)
  })

  autoUpdater.on('update-downloaded', (info) => {
    log.info(`[AutoUpdater] Update downloaded: ${info.version}. Ready to install.`)
    BrowserWindow.getAllWindows().forEach((win) => {
      if (!win.isDestroyed()) {
        win.webContents.send(IPC_EVENTS.APP_UPDATE_DOWNLOADED, info.version)
      }
    })
  })

  autoUpdater.on('error', (err) => {
    log.error(`[AutoUpdater] Error in auto-updater.`, err)
  })

  // IPC handler so renderer can trigger graceful restart
  ipcMain.handle(IPC_CHANNELS.APP_INSTALL_UPDATE, () => {
    log.info('[AutoUpdater] User requested install. Quitting and installing...')
    autoUpdater.quitAndInstall(false, true)
  })
}
