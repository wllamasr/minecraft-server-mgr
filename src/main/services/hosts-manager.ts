import { isPluginPlatform } from '../../shared/constants'
import { isValidRestartSchedule } from '../../shared/utils/restart-schedule'
import { isBackupId, isOlderDaemonError, OLDER_DAEMON_MESSAGE, plainDaemonMessage } from '../../shared/utils/daemon-errors'
import { safeStorage } from 'electron'
import { v4 as uuid } from 'uuid'
import { eq } from 'drizzle-orm'
import { getDatabase, schema } from '../database/client'
import { pairHost, remoteRequest, type HostConn } from './remote-client'
import type {
  RemoteHost,
  HostInfo,
  RemoteServer,
  AddHostInput,
  CreateRemoteServerInput,
  BackupInfo
} from '../../shared/types'
import log from '../utils/logger'

// ─── token encryption (OS keychain via safeStorage) ────────

function encodeToken(token: string): string {
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(token).toString('base64')
  }
  log.warn('[Hosts] safeStorage unavailable — storing token obfuscated, not encrypted')
  return Buffer.from(token, 'utf8').toString('base64')
}

function decodeToken(enc: string): string {
  const buf = Buffer.from(enc, 'base64')
  if (safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(buf)
    } catch {
      /* was likely stored without encryption; fall through */
    }
  }
  return buf.toString('utf8')
}

// ─── helpers ───────────────────────────────────────────────

function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim()
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  return withScheme.replace(/\/+$/, '')
}

function toRemoteHost(row: typeof schema.hosts.$inferSelect): RemoteHost {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.baseUrl,
    fingerprint: row.fingerprint,
    createdAt: row.createdAt
  }
}

function connFor(hostId: string): HostConn {
  const db = getDatabase()
  const row = db.select().from(schema.hosts).where(eq(schema.hosts.id, hostId)).get()
  if (!row) throw new Error('Host not found')
  return { baseUrl: row.baseUrl, fingerprint: row.fingerprint, token: decodeToken(row.tokenEnc) }
}

// ─── host management ───────────────────────────────────────

export async function addHost(input: AddHostInput): Promise<RemoteHost> {
  const baseUrl = normalizeBaseUrl(input.baseUrl)
  if (!input.token.trim()) throw new Error('A pairing token is required')

  // Pair: connect (TOFU), pin the fingerprint, and validate the token.
  const { fingerprint } = await pairHost(baseUrl, input.token.trim())

  const db = getDatabase()
  const row: typeof schema.hosts.$inferInsert = {
    id: uuid(),
    name: input.name.trim() || baseUrl,
    baseUrl,
    fingerprint,
    tokenEnc: encodeToken(input.token.trim()),
    createdAt: new Date().toISOString()
  }
  db.insert(schema.hosts).values(row).run()
  log.info(`[Hosts] Paired host "${row.name}" at ${baseUrl}`)
  return toRemoteHost(row as typeof schema.hosts.$inferSelect)
}

export function listHosts(): RemoteHost[] {
  const db = getDatabase()
  return db.select().from(schema.hosts).all().map(toRemoteHost)
}

export function removeHost(hostId: string): void {
  const db = getDatabase()
  db.delete(schema.hosts).where(eq(schema.hosts.id, hostId)).run()
}

// ─── remote operations (proxied to the daemon) ─────────────

export function hostInfo(hostId: string): Promise<HostInfo> {
  return remoteRequest<HostInfo>(connFor(hostId), 'GET', '/v1/info')
}

export function listRemoteServers(hostId: string): Promise<RemoteServer[]> {
  return remoteRequest<RemoteServer[]>(connFor(hostId), 'GET', '/v1/servers')
}

export function createRemoteServer(
  hostId: string,
  input: CreateRemoteServerInput
): Promise<RemoteServer> {
  return remoteRequest<RemoteServer>(connFor(hostId), 'POST', '/v1/servers', input)
}

export function startRemoteServer(hostId: string, serverId: string): Promise<void> {
  return remoteRequest(connFor(hostId), 'POST', `/v1/servers/${serverId}/start`).then(() => undefined)
}

export function stopRemoteServer(hostId: string, serverId: string): Promise<void> {
  return remoteRequest(connFor(hostId), 'POST', `/v1/servers/${serverId}/stop`).then(() => undefined)
}

/**
 * Routes added after a host's msmd was installed answer 404 or 405 there. Say
 * what to do about it instead of passing the bare HTTP error on.
 */
function explainOlderDaemon(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err)
  if (isOlderDaemonError(message)) throw new Error(OLDER_DAEMON_MESSAGE)
  throw err
}

export function restartRemoteServer(hostId: string, serverId: string): Promise<void> {
  return remoteRequest(connFor(hostId), 'POST', `/v1/servers/${serverId}/restart`).then(
    () => undefined,
    explainOlderDaemon
  )
}

/** Set (HH:MM, host time) or clear (null) a remote server's daily restart. */
export function updateRemoteServer(
  hostId: string,
  serverId: string,
  settings: { restartSchedule?: string | null }
): Promise<RemoteServer> {
  if (!settings || typeof settings !== 'object') return Promise.reject(new Error('Invalid settings'))
  const body: { restartSchedule?: string | null } = {}
  if (settings.restartSchedule !== undefined) {
    if (settings.restartSchedule !== null && !isValidRestartSchedule(settings.restartSchedule)) {
      return Promise.reject(new Error('Restart time must be HH:MM in 24-hour format, for example 04:30'))
    }
    body.restartSchedule = settings.restartSchedule
  }
  return remoteRequest<RemoteServer>(connFor(hostId), 'PATCH', `/v1/servers/${serverId}`, body).catch(explainOlderDaemon)
}

export function deleteRemoteServer(hostId: string, serverId: string): Promise<void> {
  return remoteRequest(connFor(hostId), 'DELETE', `/v1/servers/${serverId}`).then(() => undefined)
}

export function sendRemoteCommand(hostId: string, serverId: string, command: string): Promise<void> {
  return remoteRequest(connFor(hostId), 'POST', `/v1/servers/${serverId}/command`, { command }).then(
    () => undefined
  )
}

export function remoteServerLogs(hostId: string, serverId: string): Promise<unknown[]> {
  return remoteRequest<unknown[]>(connFor(hostId), 'GET', `/v1/servers/${serverId}/logs`)
}

export function remoteLoaderVersions(
  hostId: string,
  loader: string,
  mcVersion: string
): Promise<{ version: string; stable: boolean }[]> {
  return remoteRequest(
    connFor(hostId),
    'GET',
    `/v1/loaders/${encodeURIComponent(loader)}/versions?mc=${encodeURIComponent(mcVersion)}`
  )
}

/** Minecraft versions a plugin platform (paper, purpur, folia) has builds for, as seen by the host. */
export function remoteSoftwareVersions(hostId: string, platform: string): Promise<string[]> {
  if (!isPluginPlatform(platform)) return Promise.reject(new Error('Unknown server software'))
  return remoteRequest<string[]>(connFor(hostId), 'GET', `/v1/software/${platform}/versions`)
}

// ─── backups (made, kept and restored on the host) ─────────

function backupsPath(serverId: string, backupId?: string): string {
  if (typeof serverId !== 'string' || !serverId) throw new Error('Invalid server')
  const base = `/v1/servers/${encodeURIComponent(serverId)}/backups`
  if (backupId === undefined) return base
  // Ids end up in the request path: only what a backup id looks like is sent.
  if (!isBackupId(backupId)) throw new Error('Invalid backup')
  return `${base}/${backupId}`
}

/** Tell the answer of a daemon apart from "this route does not exist there". */
function plainDaemonError(err: unknown): never {
  throw new Error(plainDaemonMessage(err instanceof Error ? err.message : String(err)))
}

/** Backups of a remote server, newest first. */
export async function listRemoteBackups(hostId: string, serverId: string): Promise<BackupInfo[]> {
  const list = await remoteRequest<BackupInfo[]>(connFor(hostId), 'GET', backupsPath(serverId)).catch(plainDaemonError)
  return Array.isArray(list) ? list : []
}

/**
 * Start a backup on the host. It answers at once; the server's `operation`
 * shows the progress and its `lastOperation`, with the returned id, the outcome.
 */
export async function createRemoteBackup(hostId: string, serverId: string): Promise<{ operationId: string }> {
  const res = await remoteRequest<{ operationId: string }>(connFor(hostId), 'POST', backupsPath(serverId)).catch(plainDaemonError)
  return { operationId: res.operationId }
}

/** Start replacing a stopped remote server's files with one of its backups. */
export async function restoreRemoteBackup(
  hostId: string,
  serverId: string,
  backupId: string,
  backupFirst = true
): Promise<{ operationId: string }> {
  const res = await remoteRequest<{ operationId: string }>(
    connFor(hostId),
    'POST',
    `${backupsPath(serverId, backupId)}/restore`,
    { backupFirst: backupFirst !== false }
  ).catch(plainDaemonError)
  return { operationId: res.operationId }
}

export async function deleteRemoteBackup(hostId: string, serverId: string, backupId: string): Promise<void> {
  await remoteRequest(connFor(hostId), 'DELETE', backupsPath(serverId, backupId)).catch(plainDaemonError)
}
