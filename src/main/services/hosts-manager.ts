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
  CreateRemoteServerInput
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
    `/v1/loaders/${loader}/versions?mc=${encodeURIComponent(mcVersion)}`
  )
}
