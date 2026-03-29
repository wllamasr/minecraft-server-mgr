import { existsSync } from 'fs'
import { join } from 'path'
import { eq } from 'drizzle-orm'
import { getDatabase, schema } from '../database/client'
import log from '../utils/logger'
import { readProperties, saveProperties } from './properties-parser'

/**
 * Read server.properties as a key-value map.
 */
export function readServerProperties(serverId: string): Record<string, string> {
  const server = getServerById(serverId)
  const propsPath = join(server.absolutePath, 'server.properties')

  if (!existsSync(propsPath)) {
    return {}
  }

  return readProperties(propsPath)
}

/**
 * Write server.properties from a key-value map.
 * Preserves comments from the original file.
 */
export function writeServerProperties(serverId: string, properties: Record<string, string>): void {
  const server = getServerById(serverId)
  const propsPath = join(server.absolutePath, 'server.properties')
  
  if (!existsSync(propsPath)) {
    // If it doesn't exist, we'll create an empty one first
    const { writeFileSync } = require('fs')
    writeFileSync(propsPath, '#Minecraft server properties\n')
  }

  saveProperties(propsPath, properties)
  log.info(`[ConfigManager] Updated server.properties for ${serverId}`)
}

/**
 * Get a setting from the app_settings table.
 */
export function getSetting(key: string): string | null {
  const db = getDatabase()
  const row = db.select().from(schema.appSettings).where(eq(schema.appSettings.key, key)).get()
  return row?.value || null
}

/**
 * Set a setting in the app_settings table.
 */
export function setSetting(key: string, value: string): void {
  const db = getDatabase()
  db.insert(schema.appSettings)
    .values({ key, value })
    .onConflictDoUpdate({ target: schema.appSettings.key, set: { value } })
    .run()
}

// ─── Helper ────────────────────────────────────────────────
function getServerById(serverId: string) {
  const db = getDatabase()
  const server = db.select().from(schema.servers).where(eq(schema.servers.id, serverId)).get()
  if (!server) throw new Error(`Server not found: ${serverId}`)
  return server
}
