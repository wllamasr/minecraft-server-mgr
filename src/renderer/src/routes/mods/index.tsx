import { createFileRoute, useNavigate, Link } from '@tanstack/react-router'
import { Title, Stack, Group, TextInput, Select, SegmentedControl, Grid, Card, Image, Text, Badge, Button, Loader, Pagination, Paper } from '@mantine/core'
import { IconSearch, IconDownload } from '@tabler/icons-react'
import { useState, useEffect } from 'react'
import { useQuery, keepPreviousData } from '@tanstack/react-query'
import { useDebouncedValue } from '@mantine/hooks'
import type { ModSearchOptions, ModSource } from '@shared/types'

type ModsSearch = {
  serverId?: string
}

export const Route = createFileRoute('/mods/')({
  component: ModsPage,
  validateSearch: (search: Record<string, unknown>): ModsSearch => {
    return {
      serverId: search.serverId as string | undefined
    }
  }
})

function ModsPage() {
  const { serverId } = Route.useSearch()
  const navigate = useNavigate()

  // Context
  const { data: server } = useQuery({
    queryKey: ['server', serverId],
    queryFn: () => serverId ? window.api.getServer(serverId) : null,
    enabled: !!serverId
  })

  // Filters state
  const [source, setSource] = useState<ModSource>('modrinth')
  const [query, setQuery] = useState('')
  const [debouncedQuery] = useDebouncedValue(query, 500)
  
  const [loader, setLoader] = useState<string>('')
  const [gameVersion, setGameVersion] = useState<string>('')
  
  const [page, setPage] = useState(1)
  const pageSize = 20

  // Sync with server if specified
  useEffect(() => {
    if (server) {
      setLoader(server.modLoader || '')
      setGameVersion(server.minecraftVersion)
    }
  }, [server])

  const searchOptions: ModSearchOptions = {
    source,
    query: debouncedQuery,
    loader: loader || undefined,
    gameVersion: gameVersion || undefined,
    limit: pageSize,
    offset: (page - 1) * pageSize
  }

  // Check CurseForge Key
  const { data: cfApiKey } = useQuery({
    queryKey: ['settings', 'curseforgeApiKey'],
    queryFn: () => window.api.getSetting('curseforgeApiKey')
  })

  // Only run the search query if it's Modrinth OR we have a CF API key
  const canSearch = source === 'modrinth' || !!cfApiKey

  const { data: searchResults, isLoading, isError, error } = useQuery({
    queryKey: ['mods-search', searchOptions],
    queryFn: () => window.api.searchMods(searchOptions),
    placeholderData: keepPreviousData,
    enabled: canSearch
  })

  const totalPages = searchResults ? Math.ceil(searchResults.totalHits / pageSize) : 0

  return (
    <Stack gap="lg" h="100%" style={{ overflow: 'hidden' }}>
      <Group justify="space-between">
        <Title order={2}>Mod Browser</Title>
        {server && (
          <Badge size="lg" variant="light" color="blue">
            Browsing for: {server.name}
          </Badge>
        )}
      </Group>

      {/* Filters */}
      <Group align="flex-end" gap="md">
        <TextInput
          label="Search"
          placeholder="Search mods..."
          leftSection={<IconSearch size={16} />}
          value={query}
          onChange={(e) => {
            setQuery(e.currentTarget.value)
            setPage(1)
          }}
          style={{ flex: 1 }}
        />

        <Select
          label="Source"
          data={[
            { value: 'modrinth', label: 'Modrinth' },
            { value: 'curseforge', label: 'CurseForge' }
          ]}
          value={source}
          onChange={(val) => {
            setSource((val as ModSource) || 'modrinth')
            setPage(1)
          }}
          w={150}
        />

        <Select
          label="Loader"
          data={[
            { value: '', label: 'Any' },
            { value: 'fabric', label: 'Fabric' },
            { value: 'forge', label: 'Forge' },
            { value: 'neoforge', label: 'NeoForge' },
            { value: 'quilt', label: 'Quilt' }
          ]}
          value={loader}
          onChange={(val) => {
            setLoader(val || '')
            setPage(1)
          }}
          disabled={!!server}
          w={150}
        />

        <TextInput
          label="MC Version"
          placeholder="e.g. 1.20.1"
          value={gameVersion}
          onChange={(e) => {
            setGameVersion(e.currentTarget.value)
            setPage(1)
          }}
          disabled={!!server}
          w={120}
        />
      </Group>

      {/* Results */}
      <Stack style={{ flex: 1, overflowY: 'auto' }} pr="sm">
        {source === 'curseforge' && !cfApiKey ? (
          <Paper p="xl" radius="md" withBorder ta="center" style={{ borderColor: 'var(--mantine-color-red-9)', backgroundColor: 'var(--mantine-color-red-outline)' }}>
            <Text c="red" fw={600} size="lg" mb="sm">CurseForge API Key Missing</Text>
            <Text c="dimmed" size="sm" mb="md">
              You must configure a CurseForge API key in the settings before you can browse or install mods from CurseForge.
            </Text>
            <Button component={Link} to="/settings" variant="light" color="red">
              Go to Settings
            </Button>
          </Paper>
        ) : (
          <>
            {isLoading && (
              <Group justify="center" py="xl">
                <Loader />
              </Group>
            )}
        
        {isError && (
          <Text c="red" ta="center">Error: {(error as Error).message}</Text>
        )}

        {!isLoading && searchResults?.mods.length === 0 && (
          <Text c="dimmed" ta="center" py="xl">No mods found matching your criteria.</Text>
        )}

        {searchResults && searchResults.mods.length > 0 && (
          <>
            <Grid>
              {searchResults.mods.map((mod) => (
                <Grid.Col key={mod.id} span={{ base: 12, lg: 6, xl: 4 }}>
                  <Card withBorder padding="md" radius="md">
                    <Group wrap="nowrap" align="flex-start">
                      <Image
                        src={mod.iconUrl || 'https://placehold.co/64x64?text=Mod'}
                        w={64}
                        h={64}
                        fit="contain"
                        radius="md"
                        fallbackSrc="https://placehold.co/64x64?text=Mod"
                        style={{ flexShrink: 0 }}
                      />
                      <Stack gap={4} style={{ flex: 1, overflow: 'hidden' }}>
                        <Text fw={600} truncate>{mod.name}</Text>
                        <Text size="sm" c="dimmed" lineClamp={2} style={{ height: 42 }}>
                          {mod.summary}
                        </Text>
                        <Group justify="space-between" mt="auto">
                          <Group gap="xs">
                            <IconDownload size={14} color="var(--mantine-color-dimmed)" />
                            <Text size="xs" c="dimmed">
                              {Intl.NumberFormat('en-US', { notation: 'compact' }).format(mod.downloads)}
                            </Text>
                          </Group>
                          <Button
                            size="xs"
                            variant="light"
                            onClick={() => navigate({ 
                              to: '/mods/$modId', 
                              params: { modId: mod.id },
                              search: { source, serverId }
                            })}
                          >
                            Details
                          </Button>
                        </Group>
                      </Stack>
                    </Group>
                  </Card>
                </Grid.Col>
              ))}
            </Grid>

            {totalPages > 1 && (
              <Group justify="center" mt="xl" pb="md">
                <Pagination
                  total={Math.min(totalPages, 500)} // Reasonable cap for mod APIs
                  value={page}
                  onChange={setPage}
                />
              </Group>
            )}
          </>
        )}
        </>
        )}
      </Stack>
    </Stack>
  )
}
