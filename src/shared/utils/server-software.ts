/**
 * Pure parsing of the PaperMC ("Fill" v3) and Purpur (v2) download APIs.
 *
 * Kept free of I/O so the selection logic can be unit-tested against recorded
 * API responses; the network calls live in `src/main/services/server-software.ts`.
 */
import { compareVersionsDesc, isReleaseVersion } from './minecraft-version'

export interface SoftwareBuild {
  /** Build identifier, e.g. `232`. Stored as the server's engine version. */
  version: string
  /** True for builds the project marks as stable / recommended. */
  stable: boolean
}

export interface SoftwareDownload {
  build: string
  url: string
  fileName: string
  size?: number
  checksum: { algorithm: 'sha256' | 'md5'; value: string }
}

// ─── PaperMC Fill v3 (Paper, Folia) ────────────────────────

interface FillProject {
  versions?: Record<string, string[]>
}

interface FillBuild {
  id: number
  channel?: string
  downloads?: Record<
    string,
    { name?: string; url?: string; size?: number; checksums?: { sha256?: string } } | undefined
  >
}

/** Release Minecraft versions a PaperMC project supports, newest first. */
export function parseFillVersions(project: unknown): string[] {
  const groups = (project as FillProject | null)?.versions
  if (!groups || typeof groups !== 'object') return []
  const all = Object.values(groups).flatMap((list) => (Array.isArray(list) ? list : []))
  return [...new Set(all.filter((v) => typeof v === 'string' && isReleaseVersion(v)))].sort(compareVersionsDesc)
}

function asFillBuilds(builds: unknown): FillBuild[] {
  if (!Array.isArray(builds)) return []
  return (builds as FillBuild[])
    .filter((b) => b && typeof b.id === 'number' && !!b.downloads?.['server:default']?.url)
    .sort((a, b) => b.id - a.id)
}

/** Selectable builds, newest first. Only `STABLE` channel builds are marked stable. */
export function parseFillBuilds(builds: unknown): SoftwareBuild[] {
  return asFillBuilds(builds).map((b) => ({ version: String(b.id), stable: b.channel === 'STABLE' }))
}

/**
 * Resolve the download for a build. PaperMC hosts are the only accepted
 * origin and a SHA-256 checksum is mandatory, so a tampered or truncated jar
 * can never be started.
 */
export function resolveFillDownload(builds: unknown, build: string): SoftwareDownload {
  const match = asFillBuilds(builds).find((b) => String(b.id) === String(build))
  if (!match) throw new Error(`Build ${build} was not found`)

  const file = match.downloads!['server:default']!
  const sha256 = file.checksums?.sha256
  if (!sha256 || !/^[a-f0-9]{64}$/i.test(sha256)) {
    throw new Error(`Build ${build} does not publish a SHA-256 checksum`)
  }
  assertTrustedHost(file.url!, ['papermc.io'])

  return {
    build: String(match.id),
    url: file.url!,
    fileName: file.name || `server-${match.id}.jar`,
    size: typeof file.size === 'number' ? file.size : undefined,
    checksum: { algorithm: 'sha256', value: sha256.toLowerCase() }
  }
}

// ─── Purpur v2 ─────────────────────────────────────────────

export const PURPUR_API = 'https://api.purpurmc.org/v2/purpur'

/** Release Minecraft versions Purpur supports, newest first. */
export function parsePurpurVersions(project: unknown): string[] {
  const versions = (project as { versions?: unknown } | null)?.versions
  if (!Array.isArray(versions)) return []
  return [...new Set(versions.filter((v): v is string => typeof v === 'string' && isReleaseVersion(v)))].sort(
    compareVersionsDesc
  )
}

/** Selectable Purpur builds, newest first. Purpur has no release channels: every published build counts as stable. */
export function parsePurpurBuilds(version: unknown, limit = 25): SoftwareBuild[] {
  const builds = (version as { builds?: { latest?: unknown; all?: unknown } } | null)?.builds
  if (!builds || !Array.isArray(builds.all)) return []
  const ids = (builds.all as unknown[]).filter((b): b is string => typeof b === 'string' && /^\d+$/.test(b))
  return ids
    .sort((a, b) => Number(b) - Number(a))
    .slice(0, limit)
    .map((id) => ({ version: id, stable: true }))
}

/** Resolve the download for a Purpur build from its build-detail response. */
export function resolvePurpurDownload(mcVersion: string, buildDetail: unknown): SoftwareDownload {
  const detail = buildDetail as { build?: unknown; result?: unknown; md5?: unknown } | null
  const build = typeof detail?.build === 'string' ? detail.build : ''
  if (!/^\d+$/.test(build)) throw new Error('Purpur build details are malformed')
  if (detail?.result !== 'SUCCESS') throw new Error(`Purpur build ${build} did not build successfully`)
  const md5 = detail?.md5
  if (typeof md5 !== 'string' || !/^[a-f0-9]{32}$/i.test(md5)) {
    throw new Error(`Purpur build ${build} does not publish a checksum`)
  }
  if (!isReleaseVersion(mcVersion)) throw new Error(`Invalid Minecraft version: ${mcVersion}`)

  return {
    build,
    url: `${PURPUR_API}/${mcVersion}/${build}/download`,
    fileName: `purpur-${mcVersion}-${build}.jar`,
    checksum: { algorithm: 'md5', value: md5.toLowerCase() }
  }
}

// ─── Shared ────────────────────────────────────────────────

/** Throws unless `url` is https and its host is one of `domains` or a subdomain of one. */
export function assertTrustedHost(url: string, domains: string[]): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('Download URL is malformed')
  }
  const host = parsed.hostname.toLowerCase()
  const trusted = domains.some((d) => host === d || host.endsWith(`.${d}`))
  if (parsed.protocol !== 'https:' || !trusted) {
    throw new Error(`Refusing to download server software from an unexpected host: ${host}`)
  }
}

/** A build id is always a plain number; anything else is rejected before it reaches a URL. */
export function isValidBuildId(build: unknown): build is string {
  return typeof build === 'string' && /^\d{1,9}$/.test(build)
}
