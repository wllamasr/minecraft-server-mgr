import { createFileRoute } from '@tanstack/react-router'
import { Title, Stack, Paper, TextInput, Button, Group, Text, PasswordInput } from '@mantine/core'
import { IconFolder } from '@tabler/icons-react'
import { useTranslation } from 'react-i18next'
import { useState, useEffect } from 'react'
import { notifications } from '@mantine/notifications'

export const Route = createFileRoute('/settings')({
  component: SettingsPage
})

function SettingsPage() {
  const { t } = useTranslation('settings')

  const [serversDir, setServersDir] = useState('')
  const [curseforgeKey, setCurseforgeKey] = useState('')

  useEffect(() => {
    window.api.getSetting('serversDirectory').then((val) => {
      if (val) setServersDir(val)
    })
    window.api.getSetting('curseforgeApiKey').then((val) => {
      if (val) setCurseforgeKey(val)
    })
  }, [])

  const handleBrowse = async () => {
    const dir = await window.api.selectDirectory()
    if (dir) setServersDir(dir)
  }

  const handleSave = async () => {
    if (serversDir) {
      await window.api.setSetting('serversDirectory', serversDir)
    }
    if (curseforgeKey) {
      await window.api.setSetting('curseforgeApiKey', curseforgeKey)
    }
    notifications.show({
      message: t('saved'),
      color: 'green'
    })
  }

  return (
    <Stack gap="lg">
      <Title order={2}>{t('title')}</Title>

      <Paper p="lg" radius="md" withBorder style={{ borderColor: 'var(--mantine-color-dark-5)' }}>
        <Stack gap="lg">
          <Stack gap={4}>
            <TextInput
              label={t('serversDirectory')}
              description={t('serversDirectoryDesc')}
              value={serversDir}
              onChange={(e) => setServersDir(e.target.value)}
              placeholder="Leave empty for default"
              rightSection={
                <Button
                  variant="subtle"
                  size="compact-sm"
                  onClick={handleBrowse}
                  px="xs"
                >
                  <IconFolder size={16} />
                </Button>
              }
            />
          </Stack>

          <PasswordInput
            label={t('curseforgeApiKey')}
            description={t('curseforgeApiKeyDesc')}
            placeholder={t('curseforgeApiKeyPlaceholder')}
            value={curseforgeKey}
            onChange={(e) => setCurseforgeKey(e.target.value)}
          />

          <Group justify="flex-end">
            <Button
              onClick={handleSave}
              variant="gradient"
              gradient={{ from: 'green', to: 'teal', deg: 135 }}
            >
              {t('title') === 'Settings' ? 'Save' : t('title')}
            </Button>
          </Group>
        </Stack>
      </Paper>
    </Stack>
  )
}
