import { app } from 'electron'
import { join } from 'path'
import { mkdirSync } from 'fs'
import { getDatabase, schema } from '../database/client'
import { eq } from 'drizzle-orm'
import { DEFAULTS } from '../../shared/constants'

/**
 * Get the default servers root directory.
 * Can be overridden by the user via app settings.
 */
export function getServersRootDir(): string {
  const db = getDatabase()
  const setting = db
    .select()
    .from(schema.appSettings)
    .where(eq(schema.appSettings.key, 'serversDirectory'))
    .get()

  if (setting) {
    return setting.value
  }

  const defaultDir = join(app.getPath('userData'), DEFAULTS.SERVERS_DIR_NAME)
  mkdirSync(defaultDir, { recursive: true })
  return defaultDir
}

/**
 * Get the full path for a specific server
 */
export function getServerDir(serverName: string): string {
  const root = getServersRootDir()
  const safeName = serverName.replace(/[^a-zA-Z0-9_-]/g, '_')
  return join(root, safeName)
}
