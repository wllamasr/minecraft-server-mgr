import { describe, it, expect } from 'vitest'
import {
  MOD_LOADERS,
  addonDirFor,
  engineLabel,
  isPluginPlatform,
  modrinthCompatibleLoaders,
  modrinthLoaderFor
} from './mod-loaders'

describe('isPluginPlatform', () => {
  it('is true only for the Paper family', () => {
    expect(['paper', 'purpur', 'folia'].every((l) => isPluginPlatform(l))).toBe(true)
    expect(['forge', 'neoforge', 'fabric', 'quilt', '', 'spigot'].some((l) => isPluginPlatform(l))).toBe(false)
    expect(isPluginPlatform(null)).toBe(false)
    expect(isPluginPlatform(undefined)).toBe(false)
  })
})

describe('addonDirFor', () => {
  it('sends plugins to plugins/ and everything else to mods/', () => {
    expect(addonDirFor('paper')).toBe('plugins')
    expect(addonDirFor('purpur')).toBe('plugins')
    expect(addonDirFor('folia')).toBe('plugins')
    expect(addonDirFor('fabric')).toBe('mods')
    expect(addonDirFor(null)).toBe('mods')
  })
})

describe('Modrinth loader mapping', () => {
  it('searches the Paper catalog for Purpur and keeps Folia separate', () => {
    expect(modrinthLoaderFor('purpur')).toBe('paper')
    expect(modrinthLoaderFor('folia')).toBe('folia')
    expect(modrinthLoaderFor('fabric')).toBe('fabric')
    expect(modrinthLoaderFor(null)).toBeUndefined()
  })

  it('accepts Bukkit/Spigot plugins on Paper and Purpur, but only Folia plugins on Folia', () => {
    expect(modrinthCompatibleLoaders('paper')).toEqual(['paper', 'purpur', 'spigot', 'bukkit'])
    expect(modrinthCompatibleLoaders('purpur')).toEqual(['paper', 'purpur', 'spigot', 'bukkit'])
    expect(modrinthCompatibleLoaders('folia')).toEqual(['folia'])
    expect(modrinthCompatibleLoaders('forge')).toEqual(['forge'])
    expect(modrinthCompatibleLoaders(undefined)).toEqual([])
  })
})

describe('engineLabel', () => {
  it('labels every engine and falls back to Vanilla', () => {
    expect(engineLabel(null)).toBe('Vanilla')
    expect(engineLabel('neoforge')).toBe('NeoForge')
    expect(engineLabel('paper')).toBe('Paper')
    for (const l of MOD_LOADERS) expect(engineLabel(l.value)).toBe(l.label)
  })
})
