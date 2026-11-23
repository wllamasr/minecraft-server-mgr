import { Box, Loader, Stack, Text, Title } from '@mantine/core'
import { useEffect, useState } from 'react'

/**
 * Covers the app while it is closing and still waiting for servers to stop, so
 * a close that takes a minute or two does not look like a frozen window.
 */
export function ShutdownOverlay() {
  const [serverCount, setServerCount] = useState(0)

  useEffect(() => {
    // The event is missed if the window (re)loads while the app is closing.
    void window.api.shutdownPending().then((count) => setServerCount((current) => current || count))
    return window.api.onShuttingDown(setServerCount)
  }, [])

  if (serverCount <= 0) return null

  return (
    <Box
      data-testid="shutdown-overlay"
      role="alertdialog"
      aria-live="assertive"
      aria-label="Stopping servers before closing"
      style={{
        position: 'fixed',
        // The title bar stays reachable, so the window can still be moved or minimized.
        top: 'var(--titlebar-height)',
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 10000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(26, 27, 30, 0.94)'
      }}
    >
      <Stack align="center" gap="sm" maw={460} px="lg">
        <Loader size="lg" />
        <Title order={3} ta="center">
          {serverCount === 1 ? 'Stopping 1 server…' : `Stopping ${serverCount} servers…`}
        </Title>
        <Text c="dimmed" ta="center" size="sm">
          Each server is saving its world before it shuts down. This can take up to two minutes for large
          worlds. The app closes by itself when they are done.
        </Text>
      </Stack>
    </Box>
  )
}
