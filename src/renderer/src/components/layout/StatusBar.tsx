import { Group, Text, Box, Badge, Anchor } from '@mantine/core'
import { useTranslation } from 'react-i18next'
import { useEffect, useState } from 'react'
import { modals } from '@mantine/modals'
import { IconAlertTriangle } from '@tabler/icons-react'
import type { JavaInstallation } from '@shared/types'

export function StatusBar() {
  const { t } = useTranslation('common')
  const [version, setVersion] = useState('')
  const [javaInfo, setJavaInfo] = useState<JavaInstallation | null>(null)
  const [javaChecked, setJavaChecked] = useState(false)

  useEffect(() => {
    window.api.getVersion().then(setVersion)
    window.api.getJavaInstallations().then((javas) => {
      setJavaChecked(true)
      if (javas.length > 0) {
        // Pick best: prefer highest version, 64-bit
        const best = javas.sort((a, b) => b.major - a.major)[0]
        setJavaInfo(best)
      } else {
        // Show Java not found modal
        showJavaNotFoundDialog()
      }
    })
  }, [])

  return (
    <Box
      style={{
        height: 28,
        backgroundColor: 'var(--mantine-color-dark-8)',
        borderTop: '1px solid var(--mantine-color-dark-6)',
        display: 'flex',
        alignItems: 'center',
        paddingLeft: 12,
        paddingRight: 12,
        flexShrink: 0
      }}
    >
      <Group justify="space-between" style={{ width: '100%' }}>
        <Group gap="sm">
          {javaChecked && (
            javaInfo ? (
              <Badge size="xs" variant="dot" color="green">
                {t('statusBar.javaDetected', { version: String(javaInfo.major) })}
              </Badge>
            ) : (
              <Badge
                size="xs"
                variant="dot"
                color="red"
                style={{ cursor: 'pointer' }}
                onClick={showJavaNotFoundDialog}
              >
                {t('statusBar.javaNotFound')}
              </Badge>
            )
          )}
        </Group>
        <Text size="xs" c="dimmed">
          {version && t('statusBar.version', { version })}
        </Text>
      </Group>
    </Box>
  )
}

function showJavaNotFoundDialog() {
  modals.open({
    title: (
      <Group gap="xs">
        <IconAlertTriangle size={20} color="var(--mantine-color-yellow-6)" />
        <Text fw={600}>Java Not Found</Text>
      </Group>
    ),
    children: (
      <Box>
        <Text size="sm" mb="md">
          Minecraft servers require Java to run. No compatible Java installation was detected on your system.
        </Text>
        <Text size="sm" mb="md">
          Please install <strong>Java 21</strong> (recommended) from Eclipse Adoptium:
        </Text>
        <Anchor
          size="sm"
          fw={600}
          onClick={() => window.api.openExternal('https://adoptium.net/temurin/releases/?os=windows&arch=x64&package=jdk')}
          style={{ cursor: 'pointer' }}
        >
          🔗 Download Java 21 from Adoptium →
        </Anchor>
        <Text size="xs" c="dimmed" mt="md">
          After installing, restart Minecraft Server Manager to detect Java automatically.
          You can also set a custom Java path per server in Settings.
        </Text>
      </Box>
    ),
    size: 'md'
  })
}
