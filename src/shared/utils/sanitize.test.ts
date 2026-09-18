import { describe, it, expect } from 'vitest'
import { sanitizeServerName } from './sanitize'

describe('sanitizeServerName', () => {
  it('keeps alphanumerics, underscores and hyphens', () => {
    expect(sanitizeServerName('My_Server-01')).toBe('My_Server-01')
  })

  it('replaces spaces with underscores', () => {
    expect(sanitizeServerName('Survival World')).toBe('Survival_World')
  })

  it('neutralizes path separators and traversal characters', () => {
    expect(sanitizeServerName('../etc/passwd')).toBe('___etc_passwd')
    expect(sanitizeServerName('a\\b/c')).toBe('a_b_c')
  })

  it('replaces characters that are invalid in Windows filenames', () => {
    expect(sanitizeServerName('name:with*bad?chars')).toBe('name_with_bad_chars')
  })

  it('handles unicode by replacing non-ASCII characters', () => {
    expect(sanitizeServerName('café ☕')).toBe('caf___')
  })
})
