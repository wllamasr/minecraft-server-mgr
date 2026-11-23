import { isShuttingDown, listServers, recordScheduledBackup } from './server-manager'
import { createScheduledBackup } from './backup-manager'
import { busyKind } from './server-busy'
import { pushLog } from './console-manager'
import {
  backupStarted,
  isValidBackupKeep,
  isValidBackupSchedule,
  tickBackupSchedule,
  BACKUP_KEEP_DEFAULT,
  type BackupScheduleState,
  type ScheduledBackupResult
} from '../../shared/utils/backup-schedule'
import type { ServerWithStatus } from '../../shared/types'
import log from '../utils/logger'

const TICK_MS = 15_000

const states = new Map<string, BackupScheduleState>()
let timer: NodeJS.Timeout | undefined

/**
 * Carry out the scheduled backups of local servers.
 *
 * Like scheduled restarts, this runs inside the app: a backup is only made
 * while the app is open and the computer is awake, and one that was missed is
 * not caught up. How each one went is stored on the server, because nobody is
 * watching the console at four in the morning.
 */
export function startBackupScheduler(): void {
  if (timer) return
  timer = setInterval(() => {
    try {
      tick(new Date())
    } catch (err) {
      log.error('[BackupScheduler] Tick failed:', err)
    }
  }, TICK_MS)
  // The scheduler alone must not keep the app alive.
  timer.unref()
}

function record(serverId: string, outcome: ScheduledBackupResult['outcome'], message?: string): void {
  try {
    recordScheduledBackup(serverId, { at: new Date().toISOString(), outcome, ...(message ? { message } : {}) })
  } catch (err) {
    log.warn(`[BackupScheduler] Could not store the result for ${serverId}:`, err)
  }
}

function tick(now: Date): void {
  if (isShuttingDown()) return

  const seen = new Set<string>()
  for (const server of listServers()) {
    const schedule = server.backupSchedule
    if (!isValidBackupSchedule(schedule)) continue
    seen.add(server.id)
    try {
      handle(server, schedule, now)
    } catch (err) {
      // One server's trouble must not stop the tick for the others.
      log.error(`[BackupScheduler] Could not handle the schedule of ${server.id}:`, err)
    }
  }

  // Forget servers that were deleted or had their schedule removed.
  for (const id of states.keys()) if (!seen.has(id)) states.delete(id)
}

function handle(server: ServerWithStatus, schedule: string, now: Date): void {
  const serverId = server.id
  const result = tickBackupSchedule(now, schedule, states.get(serverId))
  states.set(serverId, result.state)

  if (result.missed !== undefined) {
    const message = 'It could not be started within 10 minutes of its time (the server was busy, or the computer was asleep)'
    log.warn(`[BackupScheduler] Scheduled backup (${schedule}) of ${serverId} was missed`)
    pushLog(serverId, `Scheduled backup (${schedule}) missed: ${message.charAt(0).toLowerCase()}${message.slice(1)}.`, 'WARN')
    record(serverId, 'missed', message)
    return
  }
  if (result.due === undefined) return

  // Not possible right now (starting, stopping, another backup or a restore):
  // the occurrence stays due and the next tick tries again.
  // A crashed server that restarts by itself is about to start: a backup begun
  // now would make that start fail. It is backed up once it is running again.
  const ready =
    server.status === 'running' || server.status === 'stopped' || (server.status === 'crashed' && !server.autoStart)
  if (!ready || busyKind(serverId)) return

  // Counted as handled from the moment it starts: a backup that fails is
  // reported, not repeated every fifteen seconds.
  states.set(serverId, backupStarted(result.state, result.due))
  const keep = isValidBackupKeep(server.backupKeep) ? server.backupKeep : BACKUP_KEEP_DEFAULT
  pushLog(serverId, `Scheduled backup (${schedule}).`, 'INFO')
  createScheduledBackup(serverId, keep).then(
    (backup) => record(serverId, backup ? 'ok' : 'skipped'),
    (err) => {
      const message = err instanceof Error ? err.message : String(err)
      log.warn(`[BackupScheduler] Scheduled backup of ${serverId} failed: ${message}`)
      record(serverId, 'failed', message)
    }
  )
}
