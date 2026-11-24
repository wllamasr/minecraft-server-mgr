import { describe, expect, it } from 'vitest'
import { PLAYERS_MAX_AGE_MS, readRemoteMetrics, tickView } from './server-metrics'
import { TICK_SAMPLE_MAX_AGE_MS, type TickSample } from './tick-query'

const sample = (over: Partial<TickSample & { at: number }> = {}): TickSample & { at: number } => ({
  averageMs: 12.5, targetMs: 50, targetRate: 20, tps: 20, mode: 'normal', p95Ms: 20.5, at: 1_000_000, ...over
})

describe('tickView', () => {
  it('shows a recent answer', () => {
    expect(tickView(sample(), undefined, 1_000_500)).toEqual({
      state: 'ok', ms: '12.5', used: 25, level: 'fine', targetMs: '50', details: '20.0 TPS · P95 20.5 ms'
    })
  })

  it('says how the server is doing against its target', () => {
    expect(tickView(sample({ averageMs: 35 }), undefined, 1_000_000)).toMatchObject({ level: 'busy', used: 70 })
    expect(tickView(sample({ averageMs: 62.5, tps: 16 }), undefined, 1_000_000)).toMatchObject({
      level: 'over', used: 100, details: '16.0 TPS · P95 20.5 ms'
    })
  })

  it('gives a sprinting or frozen game no ticks per second', () => {
    expect(tickView(sample({ mode: 'sprinting', tps: undefined, averageMs: 0 }), undefined, 1_000_000)).toMatchObject({
      level: 'sprinting', details: 'Sprinting · P95 20.5 ms'
    })
    expect(tickView(sample({ mode: 'frozen' }), undefined, 1_000_000)).toMatchObject({ details: 'Frozen · P95 20.5 ms' })
  })

  it('shows no number without a recent answer, and says why', () => {
    expect(tickView(undefined, undefined, 1)).toEqual({ state: 'waiting', reason: 'Waiting for the server' })
    expect(tickView(undefined, 'unsupported', 1).state).toBe('unsupported')
    expect(tickView(undefined, 'unavailable', 1).state).toBe('unavailable')
    const old = 1_000_000 + TICK_SAMPLE_MAX_AGE_MS + 1
    expect(tickView(sample(), undefined, old).state).toBe('waiting')
    expect(tickView(sample(), 'unavailable', old).state).toBe('unavailable')
    expect(tickView(sample(), undefined, 1_000_000 + TICK_SAMPLE_MAX_AGE_MS).state).toBe('ok')
    // A sample from the future is as little the present as one from the past.
    expect(tickView(sample(), undefined, 1_000_000 - TICK_SAMPLE_MAX_AGE_MS - 1).state).toBe('waiting')
  })
})

describe('readRemoteMetrics', () => {
  const at = 1_700_000_000_000

  it('reads what msmd reports', () => {
    expect(
      readRemoteMetrics({
        serverId: 'abc', at, cpu: 143.2, memory: 2_147_483_648,
        players: { online: 3, max: 20, at: at - 4000 },
        tick: { averageMs: 12.5, targetMs: 50, targetRate: 20, tps: 20, mode: 'normal', p50Ms: 11, p95Ms: 20.5, p99Ms: 30, sampleSize: 100, at: at - 9000 }
      })
    ).toEqual({
      at, cpu: 143.2, memory: 2_147_483_648,
      players: { online: 3, max: 20 },
      tick: { averageMs: 12.5, targetMs: 50, targetRate: 20, tps: 20, mode: 'normal', p50Ms: 11, p95Ms: 20.5, p99Ms: 30, sampleSize: 100, at: at - 9000 }
    })
  })

  it('leaves out what was not measured', () => {
    expect(readRemoteMetrics({ serverId: 'abc', at, tickStatus: 'unsupported' })).toEqual({ at, tickStatus: 'unsupported' })
    expect(readRemoteMetrics({ at, tick: { averageMs: 0, targetMs: 50, targetRate: 20, mode: 'sprinting', at } })?.tick).toEqual({
      averageMs: 0, targetMs: 50, targetRate: 20, mode: 'sprinting', at
    })
  })

  it('takes nothing that is not what it should be', () => {
    expect(readRemoteMetrics(null)).toBeNull()
    expect(readRemoteMetrics('metrics')).toBeNull()
    expect(readRemoteMetrics({ cpu: 1 })).toBeNull() // no clock: ages cannot be judged
    expect(
      readRemoteMetrics({
        at, cpu: '50', memory: -1,
        players: { online: 3.5, max: 20, at },
        tick: { averageMs: 'fast', targetMs: 50, targetRate: 20, mode: 'normal', at },
        tickStatus: 'whatever'
      })
    ).toEqual({ at })
    expect(readRemoteMetrics({ at, cpu: Infinity, memory: NaN })).toEqual({ at })
    expect(readRemoteMetrics({ at, tick: { averageMs: 1, targetMs: 50, targetRate: 20, mode: 'turbo', at } })).toEqual({ at })
  })

  it('never takes more ticks per second than the target, nor any while sprinting', () => {
    const tick = { averageMs: 1, targetMs: 50, targetRate: 20, at }
    expect(readRemoteMetrics({ at, tick: { ...tick, mode: 'normal', tps: 9000 } })?.tick?.tps).toBe(20)
    expect(readRemoteMetrics({ at, tick: { ...tick, mode: 'sprinting', tps: 20 } })?.tick?.tps).toBeUndefined()
  })

  it('does not show a player count the host took long ago', () => {
    const players = { online: 3, max: 20 }
    expect(readRemoteMetrics({ at, players: { ...players, at: at - PLAYERS_MAX_AGE_MS } })?.players).toEqual(players)
    expect(readRemoteMetrics({ at, players: { ...players, at: at - PLAYERS_MAX_AGE_MS - 1 } })?.players).toBeUndefined()
    expect(readRemoteMetrics({ at, players })?.players).toBeUndefined()
  })
})
