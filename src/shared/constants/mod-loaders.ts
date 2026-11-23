/**
 * Server software ("engine") a server runs on top of vanilla Minecraft.
 *
 * - Mod loaders (Forge, NeoForge, Fabric, Quilt) load **mods** from `mods/`.
 * - Plugin platforms (Paper, Purpur, Folia) are performance-oriented server
 *   builds that load **plugins** from `plugins/`. They are the engines meant
 *   for large player counts.
 *
 * The name `ModLoaderType` (and the `mod_loader` column) predates plugin
 * platforms; it now means "engine".
 */
export type ModLoaderType = 'forge' | 'neoforge' | 'fabric' | 'quilt' | 'paper' | 'purpur' | 'folia'

export type PluginPlatform = 'paper' | 'purpur' | 'folia'

export const MOD_LOADERS: { value: ModLoaderType; label: string }[] = [
  { value: 'forge', label: 'Forge' },
  { value: 'neoforge', label: 'NeoForge' },
  { value: 'fabric', label: 'Fabric' },
  { value: 'quilt', label: 'Quilt' },
  { value: 'paper', label: 'Paper' },
  { value: 'purpur', label: 'Purpur' },
  { value: 'folia', label: 'Folia' }
]

export const PLUGIN_PLATFORMS: readonly PluginPlatform[] = ['paper', 'purpur', 'folia']

/** True for engines that load plugins (Paper family) rather than mods. */
export function isPluginPlatform(loader: string | null | undefined): loader is PluginPlatform {
  return !!loader && (PLUGIN_PLATFORMS as readonly string[]).includes(loader)
}

/** Folder inside the server directory where the engine loads add-ons from. */
export function addonDirFor(loader: string | null | undefined): 'plugins' | 'mods' {
  return isPluginPlatform(loader) ? 'plugins' : 'mods'
}

/**
 * The loader tag to filter by on Modrinth for a given engine.
 *
 * Purpur runs Paper plugins, so it searches the (much larger) `paper` set.
 * Folia needs plugins that explicitly declare Folia support, so it keeps its
 * own tag: an ordinary Paper plugin will not load on Folia.
 */
export function modrinthLoaderFor(loader: string | null | undefined): string | undefined {
  if (!loader) return undefined
  if (loader === 'purpur') return 'paper'
  return loader
}

/** Display name for an engine id, e.g. `neoforge` → `NeoForge`. */
export function engineLabel(loader: string | null | undefined): string {
  if (!loader) return 'Vanilla'
  return MOD_LOADERS.find((l) => l.value === loader)?.label ?? loader
}

/**
 * Modrinth loader tags whose projects run on the given engine. Paper and
 * Purpur load anything built for Bukkit, Spigot or Paper; Folia only loads
 * plugins that explicitly declare Folia support.
 */
export function modrinthCompatibleLoaders(loader: string | null | undefined): string[] {
  if (!loader) return []
  if (loader === 'paper' || loader === 'purpur') return ['paper', 'purpur', 'spigot', 'bukkit']
  return [loader]
}
