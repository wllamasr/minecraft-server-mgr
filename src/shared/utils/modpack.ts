import type { ModLoaderType } from '../types/server.types'

/**
 * The `dependencies` block of a Modrinth `modrinth.index.json` (`.mrpack`).
 * Exactly one loader key is present alongside `minecraft`.
 */
export interface MrpackDependencies {
  minecraft?: string
  'fabric-loader'?: string
  'quilt-loader'?: string
  forge?: string
  neoforge?: string
}

export interface ResolvedModpackLoader {
  minecraftVersion: string
  loader: ModLoaderType | null
  loaderVersion: string | null
}

/**
 * Map a `.mrpack` dependencies block to the Minecraft version and the mod
 * loader (+ its exact version) that the server must be provisioned with.
 */
export function resolveModpackLoader(deps: MrpackDependencies): ResolvedModpackLoader {
  const minecraftVersion = deps.minecraft ?? ''
  if (deps['fabric-loader']) return { minecraftVersion, loader: 'fabric', loaderVersion: deps['fabric-loader'] }
  if (deps['quilt-loader']) return { minecraftVersion, loader: 'quilt', loaderVersion: deps['quilt-loader'] }
  if (deps['neoforge']) return { minecraftVersion, loader: 'neoforge', loaderVersion: deps['neoforge'] }
  if (deps['forge']) return { minecraftVersion, loader: 'forge', loaderVersion: deps['forge'] }
  return { minecraftVersion, loader: null, loaderVersion: null }
}

/**
 * A `.mrpack` file path (or override path) is untrusted third-party input.
 * Reject anything absolute, drive-qualified, or containing a `..` segment so
 * extraction cannot escape the server directory (zip-slip / path traversal).
 */
export function isUnsafeModpackPath(relPath: string): boolean {
  if (!relPath || relPath.trim() === '') return true
  const normalized = relPath.replace(/\\/g, '/')
  if (normalized.startsWith('/')) return true
  if (/^[a-zA-Z]:/.test(normalized)) return true // Windows drive letter
  return normalized.split('/').some((seg) => seg === '..')
}

/**
 * Accept a full Modrinth modpack URL or a bare slug/id and return the slug/id
 * usable against the Modrinth API. Returns null when the input is empty or is
 * clearly not a modrinth modpack reference.
 */
export function parseModrinthModpackSlug(input: string): string | null {
  const trimmed = (input || '').trim()
  if (!trimmed) return null

  // Full URL, e.g. https://modrinth.com/modpack/<slug>/version/<id>
  const urlMatch = trimmed.match(/modrinth\.com\/(?:modpack|project)\/([^/?#]+)/i)
  if (urlMatch) return urlMatch[1]

  // Reject other URLs (e.g. a CurseForge link)
  if (/^https?:\/\//i.test(trimmed)) return null

  // Otherwise treat it as a bare slug/id (letters, digits, -, _)
  if (/^[a-zA-Z0-9_-]+$/.test(trimmed)) return trimmed
  return null
}

/** Where Modrinth serves `.mrpack` files from. */
export const MRPACK_HOST = 'cdn.modrinth.com'

/**
 * Hosts a `.mrpack` may download its files from. This is the list the Modrinth
 * pack format defines; Modrinth rejects packs that point anywhere else.
 */
export const MODPACK_FILE_HOSTS: readonly string[] = [MRPACK_HOST, 'github.com', 'raw.githubusercontent.com', 'gitlab.com']

/** The host of a plain https URL (default port, no credentials), else null. */
function plainHttpsHost(url: unknown): string | null {
  if (typeof url !== 'string') return null
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' || parsed.port !== '' || parsed.username !== '' || parsed.password !== '') {
    return null
  }
  return parsed.hostname.toLowerCase()
}

/**
 * A modpack to deploy is named by the URL of its `.mrpack`, and the app or the
 * daemon then downloads that URL. Only Modrinth is supported, so only its CDN
 * is accepted: a create request must not be a way to make the machine fetch an
 * arbitrary address.
 */
export function isAllowedMrpackUrl(url: unknown): url is string {
  return plainHttpsHost(url) === MRPACK_HOST
}

/** Whether a file listed inside a `.mrpack` may be downloaded from this URL. */
export function isAllowedModpackFileUrl(url: unknown): url is string {
  const host = plainHttpsHost(url)
  return host !== null && MODPACK_FILE_HOSTS.includes(host)
}

/** The first of a pack file's download URLs that is on an allowed host. */
export function pickModpackDownload(urls: unknown): string | null {
  if (!Array.isArray(urls)) return null
  return urls.find(isAllowedModpackFileUrl) ?? null
}
