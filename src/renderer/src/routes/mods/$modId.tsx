import { createFileRoute, useNavigate, Link } from '@tanstack/react-router'
import { Title, Stack, Group, Card, Image, Text, Badge, Button, Loader, Divider, Paper, ScrollArea, Table, ActionIcon, Grid } from '@mantine/core'
import { IconArrowLeft, IconDownload, IconExternalLink } from '@tabler/icons-react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { notifications } from '@mantine/notifications'
import ReactMarkdown from 'react-markdown'
import type { ModSource } from '@shared/types'

type ModDetailSearch = {
  serverId?: string
  source: ModSource
}

export const Route = createFileRoute('/mods/$modId')({
  component: ModDetailPage,
  validateSearch: (search: Record<string, unknown>): ModDetailSearch => {
    return {
      serverId: search.serverId as string | undefined,
      source: (search.source as ModSource) || 'modrinth'
    }
  }
})

function ModDetailPage() {
  const { modId } = Route.useParams()
  const { serverId, source } = Route.useSearch()
  const navigate = useNavigate()
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  // Server Context
  const { data: server } = useQuery({
    queryKey: ['server', serverId],
    queryFn: () => serverId ? window.api.getServer(serverId) : null,
    enabled: !!serverId
  })

  // Mod Details
  const { data: mod, isLoading: loadingMod, isError, error } = useQuery({
    queryKey: ['mod-detail', source, modId],
    queryFn: () => window.api.getMod(source, modId)
  })

  // Mod Versions (Filtered optionally by Server Context)
  const { data: versions, isLoading: loadingVersions } = useQuery({
    queryKey: ['mod-versions', source, modId, server?.minecraftVersion, server?.modLoader],
    queryFn: () => window.api.getModVersions(
      source,
      modId,
      server?.minecraftVersion,
      server?.modLoader || undefined
    ),
    enabled: !!mod
  })

  // Install Mutation
  const installMutation = useMutation({
    mutationFn: ({ versionId }: { versionId: string }) => {
      if (!serverId) throw new Error('No server selected')
      return window.api.installMod(serverId, source, modId, versionId)
    },
    onSuccess: () => {
      notifications.show({ title: 'Success', message: 'Mod installed to server', color: 'green' })
      navigate({ to: '/servers/$serverId', params: { serverId: serverId! } })
    },
    onError: (err: Error) => {
      notifications.show({ title: 'Install Failed', message: err.message, color: 'red' })
    }
  })

  if (loadingMod) {
    return (
      <Group justify="center" h="100%" align="center">
        <Loader size="xl" />
      </Group>
    )
  }

  if (isError || !mod) {
    return <Text c="red">Error loading mod: {(error as Error)?.message || 'Unknown error'}</Text>
  }

  // Find required dependencies in the top version (simplified for MVP)
  // We just collect unique mod IDs that are "required"
  const topVersionDeps = (versions?.[0]?.dependencies || []).filter(d => d.dependencyType === 'required')

  return (
    <Stack gap="lg" h="100%">
      <Group justify="space-between">
        <Group gap="md">
          <ActionIcon
            variant="subtle"
            size="lg"
            onClick={() => navigate({ to: '/mods', search: { serverId } })}
          >
            <IconArrowLeft />
          </ActionIcon>
          <Image
            src={mod.iconUrl || 'https://placehold.co/64x64?text=Mod'}
            width={48}
            height={48}
            radius="md"
          />
          <Stack gap={0}>
            <Title order={2}>{mod.name}</Title>
            <Text size="sm" c="dimmed">by {mod.author}</Text>
          </Stack>
        </Group>
        
        {server && (
          <Badge size="lg" variant="light" color="blue">
            Context: {server.name}
          </Badge>
        )}
      </Group>

      <Group gap="sm">
        <Badge variant="dot" color={source === 'modrinth' ? 'green' : 'orange'}>
          {source}
        </Badge>
        <Badge variant="outline" color="gray">
          {Intl.NumberFormat('en-US', { notation: 'compact' }).format(mod.downloads)} <IconDownload size={12} style={{ marginLeft: 4, verticalAlign: 'middle' }} />
        </Badge>
        {mod.loaders.map(loader => (
          <Badge key={loader} variant="light" color="cyan" tt="capitalize">
            {loader}
          </Badge>
        ))}
      </Group>

      {/* Dependencies Warning */}
      {topVersionDeps.length > 0 && serverId && (
        <Paper p="md" radius="md" bg="var(--mantine-color-yellow-9)" withBorder style={{ borderColor: 'var(--mantine-color-yellow-7)' }}>
          <Text c="var(--mantine-color-yellow-1)" fw={600} size="sm">
            This mod requires {topVersionDeps.length} dependencies.
          </Text>
          <Text c="var(--mantine-color-yellow-2)" size="xs" mt={4}>
            Please ensure you search for and install its required dependencies manually.
          </Text>
        </Paper>
      )}

      {/* Main Content Split */}
      <Grid gutter="xl" style={{ flex: 1, overflow: 'hidden' }}>
        <Grid.Col span={{ base: 12, md: 7 }} h="100%">
          <Paper p="md" radius="md" withBorder h="100%" style={{ borderColor: 'var(--mantine-color-dark-5)', display: 'flex', flexDirection: 'column' }}>
            <Title order={4} mb="sm">Description</Title>
            <ScrollArea style={{ flex: 1 }} type="auto" offsetScrollbars>
              <div style={{ color: 'var(--mantine-color-dark-0)', fontSize: 14, lineHeight: 1.6 }}>
                {source === 'curseforge' ? (
                  <div dangerouslySetInnerHTML={{ __html: mod.descriptionHtml }} />
                ) : (
                  <ReactMarkdown>{mod.descriptionHtml}</ReactMarkdown>
                )}
              </div>
            </ScrollArea>
          </Paper>
        </Grid.Col>

        <Grid.Col span={{ base: 12, md: 5 }} h="100%">
          <Paper p="md" radius="md" withBorder h="100%" style={{ borderColor: 'var(--mantine-color-dark-5)', display: 'flex', flexDirection: 'column' }}>
            <Title order={4} mb="sm">Versions {server ? `(Filtered for ${server.minecraftVersion} ${server.modLoader})` : ''}</Title>
            
            {loadingVersions ? (
              <Loader size="sm" mx="auto" mt="xl" />
            ) : versions && versions.length > 0 ? (
              <ScrollArea style={{ flex: 1 }} offsetScrollbars>
                <Stack gap="xs">
                  {versions.slice(0, 20).map((ver) => (
                    <Card key={ver.id} withBorder p="sm" radius="sm" bg="var(--mantine-color-dark-7)">
                      <Stack gap={4}>
                        <Group justify="space-between" wrap="nowrap">
                          <Text size="sm" fw={600} truncate>{ver.name}</Text>
                          <Badge size="xs" color={ver.type === 'release' ? 'green' : 'yellow'}>{ver.type}</Badge>
                        </Group>
                        <Group justify="space-between" mt="xs">
                          <Text size="xs" c="dimmed">
                            {new Date(ver.releaseDate).toLocaleDateString()}
                          </Text>
                          {serverId ? (
                            <Button 
                              size="xs" 
                              variant="light"
                              onClick={() => installMutation.mutate({ versionId: ver.id })}
                              loading={installMutation.isPending && installMutation.variables?.versionId === ver.id}
                              disabled={installMutation.isPending}
                            >
                              Install
                            </Button>
                          ) : (
                            <Button 
                              size="xs" 
                              variant="default"
                              component="a"
                              href={ver.downloadUrl}
                              target="_blank"
                            >
                              Download
                            </Button>
                          )}
                        </Group>
                      </Stack>
                    </Card>
                  ))}
                </Stack>
              </ScrollArea>
            ) : (
              <Text c="dimmed" size="sm" ta="center" mt="xl">
                No compatible versions found for this server.
              </Text>
            )}
          </Paper>
        </Grid.Col>
      </Grid>
    </Stack>
  )
}
