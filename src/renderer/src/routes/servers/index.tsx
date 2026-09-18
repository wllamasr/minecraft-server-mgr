import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { 
  Title, Text, Stack, Group, Button, Box, 
  SimpleGrid, Card, Badge, Progress, ActionIcon, 
  TextInput, UnstyledButton, ScrollArea, Avatar,
  ThemeIcon, Grid
} from '@mantine/core'
import { 
  IconPlus, IconSearch, IconAdjustmentsHorizontal, 
  IconTerminal2, IconSettings, IconPower, 
  IconActivity, IconShieldCheck, IconArrowUpRight,
  IconFilter, IconDatabase, IconNetwork
} from '@tabler/icons-react'
import { useTranslation } from 'react-i18next'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, useMemo } from 'react'
import type { ServerWithStatus, ServerLogEntry } from '@shared/types'

export const Route = createFileRoute('/servers/')({
  component: ServerListPage
})

function statusColor(status: ServerWithStatus['status']): string {
  switch (status) {
    case 'running':
      return 'emerald.4'
    case 'starting':
    case 'stopping':
    case 'provisioning':
      return 'blue.4'
    case 'crashed':
    case 'error':
      return 'red.5'
    default:
      return 'dark.3'
  }
}

function ServerListPage() {
  const { t } = useTranslation(['servers', 'common'])
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<'all' | 'running' | 'warning'>('all')

  const { data: servers = [], isLoading } = useQuery<ServerWithStatus[]>({
    queryKey: ['servers'],
    queryFn: () => window.api.listServers(),
    refetchInterval: 5000
  })

  const filteredServers = useMemo(() => {
    return servers.filter(s => {
      const matchesSearch = s.name.toLowerCase().includes(search.toLowerCase()) || 
                            s.minecraftVersion.includes(search)
      const matchesFilter = filter === 'all' ||
                           (filter === 'running' && s.status === 'running') ||
                           (filter === 'warning' && (s.status === 'crashed' || s.status === 'error'))
      return matchesSearch && matchesFilter
    })
  }, [servers, search, filter])

  const counts = useMemo(() => {
    const running = servers.filter((s) => s.status === 'running').length
    const attention = servers.filter((s) => s.status === 'crashed' || s.status === 'error').length
    return { total: servers.length, running, attention, idle: servers.length - running - attention }
  }, [servers])

  const startMutation = useMutation({
    mutationFn: (id: string) => window.api.startServer(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['servers'] })
  })

  const stopMutation = useMutation({
    mutationFn: (id: string) => window.api.stopServer(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['servers'] })
  })

  return (
    <Stack gap={32} className="fade-in">
      {/* Tactical Header */}
      <Box>
        <Group justify="space-between" align="flex-end" mb="xl">
          <Box>
            <Title order={1} style={{ fontSize: '2.5rem', fontWeight: 900 }}>Server Fleet - List View</Title>
            <Text c="dark.1" size="md">High-performance management of your distributed infrastructure. Real-time metrics and container orchestration.</Text>
          </Box>
          <Group gap={4} p={4} bg="dark.8" style={{ borderRadius: 8 }}>
             <UnstyledButton 
               p="xs" px="lg" 
               bg={filter === 'running' ? 'dark.5' : 'transparent'}
               style={{ borderRadius: 6, transition: 'all 0.2s ease' }}
               onClick={() => setFilter('running')}
             >
               <Text size="xs" fw={800} c={filter === 'running' ? 'emerald.4' : 'dark.2'}>Active</Text>
             </UnstyledButton>
             <UnstyledButton 
               p="xs" px="lg" 
               bg={filter === 'all' ? 'dark.5' : 'transparent'}
               style={{ borderRadius: 6, transition: 'all 0.2s ease' }}
               onClick={() => setFilter('all')}
             >
               <Text size="xs" fw={800} c={filter === 'all' ? 'emerald.4' : 'dark.2'}>All Nodes</Text>
             </UnstyledButton>
             <UnstyledButton 
               p="xs" px="lg" 
               bg={filter === 'warning' ? 'dark.5' : 'transparent'}
               style={{ borderRadius: 6, transition: 'all 0.2s ease' }}
               onClick={() => setFilter('warning')}
             >
               <Text size="xs" fw={800} c={filter === 'warning' ? 'emerald.4' : 'dark.2'}>Warning</Text>
             </UnstyledButton>
          </Group>
        </Group>

        {/* Search and Advanced Filters */}
        <Group gap="md">
           <TextInput
             placeholder="Filter servers..."
             leftSection={<IconFilter size={18} color="var(--mantine-color-emerald-4)" />}
             value={search}
             onChange={(e) => setSearch(e.target.value)}
             style={{ flex: 1 }}
             styles={{ input: { height: 50, backgroundColor: 'var(--mantine-color-dark-8)', border: '1px solid var(--mantine-color-dark-5)' } }}
           />
           <Button 
             variant="outline" 
             color="dark.4" 
             size="md" 
             leftSection={<IconAdjustmentsHorizontal size={20} />}
             h={50}
             px="xl"
             styles={{ label: { color: 'var(--mantine-color-dark-0)' } }}
           >
             Advanced Filters
           </Button>
           <Button
             component={Link}
             to="/servers/create"
             leftSection={<ThemeIcon size={20} radius="xl" color="emerald.9" c="emerald.4"><IconPlus size={14} /></ThemeIcon>}
             variant="filled"
             color="emerald.4"
             c="dark.9"
             h={50}
             px="xl"
             fw={900}
           >
             + Create New Server
           </Button>
        </Group>
      </Box>

      {/* Fleet List */}
      <Stack gap="lg">
        {filteredServers.map((server) => (
          <Card 
            key={server.id} 
            p={0} bg="dark.6" radius="md" 
            style={{ 
              borderLeft: `3px solid ${server.status === 'running' ? 'var(--mantine-color-emerald-4)' : 'var(--mantine-color-dark-4)'}`,
              transition: 'transform 0.2s ease'
            }}
          >
            <Group justify="space-between" p="xl" wrap="nowrap">
               <Group gap={24} style={{ flex: 1 }}>
                  {/* Instance Info */}
                  <Group gap="md">
                     <ThemeIcon size={48} variant="filled" bg="dark.8" c="dark.2">
                        <IconDatabase size={24} />
                     </ThemeIcon>
                     <Box>
                        <Text fw={900} size="lg">{server.name}</Text>
                        <Group gap={8}>
                           <Box w={6} h={6} bg={statusColor(server.status)} style={{ borderRadius: '50%' }} />
                           <Text size="xs" fw={800} tt="uppercase" c={statusColor(server.status)}>
                             {server.status}
                           </Text>
                        </Group>
                     </Box>
                  </Group>

                  {/* Real configuration facts */}
                  <Box ta="center" style={{ minWidth: 90 }}>
                     <Text size="xs" fw={800} c="dark.2" tt="uppercase">Max RAM</Text>
                     <Text fw={900} size="md">{server.maxRam}</Text>
                  </Box>

                  <Box ta="center" style={{ minWidth: 90 }}>
                     <Text size="xs" fw={800} c="dark.2" tt="uppercase">Port</Text>
                     <Text fw={900} size="md">{server.port}</Text>
                  </Box>

                  <Box ta="center">
                     <Text size="xs" fw={800} c="dark.2" tt="uppercase">Engine</Text>
                     <Text fw={900} size="md">{server.modLoader || 'Vanilla'} <Text component="span" c="emerald.4" size="sm">{server.minecraftVersion}</Text></Text>
                  </Box>
               </Group>

               {/* Quick Actions */}
               <Group gap="sm">
                  <Button 
                    variant="filled" bg="dark.8" c="dark.0" size="sm" 
                    leftSection={<IconTerminal2 size={16} color="var(--mantine-color-emerald-4)" />}
                    onClick={() => navigate({ to: '/console/$serverId', params: { serverId: server.id } })}
                  >
                    Console
                  </Button>
                  <ActionIcon 
                    variant="filled" bg="emerald.4" c="dark.9" size="md" radius="sm"
                    onClick={() => navigate({ to: '/servers/$serverId', params: { serverId: server.id } })}
                  >
                    <IconSettings size={18} />
                  </ActionIcon>
                  <ActionIcon 
                    variant="filled" color={server.status === 'running' ? 'red.9' : 'emerald.4'} size="md" radius="sm"
                    loading={startMutation.isPending || stopMutation.isPending}
                    onClick={() => server.status === 'running' ? stopMutation.mutate(server.id) : startMutation.mutate(server.id)}
                  >
                    <IconPower size={18} />
                  </ActionIcon>
               </Group>
            </Group>
          </Card>
        ))}

        {filteredServers.length === 0 && !isLoading && (
          <Box py={60} ta="center">
             <Text size="xl" fw={900} c="dark.3">No instances found in fleet</Text>
             <Text size="sm" c="dark.4">Refine your search parameters or initialize a new instance.</Text>
          </Box>
        )}
      </Stack>

      {/* Fleet summary (real aggregates) */}
      {counts.total > 0 && (
        <SimpleGrid cols={4} spacing="lg" mt={24}>
          {[
            { label: 'Total Nodes', value: counts.total, color: 'dark.0', icon: IconDatabase },
            { label: 'Running', value: counts.running, color: 'emerald.4', icon: IconActivity },
            { label: 'Idle', value: counts.idle, color: 'dark.1', icon: IconPower },
            { label: 'Needs Attention', value: counts.attention, color: counts.attention > 0 ? 'red.5' : 'dark.1', icon: IconShieldCheck }
          ].map((stat) => (
            <Card key={stat.label} p={24} bg="dark.6" radius="md">
              <Group justify="space-between" mb="md">
                <Text size="xs" fw={800} c="dark.2" tt="uppercase">{stat.label}</Text>
                <ThemeIcon variant="subtle" color={stat.color}><stat.icon size={18} /></ThemeIcon>
              </Group>
              <Text fw={900} size="2rem" c={stat.color}>{stat.value}</Text>
            </Card>
          ))}
        </SimpleGrid>
      )}
    </Stack>
  )
}

