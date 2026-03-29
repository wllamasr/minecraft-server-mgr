import { Paper, Box, TextInput, ActionIcon, Group, Text, ScrollArea, Switch, Checkbox, Badge } from '@mantine/core'
import { IconSearch, IconSend } from '@tabler/icons-react'
import { useTranslation } from 'react-i18next'
import { useState, useEffect, useRef, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { ServerLogEntry, ServerWithStatus } from '@shared/types'

interface ServerConsoleProps {
  serverId: string;
}

export function ServerConsole({ serverId }: ServerConsoleProps) {
  const { t } = useTranslation(['console', 'common'])
  const [command, setCommand] = useState('')
  const [logs, setLogs] = useState<ServerLogEntry[]>([])
  const [autoScroll, setAutoScroll] = useState(true)
  // Filters
  const [filterInfo, setFilterInfo] = useState(true)
  const [filterWarn, setFilterWarn] = useState(true)
  const [filterError, setFilterError] = useState(true)
  const [filterDebug, setFilterDebug] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')

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

  const filteredLogs = useMemo(() => {
    return logs.filter((log) => {
      // Level Filter
      if (log.level === 'INFO' && !filterInfo) return false
      if (log.level === 'WARN' && !filterWarn) return false
      if (log.level === 'ERROR' && !filterError) return false
      if (log.level === 'DEBUG' && !filterDebug) return false

      // Search Query Filter
      if (searchQuery && !log.line.toLowerCase().includes(searchQuery.toLowerCase())) {
        return false
      }

      return true
    })
  }, [logs, filterInfo, filterWarn, filterError, filterDebug, searchQuery])

  // Auto-scroll
  useEffect(() => {
    if (autoScroll && viewportRef.current) {
      viewportRef.current.scrollTop = viewportRef.current.scrollHeight
    }
  }, [filteredLogs, autoScroll])

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
      <Box p="xs" style={{ borderBottom: '1px solid var(--mantine-color-dark-5)', backgroundColor: 'var(--mantine-color-dark-8)' }}>
        <Group justify="space-between" align="center">
          <Text size="sm" fw={600} ml="xs">Console Output</Text>
          <Group gap="sm">
            <TextInput
              placeholder="Search logs..."
              size="xs"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.currentTarget.value)}
              leftSection={<IconSearch size={14} />}
              w={150}
            />
            <Group gap="xs">
              <Checkbox size="xs" label="INFO" checked={filterInfo} onChange={(e) => setFilterInfo(e.currentTarget.checked)} color="blue" />
              <Checkbox size="xs" label="WARN" checked={filterWarn} onChange={(e) => setFilterWarn(e.currentTarget.checked)} color="yellow" />
              <Checkbox size="xs" label="ERROR" checked={filterError} onChange={(e) => setFilterError(e.currentTarget.checked)} color="red" />
              <Checkbox size="xs" label="DEBUG" checked={filterDebug} onChange={(e) => setFilterDebug(e.currentTarget.checked)} color="gray" />
            </Group>
            <Switch
              label="Auto-Scroll"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.currentTarget.checked)}
              size="xs"
            />
          </Group>
        </Group>
      </Box>

      <ScrollArea
        style={{ flex: 1, minHeight: 400, maxHeight: 600 }}
        viewportRef={viewportRef}
        scrollbarSize={8}
      >
        <Box p="md" className="console-output" ref={scrollRef}>
          {filteredLogs.length === 0 ? (
             <Text c="dimmed" size="sm">
               {logs.length > 0 ? 'No logs match filters' : t('console:noLogs')}
             </Text>
          ) : (
            filteredLogs.map((entry, i) => {
              let color = 'var(--mantine-color-text)'
              if (entry.level === 'ERROR') color = 'var(--mantine-color-red-5)'
              else if (entry.level === 'WARN') color = 'var(--mantine-color-yellow-5)'
              else if (entry.level === 'DEBUG') color = 'var(--mantine-color-dimmed)'

              return (
                <div key={`${entry.timestamp}-${i}`} style={{ display: 'flex', gap: '8px', alignItems: 'baseline' }}>
                  <Text
                    component="span"
                    size="xs"
                    c="dimmed"
                    style={{ fontFamily: 'var(--mantine-font-family-monospace)', flexShrink: 0 }}
                  >
                    {new Date(entry.timestamp).toLocaleTimeString()}
                  </Text>
                  
                  {entry.level && (
                    <Badge 
                      color={entry.level === 'ERROR' ? 'red' : entry.level === 'WARN' ? 'yellow' : entry.level === 'DEBUG' ? 'gray' : 'blue'}
                      variant="light"
                      size="xs"
                      style={{ flexShrink: 0, width: 60 }}
                    >
                      {entry.level}
                    </Badge>
                  )}

                  <Text
                    component="span"
                    size="sm"
                    style={{ fontFamily: 'var(--mantine-font-family-monospace)', color, wordBreak: 'break-all' }}
                  >
                    {entry.line}
                  </Text>
                </div>
              )
            })
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
  )
}
