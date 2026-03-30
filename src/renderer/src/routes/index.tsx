import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { 
  Title, Text, SimpleGrid, Card, Group, Badge, 
  Button, Stack, Box, Progress, Table, Avatar, 
  ActionIcon, Tabs, ScrollArea
} from '@mantine/core'
import { 
  IconPlus, IconServer, IconBolt, IconX, 
  IconActivity, IconDeviceDesktop, IconSearch, 
  IconFilter, IconBell, IconChevronRight
} from '@tabler/icons-react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { useState, useEffect, useRef } from 'react'
import type { ServerWithStatus, ServerLogEntry } from '@shared/types'

export const Route = createFileRoute('/')({
  component: DashboardPage
})

function DashboardPage() {
  const { t } = useTranslation(['common', 'servers'])
  const navigate = useNavigate()
  const [globalLogs, setGlobalLogs] = useState<ServerLogEntry[]>([])
  const logViewportRef = useRef<HTMLDivElement>(null)

  const { data: servers = [], isLoading } = useQuery<ServerWithStatus[]>({
    queryKey: ['servers'],
    queryFn: () => window.api.listServers(),
    refetchInterval: 5000
  })

  // Aggregate logs for Global Event Stream
  useEffect(() => {
    const unsub = window.api.onServerLog((entry) => {
      setGlobalLogs((prev) => [...prev.slice(-49), entry])
    })
    return unsub
  }, [])

  // Auto-scroll global logs
  useEffect(() => {
    if (logViewportRef.current) {
      logViewportRef.current.scrollTop = logViewportRef.current.scrollHeight
    }
  }, [globalLogs])

  const runningCount = servers.filter((s) => s.status === 'running').length
  const stoppedCount = servers.length - runningCount

  return (
    <Stack gap={32} className="fade-in">
      {/* Top Header Section */}
      <Box>
         <Group gap="xs" mb="xs">
           <Text size="xs" fw={700} c="emerald.4" td="underline" style={{ cursor: 'pointer' }}>Network</Text>
           <Text size="xs" fw={700} c="dark.2" style={{ cursor: 'pointer' }}>Nodes</Text>
           <Text size="xs" fw={700} c="dark.2" style={{ cursor: 'pointer' }}>Logs</Text>
         </Group>
         <Title order={1} style={{ fontSize: '2.2rem', letterSpacing: -0.5 }}>Dashboard Overview</Title>
         <Text c="dark.1" size="sm">Real-time telemetry and management portal.</Text>
      </Box>

      {/* Stats Cards */}
      <SimpleGrid cols={{ base: 1, sm: 3 }} spacing={24}>
        <Card p={24} bg="dark.6" radius="md">
          <Group justify="space-between" align="flex-start">
            <Box>
              <Text c="dark.1" size="xs" fw={800} tt="uppercase" mb={4} style={{ letterSpacing: 1 }}>Total Servers</Text>
              <Group align="baseline" gap="xs">
                <Text style={{ fontSize: '2.5rem', lineHeight: 1 }} fw={900}>{servers.length.toString().padStart(2, '0')}</Text>
                <Text size="xs" c="emerald.4" fw={700}>+0 this month</Text>
              </Group>
            </Box>
            <Box opacity={0.2}><IconServer size={40} stroke={1.5} /></Box>
          </Group>
        </Card>

        <Card p={24} bg="dark.6" radius="md">
          <Group justify="space-between" align="flex-start">
            <Box>
              <Text c="dark.1" size="xs" fw={800} tt="uppercase" mb={4} style={{ letterSpacing: 1 }}>Running</Text>
              <Group align="baseline" gap="xs">
                <Text style={{ fontSize: '2.5rem', lineHeight: 1 }} fw={900} c="emerald.4">{runningCount.toString().padStart(2, '0')}</Text>
                <Badge variant="filled" color="emerald.9" c="emerald.4" size="sm" radius="sm">STABLE</Badge>
              </Group>
            </Box>
            <Box opacity={0.2} c="emerald.4"><IconBolt size={40} fill="currentColor" /></Box>
          </Group>
        </Card>

        <Card p={24} bg="dark.6" radius="md">
          <Group justify="space-between" align="flex-start">
            <Box>
              <Text c="dark.1" size="xs" fw={800} tt="uppercase" mb={4} style={{ letterSpacing: 1 }}>Stopped</Text>
              <Group align="baseline" gap="xs">
                <Text style={{ fontSize: '2.5rem', lineHeight: 1 }} fw={900} c="dark.0">{stoppedCount.toString().padStart(2, '0')}</Text>
                <Text size="xs" c="dark.2" fw={700}>Needs Attention</Text>
              </Group>
            </Box>
            <Box opacity={0.2}><IconX size={40} /></Box>
          </Group>
        </Card>
      </SimpleGrid>

      {/* Main Grid Content */}
      <SimpleGrid cols={{ base: 1, lg: 3 }} spacing={24}>
        {/* Recent Deployments Table */}
        <Card p={0} bg="dark.6" radius="md" style={{ gridColumn: 'span 2' }}>
           <Box p="lg">
             <Group justify="space-between" mb="xl">
               <Text fw={800} size="md">Recent Deployments</Text>
               <Group gap="xs">
                 <Box bg="dark.8" px="sm" py={4} style={{ borderRadius: 4, display: 'flex', alignItems: 'center', gap: 8 }}>
                    <IconSearch size={14} color="var(--mantine-color-dark-2)" />
                    <Text size="xs" c="dark.2">Filter servers...</Text>
                 </Box>
                 <ActionIcon variant="subtle" color="dark.1"><IconFilter size={18} /></ActionIcon>
               </Group>
             </Group>

             <Table verticalSpacing="md">
               <Table.Thead>
                 <Table.Tr style={{ borderBottom: '1px solid var(--mantine-color-dark-5)' }}>
                   <Table.Th c="dark.1" fw={700} style={{ fontSize: 10, textTransform: 'uppercase' }}>Instance Name</Table.Th>
                   <Table.Th c="dark.1" fw={700} style={{ fontSize: 10, textTransform: 'uppercase' }}>Status</Table.Th>
                   <Table.Th c="dark.1" fw={700} style={{ fontSize: 10, textTransform: 'uppercase' }}>Uptime</Table.Th>
                   <Table.Th c="dark.1" fw={700} style={{ fontSize: 10, textTransform: 'uppercase' }}>Players</Table.Th>
                   <Table.Th></Table.Th>
                 </Table.Tr>
               </Table.Thead>
               <Table.Tbody>
                 {servers.slice(0, 5).map((server) => (
                   <Table.Tr key={server.id} style={{ borderBottom: '1px solid var(--mantine-color-dark-8)' }}>
                     <Table.Td>
                       <Group gap="sm">
                          <Box w={12} h={12} bg={server.status === 'running' ? 'emerald.4' : 'dark.3'} style={{ borderRadius: 2 }} />
                          <Box>
                            <Text size="sm" fw={700}>{server.name}</Text>
                            <Text size="xs" c="dark.2">{server.minecraftVersion} | {server.modLoader || 'Vanilla'}</Text>
                          </Box>
                       </Group>
                     </Table.Td>
                     <Table.Td>
                        <Badge 
                          variant="filled" 
                          color={server.status === 'running' ? 'emerald.9' : 'dark.7'} 
                          c={server.status === 'running' ? 'emerald.4' : 'dark.2'}
                          size="xs"
                        >
                          {server.status.toUpperCase()}
                        </Badge>
                     </Table.Td>
                     <Table.Td>
                       <Text size="xs" fw={600}>{server.status === 'running' ? '4d 18h' : '—'}</Text>
                     </Table.Td>
                     <Table.Td>
                       <Group gap={4}>
                         <Avatar.Group spacing="xs">
                            <Avatar size="xs" radius="xl" />
                            <Avatar size="xs" radius="xl" />
                            <Avatar size="xs" radius="xl" color="dark.5" style={{ fontSize: 8 }}>+14</Avatar>
                         </Avatar.Group>
                         {server.status === 'running' && <Text size="xs" fw={700}>42 <Text component="span" c="dark.2" fw={500}>/ 100</Text></Text>}
                       </Group>
                     </Table.Td>
                     <Table.Td>
                       <ActionIcon 
                         variant="subtle" 
                         color="dark.1"
                         onClick={() => navigate({ to: '/servers/$serverId', params: { serverId: server.id } })}
                       >
                         <IconChevronRight size={18} />
                       </ActionIcon>
                     </Table.Td>
                   </Table.Tr>
                 ))}
                 {servers.length === 0 && (
                   <Table.Tr>
                     <Table.Td colSpan={5} py="xl" ta="center" c="dark.2">No active deployments</Table.Td>
                   </Table.Tr>
                 )}
               </Table.Tbody>
             </Table>
           </Box>
        </Card>

        {/* Global Resources Monitor */}
        <Card p="lg" bg="dark.6" radius="md">
           <Group justify="space-between" mb="xs">
             <Box>
               <Text fw={800} size="sm">Global Resources</Text>
               <Text size="xs" c="dark.2">Network Load Monitor</Text>
             </Box>
             <ActionIcon variant="filled" color="emerald.9" c="emerald.4" size="sm"><IconActivity size={14} /></ActionIcon>
           </Group>

           <Stack gap="xl" mt="xl">
             <Box>
               <Group justify="space-between" mb={4}>
                 <Text size="xs" fw={800} tt="uppercase" c="dark.1">Memory Usage</Text>
                 <Text size="xs" fw={800} c="emerald.4">48.2 GB / 64 GB</Text>
               </Group>
               <Progress value={75} color="emerald.4" size="sm" radius="xl" />
             </Box>

             <Box>
               <Group justify="space-between" mb={4}>
                 <Text size="xs" fw={800} tt="uppercase" c="dark.1">CPU Load</Text>
                 <Text size="xs" fw={800} c="emerald.4">12%</Text>
               </Group>
               <Progress value={12} color="emerald.4" size="sm" radius="xl" />
             </Box>

             <Box>
               <Group justify="space-between" mb={4}>
                 <Text size="xs" fw={800} tt="uppercase" c="dark.1">Disk Space</Text>
                 <Text size="xs" fw={800} c="dark.1">1.2 TB / 2.0 TB</Text>
               </Group>
               <Progress value={60} color="dark.2" size="sm" radius="xl" />
             </Box>
           </Stack>

           <Box mt={60}>
              <Group gap="xs">
                <Box w={8} h={8} bg="emerald.4" style={{ borderRadius: '50%' }} />
                <Text size="xs" fw={700} c="dark.0">MASTER NODE: ONLINE</Text>
                <Text size="xs" c="dark.2" ml="auto">IP: 192.168.1.104</Text>
              </Group>
           </Box>
        </Card>
      </SimpleGrid>

      {/* Global Event Stream (Terminal) */}
      <Card p={0} bg="dark.8" radius="md" style={{ border: '1px solid var(--mantine-color-dark-3)', opacity: 0.9 }}>
        <Box p="xs" style={{ borderBottom: '1px solid var(--mantine-color-dark-3)' }}>
          <Group justify="space-between">
            <Group gap="xs">
              <IconActivity size={14} color="var(--mantine-color-emerald-4)" />
              <Text size="xs" fw={800} tt="uppercase" style={{ letterSpacing: 1 }}>Global Event Stream</Text>
            </Group>
            <Group gap={6}>
              <Box w={8} h={8} bg="dark.4" style={{ borderRadius: '50%' }} />
              <Box w={8} h={8} bg="dark.4" style={{ borderRadius: '50%' }} />
              <Box w={8} h={8} bg="emerald.4" style={{ borderRadius: '50%' }} />
            </Group>
          </Group>
        </Box>
        
        <ScrollArea h={180} p="md" viewportRef={logViewportRef}>
          {globalLogs.length === 0 ? (
            <Text c="dark.2" size="xs">Waiting for events...</Text>
          ) : (
            globalLogs.map((log, i) => (
              <Group key={i} gap="xs" wrap="nowrap" mb={2} align="baseline">
                <Text size="xs" c="emerald.4" fw={700} style={{ fontFamily: 'monospace', minWidth: 70 }}>
                  [{new Date(log.timestamp).toLocaleTimeString([], { hour12: false })}]
                </Text>
                <Text size="xs" c={log.level === 'ERROR' ? 'red' : 'emerald.4'} fw={700} style={{ fontFamily: 'monospace' }}>
                   [{log.serverId.slice(0, 8)}]
                </Text>
                <Text size="xs" c="dark.0" style={{ fontFamily: 'monospace', opacity: 0.9 }}>
                  {log.line}
                </Text>
              </Group>
            ))
          )}
        </ScrollArea>

        <Box p="xs" style={{ borderTop: '1px solid var(--mantine-color-dark-3)' }}>
           <Group justify="space-between">
             <Group gap="xl">
               <Group gap={6}>
                 <Box w={6} h={6} bg="emerald.4" style={{ borderRadius: '50%' }} />
                 <Text size="xs" fw={800} c="dark.0" style={{ fontSize: 9, textTransform: 'uppercase' }}>System Ready</Text>
               </Group>
               <Text size="xs" c="dark.2" style={{ fontSize: 9 }}>V2.4.0-STABLE</Text>
             </Group>
             <Group gap="xl">
               <Text size="xs" c="dark.2" style={{ fontSize: 9 }}>JAVA 21.0.2</Text>
               <Text size="xs" fw={800} c="emerald.4" style={{ fontSize: 9 }}>UPTIME: 99.9%</Text>
             </Group>
           </Group>
        </Box>
      </Card>
    </Stack>
  )
}

