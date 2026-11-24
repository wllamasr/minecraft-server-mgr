import pidusage from 'pidusage'
import { status } from 'minecraft-server-util'
import { BrowserWindow } from 'electron'
import { getRunningProcess, getServer } from './server-manager'
import { sendCommand, setLineFilter } from './console-manager'
import { createTickAnswerFilter, isServerReadyLine, supportsTickQuery, TickQueryPolicy, type TickSample } from '../../shared/utils/tick-query'
import type { ServerTelemetry } from '../../shared/types/telemetry.types'
import log from '../utils/logger'

interface TelemetryTrackers {
  pidInterval?: NodeJS.Timeout
  pingInterval?: NodeJS.Timeout
  tickInterval?: NodeJS.Timeout
  /** Someone is looking at this server's numbers now. */
  watch: () => void
}

const activeTrackers = new Map<string, TelemetryTrackers>()

const RESOURCE_POLLING_MS = 2000
const PING_POLLING_MS = 5000
const TICK_CHECK_MS = 1000

/**
 * Say that a server's numbers are on screen. Its tick time is only asked for
 * while this keeps being said (see TickQueryPolicy): the question and its
 * answer go into the server's own log file every time.
 */
export function watchTelemetry(serverId: string): void {
  activeTrackers.get(serverId)?.watch()
}

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

  // Tick time, from the server's own answer to "tick query".
  const policy = new TickQueryPolicy(supportsTickQuery(server.minecraftVersion))
  // The answers to our own questions are kept out of the app's console.
  const answers = createTickAnswerFilter()
  let latestTick: (TickSample & { at: number }) | undefined

  const emitTelemetry = () => {
    const data: ServerTelemetry = {
      serverId,
      cpu: latestCpu,
      memory: latestMemory,
      onlinePlayers: latestOnlinePlayers,
      maxPlayers: latestMaxPlayers,
      tick: latestTick,
      tickStatus: policy.status,
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

  // 3. Tick time
  setLineFilter(serverId, (line) => {
    if (isServerReadyLine(line)) policy.serverReady()
    const now = Date.now()
    const read = answers.feed(line, now)
    if (read.sample) {
      latestTick = { ...read.sample, at: now }
      policy.answered()
      try {
        emitTelemetry()
      } catch (err) {
        // Whether the line is shown must not depend on a window being there.
        log.warn(`[Telemetry] Could not report the tick time of ${serverId}:`, err)
      }
    }
    return read.own
  })

  const askIfDue = (): void => {
    try {
      const now = Date.now()
      if (!policy.shouldAsk(now, true)) return
      // Not while it is stopping: it no longer reads its console.
      if (getServer(serverId)?.status !== 'running') return
      if (!sendCommand(serverId, 'tick query', { quiet: true })) return
      policy.asked(now)
      answers.asked(now)
    } catch (err) {
      // Runs on a timer: nothing above it would catch this.
      log.warn(`[Telemetry] Could not ask ${serverId} for its tick time:`, err)
    }
  }
  const tickInterval = setInterval(askIfDue, TICK_CHECK_MS)

  activeTrackers.set(serverId, {
    pidInterval,
    pingInterval,
    tickInterval,
    watch: () => {
      policy.watch(Date.now())
      askIfDue()
    }
  })
}

export function stopTelemetry(serverId: string): void {
  const trackers = activeTrackers.get(serverId)
  if (trackers) {
    if (trackers.pidInterval) clearInterval(trackers.pidInterval)
    if (trackers.pingInterval) clearInterval(trackers.pingInterval)
    if (trackers.tickInterval) clearInterval(trackers.tickInterval)
    setLineFilter(serverId, null)
    activeTrackers.delete(serverId)
    log.info(`[Telemetry] Stopped tracking Server ${serverId}`)
    
    // Attempt one last pidusage cleanup to prevent memory leaks in the native tracking (Windows especially)
    pidusage.clear()
  }
}
