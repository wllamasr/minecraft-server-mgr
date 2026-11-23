import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  parseFillVersions,
  parseFillBuilds,
  resolveFillDownload,
  parsePurpurVersions,
  parsePurpurBuilds,
  resolvePurpurDownload,
  assertTrustedHost,
  isValidBuildId
} from './server-software'

// Responses recorded from the real APIs (commit metadata stripped).
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(__dirname, '__fixtures__', name), 'utf8'))

const foliaProject = fixture('fill-folia-project.json')
const foliaBuilds = fixture('fill-folia-1.21.11-builds.json')
const purpurProject = fixture('purpur-project.json')
const purpurVersion = fixture('purpur-1.21.4.json')
const purpurBuild = fixture('purpur-1.21.4-2416.json')

describe('PaperMC Fill API', () => {
  it('lists release versions newest first', () => {
    const versions = parseFillVersions(foliaProject)
    expect(versions[0]).toBe('26.3')
    expect(versions).toContain('1.21.11')
    expect(versions).toContain('1.19.4')
    expect(versions.indexOf('26.3')).toBeLessThan(versions.indexOf('1.21.11'))
    expect(versions.indexOf('1.21.11')).toBeLessThan(versions.indexOf('1.21.8'))
  })

  it('drops pre-releases and release candidates', () => {
    const versions = parseFillVersions({
      versions: { '26.3': ['26.3', '26.3-rc-3'], '1.21': ['1.21.11', '1.21.11-rc3', '1.21.9-pre4', '1.21.4'] }
    })
    expect(versions).toEqual(['26.3', '1.21.11', '1.21.4'])
  })

  it('lists builds newest first and marks only STABLE ones as stable', () => {
    const builds = parseFillBuilds(foliaBuilds)
    expect(builds[0]).toEqual({ version: '14', stable: true })
    expect(builds.find((b) => b.version === '6')).toEqual({ version: '6', stable: false }) // BETA
    expect(builds.find((b) => b.version === '1')).toEqual({ version: '1', stable: false }) // ALPHA
    const ids = builds.map((b) => Number(b.version))
    expect(ids).toEqual([...ids].sort((a, b) => b - a))
  })

  it('resolves a build to a checksummed papermc.io download', () => {
    const dl = resolveFillDownload(foliaBuilds, '14')
    expect(dl.build).toBe('14')
    expect(dl.fileName).toBe('folia-1.21.11-14.jar')
    expect(dl.url).toMatch(/^https:\/\/fill-data\.papermc\.io\//)
    expect(dl.checksum).toEqual({
      algorithm: 'sha256',
      value: 'f52c408490a0225611e67907a3ca19f7e6da2c6bc899e715d5f46844e7103c39'
    })
    expect(dl.size).toBe(55082693)
  })

  it('rejects an unknown build', () => {
    expect(() => resolveFillDownload(foliaBuilds, '99999')).toThrow(/not found/)
  })

  it('rejects a build without a valid checksum', () => {
    const builds = [
      { id: 1, channel: 'STABLE', downloads: { 'server:default': { name: 'a.jar', url: 'https://fill-data.papermc.io/a.jar' } } }
    ]
    expect(() => resolveFillDownload(builds, '1')).toThrow(/SHA-256/)
  })

  it('rejects a download hosted outside papermc.io or over http', () => {
    const make = (url: string): unknown => [
      { id: 1, channel: 'STABLE', downloads: { 'server:default': { name: 'a.jar', url, checksums: { sha256: 'a'.repeat(64) } } } }
    ]
    expect(() => resolveFillDownload(make('https://evil.example/a.jar'), '1')).toThrow(/unexpected host/)
    expect(() => resolveFillDownload(make('https://papermc.io.evil.example/a.jar'), '1')).toThrow(/unexpected host/)
    expect(() => resolveFillDownload(make('http://fill-data.papermc.io/a.jar'), '1')).toThrow(/unexpected host/)
  })

  it('tolerates malformed responses', () => {
    expect(parseFillVersions(null)).toEqual([])
    expect(parseFillVersions({ versions: 'nope' })).toEqual([])
    expect(parseFillBuilds({ error: 'not found' })).toEqual([])
    expect(parseFillBuilds([{ id: 3 }, null, { id: 'x' }])).toEqual([])
  })
})

describe('Purpur API', () => {
  it('lists release versions newest first', () => {
    const versions = parsePurpurVersions(purpurProject)
    expect(versions.length).toBeGreaterThan(10)
    expect(versions).toContain('1.21.4')
    expect(versions.indexOf('1.21.4')).toBeLessThan(versions.indexOf('1.20.4'))
    expect(versions.at(-1)).toBe('1.14.1')
  })

  it('lists builds newest first, capped, all marked stable', () => {
    const builds = parsePurpurBuilds(purpurVersion, 5)
    expect(builds).toHaveLength(5)
    expect(builds[0]).toEqual({ version: '2416', stable: true })
    expect(builds.every((b) => b.stable)).toBe(true)
  })

  it('resolves a successful build to a checksummed download', () => {
    const dl = resolvePurpurDownload('1.21.4', purpurBuild)
    expect(dl).toEqual({
      build: '2416',
      url: 'https://api.purpurmc.org/v2/purpur/1.21.4/2416/download',
      fileName: 'purpur-1.21.4-2416.jar',
      checksum: { algorithm: 'md5', value: 'e3832b46efa4a2a56d31bc7ce26df6f0' }
    })
  })

  it('rejects failed builds, missing checksums and odd versions', () => {
    expect(() => resolvePurpurDownload('1.21.4', { build: '5', result: 'FAILURE', md5: 'a'.repeat(32) })).toThrow(
      /did not build/
    )
    expect(() => resolvePurpurDownload('1.21.4', { build: '5', result: 'SUCCESS' })).toThrow(/checksum/)
    expect(() => resolvePurpurDownload('1.21.4', { build: '../x', result: 'SUCCESS', md5: 'a'.repeat(32) })).toThrow(
      /malformed/
    )
    expect(() => resolvePurpurDownload('1.21.4/../..', purpurBuild)).toThrow(/Invalid Minecraft version/)
  })

  it('tolerates malformed responses', () => {
    expect(parsePurpurVersions({})).toEqual([])
    expect(parsePurpurBuilds({ builds: {} })).toEqual([])
    expect(parsePurpurBuilds(null)).toEqual([])
  })
})

describe('assertTrustedHost', () => {
  it('accepts the domain and its subdomains over https', () => {
    expect(() => assertTrustedHost('https://papermc.io/x', ['papermc.io'])).not.toThrow()
    expect(() => assertTrustedHost('https://fill-data.papermc.io/x', ['papermc.io'])).not.toThrow()
  })

  it('rejects look-alikes, http and garbage', () => {
    expect(() => assertTrustedHost('https://notpapermc.io/x', ['papermc.io'])).toThrow()
    expect(() => assertTrustedHost('http://papermc.io/x', ['papermc.io'])).toThrow()
    expect(() => assertTrustedHost('not a url', ['papermc.io'])).toThrow(/malformed/)
  })
})

describe('isValidBuildId', () => {
  it('accepts plain numbers only', () => {
    expect(isValidBuildId('232')).toBe(true)
    expect(isValidBuildId('')).toBe(false)
    expect(isValidBuildId('232/../x')).toBe(false)
    expect(isValidBuildId('latest')).toBe(false)
    expect(isValidBuildId(232)).toBe(false)
  })
})
