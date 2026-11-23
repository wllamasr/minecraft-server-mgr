import type { ModLoaderType } from '../constants/mod-loaders'
import type { ModSource } from './mod.types'
import type { JvmProfile } from '../utils/jvm'
export type { JvmProfile }
export type { ModLoaderType }

/** Reference to the modpack a server was deployed from (for updates). */
export interface ModpackRef {
  source: ModSource
  projectId: string
  versionId: string
  mrpackUrl: string
  name: string
}

export type ServerStatus =
  | 'stopped'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'crashed'
  | 'provisioning'
  | 'error'

export interface ServerInstance {
  id: string
  name: string
  absolutePath: string
  minecraftVersion: string
  modLoader: ModLoaderType | null
  modLoaderVersion: string | null
  javaPath: string | null
  port: number
  minRam: string
  maxRam: string
  autoStart: boolean
  createdAt: string
  updatedAt: string
  modpackSource: ModSource | null
  modpackProjectId: string | null
  modpackVersionId: string | null
  modpackName: string | null
  /** JVM argument profile used to launch the server. */
  jvmProfile: JvmProfile
  /** Daily scheduled restart as local wall-clock time "HH:MM", or null for none. */
  restartSchedule: string | null
  /** Daily scheduled backup as local wall-clock time "HH:MM", or null for none. */
  backupSchedule: string | null
  /** How many scheduled backups are kept; older ones are deleted after each new one. */
  backupKeep: number
  /**
   * How the last scheduled backup went: a JSON string, read with
   * `parseScheduledBackupResult`. Null when none has been due yet.
   */
  backupLastRun: string | null
}

/** Settings of an existing server that can be changed after creation. */
export interface UpdateServerSettingsInput {
  /** "HH:MM" (24 h) to restart the server every day at that time; null to turn it off. */
  restartSchedule?: string | null
  /** "HH:MM" (24 h) to back the server up every day at that time; null to turn it off. */
  backupSchedule?: string | null
  /** How many scheduled backups to keep (1 to 365). */
  backupKeep?: number
}

export interface CreateServerInput {
  name: string
  minecraftVersion: string
  modLoader?: ModLoaderType
  modLoaderVersion?: string
  port?: number
  minRam?: string
  maxRam?: string
  /** Optional server list MOTD; falls back to a default when empty. */
  motd?: string
  /** Automatically restart the server if it crashes. */
  autoStart?: boolean
  /** JVM argument profile; `aikar` applies tuned G1GC flags for busy servers. Defaults to `default`. */
  jvmProfile?: JvmProfile
  /** When set, provision the server from this Modrinth/CurseForge modpack. */
  modpack?: ModpackRef
}

export interface ServerWithStatus extends ServerInstance {
  status: ServerStatus
  pid?: number
}

export interface JavaInstallation {
  path: string
  version: string
  major: number
  is64Bit: boolean
}

export interface ServerLogEntry {
  serverId: string
  line: string
  timestamp: number
  level?: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG'
}

export interface ServerMetrics {
  serverId: string
  cpuPercent: number
  memoryMb: number
  uptimeSeconds: number
}
