/**
 * Daily scheduled backups and how many of them are kept.
 *
 * A schedule is a wall-clock time, "HH:MM" (24 h), in the local time zone,
 * exactly like a scheduled restart (see restart-schedule.ts). The scheduler
 * is a tick that asks {@link tickBackupSchedule} what is due right now.
 *
 * Unlike a restart, a backup that cannot start at its minute (the server is
 * starting, another backup is running) is tried again on the following ticks,
 * for {@link BACKUP_START_WINDOW_MS}. After that the occurrence is missed.
 */
import { isValidRestartSchedule, restartOccurrences, RESTART_LATE_TOLERANCE_MS } from './restart-schedule'

/** How long after its time a scheduled backup may still be started. */
export const BACKUP_START_WINDOW_MS = 10 * 60_000

export const BACKUP_KEEP_DEFAULT = 7
export const BACKUP_KEEP_MIN = 1
export const BACKUP_KEEP_MAX = 365

export function isValidBackupSchedule(value: unknown): value is string {
  return isValidRestartSchedule(value)
}

/** How many scheduled backups to keep: a whole number within the limits. */
export function isValidBackupKeep(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= BACKUP_KEEP_MIN && value <= BACKUP_KEEP_MAX
}

/** What the scheduler remembers about one server between ticks. */
export interface BackupScheduleState {
  /** The schedule this state was built for; a changed schedule starts over. */
  schedule: string
  /** Time (ms) of the newest occurrence that was started or given up on. */
  handled: number
}

export interface BackupTick {
  state: BackupScheduleState
  /**
   * An occurrence (ms) whose backup should be started now. It stays due on the
   * following ticks until the caller reports it with {@link backupStarted}.
   */
  due?: number
  /** An occurrence (ms) that could not be started in time and is given up on. */
  missed?: number
}

/**
 * Decide what to do for one server at `now`.
 *
 * Nothing in the past is due the first time a schedule is seen: turning a
 * schedule on, or opening the app, never triggers a backup by itself.
 */
export function tickBackupSchedule(now: Date, schedule: string, previous: BackupScheduleState | undefined): BackupTick {
  const prev = restartOccurrences(now, schedule).prev.getTime()
  if (!previous || previous.schedule !== schedule) {
    return { state: { schedule, handled: prev } }
  }
  if (prev <= previous.handled) return { state: previous }
  if (now.getTime() - prev > BACKUP_START_WINDOW_MS) {
    return { state: { schedule, handled: prev }, missed: prev }
  }
  return { state: previous, due: prev }
}

/** The state after the backup of `occurrence` was started. */
export function backupStarted(state: BackupScheduleState, occurrence: number): BackupScheduleState {
  return { ...state, handled: Math.max(state.handled, occurrence) }
}

const SCHEDULED_ID = /^\d{8}-\d{6}-scheduled$/

/**
 * The scheduled backups to delete so that only the newest `keep` remain.
 * Backups of any other kind (made by hand, or before a restore) are never
 * chosen, and neither is `justCreated`, whatever the clock said when its id
 * was made.
 */
export function scheduledBackupsToPrune(ids: readonly string[], keep: number, justCreated?: string): string[] {
  if (!isValidBackupKeep(keep)) return []
  const scheduled = ids.filter((id) => SCHEDULED_ID.test(id)).sort((a, b) => b.localeCompare(a))
  // The new one always counts as kept, wherever it sorts.
  const others = scheduled.filter((id) => id !== justCreated)
  const room = justCreated !== undefined && scheduled.includes(justCreated) ? keep - 1 : keep
  return others.slice(Math.max(0, room))
}

/** How the last scheduled backup of a server went. */
export interface ScheduledBackupResult {
  /** ISO timestamp of when this was recorded. */
  at: string
  /**
   * `ok`: a backup was made. `skipped`: nothing had changed on a stopped
   * server. `missed`: it could not be started in time. `failed`: it started
   * and did not finish.
   */
  outcome: 'ok' | 'skipped' | 'missed' | 'failed'
  message?: string
}

const OUTCOMES = ['ok', 'skipped', 'missed', 'failed']

/**
 * Check a result that came from elsewhere (the app's database, or a remote
 * host's answer); null when it is not one.
 */
export function readScheduledBackupResult(input: unknown): ScheduledBackupResult | null {
  if (!input || typeof input !== 'object') return null
  const value = input as Partial<ScheduledBackupResult>
  if (typeof value.at !== 'string' || Number.isNaN(Date.parse(value.at))) return null
  if (typeof value.outcome !== 'string' || !OUTCOMES.includes(value.outcome)) return null
  return {
    at: value.at,
    outcome: value.outcome,
    ...(typeof value.message === 'string' && value.message ? { message: value.message } : {})
  }
}

/** Read the stored result (a JSON string); null when there is none. */
export function parseScheduledBackupResult(raw: unknown): ScheduledBackupResult | null {
  if (typeof raw !== 'string' || !raw) return null
  try {
    return readScheduledBackupResult(JSON.parse(raw))
  } catch {
    return null
  }
}

/** True when a restart is scheduled less than 15 minutes after a backup starts. */
export function restartFollowsBackupClosely(backup: string, restart: string | null | undefined): boolean {
  if (!restart || !isValidBackupSchedule(backup) || !isValidRestartSchedule(restart)) return false
  const minutes = (time: string): number => {
    const [h, m] = time.split(':').map(Number)
    return h * 60 + m
  }
  const gap = (minutes(restart) - minutes(backup) + 1440) % 1440
  return gap < RESTART_WAIT_FOR_BACKUP_MS / 60_000
}

/** How long a scheduled restart waits for a backup in progress before going ahead. */
export const RESTART_WAIT_FOR_BACKUP_MS = 15 * 60_000

/**
 * What to do with a scheduled restart that was put off because a backup was
 * running when it came due.
 */
export function deferredRestartAction(
  now: number,
  deadline: number,
  serverRunning: boolean,
  backupRunning: boolean
): 'wait' | 'restart' | 'drop' {
  if (!serverRunning) return 'drop'
  // Noticed long after the wait was over (the computer slept): too late, like
  // any other scheduled restart.
  if (now - deadline > RESTART_LATE_TOLERANCE_MS) return 'drop'
  if (backupRunning && now < deadline) return 'wait'
  return 'restart'
}
