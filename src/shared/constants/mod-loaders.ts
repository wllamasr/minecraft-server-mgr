export type ModLoaderType = 'forge' | 'neoforge' | 'fabric' | 'quilt'

export const MOD_LOADERS: { value: ModLoaderType; label: string }[] = [
  { value: 'forge', label: 'Forge' },
  { value: 'neoforge', label: 'NeoForge' },
  { value: 'fabric', label: 'Fabric' },
  { value: 'quilt', label: 'Quilt' }
]
