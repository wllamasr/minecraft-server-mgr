import { useEffect, useState } from 'react'
import { Paper, Title, Text, Switch, TextInput, Button, Group, Stack } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { IconDeviceFloppy } from '@tabler/icons-react'
import { isValidRestartSchedule } from '@shared/utils/restart-schedule'

interface Props {
  serverId: string
  /** The stored schedule, "HH:MM" or null. */
  schedule: string | null
}

const DEFAULT_TIME = '04:00'

/** Daily scheduled restart of a local server. */
export function ServerRestartSchedule({ serverId, schedule }: Props) {
  const queryClient = useQueryClient()
  const [enabled, setEnabled] = useState(schedule !== null)
  const [time, setTime] = useState(schedule ?? DEFAULT_TIME)

  // Follow the stored value (first load, or a change made elsewhere).
  useEffect(() => {
    setEnabled(schedule !== null)
    if (schedule !== null) setTime(schedule)
  }, [schedule])

  const wanted = enabled ? time : null
  const valid = wanted === null || isValidRestartSchedule(wanted)
  const dirty = wanted !== schedule

  const save = useMutation({
    mutationFn: () => window.api.updateServerSettings(serverId, { restartSchedule: wanted }),
    onSuccess: (server) => {
      queryClient.setQueryData(['server', serverId], server)
      queryClient.invalidateQueries({ queryKey: ['servers'] })
      notifications.show({
        color: 'green',
        message: server.restartSchedule
          ? `The server will restart every day at ${server.restartSchedule}.`
          : 'Scheduled restart turned off.'
      })
    },
    onError: (err: Error) => notifications.show({ title: 'Error', message: err.message, color: 'red' })
  })

  return (
    <Paper p="lg" withBorder>
      <Stack gap="md">
        <div>
          <Title order={4}>Scheduled restart</Title>
          <Text size="sm" c="dimmed">
            Restart the server every day at a fixed time. Players are warned in chat 5 minutes and
            1 minute before. The time is this computer&apos;s local time, and the restart only happens
            while the app is open, the computer is awake and the server is running.
          </Text>
        </div>
        <Group align="flex-end">
          <Switch
            label="Restart every day"
            checked={enabled}
            onChange={(e) => setEnabled(e.currentTarget.checked)}
          />
          <TextInput
            type="time"
            label="Time"
            aria-label="Restart time"
            value={time}
            onChange={(e) => setTime(e.currentTarget.value)}
            disabled={!enabled}
            error={enabled && !valid ? 'Pick a time' : undefined}
            w={140}
          />
          <Button
            leftSection={<IconDeviceFloppy size={18} />}
            onClick={() => save.mutate()}
            loading={save.isPending}
            disabled={!dirty || !valid}
          >
            Save
          </Button>
        </Group>
      </Stack>
    </Paper>
  )
}
