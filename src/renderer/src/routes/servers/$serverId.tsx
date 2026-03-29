import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { Title, Stack, Paper, Group, Text, Badge, Button, ActionIcon, Tooltip, Tabs } from '@mantine/core'
import { IconPlayerPlay, IconPlayerStop, IconTrash, IconTerminal2, IconSettings, IconPackage } from '@tabler/icons-react'
import { useTranslation } from 'react-i18next'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { notifications } from '@mantine/notifications'
import { modals } from '@mantine/modals'
import type { ServerWithStatus } from '@shared/types'
import { ServerMods } from '../../components/servers/ServerMods'

export const Route = createFileRoute('/servers/$serverId')({
  component: ServerDetailPage
})

function ServerDetailPage() {
  const { serverId } = Route.useParams()
  const { t } = useTranslation(['servers', 'common'])
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const { data: server, isLoading } = useQuery<ServerWithStatus | null>({
    queryKey: ['server', serverId],
    queryFn: () => window.api.getServer(serverId),
    refetchInterval: 3000
  })

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
  const isBusy = server.status === 'starting' || server.status === 'stopping'

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="flex-start">
        <Stack gap={4}>
          <Title order={2}>{server.name}</Title>
          <Group gap="sm">
            <Badge
              size="lg"
              color={isRunning ? 'green' : server.status === 'crashed' ? 'red' : 'gray'}
              variant="dot"
            >
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
              disabled={isBusy}
            >
              {t('servers:stop')}
            </Button>
          ) : (
            <Button
              color="green"
              variant="light"
              leftSection={<IconPlayerPlay size={18} />}
              onClick={() => startMutation.mutate()}
              loading={startMutation.isPending}
              disabled={isBusy}
            >
              {t('servers:start')}
            </Button>
          )}

          <Tooltip label={t('servers:console')}>
            <ActionIcon
              variant="light"
              size="lg"
              component={Link}
              to="/console/$serverId"
              params={{ serverId }}
            >
              <IconTerminal2 size={18} />
            </ActionIcon>
          </Tooltip>

          <Tooltip label={t('servers:config')}>
            <ActionIcon
              variant="light"
              size="lg"
              component={Link}
              to="/config/$serverId"
              params={{ serverId }}
            >
              <IconSettings size={18} />
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
            Mods
          </Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="overview" pt="xl">
          {/* Server Info */}
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
                <Text size="sm" c="dimmed">Mod Loader</Text>
                <Group gap="xs">
                  <Text size="sm" fw={server.modLoader ? 600 : 400}>
                    {server.modLoader
                      ? `${server.modLoader.charAt(0).toUpperCase() + server.modLoader.slice(1)}`
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
        </Tabs.Panel>

        <Tabs.Panel value="mods" pt="xl">
          <ServerMods server={server} />
        </Tabs.Panel>
      </Tabs>
    </Stack>
  )
}
