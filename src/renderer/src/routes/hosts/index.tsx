import { createFileRoute } from '@tanstack/react-router'
import {
  Title, Text, Stack, Group, Box, Card, Button, Badge, ActionIcon, TextInput,
  Modal, Select, NumberInput, Loader, Tooltip, Code, ScrollArea, PasswordInput
} from '@mantine/core'
import {
  IconServer, IconPlus, IconTrash, IconPlayerPlay, IconPlayerStop,
  IconTerminal2, IconRefresh, IconPlugConnected, IconDownload
} from '@tabler/icons-react'
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useDisclosure } from '@mantine/hooks'
import { notifications } from '@mantine/notifications'
import type { RemoteHost, RemoteServer } from '@shared/types'

export const Route = createFileRoute('/hosts/')({
  component: HostsPage
})

const MC_VERSIONS = ['1.21.4', '1.21.1', '1.20.4', '1.20.1', '1.19.4', '1.18.2', '1.16.5']
const LOADERS = ['(none / vanilla)', 'fabric', 'quilt', 'forge', 'neoforge']

function statusColor(status: string): string {
  if (status === 'running') return 'emerald.4'
  if (status === 'provisioning' || status === 'starting' || status === 'stopping') return 'blue.4'
  if (status === 'crashed' || status === 'error') return 'red.5'
  return 'dark.3'
}

function HostsPage() {
  const queryClient = useQueryClient()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [addOpen, addHandlers] = useDisclosure(false)

  const { data: hosts = [], isLoading } = useQuery({
    queryKey: ['hosts'],
    queryFn: () => window.api.listHosts()
  })

  const removeMutation = useMutation({
    mutationFn: (id: string) => window.api.removeHost(id),
    onSuccess: () => {
      setSelectedId(null)
      queryClient.invalidateQueries({ queryKey: ['hosts'] })
    }
  })

  const selected = hosts.find((h) => h.id === selectedId) || null

  return (
    <Stack gap={28} className="fade-in">
      <Group justify="space-between" align="flex-end">
        <Box>
          <Title order={1} style={{ fontSize: '2.5rem', fontWeight: 900 }}>Remote Hosts</Title>
          <Text c="dark.1" size="md">
            Manage Minecraft servers on remote machines running the <Code>msmd</Code> daemon.
          </Text>
        </Box>
        <Button
          leftSection={<IconPlus size={18} />}
          color="emerald.4" c="dark.9" fw={800} h={48}
          onClick={addHandlers.open}
        >
          Add Remote Host
        </Button>
      </Group>

      {isLoading && <Group justify="center" py="xl"><Loader color="emerald.4" /></Group>}

      {!isLoading && hosts.length === 0 && (
        <Card p={40} bg="dark.6" radius="md" ta="center">
          <Text fw={800} c="dark.2">No remote hosts yet.</Text>
          <Text size="sm" c="dark.3" mt={4}>
            Install the daemon on a machine (see daemon/README.md), run <Code>msmd auth</Code> to
            get its token, then add it here.
          </Text>
        </Card>
      )}

      <Group align="flex-start" gap="lg" wrap="nowrap">
        {hosts.length > 0 && (
          <Stack gap="sm" style={{ width: 280, flexShrink: 0 }}>
            {hosts.map((h) => (
              <Card
                key={h.id}
                p="md" radius="md"
                bg={selectedId === h.id ? 'dark.5' : 'dark.6'}
                style={{ cursor: 'pointer', border: `1px solid ${selectedId === h.id ? 'var(--mantine-color-emerald-9)' : 'transparent'}` }}
                onClick={() => setSelectedId(h.id)}
              >
                <Group justify="space-between" wrap="nowrap">
                  <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
                    <IconServer size={20} color="var(--mantine-color-emerald-4)" />
                    <Box style={{ minWidth: 0 }}>
                      <Text fw={800} size="sm" truncate>{h.name}</Text>
                      <Text size="xs" c="dark.2" truncate>{h.baseUrl}</Text>
                    </Box>
                  </Group>
                  <Tooltip label="Remove host">
                    <ActionIcon
                      variant="subtle" color="red" size="sm"
                      onClick={(e) => { e.stopPropagation(); removeMutation.mutate(h.id) }}
                    >
                      <IconTrash size={16} />
                    </ActionIcon>
                  </Tooltip>
                </Group>
              </Card>
            ))}
          </Stack>
        )}

        <Box style={{ flex: 1, minWidth: 0 }}>
          {selected ? (
            <HostDetail host={selected} />
          ) : hosts.length > 0 ? (
            <Card p={40} bg="dark.6" radius="md" ta="center">
              <Text c="dark.2">Select a host to manage its servers.</Text>
            </Card>
          ) : null}
        </Box>
      </Group>

      <AddHostModal opened={addOpen} onClose={addHandlers.close} />
    </Stack>
  )
}

function AddHostModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [token, setToken] = useState('')

  const mutation = useMutation({
    mutationFn: () => window.api.addHost({ name, baseUrl, token }),
    onSuccess: (host) => {
      notifications.show({ color: 'green', message: `Paired with "${host.name}".` })
      queryClient.invalidateQueries({ queryKey: ['hosts'] })
      setName(''); setBaseUrl(''); setToken('')
      onClose()
    },
    onError: (err: Error) =>
      notifications.show({ color: 'red', title: 'Pairing failed', message: err.message })
  })

  return (
    <Modal opened={opened} onClose={onClose} title="Add Remote Host" centered>
      <Stack gap="md">
        <TextInput label="Name" placeholder="My VPS" value={name} onChange={(e) => setName(e.currentTarget.value)} />
        <TextInput
          label="Address"
          description="host:port or https://host:8443"
          placeholder="192.168.1.50:8443"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.currentTarget.value)}
        />
        <PasswordInput
          label="Pairing token"
          description="From `msmd auth` on the host"
          value={token}
          onChange={(e) => setToken(e.currentTarget.value)}
        />
        <Group justify="flex-end">
          <Button variant="subtle" color="dark.1" onClick={onClose}>Cancel</Button>
          <Button
            color="emerald.4" c="dark.9" fw={800}
            leftSection={<IconPlugConnected size={18} />}
            loading={mutation.isPending}
            disabled={!baseUrl.trim() || !token.trim()}
            onClick={() => mutation.mutate()}
          >
            Pair
          </Button>
        </Group>
      </Stack>
    </Modal>
  )
}

function HostDetail({ host }: { host: RemoteHost }) {
  const queryClient = useQueryClient()
  const [deployOpen, deployHandlers] = useDisclosure(false)
  const [consoleServer, setConsoleServer] = useState<RemoteServer | null>(null)

  const { data: info } = useQuery({
    queryKey: ['host-info', host.id],
    queryFn: () => window.api.hostInfo(host.id),
    retry: 0
  })

  const { data: servers = [], isLoading, isError, error, refetch } = useQuery({
    queryKey: ['host-servers', host.id],
    queryFn: () => window.api.listRemoteServers(host.id),
    refetchInterval: 4000,
    retry: 0
  })

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['host-servers', host.id] })

  const action = (fn: Promise<void>, ok: string) =>
    fn.then(() => { notifications.show({ color: 'blue', message: ok }); invalidate() })
      .catch((e: Error) => notifications.show({ color: 'red', message: e.message }))

  return (
    <Stack gap="md">
      <Card p="lg" bg="dark.6" radius="md">
        <Group justify="space-between">
          <Box>
            <Text fw={900} size="lg">{host.name}</Text>
            {info ? (
              <Text size="xs" c="dark.2">
                msmd {info.agentVersion} · {info.os}/{info.arch} · Java: {info.java && info.java.length
                  ? info.java.map((j) => j.major).join(', ')
                  : 'auto-install on first server'}
              </Text>
            ) : (
              <Text size="xs" c="dark.3">Connecting…</Text>
            )}
          </Box>
          <Group>
            <Tooltip label="Refresh">
              <ActionIcon variant="light" onClick={() => refetch()}><IconRefresh size={18} /></ActionIcon>
            </Tooltip>
            <Button
              leftSection={<IconDownload size={18} />}
              color="emerald.4" c="dark.9" fw={800}
              onClick={deployHandlers.open}
            >
              Deploy Server
            </Button>
          </Group>
        </Group>
      </Card>

      {isError && (
        <Card p="md" bg="dark.6" radius="md">
          <Text c="red.5" size="sm">Could not reach the daemon: {(error as Error)?.message}</Text>
        </Card>
      )}

      {isLoading && <Group justify="center" py="md"><Loader color="emerald.4" size="sm" /></Group>}

      {servers.map((s) => (
        <Card key={s.id} p="md" bg="dark.6" radius="md">
          <Group justify="space-between" wrap="nowrap">
            <Group gap="md" wrap="nowrap" style={{ minWidth: 0 }}>
              <Box w={8} h={8} bg={statusColor(s.status)} style={{ borderRadius: '50%', flexShrink: 0 }} />
              <Box style={{ minWidth: 0 }}>
                <Text fw={800} truncate>{s.name}</Text>
                <Text size="xs" c="dark.2">
                  {s.modLoader || 'Vanilla'} · MC {s.minecraftVersion} · Port {s.port} · {s.maxRam}
                </Text>
              </Box>
              <Badge size="sm" variant="light" color={statusColor(s.status).split('.')[0]}>{s.status}</Badge>
            </Group>
            <Group gap="xs" wrap="nowrap">
              <Tooltip label="Console">
                <ActionIcon variant="light" onClick={() => setConsoleServer(s)}><IconTerminal2 size={16} /></ActionIcon>
              </Tooltip>
              {s.status === 'running' ? (
                <ActionIcon variant="light" color="yellow"
                  onClick={() => action(window.api.stopRemoteServer(host.id, s.id), 'Stopping…')}>
                  <IconPlayerStop size={16} />
                </ActionIcon>
              ) : (
                <ActionIcon variant="light" color="green"
                  onClick={() => action(window.api.startRemoteServer(host.id, s.id), 'Starting…')}>
                  <IconPlayerPlay size={16} />
                </ActionIcon>
              )}
              <ActionIcon variant="light" color="red"
                onClick={() => action(window.api.deleteRemoteServer(host.id, s.id), 'Deleted')}>
                <IconTrash size={16} />
              </ActionIcon>
            </Group>
          </Group>
        </Card>
      ))}

      {!isLoading && !isError && servers.length === 0 && (
        <Text c="dark.3" ta="center" py="md">No servers on this host yet — deploy one.</Text>
      )}

      <DeployRemoteModal host={host} opened={deployOpen} onClose={deployHandlers.close} onDone={invalidate} />
      {consoleServer && (
        <RemoteConsoleModal host={host} server={consoleServer} onClose={() => setConsoleServer(null)} />
      )}
    </Stack>
  )
}

function DeployRemoteModal({
  host, opened, onClose, onDone
}: { host: RemoteHost; opened: boolean; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState('')
  const [mc, setMc] = useState('1.21.4')
  const [loader, setLoader] = useState(LOADERS[0])
  const [loaderVersion, setLoaderVersion] = useState<string | null>(null)
  const [maxRam, setMaxRam] = useState(4)

  const isVanilla = loader === LOADERS[0]

  const { data: versions } = useQuery({
    queryKey: ['remote-loader-versions', host.id, loader, mc],
    queryFn: () => window.api.remoteLoaderVersions(host.id, loader, mc),
    enabled: opened && !isVanilla
  })

  const mutation = useMutation({
    mutationFn: () =>
      window.api.createRemoteServer(host.id, {
        name: name.trim(),
        minecraftVersion: mc,
        modLoader: isVanilla ? undefined : loader,
        modLoaderVersion: isVanilla ? undefined : loaderVersion || undefined,
        maxRam: `${maxRam}G`,
        minRam: `${Math.max(1, Math.floor(maxRam / 2))}G`
      }),
    onSuccess: (s) => {
      notifications.show({ color: 'blue', title: 'Deploying', message: `Provisioning "${s.name}" on ${host.name}.` })
      onDone(); onClose()
      setName('')
    },
    onError: (e: Error) => notifications.show({ color: 'red', title: 'Deploy failed', message: e.message })
  })

  return (
    <Modal opened={opened} onClose={onClose} title={`Deploy to ${host.name}`} centered>
      <Stack gap="md">
        <TextInput label="Server name" value={name} onChange={(e) => setName(e.currentTarget.value)} />
        <Select label="Minecraft version" data={MC_VERSIONS} value={mc} onChange={(v) => { setMc(v || '1.21.4'); setLoaderVersion(null) }} />
        <Select label="Mod loader" data={LOADERS} value={loader} onChange={(v) => { setLoader(v || LOADERS[0]); setLoaderVersion(null) }} />
        {!isVanilla && (
          <Select
            label={`${loader} version`}
            placeholder={versions ? 'Select…' : 'Loading…'}
            data={(versions || []).map((v) => ({ value: v.version, label: v.version + (v.stable ? ' (stable)' : '') }))}
            value={loaderVersion}
            onChange={setLoaderVersion}
            searchable
          />
        )}
        <NumberInput label="Max RAM (GB)" min={1} max={32} value={maxRam} onChange={(v) => setMaxRam(Number(v) || 4)} />
        <Group justify="flex-end">
          <Button variant="subtle" color="dark.1" onClick={onClose}>Cancel</Button>
          <Button
            color="emerald.4" c="dark.9" fw={800}
            loading={mutation.isPending}
            disabled={!name.trim() || (!isVanilla && !loaderVersion)}
            onClick={() => mutation.mutate()}
          >
            Deploy
          </Button>
        </Group>
      </Stack>
    </Modal>
  )
}

function RemoteConsoleModal({
  host, server, onClose
}: { host: RemoteHost; server: RemoteServer; onClose: () => void }) {
  const [command, setCommand] = useState('')

  const { data: logs = [] } = useQuery({
    queryKey: ['remote-logs', host.id, server.id],
    queryFn: () => window.api.remoteServerLogs(host.id, server.id),
    refetchInterval: 1500
  })

  const send = () => {
    if (!command.trim()) return
    window.api.sendRemoteCommand(host.id, server.id, command.trim())
      .catch((e: Error) => notifications.show({ color: 'red', message: e.message }))
    setCommand('')
  }

  return (
    <Modal opened onClose={onClose} title={`Console — ${server.name}`} size="xl" centered>
      <ScrollArea h={380} bg="dark.9" p="sm" style={{ borderRadius: 8 }}>
        {logs.length === 0 ? (
          <Text c="dimmed" size="sm">No output yet.</Text>
        ) : (
          logs.map((l, i) => (
            <Text key={i} size="xs" c={l.level === 'ERROR' ? 'red.5' : l.level === 'WARN' ? 'yellow.5' : 'gray.4'}
              style={{ fontFamily: 'var(--mantine-font-family-monospace)', whiteSpace: 'pre-wrap' }}>
              {l.line}
            </Text>
          ))
        )}
      </ScrollArea>
      <Group gap="sm" mt="sm">
        <TextInput
          style={{ flex: 1 }}
          placeholder="Command (e.g. op Player)"
          value={command}
          onChange={(e) => setCommand(e.currentTarget.value)}
          onKeyDown={(e) => e.key === 'Enter' && send()}
          disabled={server.status !== 'running'}
          styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
        />
        <Button color="emerald.4" c="dark.9" onClick={send} disabled={server.status !== 'running'}>Send</Button>
      </Group>
    </Modal>
  )
}
