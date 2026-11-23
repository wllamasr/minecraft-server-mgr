import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import http from 'http'
import type { AddressInfo } from 'net'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('./logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))

import { downloadFile } from './download'

let server: http.Server
let base: string
let dir: string

beforeAll(async () => {
  server = http.createServer((req, res) => {
    switch (req.url) {
      case '/file':
        res.writeHead(200, { 'Content-Length': '5' })
        res.end('hello')
        break
      case '/redirect-relative':
        res.writeHead(302, { Location: '/file' })
        res.end()
        break
      case '/redirect-308':
        res.writeHead(308, { Location: `${base}/file` })
        res.end()
        break
      case '/loop':
        res.writeHead(302, { Location: '/loop' })
        res.end()
        break
      case '/no-location':
        res.writeHead(302)
        res.end()
        break
      case '/truncated':
        // Promise 100 bytes, send 3, then drop the connection.
        res.writeHead(200, { 'Content-Length': '100' })
        res.write('abc')
        setTimeout(() => res.destroy(), 20)
        break
      default:
        res.writeHead(404)
        res.end()
    }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'msm-dl-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('downloadFile', () => {
  it('downloads a file and reports progress', async () => {
    const dest = join(dir, 'nested', 'a.bin')
    const seen: number[] = []
    await downloadFile(`${base}/file`, dest, (p) => seen.push(p.transferred))
    expect(readFileSync(dest, 'utf8')).toBe('hello')
    expect(seen.at(-1)).toBe(5)
  })

  it('follows a relative redirect', async () => {
    const dest = join(dir, 'b.bin')
    await downloadFile(`${base}/redirect-relative`, dest)
    expect(readFileSync(dest, 'utf8')).toBe('hello')
  })

  it('follows a 308 redirect', async () => {
    const dest = join(dir, 'c.bin')
    await downloadFile(`${base}/redirect-308`, dest)
    expect(readFileSync(dest, 'utf8')).toBe('hello')
  })

  it('gives up on a redirect loop', async () => {
    await expect(downloadFile(`${base}/loop`, join(dir, 'd.bin'))).rejects.toThrow(/too many redirects/)
  })

  it('rejects a redirect without a Location header', async () => {
    await expect(downloadFile(`${base}/no-location`, join(dir, 'e.bin'))).rejects.toThrow(/Location/)
  })

  it('rejects a non-200 response and leaves no file', async () => {
    const dest = join(dir, 'f.bin')
    await expect(downloadFile(`${base}/missing`, dest)).rejects.toThrow(/HTTP 404/)
    expect(existsSync(dest)).toBe(false)
  })

  it('removes the partial file when the body is cut short', async () => {
    const dest = join(dir, 'g.bin')
    await expect(downloadFile(`${base}/truncated`, dest)).rejects.toThrow()
    expect(existsSync(dest)).toBe(false)
  })

  it('rejects unsupported protocols', async () => {
    await expect(downloadFile('file:///etc/passwd', join(dir, 'h.bin'))).rejects.toThrow(/Unsupported/)
    await expect(downloadFile('not a url', join(dir, 'i.bin'))).rejects.toThrow(/Invalid/)
  })
})
