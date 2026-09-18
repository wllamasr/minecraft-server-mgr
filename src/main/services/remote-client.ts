import https from 'https'
import { createHash } from 'crypto'
import type { TLSSocket } from 'tls'

/**
 * Connection parameters for a remote daemon. The daemon uses a self-signed
 * certificate, so TLS chain validation is disabled and the certificate is
 * instead pinned by its SHA-256 fingerprint (trust on first use). A mismatch
 * aborts the request, which is what protects against a man-in-the-middle.
 */
export interface HostConn {
  baseUrl: string
  token?: string
  fingerprint?: string
  onFingerprint?: (fp: string) => void
}

function peerFingerprint(socket: TLSSocket): string {
  const cert = socket.getPeerCertificate()
  if (!cert || !cert.raw) return ''
  return createHash('sha256').update(cert.raw).digest('hex')
}

/** Make an authenticated JSON request to a daemon, verifying the pinned cert. */
export function remoteRequest<T = unknown>(
  conn: HostConn,
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, conn.baseUrl)
    const data = body !== undefined ? JSON.stringify(body) : undefined

    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port || 8443,
        path: url.pathname + url.search,
        method,
        rejectUnauthorized: false,
        // No connection pooling: force a fresh TLS handshake per request so the
        // certificate fingerprint is verified on every call (a reused socket
        // would skip the secureConnect check below).
        agent: false,
        timeout: 30000,
        headers: {
          'Content-Type': 'application/json',
          ...(conn.token ? { Authorization: `Bearer ${conn.token}` } : {}),
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
        }
      },
      (res) => {
        let buf = ''
        res.on('data', (c) => (buf += c))
        res.on('end', () => {
          const status = res.statusCode || 0
          if (status >= 200 && status < 300) {
            try {
              resolve(buf ? (JSON.parse(buf) as T) : (undefined as T))
            } catch (e) {
              reject(e)
            }
          } else {
            let msg = buf
            try {
              msg = JSON.parse(buf).error || buf
            } catch {
              /* keep raw */
            }
            reject(new Error(`Daemon HTTP ${status}: ${msg}`))
          }
        })
      }
    )

    req.on('socket', (socket) => {
      socket.on('secureConnect', () => {
        const fp = peerFingerprint(socket as TLSSocket)
        conn.onFingerprint?.(fp)
        if (conn.fingerprint && fp.toLowerCase() !== conn.fingerprint.toLowerCase()) {
          req.destroy(new Error('Certificate fingerprint mismatch (possible MITM) — refusing to connect'))
        }
      })
    })
    req.on('timeout', () => req.destroy(new Error('Daemon request timed out')))
    req.on('error', reject)

    if (data) req.write(data)
    req.end()
  })
}

/**
 * Pair with a daemon: connect (capturing its certificate fingerprint via
 * trust-on-first-use) and validate the pairing token.
 */
export async function pairHost(
  baseUrl: string,
  token: string
): Promise<{ fingerprint: string; info: Record<string, unknown> }> {
  let fingerprint = ''
  const conn: HostConn = { baseUrl, token, onFingerprint: (fp) => (fingerprint = fp) }
  const res = await remoteRequest<{ info: Record<string, unknown> }>(conn, 'POST', '/v1/pair', { token })
  if (!fingerprint) throw new Error('Could not read the daemon certificate fingerprint')
  return { fingerprint, info: res.info }
}
