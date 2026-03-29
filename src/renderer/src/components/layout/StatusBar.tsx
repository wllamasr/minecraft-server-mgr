import { Group, Text, Box, Badge } from '@mantine/core'
import { useTranslation } from 'react-i18next'
import { useEffect, useState } from 'react'

export function StatusBar() {
  const { t } = useTranslation('common')
  const [version, setVersion] = useState('')
  const [javaInfo, setJavaInfo] = useState<{ version: string } | null>(null)

  useEffect(() => {
    window.api.getVersion().then(setVersion)
    window.api.getJavaInstallations().then((javas) => {
      if (javas.length > 0) {
        setJavaInfo({ version: String(javas[0].major) })
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
          {javaInfo ? (
            <Badge size="xs" variant="dot" color="green">
              {t('statusBar.javaDetected', { version: javaInfo.version })}
            </Badge>
          ) : (
            <Badge size="xs" variant="dot" color="red">
              {t('statusBar.javaNotFound')}
            </Badge>
          )}
        </Group>
        <Text size="xs" c="dimmed">
          {version && t('statusBar.version', { version })}
        </Text>
      </Group>
    </Box>
  )
}
