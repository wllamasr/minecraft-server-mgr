import { describe, it, expect, vi } from 'vitest'

// java-detector imports the electron-log based logger transitively; stub it so
// the module can be imported in a plain Node test environment.
vi.mock('../utils/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))

import { parseJavaVersion, getRequiredJavaMajor, findBestJava } from './java-detector'
import type { JavaInstallation } from '../../shared/types'

describe('parseJavaVersion', () => {
  it('parses modern OpenJDK output (major = leading number)', () => {
    const out = 'openjdk version "21.0.2" 2024-01-16\nOpenJDK 64-Bit Server VM'
    expect(parseJavaVersion(out)).toEqual({ version: '21.0.2', major: 21, is64Bit: true })
  })

  it('parses legacy 1.8 output (major = second number)', () => {
    const out = 'java version "1.8.0_401"\nJava(TM) SE Runtime Environment'
    const parsed = parseJavaVersion(out)
    expect(parsed?.major).toBe(8)
    expect(parsed?.is64Bit).toBe(false)
  })

  it('detects 64-bit builds', () => {
    const out = 'openjdk version "17.0.10"\nOpenJDK 64-Bit Server VM (build 17.0.10)'
    expect(parseJavaVersion(out)?.is64Bit).toBe(true)
  })

  it('returns null for unrecognized output', () => {
    expect(parseJavaVersion('not a java version string')).toBeNull()
  })
})

describe('getRequiredJavaMajor', () => {
  it('requires Java 21 for 1.20.5+ / 1.21', () => {
    expect(getRequiredJavaMajor('1.21')).toBe(21)
    expect(getRequiredJavaMajor('1.21.4')).toBe(21)
  })

  it('requires Java 17 for 1.17 - 1.20', () => {
    expect(getRequiredJavaMajor('1.17')).toBe(17)
    expect(getRequiredJavaMajor('1.19.4')).toBe(17)
  })

  it('requires Java 8 for legacy versions', () => {
    expect(getRequiredJavaMajor('1.16.5')).toBe(8)
    expect(getRequiredJavaMajor('1.12.2')).toBe(8)
  })
})

describe('findBestJava', () => {
  const j = (major: number, is64Bit = true): JavaInstallation => ({
    path: `/java/${major}${is64Bit ? '' : '-32'}`,
    version: `${major}.0.0`,
    major,
    is64Bit
  })

  it('returns null when no installation meets the minimum', () => {
    expect(findBestJava('1.21', [j(8), j(17)])).toBeNull()
  })

  it('picks the highest compatible major version', () => {
    const best = findBestJava('1.17', [j(17), j(21), j(8)])
    expect(best?.major).toBe(21)
  })

  it('prefers a 64-bit build over a higher 32-bit one', () => {
    const best = findBestJava('1.17', [j(21, false), j(17, true)])
    expect(best?.major).toBe(17)
    expect(best?.is64Bit).toBe(true)
  })

  it('respects the minimum required version for the MC release', () => {
    const best = findBestJava('1.16.5', [j(8), j(11)])
    expect(best?.major).toBe(11)
  })
})
