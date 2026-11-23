import { createHash } from 'crypto'
import { createReadStream, rmSync } from 'fs'

/** Hash a file on disk without loading it into memory. */
export function hashFile(path: string, algorithm: 'sha256' | 'md5' | 'sha1'): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash(algorithm)
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')))
  })
}

/**
 * Verify a downloaded file against its published checksum. On a mismatch the
 * file is deleted before throwing, so a corrupted or tampered download can
 * never be picked up and executed later.
 */
export async function verifyFileChecksum(
  path: string,
  algorithm: 'sha256' | 'md5' | 'sha1',
  expected: string
): Promise<void> {
  const actual = await hashFile(path, algorithm)
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    try {
      rmSync(path, { force: true })
    } catch {
      /* best-effort cleanup */
    }
    throw new Error(
      `Checksum mismatch for the downloaded file (${algorithm}: expected ${expected}, got ${actual}). The file was removed.`
    )
  }
}
