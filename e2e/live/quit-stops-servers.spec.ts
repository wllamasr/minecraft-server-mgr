import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

/**
 * Live test: quitting the app while a server is running shuts that server down
 * cleanly instead of leaving its Java process behind.
 *
 * Opt-in, like the other live tests (network, Java 21, a few minutes):
 *
 *   npm run build
 *   MSM_E2E_LIVE=1 npx playwright test e2e/live
 */
const LIVE = !!process.env.MSM_E2E_LIVE
const MC_VERSION = process.env.MSM_E2E_LIVE_MC || '1.21.11'
const PORT = Number(process.env.MSM_E2E_LIVE_PORT || 25599) + 3

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ApiWindow = { api: Record<string, (...args: any[]) => Promise<any>> }

const repoRoot = resolve(__dirname, '..', '..')

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test.skip(!LIVE, 'Set MSM_E2E_LIVE=1 to run the live server test')
test.setTimeout(10 * 60_000)

test('quitting the app stops a running server cleanly', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'msm-quit-'))
  const app = await electron.launch({ cwd: repoRoot, args: ['.', `--user-data-dir=${userDataDir}`] })
  let pid: number | undefined
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')

    const id: string = await page.evaluate(
      async ({ mc, port }) => {
        const api = (window as unknown as ApiWindow).api
        const builds: { version: string; stable: boolean }[] = await api.getModLoaderVersions('paper', mc)
        const build = (builds.find((b) => b.stable) ?? builds[0]).version
        const created = await api.createServer({
          name: 'Live Quit', minecraftVersion: mc, port, minRam: '1G', maxRam: '2G',
          modLoader: 'paper', modLoaderVersion: build
        })
        return created.id
      },
      { mc: MC_VERSION, port: PORT }
    )

    const server = (): Promise<{ status: string; pid?: number; absolutePath: string }> =>
      page.evaluate((sid) => (window as unknown as ApiWindow).api.getServer(sid), id)
    const logText = (): Promise<string> =>
      page.evaluate(async (sid) => (await (window as unknown as ApiWindow).api.getServerLogs(sid)).map((l: { line: string }) => l.line).join('\n'), id)

    await expect.poll(async () => (await server()).status, { timeout: 5 * 60_000, intervals: [1000] }).toBe('stopped')
    await page.evaluate((sid) => (window as unknown as ApiWindow).api.startServer(sid), id)
    await expect.poll(logText, { timeout: 6 * 60_000, intervals: [2000] }).toMatch(/Done \(\d/)

    const running = await server()
    pid = running.pid
    expect(pid).toBeTruthy()
    expect(isAlive(pid as number)).toBe(true)

    // Quit like a user would. The app holds the quit until the server is down.
    await app.close()

    expect(isAlive(pid as number)).toBe(false)
    // The server went through its own shutdown: it saved before it exited.
    const latest = readFileSync(join(running.absolutePath, 'logs', 'latest.log'), 'utf8')
    expect(latest).toMatch(/Stopping (the )?server/)
    expect(latest).toMatch(/All dimensions are saved/)
  } finally {
    await app.close().catch(() => undefined)
    // Never leave a Java process behind, whatever the test outcome.
    if (pid && isAlive(pid)) process.kill(pid)
    try {
      rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 })
    } catch {
      /* disposable temp dir */
    }
  }
})
