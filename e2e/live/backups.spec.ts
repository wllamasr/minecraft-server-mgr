import { test, expect, _electron as electron } from '@playwright/test'
import { appendFileSync, copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

/**
 * Live test: back a running Paper server up, damage its files, restore the
 * backup and boot the restored world.
 *
 * Opt-in, like the other live tests (network, Java 21, a few minutes):
 *
 *   npm run build
 *   MSM_E2E_LIVE=1 npx playwright test e2e/live
 */
const LIVE = !!process.env.MSM_E2E_LIVE
const MC_VERSION = process.env.MSM_E2E_LIVE_MC || '1.21.11'
const PORT = Number(process.env.MSM_E2E_LIVE_PORT || 25599) + 6

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ApiWindow = { api: Record<string, (...args: any[]) => Promise<any>> }
interface Backup {
  id: string
  kind: string
  sizeBytes: number
  fileCount?: number
  whileRunning?: boolean
}

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
test.setTimeout(12 * 60_000)

test('backs up a running server, restores it and boots the restored world', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'msm-backup-live-'))
  const app = await electron.launch({ cwd: repoRoot, args: ['.', `--user-data-dir=${userDataDir}`] })
  let pid: number | undefined
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    const api = <T>(method: string, ...args: unknown[]): Promise<T> =>
      page.evaluate(([m, a]) => (window as unknown as ApiWindow).api[m as string](...(a as unknown[])), [method, args] as const)
    /** The error message of a call that must fail, or '' when it succeeded. */
    const failure = (method: string, ...args: unknown[]): Promise<string> =>
      page.evaluate(
        ([m, a]) =>
          (window as unknown as ApiWindow).api[m as string](...(a as unknown[])).then(
            () => '',
            (e: Error) => e.message
          ),
        [method, args] as const
      )

    const id: string = await page.evaluate(
      async ({ mc, port }) => {
        const bridge = (window as unknown as ApiWindow).api
        const builds: { version: string; stable: boolean }[] = await bridge.getModLoaderVersions('paper', mc)
        const build = (builds.find((b) => b.stable) ?? builds[0]).version
        const created = await bridge.createServer({
          name: 'Live Backup Мир ñ', minecraftVersion: mc, port, minRam: '1G', maxRam: '2G',
          modLoader: 'paper', modLoaderVersion: build
        })
        return created.id
      },
      { mc: MC_VERSION, port: PORT }
    )
    const server = (): Promise<{ status: string; pid?: number; absolutePath: string }> => api('getServer', id)
    const logText = async (): Promise<string> =>
      (await api<{ line: string }[]>('getServerLogs', id)).map((l) => l.line).join('\n')
    const waitBooted = (): Promise<void> =>
      expect.poll(logText, { timeout: 6 * 60_000, intervals: [2000] }).toMatch(/Done \(\d/)

    await expect.poll(async () => (await server()).status, { timeout: 5 * 60_000, intervals: [1000] }).toBe('stopped')
    expect(await api<Backup[]>('listBackups', id)).toEqual([])
    await api('startServer', id)
    await waitBooted()
    const dir = (await server()).absolutePath
    pid = (await server()).pid

    // ── Backup while the server runs ───────────────────────
    const hot = await api<Backup>('createBackup', id)
    expect(hot.kind).toBe('manual')
    expect(hot.whileRunning).toBe(true)
    expect(hot.fileCount).toBeGreaterThan(10)
    expect(hot.sizeBytes).toBeGreaterThan(100_000)
    const afterBackup = await logText()
    // Saving was paused for the copy, flushed, and turned back on.
    expect(afterBackup).toMatch(/Automatic saving is now disabled/)
    expect(afterBackup).toMatch(/Saved the game/)
    await expect.poll(logText, { timeout: 15_000 }).toMatch(/Automatic saving is now enabled/)
    expect(afterBackup).toMatch(/Backup finished: \d+ file/)
    // The server kept running through it.
    expect((await server()).status).toBe('running')
    expect(isAlive(pid as number)).toBe(true)
    // The archive is where the app keeps backups, whole, with nothing half-written beside it.
    const backupDir = join(userDataDir, 'backups', id)
    expect(readdirSync(backupDir)).toEqual([`${hot.id}.zip`])

    // A restore is refused while the server runs.
    expect(await failure('restoreBackup', id, hot.id)).toMatch(/Stop the server/)
    // Ids are checked: nothing outside the backup folder can be named.
    expect(await failure('restoreBackup', id, '../../x')).toMatch(/Invalid backup id/)
    expect(await failure('deleteBackup', id, '..\\..\\x')).toMatch(/Invalid backup id/)

    // ── Stopping wins over a backup in flight ──────────────
    const raced = await page.evaluate(async (sid) => {
      const bridge = (window as unknown as ApiWindow).api
      const backup = bridge.createBackup(sid).then(
        () => 'finished',
        (e: Error) => e.message
      )
      const stop = bridge.stopServer(sid)
      return { backup: await backup, stop: await stop.then(() => 'stopped', (e: Error) => e.message) }
    }, id)
    expect(raced.stop).toBe('stopped')
    expect(raced.backup).toMatch(/Cancelled.*the server is stopping/)
    expect((await server()).status).toBe('stopped')
    expect(isAlive(pid as number)).toBe(false)
    // The cancelled backup left nothing behind, and the server still saved on its way down.
    expect(readdirSync(backupDir)).toEqual([`${hot.id}.zip`])
    expect(readFileSync(join(dir, 'logs', 'latest.log'), 'utf8')).toMatch(/All dimensions are saved/)

    // ── A file that is not one of the app's backups is refused ──
    const fakeId = '20200101-000000-manual'
    copyFileSync(join(dir, 'server.jar'), join(backupDir, `${fakeId}.zip`))
    const worldBefore = readdirSync(join(dir, 'world')).sort()
    expect(await failure('restoreBackup', id, fakeId, { backupFirst: false })).toMatch(/damaged/)
    expect(readdirSync(join(dir, 'world')).sort()).toEqual(worldBefore)
    expect(existsSync(`${dir}.restore-aside`)).toBe(false)
    await api('deleteBackup', id, fakeId)
    expect(readdirSync(backupDir)).toEqual([`${hot.id}.zip`])

    // ── Damage the server, then restore ────────────────────
    const propsBefore = readFileSync(join(dir, 'server.properties'), 'utf8')
    appendFileSync(join(dir, 'server.properties'), '\nmotd=changed after the backup\n')
    rmSync(join(dir, 'world', 'level.dat'))
    writeFileSync(join(dir, 'world', 'stale-after-backup.txt'), 'not in the backup')
    writeFileSync(join(dir, 'logs', 'kept.log'), 'logs are not covered')

    await api('restoreBackup', id, hot.id, { backupFirst: true })

    expect(existsSync(join(dir, 'world', 'level.dat'))).toBe(true)
    expect(existsSync(join(dir, 'world', 'stale-after-backup.txt'))).toBe(false)
    expect(existsSync(join(dir, 'logs', 'kept.log'))).toBe(true)
    expect(existsSync(join(dir, 'libraries'))).toBe(true)
    // server.properties is back to what it was when the backup was made.
    expect(readFileSync(join(dir, 'server.properties'), 'utf8')).not.toContain('changed after the backup')
    expect(readFileSync(join(dir, 'server.properties'), 'utf8').length).toBeLessThanOrEqual(propsBefore.length + 200)
    expect(existsSync(`${dir}.restore-stage`)).toBe(false)
    expect(existsSync(`${dir}.restore-aside`)).toBe(false)

    const listed = await api<Backup[]>('listBackups', id)
    expect(listed.map((b) => b.kind)).toEqual(['pre-restore', 'manual'])
    expect(listed[0].whileRunning).toBe(false)

    // ── The restored world boots ───────────────────────────
    await api('startServer', id)
    await waitBooted()
    pid = (await server()).pid
    expect(await logText()).not.toMatch(/Failed to load|corrupt/i)

    // ── The Backups tab shows them ─────────────────────────
    await page.evaluate((sid) => {
      window.location.hash = `#/servers/${sid}`
    }, id)
    await page.getByRole('tab', { name: 'Backups' }).click()
    await expect(page.getByTestId('backup-row')).toHaveCount(2)
    await expect(page.getByRole('button', { name: 'Restore backup' }).first()).toBeDisabled()

    // ── Deleting ───────────────────────────────────────────
    await api('deleteBackup', id, listed[0].id)
    expect((await api<Backup[]>('listBackups', id)).map((b) => b.id)).toEqual([hot.id])
    await api('deleteServer', id)
    pid = undefined
    expect(existsSync(backupDir)).toBe(false)
    expect(existsSync(dir)).toBe(false)
  } finally {
    await app.close().catch(() => undefined)
    if (pid && isAlive(pid)) process.kill(pid)
    try {
      rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 })
    } catch {
      /* disposable temp dir */
    }
  }
})
