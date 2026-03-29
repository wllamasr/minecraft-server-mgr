import { useEffect } from 'react'
import { TextInput, NumberInput, Select, Switch, Button, Group, Stack, Paper, Title } from '@mantine/core'
import { useForm } from '@mantine/form'
import { notifications } from '@mantine/notifications'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { IconDeviceFloppy } from '@tabler/icons-react'

interface Props {
  serverId: string
}

interface PropertiesFormValues {
  'server-port': number
  'max-players': number
  motd: string
  'online-mode': boolean
  difficulty: string
  gamemode: string
  pvp: boolean
  'enable-command-block': boolean
  'view-distance': number
  'simulation-distance': number
  'white-list': boolean
  'spawn-protection': number
  [key: string]: any
}

export function ServerPropertiesEditor({ serverId }: Props) {
  const queryClient = useQueryClient()

  const { data: properties, isLoading } = useQuery({
    queryKey: ['server-properties', serverId],
    queryFn: () => window.api.readServerProperties(serverId)
  })

  const form = useForm<PropertiesFormValues>({
    initialValues: {
      'server-port': 25565,
      'max-players': 20,
      motd: 'A Minecraft Server',
      'online-mode': true,
      difficulty: 'easy',
      gamemode: 'survival',
      pvp: true,
      'enable-command-block': false,
      'view-distance': 10,
      'simulation-distance': 10,
      'white-list': false,
      'spawn-protection': 16
    }
  })

  // Load backend properties into form
  useEffect(() => {
    if (properties) {
      form.setValues({
        'server-port': parseInt(properties['server-port']) || 25565,
        'max-players': parseInt(properties['max-players']) || 20,
        motd: properties['motd'] || 'A Minecraft Server',
        'online-mode': properties['online-mode'] === 'true',
        difficulty: properties['difficulty'] || 'easy',
        gamemode: properties['gamemode'] || 'survival',
        pvp: properties['pvp'] !== 'false',
        'enable-command-block': properties['enable-command-block'] === 'true',
        'view-distance': parseInt(properties['view-distance']) || 10,
        'simulation-distance': parseInt(properties['simulation-distance']) || 10,
        'white-list': properties['white-list'] === 'true',
        'spawn-protection': parseInt(properties['spawn-protection']) || 16
      })
      form.resetDirty()
    }
  }, [properties])

  const saveMutation = useMutation({
    mutationFn: (values: PropertiesFormValues) => {
      // Convert boolean/numbers back to strings for server.properties
      const payload: Record<string, string> = { ...properties }
      Object.entries(values).forEach(([key, val]) => {
        payload[key] = val.toString()
      })
      return window.api.writeServerProperties(serverId, payload)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['server-properties', serverId] })
      notifications.show({ title: 'Saved', message: 'server.properties updated successfully', color: 'green' })
      form.resetDirty()
    },
    onError: (err: Error) => {
      notifications.show({ title: 'Error', message: err.message, color: 'red' })
    }
  })

  const handleSubmit = (values: PropertiesFormValues) => {
    saveMutation.mutate(values)
  }

  if (isLoading) return null

  return (
    <Paper p="xl" radius="md" withBorder style={{ borderColor: 'var(--mantine-color-dark-5)' }}>
      <form onSubmit={form.onSubmit(handleSubmit)}>
        <Stack gap="lg">
          <Group justify="space-between" align="center">
            <Title order={4}>server.properties</Title>
            <Button
              type="submit"
              leftSection={<IconDeviceFloppy size={16} />}
              loading={saveMutation.isPending}
              disabled={!form.isDirty()}
              color="blue"
            >
              Save Changes
            </Button>
          </Group>

          <Group grow align="flex-start">
            <Stack gap="md">
              <TextInput label="MOTD" description="Server message of the day" {...form.getInputProps('motd')} />
              <NumberInput label="Server Port" description="Main gameplay port" hideControls {...form.getInputProps('server-port')} />
              <NumberInput label="Max Players" hideControls {...form.getInputProps('max-players')} />
              
              <Select 
                label="Difficulty" 
                data={['peaceful', 'easy', 'normal', 'hard']} 
                {...form.getInputProps('difficulty')} 
              />
              <Select 
                label="Game Mode" 
                data={['survival', 'creative', 'adventure', 'spectator']} 
                {...form.getInputProps('gamemode')} 
              />
            </Stack>

            <Stack gap="md">
              <NumberInput label="View Distance" hideControls min={2} max={32} {...form.getInputProps('view-distance')} />
              <NumberInput label="Simulation Distance" hideControls min={2} max={32} {...form.getInputProps('simulation-distance')} />
              <NumberInput label="Spawn Protection" description="Radius in blocks" hideControls min={0} {...form.getInputProps('spawn-protection')} />
              
              <Paper p="md" withBorder radius="md" mt="sm">
                <Stack gap="sm">
                  <Switch label="Online Mode (Authentication)" description="Set to false for offline/cracked servers" {...form.getInputProps('online-mode', { type: 'checkbox' })} />
                  <Switch label="Player vs Player (PvP)" {...form.getInputProps('pvp', { type: 'checkbox' })} />
                  <Switch label="Enable Command Blocks" {...form.getInputProps('enable-command-block', { type: 'checkbox' })} />
                  <Switch label="Enable Whitelist" {...form.getInputProps('white-list', { type: 'checkbox' })} />
                </Stack>
              </Paper>
            </Stack>
          </Group>
        </Stack>
      </form>
    </Paper>
  )
}
