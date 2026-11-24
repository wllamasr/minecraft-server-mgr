/**
 * Plugins of a server on a remote host, as its daemon (msmd 0.5.0+) reports
 * and changes them. The host installs from Modrinth itself: the app only
 * tells it which version.
 */

import type { UnifiedModVersion } from '../types'

/** One plugin in the plugins folder of a remote server. */
export interface RemoteAddon {
  /** The jar's name; what the plugin is called by in every request. */
  file: string
  /** False for a jar the server is kept from loading. */
  enabled: boolean
  sizeBytes: number
  /** What the jar says of itself, when it does. */
  name?: string
  version?: string
  /** Set for a plugin the host installed from Modrinth. */
  projectId?: string
  versionId?: string
}

const DEVICE_NAMES = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i

/**
 * What the name of a plugin's jar looks like (the daemon's rule). Names end
 * up in request paths and on the screen: nothing else is sent or shown.
 */
export function isAddonFile(name: unknown): name is string {
  if (typeof name !== 'string') return false
  if (!/^[A-Za-z0-9][A-Za-z0-9._+()[\] -]{0,120}\.jar$/.test(name) || name.includes('..')) return false
  return !DEVICE_NAMES.test(name.split('.')[0].trim())
}

/** What the id of a Modrinth version looks like. */
export function isModrinthVersionId(id: unknown): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9]{1,32}$/.test(id)
}

function shortText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  // Printable, on one line, and short: it comes out of a file on the host.
  const clean = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, 80)
  return clean || undefined
}

/**
 * The list of plugins out of a daemon's answer. Entries that are not what a
 * plugin looks like are left out rather than shown.
 */
export function readRemoteAddons(raw: unknown): RemoteAddon[] {
  if (!Array.isArray(raw)) return []
  const out: RemoteAddon[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    if (!isAddonFile(r.file) || typeof r.enabled !== 'boolean') continue
    const size = typeof r.sizeBytes === 'number' && Number.isFinite(r.sizeBytes) && r.sizeBytes >= 0 ? r.sizeBytes : 0
    const addon: RemoteAddon = { file: r.file, enabled: r.enabled, sizeBytes: size }
    const name = shortText(r.name)
    const version = shortText(r.version)
    if (name) addon.name = name
    if (version) addon.version = version
    if (isModrinthVersionId(r.projectId)) addon.projectId = r.projectId
    if (isModrinthVersionId(r.versionId)) addon.versionId = r.versionId
    out.push(addon)
  }
  return out
}

/**
 * The version to install out of a project's versions for a server (already
 * narrowed to its Minecraft version and platform, newest first): the newest
 * release, or the newest of any kind when it has no release.
 */
export function pickAddonVersion(versions: readonly UnifiedModVersion[]): UnifiedModVersion | null {
  const usable = versions.filter((v) => isModrinthVersionId(v.id))
  return usable.find((v) => v.type === 'release') ?? usable[0] ?? null
}
