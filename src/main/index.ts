import { app, shell, BrowserWindow, powerMonitor } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registerIpcHandlers } from './ipc'
import { runMigrations } from './database/migrate'
import { initializeAutoUpdater } from './services/auto-updater'
import { holdExitForServers } from './services/app-shutdown'
import { startRestartScheduler } from './services/restart-scheduler'
import { startBackupScheduler } from './services/backup-scheduler'
import { isSafeExternalUrl } from '../shared/utils/url'
import log from './utils/logger'

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    frame: false, // Custom frameless window
    titleBarStyle: 'hidden',
    backgroundColor: '#1a1b1e',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  // Closing the window quits the app (except on macOS). With servers running
  // the window stays open, showing that they are being stopped, and the app
  // quits by itself when they are down.
  if (process.platform !== 'darwin') {
    mainWindow.on('close', (event) => holdExitForServers(event, 'Window closed'))
  }

  // Windows is shutting down, restarting or logging the user off. Ask it to
  // wait and tell the servers to stop at once: the user can still force the
  // shutdown after a few seconds, so there is no time to lose.
  mainWindow.on('query-session-end', (event) => holdExitForServers(event, 'Windows session ending'))

  // Links never open inside the app: web links go to the user's browser and
  // anything else is dropped.
  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (isSafeExternalUrl(details.url)) {
      void shell.openExternal(details.url)
    } else {
      log.warn('[App] Blocked window.open for a non-http(s) URL')
    }
    return { action: 'deny' }
  })

  // The window only ever shows the bundled UI. Block navigation away from it
  // (e.g. a link inside third-party mod description HTML).
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env['ELECTRON_RENDERER_URL']
    if (is.dev && devUrl && url.startsWith(devUrl)) return
    event.preventDefault()
    if (isSafeExternalUrl(url)) void shell.openExternal(url)
  })

  // HMR for renderer
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// A second instance would open the same SQLite database and could start the
// same servers twice, so focus the existing window instead.
const hasInstanceLock = app.requestSingleInstanceLock()
if (!hasInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.focus()
  })
}

app.whenReady().then(() => {
  if (!hasInstanceLock) return

  log.info('[App] Starting Minecraft Server Manager v' + app.getVersion())

  // Set app user model id for windows
  electronApp.setAppUserModelId('com.minecraft-server-manager.app')

  // Run database migrations
  runMigrations()

  // Register IPC handlers
  registerIpcHandlers()

  // Daily scheduled restarts of local servers
  startRestartScheduler()
  startBackupScheduler()

  // Start auto-updater
  // We disable it in dev mode to prevent errors and just let it run in production
  if (!is.dev) {
    initializeAutoUpdater()
  }

  // Default open or close DevTools by F12
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Linux or macOS shutting down or rebooting: preventDefault asks the system
  // for the time to exit cleanly. (powerMonitor is only usable once the app is
  // ready; Windows announces the end of the session to the window instead.)
  if (process.platform !== 'win32') {
    powerMonitor.on('shutdown', ((event?: { preventDefault: () => void }) => {
      holdExitForServers(event ?? { preventDefault: () => undefined }, 'System shutting down')
    }) as () => void)
  }

  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// Quitting waits for the running servers to shut down (see app-shutdown.ts).
app.on('before-quit', (event) => holdExitForServers(event, 'Quit requested'))

