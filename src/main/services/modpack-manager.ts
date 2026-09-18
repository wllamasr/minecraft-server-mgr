import { join, dirname, resolve as resolvePath } from 'path'
import { mkdirSync, writeFileSync, unlinkSync } from 'fs'
import AdmZip from 'adm-zip'
import { v4 as uuidv4 } from 'uuid'
import { getDatabase } from '../database/client'
import { installedMods } from '../database/schema'
import { downloadFile } from '../utils/download'
import { installModLoader } from './mod-loader-installer'
import {
  resolveModpackLoader,
  isUnsafeModpackPath,
  type MrpackDependencies
} from '../../shared/utils/modpack'
import { formatProgress } from '../../shared/utils/format'
import log from '../utils/logger'
import type { ModLoaderType } from '../../shared/types'

// ─── .mrpack index shape ───────────────────────────────────
interface MrpackFile {
  path: string
  downloads: string[]
  fileSize?: number
  env?: { client?: string; server?: string }
}

interface MrpackIndex {
  formatVersion: number
  name: string
  versionId: string
  dependencies: MrpackDependencies
  files: MrpackFile[]
}

export interface ApplyModpackResult {
  minecraftVersion: string
  loader: ModLoaderType | null
  loaderVersion: string | null
  modCount: number
}

type Emit = (line: string, level?: 'INFO' | 'WARN' | 'ERROR') => void

/**
 * Download and apply a Modrinth `.mrpack` into an already-created server
 * directory: install the exact loader the pack requires, download every
 * server-relevant file, and lay down the pack's config overrides.
 *
 * Returns the resolved Minecraft version and loader so the caller can update
 * the server record (a fresh server may have been created with placeholder
 * version/loader values before the pack was inspected).
 */
export async function applyModpack(
  serverId: string,
  serverDir: string,
  mrpackUrl: string,
  emit: Emit
): Promise<ApplyModpackResult> {
  const mrpackPath = join(serverDir, 'modpack.mrpack')

  emit('Downloading modpack index (.mrpack)...')
  let lastStep = -1
  await downloadFile(mrpackUrl, mrpackPath, (p) => {
    const step = p.total > 0 ? Math.floor((p.transferred / p.total) * 5) : lastStep + 1
    if (step > lastStep) {
      lastStep = step
      emit(`  modpack.mrpack  ${formatProgress(p.transferred, p.total)}`)
    }
  })

  const zip = new AdmZip(mrpackPath)
  const indexEntry = zip.getEntry('modrinth.index.json')
  if (!indexEntry) {
    throw new Error('Invalid .mrpack: modrinth.index.json not found')
  }
  const index = JSON.parse(zip.readAsText(indexEntry)) as MrpackIndex

  const resolved = resolveModpackLoader(index.dependencies || {})
  if (!resolved.minecraftVersion) {
    throw new Error('Modpack does not declare a Minecraft version')
  }

  // Install the loader at the exact version the pack pins.
  if (resolved.loader && resolved.loaderVersion) {
    emit(`Installing ${resolved.loader} ${resolved.loaderVersion} for MC ${resolved.minecraftVersion}...`)
    await installModLoader(resolved.loader, resolved.loaderVersion, resolved.minecraftVersion, serverDir)
  }

  // Download every file the server needs (skip client-only files).
  const files = (index.files || []).filter((f) => f.env?.server !== 'unsupported')
  emit(`Downloading ${files.length} modpack file(s)...`)

  const db = getDatabase()
  const serverRoot = resolvePath(serverDir)
  let modCount = 0

  for (let i = 0; i < files.length; i++) {
    const file = files[i]

    if (isUnsafeModpackPath(file.path)) {
      emit(`Skipping unsafe path in modpack: ${file.path}`, 'WARN')
      continue
    }
    if (!file.downloads?.length) {
      emit(`No download URL for ${file.path}, skipping`, 'WARN')
      continue
    }

    const dest = join(serverDir, file.path)
    if (!resolvePath(dest).startsWith(serverRoot)) {
      emit(`Skipping path escaping server directory: ${file.path}`, 'WARN')
      continue
    }

    mkdirSync(dirname(dest), { recursive: true })
    emit(`  [${i + 1}/${files.length}] ${file.path}`)
    await downloadFile(file.downloads[0], dest)

    if (file.path.startsWith('mods/')) {
      const fileName = file.path.replace(/^mods\//, '')
      db.insert(installedMods)
        .values({
          id: uuidv4(),
          serverId,
          source: 'modpack',
          sourceProjectId: null,
          sourceFileId: null,
          name: fileName,
          fileName,
          version: null,
          enabled: true,
          installedAt: new Date().toISOString()
        })
        .run()
      modCount++
    }
  }

  // Lay down config overrides bundled in the pack.
  applyOverrides(zip, 'overrides', serverDir, serverRoot, emit)
  applyOverrides(zip, 'server-overrides', serverDir, serverRoot, emit)

  try {
    unlinkSync(mrpackPath)
  } catch {
    /* best-effort cleanup */
  }

  emit(
    `Modpack applied: ${modCount} mod(s), MC ${resolved.minecraftVersion}` +
      (resolved.loader ? ` + ${resolved.loader} ${resolved.loaderVersion}` : '') +
      '.'
  )
  log.info(`[ModpackManager] Applied modpack to ${serverId} (${modCount} mods)`)

  return { ...resolved, modCount }
}

/** Extract an overrides folder from the zip into the server directory. */
function applyOverrides(
  zip: AdmZip,
  prefix: string,
  serverDir: string,
  serverRoot: string,
  emit: Emit
): void {
  const entries = zip
    .getEntries()
    .filter((e) => !e.isDirectory && e.entryName.startsWith(`${prefix}/`))

  if (entries.length === 0) return
  emit(`Applying ${entries.length} file(s) from ${prefix}/...`)

  for (const entry of entries) {
    const rel = entry.entryName.slice(prefix.length + 1)
    if (isUnsafeModpackPath(rel)) continue

    const dest = join(serverDir, rel)
    if (!resolvePath(dest).startsWith(serverRoot)) continue

    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, entry.getData())
  }
}
