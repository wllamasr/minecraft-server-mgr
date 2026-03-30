import { NavLink, Stack, Box, Text, Group, UnstyledButton } from '@mantine/core'
import { IconLayoutDashboard, IconServer, IconSettings, IconPackage, IconDots } from '@tabler/icons-react'
import { useRouter, useRouterState } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'

const NAV_ITEMS = [
  { path: '/', icon: IconLayoutDashboard, labelKey: 'nav.dashboard' },
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
        width: 240,
        height: '100%',
        backgroundColor: 'var(--mantine-color-dark-6)', // surface-container-low
        display: 'flex',
        flexDirection: 'column',
        flexShrink: 0,
        paddingTop: 40 // Title bar offset
      }}
    >
      <Box px="lg" mb="xl">
        <Group justify="space-between" align="center">
          <Box>
            <Text fw={900} size="sm" c="emerald.4" style={{ letterSpacing: 1.5, textTransform: 'uppercase' }}>
              Command Core
            </Text>
            <Text size="xs" c="dark.1" style={{ letterSpacing: 1, textTransform: 'uppercase' }}>
              Admin Console
            </Text>
          </Box>
        </Group>
      </Box>

      <Stack gap={4} px="md" style={{ flex: 1 }}>
        {NAV_ITEMS.map((item) => {
          const isActive = item.path === '/'
            ? currentPath === '/'
            : currentPath.startsWith(item.path)

          return (
            <UnstyledButton
              key={item.path}
              onClick={() => router.navigate({ to: item.path })}
              style={(theme) => ({
                display: 'flex',
                alignItems: 'center',
                gap: theme.spacing.sm,
                padding: '10px 14px',
                borderRadius: theme.radius.md,
                backgroundColor: isActive ? 'var(--mantine-color-dark-5)' : 'transparent',
                color: isActive ? 'var(--mantine-color-dark-0)' : 'var(--mantine-color-dark-1)',
                transition: 'all 150ms ease',
                position: 'relative',
                '&:hover': {
                  backgroundColor: 'var(--mantine-color-dark-5)',
                  color: 'var(--mantine-color-dark-0)'
                }
              })}
            >
              <item.icon 
                size={20} 
                stroke={2} 
                color={isActive ? 'var(--mantine-color-emerald-4)' : 'currentColor'} 
              />
              <Text size="sm" fw={600}>{t(item.labelKey)}</Text>
              
              {isActive && (
                <Box
                  style={{
                    position: 'absolute',
                    right: 0,
                    top: '50%',
                    transform: 'translateY(-50%)',
                    width: 4,
                    height: 18,
                    backgroundColor: 'var(--mantine-color-emerald-4)',
                    borderRadius: 2,
                    boxShadow: '0 0 10px rgba(84, 233, 138, 0.4)'
                  }}
                />
              )}
            </UnstyledButton>
          )
        })}
      </Stack>

      <Box p="lg" style={{ borderTop: '1px solid var(--mantine-color-dark-5)' }}>
        <Group gap="sm">
          <Box
            w={32}
            h={32}
            bg="emerald.4"
            style={{ borderRadius: 6, display: 'flex', alignItems: 'center', justifyItems: 'center' }}
          >
             <Text size="xs" ta="center" w="100%" fw={800} c="dark.9">AU</Text>
          </Box>
          <Box style={{ flex: 1 }}>
            <Text size="xs" fw={700} c="dark.0">Admin_User</Text>
            <Text size="xs" c="dark.1" style={{ fontSize: 10 }}>Root Access</Text>
          </Box>
        </Group>
      </Box>
    </Box>
  )
}
