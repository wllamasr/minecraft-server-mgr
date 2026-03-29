import pidusage from 'pidusage'
import { status } from 'minecraft-server-util'
import { BrowserWindow } from 'electron'
import { getRunningProcess, getServer } from './server-manager'
import type { ServerTelemetry } from '../../shared/types/telemetry.types'
import log from '../utils/logger'

interface TelemetryTrackers {
  pidInterval?: NodeJS.Timeout
  pingInterval?: NodeJS.Timeout
}

const activeTrackers = new Map<string, TelemetryTrackers>()

const RESOURCE_POLLING_MS = 2000
const PING_POLLING_MS = 5000

export function startTelemetry(serverId: string): void {
  if (activeTrackers.has(serverId)) {
    log.warn(`[Telemetry] Already tracking server ${serverId}`)
    return
  }

  const server = getServer(serverId)
  const process = getRunningProcess(serverId)

  if (!server) {
    log.error(`[Telemetry] Cannot start telemetry: Server ${serverId} not found.`)
    return
  }
  if (!process || !process.pid) {
    log.error(`[Telemetry] Cannot start telemetry: Server ${serverId} has no Running Process (PID).`)
    return
  }

  log.info(`[Telemetry] Started tracking Server ${server.name} (PID: ${process.pid})`)

  let latestCpu = 0
  let latestMemory = 0
  let latestOnlinePlayers = 0
  let latestMaxPlayers = 20
  
  // Track previous stat for smooth transition or fallback if ping fails
  let previousOnlinePlayers = 0

  const emitTelemetry = () => {
    const data: ServerTelemetry = {
      serverId,
      cpu: latestCpu,
      memory: latestMemory,
      onlinePlayers: latestOnlinePlayers,
      maxPlayers: latestMaxPlayers,
      timestamp: Date.now()
    }
    
    BrowserWindow.getAllWindows().forEach((win) => {
      if (!win.isDestroyed()) {
        // Broadcasting specifically on a channel dedicated to this server to reduce global event spam
        win.webContents.send(`server-telemetry:${serverId}`, data)
      }
    })
  }

  // 1. Process Polling (CPU / RAM)
  const pidInterval = setInterval(async () => {
    try {
      const stats = await pidusage(process.pid!)
      latestCpu = stats.cpu
      latestMemory = stats.memory
      emitTelemetry()
    } catch (err: any) {
      if (err.message && err.message.includes('No matching pid found')) {
        // Process might have died, let server-manager handle the 'exit' event.
        stopTelemetry(serverId)
      } else {
        log.warn(`[Telemetry] Failed to get pid usage for ${serverId}:`, err)
      }
    }
  }, RESOURCE_POLLING_MS)

  // 2. Server List Ping (Players)
  // Servers usually run on localhost when tracked directly by this process
  const pingInterval = setInterval(async () => {
    try {
      const pingResult = await status('127.0.0.1', server.port, { timeout: 2000 })
      latestOnlinePlayers = pingResult.players.online
      latestMaxPlayers = pingResult.players.max
      previousOnlinePlayers = latestOnlinePlayers
      // We don't emit immediately here because the next resource tick (which is more frequent) will include it
    } catch (err: any) {
      // It's normal for pings to fail while the server is booting up, or if Server List Ping is disabled
      latestOnlinePlayers = previousOnlinePlayers // retain last known
      log.debug(`[Telemetry] Server List Ping failed for ${serverId}: ${err.message}`)
    }
  }, PING_POLLING_MS)

  activeTrackers.set(serverId, { pidInterval, pingInterval })
}

export function stopTelemetry(serverId: string): void {
  const trackers = activeTrackers.get(serverId)
  if (trackers) {
    if (trackers.pidInterval) clearInterval(trackers.pidInterval)
    if (trackers.pingInterval) clearInterval(trackers.pingInterval)
    activeTrackers.delete(serverId)
    log.info(`[Telemetry] Stopped tracking Server ${serverId}`)
    
    // Attempt one last pidusage cleanup to prevent memory leaks in the native tracking (Windows especially)
    pidusage.clear()
  }
}
