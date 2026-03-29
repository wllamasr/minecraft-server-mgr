import { NavLink, Stack, Box, Text } from '@mantine/core'
import { IconHome, IconServer, IconSettings, IconPackage } from '@tabler/icons-react'
import { useRouter, useRouterState } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'

const NAV_ITEMS = [
  { path: '/', icon: IconHome, labelKey: 'nav.dashboard' },
  { path: '/servers', icon: IconServer, labelKey: 'nav.servers' },
  { path: '/mods', icon: IconPackage, labelKey: 'nav.mods' },
  { path: '/settings', icon: IconSettings, labelKey: 'nav.settings' }
]

export function Sidebar() {
  const { t } = useTranslation('common')
  const router = useRouter()
  const routerState = useRouterState()
  const currentPath = routerState.location.pathname

  return (
    <Box
      style={{
        width: 220,
        height: '100%',
        backgroundColor: 'var(--mantine-color-dark-8)',
        borderRight: '1px solid var(--mantine-color-dark-6)',
        display: 'flex',
        flexDirection: 'column',
        flexShrink: 0
      }}
    >
      <Stack gap={2} p="sm" style={{ flex: 1 }}>
        {NAV_ITEMS.map((item) => {
          const isActive = item.path === '/'
            ? currentPath === '/'
            : currentPath.startsWith(item.path)

          return (
            <NavLink
              key={item.path}
              label={t(item.labelKey)}
              leftSection={<item.icon size={20} stroke={1.5} />}
              active={isActive}
              onClick={() => router.navigate({ to: item.path })}
              style={{ borderRadius: 'var(--mantine-radius-md)' }}
            />
          )
        })}
      </Stack>

      <Box p="sm" style={{ borderTop: '1px solid var(--mantine-color-dark-6)' }}>
        <Text size="xs" c="dimmed" ta="center">
          ⛏ MSM
        </Text>
      </Box>
    </Box>
  )
}
