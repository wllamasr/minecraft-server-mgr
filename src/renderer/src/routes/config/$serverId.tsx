import { createFileRoute } from '@tanstack/react-router'
import { Title, Stack, Paper, TextInput, Button, Group, Text, Loader } from '@mantine/core'
import { useTranslation } from 'react-i18next'
import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { notifications } from '@mantine/notifications'

export const Route = createFileRoute('/config/$serverId')({
  component: ServerConfigPage
})

// Well-known server.properties keys with friendly descriptions
const PROPERTY_DESCRIPTIONS: Record<string, string> = {
  'server-port': 'Port number the server listens on',
  'motd': 'Message shown in the server list',
  'max-players': 'Maximum number of players',
  'level-name': 'Name of the world folder',
  'gamemode': 'Default game mode (survival, creative, adventure, spectator)',
  'difficulty': 'Difficulty level (peaceful, easy, normal, hard)',
  'online-mode': 'Verify players against Minecraft accounts',
  'white-list': 'Enable whitelist',
  'pvp': 'Allow player vs player combat',
  'enable-command-block': 'Enable command blocks',
  'spawn-protection': 'Radius of spawn protection',
  'view-distance': 'View distance in chunks',
  'simulation-distance': 'Simulation distance in chunks'
}

function ServerConfigPage() {
  const { serverId } = Route.useParams()
  const { t } = useTranslation(['servers', 'common'])
  const queryClient = useQueryClient()

  const { data: properties, isLoading } = useQuery({
    queryKey: ['serverProperties', serverId],
    queryFn: () => window.api.readServerProperties(serverId)
  })

  const [editedProps, setEditedProps] = useState<Record<string, string>>({})

  useEffect(() => {
    if (properties) {
      setEditedProps({ ...properties })
    }
  }, [properties])

  const saveMutation = useMutation({
    mutationFn: () => window.api.writeServerProperties(serverId, editedProps),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['serverProperties', serverId] })
      notifications.show({
        message: 'server.properties saved. Restart the server for changes to take effect.',
        color: 'green'
      })
    }
  })

  if (isLoading) {
    return <Loader />
  }

  const handleChange = (key: string, value: string) => {
    setEditedProps((prev) => ({ ...prev, [key]: value }))
  }

  return (
    <Stack gap="lg">
      <Group justify="space-between">
        <Title order={2}>{t('servers:config')}</Title>
        <Button
          onClick={() => saveMutation.mutate()}
          loading={saveMutation.isPending}
          variant="gradient"
          gradient={{ from: 'green', to: 'teal', deg: 135 }}
        >
          {t('common:save')}
        </Button>
      </Group>

      <Paper p="lg" radius="md" withBorder style={{ borderColor: 'var(--mantine-color-dark-5)' }}>
        <Stack gap="sm">
          {Object.entries(editedProps)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, value]) => (
              <TextInput
                key={key}
                label={key}
                description={PROPERTY_DESCRIPTIONS[key]}
                value={value}
                onChange={(e) => handleChange(key, e.target.value)}
                styles={{
                  label: { fontFamily: 'var(--mantine-font-family-monospace)', fontSize: 13 }
                }}
              />
            ))}

          {Object.keys(editedProps).length === 0 && (
            <Text c="dimmed" ta="center">
              No properties found. Start the server once to generate server.properties.
            </Text>
          )}
        </Stack>
      </Paper>
    </Stack>
  )
}
