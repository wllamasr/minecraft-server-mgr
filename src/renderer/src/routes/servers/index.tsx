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
                           (filter === 'warning' && s.status === 'stopped') // Placeholder for warning logic
      return matchesSearch && matchesFilter
    })
  }, [servers, search, filter])

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
                           <Box w={6} h={6} bg={server.status === 'running' ? 'emerald.4' : 'dark.3'} style={{ borderRadius: '50%' }} />
                           <Text size="xs" fw={800} tt="uppercase" c={server.status === 'running' ? 'emerald.4' : 'dark.2'}>
                             {server.status}
                           </Text>
                        </Group>
                     </Box>
                  </Group>

                  {/* Metrics */}
                  <Box style={{ minWidth: 150 }}>
                     <Group justify="space-between" mb={4}>
                        <Text size="xs" fw={800} c="dark.2" tt="uppercase">Ram Usage</Text>
                        <Text size="xs" fw={800}>8.2 GB / {server.maxRam || '12.0 GB'}</Text>
                     </Group>
                     <Progress value={server.status === 'running' ? 68 : 0} color="emerald.4" size="xs" radius="xl" />
                  </Box>

                  {/* Metadata */}
                  <Box ta="center">
                     <Text size="xs" fw={800} c="dark.2" tt="uppercase">Players</Text>
                     <Text fw={900} size="md">42 <Text component="span" c="dark.4" size="sm">/ 100</Text></Text>
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

      {/* Bottom Insights */}
      <Grid gutter={24} mt={24}>
         <Grid.Col span={8}>
            <Card p={24} bg="dark.6" radius="md">
               <Group justify="space-between" mb="xl">
                  <Text fw={900} size="md">System Logs</Text>
                  <Group gap={4} c="emerald.4" style={{ cursor: 'pointer' }}>
                     <Text size="xs" fw={800} tt="uppercase">View All Logs</Text>
                     <IconArrowUpRight size={14} />
                  </Group>
               </Group>
               
               <Stack gap={8}>
                  {[
                    { time: '14:22:01', level: 'INFO', msg: "Server 'Survival-Main-01' backup completed successfully." },
                    { time: '14:18:45', level: 'WARN', msg: "Memory pressure detected on 'Factions-S3-War'. Scaling allocated RAM." },
                    { time: '14:15:10', level: 'INFO', msg: "User 'admin' changed permissions for 'Survival-Main-01'." },
                  ].map((log, i) => (
                    <Group key={i} gap="md" wrap="nowrap">
                       <Text size="xs" c="dark.3" fw={700} style={{ fontFamily: 'monospace' }}>{log.time}</Text>
                       <Text size="xs" c={log.level === 'WARN' ? 'orange.4' : 'emerald.4'} fw={900} style={{ fontFamily: 'monospace' }}>[{log.level}]</Text>
                       <Text size="xs" c="dark.1" style={{ fontFamily: 'monospace' }}>{log.msg}</Text>
                    </Group>
                  ))}
               </Stack>
            </Card>
         </Grid.Col>

         <Grid.Col span={4}>
            <Card p={24} bg="dark.6" radius="md">
               <Group justify="space-between" mb="xl">
                  <Text fw={900} size="md">Global Health</Text>
                  <ThemeIcon variant="subtle" color="emerald.4"><IconActivity size={18} /></ThemeIcon>
               </Group>
               <Text size="xs" c="dark.2" mb="xl">Aggregate metrics across all clusters</Text>
               
               <Stack gap="lg">
                  <Box>
                     <Group justify="space-between" mb={4}>
                        <Text size="xs" fw={700} c="dark.1" tt="uppercase">Node Stability</Text>
                        <Text size="xs" fw={800} c="emerald.4">99.98%</Text>
                     </Group>
                     <Progress value={99} color="emerald.4" size="xs" radius="xl" />
                  </Box>
                  <Box>
                     <Group justify="space-between" mb={4}>
                        <Text size="xs" fw={700} c="dark.1" tt="uppercase">Network Load</Text>
                        <Text size="xs" fw={800} c="emerald.4">42%</Text>
                     </Group>
                     <Progress value={42} color="emerald.4" size="xs" radius="xl" />
                  </Box>

                  <Box p="md" bg="dark.8" mt="xl" style={{ borderRadius: 8 }}>
                     <Group gap="sm">
                        <IconShieldCheck size={18} color="var(--mantine-color-emerald-4)" />
                        <Box>
                           <Text size="xs" fw={800} tt="uppercase" c="dark.1">Security Shield</Text>
                           <Text size="xs" fw={800} c="emerald.4">Encrypted & Active</Text>
                        </Box>
                     </Group>
                  </Box>
               </Stack>
            </Card>
         </Grid.Col>
      </Grid>
    </Stack>
  )
}

