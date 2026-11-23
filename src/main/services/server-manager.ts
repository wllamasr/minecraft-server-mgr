import { ChildProcess, spawn } from 'child_process'
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { v4 as uuid } from 'uuid'
import { eq } from 'drizzle-orm'
import { BrowserWindow } from 'electron'
import { getDatabase, schema } from '../database/client'
import { getServerDir, getServersRootDir } from '../utils/paths'
import { downloadFile } from '../utils/download'
import { findBestJava } from './java-detector'
import { attachConsole, detachConsole, sendCommand as consoleSendCommand, pushLog } from './console-manager'
import { startTelemetry, stopTelemetry } from './telemetry-manager'
import { installModLoader } from './mod-loader-installer'
import { downloadServerSoftware } from './server-software'
import { fetchJson } from '../utils/http'
import { verifyFileChecksum } from '../utils/checksum'
import { stopProcess } from '../utils/graceful-stop'
import { busyKind, cancelAllBusy, cancelBusy } from './server-busy'
import { applyModpack } from './modpack-manager'
import log from '../utils/logger'
import { IPC_EVENTS } from '../../shared/constants'
import { DEFAULTS, MOD_LOADERS, isPluginPlatform, engineLabel } from '../../shared/constants'
import { buildJvmArgs, isJvmProfile, isValidRam, ramToMb } from '../../shared/utils/jvm'
import { isReleaseVersion } from '../../shared/utils/minecraft-version'
import { isValidBuildId } from '../../shared/utils/server-software'
import { formatProgress } from '../../shared/utils/format'
import { isValidRestartSchedule } from '../../shared/utils/restart-schedule'
import {
  BACKUP_KEEP_DEFAULT,
  BACKUP_KEEP_MAX,
  BACKUP_KEEP_MIN,
  isValidBackupKeep,
  isValidBackupSchedule,
  type ScheduledBackupResult
} from '../../shared/utils/backup-schedule'
import { isAllowedMrpackUrl, MRPACK_HOST } from '../../shared/utils/modpack'
import type {
  ServerInstance,
  ServerWithStatus,
  ServerStatus,
  CreateServerInput,
  ModSource,
  UpdateServerSettingsInput
} from '../../shared/types'

// ─── In-memory process tracking ────────────────────────────
interface RunningServer {
  process: ChildProcess
  status: ServerStatus
  /** Set while a stop is in progress, so repeated stop requests share it. */
  stopping?: Promise<void>
}

const runningServers = new Map<string, RunningServer>()

// Servers currently being provisioned (jar download, mod-loader install) or
// that failed to provision. Tracked in memory so status is reflected in the UI
// without adding a column to the schema.
const provisioningServers = new Map<string, 'provisioning' | 'error'>()

// Crash auto-restart guardrails: at most MAX_RESTARTS crashes within
// RESTART_WINDOW_MS before we give up, to avoid a tight restart loop.
const restartHistory = new Map<string, number[]>()
const MAX_RESTARTS = 3
const RESTART_WINDOW_MS = 60_000
const RESTART_DELAY_MS = 5_000
// Pending crash auto-restarts, so a stop, delete or app shutdown can cancel them.
const restartTimers = new Map<string, NodeJS.Timeout>()

// How long a server gets to save its world after `stop` before it is killed.
// A large world can take well over the 30 s this used to be.
const STOP_GRACE_OVERRIDE_MS = Number(process.env['MSM_STOP_GRACE_MS'])
const STOP_GRACE_MS = STOP_GRACE_OVERRIDE_MS >= 1000 ? STOP_GRACE_OVERRIDE_MS : 120_000

// Set once the app is quitting: nothing may be started or restarted any more.
let shuttingDown = false

// ─── Mojang version manifest ───────────────────────────────
const VERSION_MANIFEST_URL = 'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json'

interface VersionManifest {
  versions: { id: string; type: string; url: string }[]
}

interface VersionMeta {
  downloads: {
    server: { url: string; sha1: string; size: number }
  }
}

// ─── Public API ────────────────────────────────────────────

export function listServers(): ServerWithStatus[] {
  const db = getDatabase()
  const rows = db.select().from(schema.servers).all()

  return rows.map((row) => ({
    ...row,
    modLoader: row.modLoader as ServerInstance['modLoader'],
    modpackSource: row.modpackSource as ModSource | null,
    jvmProfile: isJvmProfile(row.jvmProfile) ? row.jvmProfile : 'default',
    status: getServerStatus(row.id),
    pid: runningServers.get(row.id)?.process.pid
  }))
}

export function getServer(serverId: string): ServerWithStatus | null {
  const db = getDatabase()
  const row = db.select().from(schema.servers).where(eq(schema.servers.id, serverId)).get()
  if (!row) return null

  return {
    ...row,
    modLoader: row.modLoader as ServerInstance['modLoader'],
    modpackSource: row.modpackSource as ModSource | null,
    jvmProfile: isJvmProfile(row.jvmProfile) ? row.jvmProfile : 'default',
    status: getServerStatus(row.id),
    pid: runningServers.get(row.id)?.process.pid
  }
}

export function getRunningProcess(serverId: string): ChildProcess | null {
  return runningServers.get(serverId)?.process || null
}

/**
 * Register a new server and kick off provisioning in the background.
 *
 * The database row is created immediately and the server is returned right
 * away in a `provisioning` state; the heavy work (downloading the server jar
 * and installing the mod loader) runs asynchronously and streams progress to
 * the server's console via {@link pushLog}. Callers should navigate to the
 * server and watch the console rather than awaiting completion.
 */
export function createServer(input: CreateServerInput): ServerInstance {
  validateCreateInput(input)

  const db = getDatabase()
  const id = uuid()
  const serverDir = getServerDir(input.name)

  if (existsSync(serverDir)) {
    throw new Error(`Server directory already exists: ${serverDir}`)
  }

  mkdirSync(serverDir, { recursive: true })
  log.info(`[ServerManager] Creating server "${input.name}" at ${serverDir}`)

  const now = new Date().toISOString()
  const server: typeof schema.servers.$inferInsert = {
    id,
    name: input.name,
    absolutePath: serverDir,
    minecraftVersion: input.minecraftVersion,
    modLoader: input.modLoader || null,
    modLoaderVersion: input.modLoaderVersion || null,
    javaPath: null,
    port: input.port || DEFAULTS.SERVER_PORT,
    ...resolveRam(input),
    autoStart: input.autoStart ?? false,
    createdAt: now,
    updatedAt: now,
    modpackSource: input.modpack?.source ?? null,
    modpackProjectId: input.modpack?.projectId ?? null,
    modpackVersionId: input.modpack?.versionId ?? null,
    modpackName: input.modpack?.name ?? null,
    jvmProfile: input.jvmProfile ?? 'default',
    restartSchedule: null,
    backupSchedule: null,
    backupKeep: BACKUP_KEEP_DEFAULT,
    backupLastRun: null
  }

  db.insert(schema.servers).values(server).run()

  provisioningServers.set(id, 'provisioning')
  broadcastStatus(id, 'provisioning')

  // Fire-and-forget; progress is streamed to the console and status events.
  void provisionServer(id, input, serverDir)

  return server as ServerInstance
}

/**
 * Background provisioning pipeline for a freshly created server.
 */
async function provisionServer(
  serverId: string,
  input: CreateServerInput,
  serverDir: string
): Promise<void> {
  try {
    pushLog(serverId, `Provisioning server "${input.name}"...`, 'INFO')

    // 1. Download the server jar (progress is streamed, throttled to every 10%
    //    so the console is not flooded with per-chunk updates). Plugin platforms
    //    (Paper, Purpur, Folia) ship a complete server jar that takes the place
    //    of the vanilla one; everything else starts from the vanilla jar.
    const serverJarPath = join(serverDir, 'server.jar')
    let lastLoggedStep = -1
    const logProgress = (transferred: number, total: number): void => {
      const step = total > 0 ? Math.floor((transferred / total) * 10) : lastLoggedStep + 1
      if (step > lastLoggedStep) {
        lastLoggedStep = step
        pushLog(serverId, `  server.jar  ${formatProgress(transferred, total)}`, 'INFO')
      }
    }

    const platform = !input.modpack && isPluginPlatform(input.modLoader) ? input.modLoader : null
    if (platform) {
      const build = input.modLoaderVersion as string
      pushLog(
        serverId,
        `Downloading ${engineLabel(platform)} ${input.minecraftVersion} build ${build}...`,
        'INFO'
      )
      const download = await downloadServerSoftware(platform, input.minecraftVersion, build, serverJarPath, (p) =>
        logProgress(p.transferred, p.total)
      )
      pushLog(serverId, `Verified ${download.fileName} (${download.checksum.algorithm} checksum OK).`, 'INFO')
    } else {
      pushLog(serverId, `Downloading Minecraft ${input.minecraftVersion} server jar...`, 'INFO')
      await downloadVanillaServer(input.minecraftVersion, serverJarPath, logProgress)
    }

    // 2. Generate server.properties and accept the EULA.
    pushLog(serverId, 'Writing server.properties and accepting the EULA...', 'INFO')
    writeFileSync(join(serverDir, 'server.properties'), generateDefaultProperties(input))
    writeFileSync(join(serverDir, 'eula.txt'), 'eula=true\n')

    // 3. Install the mod loader / apply the modpack.
    if (input.modpack) {
      const result = await applyModpack(serverId, serverDir, input.modpack.mrpackUrl, (line, level) =>
        pushLog(serverId, line, level ?? 'INFO')
      )
      // The pack pins the exact MC version and loader; persist them.
      getDatabase()
        .update(schema.servers)
        .set({
          minecraftVersion: result.minecraftVersion || input.minecraftVersion,
          modLoader: result.loader,
          modLoaderVersion: result.loaderVersion,
          modpackSource: input.modpack.source,
          modpackProjectId: input.modpack.projectId,
          modpackVersionId: input.modpack.versionId,
          modpackName: input.modpack.name,
          updatedAt: new Date().toISOString()
        })
        .where(eq(schema.servers.id, serverId))
        .run()
    } else if (input.modLoader && input.modLoaderVersion && !isPluginPlatform(input.modLoader)) {
      pushLog(serverId, `Installing ${input.modLoader} ${input.modLoaderVersion}...`, 'INFO')
      await installModLoader(input.modLoader, input.modLoaderVersion, input.minecraftVersion, serverDir)
    }

    provisioningServers.delete(serverId)
    pushLog(serverId, '✔ Provisioning complete — the server is ready to start.', 'INFO')
    broadcastStatus(serverId, 'stopped')
    log.info(`[ServerManager] Server "${input.name}" (${serverId}) provisioned`)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    provisioningServers.set(serverId, 'error')
    pushLog(serverId, `✖ Provisioning failed: ${message}`, 'ERROR')
    broadcastStatus(serverId, 'error')
    log.error(`[ServerManager] Provisioning failed for ${serverId}:`, err)
  }
}

export function startServer(serverId: string): void {
  if (shuttingDown) throw new Error('The app is shutting down')
  if (deleting.has(serverId)) throw new Error('Server is being deleted')
  // Starting would change the files a backup is copying, or run a world that
  // is in the middle of being replaced.
  const busy = busyKind(serverId)
  if (busy === 'restore') throw new Error('This server is being restored from a backup')
  if (busy === 'backup' && !runningServers.has(serverId)) {
    throw new Error('A backup of this server is in progress; start it when the backup has finished')
  }
  cancelAutoRestart(serverId)
  if (runningServers.has(serverId)) {
    throw new Error('Server is already running')
  }

  if (provisioningServers.get(serverId) === 'provisioning') {
    throw new Error('Server is still being provisioned')
  }

  const db = getDatabase()
  const server = db.select().from(schema.servers).where(eq(schema.servers.id, serverId)).get()
  if (!server) throw new Error(`Server not found: ${serverId}`)

  const serverDir = server.absolutePath
  // A restore that was cut off (the app was killed) leaves the previous files
  // in this folder and the server directory half replaced.
  if (existsSync(`${serverDir}.restore-aside`)) {
    throw new Error(
      `A restore of this server did not finish cleanly. The files it replaced are in ${serverDir}.restore-aside; ` +
        'move back what you need and remove that folder before starting the server.'
    )
  }
  if (!existsSync(join(serverDir, 'server.jar'))) {
    throw new Error(`server.jar not found in ${serverDir}`)
  }

  // Find Java
  let javaPath = server.javaPath || 'java'
  if (!server.javaPath) {
    const java = findBestJava(server.minecraftVersion)
    if (java) {
      javaPath = java.path
    }
  }

  // Older records can hold a minimum the JVM profile builder rejects (the wizard
  // used to store "0G" for a 1 GB server); fall back to the maximum for those.
  const minRamUsable =
    isValidRam(server.minRam) && isValidRam(server.maxRam) && ramToMb(server.minRam) <= ramToMb(server.maxRam)
  const jvmArgs = buildJvmArgs({
    minRam: minRamUsable ? server.minRam : server.maxRam,
    maxRam: server.maxRam,
    profile: isJvmProfile(server.jvmProfile) ? server.jvmProfile : 'default'
  })

  let command = javaPath
  let args = [...jvmArgs, '-jar', 'server.jar', 'nogui']

  // Specialized startup logic for mod loaders
  if (server.modLoader === 'forge' || server.modLoader === 'neoforge') {
    const isWin = process.platform === 'win32'
    const scriptName = isWin ? 'run.bat' : 'run.sh'
    const scriptPath = join(serverDir, scriptName)

    if (existsSync(scriptPath)) {
      log.info(`[ServerManager] Detected ${server.modLoader} script: ${scriptName}`)
      
      // The run script reads JVM arguments (heap + profile flags) from user_jvm_args.txt
      const jvmArgsPath = join(serverDir, 'user_jvm_args.txt')
      writeFileSync(jvmArgsPath, jvmArgs.join('\n') + '\n')
      
      if (isWin) {
        command = 'cmd.exe'
        args = ['/c', scriptName, 'nogui']
      } else {
        command = 'sh'
        args = [scriptName, 'nogui']
      }
    }
  } else if (server.modLoader === 'fabric' || server.modLoader === 'quilt') {
    const loaderJar = server.modLoader === 'fabric' ? 'fabric-server-launch.jar' : 'quilt-server-launch.jar'
    if (existsSync(join(serverDir, loaderJar))) {
      args = [...jvmArgs, '-jar', loaderJar, 'nogui']
    }
  }

  const env = { ...process.env }
  if (javaPath !== 'java') {
     const javaDir = require('path').dirname(javaPath)
     const pathKey = process.platform === 'win32' ? 'Path' : 'PATH'
     env[pathKey] = `${javaDir}${require('path').delimiter}${env[pathKey]}`
  }

  log.info(`[ServerManager] Starting server "${server.name}" with command: ${command} ${args.join(' ')}`)

  const childProcess = spawn(command, args, {
    cwd: serverDir,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    // On POSIX the server leads its own process group, so a forced stop can
    // kill the whole group (run.sh and the JVM it starts).
    detached: process.platform !== 'win32',
    windowsHide: true
  })

  const running: RunningServer = {
    process: childProcess,
    status: 'starting'
  }

  runningServers.set(serverId, running)
  attachConsole(serverId, childProcess)
  broadcastStatus(serverId, 'starting')

  childProcess.on('spawn', () => {
    running.status = 'running'
    broadcastStatus(serverId, 'running')
    startTelemetry(serverId)
  })

  childProcess.on('exit', (code) => {
    log.info(`[ServerManager] Server "${server.name}" exited with code ${code}`)
    const wasStopping = running.status === 'stopping'
    runningServers.delete(serverId)
    detachConsole(serverId)
    stopTelemetry(serverId)

    // A stop we asked for is never a crash, even when the server had to be
    // killed or exits with a non-zero code on its way out.
    const crashed = code !== 0 && !wasStopping
    broadcastStatus(serverId, crashed ? 'crashed' : 'stopped')

    // Auto-restart on crash (not on an intentional stop) when enabled.
    if (crashed && !shuttingDown && server.autoStart) {
      scheduleAutoRestart(serverId, server.name)
    } else {
      restartHistory.delete(serverId)
    }
  })

  childProcess.on('error', (err) => {
    log.error(`[ServerManager] Server "${server.name}" process error:`, err)
    runningServers.delete(serverId)
    detachConsole(serverId)
    stopTelemetry(serverId)
    broadcastStatus(serverId, 'crashed')
  })
}

/**
 * Stop a server: ask it to shut down, give it time to save, and only kill it
 * (with everything it started) when it does not exit on its own. Resolves once
 * the process is gone, so the world is safe to start again or delete.
 */
export function stopServer(serverId: string): Promise<void> {
  cancelAutoRestart(serverId)

  const running = runningServers.get(serverId)
  if (!running) {
    return Promise.reject(new Error('Server is not running'))
  }
  if (running.stopping) return running.stopping

  running.status = 'stopping'
  broadcastStatus(serverId, 'stopping')

  // A backup pauses world saving while it copies. Stopping wins: the backup
  // is cancelled and has turned saving back on before the server is told to
  // stop.
  const backupCancelled = busyKind(serverId) === 'backup' ? cancelBusy(serverId, 'the server is stopping') : Promise.resolve()

  running.stopping = backupCancelled.then(() => stopProcess(running.process, {
    requestStop: () => {
      consoleSendCommand(serverId, 'stop')
    },
    timeoutMs: STOP_GRACE_MS,
    onForce: () => {
      log.warn(`[ServerManager] Server ${serverId} did not stop within ${STOP_GRACE_MS / 1000}s — killing it`)
      pushLog(
        serverId,
        `Server did not stop within ${STOP_GRACE_MS / 1000}s — killing the process. Recent changes may not have been saved.`,
        'WARN'
      )
    }
  })).then(() => {
    const child = running.process
    if (child.exitCode === null && child.signalCode === null && runningServers.get(serverId) === running) {
      // Even the kill had no effect. Allow another stop attempt later.
      log.error(`[ServerManager] Server ${serverId} could not be killed`)
      running.stopping = undefined
    }
  })

  return running.stopping
}

// Servers that are being deleted: they must not be started again by a restart
// that was already in flight.
const deleting = new Set<string>()

// Restarts in flight, so a second request for the same server joins the first.
const restarting = new Map<string, Promise<void>>()

/**
 * Restart a server: stop it, wait until its process is gone, start it again.
 * A server that is not running is simply started.
 */
export function restartServer(serverId: string): Promise<void> {
  const inFlight = restarting.get(serverId)
  if (inFlight) return inFlight

  const run = (async (): Promise<void> => {
    if (runningServers.has(serverId)) {
      pushLog(serverId, 'Restarting server...', 'INFO')
      await stopServer(serverId)
    }
    // The server may have been deleted, or the app may be quitting, meanwhile:
    // startServer then throws and the caller reports it.
    startServer(serverId)
  })().finally(() => {
    restarting.delete(serverId)
  })

  restarting.set(serverId, run)
  return run
}

/** Change the settings of an existing server. Only the given fields change. */
export function updateServerSettings(serverId: string, input: UpdateServerSettingsInput): ServerWithStatus {
  if (!input || typeof input !== 'object') throw new Error('Invalid settings')

  const changes: {
    restartSchedule?: string | null
    backupSchedule?: string | null
    backupKeep?: number
    updatedAt: string
  } = { updatedAt: new Date().toISOString() }
  if (input.restartSchedule !== undefined) {
    if (input.restartSchedule !== null && !isValidRestartSchedule(input.restartSchedule)) {
      throw new Error('Restart time must be HH:MM in 24-hour format, for example 04:30')
    }
    changes.restartSchedule = input.restartSchedule
  }
  if (input.backupSchedule !== undefined) {
    if (input.backupSchedule !== null && !isValidBackupSchedule(input.backupSchedule)) {
      throw new Error('Backup time must be HH:MM in 24-hour format, for example 04:30')
    }
    changes.backupSchedule = input.backupSchedule
  }
  if (input.backupKeep !== undefined) {
    if (!isValidBackupKeep(input.backupKeep)) {
      throw new Error(`The number of backups to keep must be a whole number from ${BACKUP_KEEP_MIN} to ${BACKUP_KEEP_MAX}`)
    }
    changes.backupKeep = input.backupKeep
  }

  const db = getDatabase()
  const result = db.update(schema.servers).set(changes).where(eq(schema.servers.id, serverId)).run()
  if (result.changes === 0) throw new Error(`Server not found: ${serverId}`)
  return getServer(serverId) as ServerWithStatus
}

/** Remember how the last scheduled backup of a server went. */
export function recordScheduledBackup(serverId: string, result: ScheduledBackupResult): void {
  getDatabase()
    .update(schema.servers)
    .set({ backupLastRun: JSON.stringify(result) })
    .where(eq(schema.servers.id, serverId))
    .run()
}

/** True once the app has begun quitting. */
/** True while a server is in the middle of being deleted. */
export function isBeingDeleted(serverId: string): boolean {
  return deleting.has(serverId)
}

export function isShuttingDown(): boolean {
  return shuttingDown
}

/** How many server processes are alive. */
export function runningServerCount(): number {
  return runningServers.size
}

/**
 * Stop every running server and refuse to start new ones. Called when the app
 * quits, so no server is left running without a console to control it.
 */
export async function stopAllServers(): Promise<void> {
  shuttingDown = true
  for (const serverId of [...restartTimers.keys()]) cancelAutoRestart(serverId)

  await cancelAllBusy('the app is closing')

  const ids = [...runningServers.keys()]
  if (ids.length === 0) return
  log.info(`[ServerManager] Stopping ${ids.length} running server(s) before quitting`)
  await Promise.allSettled(ids.map((id) => stopServer(id)))
}

export async function deleteServer(serverId: string): Promise<void> {
  deleting.add(serverId)
  try {
    await removeServer(serverId)
  } finally {
    deleting.delete(serverId)
  }
}

async function removeServer(serverId: string): Promise<void> {
  // A backup in flight is cancelled; a restore that is already replacing
  // files is waited for.
  await cancelBusy(serverId, 'the server is being deleted')
  cancelAutoRestart(serverId)
  restartHistory.delete(serverId)

  // Stop if running
  if (runningServers.has(serverId)) {
    await stopServer(serverId)
  }

  provisioningServers.delete(serverId)

  const db = getDatabase()
  const server = db.select().from(schema.servers).where(eq(schema.servers.id, serverId)).get()
  if (!server) throw new Error(`Server not found: ${serverId}`)

  // Remove from database
  db.delete(schema.servers).where(eq(schema.servers.id, serverId)).run()

  // Remove server directory
  const { rmSync } = require('fs')
  // ...and what a restore may have left beside it.
  for (const dir of [server.absolutePath, `${server.absolutePath}.restore-stage`, `${server.absolutePath}.restore-aside`]) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch (err) {
      log.warn(`[ServerManager] Could not delete directory: ${dir}`, err)
    }
  }

  log.info(`[ServerManager] Deleted server "${server.name}"`)
}

// ─── Internal helpers ──────────────────────────────────────

function getServerStatus(serverId: string): ServerStatus {
  const running = runningServers.get(serverId)
  if (running) return running.status

  const provisioning = provisioningServers.get(serverId)
  if (provisioning) return provisioning

  return 'stopped'
}

function cancelAutoRestart(serverId: string): void {
  const timer = restartTimers.get(serverId)
  if (!timer) return
  clearTimeout(timer)
  restartTimers.delete(serverId)
}

function scheduleAutoRestart(serverId: string, name: string): void {
  const now = Date.now()
  const recent = (restartHistory.get(serverId) || []).filter((t) => now - t < RESTART_WINDOW_MS)

  if (recent.length >= MAX_RESTARTS) {
    pushLog(
      serverId,
      `Auto-restart aborted: "${name}" crashed ${MAX_RESTARTS} times within a minute.`,
      'ERROR'
    )
    restartHistory.delete(serverId)
    return
  }

  recent.push(now)
  restartHistory.set(serverId, recent)

  pushLog(serverId, `Server crashed — auto-restarting in ${RESTART_DELAY_MS / 1000}s...`, 'WARN')

  cancelAutoRestart(serverId)
  const timer = setTimeout(() => {
    const start = (): void => {
      // Stopped or deleted while waiting: cancelAutoRestart removed the entry.
      if (restartTimers.get(serverId) !== timer) return
      restartTimers.delete(serverId)
      if (shuttingDown || runningServers.has(serverId)) return
      try {
        startServer(serverId)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        pushLog(serverId, `Auto-restart failed: ${message}`, 'ERROR')
      }
    }
    // A backup of the files would make the start fail (and one that was
    // running when the server crashed is of no use): getting the server back
    // comes first. A restore is the user's own doing and is left alone. The
    // entry stays in restartTimers meanwhile, so a stop or a delete during
    // the wait still cancels this restart.
    if (busyKind(serverId) === 'backup') {
      void cancelBusy(serverId, 'the server is restarting after a crash')
        .catch(() => undefined)
        .then(start)
    } else {
      start()
    }
  }, RESTART_DELAY_MS)
  restartTimers.set(serverId, timer)
}

/** True while a crashed server is waiting to be started again automatically. */
export function isAutoRestartPending(serverId: string): boolean {
  return restartTimers.has(serverId)
}

function broadcastStatus(serverId: string, status: ServerStatus): void {
  BrowserWindow.getAllWindows().forEach((win) => {
    if (!win.isDestroyed()) {
      win.webContents.send(IPC_EVENTS.SERVER_STATUS_CHANGED, { serverId, status })
    }
  })
}

async function downloadVanillaServer(
  mcVersion: string,
  destPath: string,
  onProgress?: (transferred: number, total: number) => void
): Promise<void> {
  log.info(`[ServerManager] Downloading vanilla server jar for MC ${mcVersion}`)

  // Fetch version manifest
  const manifestJson = await fetchJson(VERSION_MANIFEST_URL)
  const manifest = manifestJson as VersionManifest

  const versionEntry = manifest.versions.find((v) => v.id === mcVersion)
  if (!versionEntry) {
    throw new Error(`Minecraft version ${mcVersion} not found in manifest`)
  }

  // Fetch version metadata
  const versionMeta = (await fetchJson(versionEntry.url)) as VersionMeta
  const serverDownload = versionMeta.downloads?.server
  if (!serverDownload) {
    throw new Error(`No server download available for MC ${mcVersion}`)
  }

  await downloadFile(serverDownload.url, destPath, (p) => onProgress?.(p.transferred, p.total))
  // Mojang publishes a SHA-1 for the jar; refuse a corrupted or tampered download.
  if (serverDownload.sha1) {
    await verifyFileChecksum(destPath, 'sha1', serverDownload.sha1)
  }
}

/** Heap bounds for a new server; a single given bound pulls the other default along. */
function resolveRam(input: CreateServerInput): { minRam: string; maxRam: string } {
  let minRam = input.minRam || DEFAULTS.MIN_RAM
  let maxRam = input.maxRam || DEFAULTS.MAX_RAM
  if (ramToMb(minRam) > ramToMb(maxRam)) {
    if (input.minRam) maxRam = minRam
    else minRam = maxRam
  }
  return { minRam, maxRam }
}

/**
 * Reject malformed creation input before anything touches the disk. These
 * values end up in process arguments and download URLs, so they are checked
 * here rather than trusted from the renderer.
 */
function validateCreateInput(input: CreateServerInput): void {
  if (!input || typeof input.name !== 'string' || !input.name.trim()) {
    throw new Error('A server name is required')
  }
  if (typeof input.minecraftVersion !== 'string' || !input.minecraftVersion.trim()) {
    throw new Error('A Minecraft version is required')
  }
  if (input.minRam !== undefined && !isValidRam(input.minRam)) {
    throw new Error(`Invalid minimum memory: ${String(input.minRam)}`)
  }
  if (input.maxRam !== undefined && !isValidRam(input.maxRam)) {
    throw new Error(`Invalid maximum memory: ${String(input.maxRam)}`)
  }
  // Throws when the minimum exceeds the maximum.
  if (input.minRam && input.maxRam) buildJvmArgs({ minRam: input.minRam, maxRam: input.maxRam })

  if (input.jvmProfile !== undefined && !isJvmProfile(input.jvmProfile)) {
    throw new Error(`Unknown JVM profile: ${String(input.jvmProfile)}`)
  }
  if (input.modLoader !== undefined && !MOD_LOADERS.some((l) => l.value === input.modLoader)) {
    throw new Error(`Unknown server software: ${String(input.modLoader)}`)
  }
  // Loader versions are interpolated into download URLs and installer arguments.
  if (input.modLoaderVersion !== undefined && !/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/.test(String(input.modLoaderVersion))) {
    throw new Error(`Invalid engine version: ${String(input.modLoaderVersion)}`)
  }
  // The .mrpack URL is downloaded as given, so it must be a Modrinth one.
  if (input.modpack && !isAllowedMrpackUrl(input.modpack.mrpackUrl)) {
    throw new Error(`Modpacks can only be downloaded from https://${MRPACK_HOST}`)
  }
  if (!input.modpack && isPluginPlatform(input.modLoader)) {
    if (!isReleaseVersion(input.minecraftVersion)) {
      throw new Error(`Invalid Minecraft version: ${input.minecraftVersion}`)
    }
    if (!isValidBuildId(input.modLoaderVersion)) {
      throw new Error(`Select a ${engineLabel(input.modLoader)} build before creating the server`)
    }
  }
}

function generateDefaultProperties(input: CreateServerInput): string {
  const port = input.port || DEFAULTS.SERVER_PORT
  const motd = (input.motd || 'A Minecraft Server managed by MSM').replace(/[\r\n]+/g, ' ').trim()
  return [
    '#Minecraft server properties',
    `#Generated by Minecraft Server Manager`,
    `server-port=${port}`,
    `motd=${motd}`,
    `max-players=20`,
    `level-name=world`,
    `gamemode=survival`,
    `difficulty=easy`,
    `online-mode=true`,
    `white-list=false`,
    `pvp=true`,
    `enable-command-block=false`,
    `spawn-protection=16`,
    `view-distance=10`,
    `simulation-distance=10`,
    // Disable Minecraft's own Server Watchdog: our manager already supervises the
    // process and auto-restarts on real crashes, so the watchdog is redundant and
    // causes false "java.lang.Error: Watchdog" kills on slow/virtualized hosts
    // during world generation.
    `max-tick-time=-1`,
    ``
  ].join('\n')
}
