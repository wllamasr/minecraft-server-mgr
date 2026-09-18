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
import log from '../utils/logger'
import { IPC_EVENTS } from '../../shared/constants'
import { DEFAULTS } from '../../shared/constants'
import { formatProgress } from '../../shared/utils/format'
import type { ServerInstance, ServerWithStatus, ServerStatus, CreateServerInput } from '../../shared/types'

// ─── In-memory process tracking ────────────────────────────
interface RunningServer {
  process: ChildProcess
  status: ServerStatus
}

const runningServers = new Map<string, RunningServer>()

// Servers currently being provisioned (jar download, mod-loader install) or
// that failed to provision. Tracked in memory so status is reflected in the UI
// without adding a column to the schema.
const provisioningServers = new Map<string, 'provisioning' | 'error'>()

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
    minRam: input.minRam || DEFAULTS.MIN_RAM,
    maxRam: input.maxRam || DEFAULTS.MAX_RAM,
    autoStart: false,
    createdAt: now,
    updatedAt: now
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

    // 1. Download the vanilla server jar (progress is streamed, throttled to
    //    every 10% so the console is not flooded with per-chunk updates).
    pushLog(serverId, `Downloading Minecraft ${input.minecraftVersion} server jar...`, 'INFO')
    const serverJarPath = join(serverDir, 'server.jar')
    let lastLoggedStep = -1
    await downloadVanillaServer(input.minecraftVersion, serverJarPath, (transferred, total) => {
      const step = total > 0 ? Math.floor((transferred / total) * 10) : lastLoggedStep + 1
      if (step > lastLoggedStep) {
        lastLoggedStep = step
        pushLog(serverId, `  server.jar  ${formatProgress(transferred, total)}`, 'INFO')
      }
    })

    // 2. Generate server.properties and accept the EULA.
    pushLog(serverId, 'Writing server.properties and accepting the EULA...', 'INFO')
    writeFileSync(join(serverDir, 'server.properties'), generateDefaultProperties(input))
    writeFileSync(join(serverDir, 'eula.txt'), 'eula=true\n')

    // 3. Install the mod loader, if any.
    if (input.modLoader && input.modLoaderVersion) {
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

  let command = javaPath
  let args = [
    `-Xms${server.minRam}`,
    `-Xmx${server.maxRam}`,
    '-jar',
    'server.jar',
    'nogui'
  ]

  // Specialized startup logic for mod loaders
  if (server.modLoader === 'forge' || server.modLoader === 'neoforge') {
    const isWin = process.platform === 'win32'
    const scriptName = isWin ? 'run.bat' : 'run.sh'
    const scriptPath = join(serverDir, scriptName)

    if (existsSync(scriptPath)) {
      log.info(`[ServerManager] Detected ${server.modLoader} script: ${scriptName}`)
      
      // Update user_jvm_args.txt for RAM
      const jvmArgsPath = join(serverDir, 'user_jvm_args.txt')
      const ramArgs = `-Xms${server.minRam}\n-Xmx${server.maxRam}\n`
      writeFileSync(jvmArgsPath, ramArgs)
      
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
      args = [
        `-Xms${server.minRam}`, 
        `-Xmx${server.maxRam}`, 
        '-jar', 
        loaderJar, 
        'nogui'
      ]
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
    stdio: ['pipe', 'pipe', 'pipe']
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
    runningServers.delete(serverId)
    detachConsole(serverId)
    stopTelemetry(serverId)
    broadcastStatus(serverId, code === 0 ? 'stopped' : 'crashed')
  })

  childProcess.on('error', (err) => {
    log.error(`[ServerManager] Server "${server.name}" process error:`, err)
    runningServers.delete(serverId)
    detachConsole(serverId)
    stopTelemetry(serverId)
    broadcastStatus(serverId, 'crashed')
  })
}

export async function stopServer(serverId: string): Promise<void> {
  const running = runningServers.get(serverId)
  if (!running) {
    throw new Error('Server is not running')
  }

  broadcastStatus(serverId, 'stopping')
  running.status = 'stopping'

  // Send graceful stop command
  consoleSendCommand(serverId, 'stop')

  // Wait up to 30 seconds, then force kill
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      log.warn(`[ServerManager] Force killing server ${serverId}`)
      running.process.kill('SIGKILL')
      resolve()
    }, 30000)

    running.process.on('exit', () => {
      clearTimeout(timeout)
      resolve()
    })
  })
}

export async function deleteServer(serverId: string): Promise<void> {
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
  try {
    rmSync(server.absolutePath, { recursive: true, force: true })
  } catch (err) {
    log.warn(`[ServerManager] Could not delete directory: ${server.absolutePath}`, err)
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
}

function fetchJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const https = require('https')
    https.get(url, (res: any) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`))
        return
      }
      let data = ''
      res.on('data', (chunk: string) => (data += chunk))
      res.on('end', () => {
        try {
          resolve(JSON.parse(data))
        } catch (e) {
          reject(e)
        }
      })
    }).on('error', reject)
  })
}

function generateDefaultProperties(input: CreateServerInput): string {
  const port = input.port || DEFAULTS.SERVER_PORT
  return [
    '#Minecraft server properties',
    `#Generated by Minecraft Server Manager`,
    `server-port=${port}`,
    `motd=A Minecraft Server managed by MSM`,
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
    ``
  ].join('\n')
}
