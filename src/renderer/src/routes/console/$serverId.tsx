import { createFileRoute } from '@tanstack/react-router'
import { Title, Stack, Group, ActionIcon } from '@mantine/core'
import { IconArrowLeft } from '@tabler/icons-react'
import { ServerConsole } from '../../components/servers/ServerConsole'

export const Route = createFileRoute('/console/$serverId')({
  component: ConsolePage
})

function ConsolePage() {
  const { serverId } = Route.useParams()
  const navigate = Route.useNavigate()

  return (
    <Stack gap="md" style={{ height: '100%' }}>
      <Group justify="flex-start" align="center">
        <ActionIcon
          variant="subtle"
          onClick={() => navigate({ to: '/servers/$serverId', params: { serverId } })}
        >
          <IconArrowLeft size={18} />
        </ActionIcon>
        <Title order={2}>
          Console — {serverId}
        </Title>
      </Group>

      <ServerConsole serverId={serverId} />
    </Stack>
  )
}

