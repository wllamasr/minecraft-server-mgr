import { RingProgress, Stack, Text } from '@mantine/core'
import type { ServerTelemetry } from '@shared/types'
import { tickView } from '@shared/utils/server-metrics'

interface Props {
  tick: ServerTelemetry['tick']
  status: ServerTelemetry['tickStatus']
  /** The time of the telemetry these came with. */
  now: number
}

const COLORS = { fine: 'teal', busy: 'yellow', over: 'red', sprinting: 'blue' } as const

/**
 * How long the server needs for one tick, against the time it has (50 ms at
 * 20 ticks per second). What is shown, and when a dash is shown instead of a
 * number, is decided by tickView.
 */
export function TickTimeStat({ tick, status, now }: Props) {
  const view = tickView(tick, status, now)

  if (view.state !== 'ok') {
    return (
      <Stack align="center" gap="xs" data-testid="tick-time" data-state={view.state}>
        <RingProgress
          size={120}
          thickness={12}
          roundCaps
          sections={[]}
          label={<Text c="dimmed" fw={700} ta="center" size="xl">—</Text>}
        />
        <Text size="sm" fw={500} c="dimmed">Tick time (ms)</Text>
        <Text size="xs" c="dimmed">{view.reason}</Text>
      </Stack>
    )
  }

  const color = COLORS[view.level]
  return (
    <Stack align="center" gap="xs" data-testid="tick-time" data-state="ok">
      <RingProgress
        size={120}
        thickness={12}
        roundCaps
        sections={[{ value: view.used, color }]}
        label={<Text c={color} fw={700} ta="center" size="xl" data-testid="tick-time-ms">{view.ms}</Text>}
      />
      <Text size="sm" fw={500} c="dimmed">Tick time (ms) / {view.targetMs} ms</Text>
      <Text size="xs" c="dimmed" data-testid="tick-time-details">{view.details}</Text>
    </Stack>
  )
}
