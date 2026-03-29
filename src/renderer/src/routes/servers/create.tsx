import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { Title, TextInput, Select, NumberInput, Button, Stack, Paper, Group, Text } from '@mantine/core'
import { useTranslation } from 'react-i18next'
import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { notifications } from '@mantine/notifications'
import type { CreateServerInput } from '@shared/types'

export const Route = createFileRoute('/servers/create')({
  component: CreateServerPage
})

// Common MC versions
const MC_VERSIONS = [
  '1.21.4', '1.21.3', '1.21.1', '1.21',
  '1.20.4', '1.20.2', '1.20.1',
  '1.19.4', '1.19.2',
  '1.18.2',
  '1.16.5',
  '1.12.2'
]

function CreateServerPage() {
  const { t } = useTranslation(['servers', 'common'])
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const [form, setForm] = useState<CreateServerInput>({
    name: '',
    minecraftVersion: '1.21.4',
    port: 25565,
    minRam: '1G',
    maxRam: '2G'
  })

  const createMutation = useMutation({
    mutationFn: (input: CreateServerInput) => window.api.createServer(input),
    onSuccess: (server) => {
      queryClient.invalidateQueries({ queryKey: ['servers'] })
      notifications.show({
        title: 'Success',
        message: t('servers:serverCreated', { name: server.name }),
        color: 'green'
      })
      navigate({ to: '/servers/$serverId', params: { serverId: server.id } })
    },
    onError: (err: Error) => {
      notifications.show({
        title: 'Error',
        message: err.message,
        color: 'red'
      })
    }
  })

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.name.trim() || !form.minecraftVersion) return
    createMutation.mutate(form)
  }

  return (
    <Stack gap="lg">
      <Title order={2}>{t('servers:createServer')}</Title>

      <Paper
        p="xl"
        radius="md"
        withBorder
        style={{ borderColor: 'var(--mantine-color-dark-5)', maxWidth: 600 }}
      >
        <form onSubmit={handleSubmit}>
          <Stack gap="md">
            <TextInput
              label={t('servers:serverName')}
              placeholder="My Awesome Server"
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />

            <Select
              label={t('servers:minecraftVersion')}
              data={MC_VERSIONS}
              value={form.minecraftVersion}
              onChange={(val) => setForm({ ...form, minecraftVersion: val || '1.21.4' })}
              searchable
              required
            />

            <NumberInput
              label={t('servers:port')}
              value={form.port}
              onChange={(val) => setForm({ ...form, port: Number(val) || 25565 })}
              min={1024}
              max={65535}
            />

            <Group grow>
              <Select
                label={t('servers:minRam')}
                data={['512M', '1G', '2G', '3G', '4G']}
                value={form.minRam}
                onChange={(val) => setForm({ ...form, minRam: val || '1G' })}
              />
              <Select
                label={t('servers:maxRam')}
                data={['1G', '2G', '4G', '6G', '8G', '12G', '16G']}
                value={form.maxRam}
                onChange={(val) => setForm({ ...form, maxRam: val || '2G' })}
              />
            </Group>

            <Group justify="flex-end" mt="md">
              <Button variant="subtle" onClick={() => navigate({ to: '/servers' })}>
                {t('common:cancel')}
              </Button>
              <Button
                type="submit"
                loading={createMutation.isPending}
                variant="gradient"
                gradient={{ from: 'green', to: 'teal', deg: 135 }}
              >
                {t('servers:createServer')}
              </Button>
            </Group>

            {createMutation.isPending && (
              <Text size="sm" c="dimmed" ta="center">
                {t('servers:downloadingJar')}
              </Text>
            )}
          </Stack>
        </form>
      </Paper>
    </Stack>
  )
}
