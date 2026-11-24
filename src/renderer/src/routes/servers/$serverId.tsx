import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { Title, Stack, Paper, Group, Text, Badge, Button, ActionIcon, Tooltip, Tabs, RingProgress, Loader } from '@mantine/core'
import { IconPlayerPlay, IconPlayerStop, IconRefresh, IconTrash, IconTerminal2, IconSettings, IconPackage, IconArchive } from '@tabler/icons-react'
import { useTranslation } from 'react-i18next'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { notifications } from '@mantine/notifications'
import { modals } from '@mantine/modals'
import type { ServerWithStatus, ServerTelemetry } from '@shared/types'
import { engineLabel, isPluginPlatform } from '@shared/constants'
import { ServerMods } from '../../components/servers/ServerMods'
import { ServerConsole } from '../../components/servers/ServerConsole'
import { ServerPropertiesEditor } from '../../components/servers/ServerPropertiesEditor'
import { ServerRestartSchedule } from '../../components/servers/ServerRestartSchedule'
import { ServerBackups } from '../../components/servers/ServerBackups'
import { ServerBackupSchedule } from '../../components/servers/ServerBackupSchedule'
import { TickTimeStat } from '../../components/servers/TickTimeStat'
import { useState, useEffect } from 'react'

export const Route = createFileRoute('/servers/$serverId')({
  component: ServerDetailPage
})

function ServerDetailPage() {
  const { serverId } = Route.useParams()
  const { t } = useTranslation(['servers', 'common'])
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const [telemetry, setTelemetry] = useState<ServerTelemetry | null>(null)

  const { data: server, isLoading } = useQuery<ServerWithStatus | null>({
    queryKey: ['server', serverId],
    queryFn: () => window.api.getServer(serverId),
    refetchInterval: 3000
  })

  useEffect(() => {
    if (server && server.status === 'running') {
      const unsub = window.api.onTelemetry(server.id, (data) => {
        setTelemetry(data)
      })
      return () => {
        unsub()
        setTelemetry(null)
      }
    } else {
      setTelemetry(null)
    }
  }, [server?.status, server?.id])

  // The tick time is asked of the server itself, and every question lands in
  // its log file: main only asks while this page keeps saying it is showing
  // the numbers.
  useEffect(() => {
    if (server?.status !== 'running') return
    const id = server.id
    const renew = (): void => {
      if (document.visibilityState === 'visible') void window.api.watchTelemetry(id)
    }
    renew()
    const timer = setInterval(renew, 5000)
    document.addEventListener('visibilitychange', renew)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', renew)
    }
  }, [server?.status, server?.id])

  const startMutation = useMutation({
    mutationFn: () => window.api.startServer(serverId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['server', serverId] })
      notifications.show({ message: t('servers:serverStarted', { name: server?.name }), color: 'green' })
    },
    onError: (err: Error) => {
      notifications.show({ title: 'Error', message: err.message, color: 'red' })
    }
  })

  const stopMutation = useMutation({
    mutationFn: () => window.api.stopServer(serverId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['server', serverId] })
      notifications.show({ message: t('servers:serverStopped', { name: server?.name }), color: 'yellow' })
    }
  })

  const restartMutation = useMutation({
    mutationFn: () => window.api.restartServer(serverId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['server', serverId] })
      notifications.show({ message: t('servers:serverStarted', { name: server?.name }), color: 'green' })
    },
    onError: (err: Error) => {
      notifications.show({ title: 'Error', message: err.message, color: 'red' })
    }
  })

  const deleteMutation = useMutation({
    mutationFn: () => window.api.deleteServer(serverId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['servers'] })
      notifications.show({ message: t('servers:serverDeleted', { name: server?.name }), color: 'red' })
      navigate({ to: '/' })
    }
  })

  const confirmDelete = () => {
    modals.openConfirmModal({
      title: t('servers:delete'),
      children: <Text size="sm">{t('servers:confirmDelete', { name: server?.name })}</Text>,
      labels: { confirm: t('common:delete'), cancel: t('common:cancel') },
      confirmProps: { color: 'red' },
      onConfirm: () => deleteMutation.mutate()
    })
  }

  if (isLoading || !server) {
    return <Text>{t('common:loading')}</Text>
  }

  const isRunning = server.status === 'running'
  const isProvisioning = server.status === 'provisioning'
  const isBusy = server.status === 'starting' || server.status === 'stopping' || isProvisioning
  const statusColor = isRunning
    ? 'green'
    : server.status === 'crashed' || server.status === 'error'
      ? 'red'
      : isProvisioning
        ? 'blue'
        : 'gray'
  const memoryGb = telemetry ? (telemetry.memory / 1024 / 1024 / 1024).toFixed(2) : '0.00'
  const maxMemGb = parseInt(server.maxRam.replace(/\D/g, ''), 10) || 2

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="flex-start">
        <Stack gap={4}>
          <Title order={2}>{server.name}</Title>
          <Group gap="sm">
            <Badge size="lg" color={statusColor} variant="dot">
              {t(`common:status.${server.status}`)}
            </Badge>
            <Text size="sm" c="dimmed">
              MC {server.minecraftVersion} · Port {server.port}
            </Text>
          </Group>
        </Stack>

        <Group gap="xs">
          {isRunning ? (
            <Button
              color="yellow"
              variant="light"
              leftSection={<IconPlayerStop size={18} />}
              onClick={() => stopMutation.mutate()}
              loading={stopMutation.isPending}
              disabled={isBusy || restartMutation.isPending}
            >
              {t('servers:stop')}
            </Button>
          ) : (
            <Button
              color="green"
              variant="light"
              leftSection={<IconPlayerPlay size={18} />}
              onClick={() => startMutation.mutate()}
              loading={startMutation.isPending || isProvisioning}
              disabled={isBusy || restartMutation.isPending}
            >
              {t('servers:start')}
            </Button>
          )}

          {(isRunning || restartMutation.isPending) && (
            <Button
              variant="light"
              leftSection={<IconRefresh size={18} />}
              onClick={() => restartMutation.mutate()}
              loading={restartMutation.isPending}
              disabled={isBusy || stopMutation.isPending}
            >
              {t('servers:restart')}
            </Button>
          )}

          <Tooltip label={t('servers:console')}>
            <ActionIcon
              variant="light"
              size="lg"
              onClick={() => navigate({ to: '/console/$serverId', params: { serverId } })}
            >
              <IconTerminal2 size={18} />
            </ActionIcon>
          </Tooltip>

          <Tooltip label={t('servers:delete')}>
            <ActionIcon variant="light" color="red" size="lg" onClick={confirmDelete}>
              <IconTrash size={18} />
            </ActionIcon>
          </Tooltip>
        </Group>
      </Group>

      <Tabs defaultValue="overview">
        <Tabs.List>
          <Tabs.Tab value="overview" leftSection={<IconSettings size={14} />}>
            Overview
          </Tabs.Tab>
          <Tabs.Tab value="mods" leftSection={<IconPackage size={14} />}>
            {isPluginPlatform(server.modLoader) ? 'Plugins' : 'Mods'}
          </Tabs.Tab>
          <Tabs.Tab value="backups" leftSection={<IconArchive size={14} />}>
            Backups
          </Tabs.Tab>
          <Tabs.Tab value="settings" leftSection={<IconSettings size={14} />}>
            Settings
          </Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="overview" pt="xl">
          <Stack gap="xl">
            <Paper p="lg" radius="md" withBorder style={{ borderColor: 'var(--mantine-color-dark-5)' }}>
              <Stack gap="sm">
                <Group justify="space-between">
                  <Text size="sm" c="dimmed">Path</Text>
                  <Text size="sm" style={{ fontFamily: 'var(--mantine-font-family-monospace)' }}>
                    {server.absolutePath}
                  </Text>
                </Group>
                <Group justify="space-between">
                  <Text size="sm" c="dimmed">RAM</Text>
                  <Text size="sm">{server.minRam} – {server.maxRam}</Text>
                </Group>
                <Group justify="space-between">
                  <Text size="sm" c="dimmed">JVM flags</Text>
                  <Text size="sm">{server.jvmProfile === 'aikar' ? "Optimized (Aikar's flags)" : 'Default'}</Text>
                </Group>
                <Group justify="space-between">
                  <Text size="sm" c="dimmed">Engine</Text>
                  <Group gap="xs">
                    <Text size="sm" fw={server.modLoader ? 600 : 400}>
                      {server.modLoader
                        ? engineLabel(server.modLoader)
                        : 'Vanilla'}
                    </Text>
                    {server.modLoaderVersion && (
                      <Badge size="sm" variant="light" color="blue">
                        {server.modLoaderVersion}
                      </Badge>
                    )}
                  </Group>
                </Group>
                <Group justify="space-between">
                  <Text size="sm" c="dimmed">Auto Start</Text>
                  <Text size="sm">{server.autoStart ? 'Yes' : 'No'}</Text>
                </Group>
              </Stack>
            </Paper>

            {server.status === 'running' && (
              <Paper p="lg" radius="md" withBorder bg="var(--mantine-color-dark-8)" style={{ borderColor: 'var(--mantine-color-dark-5)' }}>
                <Title order={4} mb="md">Real-time Telemetry</Title>
                {telemetry ? (
                  <Group grow align="flex-start" justify="space-around" ta="center">
                    <Stack align="center" gap="xs">
                      <RingProgress
                        size={120}
                        thickness={12}
                        roundCaps
                        sections={[{ value: Math.min(telemetry.cpu, 100), color: telemetry.cpu > 80 ? 'red' : 'blue' }]}
                        label={<Text c="cyan" fw={700} ta="center" size="xl">{telemetry.cpu.toFixed(1)}%</Text>}
                      />
                      <Text size="sm" fw={500} c="dimmed">CPU Usage</Text>
                    </Stack>
                    <Stack align="center" gap="xs">
                      <RingProgress
                        size={120}
                        thickness={12}
                        roundCaps
                        sections={[{ value: Math.min((parseFloat(memoryGb) / maxMemGb) * 100, 100), color: 'violet' }]}
                        label={<Text c="violet" fw={700} ta="center" size="xl">{memoryGb}</Text>}
                      />
                      <Text size="sm" fw={500} c="dimmed">RAM (GB) / {maxMemGb}GB</Text>
                    </Stack>
                    <Stack align="center" gap="xs">
                      <RingProgress
                        size={120}
                        thickness={12}
                        roundCaps
                        sections={[{ value: Math.min((telemetry.onlinePlayers / telemetry.maxPlayers) * 100, 100), color: 'green' }]}
                        label={<Text c="green" fw={700} ta="center" size="xl">{telemetry.onlinePlayers}</Text>}
                      />
                      <Text size="sm" fw={500} c="dimmed">Players Online</Text>
                    </Stack>
                    <TickTimeStat tick={telemetry.tick} status={telemetry.tickStatus} now={telemetry.timestamp} />
                  </Group>
                ) : (
                  <Text c="dimmed" size="sm" ta="center" py="md">Waiting for telemetry data...</Text>
                )}
              </Paper>
            )}
            
            {(isProvisioning || server.status === 'error') && (
              <Paper
                p="md"
                radius="md"
                withBorder
                style={{
                  borderColor:
                    server.status === 'error'
                      ? 'var(--mantine-color-red-9)'
                      : 'var(--mantine-color-blue-9)'
                }}
              >
                <Group gap="sm">
                  {isProvisioning && <Loader size="sm" color="blue" />}
                  <Text size="sm" c={server.status === 'error' ? 'red' : 'blue'}>
                    {isProvisioning
                      ? 'Provisioning server — downloading files and installing the engine. Watch the console below for live progress.'
                      : 'Provisioning failed. Check the console below, then delete and recreate the server.'}
                  </Text>
                </Group>
              </Paper>
            )}

            <ServerConsole serverId={serverId} />
          </Stack>
        </Tabs.Panel>

        <Tabs.Panel value="mods" pt="xl">
          <ServerMods server={server} />
        </Tabs.Panel>

        <Tabs.Panel value="backups" pt="xl">
          <Stack gap="lg">
            <ServerBackups server={server} />
            <ServerBackupSchedule server={server} />
          </Stack>
        </Tabs.Panel>

        <Tabs.Panel value="settings" pt="xl">
          <Stack gap="lg">
            <ServerRestartSchedule serverId={server.id} schedule={server.restartSchedule} />
            <ServerPropertiesEditor serverId={server.id} />
          </Stack>
        </Tabs.Panel>
      </Tabs>
    </Stack>
  )
}
