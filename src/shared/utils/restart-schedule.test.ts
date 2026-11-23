import { describe, it, expect, beforeAll } from 'vitest'

// The schedule is wall-clock time, so the tests need a zone with daylight
// saving. Set before any Date is created.
process.env.TZ = 'America/New_York'

import {
  isValidRestartSchedule,
  restartOccurrences,
  restartWarningMessage,
  tickSchedule,
  type RestartScheduleState
} from './restart-schedule'

/** Local wall-clock time in the test zone. */
const at = (y: number, mo: number, d: number, h: number, mi: number, s = 0): Date => new Date(y, mo - 1, d, h, mi, s)

/** Run the scheduler every 15 s from `from` to `to` and collect what it did. */
function run(
  schedule: string,
  from: Date,
  to: Date,
  running: (now: Date) => boolean = () => true,
  initial?: RestartScheduleState
): { events: string[]; state: RestartScheduleState | undefined } {
  const events: string[] = []
  let state = initial
  for (let t = from.getTime(); t <= to.getTime(); t += 15_000) {
    const now = new Date(t)
    const tick = tickSchedule(now, schedule, running(now), state)
    state = tick.state
    const stamp = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
    if (tick.warnSeconds) events.push(`${stamp} warn ${tick.warnSeconds}`)
    if (tick.restart) events.push(`${stamp} restart`)
  }
  return { events, state }
}

beforeAll(() => {
  // If the zone did not take effect the daylight-saving tests would pass
  // without testing anything.
  expect(new Date(2026, 0, 1).getTimezoneOffset()).toBe(300)
  expect(new Date(2026, 6, 1).getTimezoneOffset()).toBe(240)
})

describe('isValidRestartSchedule', () => {
  it('accepts 24-hour HH:MM only', () => {
    for (const ok of ['00:00', '04:30', '23:59']) expect(isValidRestartSchedule(ok)).toBe(true)
    for (const bad of ['24:00', '4:30', '04:60', '04:30:00', '', ' 04:30', '04:30\n', null, undefined, 430]) {
      expect(isValidRestartSchedule(bad)).toBe(false)
    }
  })
})

describe('restartOccurrences', () => {
  it('brackets now with the previous and the next occurrence', () => {
    const { prev, next } = restartOccurrences(at(2026, 6, 10, 12, 0), '04:30')
    expect(prev).toEqual(at(2026, 6, 10, 4, 30))
    expect(next).toEqual(at(2026, 6, 11, 4, 30))
  })

  it('counts an occurrence that is exactly now as passed', () => {
    const { prev, next } = restartOccurrences(at(2026, 6, 10, 4, 30), '04:30')
    expect(prev).toEqual(at(2026, 6, 10, 4, 30))
    expect(next).toEqual(at(2026, 6, 11, 4, 30))
  })

  it('keeps the wall-clock time across a daylight-saving change', () => {
    // Clocks go back on 2026-11-01: the day is 25 hours long.
    const { prev, next } = restartOccurrences(at(2026, 10, 31, 12, 0), '04:30')
    expect(prev).toEqual(at(2026, 10, 31, 4, 30))
    expect(next).toEqual(at(2026, 11, 1, 4, 30))
    expect(next.getHours()).toBe(4)
    expect(next.getTime() - prev.getTime()).toBe(25 * 3600_000)
  })

  it('rejects a malformed schedule', () => {
    expect(() => restartOccurrences(new Date(), '25:00')).toThrow()
  })
})

describe('tickSchedule', () => {
  it('warns 5 minutes and 1 minute ahead, then restarts once', () => {
    const { events } = run('04:30', at(2026, 6, 10, 4, 0), at(2026, 6, 10, 5, 0))
    expect(events).toEqual(['04:25 warn 300', '04:29 warn 60', '04:30 restart'])
  })

  it('sends the warnings of a 00:02 schedule before midnight', () => {
    const { events } = run('00:02', at(2026, 6, 10, 23, 50), at(2026, 6, 11, 0, 10))
    expect(events).toEqual(['23:57 warn 300', '00:01 warn 60', '00:02 restart'])
  })

  it('does nothing for an occurrence that passed before it first looked', () => {
    const { events } = run('04:30', at(2026, 6, 10, 4, 30, 15), at(2026, 6, 10, 6, 0))
    expect(events).toEqual([])
  })

  it('sends only the 1-minute warning when the schedule is set 2 minutes ahead', () => {
    const { events } = run('04:30', at(2026, 6, 10, 4, 28), at(2026, 6, 10, 4, 40))
    expect(events).toEqual(['04:29 warn 60', '04:30 restart'])
  })

  it('still sends the 5-minute warning when the schedule is set 5 minutes ahead', () => {
    const { events } = run('04:30', at(2026, 6, 10, 4, 25, 10), at(2026, 6, 10, 4, 31))
    expect(events).toEqual(['04:25 warn 300', '04:29 warn 60', '04:30 restart'])
  })

  it('neither restarts nor starts a server that was stopped after the warning', () => {
    const stopAt = at(2026, 6, 10, 4, 27).getTime()
    const { events } = run('04:30', at(2026, 6, 10, 4, 0), at(2026, 6, 10, 5, 0), (now) => now.getTime() < stopAt)
    expect(events).toEqual(['04:25 warn 300'])
  })

  it('does not restart a server that is started just after the scheduled time', () => {
    const startAt = at(2026, 6, 10, 4, 30, 30).getTime()
    const { events } = run('04:30', at(2026, 6, 10, 4, 0), at(2026, 6, 10, 5, 0), (now) => now.getTime() >= startAt)
    expect(events).toEqual([])
  })

  it('does not send a stale warning to a server started 3 minutes before', () => {
    const startAt = at(2026, 6, 10, 4, 27).getTime()
    const { events } = run('04:30', at(2026, 6, 10, 4, 0), at(2026, 6, 10, 4, 40), (now) => now.getTime() >= startAt)
    expect(events).toEqual(['04:29 warn 60', '04:30 restart'])
  })

  it('skips an occurrence it notices too late (the computer was asleep)', () => {
    const before = run('04:30', at(2026, 6, 10, 4, 0), at(2026, 6, 10, 4, 10))
    const later = run('04:30', at(2026, 6, 10, 7, 0), at(2026, 6, 10, 7, 10), () => true, before.state)
    expect(later.events).toEqual([])
    // ...and the next day is unaffected.
    const nextDay = run('04:30', at(2026, 6, 11, 4, 20), at(2026, 6, 11, 4, 40), () => true, later.state)
    expect(nextDay.events).toEqual(['04:25 warn 300', '04:29 warn 60', '04:30 restart'])
  })

  it('restarts every day', () => {
    const { events } = run('04:30', at(2026, 6, 10, 0, 0), at(2026, 6, 13, 0, 0))
    expect(events.filter((e) => e.endsWith('restart'))).toHaveLength(3)
    expect(events).toHaveLength(9)
  })

  it('starts over when the schedule changes', () => {
    const first = run('04:30', at(2026, 6, 10, 4, 0), at(2026, 6, 10, 4, 26))
    expect(first.events).toEqual(['04:25 warn 300'])
    const changed = run('06:00', at(2026, 6, 10, 4, 26, 15), at(2026, 6, 10, 6, 10), () => true, first.state)
    expect(changed.events).toEqual(['05:55 warn 300', '05:59 warn 60', '06:00 restart'])
  })

  it('fires once on the day the clocks go back (01:30 happens twice)', () => {
    const { events } = run('01:30', at(2026, 10, 31, 12, 0), new Date(at(2026, 11, 1, 12, 0)))
    expect(events.filter((e) => e.endsWith('restart'))).toHaveLength(1)
    expect(events.filter((e) => e.includes('warn'))).toHaveLength(2)
  })

  it('fires once, an hour late, on the day the clocks skip the scheduled time', () => {
    // 2026-03-08: 02:00 jumps to 03:00, so 02:30 does not exist.
    const { events } = run('02:30', at(2026, 3, 7, 12, 0), at(2026, 3, 8, 12, 0))
    expect(events).toEqual(['03:25 warn 300', '03:29 warn 60', '03:30 restart'])
  })
})

describe('restartWarningMessage', () => {
  it('speaks in minutes or seconds', () => {
    expect(restartWarningMessage(300)).toBe('Scheduled restart in 5 minutes')
    expect(restartWarningMessage(60)).toBe('Scheduled restart in 1 minute')
    expect(restartWarningMessage(10)).toBe('Scheduled restart in 10 seconds')
  })
})
