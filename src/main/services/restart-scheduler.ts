import { isShuttingDown, listServers, restartServer } from './server-manager'
import { pushLog, sendCommand } from './console-manager'
import {
  isValidRestartSchedule,
  restartWarningMessage,
  tickSchedule,
  type RestartScheduleState
} from '../../shared/utils/restart-schedule'
import { deferredRestartAction, RESTART_WAIT_FOR_BACKUP_MS } from '../../shared/utils/backup-schedule'
import { busyKind } from './server-busy'
import log from '../utils/logger'

const TICK_MS = 15_000

const states = new Map<string, RestartScheduleState>()
/** Servers whose restart is waiting for a backup, with the time (ms) the wait ends. */
const deferred = new Map<string, number>()
let timer: NodeJS.Timeout | undefined

/**
 * Carry out the scheduled restarts of local servers.
 *
 * This runs inside the app, so schedules only fire while the app is open and
 * the computer is awake; a restart that was missed is skipped, not caught up.
 */
export function startRestartScheduler(): void {
  if (timer) return
  timer = setInterval(() => {
    try {
      tick(new Date())
    } catch (err) {
      log.error('[RestartScheduler] Tick failed:', err)
    }
  }, TICK_MS)
  // The scheduler alone must not keep the app alive.
  timer.unref()
}

function tick(now: Date): void {
  if (isShuttingDown()) return

  const seen = new Set<string>()
  for (const server of listServers()) {
    const schedule = server.restartSchedule
    if (!isValidRestartSchedule(schedule)) continue
    seen.add(server.id)
    try {
      handle(server.id, schedule, server.status === 'running', now)
    } catch (err) {
      // One server's trouble must not stop the tick for the others.
      log.error(`[RestartScheduler] Could not handle the schedule of ${server.id}:`, err)
    }
  }

  // Forget servers that were deleted or had their schedule removed.
  for (const id of states.keys()) if (!seen.has(id)) states.delete(id)
  for (const id of deferred.keys()) if (!seen.has(id)) deferred.delete(id)
}

function restartNow(serverId: string, schedule: string): void {
  pushLog(serverId, `Scheduled restart (${schedule}) — restarting now.`, 'INFO')
  sendCommand(serverId, 'say Server is restarting now')
  restartServer(serverId).catch((err) => {
    const message = err instanceof Error ? err.message : String(err)
    log.warn(`[RestartScheduler] Scheduled restart of ${serverId} failed: ${message}`)
    pushLog(serverId, `Scheduled restart failed: ${message}`, 'ERROR')
  })
}

function handle(serverId: string, schedule: string, running: boolean, now: Date): void {
  const result = tickSchedule(now, schedule, running, states.get(serverId))
  states.set(serverId, result.state)

  if (result.warnSeconds !== undefined) {
    const message = restartWarningMessage(result.warnSeconds)
    pushLog(serverId, `${message}.`, 'INFO')
    sendCommand(serverId, `say ${message}`)
  }

  // A restart that was put off because a backup was running.
  const deadline = deferred.get(serverId)
  if (deadline !== undefined) {
    const action = deferredRestartAction(now.getTime(), deadline, running, busyKind(serverId) === 'backup')
    if (action === 'wait') return
    deferred.delete(serverId)
    if (action === 'restart') restartNow(serverId, schedule)
    return
  }

  if (result.restart) {
    // Stopping the server cancels a backup in progress. A backup scheduled a
    // few minutes before the restart would then never finish, night after
    // night, so the restart waits for it (for a limited time).
    if (busyKind(serverId) === 'backup') {
      deferred.set(serverId, now.getTime() + RESTART_WAIT_FOR_BACKUP_MS)
      pushLog(serverId, `Scheduled restart (${schedule}) is waiting for the backup in progress to finish.`, 'INFO')
      return
    }
    restartNow(serverId, schedule)
  }
}
