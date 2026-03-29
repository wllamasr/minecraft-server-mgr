export type ModSource = 'curseforge' | 'modrinth'

export interface UnifiedMod {
  id: string
  slug: string
  name: string
  summary: string
  author: string
  iconUrl: string | null
  downloads: number
  loaders: string[] // 'fabric', 'forge', etc.
  gameVersions: string[]
  categories: string[]
  dateCreated: string
  dateModified: string
  source: ModSource
}

export interface UnifiedModVersion {
  id: string // File ID (CurseForge) or Version ID (Modrinth)
  name: string // Display name of the file
  fileName: string
  versionNumber: string
  releaseDate: string
  downloads: number
  loaders: string[]
  gameVersions: string[]
  type: 'release' | 'beta' | 'alpha'
  dependencies: UnifiedDependency[]
  downloadUrl: string
  fileSize: number
}

export interface UnifiedDependency {
  modId: string | null // Target mod ID (if known)
  projectId: string | null // External project ID (if available, e.g. Modrinth's project_id)
  dependencyType: 'required' | 'optional' | 'incompatible' | 'embedded'
}

export interface ModSearchOptions {
  query: string
  loader?: string // e.g. 'fabric', 'forge'
  gameVersion?: string // e.g. '1.20.1'
  source: ModSource
  limit?: number
  offset?: number
}

export interface ModSearchResponse {
  mods: UnifiedMod[]
  totalHits: number
}
