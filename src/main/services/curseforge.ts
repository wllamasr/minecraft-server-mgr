import type { ModSearchOptions, ModSearchResponse, UnifiedMod, UnifiedModVersion } from '../../shared/types/mod.types'
import { getSetting } from './config-manager'
import log from '../utils/logger'

const API_BASE = 'https://api.curseforge.com/v1'
const MINECRAFT_GAME_ID = 432
const MODS_CLASS_ID = 6

// ModLoader Type IDs for CurseForge
const CF_LOADER_TYPES: Record<string, number> = {
  forge: 1,
  fabric: 4,
  quilt: 5,
  neoforge: 6
}

// ─── API Types ─────────────────────────────────────────────
interface CFModSearchResponse {
  data: CFMod[]
  pagination: {
    index: number
    pageSize: number
    resultCount: number
    totalCount: number
  }
}

interface CFMod {
  id: number
  name: string
  slug: string
  summary: string
  authors: { name: string }[]
  logo: { thumbnailUrl: string }
  downloadCount: number
  dateCreated: string
  dateModified: string
  categories: { name: string }[]
  latestFilesIndexes: {
    gameVersion: string
    modLoader?: number
  }[]
}

interface CFModFileResponse {
  data: CFModFile[]
}

interface CFModFile {
  id: number
  modId: number
  displayName: string
  fileName: string
  fileDate: string
  fileLength: number
  releaseType: number // 1: Release, 2: Beta, 3: Alpha
  downloadUrl: string | null
  gameVersions: string[]
  dependencies: {
    modId: number
    relationType: number // 3: Required, 4: Optional
  }[]
}

interface CFModDescriptionResponse {
  data: string // HTML description
}

interface CFModResponse {
  data: CFMod
}

// ─── Core Request Helper ───────────────────────────────────

async function cfFetch<T>(endpoint: string): Promise<T> {
  const apiKey = getSetting('curseforge.apiKey')
  if (!apiKey) {
    throw new Error('CurseForge API key is not configured.')
  }

  const url = `${API_BASE}${endpoint}`
  // Use undocumented proxy endpoint or official endpoint based on need - standard applies here
  log.debug(`[CurseForge] Fetching: ${url}`)

  return new Promise((resolve, reject) => {
    const https = require('https')
    const options = {
      headers: {
        'Accept': 'application/json',
        'x-api-key': apiKey
      }
    }

    https.get(url, options, (res: any) => {
      let data = ''
      res.on('data', (chunk: string) => (data += chunk))
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`CurseForge API error: HTTP ${res.statusCode} - ${data.slice(0, 200)}`))
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

// ─── API Methods ──────────────────────────────────────────

export async function searchMods(options: ModSearchOptions): Promise<ModSearchResponse> {
  const params = new URLSearchParams()
  params.append('gameId', String(MINECRAFT_GAME_ID))
  params.append('classId', String(MODS_CLASS_ID))
  
  if (options.query) params.append('searchFilter', options.query)
  if (options.gameVersion) params.append('gameVersion', options.gameVersion)
  
  if (options.loader && CF_LOADER_TYPES[options.loader]) {
    params.append('modLoaderType', String(CF_LOADER_TYPES[options.loader]))
  }

  // CurseForge pagination uses index/pageSize
  params.append('index', String(options.offset || 0))
  params.append('pageSize', String(options.limit || 20))

  const endpoint = `/mods/search?${params.toString()}`
  const data = await cfFetch<CFModSearchResponse>(endpoint)

  const mods: UnifiedMod[] = data.data.map((mod) => {
    // Determine loaders based on latest files
    const loaders = new Set<string>()
    const gameVers = new Set<string>()
    mod.latestFilesIndexes?.forEach(idx => {
      gameVers.add(idx.gameVersion)
      if (idx.modLoader === 1) loaders.add('forge')
      if (idx.modLoader === 4) loaders.add('fabric')
      if (idx.modLoader === 5) loaders.add('quilt')
      if (idx.modLoader === 6) loaders.add('neoforge')
    })

    return {
      id: String(mod.id),
      slug: mod.slug,
      name: mod.name,
      summary: mod.summary,
      author: mod.authors.map(a => a.name).join(', '),
      iconUrl: mod.logo?.thumbnailUrl || null,
      downloads: mod.downloadCount,
      loaders: Array.from(loaders),
      gameVersions: Array.from(gameVers),
      categories: mod.categories.map(c => c.name),
      dateCreated: mod.dateCreated,
      dateModified: mod.dateModified,
      source: 'curseforge'
    }
  })

  return { mods, totalHits: data.pagination.totalCount }
}

export async function getMod(modId: string): Promise<UnifiedMod & { descriptionHtml: string }> {
  const [modRes, descRes] = await Promise.all([
    cfFetch<CFModResponse>(`/mods/${modId}`),
    cfFetch<CFModDescriptionResponse>(`/mods/${modId}/description`)
  ])

  const mod = modRes.data
  const loaders = new Set<string>()
  const gameVers = new Set<string>()
  mod.latestFilesIndexes?.forEach(idx => {
    gameVers.add(idx.gameVersion)
    if (idx.modLoader === 1) loaders.add('forge')
    if (idx.modLoader === 4) loaders.add('fabric')
    if (idx.modLoader === 5) loaders.add('quilt')
    if (idx.modLoader === 6) loaders.add('neoforge')
  })

  return {
    id: String(mod.id),
    slug: mod.slug,
    name: mod.name,
    summary: mod.summary,
    author: mod.authors.map(a => a.name).join(', '),
    iconUrl: mod.logo?.thumbnailUrl || null,
    downloads: mod.downloadCount,
    loaders: Array.from(loaders),
    gameVersions: Array.from(gameVers),
    categories: mod.categories.map(c => c.name),
    dateCreated: mod.dateCreated,
    dateModified: mod.dateModified,
    source: 'curseforge',
    descriptionHtml: descRes.data // Direct HTML from CurseForge API
  }
}

export async function getModVersions(
  modId: string,
  gameVersion?: string,
  loader?: string
): Promise<UnifiedModVersion[]> {
  const params = new URLSearchParams()
  if (gameVersion) params.append('gameVersion', gameVersion)
  if (loader && CF_LOADER_TYPES[loader]) {
    params.append('modLoaderType', String(CF_LOADER_TYPES[loader]))
  }

  const endpoint = `/mods/${modId}/files?${params.toString()}`
  const data = await cfFetch<CFModFileResponse>(endpoint)

  return data.data.map(f => {
    // Map release type
    let rType: 'release' | 'beta' | 'alpha' = 'release'
    if (f.releaseType === 2) rType = 'beta'
    if (f.releaseType === 3) rType = 'alpha'

    // Determine loaders from game versions list (Curseforge sometimes mixes them)
    const fileLoaders = f.gameVersions.filter(v => ['Forge', 'Fabric', 'Quilt', 'NeoForge'].includes(v)).map(l => l.toLowerCase())

    return {
      id: String(f.id),
      name: f.displayName,
      fileName: f.fileName,
      versionNumber: f.displayName, // CF files don't have strict version props, displayName contains it
      releaseDate: f.fileDate,
      downloads: 0, // Not provided directly per file
      loaders: fileLoaders,
      gameVersions: f.gameVersions.filter(v => !['Forge', 'Fabric', 'Quilt', 'NeoForge'].includes(v)),
      type: rType,
      downloadUrl: f.downloadUrl || '', // If null, user might need a different authentication flow, we'll assume it exists for MVP
      fileSize: f.fileLength,
      dependencies: (f.dependencies || []).map(d => {
        let depType: 'required' | 'optional' = 'optional'
        if (d.relationType === 3) depType = 'required'
        
        return {
          modId: String(d.modId),
          projectId: null,
          dependencyType: depType
        }
      })
    }
  })
}
