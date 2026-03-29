import { execSync, spawn } from 'child_process'
import { existsSync, mkdirSync, readdirSync } from 'fs'
import { join } from 'path'
import { downloadFile } from '../utils/download'
import { findBestJava } from './java-detector'
import log from '../utils/logger'
import type { ModLoaderType } from '../../shared/types/server.types'

// ─── API URLs ──────────────────────────────────────────────
const FABRIC_META = 'https://meta.fabricmc.net/v2'
const FABRIC_INSTALLER_URL = 'https://meta.fabricmc.net/v2/versions/installer'
const FORGE_PROMOTIONS_URL = 'https://files.minecraftforge.net/maven/net/minecraftforge/forge/promotions_slim.json'
const FORGE_MAVEN_BASE = 'https://maven.minecraftforge.net/net/minecraftforge/forge'
const NEOFORGE_MAVEN_BASE = 'https://maven.neoforged.net/releases/net/neoforged/neoforge'
const QUILT_META = 'https://meta.quiltmc.org/v3'

// ─── Types ─────────────────────────────────────────────────
export interface LoaderVersion {
  version: string
  stable: boolean
}

// ─── Fetch Available Versions ──────────────────────────────

/**
 * Fetch available mod loader versions for a given MC version.
 */
export async function getLoaderVersions(
  loader: ModLoaderType,
  mcVersion: string
): Promise<LoaderVersion[]> {
  switch (loader) {
    case 'fabric':
      return getFabricLoaderVersions()
    case 'quilt':
      return getQuiltLoaderVersions()
    case 'forge':
      return getForgeVersions(mcVersion)
    case 'neoforge':
      return getNeoForgeVersions(mcVersion)
    default:
      return []
  }
}

async function getFabricLoaderVersions(): Promise<LoaderVersion[]> {
  const data = await fetchJson(`${FABRIC_META}/versions/loader`) as any[]
  return data.slice(0, 20).map((v) => ({
    version: v.version,
    stable: v.stable
  }))
}

async function getQuiltLoaderVersions(): Promise<LoaderVersion[]> {
  const data = await fetchJson(`${QUILT_META}/versions/loader`) as any[]
  return data.slice(0, 20).map((v) => ({
    version: v.version,
    stable: false // Quilt doesn't distinguish stable/unstable in their API
  }))
}

async function getForgeVersions(mcVersion: string): Promise<LoaderVersion[]> {
  const data = await fetchJson(FORGE_PROMOTIONS_URL) as { promos: Record<string, string> }
  const versions: LoaderVersion[] = []

  const latestKey = `${mcVersion}-latest`
  const recommendedKey = `${mcVersion}-recommended`

  if (data.promos[recommendedKey]) {
    versions.push({ version: data.promos[recommendedKey], stable: true })
  }
  if (data.promos[latestKey] && data.promos[latestKey] !== data.promos[recommendedKey]) {
    versions.push({ version: data.promos[latestKey], stable: false })
  }

  return versions
}

async function getNeoForgeVersions(mcVersion: string): Promise<LoaderVersion[]> {
  // NeoForge versions follow the pattern: mcMinor.mcPatch.neoVersion
  // e.g., for MC 1.21.4 -> NeoForge 21.4.x
  try {
    const parts = mcVersion.split('.')
    const neoPrefix = `${parts[1]}.${parts[2] || '0'}`

    // Fetch the maven metadata to find available versions
    const metadataUrl = `${NEOFORGE_MAVEN_BASE}/maven-metadata.xml`
    const xml = await fetchText(metadataUrl)

    // Simple XML parsing for version extraction
    const versionRegex = /<version>([^<]+)<\/version>/g
    const allVersions: string[] = []
    let match: RegExpExecArray | null
    while ((match = versionRegex.exec(xml)) !== null) {
      allVersions.push(match[1])
    }

    // Filter to versions matching this MC version
    const matching = allVersions
      .filter((v) => v.startsWith(neoPrefix))
      .reverse()
      .slice(0, 10)

    return matching.map((v, i) => ({
      version: v,
      stable: i === 0 // Latest is considered stable
    }))
  } catch (err) {
    log.error('[ModLoader] Failed to fetch NeoForge versions:', err)
    return []
  }
}

// ─── Install Mod Loader ────────────────────────────────────

/**
 * Install a mod loader into an existing server directory.
 */
export async function installModLoader(
  loader: ModLoaderType,
  loaderVersion: string,
  mcVersion: string,
  serverDir: string
): Promise<void> {
  log.info(`[ModLoader] Installing ${loader} ${loaderVersion} for MC ${mcVersion} in ${serverDir}`)

  switch (loader) {
    case 'fabric':
      return installFabric(loaderVersion, mcVersion, serverDir)
    case 'quilt':
      return installQuilt(loaderVersion, mcVersion, serverDir)
    case 'forge':
      return installForge(loaderVersion, mcVersion, serverDir)
    case 'neoforge':
      return installNeoForge(loaderVersion, serverDir)
    default:
      throw new Error(`Unknown mod loader: ${loader}`)
  }
}

// ─── Fabric Installer ──────────────────────────────────────

async function installFabric(loaderVersion: string, mcVersion: string, serverDir: string): Promise<void> {
  // Get latest installer version
  const installers = await fetchJson(FABRIC_INSTALLER_URL) as any[]
  const latestInstaller = installers.find((i) => i.stable) || installers[0]

  const installerUrl = latestInstaller.url ||
    `https://maven.fabricmc.net/net/fabricmc/fabric-installer/${latestInstaller.version}/fabric-installer-${latestInstaller.version}.jar`

  const installerPath = join(serverDir, 'fabric-installer.jar')
  await downloadFile(installerUrl, installerPath)

  // Run installer
  const java = findBestJava(mcVersion)
  const javaPath = java?.path || 'java'

  log.info(`[Fabric] Running installer: ${javaPath} -jar fabric-installer.jar server -mcversion ${mcVersion} -loader ${loaderVersion} -dir . -downloadMinecraft`)

  await runJar(javaPath, installerPath, [
    'server',
    '-mcversion', mcVersion,
    '-loader', loaderVersion,
    '-dir', serverDir,
    '-downloadMinecraft'
  ], serverDir)

  // Clean up installer
  try {
    require('fs').unlinkSync(installerPath)
  } catch { /* ignore */ }

  log.info('[Fabric] Installation complete')
}

// ─── Quilt Installer ───────────────────────────────────────

async function installQuilt(loaderVersion: string, mcVersion: string, serverDir: string): Promise<void> {
  // Quilt installer works similarly to Fabric
  const installerUrl = `https://quiltmc.org/api/v1/download-latest-installer/java-universal`

  const installerPath = join(serverDir, 'quilt-installer.jar')
  await downloadFile(installerUrl, installerPath)

  const java = findBestJava(mcVersion)
  const javaPath = java?.path || 'java'

  await runJar(javaPath, installerPath, [
    'install', 'server', mcVersion,
    loaderVersion,
    '--download-server',
    '--install-dir=' + serverDir
  ], serverDir)

  try {
    require('fs').unlinkSync(installerPath)
  } catch { /* ignore */ }

  log.info('[Quilt] Installation complete')
}

// ─── Forge Installer ───────────────────────────────────────

async function installForge(forgeVersion: string, mcVersion: string, serverDir: string): Promise<void> {
  const fullVersion = `${mcVersion}-${forgeVersion}`
  const installerUrl = `${FORGE_MAVEN_BASE}/${fullVersion}/forge-${fullVersion}-installer.jar`

  const installerPath = join(serverDir, 'forge-installer.jar')
  await downloadFile(installerUrl, installerPath)

  const java = findBestJava(mcVersion)
  const javaPath = java?.path || 'java'

  log.info(`[Forge] Running installer: ${javaPath} -jar forge-installer.jar --installServer`)

  await runJar(javaPath, installerPath, ['--installServer'], serverDir)

  try {
    require('fs').unlinkSync(installerPath)
  } catch { /* ignore */ }

  log.info('[Forge] Installation complete')
}

// ─── NeoForge Installer ────────────────────────────────────

async function installNeoForge(neoVersion: string, serverDir: string): Promise<void> {
  const installerUrl = `${NEOFORGE_MAVEN_BASE}/${neoVersion}/neoforge-${neoVersion}-installer.jar`

  const installerPath = join(serverDir, 'neoforge-installer.jar')
  await downloadFile(installerUrl, installerPath)

  const java = findBestJava('1.21') // NeoForge always needs Java 21+
  const javaPath = java?.path || 'java'

  log.info(`[NeoForge] Running installer: ${javaPath} -jar neoforge-installer.jar --installServer`)

  await runJar(javaPath, installerPath, ['--installServer'], serverDir)

  try {
    require('fs').unlinkSync(installerPath)
  } catch { /* ignore */ }

  log.info('[NeoForge] Installation complete')
}

// ─── Helpers ───────────────────────────────────────────────

function runJar(javaPath: string, jarPath: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(javaPath, ['-jar', jarPath, ...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let stdout = ''
    let stderr = ''

    proc.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString()
      log.debug(`[Installer] ${data.toString().trim()}`)
    })

    proc.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    proc.on('exit', (code) => {
      if (code === 0) {
        resolve()
      } else {
        log.error(`[Installer] Failed with code ${code}`)
        log.error(`[Installer] stderr: ${stderr}`)
        reject(new Error(`Installer exited with code ${code}: ${stderr.slice(0, 500)}`))
      }
    })

    proc.on('error', reject)

    // Timeout after 5 minutes
    setTimeout(() => {
      proc.kill()
      reject(new Error('Installer timed out after 5 minutes'))
    }, 300000)
  })
}

async function fetchJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const https = require('https')
    const http = require('http')
    const protocol = url.startsWith('https') ? https : http

    protocol.get(url, (res: any) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`))
        return
      }
      let data = ''
      res.on('data', (chunk: string) => (data += chunk))
      res.on('end', () => {
        try { resolve(JSON.parse(data)) }
        catch (e) { reject(e) }
      })
    }).on('error', reject)
  })
}

async function fetchText(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const https = require('https')
    const http = require('http')
    const protocol = url.startsWith('https') ? https : http

    protocol.get(url, (res: any) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`))
        return
      }
      let data = ''
      res.on('data', (chunk: string) => (data += chunk))
      res.on('end', () => resolve(data))
    }).on('error', reject)
  })
}
