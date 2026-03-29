import { createFileRoute, Link } from '@tanstack/react-router'
import { Title, Text, SimpleGrid, Card, Group, Badge, ThemeIcon, Button, Stack, Box } from '@mantine/core'
import { IconServer, IconPlayerPlay, IconSettings, IconPlus } from '@tabler/icons-react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import type { ServerWithStatus } from '@shared/types'

export const Route = createFileRoute('/')({
  component: DashboardPage
})

function DashboardPage() {
  const { t } = useTranslation(['common', 'servers'])

  const { data: servers = [], isLoading } = useQuery<ServerWithStatus[]>({
    queryKey: ['servers'],
    queryFn: () => window.api.listServers(),
    refetchInterval: 5000
  })

  const runningCount = servers.filter((s) => s.status === 'running').length

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="center">
        <Box>
          <Title order={2}>{t('common:nav.dashboard')}</Title>
          <Text c="dimmed" size="sm" mt={4}>
            Manage your Minecraft servers
          </Text>
        </Box>
        <Button
          component={Link}
          to="/servers/create"
          leftSection={<IconPlus size={18} />}
          variant="gradient"
          gradient={{ from: 'green', to: 'teal', deg: 135 }}
        >
          {t('servers:createServer')}
        </Button>
      </Group>

      {/* Quick stats */}
      <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="md">
        <Card padding="lg" radius="md" withBorder style={{ borderColor: 'var(--mantine-color-dark-5)' }}>
          <Group>
            <ThemeIcon size={48} radius="md" variant="gradient" gradient={{ from: 'green', to: 'teal' }}>
              <IconServer size={24} />
            </ThemeIcon>
            <Box>
              <Text c="dimmed" size="xs" tt="uppercase" fw={700}>
                Total Servers
              </Text>
              <Text fw={700} size="xl">
                {servers.length}
              </Text>
            </Box>
          </Group>
        </Card>

        <Card padding="lg" radius="md" withBorder style={{ borderColor: 'var(--mantine-color-dark-5)' }}>
          <Group>
            <ThemeIcon size={48} radius="md" variant="gradient" gradient={{ from: 'cyan', to: 'blue' }}>
              <IconPlayerPlay size={24} />
            </ThemeIcon>
            <Box>
              <Text c="dimmed" size="xs" tt="uppercase" fw={700}>
                Running
              </Text>
              <Text fw={700} size="xl">
                {runningCount}
              </Text>
            </Box>
          </Group>
        </Card>

        <Card padding="lg" radius="md" withBorder style={{ borderColor: 'var(--mantine-color-dark-5)' }}>
          <Group>
            <ThemeIcon size={48} radius="md" variant="gradient" gradient={{ from: 'violet', to: 'grape' }}>
              <IconSettings size={24} />
            </ThemeIcon>
            <Box>
              <Text c="dimmed" size="xs" tt="uppercase" fw={700}>
                Stopped
              </Text>
              <Text fw={700} size="xl">
                {servers.length - runningCount}
              </Text>
            </Box>
          </Group>
        </Card>
      </SimpleGrid>

      {/* Server list */}
      {servers.length === 0 && !isLoading ? (
        <Card padding="xl" radius="md" withBorder ta="center" style={{ borderColor: 'var(--mantine-color-dark-5)' }}>
          <Text c="dimmed" size="lg">
            {t('servers:noServers')}
          </Text>
          <Button
            component={Link}
            to="/servers/create"
            mt="md"
            variant="light"
            leftSection={<IconPlus size={18} />}
          >
            {t('servers:createServer')}
          </Button>
        </Card>
      ) : (
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="md">
          {servers.map((server) => (
            <Card
              key={server.id}
              padding="lg"
              radius="md"
              withBorder
              style={{
                borderColor: server.status === 'running'
                  ? 'var(--mantine-color-green-7)'
                  : 'var(--mantine-color-dark-5)',
                cursor: 'pointer',
                transition: 'transform 150ms ease, box-shadow 150ms ease',
              }}
              component={Link}
              to="/servers/$serverId"
              params={{ serverId: server.id }}
            >
              <Group justify="space-between" mb="sm">
                <Text fw={600} size="lg">
                  {server.name}
                </Text>
                <Badge
                  color={
                    server.status === 'running'
                      ? 'green'
                      : server.status === 'crashed'
                        ? 'red'
                        : server.status === 'starting'
                          ? 'yellow'
                          : 'gray'
                  }
                  variant="dot"
                >
                  {t(`common:status.${server.status}`)}
                </Badge>
              </Group>
              <Text size="sm" c="dimmed">
                MC {server.minecraftVersion} · Port {server.port}
              </Text>
              {server.modLoader && (
                <Text size="xs" c="dimmed" mt={4}>
                  {server.modLoader} {server.modLoaderVersion}
                </Text>
              )}
            </Card>
          ))}
        </SimpleGrid>
      )}
    </Stack>
  )
}
