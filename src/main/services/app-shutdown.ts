import { app, BrowserWindow } from 'electron'
import { IPC_EVENTS } from '../../shared/constants'
import { runningServerCount, stopAllServers } from './server-manager'
import { busyCount } from './server-busy'
import log from '../utils/logger'

/**
 * Servers are child processes of the app: quitting without stopping them would
 * leave them running with no console attached, or cut them off mid-save. So
 * every way out of the app (closing the window, quitting, an update, the end of
 * the Windows session) is held here until the servers have shut down.
 */

let stopping: Promise<void> | undefined
let finished = false

/** True while there is something to wait for before the app may exit. */
export function mustHoldExit(): boolean {
  if (finished) return false
  // A backup or restore in flight is wound down first as well.
  return stopping !== undefined || runningServerCount() > 0 || busyCount() > 0
}

/**
 * Stop every running server, once: later calls join the shutdown under way.
 * The window stays open and says what is going on, because a large world can
 * take a couple of minutes to save.
 */
export function stopServersForExit(reason: string): Promise<void> {
  if (stopping) return stopping

  const count = runningServerCount()
  if (count > 0) {
    log.info(`[App] ${reason} with ${count} server(s) running — stopping them first`)
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue
      if (win.isMinimized()) win.restore()
      win.show()
      win.webContents.send(IPC_EVENTS.APP_SHUTTING_DOWN, count)
    }
  }

  stopping = stopAllServers()
    .catch((err) => log.error('[App] Failed to stop servers before exiting:', err))
    .finally(() => {
      finished = true
    })
  return stopping
}

/** How many servers the shutdown under way is waiting for; 0 when none is. */
export function shutdownPendingCount(): number {
  return stopping && !finished ? runningServerCount() : 0
}

/**
 * Handler body for the events that end the app (`before-quit`, a window's
 * `close`, `query-session-end`, ...): cancel the event while servers are
 * running, stop them, then quit for real. Does nothing when no server runs.
 */
export function holdExitForServers(event: { preventDefault: () => void }, reason: string): void {
  if (!mustHoldExit()) return
  event.preventDefault()
  void stopServersForExit(reason).then(() => app.quit())
}
