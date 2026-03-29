import { createFileRoute } from '@tanstack/react-router'
import { Title, Stack, Text, Card } from '@mantine/core'
import { IconPackage } from '@tabler/icons-react'

export const Route = createFileRoute('/mods/')({
  component: ModsPage
})

function ModsPage() {
  return (
    <Stack gap="lg">
      <Title order={2}>Mods</Title>
      <Card padding="xl" radius="md" withBorder ta="center" style={{ borderColor: 'var(--mantine-color-dark-5)' }}>
        <IconPackage size={48} stroke={1.5} color="var(--mantine-color-dimmed)" />
        <Text c="dimmed" size="lg" mt="md">
          Mod management coming in Phase 3
        </Text>
        <Text c="dimmed" size="sm" mt="xs">
          Browse, download and install mods from CurseForge and Modrinth
        </Text>
      </Card>
    </Stack>
  )
}
