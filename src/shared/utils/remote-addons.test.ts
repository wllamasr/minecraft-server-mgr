import { describe, it, expect } from 'vitest'
import { isAddonFile, isModrinthVersionId, pickAddonVersion, readRemoteAddons } from './remote-addons'
import type { UnifiedModVersion } from '../types'

describe('isAddonFile', () => {
  it('takes the names plugin jars have', () => {
    for (const ok of ['LuckPerms-Bukkit-5.4.145.jar', 'a.jar', 'Essentials X (2.20) [beta]+build.7.jar']) {
      expect(isAddonFile(ok)).toBe(true)
    }
  })

  // The same cases the daemon refuses (daemon/internal/addons).
  it('takes nothing that is a path, another kind of file or a device', () => {
    const bad = [
      '', '.jar', 'a.zip', 'a.jar.disabled', '../a.jar', 'a/b.jar', 'a\\b.jar', 'a..b.jar', '.hidden.jar',
      'con.jar', 'NUL.x.jar', 'com1.jar', 'a:b.jar', 'a\u0000.jar', 'ñ.jar', `${'a'.repeat(130)}.jar`,
      'a%2Fb.jar', 'a?b.jar', 'a#b.jar', null, undefined, 7
    ]
    for (const name of bad) expect(isAddonFile(name)).toBe(false)
  })
})

describe('isModrinthVersionId', () => {
  it('takes ids and nothing that could be more of a path', () => {
    expect(isModrinthVersionId('Xh3kRMAW')).toBe(true)
    for (const bad of ['', 'a/b', '../x', 'a?b', 'a b', 'a'.repeat(33), null, 5]) {
      expect(isModrinthVersionId(bad)).toBe(false)
    }
  })
})

describe('readRemoteAddons', () => {
  it('reads what a daemon lists', () => {
    const list = readRemoteAddons([
      { file: 'LuckPerms-5.4.jar', enabled: true, sizeBytes: 1024, modifiedAt: '2026-11-23T10:00:00Z', name: 'LuckPerms', version: '5.4', projectId: 'Vebnzrzj', versionId: 'Xh3kRMAW' },
      { file: 'Other.jar', enabled: false, sizeBytes: 5 }
    ])
    expect(list).toEqual([
      { file: 'LuckPerms-5.4.jar', enabled: true, sizeBytes: 1024, name: 'LuckPerms', version: '5.4', projectId: 'Vebnzrzj', versionId: 'Xh3kRMAW' },
      { file: 'Other.jar', enabled: false, sizeBytes: 5 }
    ])
  })

  it('leaves out what is not a plugin and cleans what it shows', () => {
    const list = readRemoteAddons([
      null,
      'x',
      { file: '../evil.jar', enabled: true },
      { file: 'NoState.jar' },
      { file: 'Odd.jar', enabled: true, sizeBytes: -4, name: `two\nlines\u001b[31m${'x'.repeat(200)}`, version: 7, projectId: 'a/b' }
    ])
    expect(list).toHaveLength(1)
    expect(list[0].file).toBe('Odd.jar')
    expect(list[0].sizeBytes).toBe(0)
    expect(list[0].name).toHaveLength(80)
    expect(list[0].name?.startsWith('twolines[31m')).toBe(true)
    expect(list[0].version).toBeUndefined()
    expect(list[0].projectId).toBeUndefined()
  })

  it('reads an answer that is no list as no plugins', () => {
    expect(readRemoteAddons(undefined)).toEqual([])
    expect(readRemoteAddons({ plugins: [] })).toEqual([])
  })
})

describe('pickAddonVersion', () => {
  const version = (id: string, type: UnifiedModVersion['type']): UnifiedModVersion => ({
    id, type, name: id, fileName: `${id}.jar`, versionNumber: '1', releaseDate: '', downloads: 0,
    loaders: [], gameVersions: [], dependencies: [], downloadUrl: '', fileSize: 1
  })

  it('prefers the newest release', () => {
    expect(pickAddonVersion([version('b1', 'beta'), version('r2', 'release'), version('r1', 'release')])?.id).toBe('r2')
  })

  it('falls back to the newest of any kind', () => {
    expect(pickAddonVersion([version('a1', 'alpha'), version('b1', 'beta')])?.id).toBe('a1')
  })

  it('has nothing to pick from an empty list or from ids that are none', () => {
    expect(pickAddonVersion([])).toBeNull()
    expect(pickAddonVersion([version('a/b', 'release')])).toBeNull()
  })
})
