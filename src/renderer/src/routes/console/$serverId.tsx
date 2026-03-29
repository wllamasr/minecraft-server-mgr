import { createFileRoute } from '@tanstack/react-router'
import { Title, Stack, Paper, Box, TextInput, ActionIcon, Group, Text, ScrollArea, Switch } from '@mantine/core'
import { IconSend } from '@tabler/icons-react'
import { useTranslation } from 'react-i18next'
import { useState, useEffect, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { ServerLogEntry, ServerWithStatus } from '@shared/types'

export const Route = createFileRoute('/console/$serverId')({
  component: ConsolePage
})

function ConsolePage() {
  const { serverId } = Route.useParams()
  const { t } = useTranslation(['console', 'common'])
  const [command, setCommand] = useState('')
  const [logs, setLogs] = useState<ServerLogEntry[]>([])
  const [autoScroll, setAutoScroll] = useState(true)
  const scrollRef = useRef<HTMLDivElement>(null)
  const viewportRef = useRef<HTMLDivElement>(null)

  const { data: server } = useQuery<ServerWithStatus | null>({
    queryKey: ['server', serverId],
    queryFn: () => window.api.getServer(serverId),
    refetchInterval: 5000
  })

  // Listen for server log events
  useEffect(() => {
    const unsubscribe = window.api.onServerLog((entry) => {
      if (entry.serverId === serverId) {
        setLogs((prev) => [...prev.slice(-1999), entry])
      }
    })
    return unsubscribe
  }, [serverId])

  // Auto-scroll
  useEffect(() => {
    if (autoScroll && viewportRef.current) {
      viewportRef.current.scrollTop = viewportRef.current.scrollHeight
    }
  }, [logs, autoScroll])

  const handleSend = () => {
    if (!command.trim()) return
    window.api.sendCommand(serverId, command.trim())
    setCommand('')
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSend()
    }
  }

  return (
    <Stack gap="md" style={{ height: '100%' }}>
      <Group justify="space-between">
        <Title order={2}>
          {t('console:title')} — {server?.name || serverId}
        </Title>
        <Switch
          label={t('console:autoScroll')}
          checked={autoScroll}
          onChange={(e) => setAutoScroll(e.currentTarget.checked)}
          size="sm"
        />
      </Group>

      <Paper
        p={0}
        radius="md"
        withBorder
        style={{
          borderColor: 'var(--mantine-color-dark-5)',
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          minHeight: 400
        }}
      >
        <ScrollArea
          style={{ flex: 1 }}
          viewportRef={viewportRef}
          scrollbarSize={8}
        >
          <Box p="md" className="console-output" ref={scrollRef}>
            {logs.length === 0 ? (
              <Text c="dimmed" size="sm">
                {t('console:noLogs')}
              </Text>
            ) : (
              logs.map((entry, i) => (
                <div key={i}>
                  <Text
                    component="span"
                    size="xs"
                    c="dimmed"
                    style={{ fontFamily: 'var(--mantine-font-family-monospace)' }}
                  >
                    {new Date(entry.timestamp).toLocaleTimeString()}
                  </Text>{' '}
                  <Text
                    component="span"
                    size="sm"
                    style={{ fontFamily: 'var(--mantine-font-family-monospace)' }}
                  >
                    {entry.line}
                  </Text>
                </div>
              ))
            )}
          </Box>
        </ScrollArea>

        <Box
          p="sm"
          style={{ borderTop: '1px solid var(--mantine-color-dark-5)' }}
        >
          <Group gap="sm">
            <TextInput
              placeholder={t('console:placeholder')}
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              onKeyDown={handleKeyDown}
              style={{ flex: 1 }}
              styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
              disabled={server?.status !== 'running'}
            />
            <ActionIcon
              size="lg"
              variant="filled"
              color="green"
              onClick={handleSend}
              disabled={server?.status !== 'running' || !command.trim()}
            >
              <IconSend size={18} />
            </ActionIcon>
          </Group>
        </Box>
      </Paper>
    </Stack>
  )
}
