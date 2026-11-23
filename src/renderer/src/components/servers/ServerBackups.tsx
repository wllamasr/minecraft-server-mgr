import { useEffect, useState } from 'react'
import { ActionIcon, Badge, Button, Checkbox, Group, Paper, Progress, Stack, Table, Text, Title, Tooltip } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { modals } from '@mantine/modals'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { IconArchive, IconRestore, IconTrash } from '@tabler/icons-react'
import type { BackupInfo, BackupProgress, ServerWithStatus } from '@shared/types'
import { formatBytes } from '@shared/utils/format'

interface Props {
  server: ServerWithStatus
}

function describeProgress(progress: BackupProgress): string {
  if (progress.phase === 'saving') return 'Waiting for the server to save the world…'
  if (progress.phase === 'replacing') return 'Replacing the server files…'
  if (progress.phase === 'done') return 'Finishing…'
  const verb = progress.operation === 'backup' ? 'Copying' : 'Unpacking'
  return `${verb} ${formatBytes(progress.doneBytes)} of ${formatBytes(progress.totalBytes)}`
}

/** Backups of a local server: make one, list them, restore or delete one. */
export function ServerBackups({ server }: Props) {
  const serverId = server.id
  const queryClient = useQueryClient()
  const [progress, setProgress] = useState<BackupProgress | null>(null)

  const { data: backups = [], isLoading } = useQuery<BackupInfo[]>({
    queryKey: ['backups', serverId],
    queryFn: () => window.api.listBackups(serverId)
  })

  // Progress also arrives for operations this page did not start (a scheduled
  // backup, another window): it is what tells that one is running and when it
  // is over.
  useEffect(
    () =>
      window.api.onBackupProgress((p) => {
        if (p.serverId !== serverId) return
        if (p.phase !== 'done') {
          setProgress(p)
          return
        }
        setProgress(null)
        queryClient.invalidateQueries({ queryKey: ['backups', serverId] })
        // The result of a scheduled backup is stored on the server.
        queryClient.invalidateQueries({ queryKey: ['server', serverId] })
      }),
    [serverId, queryClient]
  )

  const refresh = (): void => {
    setProgress(null)
    queryClient.invalidateQueries({ queryKey: ['backups', serverId] })
  }
  const showError = (err: Error): void => {
    const message = err.message.replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '')
    // Cancelled because the server was stopped or deleted: expected, not a fault.
    if (message.startsWith('Cancelled')) {
      notifications.show({ message: `${message}.`, color: 'yellow' })
      return
    }
    notifications.show({ title: 'Error', message, color: 'red', autoClose: 10000 })
  }

  const create = useMutation({
    mutationFn: () => window.api.createBackup(serverId),
    onSuccess: (backup) => notifications.show({ color: 'green', message: `Backup created (${formatBytes(backup.sizeBytes)}).` }),
    onError: showError,
    onSettled: refresh
  })

  const restore = useMutation({
    mutationFn: (input: { backupId: string; backupFirst: boolean }) =>
      window.api.restoreBackup(serverId, input.backupId, { backupFirst: input.backupFirst }),
    onSuccess: () => {
      notifications.show({ color: 'green', message: 'Backup restored. You can start the server now.' })
      queryClient.invalidateQueries({ queryKey: ['mods', serverId] })
      queryClient.invalidateQueries({ queryKey: ['installed-mods', serverId] })
      queryClient.invalidateQueries({ queryKey: ['server-properties', serverId] })
    },
    onError: showError,
    onSettled: refresh
  })

  const remove = useMutation({
    mutationFn: (backupId: string) => window.api.deleteBackup(serverId, backupId),
    onError: showError,
    onSettled: refresh
  })

  const working = create.isPending || restore.isPending || progress !== null
  const stopped = server.status === 'stopped' || server.status === 'crashed'
  const canBackUp = server.status === 'running' || server.status === 'stopped' || server.status === 'crashed'

  const confirmRestore = (backup: BackupInfo): void => {
    let backupFirst = true
    modals.openConfirmModal({
      title: 'Restore this backup?',
      children: (
        <Stack gap="sm">
          <Text size="sm">
            The world, settings, and mods or plugins of &quot;{server.name}&quot; will be replaced with the
            backup from {new Date(backup.createdAt).toLocaleString()}. Everything that changed since then is lost.
          </Text>
          <Checkbox
            defaultChecked
            label="Back up the current files first, so this can be undone"
            onChange={(event) => (backupFirst = event.currentTarget.checked)}
          />
        </Stack>
      ),
      labels: { confirm: 'Restore', cancel: 'Cancel' },
      confirmProps: { color: 'orange' },
      onConfirm: () => restore.mutate({ backupId: backup.id, backupFirst })
    })
  }

  const confirmDelete = (backup: BackupInfo): void => {
    modals.openConfirmModal({
      title: 'Delete this backup?',
      children: (
        <Text size="sm">
          The backup from {new Date(backup.createdAt).toLocaleString()} ({formatBytes(backup.sizeBytes)}) will be
          deleted. This cannot be undone.
        </Text>
      ),
      labels: { confirm: 'Delete', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: () => remove.mutate(backup.id)
    })
  }

  return (
    <Paper p="lg" withBorder data-testid="server-backups">
      <Stack gap="md">
        <Group justify="space-between" align="flex-start" wrap="nowrap">
          <div>
            <Title order={4}>Backups</Title>
            <Text size="sm" c="dimmed">
              A backup holds the world, the settings and the mods or plugins of this server. It can be made
              while the server is running: world saving is paused for the copy and players can keep playing.
              Logs and the files the server software downloads for itself are left out. Restoring needs the
              server to be stopped.
            </Text>
          </div>
          <Tooltip label="Wait until the server is running or stopped" disabled={canBackUp}>
            <Button
              leftSection={<IconArchive size={16} />}
              onClick={() => create.mutate()}
              loading={create.isPending}
              disabled={!canBackUp || working}
              style={{ flexShrink: 0 }}
            >
              Back up now
            </Button>
          </Tooltip>
        </Group>

        {working && (
          <Stack gap={4} data-testid="backup-progress">
            <Text size="sm">{progress ? describeProgress(progress) : 'Preparing…'}</Text>
            <Progress
              value={progress && progress.totalBytes > 0 ? (progress.doneBytes / progress.totalBytes) * 100 : 100}
              animated={!progress || progress.totalBytes === 0}
            />
          </Stack>
        )}

        {!isLoading && backups.length === 0 ? (
          <Text c="dimmed" size="sm" ta="center" py="md">
            No backups yet.
          </Text>
        ) : (
          <Table verticalSpacing="xs">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Created</Table.Th>
                <Table.Th>Size</Table.Th>
                <Table.Th>Files</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {backups.map((backup) => (
                <Table.Tr key={backup.id} data-testid="backup-row">
                  <Table.Td>
                    <Group gap="xs">
                      <Text size="sm">{new Date(backup.createdAt).toLocaleString()}</Text>
                      {backup.kind === 'scheduled' && (
                        <Tooltip label="Made by the daily schedule; old ones are deleted automatically">
                          <Badge size="xs" variant="light" color="blue">
                            scheduled
                          </Badge>
                        </Tooltip>
                      )}
                      {backup.kind === 'pre-restore' && (
                        <Tooltip label="Made automatically right before a restore">
                          <Badge size="xs" variant="light" color="orange">
                            before restore
                          </Badge>
                        </Tooltip>
                      )}
                      {backup.minecraftVersion && backup.minecraftVersion !== server.minecraftVersion && (
                        <Badge size="xs" variant="light" color="gray">
                          MC {backup.minecraftVersion}
                        </Badge>
                      )}
                    </Group>
                  </Table.Td>
                  <Table.Td>{formatBytes(backup.sizeBytes)}</Table.Td>
                  <Table.Td>{backup.fileCount ?? '—'}</Table.Td>
                  <Table.Td>
                    <Group gap="xs" justify="flex-end" wrap="nowrap">
                      <Tooltip label={stopped ? 'Restore' : 'Stop the server to restore a backup'}>
                        <ActionIcon
                          variant="light"
                          color="orange"
                          aria-label="Restore backup"
                          disabled={!stopped || working}
                          onClick={() => confirmRestore(backup)}
                        >
                          <IconRestore size={16} />
                        </ActionIcon>
                      </Tooltip>
                      <Tooltip label="Delete">
                        <ActionIcon
                          variant="light"
                          color="red"
                          aria-label="Delete backup"
                          disabled={working || remove.isPending}
                          onClick={() => confirmDelete(backup)}
                        >
                          <IconTrash size={16} />
                        </ActionIcon>
                      </Tooltip>
                    </Group>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
      </Stack>
    </Paper>
  )
}
