import { describe, it, expect } from 'vitest'
import { resolveModpackLoader, isUnsafeModpackPath, parseModrinthModpackSlug } from './modpack'

describe('resolveModpackLoader', () => {
  it('resolves Fabric packs', () => {
    expect(resolveModpackLoader({ minecraft: '1.20.1', 'fabric-loader': '0.15.7' })).toEqual({
      minecraftVersion: '1.20.1',
      loader: 'fabric',
      loaderVersion: '0.15.7'
    })
  })

  it('resolves NeoForge and Forge and Quilt', () => {
    expect(resolveModpackLoader({ minecraft: '1.21', neoforge: '21.0.5' }).loader).toBe('neoforge')
    expect(resolveModpackLoader({ minecraft: '1.20.1', forge: '47.2.0' }).loader).toBe('forge')
    expect(resolveModpackLoader({ minecraft: '1.20.1', 'quilt-loader': '0.23' }).loader).toBe('quilt')
  })

  it('returns a null loader for a vanilla pack', () => {
    expect(resolveModpackLoader({ minecraft: '1.20.1' })).toEqual({
      minecraftVersion: '1.20.1',
      loader: null,
      loaderVersion: null
    })
  })
})

describe('isUnsafeModpackPath', () => {
  it('accepts normal relative paths', () => {
    expect(isUnsafeModpackPath('mods/sodium.jar')).toBe(false)
    expect(isUnsafeModpackPath('config/foo/bar.toml')).toBe(false)
  })

  it('rejects traversal, absolute, and drive paths', () => {
    expect(isUnsafeModpackPath('../evil.jar')).toBe(true)
    expect(isUnsafeModpackPath('mods/../../evil.jar')).toBe(true)
    expect(isUnsafeModpackPath('/etc/passwd')).toBe(true)
    expect(isUnsafeModpackPath('C:\\Windows\\system32')).toBe(true)
    expect(isUnsafeModpackPath('')).toBe(true)
  })
})

describe('parseModrinthModpackSlug', () => {
  it('extracts the slug from a modpack URL', () => {
    expect(parseModrinthModpackSlug('https://modrinth.com/modpack/fabulously-optimized')).toBe(
      'fabulously-optimized'
    )
    expect(
      parseModrinthModpackSlug('https://modrinth.com/modpack/create-fabric/version/abc123')
    ).toBe('create-fabric')
  })

  it('accepts a bare slug', () => {
    expect(parseModrinthModpackSlug('  cobblemon  ')).toBe('cobblemon')
  })

  it('rejects empty input and non-modrinth URLs', () => {
    expect(parseModrinthModpackSlug('')).toBeNull()
    expect(parseModrinthModpackSlug('https://curseforge.com/minecraft/modpacks/rlcraft')).toBeNull()
  })
})
