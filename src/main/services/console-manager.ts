import { ChildProcess, spawn } from 'child_process'
import { BrowserWindow } from 'electron'
import log from '../utils/logger'
import { IPC_EVENTS } from '../../shared/constants'
import type { ServerLogEntry } from '../../shared/types'

interface ManagedConsole {
  serverId: string
  process: ChildProcess
  logBuffer: ServerLogEntry[]
}

const MAX_BUFFER_SIZE = 2000 // Keep last N log lines in memory
const consoles = new Map<string, ManagedConsole>()

/**
 * Attach console management to a server's child process.
 */
export function attachConsole(serverId: string, childProcess: ChildProcess): void {
  const managed: ManagedConsole = {
    serverId,
    process: childProcess,
    logBuffer: []
  }

  const pushLine = (line: string) => {
    const entry: ServerLogEntry = {
      serverId,
      line,
      timestamp: Date.now()
    }

    managed.logBuffer.push(entry)
    if (managed.logBuffer.length > MAX_BUFFER_SIZE) {
      managed.logBuffer.shift()
    }

    // Send to all renderer windows
    BrowserWindow.getAllWindows().forEach((win) => {
      if (!win.isDestroyed()) {
        win.webContents.send(IPC_EVENTS.SERVER_LOG, entry)
      }
    })
  }

  childProcess.stdout?.on('data', (data: Buffer) => {
    const lines = data.toString().split('\n').filter(Boolean)
    lines.forEach(pushLine)
  })

  childProcess.stderr?.on('data', (data: Buffer) => {
    const lines = data.toString().split('\n').filter(Boolean)
    lines.forEach((line) => pushLine(`[STDERR] ${line}`))
  })

  consoles.set(serverId, managed)
}

/**
 * Send a command to a running server's stdin.
 */
export function sendCommand(serverId: string, command: string): boolean {
  const managed = consoles.get(serverId)
  if (!managed || !managed.process.stdin?.writable) {
    log.warn(`[Console] Cannot send command to server ${serverId}: not running`)
    return false
  }

  managed.process.stdin.write(command + '\n')
  log.info(`[Console] Sent command to ${serverId}: ${command}`)
  return true
}

/**
 * Get the log buffer for a server.
 */
export function getLogBuffer(serverId: string): ServerLogEntry[] {
  return consoles.get(serverId)?.logBuffer || []
}

/**
 * Remove console tracking for a server.
 */
export function detachConsole(serverId: string): void {
  consoles.delete(serverId)
}
