import { ChildProcess, spawn } from 'child_process'
import { BrowserWindow } from 'electron'
import log from '../utils/logger'
import { IPC_EVENTS } from '../../shared/constants'
import type { ServerLogEntry } from '../../shared/types'

interface ManagedConsole {
  serverId: string
  process?: ChildProcess
  logBuffer: ServerLogEntry[]
}

const lineListeners = new Map<string, Set<(line: string) => void>>()

/**
 * Be told about every line a server process prints from now on. Lines the
 * app itself adds to the console (pushLog) are not reported: a listener waits
 * for an answer from the server, and nothing else may pass for one. Returns
 * the function that ends the subscription.
 */
export function onLogLine(serverId: string, listener: (line: string) => void): () => void {
  let listeners = lineListeners.get(serverId)
  if (!listeners) {
    listeners = new Set()
    lineListeners.set(serverId, listeners)
  }
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && lineListeners.get(serverId) === listeners) lineListeners.delete(serverId)
  }
}

/** Append an entry to a server's buffer and broadcast it to every window. */
function record(managed: ManagedConsole, entry: ServerLogEntry): void {
  managed.logBuffer.push(entry)
  if (managed.logBuffer.length > MAX_BUFFER_SIZE) {
    managed.logBuffer.shift()
  }

  BrowserWindow.getAllWindows().forEach((win) => {
    if (!win.isDestroyed()) {
      win.webContents.send(IPC_EVENTS.SERVER_LOG, entry)
    }
  })
}

function extractLogLevel(line: string): ServerLogEntry['level'] {
  const match = line.match(/(?:INFO|WARN|ERROR|DEBUG|FINE|SEVERE)/i)
  if (!match) return undefined
  
  const raw = match[0].toUpperCase()
  if (raw === 'SEVERE' || raw === 'FATAL') return 'ERROR'
  if (raw === 'FINE' || raw === 'FINER' || raw === 'FINEST') return 'DEBUG'
  return raw as ServerLogEntry['level']
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

  const pushLine = (line: string, isErrorStream = false) => {
    let level = extractLogLevel(line)
    if (isErrorStream && !level) {
      level = 'ERROR'
    }

    record(managed, {
      serverId,
      line,
      timestamp: Date.now(),
      level
    })

    if (!isErrorStream) {
      for (const listener of [...(lineListeners.get(serverId) ?? [])]) {
        try {
          listener(line)
        } catch (err) {
          log.error('[Console] A log line listener failed:', err)
        }
      }
    }
  }

  childProcess.stdout?.on('data', (data: Buffer) => {
    const lines = data.toString().split('\n').filter(Boolean)
    lines.forEach(l => pushLine(l, false))
  })

  childProcess.stderr?.on('data', (data: Buffer) => {
    const lines = data.toString().split('\n').filter(Boolean)
    lines.forEach((line) => pushLine(line, true))
  })

  // Preserve any provisioning logs that were buffered before the process
  // started, so the console shows a continuous history.
  const existing = consoles.get(serverId)
  if (existing) {
    managed.logBuffer = existing.logBuffer
  }

  consoles.set(serverId, managed)
}

/**
 * Append a synthetic log line for a server that has no live process yet
 * (e.g. progress messages while the server is being provisioned). The line
 * is buffered and broadcast exactly like real console output.
 */
export function pushLog(serverId: string, line: string, level?: ServerLogEntry['level']): void {
  let managed = consoles.get(serverId)
  if (!managed) {
    managed = { serverId, logBuffer: [] }
    consoles.set(serverId, managed)
  }

  record(managed, { serverId, line, timestamp: Date.now(), level })
}

/**
 * Send a command to a running server's stdin.
 */
export function sendCommand(serverId: string, command: string): boolean {
  const managed = consoles.get(serverId)
  if (!managed || !managed.process?.stdin?.writable) {
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
