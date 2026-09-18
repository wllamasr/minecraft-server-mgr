import { describe, it, expect } from 'vitest'
import { formatBytes, formatProgress } from './format'

describe('formatBytes', () => {
  it('formats zero and negatives as "0 B"', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(-5)).toBe('0 B')
  })

  it('formats bytes without decimals', () => {
    expect(formatBytes(512)).toBe('512 B')
  })

  it('formats KB/MB/GB with one decimal', () => {
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(1048576)).toBe('1.0 MB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
    expect(formatBytes(2 * 1024 * 1024 * 1024)).toBe('2.0 GB')
  })

  it('caps at the largest known unit', () => {
    expect(formatBytes(3 * 1024 ** 4)).toBe('3.0 TB')
  })
})

describe('formatProgress', () => {
  it('shows only the transferred amount when total is unknown', () => {
    expect(formatProgress(1048576, 0)).toBe('1.0 MB')
  })

  it('shows percent and both sizes when total is known', () => {
    expect(formatProgress(1048576, 2097152)).toBe('50% (1.0 MB / 2.0 MB)')
  })

  it('clamps percent to 100', () => {
    expect(formatProgress(3000, 2000)).toContain('100%')
  })
})
