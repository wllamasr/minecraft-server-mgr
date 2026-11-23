import { describe, it, expect } from 'vitest'
import { getRequiredJavaMajor, isReleaseVersion, compareVersionsDesc } from './minecraft-version'

describe('getRequiredJavaMajor', () => {
  // Expected values are Mojang's published javaVersion.majorVersion per version.
  it('requires Java 25 for the year-based versions (26.x)', () => {
    expect(getRequiredJavaMajor('26.1')).toBe(25)
    expect(getRequiredJavaMajor('26.1.2')).toBe(25)
    expect(getRequiredJavaMajor('26.3')).toBe(25)
    expect(getRequiredJavaMajor('27.1')).toBe(25)
  })

  it('requires Java 21 for 1.20.5 through 1.21.x', () => {
    expect(getRequiredJavaMajor('1.20.5')).toBe(21)
    expect(getRequiredJavaMajor('1.20.6')).toBe(21)
    expect(getRequiredJavaMajor('1.21')).toBe(21)
    expect(getRequiredJavaMajor('1.21.4')).toBe(21)
    expect(getRequiredJavaMajor('1.21.11')).toBe(21)
  })

  it('requires Java 17 for 1.17 through 1.20.4', () => {
    expect(getRequiredJavaMajor('1.17')).toBe(17)
    expect(getRequiredJavaMajor('1.19.4')).toBe(17)
    expect(getRequiredJavaMajor('1.20')).toBe(17)
    expect(getRequiredJavaMajor('1.20.4')).toBe(17)
  })

  it('requires Java 8 for legacy versions', () => {
    expect(getRequiredJavaMajor('1.16.5')).toBe(8)
    expect(getRequiredJavaMajor('1.12.2')).toBe(8)
  })

  it('tolerates pre-release suffixes', () => {
    expect(getRequiredJavaMajor('1.21.11-rc3')).toBe(21)
    expect(getRequiredJavaMajor('26.3-rc-3')).toBe(25)
  })
})

describe('isReleaseVersion', () => {
  it('accepts final releases only', () => {
    expect(isReleaseVersion('1.21.4')).toBe(true)
    expect(isReleaseVersion('1.21')).toBe(true)
    expect(isReleaseVersion('26.3')).toBe(true)
    expect(isReleaseVersion('1.21.11-rc3')).toBe(false)
    expect(isReleaseVersion('1.21.9-pre4')).toBe(false)
    expect(isReleaseVersion('26.3-rc-3')).toBe(false)
    expect(isReleaseVersion('26.4-snapshot-10')).toBe(false)
  })
})

describe('compareVersionsDesc', () => {
  it('sorts newest first, numerically', () => {
    const sorted = ['1.21.4', '1.21.11', '26.1.2', '1.21', '1.20.6', '26.3'].sort(compareVersionsDesc)
    expect(sorted).toEqual(['26.3', '26.1.2', '1.21.11', '1.21.4', '1.21', '1.20.6'])
  })
})
