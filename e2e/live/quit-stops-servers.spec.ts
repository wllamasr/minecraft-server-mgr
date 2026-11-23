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

    // ── Restart ───────────────────────────────────────────
    const firstPid = (await server()).pid as number
    expect(isAlive(firstPid)).toBe(true)
    await page.evaluate((sid) => (window as unknown as ApiWindow).api.restartServer(sid), id)
    // restartServer resolves once the old process is gone and the new one is launched.
    expect(isAlive(firstPid)).toBe(false)
    await expect.poll(async () => (await server()).pid, { timeout: 30_000 }).not.toBe(firstPid)
    // The console starts over with each run, so this "Done" is the second boot.
    await expect.poll(logText, { timeout: 6 * 60_000, intervals: [2000] }).toMatch(/Done \(\d/)
    expect((await server()).status).toBe('running')
    // The first run went down through its own shutdown, not by force.
    expect(await logText()).not.toContain('killing the process')

    // ── Scheduled restart setting ─────────────────────────
    const settings = await page.evaluate(async (sid) => {
      const api = (window as unknown as ApiWindow).api
      const rejected = await api.updateServerSettings(sid, { restartSchedule: '4:30' }).then(() => '', (e: Error) => e.message)
      const saved = await api.updateServerSettings(sid, { restartSchedule: '04:30' })
      const reread = await api.getServer(sid)
      const cleared = await api.updateServerSettings(sid, { restartSchedule: null })
      return { rejected, saved: saved.restartSchedule, reread: reread.restartSchedule, cleared: cleared.restartSchedule }
    }, id)
    expect(settings.rejected).toMatch(/HH:MM/)
    expect(settings.saved).toBe('04:30')
    expect(settings.reread).toBe('04:30')
    expect(settings.cleared).toBeNull()

    // ── Scheduled restart, for real ───────────────────────
    // Two to three minutes ahead: late enough for the 1-minute warning.
    const due = new Date(Date.now() + 3 * 60_000)
    due.setSeconds(0, 0)
    const hhmm = `${String(due.getHours()).padStart(2, '0')}:${String(due.getMinutes()).padStart(2, '0')}`
    const scheduledPid = (await server()).pid as number
    await page.evaluate(
      ({ sid, at }) => (window as unknown as ApiWindow).api.updateServerSettings(sid, { restartSchedule: at }),
      { sid: id, at: hhmm }
    )
    await expect.poll(logText, { timeout: 3 * 60_000, intervals: [2000] }).toContain('Scheduled restart in 1 minute')
    // Players are told in chat too: the server echoes the say command.
    await expect.poll(logText, { timeout: 15_000 }).toMatch(/\[Server\] Scheduled restart in 1 minute/)
    await expect.poll(async () => (await server()).pid, { timeout: 2 * 60_000, intervals: [2000] }).not.toBe(scheduledPid)
    expect(isAlive(scheduledPid)).toBe(false)
    expect(Date.now()).toBeGreaterThanOrEqual(due.getTime())
    await expect.poll(logText, { timeout: 6 * 60_000, intervals: [2000] }).toMatch(/Done \(\d/)
    await page.evaluate(
      (sid) => (window as unknown as ApiWindow).api.updateServerSettings(sid, { restartSchedule: null }),
      id
    )

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
