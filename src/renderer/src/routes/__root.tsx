import { createRootRoute, Outlet } from '@tanstack/react-router'
import { Box } from '@mantine/core'
import { TitleBar } from '../components/layout/TitleBar'
import { Sidebar } from '../components/layout/Sidebar'
import { StatusBar } from '../components/layout/StatusBar'

export const Route = createRootRoute({
  component: RootLayout
})

function RootLayout() {
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
