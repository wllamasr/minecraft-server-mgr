import { useEffect, useState } from 'react'
import { Alert, Button, Group, NumberInput, Paper, Stack, Switch, Text, TextInput, Title } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { IconDeviceFloppy } from '@tabler/icons-react'
import type { ServerWithStatus } from '@shared/types'
import {
  BACKUP_KEEP_MAX,
  BACKUP_KEEP_MIN,
  isValidBackupKeep,
  isValidBackupSchedule,
  parseScheduledBackupResult,
  type ScheduledBackupResult
} from '@shared/utils/backup-schedule'

interface Props {
  server: ServerWithStatus
}

const DEFAULT_TIME = '03:30'

function minutesOfDay(time: string): number {
  const [h, m] = time.split(':').map(Number)
  return h * 60 + m
}

/** True when a restart is scheduled less than 15 minutes after the backup starts. */
function restartFollowsClosely(backup: string, restart: string | null): boolean {
  if (!restart) return false
  const gap = (minutesOfDay(restart) - minutesOfDay(backup) + 1440) % 1440
  return gap < 15
}

function describeLastRun(result: ScheduledBackupResult): { text: string; color: string } {
  const when = new Date(result.at).toLocaleString()
  switch (result.outcome) {
    case 'ok':
      return { text: `Last scheduled backup: made on ${when}.`, color: 'dimmed' }
    case 'skipped':
      return { text: `Last scheduled backup: skipped on ${when}, nothing had changed since the one before.`, color: 'dimmed' }
    case 'missed':
      return { text: `Last scheduled backup: missed on ${when}. ${result.message ?? ''}`.trim(), color: 'orange' }
    default:
      return { text: `Last scheduled backup: failed on ${when}. ${result.message ?? ''}`.trim(), color: 'red' }
  }
}

/** Daily scheduled backup of a local server, and how many of them to keep. */
export function ServerBackupSchedule({ server }: Props) {
  const serverId = server.id
  const queryClient = useQueryClient()
  const [enabled, setEnabled] = useState(server.backupSchedule !== null)
  const [time, setTime] = useState(server.backupSchedule ?? DEFAULT_TIME)
  const [keep, setKeep] = useState<number | string>(server.backupKeep)

  // Follow the stored values (first load, or a change made elsewhere).
  useEffect(() => {
    setEnabled(server.backupSchedule !== null)
    if (server.backupSchedule !== null) setTime(server.backupSchedule)
    setKeep(server.backupKeep)
  }, [server.backupSchedule, server.backupKeep])

  const wanted = enabled ? time : null
  const timeValid = wanted === null || isValidBackupSchedule(wanted)
  const keepValid = isValidBackupKeep(keep)
  const dirty = wanted !== server.backupSchedule || keep !== server.backupKeep
  const lowered = keepValid && keep < server.backupKeep

  const save = useMutation({
    mutationFn: () =>
      window.api.updateServerSettings(serverId, { backupSchedule: wanted, backupKeep: keep as number }),
    onSuccess: (updated) => {
      queryClient.setQueryData(['server', serverId], updated)
      queryClient.invalidateQueries({ queryKey: ['servers'] })
      notifications.show({
        color: 'green',
        message: updated.backupSchedule
          ? `The server will be backed up every day at ${updated.backupSchedule}, keeping the last ${updated.backupKeep}.`
          : 'Scheduled backups turned off.'
      })
    },
    onError: (err: Error) =>
      notifications.show({
        title: 'Error',
        message: err.message.replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, ''),
        color: 'red'
      })
  })

  const lastRun = parseScheduledBackupResult(server.backupLastRun)
  const last = lastRun ? describeLastRun(lastRun) : null

  return (
    <Paper p="lg" withBorder data-testid="server-backup-schedule">
      <Stack gap="md">
        <div>
          <Title order={4}>Scheduled backups</Title>
          <Text size="sm" c="dimmed">
            Back the server up every day at a fixed time and keep only the most recent ones. Only scheduled
            backups are ever deleted automatically; the ones you make by hand, and the ones made before a
            restore, stay until you delete them. The time is this computer&apos;s local time, and a backup is
            only made while the app is open and the computer is awake. A stopped server is backed up only if
            its files changed since its last scheduled backup.
          </Text>
        </div>
        <Group align="flex-end">
          <Switch label="Back up every day" checked={enabled} onChange={(e) => setEnabled(e.currentTarget.checked)} />
          <TextInput
            type="time"
            label="Time"
            aria-label="Backup time"
            value={time}
            onChange={(e) => setTime(e.currentTarget.value)}
            disabled={!enabled}
            error={enabled && !timeValid ? 'Pick a time' : undefined}
            w={140}
          />
          <NumberInput
            label="Backups to keep"
            aria-label="Scheduled backups to keep"
            value={keep}
            onChange={setKeep}
            min={BACKUP_KEEP_MIN}
            max={BACKUP_KEEP_MAX}
            allowDecimal={false}
            allowNegative={false}
            error={!keepValid ? `${BACKUP_KEEP_MIN} to ${BACKUP_KEEP_MAX}` : undefined}
            w={150}
          />
          <Button
            leftSection={<IconDeviceFloppy size={18} />}
            onClick={() => save.mutate()}
            loading={save.isPending}
            disabled={!dirty || !timeValid || !keepValid}
          >
            Save
          </Button>
        </Group>
        {lowered && (
          <Text size="sm" c="dimmed">
            Older scheduled backups beyond the last {keep as number} will be deleted after the next scheduled backup.
          </Text>
        )}
        {enabled && timeValid && restartFollowsClosely(time, server.restartSchedule) && (
          <Alert color="yellow" variant="light">
            This server restarts at {server.restartSchedule}, less than 15 minutes after this backup time. A
            restart that comes due during a backup waits up to 15 minutes for it; set the backup earlier if
            your world needs longer than that, and not at the very same minute as the restart.
          </Alert>
        )}
        {last && (
          <Text size="sm" c={last.color} data-testid="backup-last-run">
            {last.text}
          </Text>
        )}
      </Stack>
    </Paper>
  )
}
