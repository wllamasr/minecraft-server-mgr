import { RingProgress, Stack, Text } from '@mantine/core'
import type { ServerTelemetry } from '@shared/types'
import { TICK_SAMPLE_MAX_AGE_MS } from '@shared/utils/tick-query'

interface Props {
  tick: ServerTelemetry['tick']
  status: ServerTelemetry['tickStatus']
  /** The time of the telemetry these came with. */
  now: number
}

/**
 * How long the server needs for one tick, against the time it has (50 ms at
 * 20 ticks per second). Shows a dash, never a number, when the server has not
 * said anything recent: a made-up 20 TPS would read as "all is well".
 */
export function TickTimeStat({ tick, status, now }: Props) {
  const fresh = tick && now - tick.at <= TICK_SAMPLE_MAX_AGE_MS ? tick : undefined

  if (!fresh) {
    const reason =
      status === 'unsupported'
        ? 'Needs Minecraft 1.20.3 or newer'
        : status === 'unavailable'
          ? 'This server does not answer "tick query"'
          : 'Waiting for the server'
    return (
      <Stack align="center" gap="xs" data-testid="tick-time" data-state={status ?? 'waiting'}>
        <RingProgress
          size={120}
          thickness={12}
          roundCaps
          sections={[]}
          label={<Text c="dimmed" fw={700} ta="center" size="xl">—</Text>}
        />
        <Text size="sm" fw={500} c="dimmed">Tick time (ms)</Text>
        <Text size="xs" c="dimmed">{reason}</Text>
      </Stack>
    )
  }

  const used = fresh.targetMs > 0 ? (fresh.averageMs / fresh.targetMs) * 100 : 0
  const color = fresh.mode === 'sprinting' ? 'blue' : used >= 100 ? 'red' : used >= 60 ? 'yellow' : 'teal'
  // A sprinting game ignores its target and a frozen one is not ticking:
  // ticks per second would say nothing true about either.
  const details = [
    fresh.mode === 'sprinting' ? 'Sprinting' : fresh.mode === 'frozen' ? 'Frozen' : `${(fresh.tps ?? fresh.targetRate).toFixed(1)} TPS`
  ]
  if (fresh.p95Ms !== undefined) details.push(`P95 ${fresh.p95Ms.toFixed(1)} ms`)

  return (
    <Stack align="center" gap="xs" data-testid="tick-time" data-state="ok">
      <RingProgress
        size={120}
        thickness={12}
        roundCaps
        sections={[{ value: Math.min(used, 100), color }]}
        label={<Text c={color} fw={700} ta="center" size="xl" data-testid="tick-time-ms">{fresh.averageMs.toFixed(1)}</Text>}
      />
      <Text size="sm" fw={500} c="dimmed">Tick time (ms) / {fresh.targetMs.toFixed(0)} ms</Text>
      <Text size="xs" c="dimmed" data-testid="tick-time-details">{details.join(' · ')}</Text>
    </Stack>
  )
}
