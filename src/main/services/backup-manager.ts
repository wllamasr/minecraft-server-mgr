import { app, BrowserWindow } from 'electron'
import { existsSync } from 'fs'
import { mkdir, readdir, rm, stat, statfs } from 'fs/promises'
import { dirname, join } from 'path'
import { eq } from 'drizzle-orm'
import { getDatabase } from '../database/client'
import { installedMods } from '../database/schema'
import { getServer, isBeingDeleted, isShuttingDown } from './server-manager'
import { onLogLine, pushLog, sendCommand } from './console-manager'
import { beginBusy, busyKind } from './server-busy'
import {
  BackupAbortedError,
  extractArchive,
  planBackup,
  readArchiveComment,
  planChangedSince,
  restorableManifest,
  RestoreLeftoverError,
  type BackupPlan,
  swapIntoServerDir,
  writeArchive,
  type ArchiveProgress
} from '../utils/backup-archive'
import { isSaveFinishedLine, saveOffAnswer } from '../../shared/utils/save-lines'
import { formatBytes } from '../../shared/utils/format'
import { scheduledBackupsToPrune } from '../../shared/utils/backup-schedule'
import { IPC_EVENTS, isPluginPlatform } from '../../shared/constants'
import type { BackupInfo, BackupKind, BackupProgress, RestoreBackupOptions } from '../../shared/types'
import log from '../utils/logger'

/**
 * Backups of local servers.
 *
 * A backup is a zip of the server directory (minus what the server software
 * regenerates, see backup-archive.ts) kept outside that directory, under the
 * app's data folder: `backups/<server id>/<id>.zip`. There is no table of
 * backups; the folder is the list, and each archive carries its own manifest.
 */

const SAVE_OFF_TIMEOUT_MS = 15_000
const SAVE_ALL_TIMEOUT_MS = 180_000
/** Room that must be left on the backup volume beyond the size of the backup. */
const FREE_SPACE_MARGIN = 64 * 1024 * 1024

const ID_PATTERN = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-(manual|pre-restore|scheduled)$/
const SERVER_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/

/**
 * JSON with every non-ASCII character escaped. The manifest goes into the zip
 * comment, which the zip format encodes as CP437: a server called "Мой сервер"
 * could not be written there as it is.
 */
function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(/[^\x20-\x7e]/g, (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'))
}

function backupsRoot(): string {
  return join(app.getPath('userData'), 'backups')
}

function backupDir(serverId: string): string {
  // The id becomes a folder name; it comes from the renderer.
  if (!SERVER_ID_PATTERN.test(serverId)) throw new Error('Invalid server id')
  return join(backupsRoot(), serverId)
}

function backupPath(serverId: string, backupId: string): string {
  // Same for the backup id: only the names this module generates are accepted.
  if (typeof backupId !== 'string' || !ID_PATTERN.test(backupId)) throw new Error('Invalid backup id')
  return join(backupDir(serverId), `${backupId}.zip`)
}

function newBackupId(now: Date, kind: BackupKind): string {
  const p = (n: number, width = 2): string => String(n).padStart(width, '0')
  // UTC, so ids sort by time whatever happens to the clock's zone.
  return (
    `${p(now.getUTCFullYear(), 4)}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}-` +
    `${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}-${kind}`
  )
}

function idToDate(id: string): Date | null {
  const m = ID_PATTERN.exec(id)
  if (!m) return null
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]))
}

interface Manifest {
  format: 1
  serverId: string
  serverName: string
  minecraftVersion: string
  modLoader: string | null
  createdAt: string
  kind: BackupKind
  whileRunning: boolean
  fileCount: number
  totalBytes: number
}

function sendProgress(progress: BackupProgress): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC_EVENTS.BACKUP_PROGRESS, progress)
  }
}

/** Report progress a few times a second at most. */
function throttledProgress(base: Omit<BackupProgress, 'doneBytes' | 'totalBytes'>): (p: ArchiveProgress) => void {
  let last = 0
  return (p) => {
    const now = Date.now()
    if (now - last < 200 && p.doneBytes < p.totalBytes) return
    last = now
    sendProgress({ ...base, ...p })
  }
}

function waitForLine<T>(
  serverId: string,
  match: (line: string) => T | null | false,
  timeoutMs: number,
  signal: AbortSignal,
  what: string
): Promise<T> {
  return new Promise((resolve, reject) => {
    const finish = (run: () => void): void => {
      clearTimeout(timer)
      unsubscribe()
      signal.removeEventListener('abort', onAbort)
      run()
    }
    const unsubscribe = onLogLine(serverId, (line) => {
      const result = match(line)
      if (result) finish(() => resolve(result))
    })
    const timer = setTimeout(() => finish(() => reject(new Error(what))), timeoutMs)
    const onAbort = (): void => finish(() => reject(new BackupAbortedError(String(signal.reason ?? ''))))
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Bring a running server to a state its files can be copied in: automatic
 * saving off, everything written to disk. Returns the function that turns
 * saving back on (if it was on before).
 *
 * Without this the copy would catch region files halfway through a write.
 * If the server does not confirm, the backup fails rather than produce an
 * archive nobody can vouch for.
 */
async function pauseSaving(serverId: string, signal: AbortSignal): Promise<() => void> {
  if (signal.aborted) throw new BackupAbortedError(String(signal.reason ?? ''))
  // Listen before sending, so the answer cannot slip by.
  const answered = waitForLine(
    serverId,
    saveOffAnswer,
    SAVE_OFF_TIMEOUT_MS,
    signal,
    'The server did not answer the save-off command. If it is still starting, try again once it is up.'
  )
  if (!sendCommand(serverId, 'save-off')) {
    answered.catch(() => undefined)
    throw new Error('Could not send commands to the server')
  }
  let wasOn: boolean
  try {
    wasOn = (await answered) === 'disabled'
  } catch (err) {
    // The command was sent, so the server may still act on it later (it reads
    // its input only once it has started). Never leave saving off behind an
    // answer nobody saw: turn it back on.
    sendCommand(serverId, 'save-on')
    throw err
  }
  const resume = (): void => {
    // Leave saving off if an admin had turned it off on purpose.
    if (wasOn) sendCommand(serverId, 'save-on')
  }

  try {
    const saved = waitForLine(
      serverId,
      (line) => isSaveFinishedLine(line),
      SAVE_ALL_TIMEOUT_MS,
      signal,
      `The server did not finish saving within ${SAVE_ALL_TIMEOUT_MS / 1000} seconds`
    )
    sendCommand(serverId, 'save-all flush')
    await saved
  } catch (err) {
    resume()
    throw err
  }
  return resume
}

async function ensureFreeSpace(dir: string, needed: number): Promise<void> {
  let free: number
  try {
    const info = await statfs(dir)
    free = Number(info.bavail) * Number(info.bsize)
  } catch {
    return // Cannot tell on this file system; the write itself will fail if it must.
  }
  if (free < needed + FREE_SPACE_MARGIN) {
    throw new Error(
      `Not enough free disk space: this needs about ${formatBytes(needed)} and only ${formatBytes(free)} is free`
    )
  }
}

async function readManifest(zipPath: string): Promise<Partial<Manifest>> {
  const manifest = JSON.parse(await readArchiveComment(zipPath)) as Partial<Manifest> | null
  if (!manifest || typeof manifest !== 'object') throw new Error('no manifest')
  return manifest
}

async function describe(serverId: string, id: string, zipPath: string): Promise<BackupInfo> {
  const info = await stat(zipPath)
  const kind = ID_PATTERN.exec(id)?.[7] as BackupKind
  const backup: BackupInfo = {
    id,
    serverId,
    kind,
    createdAt: (idToDate(id) ?? info.mtime).toISOString(),
    sizeBytes: info.size
  }
  try {
    const manifest = await readManifest(zipPath)
    if (typeof manifest.fileCount === 'number') backup.fileCount = manifest.fileCount
    if (typeof manifest.minecraftVersion === 'string') backup.minecraftVersion = manifest.minecraftVersion
    if (typeof manifest.whileRunning === 'boolean') backup.whileRunning = manifest.whileRunning
  } catch {
    // Listed all the same; a restore will say what is wrong with it.
  }
  return backup
}

/** The backups of a server, newest first. */
export async function listBackups(serverId: string): Promise<BackupInfo[]> {
  const dir = backupDir(serverId)
  if (!existsSync(dir)) return []
  const backups: BackupInfo[] = []
  for (const name of await readdir(dir)) {
    if (!name.endsWith('.zip')) continue
    const id = name.slice(0, -4)
    if (!ID_PATTERN.test(id)) continue
    try {
      backups.push(await describe(serverId, id, join(dir, name)))
    } catch (err) {
      log.warn(`[Backup] Could not read ${name}:`, err)
    }
  }
  return backups.sort((a, b) => b.id.localeCompare(a.id))
}

/** Remove archives a crash or a kill left half-written. */
async function sweepPartials(dir: string): Promise<void> {
  if (!existsSync(dir)) return
  for (const name of await readdir(dir)) {
    if (name.endsWith('.zip.part')) await rm(join(dir, name), { force: true }).catch(() => undefined)
  }
}

function refuseWhileGoingAway(serverId: string): void {
  if (isShuttingDown()) throw new Error('The app is closing')
  if (isBeingDeleted(serverId)) throw new Error('Server is being deleted')
}

interface ScheduledOptions {
  /** Keep this many scheduled backups; older ones go once the new one is made. */
  keep: number
}

/** When the newest scheduled backup was made, and how many files it holds. */
async function newestScheduled(serverId: string): Promise<{ at: Date | null; fileCount: number | undefined }> {
  const dir = backupDir(serverId)
  const ids = existsSync(dir)
    ? (await readdir(dir))
        .filter((name) => name.endsWith('.zip'))
        .map((name) => name.slice(0, -4))
        .filter((id) => ID_PATTERN.exec(id)?.[7] === 'scheduled')
        .sort((a, b) => b.localeCompare(a))
    : []
  if (ids.length === 0) return { at: null, fileCount: undefined }
  let fileCount: number | undefined
  try {
    const manifest = await readManifest(backupPath(serverId, ids[0]))
    if (typeof manifest.fileCount === 'number') fileCount = manifest.fileCount
  } catch {
    // Unreadable: nothing to compare with, so a new backup is made.
  }
  return { at: idToDate(ids[0]), fileCount }
}

/** Delete the scheduled backups beyond the number to keep. Never fails the backup. */
async function pruneScheduled(serverId: string, keep: number, justCreated: string): Promise<void> {
  try {
    const dir = backupDir(serverId)
    const ids = (await readdir(dir)).filter((name) => name.endsWith('.zip')).map((name) => name.slice(0, -4))
    const doomed = scheduledBackupsToPrune(ids, keep, justCreated)
    for (const id of doomed) await rm(backupPath(serverId, id), { force: true })
    if (doomed.length) {
      pushLog(serverId, `Deleted ${doomed.length} old scheduled backup${doomed.length === 1 ? '' : 's'} (keeping the last ${keep}).`, 'INFO')
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.warn(`[Backup] Could not delete old scheduled backups of ${serverId}: ${message}`)
    pushLog(serverId, `Old scheduled backups could not be deleted: ${message}`, 'WARN')
  }
}

/**
 * Make a backup. Resolves to null only for a scheduled backup of a stopped
 * server whose files have not changed since its last scheduled backup.
 */
async function runBackup(
  serverId: string,
  kind: BackupKind,
  signal: AbortSignal,
  scheduled?: ScheduledOptions
): Promise<BackupInfo | null> {
  refuseWhileGoingAway(serverId)
  const server = getServer(serverId)
  if (!server) throw new Error('Server not found')
  if (server.status !== 'running' && server.status !== 'stopped' && server.status !== 'crashed') {
    throw new Error(`The server is ${server.status}; wait until it is running or stopped`)
  }
  const whileRunning = server.status === 'running'
  const dir = backupDir(serverId)
  await mkdir(dir, { recursive: true })
  await sweepPartials(dir)

  // A stopped server that nothing touched would get the same backup every
  // day, and those copies would push the useful ones out of what is kept.
  let plan: BackupPlan | undefined
  if (scheduled && !whileRunning) {
    plan = await planBackup(server.absolutePath, signal)
    const last = await newestScheduled(serverId)
    if (!planChangedSince(plan, last.at, last.fileCount)) {
      pushLog(serverId, 'Scheduled backup skipped: nothing has changed since the last one.', 'INFO')
      return null
    }
  }

  const started = Date.now()
  pushLog(serverId, whileRunning ? 'Backup started — pausing world saving for a consistent copy...' : 'Backup started...', 'INFO')

  let resumeSaving: (() => void) | undefined
  try {
    if (whileRunning) {
      sendProgress({ serverId, operation: 'backup', phase: 'saving', doneBytes: 0, totalBytes: 0 })
      resumeSaving = await pauseSaving(serverId, signal)
    }

    plan ??= await planBackup(server.absolutePath, signal)
    await ensureFreeSpace(dir, plan.totalBytes)

    let id = newBackupId(new Date(), kind)
    // Two backups within one second (a manual one, then a restore).
    while (existsSync(backupPath(serverId, id))) {
      await new Promise((r) => setTimeout(r, 1000))
      id = newBackupId(new Date(), kind)
    }
    const manifest: Manifest = {
      format: 1,
      serverId,
      serverName: server.name,
      minecraftVersion: server.minecraftVersion,
      modLoader: server.modLoader ?? null,
      createdAt: (idToDate(id) as Date).toISOString(),
      kind,
      whileRunning,
      fileCount: plan.files.length,
      totalBytes: plan.totalBytes
    }
    const zipPath = backupPath(serverId, id)
    await writeArchive(plan, zipPath, {
      signal,
      comment: asciiJson(manifest),
      onProgress: throttledProgress({ serverId, operation: 'backup', phase: 'copying' })
    })

    const info = await describe(serverId, id, zipPath)
    const seconds = Math.max(1, Math.round((Date.now() - started) / 1000))
    pushLog(
      serverId,
      `Backup finished: ${plan.files.length} file(s), ${formatBytes(info.sizeBytes)}, in ${seconds}s.` +
        (plan.skipped.length ? ` ${plan.skipped.length} entr${plan.skipped.length === 1 ? 'y was' : 'ies were'} skipped (links or unreadable files).` : ''),
      plan.skipped.length ? 'WARN' : 'INFO'
    )
    if (plan.skipped.length) log.warn(`[Backup] Skipped in ${serverId}: ${plan.skipped.slice(0, 20).join(', ')}`)
    // Only now that the new backup is whole do old ones go.
    if (scheduled) await pruneScheduled(serverId, scheduled.keep, id)
    return info
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    pushLog(serverId, err instanceof BackupAbortedError ? `Backup cancelled (${message}).` : `Backup failed: ${message}`, 'WARN')
    throw err
  } finally {
    resumeSaving?.()
  }
}

/**
 * Back a server up. Works on a stopped server and on a running one (saving is
 * paused for the duration). One backup or restore per server at a time.
 */
export async function createBackup(serverId: string): Promise<BackupInfo> {
  return (await startBackup(serverId, 'manual')) as BackupInfo
}

/**
 * The backup of the daily schedule. Old scheduled backups beyond `keep` are
 * deleted once the new one is complete. Resolves to null when a stopped
 * server has not changed since its last scheduled backup (nothing is made).
 */
export function createScheduledBackup(serverId: string, keep: number): Promise<BackupInfo | null> {
  return startBackup(serverId, 'scheduled', { keep })
}

async function startBackup(serverId: string, kind: BackupKind, scheduled?: ScheduledOptions): Promise<BackupInfo | null> {
  const controller = new AbortController()
  let done: Promise<unknown> = Promise.resolve()
  const end = beginBusy(serverId, {
    kind: 'backup',
    cancel: async (reason) => {
      controller.abort(reason)
      await done.catch(() => undefined)
    }
  })
  const run = runBackup(serverId, kind, controller.signal, scheduled).finally(() => {
    end()
    // Tells every window the operation is over, whoever started it.
    sendProgress({ serverId, operation: 'backup', phase: 'done', doneBytes: 0, totalBytes: 0 })
  })
  done = run
  return run
}

export async function deleteBackup(serverId: string, backupId: string): Promise<void> {
  const zipPath = backupPath(serverId, backupId)
  if (!existsSync(zipPath)) throw new Error('Backup not found')
  // Not while one of them may be the archive a restore is reading.
  if (busyKind(serverId)) throw new Error('Wait until the backup or restore in progress has finished')
  await rm(zipPath, { force: true })
}

/** Remove every backup of a server (the server is being deleted). */
export async function deleteAllBackups(serverId: string): Promise<void> {
  await rm(backupDir(serverId), { recursive: true, force: true, maxRetries: 3 })
}

/**
 * After a restore the add-on folder is the one from the backup, while the
 * list of installed mods lives in the database. Bring the list in line: drop
 * what is no longer on disk and fix the enabled flag of what is.
 */
function reconcileInstalledMods(serverId: string, serverDir: string, modLoader: string | null): void {
  const db = getDatabase()
  const addonDir = join(serverDir, isPluginPlatform(modLoader ?? undefined) ? 'plugins' : 'mods')
  for (const mod of db.select().from(installedMods).where(eq(installedMods.serverId, serverId)).all()) {
    if (existsSync(join(addonDir, mod.fileName))) {
      if (!mod.enabled) db.update(installedMods).set({ enabled: true }).where(eq(installedMods.id, mod.id)).run()
    } else if (existsSync(join(addonDir, `${mod.fileName}.disabled`))) {
      if (mod.enabled) db.update(installedMods).set({ enabled: false }).where(eq(installedMods.id, mod.id)).run()
    } else {
      db.delete(installedMods).where(eq(installedMods.id, mod.id)).run()
    }
  }
}

async function runRestore(
  serverId: string,
  backupId: string,
  options: RestoreBackupOptions,
  signal: AbortSignal,
  enterPointOfNoReturn: () => void
): Promise<void> {
  const zipPath = backupPath(serverId, backupId)
  refuseWhileGoingAway(serverId)
  const server = getServer(serverId)
  if (!server) throw new Error('Server not found')
  if (server.status !== 'stopped' && server.status !== 'crashed') {
    throw new Error('Stop the server before restoring a backup')
  }
  if (!existsSync(zipPath)) throw new Error('Backup not found')

  const serverDir = server.absolutePath
  const stageDir = `${serverDir}.restore-stage`
  const asideDir = `${serverDir}.restore-aside`
  if (existsSync(asideDir)) {
    // The only copy of the previous files may be in there.
    throw new Error(
      `An earlier restore of this server did not finish cleanly. The files it replaced are in ${asideDir}; move back what you need and remove that folder, then try again.`
    )
  }

  // An archive without the manifest this app writes, or with no files, is not
  // a backup: restoring it would only empty the server.
  let comment: string
  try {
    comment = await readArchiveComment(zipPath)
  } catch {
    throw new Error('This file is damaged or is not a backup made by this app')
  }
  const manifest = restorableManifest(comment)

  pushLog(serverId, `Restoring backup ${backupId}...`, 'INFO')
  let replacing = false
  try {
    if (options.backupFirst !== false) {
      await runBackup(serverId, 'pre-restore', signal)
    }

    await rm(stageDir, { recursive: true, force: true })
    await mkdir(stageDir, { recursive: true })
    await ensureFreeSpace(dirname(serverDir), manifest.totalBytes)
    const fileCount = await extractArchive(zipPath, stageDir, {
      signal,
      onProgress: throttledProgress({ serverId, operation: 'restore', phase: 'copying' })
    })

    if (fileCount !== manifest.fileCount) {
      throw new Error(`This backup is damaged: it holds ${fileCount} file(s) instead of ${manifest.fileCount}`)
    }

    // From here on the server's files are being moved: it runs to the end.
    enterPointOfNoReturn()
    replacing = true
    sendProgress({ serverId, operation: 'restore', phase: 'replacing', doneBytes: 0, totalBytes: 0 })
    let leftover: RestoreLeftoverError | undefined
    try {
      await swapIntoServerDir(serverDir, stageDir, asideDir)
    } catch (err) {
      // The backup is in place; only the replaced files could not be removed.
      if (!(err instanceof RestoreLeftoverError)) throw err
      leftover = err
    }
    pushLog(serverId, `Backup ${backupId} restored: ${fileCount} file(s).`, 'INFO')
    try {
      reconcileInstalledMods(serverId, serverDir, server.modLoader ?? null)
    } catch (err) {
      // The files are restored; only the list in the Mods tab may be off.
      log.warn(`[Backup] Could not bring the mod list of ${serverId} in line after the restore:`, err)
    }
    if (leftover) throw leftover
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    pushLog(
      serverId,
      // Once files were being moved, the error itself says where things stand.
      err instanceof RestoreLeftoverError
        ? message
        : replacing
          ? `Restore failed: ${message}`
          : `Restore failed, the server files were not touched: ${message}`,
      err instanceof RestoreLeftoverError ? 'WARN' : 'ERROR'
    )
    throw err
  } finally {
    await rm(stageDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined)
  }
}

/**
 * Replace a stopped server's files with those of a backup. The files backups
 * do not cover (logs, libraries) stay. Nothing is deleted before the backup
 * has been unpacked completely, and a failure puts everything back.
 */
export async function restoreBackup(serverId: string, backupId: string, options: RestoreBackupOptions = {}): Promise<void> {
  const controller = new AbortController()
  let committed = false
  let done: Promise<unknown> = Promise.resolve()
  const end = beginBusy(serverId, {
    kind: 'restore',
    cancel: async (reason) => {
      if (!committed) controller.abort(reason)
      await done.catch(() => undefined)
    }
  })
  const run = runRestore(serverId, backupId, options ?? {}, controller.signal, () => (committed = true)).finally(() => {
    end()
    sendProgress({ serverId, operation: 'restore', phase: 'done', doneBytes: 0, totalBytes: 0 })
  })
  done = run
  return run
}
