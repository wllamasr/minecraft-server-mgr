import { describe, it, expect } from 'vitest'
import { isSafeExternalUrl } from './url'

describe('isSafeExternalUrl', () => {
  it('accepts http and https links', () => {
    expect(isSafeExternalUrl('https://adoptium.net/temurin/releases/')).toBe(true)
    expect(isSafeExternalUrl('http://example.com')).toBe(true)
  })

  it('rejects schemes that can launch local programs or files', () => {
    expect(isSafeExternalUrl('file:///C:/Windows/System32/calc.exe')).toBe(false)
    expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false)
    expect(isSafeExternalUrl('ms-msdt:/id PCWDiagnostic')).toBe(false)
    expect(isSafeExternalUrl('smb://host/share')).toBe(false)
    expect(isSafeExternalUrl('\\\\host\\share\\evil.exe')).toBe(false)
  })

  it('rejects malformed and non-string input', () => {
    expect(isSafeExternalUrl('')).toBe(false)
    expect(isSafeExternalUrl('not a url')).toBe(false)
    expect(isSafeExternalUrl(undefined)).toBe(false)
    expect(isSafeExternalUrl({ href: 'https://example.com' })).toBe(false)
  })
})
