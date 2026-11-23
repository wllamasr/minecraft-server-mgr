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
  /** The host's clock (RFC 3339) and zone abbreviation; absent on older daemons. */
  time?: string
  timeZone?: string
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
  /** Daily restart time "HH:MM" in the host's time zone; absent when not scheduled. */
  restartSchedule?: string
  /** The backup or restore in flight, if any. Absent on daemons without backups. */
  operation?: RemoteOperation
  /** How the last backup or restore ended, if one ran since the daemon started. */
  lastOperation?: RemoteOperationResult
}

/** A backup or a restore running on a remote host. */
export interface RemoteOperation {
  id: string
  kind: 'backup' | 'restore'
  /** `saving`: waiting for the running server to write the world to disk. */
  phase: 'saving' | 'copying' | 'replacing'
  doneBytes: number
  totalBytes: number
}

/** How a backup or a restore on a remote host ended. */
export interface RemoteOperationResult {
  id: string
  kind: 'backup' | 'restore'
  ok: boolean
  /** It was dropped because the server was stopped, restarted or deleted, or the daemon shut down. */
  cancelled?: boolean
  error?: string
  /** It went through, but left something for the user to do. */
  warning?: string
  /** The backup that was made or restored. */
  backupId?: string
  finishedAt: string
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
  /** JVM argument profile: `default` or `aikar` (tuned G1GC flags). Needs msmd with engine support. */
  jvmProfile?: 'default' | 'aikar'
  autoStart?: boolean
  modpack?: {
    source: string
    projectId: string
    versionId: string
    mrpackUrl: string
    name: string
  }
}
