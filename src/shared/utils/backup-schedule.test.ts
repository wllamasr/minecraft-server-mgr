import { describe, it, expect } from 'vitest'
import {
  BACKUP_START_WINDOW_MS,
  backupStarted,
  deferredRestartAction,
  isValidBackupKeep,
  isValidBackupSchedule,
  parseScheduledBackupResult,
  scheduledBackupsToPrune,
  tickBackupSchedule,
  type BackupScheduleState
} from './backup-schedule'

const at = (h: number, m: number, s = 0, day = 10): Date => new Date(2026, 5, day, h, m, s)

describe('validation', () => {
  it('accepts HH:MM and a sensible number to keep', () => {
    expect(isValidBackupSchedule('04:30')).toBe(true)
    expect(isValidBackupSchedule('24:00')).toBe(false)
    expect(isValidBackupSchedule(null)).toBe(false)
    for (const keep of [1, 7, 365]) expect(isValidBackupKeep(keep)).toBe(true)
    for (const keep of [0, -1, 366, 2.5, '7', null, NaN, Infinity]) expect(isValidBackupKeep(keep)).toBe(false)
  })
})

describe('tickBackupSchedule', () => {
  it('does nothing the first time it sees a schedule, even right after its time', () => {
    const tick = tickBackupSchedule(at(4, 0, 5), '04:00', undefined)
    expect(tick.due).toBeUndefined()
    expect(tick.missed).toBeUndefined()
    expect(tick.state.handled).toBe(at(4, 0).getTime())
  })

  it('is due once the time passes and stays due until it was started', () => {
    let state = tickBackupSchedule(at(3, 59, 50), '04:00', undefined).state
    expect(tickBackupSchedule(at(3, 59, 55), '04:00', state).due).toBeUndefined()

    const first = tickBackupSchedule(at(4, 0, 5), '04:00', state)
    expect(first.due).toBe(at(4, 0).getTime())
    // Could not start (server busy): the next tick asks again.
    const again = tickBackupSchedule(at(4, 0, 20), '04:00', first.state)
    expect(again.due).toBe(at(4, 0).getTime())

    state = backupStarted(again.state, again.due as number)
    expect(tickBackupSchedule(at(4, 0, 35), '04:00', state).due).toBeUndefined()
    // And the day after it is due again.
    expect(tickBackupSchedule(at(4, 0, 5, 11), '04:00', state).due).toBe(at(4, 0, 0, 11).getTime())
  })

  it('gives an occurrence up when it could not be started in time', () => {
    const state = tickBackupSchedule(at(3, 0), '04:00', undefined).state
    const late = new Date(at(4, 0).getTime() + BACKUP_START_WINDOW_MS + 1000)
    const tick = tickBackupSchedule(late, '04:00', state)
    expect(tick.due).toBeUndefined()
    expect(tick.missed).toBe(at(4, 0).getTime())
    // Reported once.
    expect(tickBackupSchedule(new Date(late.getTime() + 15_000), '04:00', tick.state).missed).toBeUndefined()
  })

  it('skips what was missed while the computer slept, without catching up', () => {
    const state = tickBackupSchedule(at(3, 0), '04:00', undefined).state
    const tick = tickBackupSchedule(at(9, 0, 0, 12), '04:00', state)
    expect(tick.due).toBeUndefined()
    expect(tick.missed).toBe(at(4, 0, 0, 12).getTime())
  })

  it('starts over when the schedule changes', () => {
    const state: BackupScheduleState = tickBackupSchedule(at(3, 0), '04:00', undefined).state
    const tick = tickBackupSchedule(at(3, 30, 10), '03:30', state)
    expect(tick.due).toBeUndefined()
    expect(tick.state).toEqual({ schedule: '03:30', handled: at(3, 30).getTime() })
  })
})

describe('scheduledBackupsToPrune', () => {
  const ids = [
    '20260601-040000-scheduled',
    '20260602-040000-scheduled',
    '20260603-040000-scheduled',
    '20260604-040000-scheduled',
    '20260101-120000-manual',
    '20260102-120000-pre-restore'
  ]

  it('keeps the newest scheduled ones and never touches the other kinds', () => {
    expect(scheduledBackupsToPrune(ids, 2)).toEqual(['20260602-040000-scheduled', '20260601-040000-scheduled'])
    expect(scheduledBackupsToPrune(ids, 4)).toEqual([])
    expect(scheduledBackupsToPrune(ids, 10)).toEqual([])
    expect(scheduledBackupsToPrune(ids, 1)).toHaveLength(3)
  })

  it('never chooses the backup that was just made, even when the clock went back', () => {
    const withOld = [...ids, '20250101-040000-scheduled']
    const pruned = scheduledBackupsToPrune(withOld, 2, '20250101-040000-scheduled')
    expect(pruned).not.toContain('20250101-040000-scheduled')
    // It takes one of the two places; the newest other one takes the second.
    expect(pruned).toEqual(['20260603-040000-scheduled', '20260602-040000-scheduled', '20260601-040000-scheduled'])
  })

  it('deletes nothing for a number that makes no sense', () => {
    for (const keep of [0, -3, 1.5, NaN]) expect(scheduledBackupsToPrune(ids, keep)).toEqual([])
  })

  it('ignores names that are not backup ids', () => {
    expect(scheduledBackupsToPrune(['x-scheduled', '../../a-scheduled', 'scheduled'], 1)).toEqual([])
  })
})

describe('parseScheduledBackupResult', () => {
  it('reads what was stored and rejects anything else', () => {
    const stored = JSON.stringify({ at: '2026-06-10T04:00:10.000Z', outcome: 'failed', message: 'disk full' })
    expect(parseScheduledBackupResult(stored)).toEqual({ at: '2026-06-10T04:00:10.000Z', outcome: 'failed', message: 'disk full' })
    expect(parseScheduledBackupResult(JSON.stringify({ at: '2026-06-10T04:00:10.000Z', outcome: 'ok' }))).toEqual({
      at: '2026-06-10T04:00:10.000Z',
      outcome: 'ok'
    })
    for (const raw of [null, '', 'x', '{}', '{"at":"nope","outcome":"ok"}', '{"at":"2026-06-10T04:00:10.000Z","outcome":"great"}', 5]) {
      expect(parseScheduledBackupResult(raw)).toBeNull()
    }
  })
})

describe('deferredRestartAction', () => {
  it('waits for the backup, but not for ever', () => {
    expect(deferredRestartAction(1000, 5000, true, true)).toBe('wait')
    expect(deferredRestartAction(1000, 5000, true, false)).toBe('restart')
    expect(deferredRestartAction(5000, 5000, true, true)).toBe('restart')
    expect(deferredRestartAction(1000, 5000, false, true)).toBe('drop')
    expect(deferredRestartAction(1000, 5000, false, false)).toBe('drop')
    // The computer slept through the wait: no restart hours later.
    expect(deferredRestartAction(5000 + 3_600_000, 5000, true, false)).toBe('drop')
    expect(deferredRestartAction(5000 + 30_000, 5000, true, true)).toBe('restart')
  })
})
