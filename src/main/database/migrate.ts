import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'
import { mkdirSync } from 'fs'
import log from 'electron-log'

/**
 * Run migrations on app startup.
 * We use a simple approach: execute CREATE TABLE IF NOT EXISTS statements
 * since Drizzle Kit migrations can be complex in a packaged Electron app.
 */
export function runMigrations(): void {
  const userDataPath = app.getPath('userData')
  const dbDir = join(userDataPath, 'data')
  mkdirSync(dbDir, { recursive: true })

  const dbPath = join(dbDir, 'minecraft-server-manager.db')
  const sqlite = new Database(dbPath)

  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')

  log.info(`[DB] Running migrations on: ${dbPath}`)

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS servers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      absolute_path TEXT NOT NULL UNIQUE,
      minecraft_version TEXT NOT NULL,
      mod_loader TEXT,
      mod_loader_version TEXT,
      java_path TEXT,
      port INTEGER NOT NULL DEFAULT 25565,
      min_ram TEXT NOT NULL DEFAULT '1G',
      max_ram TEXT NOT NULL DEFAULT '2G',
      auto_start INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS installed_mods (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      source TEXT NOT NULL,
      source_project_id TEXT,
      source_file_id TEXT,
      name TEXT NOT NULL,
      file_name TEXT NOT NULL,
      version TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      installed_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `)

  sqlite.close()
  log.info('[DB] Migrations completed successfully')
}
