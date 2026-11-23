import { describe, it, expect } from 'vitest'
import {
  resolveModpackLoader,
  isUnsafeModpackPath,
  parseModrinthModpackSlug,
  isAllowedMrpackUrl,
  isAllowedModpackFileUrl,
  pickModpackDownload
} from './modpack'

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

describe('modpack download URLs', () => {
  it('accepts a .mrpack only from the Modrinth CDN over https', () => {
    expect(isAllowedMrpackUrl('https://cdn.modrinth.com/data/abc/versions/def/pack.mrpack')).toBe(true)
    expect(isAllowedMrpackUrl('HTTPS://CDN.MODRINTH.COM/data/pack.mrpack')).toBe(true)
    for (const bad of [
      'http://cdn.modrinth.com/data/pack.mrpack',
      'https://github.com/someone/pack/releases/download/v1/pack.mrpack',
      'https://cdn.modrinth.com.evil.example/pack.mrpack',
      'https://evil.example/cdn.modrinth.com/pack.mrpack',
      'https://cdn.modrinth.com@evil.example/pack.mrpack',
      'https://user:secret@cdn.modrinth.com/pack.mrpack',
      'https://cdn.modrinth.com:8443/pack.mrpack',
      'https://127.0.0.1/pack.mrpack',
      'file:///C:/pack.mrpack',
      'cdn.modrinth.com/pack.mrpack',
      '',
      undefined,
      42
    ]) {
      expect(isAllowedMrpackUrl(bad), String(bad)).toBe(false)
    }
  })

  it('accepts pack files from the hosts of the pack format', () => {
    for (const ok of [
      'https://cdn.modrinth.com/data/a/versions/b/mod.jar',
      'https://github.com/o/r/releases/download/v1/mod.jar',
      'https://raw.githubusercontent.com/o/r/main/mod.jar',
      'https://gitlab.com/o/r/-/raw/main/mod.jar'
    ]) {
      expect(isAllowedModpackFileUrl(ok), ok).toBe(true)
    }
    for (const bad of [
      'http://github.com/o/r/mod.jar',
      'https://gist.github.com/o/mod.jar',
      'https://mediafire.example/mod.jar',
      'https://169.254.169.254/latest/meta-data',
      'https://localhost/mod.jar'
    ]) {
      expect(isAllowedModpackFileUrl(bad), bad).toBe(false)
    }
  })

  it('picks the first download on an allowed host', () => {
    const good = 'https://cdn.modrinth.com/data/a/mod.jar'
    expect(pickModpackDownload(['https://evil.example/mod.jar', good])).toBe(good)
    expect(pickModpackDownload(['https://evil.example/mod.jar'])).toBeNull()
    expect(pickModpackDownload([])).toBeNull()
    expect(pickModpackDownload(undefined)).toBeNull()
  })
})
