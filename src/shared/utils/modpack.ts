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
