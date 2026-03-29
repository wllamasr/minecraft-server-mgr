import { app } from 'electron'
import type { ModSearchOptions, ModSearchResponse, UnifiedMod, UnifiedModVersion } from '../../shared/types/mod.types'
import log from '../utils/logger'

const API_BASE = 'https://api.modrinth.com/v2'

/** Use a compliant User-Agent as requested by Modrinth docs */
const USER_AGENT = `wllamasr/minecraft-server-manager/${app.getVersion()} (github.com/wllamasr/minecraft-server-mgr)`

// ─── API Types ─────────────────────────────────────────────
interface ModrinthSearchHit {
  project_id: string
  slug: string
  title: string
  description: string
  categories: string[] // e.g., 'fabric', 'forge'
  author: string
  downloads: number
  icon_url: string
  date_created: string
  date_modified: string
  versions: string[] // Game versions
}

interface ModrinthSearchResponse {
  hits: ModrinthSearchHit[]
  offset: number
  limit: number
  total_hits: number
}

interface ModrinthProject {
  id: string
  slug: string
  title: string
  description: string
  categories: string[]
  downloads: number
  icon_url: string
  published: string
  updated: string
  body: string
}

interface ModrinthVersion {
  id: string
  project_id: string
  name: string
  version_number: string
  version_type: 'release' | 'beta' | 'alpha'
  date_published: string
  downloads: number
  game_versions: string[]
  loaders: string[]
  files: {
    url: string
    filename: string
    primary: boolean
    size: number
  }[]
  dependencies: {
    version_id: string | null
    project_id: string | null
    dependency_type: 'required' | 'optional' | 'incompatible' | 'embedded'
  }[]
}

// ─── API Methods ──────────────────────────────────────────

export async function searchMods(options: ModSearchOptions): Promise<ModSearchResponse> {
  const params = new URLSearchParams()
  if (options.query) params.append('query', options.query)
  params.append('limit', String(options.limit || 20))
  params.append('offset', String(options.offset || 0))

  // Facets for filtering by loader and game version
  const facets: string[][] = []

  // Always only search for 'mod' type projects
  facets.push(['project_type:mod'])

  if (options.loader) {
    facets.push([`categories:${options.loader}`])
  }
  if (options.gameVersion) {
    facets.push([`versions:${options.gameVersion}`])
  }

  if (facets.length > 0) {
    params.append('facets', JSON.stringify(facets))
  }

  const url = `${API_BASE}/search?${params.toString()}`
  log.debug(`[Modrinth] Searching mods: ${url}`)

  const data = await fetchJson<ModrinthSearchResponse>(url)

  const mods: UnifiedMod[] = data.hits.map((hit) => ({
    id: hit.project_id,
    slug: hit.slug,
    name: hit.title,
    summary: hit.description,
    author: hit.author,
    iconUrl: hit.icon_url,
    downloads: hit.downloads,
    loaders: hit.categories.filter((c) => ['fabric', 'forge', 'quilt', 'neoforge'].includes(c)),
    gameVersions: hit.versions,
    categories: hit.categories.filter((c) => !['fabric', 'forge', 'quilt', 'neoforge'].includes(c)),
    dateCreated: hit.date_created,
    dateModified: hit.date_modified,
    source: 'modrinth'
  }))

  return { mods, totalHits: data.total_hits }
}

export async function getMod(projectId: string): Promise<UnifiedMod & { descriptionHtml: string }> {
  const url = `${API_BASE}/project/${projectId}`
  const data = await fetchJson<ModrinthProject>(url)

  return {
    id: data.id,
    slug: data.slug,
    name: data.title,
    summary: data.description,
    author: 'Unknown', // Modrinth project endpoint doesn't return author directly without expanding
    iconUrl: data.icon_url,
    downloads: data.downloads,
    loaders: data.categories.filter((c) => ['fabric', 'forge', 'quilt', 'neoforge'].includes(c)),
    gameVersions: [], // The project endpoint doesn't list all game versions easily, rely on version endpoint
    categories: data.categories.filter((c) => !['fabric', 'forge', 'quilt', 'neoforge'].includes(c)),
    dateCreated: data.published,
    dateModified: data.updated,
    source: 'modrinth',
    descriptionHtml: data.body // Modrinth bodies are Markdown, we'll return raw for client to render
  }
}

export async function getModVersions(
  projectId: string,
  gameVersion?: string,
  loader?: string
): Promise<UnifiedModVersion[]> {
  const params = new URLSearchParams()
  if (gameVersion) params.append('game_versions', JSON.stringify([gameVersion]))
  if (loader) params.append('loaders', JSON.stringify([loader]))

  const url = `${API_BASE}/project/${projectId}/version?${params.toString()}`
  const data = await fetchJson<ModrinthVersion[]>(url)

  return data.map((v) => {
    // Modrinth files arrays usually have a primary file, or we just take the first
    const primaryFile = v.files.find((f) => f.primary) || v.files[0]

    return {
      id: v.id,
      name: v.name,
      fileName: primaryFile.filename,
      versionNumber: v.version_number,
      releaseDate: v.date_published,
      downloads: v.downloads,
      loaders: v.loaders,
      gameVersions: v.game_versions,
      type: v.version_type,
      downloadUrl: primaryFile.url,
      fileSize: primaryFile.size,
      dependencies: v.dependencies.map((d) => ({
        modId: null, // Modrinth only provides project_id for dependencies
        projectId: d.project_id,
        dependencyType: d.dependency_type
      }))
    }
  })
}

// ─── Helpers ───────────────────────────────────────────────

async function fetchJson<T>(url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const https = require('https')
    const options = {
      headers: {
        'User-Agent': USER_AGENT
      }
    }

    https.get(url, options, (res: any) => {
      let data = ''
      res.on('data', (chunk: string) => (data += chunk))
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`Modrinth API error: HTTP ${res.statusCode} - ${data.slice(0, 200)}`))
          return
        }
        try {
          resolve(JSON.parse(data))
        } catch (e) {
          reject(e)
        }
      })
    }).on('error', reject)
  })
}
