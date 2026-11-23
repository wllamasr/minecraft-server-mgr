import { app } from 'electron'
import https from 'https'
import http from 'http'
import type { IncomingMessage } from 'http'

/**
 * Identifies the app to the APIs it calls. PaperMC and Modrinth ask clients
 * for a descriptive User-Agent instead of a generic one, so it carries the
 * project name and the app version. It names no person, account or machine.
 */
export const USER_AGENT = `minecraft-server-mgr/${app.getVersion()}`

const MAX_REDIRECTS = 5
const TIMEOUT_MS = 20000
const MAX_BODY_BYTES = 20 * 1024 * 1024

/** GET a URL and return the response body as text. */
export function fetchText(url: string, redirects = 0): Promise<string> {
  return new Promise((resolve, reject) => {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      reject(new Error(`Invalid URL: ${url}`))
      return
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      reject(new Error(`Unsupported protocol: ${parsed.protocol}`))
      return
    }

    const client = parsed.protocol === 'https:' ? https : http
    const request = client.get(
      parsed,
      { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json, text/plain, */*' } },
      (res: IncomingMessage) => {
        const status = res.statusCode ?? 0

        if ([301, 302, 303, 307, 308].includes(status)) {
          res.resume()
          const location = res.headers.location
          if (!location || redirects >= MAX_REDIRECTS) {
            reject(new Error(`HTTP ${status} for ${url}: too many redirects`))
            return
          }
          const next = new URL(location, parsed)
          if (parsed.protocol === 'https:' && next.protocol !== 'https:') {
            reject(new Error(`Refusing redirect from https to an insecure URL for ${url}`))
            return
          }
          fetchText(next.toString(), redirects + 1).then(resolve, reject)
          return
        }

        if (status !== 200) {
          res.resume()
          reject(new Error(`HTTP ${status} for ${url}`))
          return
        }

        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > MAX_BODY_BYTES) {
            request.destroy(new Error(`Response too large for ${url}`))
            return
          }
          chunks.push(chunk)
        })
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
        res.on('error', reject)
      }
    )

    request.on('error', reject)
    request.setTimeout(TIMEOUT_MS, () => request.destroy(new Error(`Request timed out for ${url}`)))
  })
}

/** GET a URL and parse the response body as JSON. */
export async function fetchJson<T = unknown>(url: string): Promise<T> {
  const body = await fetchText(url)
  try {
    return JSON.parse(body) as T
  } catch {
    throw new Error(`Invalid JSON from ${url}`)
  }
}
