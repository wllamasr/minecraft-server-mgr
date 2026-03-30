import { Group, ActionIcon, Text, Box, Button } from '@mantine/core'
import { IconMinus, IconSquare, IconX, IconPlus, IconBell, IconSettings } from '@tabler/icons-react'
import { Link } from '@tanstack/react-router'

export function TitleBar() {
  return (
    <Box
      className="titlebar-drag"
      style={{
        height: 'var(--titlebar-height)',
        backgroundColor: 'var(--mantine-color-dark-6)', // surface-container-low
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingLeft: 16,
        paddingRight: 0,
        flexShrink: 0,
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        zIndex: 1000,
        borderBottom: '1px solid var(--mantine-color-dark-4)'
      }}
    >
      <Group gap="xs">
        <Text size="xs" fw={900} c="emerald.4">
          ⛏
        </Text>
        <Text size="xs" fw={700} c="dark.1" style={{ letterSpacing: 0.5 }}>
          MINECRAFT SERVER MANAGER
        </Text>
      </Group>

      <Group gap={0} className="titlebar-no-drag">
        {/* Rapid Actions */}
        <Group gap="xs" px="lg" style={{ borderRight: '1px solid var(--mantine-color-dark-5)', marginRight: 4 }}>
           <Button
             component={Link}
             to="/servers/create"
             leftSection={<IconPlus size={14} />}
             variant="filled"
             color="emerald.4"
             size="xs"
             c="dark.9"
             h={24}
             fw={800}
             style={{ fontSize: 10 }}
           >
             Create New Server
           </Button>
           
           <ActionIcon variant="subtle" color="dark.2" size="sm">
             <IconBell size={16} />
           </ActionIcon>
           
           <ActionIcon variant="subtle" color="dark.2" size="sm">
             <IconSettings size={16} />
           </ActionIcon>
        </Group>

        {/* Window Controls */}
        <ActionIcon
          variant="subtle"
          color="gray"
          size={38}
          radius={0}
          onClick={() => window.api.windowMinimize()}
          aria-label="Minimize"
        >
          <IconMinus size={14} />
        </ActionIcon>
        <ActionIcon
          variant="subtle"
          color="gray"
          size={38}
          radius={0}
          onClick={() => window.api.windowMaximize()}
          aria-label="Maximize"
        >
          <IconSquare size={12} />
        </ActionIcon>
        <ActionIcon
          variant="subtle"
          color="gray"
          size={38}
          radius={0}
          onClick={() => window.api.windowClose()}
          aria-label="Close"
          className="close-button"
          style={{ borderRadius: 0 }}
        >
          <IconX size={14} />
        </ActionIcon>
      </Group>
    </Box>
  )
}
