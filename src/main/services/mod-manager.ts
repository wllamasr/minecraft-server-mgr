import { join } from 'path'
import { existsSync, renameSync, unlinkSync } from 'fs'
import { v4 as uuidv4 } from 'uuid'
import { getDatabase } from '../database/client'
import { installedMods } from '../database/schema'
import { getServer } from './server-manager'
import { downloadFile } from '../utils/download'
import * as modrinth from './modrinth'
import * as curseforge from './curseforge'
import { eq, and } from 'drizzle-orm'
import type { ModSearchOptions, ModSearchResponse, UnifiedMod, UnifiedModVersion, ModSource } from '../../shared/types'
import log from '../utils/logger'

// ─── API Proxies ───────────────────────────────────────────

export async function searchMods(options: ModSearchOptions): Promise<ModSearchResponse> {
  if (options.source === 'modrinth') {
    return modrinth.searchMods(options)
  } else {
    return curseforge.searchMods(options)
  }
}

export async function getMod(source: ModSource, id: string): Promise<UnifiedMod & { descriptionHtml: string }> {
  if (source === 'modrinth') {
    return modrinth.getMod(id)
  } else {
    return curseforge.getMod(id)
  }
}

export async function getModVersions(
  source: ModSource,
  id: string,
  gameVersion?: string,
  loader?: string
): Promise<UnifiedModVersion[]> {
  if (source === 'modrinth') {
    return modrinth.getModVersions(id, gameVersion, loader)
  } else {
    return curseforge.getModVersions(id, gameVersion, loader)
  }
}

// ─── Installation & Management ─────────────────────────────

export async function getInstalledMods(serverId: string) {
  const db = getDatabase()
  return db.select().from(installedMods).where(eq(installedMods.serverId, serverId)).all()
}

export async function installMod(
  serverId: string,
  source: ModSource,
  projectId: string,
  versionId: string
): Promise<void> {
  const db = getDatabase()
  const server = getServer(serverId)
  if (!server) throw new Error('Server not found')

  log.info(`[ModManager] Installing ${source} mod ${projectId} (version ${versionId}) to server ${server.name}`)

  const versions = await getModVersions(source, projectId)
  const version = versions.find((v) => v.id === versionId)
  if (!version) throw new Error('Version not found on remote')

  if (!version.downloadUrl) {
    throw new Error('Download URL is not available for this file.')
  }

  const modDetails = await getMod(source, projectId)

  // Ensure mods directory exists
  const modsDir = join(server.absolutePath, 'mods')
  if (!existsSync(modsDir)) {
    const { mkdirSync } = require('fs')
    mkdirSync(modsDir, { recursive: true })
  }

  const destPath = join(modsDir, version.fileName)

  // Download the file
  await downloadFile(version.downloadUrl, destPath)

  // Save to database
  const insertData = {
    id: uuidv4(),
    serverId,
    source,
    sourceProjectId: projectId,
    sourceFileId: versionId,
    name: modDetails.name,
    fileName: version.fileName,
    version: version.versionNumber,
    enabled: true,
    installedAt: new Date().toISOString()
  }

  db.insert(installedMods).values(insertData).run()
  log.info(`[ModManager] Installed mod ${insertData.name} successfully.`)
}

export async function uninstallMod(serverId: string, modDbId: string): Promise<void> {
  const db = getDatabase()
  const server = getServer(serverId)
  if (!server) throw new Error('Server not found')

  const mod = db.select().from(installedMods).where(eq(installedMods.id, modDbId)).get()
  if (!mod) throw new Error('Mod not found in database')

  log.info(`[ModManager] Uninstalling mod ${mod.name} from server ${serverId}`)

  // Try to remove from filesystem
  const actualFileName = mod.enabled ? mod.fileName : `${mod.fileName}.disabled`
  const targetPath = join(server.absolutePath, 'mods', actualFileName)

  if (existsSync(targetPath)) {
    try {
      unlinkSync(targetPath)
    } catch (err: any) {
      log.error(`[ModManager] Failed to delete file ${targetPath}:`, err)
      throw new Error(`Failed to delete file: ${err.message}`)
    }
  }

  // Remove from DB
  db.delete(installedMods).where(eq(installedMods.id, modDbId)).run()
}

export async function toggleMod(serverId: string, modDbId: string, enable: boolean): Promise<void> {
  const db = getDatabase()
  const server = getServer(serverId)
  if (!server) throw new Error('Server not found')

  const mod = db.select().from(installedMods).where(eq(installedMods.id, modDbId)).get()
  if (!mod) throw new Error('Mod not found in database')

  if (mod.enabled === enable) return // No change needed

  const modsDir = join(server.absolutePath, 'mods')
  
  const fromName = mod.enabled ? mod.fileName : `${mod.fileName}.disabled`
  const toName = enable ? mod.fileName : `${mod.fileName}.disabled`

  const fromPath = join(modsDir, fromName)
  const toPath = join(modsDir, toName)

  if (existsSync(fromPath)) {
    try {
      renameSync(fromPath, toPath)
    } catch (err: any) {
      log.error(`[ModManager] Failed to rename ${fromPath} to ${toPath}:`, err)
      throw new Error(`Failed to rename file: ${err.message}`)
    }
  } else {
    log.warn(`[ModManager] File ${fromPath} not found on disk, updating DB anyway.`)
  }

  db.update(installedMods)
    .set({ enabled: enable })
    .where(eq(installedMods.id, modDbId))
    .run()
    
  log.info(`[ModManager] Toggled mod ${mod.name} to ${enable ? 'enabled' : 'disabled'}`)
}
