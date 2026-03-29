import { Group, ActionIcon, Text, Box } from '@mantine/core'
import { IconMinus, IconSquare, IconX } from '@tabler/icons-react'

export function TitleBar() {
  return (
    <Box
      className="titlebar-drag"
      style={{
        height: 'var(--titlebar-height)',
        backgroundColor: 'var(--mantine-color-dark-8)',
        borderBottom: '1px solid var(--mantine-color-dark-6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingLeft: 16,
        paddingRight: 0,
        flexShrink: 0
      }}
    >
      <Text size="sm" fw={600} c="dimmed">
        ⛏ Minecraft Server Manager
      </Text>

      <Group gap={0} className="titlebar-no-drag">
        <ActionIcon
          variant="subtle"
          color="gray"
          size={38}
          radius={0}
          onClick={() => window.api.windowMinimize()}
          aria-label="Minimize"
        >
          <IconMinus size={16} />
        </ActionIcon>
        <ActionIcon
          variant="subtle"
          color="gray"
          size={38}
          radius={0}
          onClick={() => window.api.windowMaximize()}
          aria-label="Maximize"
        >
          <IconSquare size={14} />
        </ActionIcon>
        <ActionIcon
          variant="subtle"
          color="red"
          size={38}
          radius={0}
          onClick={() => window.api.windowClose()}
          aria-label="Close"
          style={{ borderRadius: 0 }}
        >
          <IconX size={16} />
        </ActionIcon>
      </Group>
    </Box>
  )
}
