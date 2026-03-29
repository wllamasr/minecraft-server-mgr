import { createFileRoute, Link } from '@tanstack/react-router'
import { Title, Stack, Button, Group, Text } from '@mantine/core'
import { IconPlus } from '@tabler/icons-react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import type { ServerWithStatus } from '@shared/types'

export const Route = createFileRoute('/servers/')({
  component: ServerListPage
})

function ServerListPage() {
  const { t } = useTranslation(['servers', 'common'])
  const { data: servers = [] } = useQuery<ServerWithStatus[]>({
    queryKey: ['servers'],
    queryFn: () => window.api.listServers(),
    refetchInterval: 5000
  })

  return (
    <Stack gap="lg">
      <Group justify="space-between">
        <Title order={2}>{t('servers:title')}</Title>
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

      {servers.length === 0 ? (
        <Text c="dimmed" ta="center" py="xl">
          {t('servers:noServers')}
        </Text>
      ) : (
        <Text c="dimmed">
          {servers.length} server(s) — view them on the Dashboard
        </Text>
      )}
    </Stack>
  )
}
