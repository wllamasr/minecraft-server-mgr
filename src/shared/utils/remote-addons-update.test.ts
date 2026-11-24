import { describe, expect, it } from 'vitest'
import type { UnifiedModVersion } from '../types'
import { addonUpdateTo, isPluginOperation } from './remote-addons'

const version = (id: string, type: UnifiedModVersion['type'] = 'release'): UnifiedModVersion =>
  ({ id, type, versionNumber: id.toLowerCase(), name: id, fileName: `${id}.jar` }) as UnifiedModVersion

describe('addonUpdateTo', () => {
  // Newest first, as Modrinth lists them.
  const listed = [version('V4', 'beta'), version('V3'), version('V2'), version('V1')]

  it('offers the newest release over an older installed one', () => {
    expect(addonUpdateTo(listed, 'V1')?.id).toBe('V3')
    expect(addonUpdateTo(listed, 'V2')?.id).toBe('V3')
  })

  it('offers nothing for the version that is installed', () => {
    expect(addonUpdateTo(listed, 'V3')).toBeNull()
  })

  it('offers nothing when the installed version is newer than the release', () => {
    expect(addonUpdateTo(listed, 'V4')).toBeNull()
  })

  it('offers nothing for a version that is no longer listed for this server', () => {
    expect(addonUpdateTo(listed, 'GONE')).toBeNull()
  })

  it('offers nothing when there is no version at all', () => {
    expect(addonUpdateTo([], 'V1')).toBeNull()
  })
})

describe('isPluginOperation', () => {
  it('covers the installation and the update of a plugin, and nothing else', () => {
    expect(isPluginOperation('install')).toBe(true)
    expect(isPluginOperation('update')).toBe(true)
    expect(isPluginOperation('backup')).toBe(false)
    expect(isPluginOperation('restore')).toBe(false)
  })
})
