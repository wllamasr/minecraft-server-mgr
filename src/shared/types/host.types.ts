/** A paired remote daemon (never carries the raw token to the renderer). */
export interface RemoteHost {
  id: string
  name: string
  baseUrl: string
  fingerprint: string
  createdAt: string
}

/** Host info reported by the daemon's /v1/info. */
export interface HostInfo {
  agentVersion: string
  os: string
  arch: string
  hostname: string
  serversRoot: string
  java: { path: string; major: number; version: string }[]
}

/** A server as returned by a daemon (mirrors the daemon's View). */
export interface RemoteServer {
  id: string
  name: string
  minecraftVersion: string
  modLoader?: string
  modLoaderVersion?: string
  port: number
  minRam: string
  maxRam: string
  autoStart: boolean
  status: string
  pid?: number
  modpackName?: string
}

export interface AddHostInput {
  name: string
  baseUrl: string
  token: string
}

export interface CreateRemoteServerInput {
  name: string
  minecraftVersion: string
  modLoader?: string
  modLoaderVersion?: string
  port?: number
  minRam?: string
  maxRam?: string
  autoStart?: boolean
  modpack?: {
    source: string
    projectId: string
    versionId: string
    mrpackUrl: string
    name: string
  }
}
