import https from 'https'
import http from 'http'
import { createWriteStream, mkdirSync, rmSync } from 'fs'
import { dirname } from 'path'
import log from './logger'

export interface DownloadProgress {
  percent: number
  transferred: number
  total: number
}

const MAX_REDIRECTS = 5
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308])
const IDLE_TIMEOUT_MS = 30000

/**
 * Download a file from a URL to a local path with progress reporting.
 *
 * - Follows at most {@link MAX_REDIRECTS} redirects (relative `Location`
 *   headers are resolved against the current URL).
 * - Refuses a redirect from https to http.
 * - Removes the partial file when the download fails, so a broken jar is never
 *   left behind looking like a complete one.
 */
export function downloadFile(
  url: string,
  destPath: string,
  onProgress?: (progress: DownloadProgress) => void
): Promise<void> {
  mkdirSync(dirname(destPath), { recursive: true })
  return fetchToFile(url, destPath, onProgress, 0)
}

function fetchToFile(
  url: string,
  destPath: string,
  onProgress: ((progress: DownloadProgress) => void) | undefined,
  redirects: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      reject(new Error(`Invalid download URL: ${url}`))
      return
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      reject(new Error(`Unsupported download protocol: ${parsed.protocol}`))
      return
    }

    const protocol = parsed.protocol === 'https:' ? https : http

    let settled = false
    const fail = (err: Error, removePartial: boolean): void => {
      if (settled) return
      settled = true
      if (removePartial) {
        try {
          rmSync(destPath, { force: true })
        } catch {
          /* best-effort cleanup */
        }
      }
      reject(err)
    }

    const request = protocol.get(parsed, (response) => {
      const status = response.statusCode ?? 0

      if (REDIRECT_STATUS.has(status)) {
        response.resume()
        const location = response.headers.location
        if (!location) {
          fail(new Error(`Failed to download: HTTP ${status} without a Location header`), false)
          return
        }
        if (redirects >= MAX_REDIRECTS) {
          fail(new Error('Failed to download: too many redirects'), false)
          return
        }
        let next: URL
        try {
          next = new URL(location, parsed)
        } catch {
          fail(new Error('Failed to download: invalid redirect target'), false)
          return
        }
        if (parsed.protocol === 'https:' && next.protocol !== 'https:') {
          fail(new Error('Failed to download: refusing redirect from https to an insecure URL'), false)
          return
        }
        settled = true
        fetchToFile(next.toString(), destPath, onProgress, redirects + 1).then(resolve, reject)
        return
      }

      if (status !== 200) {
        response.resume()
        fail(new Error(`Failed to download: HTTP ${status}`), false)
        return
      }

      const totalBytes = parseInt(response.headers['content-length'] || '0', 10)
      let downloadedBytes = 0

      const file = createWriteStream(destPath)

      response.on('data', (chunk: Buffer) => {
        downloadedBytes += chunk.length
        if (onProgress && totalBytes > 0) {
          onProgress({
            percent: (downloadedBytes / totalBytes) * 100,
            transferred: downloadedBytes,
            total: totalBytes
          })
        }
      })

      // The connection dropped or the body was cut short.
      response.on('error', (err) => {
        file.destroy()
        fail(err, true)
      })
      response.on('aborted', () => {
        file.destroy()
        fail(new Error('Download interrupted'), true)
      })

      response.pipe(file)

      file.on('finish', () => {
        file.close(() => {
          if (settled) return
          if (totalBytes > 0 && downloadedBytes !== totalBytes) {
            fail(new Error(`Download incomplete: got ${downloadedBytes} of ${totalBytes} bytes`), true)
            return
          }
          settled = true
          log.info(`[Download] Completed: ${destPath}`)
          resolve()
        })
      })

      file.on('error', (err) => {
        file.destroy()
        fail(err, true)
      })
    })

    request.on('error', (err) => fail(err, true))
    request.setTimeout(IDLE_TIMEOUT_MS, () => {
      request.destroy(new Error('Download timed out'))
    })
  })
}
