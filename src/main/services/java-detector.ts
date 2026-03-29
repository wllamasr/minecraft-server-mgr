import { execSync } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import log from '../utils/logger'
import type { JavaInstallation } from '../../shared/types'

const COMMON_JAVA_PATHS_WIN = [
  'C:\\Program Files\\Java',
  'C:\\Program Files\\Eclipse Adoptium',
  'C:\\Program Files\\Microsoft\\jdk-',
  'C:\\Program Files\\Zulu',
  'C:\\Program Files\\BellSoft',
  'C:\\Program Files (x86)\\Java'
]

/**
 * Parse the output of `java -version` to extract version info.
 */
function parseJavaVersion(output: string): { version: string; major: number; is64Bit: boolean } | null {
  // java version "21.0.2" or openjdk version "17.0.10"
  const versionMatch = output.match(/(?:java|openjdk)\s+version\s+"([^"]+)"/i)
  if (!versionMatch) return null

  const version = versionMatch[1]
  // Extract major: "1.8.0_xxx" → 8, "17.0.10" → 17, "21.0.2" → 21
  let major: number
  if (version.startsWith('1.')) {
    major = parseInt(version.split('.')[1], 10)
  } else {
    major = parseInt(version.split('.')[0], 10)
  }

  const is64Bit = output.includes('64-Bit')

  return { version, major, is64Bit }
}

/**
 * Try to get Java installation info from a specific java executable path.
 */
function probeJava(javaPath: string): JavaInstallation | null {
  try {
    const output = execSync(`"${javaPath}" -version 2>&1`, {
      encoding: 'utf-8',
      timeout: 5000
    })

    const parsed = parseJavaVersion(output)
    if (!parsed) return null

    return {
      path: javaPath,
      ...parsed
    }
  } catch {
    return null
  }
}

/**
 * Scan the system for Java installations.
 */
export function detectJavaInstallations(): JavaInstallation[] {
  const found: JavaInstallation[] = []
  const seenPaths = new Set<string>()

  const addIfNew = (installation: JavaInstallation | null) => {
    if (installation && !seenPaths.has(installation.path.toLowerCase())) {
      seenPaths.add(installation.path.toLowerCase())
      found.push(installation)
    }
  }

  // 1. Check JAVA_HOME
  const javaHome = process.env.JAVA_HOME
  if (javaHome) {
    const javaExe = join(javaHome, 'bin', 'java.exe')
    if (existsSync(javaExe)) {
      addIfNew(probeJava(javaExe))
    }
  }

  // 2. Check PATH (system java)
  addIfNew(probeJava('java'))

  // 3. Scan common installation directories on Windows
  for (const basePath of COMMON_JAVA_PATHS_WIN) {
    try {
      if (!existsSync(basePath)) continue
      const { readdirSync } = require('fs')
      const entries = readdirSync(basePath, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const javaExe = join(basePath, entry.name, 'bin', 'java.exe')
          if (existsSync(javaExe)) {
            addIfNew(probeJava(javaExe))
          }
        }
      }
    } catch {
      // Skip inaccessible directories
    }
  }

  log.info(`[JavaDetector] Found ${found.length} Java installation(s)`)
  for (const j of found) {
    log.info(`  - Java ${j.major} (${j.version}) at ${j.path}`)
  }

  return found
}

/**
 * Get the minimum Java major version required for a given Minecraft version.
 */
export function getRequiredJavaMajor(mcVersion: string): number {
  const parts = mcVersion.split('.').map(Number)
  const minor = parts[1] || 0

  if (minor >= 21) return 21
  if (minor >= 17) return 17
  return 8
}

/**
 * Find the best Java installation for a given Minecraft version.
 */
export function findBestJava(mcVersion: string, installations?: JavaInstallation[]): JavaInstallation | null {
  const javas = installations || detectJavaInstallations()
  const requiredMajor = getRequiredJavaMajor(mcVersion)

  // Prefer 64-bit, then highest version that meets the minimum
  const compatible = javas
    .filter((j) => j.major >= requiredMajor)
    .sort((a, b) => {
      if (a.is64Bit !== b.is64Bit) return a.is64Bit ? -1 : 1
      return b.major - a.major
    })

  return compatible[0] || null
}
