import { useEffect, useState } from 'react'
import { Alert, Button, Group, NumberInput, Paper, Stack, Switch, Text, TextInput } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { useMutation } from '@tanstack/react-query'
import { IconDeviceFloppy } from '@tabler/icons-react'
import type { RemoteHost, RemoteServer } from '@shared/types'
import {
  BACKUP_KEEP_DEFAULT,
  BACKUP_KEEP_MAX,
  BACKUP_KEEP_MIN,
  isValidBackupKeep,
  isValidBackupSchedule,
  readScheduledBackupResult,
  restartFollowsBackupClosely,
  type ScheduledBackupResult
} from '@shared/utils/backup-schedule'

interface Props {
  host: RemoteHost
  /** The server as the host last reported it. */
  server: RemoteServer
  /** The host's time zone, as a label; null when the host did not report its clock. */
  zone: string | null
  /** The settings changed: ask for the server list again. */
  onSaved: () => void
}

const DEFAULT_TIME = '03:30'

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

/**
 * Daily scheduled backup of a server on a remote host, and how many of them
 * the host keeps. The host does it all, on its own clock; this only stores
 * the settings there and shows how the last one went.
 */
export function RemoteBackupSchedule({ host, server, zone, onSaved }: Props) {
  // What the host has: no schedule and no number mean "off" and the default.
  const stored = server.backupSchedule ?? null
  const storedKeep = isValidBackupKeep(server.backupKeep) ? server.backupKeep : BACKUP_KEEP_DEFAULT

  const [enabled, setEnabled] = useState(stored !== null)
  const [time, setTime] = useState(stored ?? DEFAULT_TIME)
  const [keep, setKeep] = useState<number | string>(storedKeep)

  // Follow the host (first load, or a change made from another computer).
  useEffect(() => {
    setEnabled(stored !== null)
    if (stored !== null) setTime(stored)
    setKeep(storedKeep)
  }, [stored, storedKeep])

  const wanted = enabled ? time : null
  const timeValid = wanted === null || isValidBackupSchedule(wanted)
  const keepValid = isValidBackupKeep(keep)
  const dirty = wanted !== stored || keep !== storedKeep
  const lowered = keepValid && keep < storedKeep

  const save = useMutation({
    mutationFn: () =>
      window.api.updateRemoteServer(host.id, server.id, { backupSchedule: wanted, backupKeep: keep as number }),
    onSuccess: (updated) => {
      onSaved()
      notifications.show({
        color: 'green',
        message: updated.backupSchedule
          ? `${server.name} will be backed up every day at ${updated.backupSchedule} (host time), keeping the last ${updated.backupKeep ?? BACKUP_KEEP_DEFAULT}.`
          : 'Scheduled backups turned off.'
      })
    },
    onError: (err: Error) =>
      notifications.show({
        title: 'Error',
        message: err.message.replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, ''),
        color: 'red',
        autoClose: 10000
      })
  })

  const lastRun = readScheduledBackupResult(server.backupLastRun)
  const last = lastRun ? describeLastRun(lastRun) : null

  return (
    <Paper p="md" withBorder data-testid="remote-backup-schedule">
      <Stack gap="sm">
        <div>
          <Text fw={600}>Scheduled backups</Text>
          <Text size="sm" c="dimmed">
            Back the server up every day at a fixed time and keep only the most recent ones. Only scheduled backups
            are ever deleted automatically; the ones you make by hand, and the ones made before a restore, stay
            until you delete them. The time is on the host&apos;s clock{zone ? `, which is ${zone}` : ''}, and{' '}
            {host.name} makes the backup itself, so it happens even when this app is closed. A stopped server is
            backed up only if its files changed since its last scheduled backup.
          </Text>
        </div>
        <Group align="flex-end">
          <Switch label="Back up every day" checked={enabled} onChange={(e) => setEnabled(e.currentTarget.checked)} />
          <TextInput
            type="time"
            label="Time (host)"
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
        {enabled && timeValid && restartFollowsBackupClosely(time, server.restartSchedule) && (
          <Alert color="yellow" variant="light">
            This server restarts at {server.restartSchedule}, less than 15 minutes after this backup time. A restart
            that comes due during a backup waits up to 15 minutes for it; set the backup earlier if your world needs
            longer than that.
          </Alert>
        )}
        {last && (
          <Text size="sm" c={last.color} data-testid="remote-backup-last-run">
            {last.text}
          </Text>
        )}
      </Stack>
    </Paper>
  )
}
