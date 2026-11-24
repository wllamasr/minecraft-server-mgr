import { isPluginPlatform } from '../../shared/constants'
import { isValidRestartSchedule } from '../../shared/utils/restart-schedule'
import { isValidBackupKeep, isValidBackupSchedule } from '../../shared/utils/backup-schedule'
import {
  isBackupId,
  isOlderDaemonError,
  OLDER_DAEMON_MESSAGE,
  plainDaemonMessage,
  plainSettingsMessage
} from '../../shared/utils/daemon-errors'
import { readRemoteMetrics, type RemoteServerMetrics } from '../../shared/utils/server-metrics'
import { isAddonFile, isModrinthVersionId, readRemoteAddons, type RemoteAddon } from '../../shared/utils/remote-addons'
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

/**
 * Change the settings of a remote server: its daily restart and its daily
 * backup (HH:MM on the host's clock, or null for none), and how many
 * scheduled backups the host keeps. Only what is given changes.
 */
export function updateRemoteServer(
  hostId: string,
  serverId: string,
  settings: { restartSchedule?: string | null; backupSchedule?: string | null; backupKeep?: number }
): Promise<RemoteServer> {
  if (!settings || typeof settings !== 'object') return Promise.reject(new Error('Invalid settings'))
  const body: { restartSchedule?: string | null; backupSchedule?: string | null; backupKeep?: number } = {}
  if (settings.restartSchedule !== undefined) {
    if (settings.restartSchedule !== null && !isValidRestartSchedule(settings.restartSchedule)) {
      return Promise.reject(new Error('Restart time must be HH:MM in 24-hour format, for example 04:30'))
    }
    body.restartSchedule = settings.restartSchedule
  }
  if (settings.backupSchedule !== undefined) {
    if (settings.backupSchedule !== null && !isValidBackupSchedule(settings.backupSchedule)) {
      return Promise.reject(new Error('Backup time must be HH:MM in 24-hour format, for example 03:30'))
    }
    body.backupSchedule = settings.backupSchedule
  }
  if (settings.backupKeep !== undefined) {
    if (!isValidBackupKeep(settings.backupKeep)) {
      return Promise.reject(new Error('The number of backups to keep must be a whole number from 1 to 365'))
    }
    body.backupKeep = settings.backupKeep
  }
  // A host whose msmd is older refuses the settings it does not know by name.
  return remoteRequest<RemoteServer>(connFor(hostId), 'PATCH', `/v1/servers/${encodeURIComponent(serverId)}`, body).catch(
    (err: unknown) => {
      throw new Error(plainSettingsMessage(err instanceof Error ? err.message : String(err)))
    }
  )
}

export function deleteRemoteServer(hostId: string, serverId: string): Promise<void> {
  return remoteRequest(connFor(hostId), 'DELETE', `/v1/servers/${serverId}`).then(() => undefined)
}

export function sendRemoteCommand(hostId: string, serverId: string, command: string): Promise<void> {
  return remoteRequest(connFor(hostId), 'POST', `/v1/servers/${serverId}/command`, { command }).then(
    () => undefined
  )
}

/**
 * What a running server on a host is doing. Resolves to null when the host
 * has no metrics to give (an msmd from before 0.4.0), so that the caller can
 * stop asking; fails when the server is not running or the host cannot be
 * reached. Asking is what makes the host ask the server for its tick time.
 */
export async function remoteServerMetrics(hostId: string, serverId: string): Promise<RemoteServerMetrics | null> {
  if (typeof serverId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(serverId)) throw new Error('Invalid server id')
  let raw: unknown
  try {
    raw = await remoteRequest<unknown>(connFor(hostId), 'GET', `/v1/servers/${serverId}/metrics`)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (isOlderDaemonError(message)) return null
    throw new Error(plainDaemonMessage(message))
  }
  const metrics = readRemoteMetrics(raw)
  if (!metrics) throw new Error('The host did not answer with metrics')
  return metrics
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

function backupsPath(serverId: string): string {
  if (typeof serverId !== 'string' || !serverId) throw new Error('Invalid server')
  return `/v1/servers/${encodeURIComponent(serverId)}/backups`
}

function backupPath(serverId: string, backupId: unknown): string {
  // Ids end up in the request path: only what a backup id looks like is sent.
  if (!isBackupId(backupId)) throw new Error('Invalid backup')
  return `${backupsPath(serverId)}/${backupId}`
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
    `${backupPath(serverId, backupId)}/restore`,
    { backupFirst: backupFirst !== false }
  ).catch(plainDaemonError)
  return { operationId: res.operationId }
}

export async function deleteRemoteBackup(hostId: string, serverId: string, backupId: string): Promise<void> {
  await remoteRequest(connFor(hostId), 'DELETE', backupPath(serverId, backupId)).catch(plainDaemonError)
}

// ─── plugins (installed, kept and changed on the host) ─────

function addonsPath(serverId: string): string {
  if (typeof serverId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(serverId)) throw new Error('Invalid server')
  return `/v1/servers/${serverId}/addons`
}

function addonPath(serverId: string, file: unknown): string {
  // Names end up in the request path: only what a plugin's jar is called is sent.
  if (!isAddonFile(file)) throw new Error('Invalid plugin')
  return `${addonsPath(serverId)}/${encodeURIComponent(file)}`
}

/** The plugins of a remote server (Paper, Purpur or Folia), by name. */
export async function listRemoteAddons(hostId: string, serverId: string): Promise<RemoteAddon[]> {
  const raw = await remoteRequest<unknown>(connFor(hostId), 'GET', addonsPath(serverId)).catch(plainDaemonError)
  return readRemoteAddons(raw)
}

/**
 * Have the host install a version of a Modrinth project as a plugin. The host
 * downloads it from Modrinth itself and checks it; only the version's id is
 * sent. It answers at once; the server's `lastOperation`, with the returned
 * id, tells how it ended.
 */
export async function installRemoteAddon(hostId: string, serverId: string, versionId: string): Promise<{ operationId: string }> {
  if (!isModrinthVersionId(versionId)) throw new Error('Invalid version')
  const res = await remoteRequest<{ operationId: string }>(connFor(hostId), 'POST', addonsPath(serverId), { versionId }).catch(
    plainDaemonError
  )
  return { operationId: res.operationId }
}

/** Turn a plugin of a stopped remote server off or on. */
export async function setRemoteAddonEnabled(hostId: string, serverId: string, file: string, enabled: boolean): Promise<void> {
  if (typeof enabled !== 'boolean') throw new Error('Invalid state')
  await remoteRequest(connFor(hostId), 'PATCH', addonPath(serverId, file), { enabled }).catch(plainDaemonError)
}

/** Delete the jar of a plugin of a stopped remote server. */
export async function removeRemoteAddon(hostId: string, serverId: string, file: string): Promise<void> {
  await remoteRequest(connFor(hostId), 'DELETE', addonPath(serverId, file)).catch(plainDaemonError)
}
