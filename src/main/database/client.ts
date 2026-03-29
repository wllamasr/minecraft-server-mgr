import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { app } from 'electron'
import { join } from 'path'
import { mkdirSync } from 'fs'
import * as schema from './schema'

let db: ReturnType<typeof drizzle<typeof schema>>

export function getDatabase() {
  if (!db) {
    const userDataPath = app.getPath('userData')
    const dbDir = join(userDataPath, 'data')
    mkdirSync(dbDir, { recursive: true })

    const dbPath = join(dbDir, 'minecraft-server-manager.db')
    const sqlite = new Database(dbPath)

    // Enable WAL mode for better concurrent read performance
    sqlite.pragma('journal_mode = WAL')
    sqlite.pragma('foreign_keys = ON')

    db = drizzle(sqlite, { schema })
  }
  return db
}

export { schema }
