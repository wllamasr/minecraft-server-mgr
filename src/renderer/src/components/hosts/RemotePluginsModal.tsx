import { useEffect, useRef, useState } from 'react'
import {
  ActionIcon, Alert, Avatar, Badge, Box, Button, Divider, Group, Loader, Modal, Progress, Stack, Switch, Table, Text,
  TextInput, Tooltip
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { modals } from '@mantine/modals'
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { IconArrowUp, IconDownload, IconSearch, IconTrash } from '@tabler/icons-react'
import type { ModSearchResponse, RemoteHost, RemoteServer, UnifiedMod, UnifiedModVersion } from '@shared/types'
import { engineLabel } from '@shared/constants'
import { formatBytes } from '@shared/utils/format'
import { addonUpdateTo, isPluginOperation, pickAddonVersion, type RemoteAddon } from '@shared/utils/remote-addons'

interface Props {
  host: RemoteHost
  /** The server as the host last reported it; it carries the installation in flight. */
  server: RemoteServer
  onClose: () => void
  /** Ask for the server list again (it is what carries progress and results). */
  onRefresh: () => void
}

/** A change to the plugins that this window started and whose outcome it still owes the user. */
interface Awaited {
  id: string
  name: string
  verb: 'install' | 'update'
}

const cleanError = (err: Error): string => err.message.replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '')

/**
 * Plugins of a Paper, Purpur or Folia server on a remote host: see what is in
 * its plugins folder, turn one off or on, remove one, install one from
 * Modrinth, and update one installed that way. The search runs here; the host
 * downloads the plugin from Modrinth itself, told only which version, and
 * checks it before keeping it.
 */
export function RemotePluginsModal({ host, server, onClose, onRefresh }: Props) {
  const queryClient = useQueryClient()
  const listKey = ['remote-addons', host.id, server.id]
  const [awaiting, setAwaiting] = useState<Awaited | null>(null)
  const [typed, setTyped] = useState('')
  const [query, setQuery] = useState('')

  const {
    data: plugins = [],
    isLoading,
    error: listError
  } = useQuery<RemoteAddon[], Error>({
    queryKey: listKey,
    queryFn: () => window.api.listRemoteAddons(host.id, server.id),
    retry: 0
  })

  // The versions of each plugin that came from Modrinth: what it can be updated to.
  const fromModrinth = plugins.filter((p) => p.projectId && p.versionId)
  const versionQueries = useQueries({
    queries: fromModrinth.map((p) => ({
      queryKey: ['remote-addon-versions', server.modLoader, server.minecraftVersion, p.projectId],
      queryFn: () =>
        window.api.getModVersions('modrinth', p.projectId as string, server.minecraftVersion, server.modLoader),
      retry: 0,
      staleTime: 5 * 60 * 1000
    }))
  })
  const updateFor = (plugin: RemoteAddon): UnifiedModVersion | null => {
    const at = fromModrinth.indexOf(plugin)
    const versions = at >= 0 ? (versionQueries[at]?.data as UnifiedModVersion[] | undefined) : undefined
    return versions && plugin.versionId ? addonUpdateTo(versions, plugin.versionId) : null
  }

  const search = useQuery<ModSearchResponse, Error>({
    queryKey: ['remote-addon-search', server.modLoader, server.minecraftVersion, query],
    queryFn: () =>
      window.api.searchMods({
        source: 'modrinth',
        query,
        loader: server.modLoader,
        gameVersion: server.minecraftVersion,
        limit: 8
      }),
    enabled: query !== '',
    retry: 0
  })

  const operation = server.operation ?? null
  const last = server.lastOperation ?? null
  const installing = operation !== null && isPluginOperation(operation.kind)
  const working = operation !== null || awaiting !== null

  // The server list is polled every few seconds; follow an operation closer.
  const refresh = useRef(onRefresh)
  refresh.current = onRefresh
  useEffect(() => {
    if (!working) return
    const timer = setInterval(() => refresh.current(), 1000)
    return () => clearInterval(timer)
  }, [working])

  // Any operation that ended may have changed the folder: an installation
  // from another window, a restored backup.
  const lastSeen = useRef(last?.id ?? '')
  useEffect(() => {
    if (lastSeen.current === (last?.id ?? '')) return
    lastSeen.current = last?.id ?? ''
    queryClient.invalidateQueries({ queryKey: ['remote-addons', host.id, server.id] })
  }, [last?.id, queryClient, host.id, server.id])

  // Report how the change started here ended.
  useEffect(() => {
    if (!awaiting || !last || last.id !== awaiting.id) return
    setAwaiting(null)
    queryClient.invalidateQueries({ queryKey: ['remote-addons', host.id, server.id] })
    const done = awaiting.verb === 'install' ? 'installed' : 'updated'
    const failed = awaiting.verb === 'install' ? 'was not installed' : 'was not updated'
    if (last.ok && last.warning) {
      notifications.show({ color: 'orange', title: `${awaiting.name} ${done}`, message: `${last.warning}.`, autoClose: 10000 })
    } else if (last.ok) {
      notifications.show({ color: 'green', message: `${awaiting.name} ${done}. It loads when the server starts.` })
    } else if (last.cancelled) {
      notifications.show({ color: 'yellow', message: `${last.error ?? 'Cancelled'}.` })
    } else {
      notifications.show({
        color: 'red',
        title: `${awaiting.name} ${failed}`,
        message: last.error ?? 'Unknown error',
        autoClose: 10000
      })
    }
  }, [awaiting, last, queryClient, host.id, server.id])

  // A daemon that was restarted forgets its operations: do not wait forever.
  useEffect(() => {
    if (!awaiting || operation) return
    const timer = setTimeout(() => {
      setAwaiting(null)
      queryClient.invalidateQueries({ queryKey: ['remote-addons', host.id, server.id] })
      notifications.show({
        color: 'yellow',
        message: 'The host no longer reports this change (msmd may have been restarted). Check the list and the console.',
        autoClose: 10000
      })
    }, 20000)
    return () => clearTimeout(timer)
  }, [awaiting, operation, queryClient, host.id, server.id])

  const showError = (err: Error): void => {
    notifications.show({ title: 'Error', message: cleanError(err), color: 'red', autoClose: 10000 })
  }
  const reload = (): void => {
    queryClient.invalidateQueries({ queryKey: ['remote-addons', host.id, server.id] })
  }

  const install = useMutation({
    mutationFn: async (project: UnifiedMod): Promise<Awaited> => {
      // The newest version for this server's Minecraft version and platform.
      const versions = await window.api.getModVersions('modrinth', project.id, server.minecraftVersion, server.modLoader)
      const version = pickAddonVersion(versions)
      if (!version) {
        throw new Error(
          `${project.name} has no version for Minecraft ${server.minecraftVersion} on ${engineLabel(server.modLoader)}.`
        )
      }
      const res = await window.api.installRemoteAddon(host.id, server.id, version.id)
      return { id: res.operationId, name: project.name, verb: 'install' }
    },
    onSuccess: (started) => {
      setAwaiting(started)
      onRefresh()
    },
    onError: showError
  })
  const update = useMutation({
    mutationFn: async (input: { plugin: RemoteAddon; version: UnifiedModVersion }): Promise<Awaited> => {
      const res = await window.api.updateRemoteAddon(host.id, server.id, input.plugin.file, input.version.id)
      return { id: res.operationId, name: input.plugin.name ?? input.plugin.file, verb: 'update' }
    },
    onSuccess: (started) => {
      setAwaiting(started)
      onRefresh()
    },
    onError: showError
  })
  const toggle = useMutation({
    mutationFn: (input: { file: string; enabled: boolean }) =>
      window.api.setRemoteAddonEnabled(host.id, server.id, input.file, input.enabled),
    onError: showError,
    onSettled: reload
  })
  const remove = useMutation({
    mutationFn: (file: string) => window.api.removeRemoteAddon(host.id, server.id, file),
    onError: showError,
    onSettled: reload
  })

  const busy = working || install.isPending || update.isPending
  const stopped = server.status === 'stopped' || server.status === 'crashed'
  const unavailable = listError ? cleanError(listError) : null
  const installedProjects = new Set(plugins.map((p) => p.projectId).filter(Boolean))

  const confirmRemove = (plugin: RemoteAddon): void => {
    modals.openConfirmModal({
      title: 'Remove this plugin?',
      children: (
        <Text size="sm">
          {plugin.file} will be deleted from &quot;{server.name}&quot; on {host.name}. The folder with the
          plugin&apos;s settings and data stays on the host.
        </Text>
      ),
      labels: { confirm: 'Remove', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: () => remove.mutate(plugin.file)
    })
  }

  const hits = search.data?.mods ?? []

  return (
    <Modal opened onClose={onClose} title={`Plugins — ${server.name}`} centered size="lg">
      <Stack gap="md" data-testid="remote-plugins">
        <Text size="sm" c="dimmed">
          The plugins in the plugins folder of this server on {host.name}. A plugin can be installed while the
          server runs and is loaded the next time it starts. Removing, updating, turning a plugin off or on needs
          the server to be stopped.
        </Text>

        {unavailable !== null ? (
          <Alert color="yellow" title="Plugins cannot be managed on this host">
            {unavailable}
          </Alert>
        ) : (
          <>
            {busy && (
              <Stack gap={4} data-testid="remote-plugin-progress">
                <Text size="sm">
                  {!operation
                    ? 'Starting…'
                    : !installing
                      ? 'A backup or a restore of this server is in progress…'
                      : operation.totalBytes > 0
                        ? `Downloading ${formatBytes(operation.doneBytes)} of ${formatBytes(operation.totalBytes)}`
                        : 'Asking Modrinth for the plugin…'}
                </Text>
                <Progress
                  value={installing && operation.totalBytes > 0 ? (operation.doneBytes / operation.totalBytes) * 100 : 100}
                  animated={!installing || operation.totalBytes === 0}
                />
              </Stack>
            )}

            {!isLoading && plugins.length === 0 ? (
              <Text c="dimmed" size="sm" ta="center" py="sm" data-testid="remote-plugins-empty">
                No plugins installed.
              </Text>
            ) : (
              <Table verticalSpacing="xs">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Plugin</Table.Th>
                    <Table.Th>Size</Table.Th>
                    <Table.Th>Enabled</Table.Th>
                    <Table.Th />
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {plugins.map((plugin) => {
                    const newer = updateFor(plugin)
                    return (
                      <Table.Tr key={`${plugin.file}:${plugin.enabled}`} data-testid="remote-plugin-row">
                        <Table.Td>
                          <Group gap="xs">
                            <Text size="sm" fw={600}>{plugin.name ?? plugin.file}</Text>
                            {plugin.version && <Badge size="xs" variant="light" color="gray">{plugin.version}</Badge>}
                            {plugin.projectId && (
                              <Tooltip label="Installed from Modrinth by the host">
                                <Badge size="xs" variant="light" color="green">Modrinth</Badge>
                              </Tooltip>
                            )}
                          </Group>
                          {plugin.name && <Text size="xs" c="dimmed">{plugin.file}</Text>}
                          {newer && (
                            <Tooltip label="Stop the server to update a plugin" disabled={stopped}>
                              <Button
                                mt={4}
                                size="compact-xs"
                                variant="light"
                                leftSection={<IconArrowUp size={12} />}
                                data-testid="remote-plugin-update"
                                disabled={!stopped || busy}
                                loading={update.isPending && update.variables?.plugin.file === plugin.file}
                                onClick={() => update.mutate({ plugin, version: newer })}
                              >
                                Update to {newer.versionNumber}
                              </Button>
                            </Tooltip>
                          )}
                        </Table.Td>
                        <Table.Td>{formatBytes(plugin.sizeBytes)}</Table.Td>
                        <Table.Td>
                          <Tooltip label="Stop the server to turn a plugin off or on" disabled={stopped}>
                            <Box w="fit-content">
                              <Switch
                                aria-label={`Enable ${plugin.file}`}
                                checked={plugin.enabled}
                                disabled={!stopped || busy || toggle.isPending}
                                onChange={(event) => toggle.mutate({ file: plugin.file, enabled: event.currentTarget.checked })}
                              />
                            </Box>
                          </Tooltip>
                        </Table.Td>
                        <Table.Td>
                          <Group justify="flex-end">
                            <Tooltip label={stopped ? 'Remove' : 'Stop the server to remove a plugin'}>
                              <ActionIcon
                                variant="light"
                                color="red"
                                aria-label={`Remove ${plugin.file}`}
                                disabled={!stopped || busy || remove.isPending}
                                onClick={() => confirmRemove(plugin)}
                              >
                                <IconTrash size={16} />
                              </ActionIcon>
                            </Tooltip>
                          </Group>
                        </Table.Td>
                      </Table.Tr>
                    )
                  })}
                </Table.Tbody>
              </Table>
            )}

            <Divider label="Install from Modrinth" labelPosition="left" />
            <form
              onSubmit={(event) => {
                event.preventDefault()
                setQuery(typed.trim())
              }}
            >
              <Group gap="xs" wrap="nowrap">
                <TextInput
                  aria-label="Search plugins on Modrinth"
                  placeholder={`Search plugins for ${engineLabel(server.modLoader)} ${server.minecraftVersion}`}
                  leftSection={<IconSearch size={16} />}
                  value={typed}
                  onChange={(event) => setTyped(event.currentTarget.value)}
                  style={{ flex: 1 }}
                />
                <Button type="submit" variant="light" disabled={typed.trim() === ''}>
                  Search
                </Button>
              </Group>
            </form>

            {search.isFetching && (
              <Group justify="center" py="xs">
                <Loader size="sm" />
              </Group>
            )}
            {search.error && (
              <Alert color="red" title="The search failed">
                {cleanError(search.error)}
              </Alert>
            )}
            {!search.isFetching && query !== '' && !search.error && hits.length === 0 && (
              <Text c="dimmed" size="sm" ta="center">
                No plugins found for &quot;{query}&quot;.
              </Text>
            )}
            {!search.isFetching &&
              hits.map((hit) => {
                const present = installedProjects.has(hit.id)
                return (
                  <Group key={hit.id} justify="space-between" wrap="nowrap" data-testid="remote-plugin-hit">
                    <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
                      <Avatar src={hit.iconUrl} radius="sm" size="md" />
                      <Box style={{ minWidth: 0 }}>
                        <Text size="sm" fw={600} truncate>{hit.name}</Text>
                        <Text size="xs" c="dimmed" lineClamp={1}>{hit.summary}</Text>
                      </Box>
                    </Group>
                    <Button
                      size="xs"
                      variant="light"
                      leftSection={<IconDownload size={14} />}
                      style={{ flexShrink: 0 }}
                      disabled={busy || present}
                      loading={install.isPending && install.variables?.id === hit.id}
                      onClick={() => install.mutate(hit)}
                    >
                      {present ? 'Installed' : 'Install'}
                    </Button>
                  </Group>
                )
              })}
            <Text size="xs" c="dimmed">
              The newest version for this server&apos;s Minecraft version is installed. Plugins that a plugin needs are
              not installed with it.
            </Text>
          </>
        )}
      </Stack>
    </Modal>
  )
}
