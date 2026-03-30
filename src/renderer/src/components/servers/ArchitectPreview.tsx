import { Box, Text, Stack, Group, Avatar, Badge, Progress, ThemeIcon } from '@mantine/core'
import { IconLayout, IconCpu, IconDeviceFloppy, IconNetwork, IconRocket, IconBulb } from '@tabler/icons-react'

interface ArchitectPreviewProps {
  name: string
  version: string
  loader?: string
  loaderVersion?: string
  ram: string
  port: number
  icon?: string
  step: number
}

export function ArchitectPreview({ 
  name, version, loader, loaderVersion, ram, port, icon, step 
}: ArchitectPreviewProps) {
  return (
    <Box
      style={{
        width: 320,
        backgroundColor: 'var(--mantine-color-dark-6)',
        borderRadius: 'var(--mantine-radius-md)',
        overflow: 'hidden',
        position: 'sticky',
        top: 24
      }}
    >
      <Box p="lg" style={{ borderBottom: '1px solid var(--mantine-color-dark-5)' }}>
        <Text fw={800} size="sm" tt="uppercase" c="dark.1" style={{ letterSpacing: 1 }}>
          Architect Preview
        </Text>
      </Box>

      <Box p="xl">
        <Stack gap="xl">
          <Box
            h={220}
            bg="dark.8"
            style={{ 
              borderRadius: 'var(--mantine-radius-md)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              position: 'relative',
              overflow: 'hidden'
            }}
          >
             <Box
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                backgroundImage: 'radial-gradient(circle at center, rgba(84, 233, 138, 0.05) 0%, transparent 70%)',
              }}
             />
             
             <ThemeIcon size={80} radius="xl" variant="filled" color="emerald.9" c="emerald.4" mb="md">
                <IconRocket size={40} />
             </ThemeIcon>

             <Box ta="center">
                <Text size="xs" fw={800} c="emerald.4" tt="uppercase" mb={4}>Status</Text>
                <Text fw={900} size="xl" c="dark.0">PRE-FLIGHT</Text>
             </Box>
          </Box>

          <Stack gap="md">
            <Group justify="space-between">
               <Text size="xs" fw={700} c="dark.2">ENGINE</Text>
               <Text size="xs" fw={800} c="dark.0">{loader || 'VANILLA'} {version}</Text>
            </Group>
            <Group justify="space-between">
               <Text size="xs" fw={700} c="dark.2">MEMORY</Text>
               <Text size="xs" fw={800} c="dark.0">{ram}</Text>
            </Group>
            <Group justify="space-between">
               <Text size="xs" fw={700} c="dark.2">NETWORK</Text>
               <Text size="xs" fw={800} c="dark.0">PORT {port}</Text>
            </Group>
            <Group justify="space-between">
               <Text size="xs" fw={700} c="dark.2">STORAGE</Text>
               <Text size="xs" fw={800} c="dark.1">DYNAMIC ALLOC</Text>
            </Group>
          </Stack>

          <Box mt="md">
            <Group justify="space-between" mb={6}>
               <Text size="xs" fw={800} tt="uppercase" c="dark.2">Estimated Load</Text>
               <Text size="xs" fw={800} c="emerald.4">OPTIMAL</Text>
            </Group>
             <Progress value={20} color="emerald.4" size="sm" radius="xl" />
          </Box>
        </Stack>
      </Box>

      <Box p="lg" bg="dark.7" style={{ borderTop: '1px solid var(--mantine-color-dark-5)' }}>
        <Group gap="sm" align="flex-start" wrap="nowrap">
           <IconBulb size={18} color="var(--mantine-color-emerald-4)" style={{ flexShrink: 0 }} />
           <Text size="xs" c="dark.2" style={{ lineHeight: 1.5 }}>
              <Text component="span" fw={800} c="dark.0">Pro Tip:</Text> Choosing a shorter, punchy server name improves discoverability on community trackers.
           </Text>
        </Group>
      </Box>
    </Box>
  )
}
