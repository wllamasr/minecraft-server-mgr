import { Stack, Group, Title, Button, Table, ActionIcon, Switch, Text, Badge } from '@mantine/core'
import { IconTrash, IconExternalLink, IconPackage } from '@tabler/icons-react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { notifications } from '@mantine/notifications'
import { modals } from '@mantine/modals'
import { useTranslation } from 'react-i18next'
import type { ServerWithStatus, ModLoaderType } from '@shared/types'

interface ServerModsProps {
  server: ServerWithStatus
}

export function ServerMods({ server }: ServerModsProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  const { data: mods, isLoading } = useQuery({
    queryKey: ['installed-mods', server.id],
    queryFn: () => window.api.getInstalledMods(server.id)
  })

  const toggleMutation = useMutation({
    mutationFn: ({ modDbId, enable }: { modDbId: string; enable: boolean }) =>
      window.api.toggleMod(server.id, modDbId, enable),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['installed-mods', server.id] })
    },
    onError: (err: Error) => {
      notifications.show({ title: 'Error toggling mod', message: err.message, color: 'red' })
    }
  })

  const uninstallMutation = useMutation({
    mutationFn: (modDbId: string) => window.api.uninstallMod(server.id, modDbId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['installed-mods', server.id] })
      notifications.show({ message: 'Mod uninstalled', color: 'green' })
    },
    onError: (err: Error) => {
      notifications.show({ title: 'Error uninstalling mod', message: err.message, color: 'red' })
    }
  })

  // Prevent users from browsing mods if it's a vanilla server
  const isVanilla = !server.modLoader

  const handleUninstall = (mod: any) => {
    modals.openConfirmModal({
      title: 'Uninstall Mod',
      children: <Text size="sm">Are you sure you want to uninstall and delete {mod.name}?</Text>,
      labels: { confirm: 'Uninstall', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: () => uninstallMutation.mutate(mod.id)
    })
  }

  return (
    <Stack gap="md" mt="md">
      <Group justify="space-between">
        <Title order={3}>Installed Mods</Title>
        <Button
          component={Link}
          to="/mods/"
          search={{ serverId: server.id }}
          leftSection={<IconPackage size={18} />}
          disabled={isVanilla}
          variant="light"
        >
          Browse Mods
        </Button>
      </Group>

      {isVanilla && (
        <Text c="dimmed" size="sm" ta="center" mt="xl">
          This is a Vanilla server. You must set a mod loader (Forge, Fabric, etc.) before installing mods.
        </Text>
      )}

      {!isVanilla && isLoading && <Text c="dimmed">Loading...</Text>}

      {!isVanilla && !isLoading && (!mods || mods.length === 0) && (
        <Text c="dimmed" size="sm" ta="center" mt="xl">
          No mods installed yet.
        </Text>
      )}

      {!isVanilla && mods && mods.length > 0 && (
        <Table withTableBorder withColumnBorders style={{ borderColor: 'var(--mantine-color-dark-5)' }}>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Name</Table.Th>
              <Table.Th>Version</Table.Th>
              <Table.Th>Source</Table.Th>
              <Table.Th>Enabled</Table.Th>
              <Table.Th>Actions</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {mods.map((mod) => (
              <Table.Tr key={mod.id}>
                <Table.Td>
                  {mod.name}
                  <Text size="xs" c="dimmed">{mod.fileName}</Text>
                </Table.Td>
                <Table.Td>{mod.version || 'Unknown'}</Table.Td>
                <Table.Td>
                  <Badge
                    size="sm"
                    variant="dot"
                    color={mod.source === 'modrinth' ? 'green' : 'orange'}
                  >
                    {mod.source}
                  </Badge>
                </Table.Td>
                <Table.Td>
                  <Switch
                    checked={mod.enabled}
                    onChange={(event) =>
                      toggleMutation.mutate({ modDbId: mod.id, enable: event.currentTarget.checked })
                    }
                    styles={{ track: { cursor: 'pointer' } }}
                  />
                </Table.Td>
                <Table.Td>
                  <Group gap="xs">
                    <ActionIcon
                      variant="subtle"
                      color="red"
                      onClick={() => handleUninstall(mod)}
                    >
                      <IconTrash size={16} />
                    </ActionIcon>
                  </Group>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Stack>
  )
}
