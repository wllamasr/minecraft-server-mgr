import { describe, it, expect } from 'vitest'
import { buildJvmArgs, isValidRam, ramToMb, isJvmProfile, AIKAR_FLAGS } from './jvm'

describe('isValidRam / ramToMb', () => {
  it('accepts megabyte and gigabyte sizes', () => {
    expect(isValidRam('512M')).toBe(true)
    expect(isValidRam('8G')).toBe(true)
    expect(ramToMb('512M')).toBe(512)
    expect(ramToMb('8G')).toBe(8192)
  })

  it('rejects anything that could smuggle extra JVM arguments', () => {
    for (const bad of ['', '0G', '4', '4g', '4GB', '-4G', '4G -XX:+Foo', '4G\n-Dx=y', undefined, 4]) {
      expect(isValidRam(bad)).toBe(false)
    }
    expect(() => ramToMb('4G -javaagent:evil.jar')).toThrow(/Invalid memory size/)
  })
})

describe('isJvmProfile', () => {
  it('knows the two profiles', () => {
    expect(isJvmProfile('default')).toBe(true)
    expect(isJvmProfile('aikar')).toBe(true)
    expect(isJvmProfile('zgc')).toBe(false)
    expect(isJvmProfile(null)).toBe(false)
  })
})

describe('buildJvmArgs', () => {
  it('default profile only sets the heap', () => {
    expect(buildJvmArgs({ minRam: '1G', maxRam: '2G' })).toEqual(['-Xms1G', '-Xmx2G'])
    expect(buildJvmArgs({ minRam: '1G', maxRam: '2G', profile: 'default' })).toEqual(['-Xms1G', '-Xmx2G'])
    expect(buildJvmArgs({ minRam: '1G', maxRam: '2G', profile: null })).toEqual(['-Xms1G', '-Xmx2G'])
  })

  it('aikar profile pins the heap and appends the flags in order', () => {
    const args = buildJvmArgs({ minRam: '4G', maxRam: '8G', profile: 'aikar' })
    expect(args.slice(0, 2)).toEqual(['-Xms8G', '-Xmx8G'])
    expect(args.slice(2)).toEqual([...AIKAR_FLAGS])
  })

  it('unlocks experimental options before using them', () => {
    const args = buildJvmArgs({ minRam: '8G', maxRam: '8G', profile: 'aikar' })
    const unlock = args.indexOf('-XX:+UnlockExperimentalVMOptions')
    expect(unlock).toBeGreaterThan(-1)
    for (const experimental of ['-XX:G1NewSizePercent=30', '-XX:G1MaxNewSizePercent=40', '-XX:G1MixedGCLiveThresholdPercent=90']) {
      expect(args.indexOf(experimental)).toBeGreaterThan(unlock)
    }
  })

  it('never emits an argument containing whitespace', () => {
    for (const arg of buildJvmArgs({ minRam: '8G', maxRam: '8G', profile: 'aikar' })) {
      expect(arg).not.toMatch(/\s/)
    }
  })

  it('rejects malformed or inverted memory settings', () => {
    expect(() => buildJvmArgs({ minRam: '4G', maxRam: '2G' })).toThrow(/cannot exceed/)
    expect(() => buildJvmArgs({ minRam: '1G', maxRam: '2G -Dfoo=bar' })).toThrow(/Invalid maximum memory/)
    expect(() => buildJvmArgs({ minRam: 'lots', maxRam: '2G' })).toThrow(/Invalid minimum memory/)
  })

  it('compares sizes across units', () => {
    expect(buildJvmArgs({ minRam: '512M', maxRam: '1G' })).toEqual(['-Xms512M', '-Xmx1G'])
    expect(() => buildJvmArgs({ minRam: '2048M', maxRam: '1G' })).toThrow(/cannot exceed/)
  })
})
