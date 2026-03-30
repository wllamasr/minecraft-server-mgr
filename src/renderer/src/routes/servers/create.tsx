import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { 
  Title, TextInput, Select, NumberInput, Button, 
  Stack, Box, Group, Text, Loader, Badge, 
  UnstyledButton, Slider, Checkbox, 
  SimpleGrid, ThemeIcon, ScrollArea, Card
} from '@mantine/core'
import { useTranslation } from 'react-i18next'
import { useState, useMemo } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { notifications } from '@mantine/notifications'
import { 
  IconCheck, IconChevronLeft, IconChevronRight, 
  IconRocket, IconSword, IconBuildingFortress, 
  IconTree, IconSkull, IconBox,
  IconBolt, IconSettings, IconShieldCheck
} from '@tabler/icons-react'
import type { CreateServerInput, ModLoaderType } from '@shared/types'
import { ArchitectPreview } from '../../components/servers/ArchitectPreview'

export const Route = createFileRoute('/servers/create')({
  component: CreateServerPage
})

const MC_VERSIONS = [
  '1.21.4', '1.21.3', '1.21.1', '1.21',
  '1.20.4', '1.20.1', '1.19.4', '1.19.2', '1.18.2', '1.16.5'
]

const ENGINES = [
  { id: '', name: 'Vanilla', description: 'The pure Minecraft experience. Stable, official, and straightforward.', icon: IconBox, recommended: true },
  { id: 'paper', name: 'Spigot / Paper', description: 'High performance with plugin support. Industry standard.', icon: IconBolt, highlight: true },
  { id: 'neoforge', name: 'NeoForge', description: 'The modern, performance-first fork of Forge. Optimized for the latest versions.', icon: IconRocket, highlight: true },
  { id: 'forge', name: 'Forge', description: 'The classic modding engine. Supports the widest array of complex modpacks.', icon: IconSettings },
  { id: 'fabric', name: 'Fabric', description: 'Lightweight, modular, and extremely fast. Ideal for modern technical play.', icon: IconRocket },
  { id: 'quilt', name: 'Quilt', description: 'The community-driven evolution of Fabric. Caring and open-source.', icon: IconRocket },
]

const VISUAL_IDENTITIES = [
  { id: 'sword', icon: IconSword },
  { id: 'castle', icon: IconBuildingFortress },
  { id: 'tree', icon: IconTree },
  { id: 'skull', icon: IconSkull },
]

function CreateServerPage() {
  const { t } = useTranslation(['servers', 'common'])
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [step, setStep] = useState(1)

  const [form, setForm] = useState<CreateServerInput>({
    name: '',
    minecraftVersion: '1.21.4',
    port: 25565,
    minRam: '2G',
    maxRam: '4G'
  })

  const [selectedLoader, setSelectedLoader] = useState<string>('')
  const [selectedLoaderVersion, setSelectedLoaderVersion] = useState<string>('')
  const [selectedIdentity, setSelectedIdentity] = useState('sword')
  const [eulaAccepted, setEulaAccepted] = useState(false)

  const { data: loaderVersions, isLoading: loadingVersions } = useQuery({
    queryKey: ['loaderVersions', selectedLoader, form.minecraftVersion],
    queryFn: () => window.api.getModLoaderVersions(selectedLoader as ModLoaderType, form.minecraftVersion),
    enabled: !!selectedLoader && !!form.minecraftVersion
  })

  const createMutation = useMutation({
    mutationFn: (input: CreateServerInput) => window.api.createServer(input),
    onSuccess: (server) => {
      queryClient.invalidateQueries({ queryKey: ['servers'] })
      notifications.show({ title: 'Success', message: t('servers:serverCreated', { name: server.name }), color: 'green' })
      navigate({ to: '/servers/$serverId', params: { serverId: server.id } })
    },
    onError: (err: Error) => {
      notifications.show({ title: 'Error', message: err.message, color: 'red' })
    }
  })

  const handleCreate = () => {
    if (!form.name.trim() || !form.minecraftVersion || !eulaAccepted) return
    const input: CreateServerInput = {
      ...form,
      modLoader: selectedLoader ? (selectedLoader as ModLoaderType) : undefined,
      modLoaderVersion: selectedLoaderVersion || undefined
    }
    createMutation.mutate(input)
  }

  const engineName = useMemo(() => {
     return ENGINES.find(e => e.id === selectedLoader)?.name || 'Vanilla'
  }, [selectedLoader])

  return (
    <Box className="fade-in" style={{ height: '100%' }}>
      <Group align="flex-start" gap={60} p={0} wrap="nowrap" style={{ height: '100%' }}>
        <Box style={{ flex: 1, maxWidth: 800, height: '100%', display: 'flex', flexDirection: 'column' }}>
          {/* Header Step Indicator */}
          <Stack gap={32} mb={48}>
             <Group gap="xl">
                <Stack gap={4} align="center">
                   <Box 
                      w={42} h={42} 
                      bg={step === 1 ? 'emerald.4' : 'dark.5'} 
                      style={{ borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                   >
                      {step > 1 ? <IconCheck size={20} color="var(--mantine-color-dark-9)" stroke={3} /> : <Text fw={900} c={step === 1 ? 'dark.9' : 'dark.2'}>1</Text>}
                   </Box>
                   <Text size="xs" fw={900} c={step === 1 ? 'dark.0' : 'dark.2'} tt="uppercase" style={{ letterSpacing: 1 }}>Identity</Text>
                </Stack>
                <Box h={2} style={{ flex: 1, backgroundColor: 'var(--mantine-color-dark-5)', marginTop: -20 }} />
                <Stack gap={4} align="center">
                   <Box 
                      w={42} h={42} 
                      bg={step === 2 ? 'emerald.4' : 'dark.5'} 
                      style={{ borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                   >
                      {step > 2 ? <IconCheck size={20} color="var(--mantine-color-dark-9)" stroke={3} /> : <Text fw={900} c={step === 2 ? 'dark.9' : 'dark.2'}>2</Text>}
                   </Box>
                   <Text size="xs" fw={900} c={step === 2 ? 'dark.0' : 'dark.2'} tt="uppercase" style={{ letterSpacing: 1 }}>Engine</Text>
                </Stack>
                <Box h={2} style={{ flex: 1, backgroundColor: 'var(--mantine-color-dark-5)', marginTop: -20 }} />
                <Stack gap={4} align="center">
                   <Box 
                      w={42} h={42} 
                      bg={step === 3 ? 'emerald.4' : 'dark.5'} 
                      style={{ borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                   >
                      <Text fw={900} c={step === 3 ? 'dark.9' : 'dark.2'}>3</Text>
                   </Box>
                   <Text size="xs" fw={900} c={step === 3 ? 'dark.0' : 'dark.2'} tt="uppercase" style={{ letterSpacing: 1 }}>Logic</Text>
                </Stack>
             </Group>

             <Box>
                <Text size="xs" fw={800} c="emerald.4" tt="uppercase" style={{ letterSpacing: 2 }}>
                  Step {step} of 3 — {step === 1 ? 'Initialize Identity' : step === 2 ? 'Select Engine' : 'System Configuration'}
                </Text>
                <Title order={1} style={{ fontSize: '3rem', mt: 8 }}>
                   {step === 1 ? 'Basic Identity' : step === 2 ? 'Engine Selection' : 'Core Logic & Resources'}
                </Title>
                <Text c="dark.1" mt="md" size="md">
                   {step === 1 ? 'Architect your world with high-precision parameters.' : 
                    step === 2 ? 'Define the core architecture of your server. This choice dictates mod compatibility.' : 
                    'Fine-tune your hardware allocation and network protocols.'}
                </Text>
             </Box>
          </Stack>

          {/* Step Contents */}
          <Box style={{ flex: 1, minHeight: 0 }}>
            <ScrollArea h="100%" scrollbarSize={4}>
              {step === 1 && (
                <Stack gap={40} pb="xl">
                  <Box>
                     <Text size="xs" fw={800} c="dark.1" tt="uppercase" mb={12}>Server Name</Text>
                     <TextInput
                        placeholder="Enter a distinctive name..."
                        styles={{ input: { height: 60, fontSize: 18, backgroundColor: 'var(--mantine-color-dark-8)', border: '1px solid var(--mantine-color-dark-5)' } }}
                        value={form.name}
                        onChange={(e) => setForm({ ...form, name: e.target.value })}
                     />
                  </Box>

                  <Box>
                     <Text size="xs" fw={800} c="dark.1" tt="uppercase" mb={12}>Visual Identity</Text>
                     <Group gap="md">
                        {VISUAL_IDENTITIES.map(id => (
                          <UnstyledButton
                            key={id.id}
                            onClick={() => setSelectedIdentity(id.id)}
                            style={{
                              width: 80, height: 80, borderRadius: 8,
                              backgroundColor: selectedIdentity === id.id ? 'transparent' : 'var(--mantine-color-dark-5)',
                              border: `2px solid ${selectedIdentity === id.id ? 'var(--mantine-color-emerald-4)' : 'transparent'}`,
                              display: 'flex', alignItems: 'center', justifyContent: 'center',
                              transition: 'all 0.2s ease'
                            }}
                          >
                            <id.icon size={32} color={selectedIdentity === id.id ? 'var(--mantine-color-emerald-4)' : 'white'} />
                          </UnstyledButton>
                        ))}
                        <UnstyledButton
                          style={{
                            width: 80, height: 80, borderRadius: 8,
                            backgroundColor: 'var(--mantine-color-dark-8)',
                            border: '2px dashed var(--mantine-color-dark-4)',
                            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center'
                          }}
                        >
                           <Text size="xs" c="dark.2" fw={700}>SVG/PNG</Text>
                        </UnstyledButton>
                     </Group>
                  </Box>

                  <Box>
                     <Text size="xs" fw={800} c="dark.1" tt="uppercase" mb={12}>Public MOTD (Optional)</Text>
                     <TextInput
                        placeholder="A brief broadcast for the server browser..."
                        styles={{ input: { height: 80, backgroundColor: 'var(--mantine-color-dark-8)', border: '1px solid var(--mantine-color-dark-5)' } }}
                     />
                  </Box>
                </Stack>
              )}

              {step === 2 && (
                <Stack gap={40} pb="xl">
                   <SimpleGrid cols={2} spacing="lg">
                      {ENGINES.map(engine => (
                        <Card 
                          key={engine.id} 
                          p="lg" 
                          onClick={() => {
                            setSelectedLoader(engine.id)
                            setSelectedLoaderVersion('')
                          }}
                          style={{
                            cursor: 'pointer',
                            backgroundColor: selectedLoader === engine.id ? 'transparent' : 'var(--mantine-color-dark-8)',
                            border: `2px solid ${selectedLoader === engine.id ? 'var(--mantine-color-emerald-4)' : 'transparent'}`,
                            transition: 'all 0.2s ease',
                            position: 'relative'
                          }}
                        >
                           {engine.recommended && <Badge variant="filled" color="emerald.9" c="emerald.4" size="xs" radius="sm" style={{ position: 'absolute', top: 12, right: 12 }}>RECOMMENDED</Badge>}
                           {selectedLoader === engine.id && <Box style={{ position: 'absolute', top: 12, right: 12 }}><IconCheck size={18} color="var(--mantine-color-emerald-4)" /></Box>}
                           <ThemeIcon 
                             size={48} variant="filled" 
                             bg={selectedLoader === engine.id ? 'emerald.4' : 'dark.5'}
                             color={selectedLoader === engine.id ? 'dark.9' : 'white'}
                             mb="md"
                           >
                              <engine.icon size={28} />
                           </ThemeIcon>
                           <Text fw={800} size="md" mb={4}>{engine.name}</Text>
                           <Text size="xs" c="dark.1" style={{ lineHeight: 1.4 }}>{engine.description}</Text>
                        </Card>
                      ))}
                   </SimpleGrid>

                   <Box>
                      <Text size="xs" fw={800} c="dark.1" tt="uppercase" mb={12}>Minecraft Version</Text>
                      <Select
                        data={MC_VERSIONS}
                        value={form.minecraftVersion}
                        onChange={(val) => {
                          setForm({ ...form, minecraftVersion: val || '1.21.4' })
                          setSelectedLoaderVersion('')
                        }}
                        styles={{ input: { height: 50, backgroundColor: 'var(--mantine-color-dark-8)', border: '1px solid var(--mantine-color-dark-5)' } }}
                      />
                      
                      <Box mt="md" p="md" bg="dark.8" style={{ borderRadius: 8 }}>
                         <Text size="xs" fw={800} c="emerald.4" tt="uppercase" mb="xs" style={{ letterSpacing: 1 }}>
                           {selectedLoader ? `${engineName} Version` : 'Selection Status'}
                         </Text>
                         {selectedLoader ? (
                           <Select
                             placeholder={`Select ${engineName} version...`}
                             data={(loaderVersions || []).map(v => v.version)}
                             value={selectedLoaderVersion}
                             onChange={(val) => setSelectedLoaderVersion(val || '')}
                             disabled={loadingVersions}
                             leftSection={loadingVersions && <Loader size="xs" color="emerald.4" />}
                             styles={{ input: { height: 50, backgroundColor: 'var(--mantine-color-dark-8)', border: '1px solid var(--mantine-color-dark-5)' } }}
                           />
                         ) : (
                           <Text size="sm" fw={700} c="emerald.4" p="xs">{form.minecraftVersion} (Stable)</Text>
                         )}
                      </Box>
                   </Box>
                </Stack>
              )}

              {step === 3 && (
                <Stack gap={40} pb="xl">
                  <Card p={24} bg="dark.8" radius="md" style={{ border: '1px solid var(--mantine-color-dark-5)' }}>
                     <Group justify="space-between" mb="xs">
                        <Box>
                           <Text size="xs" fw={800} c="dark.1" tt="uppercase" mb={4}>Ram Allocation</Text>
                           <Text size="xs" c="dark.2">Dedicated memory for server execution</Text>
                        </Box>
                        <Text fw={900} size="xl"><Text component="span" c="emerald.4">{(form.maxRam || '4G').replace('G', '.0')}</Text> GB</Text>
                     </Group>
                     <Box px="md" py="xl">
                        <Slider 
                          min={1} max={16} step={1}
                          value={parseInt(form.maxRam || '4G')}
                          onChange={(val) => setForm({ ...form, minRam: `${Math.floor(val/2)}G`, maxRam: `${val}G` })}
                          color="emerald.4"
                          label={null}
                          marks={[
                            { value: 2, label: <Text size="xs" fw={700} c="dark.2" mt={8}>2GB (MIN)</Text> },
                            { value: 6, label: <Text size="xs" fw={700} c="emerald.4" mt={8}>6GB (REC)</Text> },
                            { value: 16, label: <Text size="xs" fw={700} c="dark.2" mt={8}>16GB (EXT)</Text> }
                          ]}
                        />
                     </Box>
                     <Box mt={32} p="md" bg="emerald.9" style={{ borderRadius: 6, border: '1px solid rgba(84, 233, 138, 0.2)' }}>
                        <Text size="xs" c="emerald.4" fw={700}>
                           Based on your selection of {engineName} with 5-10 plugins, 6GB to 8GB is optimal for performance.
                        </Text>
                     </Box>
                  </Card>

                  <Group gap="lg" grow>
                     <Box>
                        <Text size="xs" fw={800} c="dark.1" tt="uppercase" mb={12}>Network Port</Text>
                        <NumberInput
                          value={form.port}
                          onChange={(val) => setForm({ ...form, port: Number(val) || 25565 })}
                          styles={{ input: { height: 60, backgroundColor: 'var(--mantine-color-dark-8)', border: '1px solid var(--mantine-color-dark-5)' } }}
                        />
                     </Box>
                     <Card p="md" bg="dark.8" style={{ alignSelf: 'stretch', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
                        <Group justify="space-between">
                           <Box>
                              <Text size="xs" fw={800} c="white">Auto-Restart</Text>
                              <Text size="xs" c="dark.2">Recover on crash</Text>
                           </Box>
                           <IconBolt size={20} color="var(--mantine-color-emerald-4)" fill="currentColor" />
                        </Group>
                     </Card>
                  </Group>

                  <Box mt="md">
                     <Checkbox
                        label={
                          <Text size="xs" c="dark.1">
                            I acknowledge that I have read and agree to the <Text component="span" c="emerald.4" td="underline" style={{ cursor: 'pointer' }}>Mojang End User License Agreement</Text> and the Command Core terms of service.
                          </Text>
                        }
                        checked={eulaAccepted}
                        onChange={(e) => setEulaAccepted(e.currentTarget.checked)}
                        styles={{ input: { backgroundColor: 'var(--mantine-color-dark-8)', borderColor: 'var(--mantine-color-dark-4)' } }}
                     />
                  </Box>
                </Stack>
              )}
            </ScrollArea>
          </Box>

          {/* Action Buttons */}
          <Group justify="space-between" mt="auto" py={32} style={{ borderTop: '1px solid var(--mantine-color-dark-5)' }}>
             <Button 
                variant="subtle" 
                color="dark.1" 
                leftSection={<IconChevronLeft size={18} />}
                onClick={() => step === 1 ? navigate({ to: '/servers' }) : setStep(s => s - 1)}
             >
                {step === 1 ? 'Cancel Creation' : step === 2 ? 'Return to Identity' : 'Return to Engine'}
             </Button>

             <Button
                variant="filled"
                color="emerald.4"
                c="dark.9"
                size="md"
                fw={900}
                px={40}
                rightSection={step === 3 ? <IconRocket size={18} /> : <IconChevronRight size={18} />}
                onClick={() => {
                  if (step < 3) setStep(s => s + 1)
                  else handleCreate()
                }}
                loading={createMutation.isPending}
                disabled={step === 3 && !eulaAccepted}
             >
                {step === 3 ? 'Initialize & Deploy Server' : step === 2 ? 'Continue to System Configuration' : 'Continue to Engine Selection'}
             </Button>
          </Group>
        </Box>

        <ArchitectPreview 
           name={form.name || 'New Instance'}
           version={form.minecraftVersion}
           loader={engineName}
           ram={form.maxRam || '4G'}
           port={form.port || 25565}
           step={step}
        />
      </Group>
    </Box>
  )
}

