import { useEffect } from 'react'
import { Group, Text, Tooltip } from '@mantine/core'
import { useQuery } from '@tanstack/react-query'
import { tickView } from '@shared/utils/server-metrics'

interface Props {
  hostId: string
  serverId: string
  /** The host has no metrics to give (an older msmd): told once, then no more requests. */
  onUnsupported: () => void
}

const TICK_COLORS = { fine: 'teal.4', busy: 'yellow.4', over: 'red.5', sprinting: 'blue.4' } as const

/**
 * What a running server on a remote host is doing: players, tick time,
 * processor and memory. Asked of the host every few seconds while this is on
 * screen; the asking is also what makes the host ask the server for its tick
 * time. What the host could not measure shows as a dash.
 */
export function RemoteServerMetricsLine({ hostId, serverId, onUnsupported }: Props) {
  const { data, isError } = useQuery({
    queryKey: ['remote-metrics', hostId, serverId],
    queryFn: () => window.api.remoteServerMetrics(hostId, serverId),
    refetchInterval: 5000,
    retry: 0,
    // Nothing is kept for the next time this is shown: by then the server
    // may have been restarted, and its old numbers would pass for new ones.
    gcTime: 0
  })

  const unsupported = data === null
  useEffect(() => {
    if (unsupported) onUnsupported()
  }, [unsupported, onUnsupported])

  // Numbers from before an error (the server stopped, the host is gone) are
  // not the present.
  if (!data || isError) return null

  const tick = tickView(data.tick, data.tickStatus, data.at)
  return (
    <Group gap="md" mt={4} wrap="wrap" data-testid={`remote-metrics-${serverId}`}>
      <Text size="xs" c="dark.1" data-testid="remote-players">
        Players {data.players ? `${data.players.online}/${data.players.max}` : '—'}
      </Text>
      {tick.state === 'ok' ? (
        <Text size="xs" c="dark.1" data-testid="remote-tick" data-state="ok">
          Tick <Text span c={TICK_COLORS[tick.level]} fw={700}>{tick.ms} ms</Text> / {tick.targetMs} ms · {tick.details}
        </Text>
      ) : (
        <Tooltip label={tick.reason}>
          <Text size="xs" c="dark.1" data-testid="remote-tick" data-state={tick.state}>Tick —</Text>
        </Tooltip>
      )}
      <Text size="xs" c="dark.1" data-testid="remote-cpu">
        CPU {data.cpu !== undefined ? `${data.cpu.toFixed(0)}%` : '—'}
      </Text>
      <Text size="xs" c="dark.1" data-testid="remote-memory">
        RAM {data.memory !== undefined ? `${(data.memory / 1024 / 1024 / 1024).toFixed(2)} GB` : '—'}
      </Text>
    </Group>
  )
}
