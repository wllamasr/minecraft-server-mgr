import { createFileRoute, useNavigate } from '@tanstack/react-router'
import {
  Title, Text, Stack, Group, Box, SimpleGrid, Card, Image, Badge, Button,
  TextInput, Loader, Modal, Select, NumberInput, ThemeIcon
} from '@mantine/core'
import { IconSearch, IconLink, IconRocket, IconBoxMultiple, IconDownload } from '@tabler/icons-react'
import { useState, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useDebouncedValue, useDisclosure } from '@mantine/hooks'
import { notifications } from '@mantine/notifications'
import { parseModrinthModpackSlug } from '@shared/utils/modpack'
import type { UnifiedMod, ModLoaderType } from '@shared/types'

export const Route = createFileRoute('/modpacks/')({
  component: ModpacksPage
})

function ModpacksPage() {
  const [query, setQuery] = useState('')
  const [debouncedQuery] = useDebouncedValue(query, 500)
  const [pasteUrl, setPasteUrl] = useState('')
  const [pasteError, setPasteError] = useState<string | null>(null)

  const [selected, setSelected] = useState<UnifiedMod | null>(null)
  const [opened, { open, close }] = useDisclosure(false)

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['modpackSearch', debouncedQuery],
    queryFn: () =>
      window.api.searchModpacks({ query: debouncedQuery, source: 'modrinth', limit: 24 })
  })

  const openDeploy = (mod: UnifiedMod) => {
    setSelected(mod)
    open()
  }

  const handlePaste = async () => {
    setPasteError(null)
    const slug = parseModrinthModpackSlug(pasteUrl)
    if (!slug) {
      setPasteError('Enter a Modrinth modpack link or slug (e.g. modrinth.com/modpack/…).')
      return
    }
    try {
      const mod = await window.api.getMod('modrinth', slug)
      openDeploy(mod)
    } catch {
      setPasteError(`Could not find a Modrinth modpack for "${slug}".`)
    }
  }

  return (
    <Stack gap={28} className="fade-in">
      <Box>
        <Title order={1} style={{ fontSize: '2.5rem', fontWeight: 900 }}>Modpacks</Title>
        <Text c="dark.1" size="md">
          Search Modrinth or paste a modpack link, then deploy it as a ready-to-run server.
        </Text>
      </Box>

      {/* Search + paste-by-link */}
      <Group gap="md" align="flex-start" grow>
        <TextInput
          placeholder="Search modpacks on Modrinth..."
          leftSection={<IconSearch size={18} color="var(--mantine-color-emerald-4)" />}
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
          styles={{ input: { height: 50, backgroundColor: 'var(--mantine-color-dark-8)' } }}
        />
        <Group gap="xs" align="flex-start" wrap="nowrap">
          <TextInput
            style={{ flex: 1 }}
            placeholder="…or paste a modrinth.com/modpack/… link"
            leftSection={<IconLink size={18} />}
            value={pasteUrl}
            error={pasteError}
            onChange={(e) => setPasteUrl(e.currentTarget.value)}
            onKeyDown={(e) => e.key === 'Enter' && handlePaste()}
            styles={{ input: { height: 50, backgroundColor: 'var(--mantine-color-dark-8)' } }}
          />
          <Button h={50} color="emerald.4" c="dark.9" fw={800} onClick={handlePaste}>
            Open
          </Button>
        </Group>
      </Group>

      {isLoading && (
        <Group justify="center" py={60}><Loader color="emerald.4" /></Group>
      )}

      {isError && (
        <Text c="red.5" ta="center" py="xl">
          {(error as Error)?.message || 'Search failed.'}
        </Text>
      )}

      {data && (
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="lg">
          {data.mods.map((mod) => (
            <Card
              key={mod.id}
              p="lg"
              bg="dark.6"
              radius="md"
              style={{ cursor: 'pointer', display: 'flex', flexDirection: 'column' }}
              onClick={() => openDeploy(mod)}
            >
              <Group gap="md" wrap="nowrap" align="flex-start">
                {mod.iconUrl ? (
                  <Image src={mod.iconUrl} w={56} h={56} radius="md" fit="contain" />
                ) : (
                  <ThemeIcon size={56} radius="md" variant="light" color="emerald.4">
                    <IconBoxMultiple size={28} />
                  </ThemeIcon>
                )}
                <Box style={{ flex: 1, minWidth: 0 }}>
                  <Text fw={800} size="md" truncate>{mod.name}</Text>
                  <Group gap={6} c="dark.2">
                    <IconDownload size={13} />
                    <Text size="xs" fw={700}>{mod.downloads.toLocaleString()}</Text>
                  </Group>
                </Box>
              </Group>
              <Text size="xs" c="dark.1" mt="sm" lineClamp={3} style={{ flex: 1 }}>
                {mod.summary}
              </Text>
              <Group gap={6} mt="md">
                {mod.loaders.slice(0, 3).map((l) => (
                  <Badge key={l} size="xs" variant="light" color="emerald.4">{l}</Badge>
                ))}
              </Group>
            </Card>
          ))}
          {data.mods.length === 0 && (
            <Text c="dark.3" py="xl">No modpacks found.</Text>
          )}
        </SimpleGrid>
      )}

      <DeployModpackModal mod={selected} opened={opened} onClose={close} />
    </Stack>
  )
}

const VALID_LOADERS: ModLoaderType[] = ['forge', 'neoforge', 'fabric', 'quilt']

function DeployModpackModal({
  mod,
  opened,
  onClose
}: {
  mod: UnifiedMod | null
  opened: boolean
  onClose: () => void
}) {
  const navigate = useNavigate()
  const [versionId, setVersionId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [maxRam, setMaxRam] = useState(4)
  const [deploying, setDeploying] = useState(false)

  const { data: versions, isLoading } = useQuery({
    queryKey: ['modpackVersions', mod?.id],
    queryFn: () => window.api.getModVersions('modrinth', mod!.id),
    enabled: !!mod && opened
  })

  // Default the name and selected version once versions load.
  useEffect(() => {
    if (mod) setName((prev) => prev || mod.name)
  }, [mod])
  useEffect(() => {
    if (versions && versions.length && !versionId) setVersionId(versions[0].id)
  }, [versions, versionId])

  const chosen = versions?.find((v) => v.id === versionId) || versions?.[0]

  const handleDeploy = async () => {
    if (!mod || !chosen) return
    const mcVersion = chosen.gameVersions[0]
    if (!mcVersion) {
      notifications.show({ color: 'red', message: 'This version has no Minecraft version listed.' })
      return
    }
    const loader = chosen.loaders.find((l) => VALID_LOADERS.includes(l as ModLoaderType)) as
      | ModLoaderType
      | undefined

    setDeploying(true)
    try {
      const server = await window.api.createServer({
        name: name.trim() || mod.name,
        minecraftVersion: mcVersion,
        modLoader: loader,
        minRam: `${Math.max(1, Math.floor(maxRam / 2))}G`,
        maxRam: `${maxRam}G`,
        modpack: {
          source: 'modrinth',
          projectId: mod.id,
          versionId: chosen.id,
          mrpackUrl: chosen.downloadUrl,
          name: mod.name
        }
      })
      notifications.show({
        color: 'blue',
        title: 'Deploying modpack',
        message: `Provisioning "${server.name}" — follow the console for live progress.`
      })
      onClose()
      navigate({ to: '/servers/$serverId', params: { serverId: server.id } })
    } catch (err) {
      notifications.show({ color: 'red', title: 'Deploy failed', message: (err as Error).message })
    } finally {
      setDeploying(false)
    }
  }

  return (
    <Modal opened={opened} onClose={onClose} title={mod ? `Deploy ${mod.name}` : 'Deploy'} size="lg" centered>
      {isLoading ? (
        <Group justify="center" py="xl"><Loader color="emerald.4" /></Group>
      ) : (
        <Stack gap="md">
          <TextInput
            label="Server name"
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
          />
          <Select
            label="Modpack version"
            data={(versions || []).map((v) => ({
              value: v.id,
              label: `${v.versionNumber} · MC ${v.gameVersions[0] ?? '?'} · ${v.type}`
            }))}
            value={versionId}
            onChange={setVersionId}
            searchable
          />
          <NumberInput
            label="Max RAM (GB)"
            description="Modpacks are heavier than vanilla; 4–8 GB is typical."
            min={2}
            max={32}
            value={maxRam}
            onChange={(v) => setMaxRam(Number(v) || 4)}
          />
          {chosen && (
            <Text size="xs" c="dark.1">
              Will provision Minecraft {chosen.gameVersions[0]} with{' '}
              {chosen.loaders.join(', ') || 'no loader'} and install the pack's mods and configs.
            </Text>
          )}
          <Group justify="flex-end" mt="sm">
            <Button variant="subtle" color="dark.1" onClick={onClose}>Cancel</Button>
            <Button
              color="emerald.4"
              c="dark.9"
              fw={800}
              leftSection={<IconRocket size={18} />}
              loading={deploying}
              disabled={!chosen}
              onClick={handleDeploy}
            >
              Deploy Server
            </Button>
          </Group>
        </Stack>
      )}
    </Modal>
  )
}
