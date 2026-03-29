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
import { attachConsole, detachConsole, sendCommand as consoleSendCommand } from './console-manager'
import log from '../utils/logger'
import { IPC_EVENTS } from '../../shared/constants'
import { DEFAULTS } from '../../shared/constants'
import type { ServerInstance, ServerWithStatus, ServerStatus, CreateServerInput } from '../../shared/types'

// ─── In-memory process tracking ────────────────────────────
interface RunningServer {
  process: ChildProcess
  status: ServerStatus
}

const runningServers = new Map<string, RunningServer>()

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

export async function createServer(input: CreateServerInput): Promise<ServerInstance> {
  const db = getDatabase()
  const id = uuid()
  const serverDir = getServerDir(input.name)

  if (existsSync(serverDir)) {
    throw new Error(`Server directory already exists: ${serverDir}`)
  }

  mkdirSync(serverDir, { recursive: true })

  log.info(`[ServerManager] Creating server "${input.name}" at ${serverDir}`)

  // Download the vanilla server jar
  const serverJarPath = join(serverDir, 'server.jar')
  await downloadVanillaServer(input.minecraftVersion, serverJarPath)

  // Generate server.properties
  const properties = generateDefaultProperties(input)
  writeFileSync(join(serverDir, 'server.properties'), properties)

  // Accept EULA
  writeFileSync(join(serverDir, 'eula.txt'), 'eula=true\n')

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
  log.info(`[ServerManager] Server "${input.name}" created with ID ${id}`)

  return server as ServerInstance
}

export function startServer(serverId: string): void {
  if (runningServers.has(serverId)) {
    throw new Error('Server is already running')
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

  log.info(`[ServerManager] Starting server "${server.name}" with Java: ${javaPath}`)

  const args = [
    `-Xms${server.minRam}`,
    `-Xmx${server.maxRam}`,
    '-jar',
    'server.jar',
    'nogui'
  ]

  const childProcess = spawn(javaPath, args, {
    cwd: serverDir,
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
  })

  childProcess.on('exit', (code) => {
    log.info(`[ServerManager] Server "${server.name}" exited with code ${code}`)
    runningServers.delete(serverId)
    detachConsole(serverId)
    broadcastStatus(serverId, code === 0 ? 'stopped' : 'crashed')
  })

  childProcess.on('error', (err) => {
    log.error(`[ServerManager] Server "${server.name}" process error:`, err)
    runningServers.delete(serverId)
    detachConsole(serverId)
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
  return runningServers.get(serverId)?.status || 'stopped'
}

function broadcastStatus(serverId: string, status: ServerStatus): void {
  BrowserWindow.getAllWindows().forEach((win) => {
    if (!win.isDestroyed()) {
      win.webContents.send(IPC_EVENTS.SERVER_STATUS_CHANGED, { serverId, status })
    }
  })
}

async function downloadVanillaServer(mcVersion: string, destPath: string): Promise<void> {
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

  await downloadFile(serverDownload.url, destPath)
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
