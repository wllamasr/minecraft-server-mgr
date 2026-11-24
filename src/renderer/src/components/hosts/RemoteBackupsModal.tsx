import { useEffect, useRef, useState } from 'react'
import { ActionIcon, Alert, Badge, Button, Checkbox, Group, Modal, Progress, Stack, Table, Text, Tooltip } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { modals } from '@mantine/modals'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { IconArchive, IconRestore, IconTrash } from '@tabler/icons-react'
import type { BackupInfo, RemoteHost, RemoteOperation, RemoteOperationResult, RemoteServer } from '@shared/types'
import { formatBytes } from '@shared/utils/format'
import { RemoteBackupSchedule } from './RemoteBackupSchedule'

interface Props {
  host: RemoteHost
  /** The server as the host last reported it; it carries the operation in flight. */
  server: RemoteServer
  /** The host's time zone, as a label; null when the host did not report its clock. */
  zone: string | null
  onClose: () => void
  /** Ask for the server list again (it is what carries progress and results). */
  onRefresh: () => void
}

function describeOperation(op: RemoteOperation): string {
  if (op.kind === 'install') return 'A plugin is being installed on this server…'
  if (op.phase === 'saving') return 'Waiting for the server to save the world…'
  if (op.phase === 'replacing') return 'Replacing the server files…'
  if (op.totalBytes <= 0) return op.kind === 'backup' ? 'Preparing the backup…' : 'Preparing the restore…'
  const verb = op.kind === 'backup' ? 'Copying' : 'Unpacking'
  return `${verb} ${formatBytes(op.doneBytes)} of ${formatBytes(op.totalBytes)}`
}

const cleanError = (err: Error): string => err.message.replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '')

/**
 * Backups of a server on a remote host: make one, list them, restore or
 * delete one. The host does the work and keeps the archives; this window only
 * asks for it and follows along through the server list it is given.
 */
export function RemoteBackupsModal({ host, server, zone, onClose, onRefresh }: Props) {
  const queryClient = useQueryClient()
  // The operation this window started and whose outcome it still owes the user.
  const [awaiting, setAwaiting] = useState<string | null>(null)

  const {
    data: backups = [],
    isLoading,
    error: listError
  } = useQuery<BackupInfo[], Error>({
    queryKey: ['remote-backups', host.id, server.id],
    queryFn: () => window.api.listRemoteBackups(host.id, server.id),
    retry: 0
  })

  const operation = server.operation ?? null
  // How the installation of a plugin ended is told where plugins are managed.
  const last = server.lastOperation && server.lastOperation.kind !== 'install' ? server.lastOperation : null
  const working = operation !== null || awaiting !== null

  // The server list is polled every few seconds; follow an operation closer.
  // (Through a ref: the caller passes a new function on every render, which
  // must not restart the timer.)
  const refresh = useRef(onRefresh)
  refresh.current = onRefresh
  useEffect(() => {
    if (!working) return
    const timer = setInterval(() => refresh.current(), 1000)
    return () => clearInterval(timer)
  }, [working])

  // An operation that is over (started here or not) may have changed the list.
  const seenOperation = useRef<string | null>(operation?.id ?? null)
  useEffect(() => {
    if (operation) {
      seenOperation.current = operation.id
    } else if (seenOperation.current) {
      seenOperation.current = null
      queryClient.invalidateQueries({ queryKey: ['remote-backups', host.id, server.id] })
    }
  }, [operation, queryClient, host.id, server.id])

  // So may one that began and ended between two looks at the server (a
  // scheduled backup of a small world takes a second), or a scheduled backup
  // that was skipped and only deleted old ones: both leave a new result.
  const resultSeen = `${last?.id ?? ''}|${server.backupLastRun?.at ?? ''}`
  const lastResultSeen = useRef(resultSeen)
  useEffect(() => {
    if (lastResultSeen.current === resultSeen) return
    lastResultSeen.current = resultSeen
    queryClient.invalidateQueries({ queryKey: ['remote-backups', host.id, server.id] })
  }, [resultSeen, queryClient, host.id, server.id])

  // Report how the operation started here ended.
  useEffect(() => {
    if (!awaiting || !last || last.id !== awaiting) return
    setAwaiting(null)
    queryClient.invalidateQueries({ queryKey: ['remote-backups', host.id, server.id] })
    const what = last.kind === 'backup' ? 'Backup' : 'Restore'
    if (last.ok && last.warning) {
      notifications.show({ color: 'orange', title: `${what} finished with a warning`, message: last.warning, autoClose: false })
    } else if (last.ok) {
      notifications.show({
        color: 'green',
        message: last.kind === 'backup' ? 'Backup created.' : 'Backup restored. You can start the server now.'
      })
    } else if (last.cancelled) {
      // Dropped because the server was stopped or deleted: expected, not a fault.
      notifications.show({ color: 'yellow', message: `${last.error ?? `${what} cancelled`}.` })
    } else {
      notifications.show({ color: 'red', title: `${what} failed`, message: last.error ?? 'Unknown error', autoClose: 10000 })
    }
  }, [awaiting, last, queryClient, host.id, server.id])

  // A daemon that was restarted forgets its operations: do not wait forever.
  useEffect(() => {
    if (!awaiting || operation) return
    const timer = setTimeout(() => {
      setAwaiting(null)
      queryClient.invalidateQueries({ queryKey: ['remote-backups', host.id, server.id] })
      notifications.show({
        color: 'yellow',
        message: 'The host no longer reports this operation (msmd may have been restarted). Check the list and the console.',
        autoClose: 10000
      })
    }, 20000)
    return () => clearTimeout(timer)
  }, [awaiting, operation, queryClient, host.id, server.id])

  const showError = (err: Error): void => {
    notifications.show({ title: 'Error', message: cleanError(err), color: 'red', autoClose: 10000 })
  }
  const started = (res: { operationId: string }): void => {
    setAwaiting(res.operationId)
    onRefresh()
  }

  const create = useMutation({
    mutationFn: () => window.api.createRemoteBackup(host.id, server.id),
    onSuccess: started,
    onError: showError
  })
  const restore = useMutation({
    mutationFn: (input: { backupId: string; backupFirst: boolean }) =>
      window.api.restoreRemoteBackup(host.id, server.id, input.backupId, input.backupFirst),
    onSuccess: started,
    onError: showError
  })
  const remove = useMutation({
    mutationFn: (backupId: string) => window.api.deleteRemoteBackup(host.id, server.id, backupId),
    onError: showError,
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['remote-backups', host.id, server.id] })
  })

  const busy = working || create.isPending || restore.isPending
  const stopped = server.status === 'stopped' || server.status === 'crashed'
  const canBackUp = server.status === 'running' || stopped
  const unavailable = listError ? cleanError(listError) : null

  const confirmRestore = (backup: BackupInfo): void => {
    let backupFirst = true
    modals.openConfirmModal({
      title: 'Restore this backup?',
      children: (
        <Stack gap="sm">
          <Text size="sm">
            The world, settings, and mods or plugins of &quot;{server.name}&quot; on {host.name} will be replaced
            with the backup from {new Date(backup.createdAt).toLocaleString()}. Everything that changed since then
            is lost.
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
          deleted from {host.name}. This cannot be undone.
        </Text>
      ),
      labels: { confirm: 'Delete', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: () => remove.mutate(backup.id)
    })
  }

  return (
    <Modal opened onClose={onClose} title={`Backups — ${server.name}`} centered size="lg">
      <Stack gap="md" data-testid="remote-backups">
        <Group justify="space-between" align="flex-start" wrap="nowrap">
          <Text size="sm" c="dimmed">
            Backups are made and kept on {host.name}, and are deleted with the server. A backup holds the world,
            the settings and the mods or plugins; it can be made while the server is running (world saving is
            paused for the copy). Restoring needs the server to be stopped. Stopping or restarting the server by
            hand cancels a backup in progress; a scheduled restart waits up to 15 minutes for it.
          </Text>
          <Tooltip label="Wait until the server is running or stopped" disabled={canBackUp}>
            <Button
              leftSection={<IconArchive size={16} />}
              onClick={() => create.mutate()}
              loading={create.isPending}
              disabled={!canBackUp || busy || unavailable !== null}
              style={{ flexShrink: 0 }}
            >
              Back up now
            </Button>
          </Tooltip>
        </Group>

        {busy && (
          <Stack gap={4} data-testid="remote-backup-progress">
            <Text size="sm">{operation ? describeOperation(operation) : 'Starting…'}</Text>
            <Progress
              value={operation && operation.totalBytes > 0 ? (operation.doneBytes / operation.totalBytes) * 100 : 100}
              animated={!operation || operation.totalBytes === 0}
            />
          </Stack>
        )}

        {/* How a scheduled backup went is told by the schedule below. */}
        {!busy && last && !last.scheduled && <LastResult result={last} />}

        {unavailable === null && <RemoteBackupSchedule host={host} server={server} zone={zone} onSaved={onRefresh} />}

        {unavailable !== null ? (
          <Alert color="yellow" title="Backups are not available on this host">
            {unavailable}
          </Alert>
        ) : !isLoading && backups.length === 0 ? (
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
                <Table.Tr key={backup.id} data-testid="remote-backup-row">
                  <Table.Td>
                    <Group gap="xs">
                      <Text size="sm">{new Date(backup.createdAt).toLocaleString()}</Text>
                      {backup.kind === 'scheduled' && (
                        <Tooltip label="Made by the daily schedule; only these are deleted automatically">
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
                          disabled={!stopped || busy}
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
                          disabled={busy || remove.isPending}
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
    </Modal>
  )
}

/**
 * How the last operation ended, when that still matters: it failed, was
 * cancelled, or left something to do. It also covers an operation that ended
 * while this window was closed.
 */
function LastResult({ result }: { result: RemoteOperationResult }) {
  const what = result.kind === 'backup' ? 'backup' : 'restore'
  const when = new Date(result.finishedAt).toLocaleString()
  if (result.ok && !result.warning) return null
  if (result.ok) {
    return (
      <Alert color="orange" title={`The last ${what} (${when}) finished with a warning`} data-testid="remote-backup-last">
        {result.warning}
      </Alert>
    )
  }
  return (
    <Alert
      color={result.cancelled ? 'yellow' : 'red'}
      title={`The last ${what} (${when}) ${result.cancelled ? 'was cancelled' : 'failed'}`}
      data-testid="remote-backup-last"
    >
      {result.error ?? 'Unknown error'}
    </Alert>
  )
}
