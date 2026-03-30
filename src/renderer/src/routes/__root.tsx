import { createRootRoute, Outlet } from '@tanstack/react-router'
import { Box, Button, Text } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { IconDownload } from '@tabler/icons-react'
import { useEffect } from 'react'
import { TitleBar } from '../components/layout/TitleBar'
import { Sidebar } from '../components/layout/Sidebar'
import { StatusBar } from '../components/layout/StatusBar'

export const Route = createRootRoute({
  component: RootLayout
})

function RootLayout() {
  useEffect(() => {
    const unsub = window.api.onUpdateDownloaded((version) => {
      notifications.show({
        id: 'app-update',
        title: 'Update Ready!',
        color: 'green',
        autoClose: false,
        message: (
          <Box mt="xs">
            <Text size="sm" mb="xs">
              Minecraft Server Manager version {version} has been downloaded and is ready to install.
            </Text>
            <Button
              size="xs"
              color="green"
              leftSection={<IconDownload size={14} />}
              onClick={() => window.api.installUpdate()}
            >
              Restart & Install
            </Button>
          </Box>
        )
      })
    })
    return () => unsub()
  }, [])

  return (
    <Box style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <TitleBar />
      <Box style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        <Sidebar />
        <Box
          component="main"
          style={{
            flex: 1,
            overflow: 'auto',
            padding: 'var(--mantine-spacing-lg)',
            paddingTop: 'calc(var(--titlebar-height) + var(--mantine-spacing-lg))',
            backgroundColor: 'var(--mantine-color-dark-7)'
          }}
        >
          <Outlet />
        </Box>
      </Box>
      <StatusBar />
    </Box>
  )
}
