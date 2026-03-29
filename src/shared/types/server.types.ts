import type { ModLoaderType } from '../constants/mod-loaders'

export type ServerStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'crashed'

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
}

export interface CreateServerInput {
  name: string
  minecraftVersion: string
  modLoader?: ModLoaderType
  modLoaderVersion?: string
  port?: number
  minRam?: string
  maxRam?: string
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
}

export interface ServerMetrics {
  serverId: string
  cpuPercent: number
  memoryMb: number
  uptimeSeconds: number
}
