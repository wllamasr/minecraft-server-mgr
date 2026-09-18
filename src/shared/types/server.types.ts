import type { ModLoaderType } from '../constants/mod-loaders'
import type { ModSource } from './mod.types'
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
