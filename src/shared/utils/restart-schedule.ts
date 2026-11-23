/**
 * Daily scheduled restarts.
 *
 * A schedule is a wall-clock time, "HH:MM" (24 h), in the local time zone of
 * the machine that runs the server. The scheduler is a stateless tick: every
 * few seconds it asks {@link tickSchedule} what to do right now. The only
 * memory is which occurrence was already handled or warned about, so nothing
 * has to be cancelled when a server is stopped, edited or deleted.
 *
 * The msmd daemon implements the same rules in Go (daemon/internal/schedule).
 */

/** Players are warned this many seconds before a scheduled restart. */
export const RESTART_WARNINGS_S = [300, 60] as const

/** An occurrence that is noticed later than this (sleep, suspend) is skipped. */
export const RESTART_LATE_TOLERANCE_MS = 60_000

const SCHEDULE_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/

export function isValidRestartSchedule(value: unknown): value is string {
  return typeof value === 'string' && SCHEDULE_PATTERN.test(value)
}

/** The last occurrence at or before `now`, and the first one after it. */
export function restartOccurrences(now: Date, schedule: string): { prev: Date; next: Date } {
  const match = SCHEDULE_PATTERN.exec(schedule)
  if (!match) throw new Error(`Invalid restart schedule: ${schedule}`)
  const hours = Number(match[1])
  const minutes = Number(match[2])

  // Built from calendar dates, not by adding 24 h, so the schedule keeps its
  // wall-clock time across daylight-saving changes.
  let prev: Date | undefined
  let next: Date | undefined
  for (let offset = -2; offset <= 2; offset++) {
    const at = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, hours, minutes, 0, 0)
    if (at.getTime() <= now.getTime()) {
      if (!prev || at.getTime() > prev.getTime()) prev = at
    } else if (!next || at.getTime() < next.getTime()) {
      next = at
    }
  }
  if (!prev || !next) throw new Error('Could not compute the restart schedule')
  return { prev, next }
}

/** What the scheduler remembers about one server between ticks. */
export interface RestartScheduleState {
  /** The schedule this state was built for; a changed schedule starts over. */
  schedule: string
  /** Time (ms) of the newest occurrence that was already dealt with. */
  handled: number
  /** Occurrence (ms) the warnings below belong to. */
  warnedFor: number
  /** Warning offsets (seconds) already sent, or skipped, for `warnedFor`. */
  warned: number[]
}

export interface RestartTick {
  state: RestartScheduleState
  /** Send the "restarting in N seconds" warning for this offset. */
  warnSeconds?: number
  /** Restart the server now. */
  restart: boolean
}

/**
 * Decide what to do for one server at `now`.
 *
 * - A restart is due when an occurrence has passed since the last tick. It is
 *   only carried out if the server is running at that moment and the tick is
 *   not too late; either way the occurrence counts as handled, so a server
 *   that is started a minute later is not restarted at once.
 * - Warnings are sent only to a running server, each once per occurrence. A
 *   schedule that is set less than a warning's lead time ahead skips that
 *   warning instead of sending it late.
 */
export function tickSchedule(
  now: Date,
  schedule: string,
  running: boolean,
  previous: RestartScheduleState | undefined
): RestartTick {
  const { prev, next } = restartOccurrences(now, schedule)
  const nextMs = next.getTime()
  const remainingMs = nextMs - now.getTime()

  let state = previous
  if (!state || state.schedule !== schedule) {
    // First look at this schedule: nothing in the past is due, and warnings
    // whose moment has already gone by are not sent late.
    state = {
      schedule,
      handled: prev.getTime(),
      warnedFor: nextMs,
      warned: RESTART_WARNINGS_S.filter((s) => remainingMs < (s - 30) * 1000)
    }
  } else {
    state = { ...state, warned: [...state.warned] }
  }

  let restart = false
  if (prev.getTime() > state.handled) {
    restart = running && now.getTime() - prev.getTime() <= RESTART_LATE_TOLERANCE_MS
    state.handled = prev.getTime()
  }

  if (state.warnedFor !== nextMs) {
    state.warnedFor = nextMs
    state.warned = []
  }

  let warnSeconds: number | undefined
  // The tightest warning whose moment has come; wider ones are then moot.
  const due = RESTART_WARNINGS_S.filter((s) => remainingMs <= s * 1000)
  const tightest = due[due.length - 1]
  if (tightest !== undefined && !state.warned.includes(tightest)) {
    // Nobody to warn on a stopped server: the warning counts as skipped, so a
    // server started three minutes before is not told "in 5 minutes".
    if (running && !restart) warnSeconds = tightest
    for (const s of due) if (!state.warned.includes(s)) state.warned.push(s)
  }

  return { state, warnSeconds, restart }
}

/** The line announced to players, e.g. "Server restarting in 5 minutes". */
export function restartWarningMessage(seconds: number): string {
  if (seconds >= 60) {
    const minutes = Math.round(seconds / 60)
    return `Scheduled restart in ${minutes} minute${minutes === 1 ? '' : 's'}`
  }
  return `Scheduled restart in ${seconds} seconds`
}
