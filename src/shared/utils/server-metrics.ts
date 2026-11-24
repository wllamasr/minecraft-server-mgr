/**
 * What a running server is doing, as shown in the app: the rules for showing
 * a tick time (shared by local and remote servers) and the reading of the
 * metrics a remote host (msmd) reports.
 */
import { TICK_SAMPLE_MAX_AGE_MS, type TickSample } from './tick-query'

export type TickStatus = 'unsupported' | 'unavailable'

/** How a tick time is to be shown. */
export type TickView =
  | {
      state: 'ok'
      /** Average milliseconds per tick, e.g. "12.5". */
      ms: string
      /** The tick's share of the time it has, 0–100. */
      used: number
      /** How it is doing: fine, close to its limit, over it; or sprinting. */
      level: 'fine' | 'busy' | 'over' | 'sprinting'
      /** The time one tick has, e.g. "50". */
      targetMs: string
      /** "20.0 TPS · P95 20.5 ms", or "Sprinting"/"Frozen" in place of the TPS. */
      details: string
    }
  | { state: 'waiting' | TickStatus; reason: string }

/**
 * Decide how to show a tick time. `now` must be on the same clock as
 * `tick.at` (the machine that took the sample).
 *
 * Without a recent answer there is no number: a made-up 20 TPS would read as
 * "all is well". A sprinting game ignores its target and a frozen one is not
 * ticking, so neither gets ticks per second.
 */
export function tickView(
  tick: (TickSample & { at: number }) | undefined,
  status: TickStatus | undefined,
  now: number
): TickView {
  const fresh = tick && now - tick.at <= TICK_SAMPLE_MAX_AGE_MS && now - tick.at >= -TICK_SAMPLE_MAX_AGE_MS
  if (!tick || !fresh) {
    if (status === 'unsupported') return { state: status, reason: 'Needs Minecraft 1.20.3 or newer' }
    if (status === 'unavailable') return { state: status, reason: 'This server does not answer "tick query"' }
    return { state: 'waiting', reason: 'Waiting for the server' }
  }
  const used = tick.targetMs > 0 ? Math.min((tick.averageMs / tick.targetMs) * 100, 100) : 0
  const level = tick.mode === 'sprinting' ? 'sprinting' : used >= 100 ? 'over' : used >= 60 ? 'busy' : 'fine'
  const details = [
    tick.mode === 'sprinting' ? 'Sprinting' : tick.mode === 'frozen' ? 'Frozen' : `${(tick.tps ?? tick.targetRate).toFixed(1)} TPS`
  ]
  if (tick.p95Ms !== undefined) details.push(`P95 ${tick.p95Ms.toFixed(1)} ms`)
  return {
    state: 'ok',
    ms: tick.averageMs.toFixed(1),
    used,
    level,
    targetMs: tick.targetMs.toFixed(0),
    details: details.join(' · ')
  }
}

/** The metrics of a server on a remote host, as msmd reports them. */
export interface RemoteServerMetrics {
  /** The host's clock when it put this together (epoch ms). Ages are judged against it. */
  at: number
  /** Processor use in percent of one core (200 = two cores busy). */
  cpu?: number
  /** Physical memory in use, bytes. */
  memory?: number
  players?: { online: number; max: number }
  tick?: TickSample & { at: number }
  tickStatus?: TickStatus
}

/** A player count older than this (on the host's clock) is not shown. */
export const PLAYERS_MAX_AGE_MS = 30_000

function finite(value: unknown, min = 0): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= min ? value : undefined
}

/**
 * Read what a host answered to a metrics request. The host is another
 * machine: only numbers of the expected kind are taken, anything else is
 * left out as if it had not been measured. Returns null for something that
 * is not a metrics answer at all.
 */
export function readRemoteMetrics(raw: unknown): RemoteServerMetrics | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const at = finite(r.at, 1)
  if (at === undefined) return null
  const out: RemoteServerMetrics = { at }

  const cpu = finite(r.cpu)
  if (cpu !== undefined) out.cpu = cpu
  const memory = finite(r.memory)
  if (memory !== undefined) out.memory = memory

  if (typeof r.players === 'object' && r.players !== null) {
    const p = r.players as Record<string, unknown>
    const online = finite(p.online)
    const max = finite(p.max)
    const playersAt = finite(p.at, 1)
    const recent = playersAt !== undefined && Math.abs(at - playersAt) <= PLAYERS_MAX_AGE_MS
    if (online !== undefined && max !== undefined && recent && Number.isInteger(online) && Number.isInteger(max)) {
      out.players = { online, max }
    }
  }

  if (typeof r.tick === 'object' && r.tick !== null) {
    const t = r.tick as Record<string, unknown>
    const averageMs = finite(t.averageMs)
    const targetMs = finite(t.targetMs)
    const targetRate = finite(t.targetRate)
    const tickAt = finite(t.at, 1)
    const mode = t.mode === 'sprinting' || t.mode === 'frozen' ? t.mode : t.mode === 'normal' ? 'normal' : undefined
    if (averageMs !== undefined && targetMs !== undefined && targetRate !== undefined && tickAt !== undefined && mode) {
      const tick: TickSample & { at: number } = { averageMs, targetMs, targetRate, mode, at: tickAt }
      const tps = finite(t.tps)
      // Never more than the target, whatever the host says.
      if (tps !== undefined && mode !== 'sprinting') tick.tps = Math.min(tps, targetRate)
      const p50 = finite(t.p50Ms)
      const p95 = finite(t.p95Ms)
      const p99 = finite(t.p99Ms)
      const size = finite(t.sampleSize)
      if (p50 !== undefined) tick.p50Ms = p50
      if (p95 !== undefined) tick.p95Ms = p95
      if (p99 !== undefined) tick.p99Ms = p99
      if (size !== undefined) tick.sampleSize = size
      out.tick = tick
    }
  }

  if (r.tickStatus === 'unsupported' || r.tickStatus === 'unavailable') out.tickStatus = r.tickStatus
  return out
}
