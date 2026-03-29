import https from 'https'
import http from 'http'
import { createWriteStream, mkdirSync } from 'fs'
import { dirname } from 'path'
import log from './logger'

export interface DownloadProgress {
  percent: number
  transferred: number
  total: number
}

/**
 * Download a file from a URL to a local path with progress reporting.
 */
export function downloadFile(
  url: string,
  destPath: string,
  onProgress?: (progress: DownloadProgress) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    mkdirSync(dirname(destPath), { recursive: true })

    const protocol = url.startsWith('https') ? https : http

    const request = protocol.get(url, (response) => {
      // Handle redirects
      if (response.statusCode === 301 || response.statusCode === 302) {
        const redirectUrl = response.headers.location
        if (redirectUrl) {
          downloadFile(redirectUrl, destPath, onProgress).then(resolve).catch(reject)
          return
        }
      }

      if (response.statusCode !== 200) {
        reject(new Error(`Failed to download: HTTP ${response.statusCode}`))
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

      response.pipe(file)

      file.on('finish', () => {
        file.close()
        log.info(`[Download] Completed: ${destPath}`)
        resolve()
      })

      file.on('error', (err) => {
        file.close()
        reject(err)
      })
    })

    request.on('error', reject)
    request.setTimeout(30000, () => {
      request.destroy()
      reject(new Error('Download timed out'))
    })
  })
}
