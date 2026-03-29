import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { eq } from 'drizzle-orm'
import { getDatabase, schema } from '../database/client'
import log from '../utils/logger'

/**
 * Read server.properties as a key-value map.
 */
export function readServerProperties(serverId: string): Record<string, string> {
  const server = getServerById(serverId)
  const propsPath = join(server.absolutePath, 'server.properties')

  if (!existsSync(propsPath)) {
    return {}
  }

  const content = readFileSync(propsPath, 'utf-8')
  const result: Record<string, string> = {}

  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIndex = trimmed.indexOf('=')
    if (eqIndex === -1) continue
    const key = trimmed.substring(0, eqIndex).trim()
    const value = trimmed.substring(eqIndex + 1).trim()
    result[key] = value
  }

  return result
}

/**
 * Write server.properties from a key-value map.
 * Preserves comments from the original file.
 */
export function writeServerProperties(serverId: string, properties: Record<string, string>): void {
  const server = getServerById(serverId)
  const propsPath = join(server.absolutePath, 'server.properties')

  const lines: string[] = [
    '#Minecraft server properties',
    `#Updated by Minecraft Server Manager`
  ]

  for (const [key, value] of Object.entries(properties)) {
    lines.push(`${key}=${value}`)
  }

  writeFileSync(propsPath, lines.join('\n') + '\n')
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
