import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'

// ─── Servers ────────────────────────────────────────────────
export const servers = sqliteTable('servers', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  absolutePath: text('absolute_path').notNull().unique(),
  minecraftVersion: text('minecraft_version').notNull(),
  modLoader: text('mod_loader'),
  modLoaderVersion: text('mod_loader_version'),
  javaPath: text('java_path'),
  port: integer('port').notNull().default(25565),
  minRam: text('min_ram').notNull().default('1G'),
  maxRam: text('max_ram').notNull().default('2G'),
  autoStart: integer('auto_start', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull()
})

// ─── Installed Mods ─────────────────────────────────────────
export const installedMods = sqliteTable('installed_mods', {
  id: text('id').primaryKey(),
  serverId: text('server_id')
    .notNull()
    .references(() => servers.id, { onDelete: 'cascade' }),
  source: text('source').notNull(), // 'curseforge' | 'modrinth' | 'manual'
  sourceProjectId: text('source_project_id'),
  sourceFileId: text('source_file_id'),
  name: text('name').notNull(),
  fileName: text('file_name').notNull(),
  version: text('version'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  installedAt: text('installed_at').notNull()
})

// ─── App Settings (key-value) ───────────────────────────────
export const appSettings = sqliteTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull()
})
