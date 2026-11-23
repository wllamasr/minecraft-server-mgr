import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { hashFile, verifyFileChecksum } from './checksum'

// Well-known digests of the ASCII string "hello".
const HELLO_SHA256 = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
const HELLO_MD5 = '5d41402abc4b2a76b9719d911017c592'

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'msm-sum-'))
  file = join(dir, 'server.jar')
  writeFileSync(file, 'hello')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('hashFile', () => {
  it('computes sha256 and md5', async () => {
    expect(await hashFile(file, 'sha256')).toBe(HELLO_SHA256)
    expect(await hashFile(file, 'md5')).toBe(HELLO_MD5)
  })

  it('rejects for a missing file', async () => {
    await expect(hashFile(join(dir, 'nope'), 'sha256')).rejects.toThrow()
  })
})

describe('verifyFileChecksum', () => {
  it('accepts a matching checksum, case-insensitively, and keeps the file', async () => {
    await expect(verifyFileChecksum(file, 'sha256', HELLO_SHA256.toUpperCase())).resolves.toBeUndefined()
    expect(existsSync(file)).toBe(true)
  })

  it('deletes the file and throws on a mismatch', async () => {
    await expect(verifyFileChecksum(file, 'sha256', 'a'.repeat(64))).rejects.toThrow(/Checksum mismatch/)
    expect(existsSync(file)).toBe(false)
  })
})
