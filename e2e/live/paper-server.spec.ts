import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { execFileSync } from 'child_process'
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join, resolve } from 'path'

/**
 * Live test: creates a real Paper server through the wizard, boots it and
 * shuts it down again.
 *
 * It needs network access (PaperMC + Mojang downloads), Java 21 and a few
 * minutes, so it is opt-in and never runs in CI:
 *
 *   npm run build
 *   MSM_E2E_LIVE=1 npx playwright test e2e/live
 *
 * (PowerShell: `$env:MSM_E2E_LIVE = '1'; npx playwright test e2e/live`)
 */
const LIVE = !!process.env.MSM_E2E_LIVE
const MC_VERSION = process.env.MSM_E2E_LIVE_MC || '1.21.11'
const PORT = Number(process.env.MSM_E2E_LIVE_PORT || 25599)

// The preload API as seen from page.evaluate(); typed loosely on purpose.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ApiWindow = { api: Record<string, (...args: any[]) => Promise<any>> }

const repoRoot = resolve(__dirname, '..', '..')

let app: ElectronApplication
let page: Page
let userDataDir: string
let serverId: string | undefined

test.skip(!LIVE, 'Set MSM_E2E_LIVE=1 to run the live server test')
test.setTimeout(10 * 60_000)

test.beforeAll(async () => {
  if (!LIVE) return
  userDataDir = mkdtempSync(join(tmpdir(), 'msm-live-'))
  app = await electron.launch({ cwd: repoRoot, args: ['.', `--user-data-dir=${userDataDir}`] })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
})

test.afterAll(async () => {
  if (!LIVE) return
  if (serverId && page) {
    // Never leave a Java process behind, whatever the test outcome.
    await page
      .evaluate(async (id) => {
        const s = await (window as unknown as ApiWindow).api.getServer(id)
        if (s && s.status !== 'stopped') await (window as unknown as ApiWindow).api.stopServer(id)
      }, serverId)
      .catch(() => undefined)
  }
  await app?.close()
  if (userDataDir) {
    try {
      rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 })
    } catch {
      /* disposable temp dir */
    }
  }
})

test('creates, boots and stops a Paper server with optimized JVM flags', async () => {
  // ── Wizard ────────────────────────────────────────────
  await page.evaluate(() => {
    window.location.hash = '#/servers/create'
  })
  await page.getByPlaceholder('Enter a distinctive name...').fill('Live Paper')
  await page.getByRole('button', { name: 'Continue to Engine Selection' }).click()

  await page.getByText('Paper', { exact: true }).click()

  // The version list now comes from PaperMC; pick a version that runs on Java 21.
  const versionInput = page.getByRole('combobox').first()
  await expect(versionInput).toBeEnabled({ timeout: 30_000 })
  await versionInput.click()
  await versionInput.fill(MC_VERSION)
  await page.getByRole('option', { name: MC_VERSION, exact: true }).click()

  // The newest stable build is selected automatically.
  const buildInput = page.getByPlaceholder('Select Paper build...')
  await expect(buildInput).toHaveValue(/^Build \d+$/, { timeout: 30_000 })

  await page.getByRole('button', { name: 'Continue to System Configuration' }).click()

  await expect(page.getByRole('switch', { name: 'Optimized JVM flags' })).toBeChecked()
  // The port field is the only text box on this step.
  await page.getByRole('textbox').fill(String(PORT))
  await page.getByRole('checkbox').check()
  await page.getByRole('button', { name: 'Initialize & Deploy Server' }).click()

  // ── Provisioning ──────────────────────────────────────
  await page.waitForURL(/#\/servers\/[0-9a-f-]{36}/)
  serverId = /#\/servers\/([0-9a-f-]{36})/.exec(page.url())?.[1]
  expect(serverId).toBeTruthy()
  const id = serverId as string

  const status = (): Promise<string | undefined> =>
    page.evaluate(async (sid) => (await (window as unknown as ApiWindow).api.getServer(sid))?.status, id)
  const logText = (): Promise<string> =>
    page.evaluate(async (sid) => (await (window as unknown as ApiWindow).api.getServerLogs(sid)).map((l: { line: string }) => l.line).join('\n'), id)

  await expect
    .poll(status, { timeout: 5 * 60_000, intervals: [1000], message: await logText() })
    .toBe('stopped')

  const server = await page.evaluate((sid) => (window as unknown as ApiWindow).api.getServer(sid), id)
  expect(server.modLoader).toBe('paper')
  expect(server.jvmProfile).toBe('aikar')
  expect(server.port).toBe(PORT)
  expect(await logText()).toMatch(/Verified paper-.*\.jar \(sha256 checksum OK\)/)
  expect(existsSync(join(server.absolutePath, 'server.jar'))).toBe(true)

  // ── Boot ──────────────────────────────────────────────
  await page.evaluate((sid) => (window as unknown as ApiWindow).api.startServer(sid), id)
  await expect.poll(logText, { timeout: 6 * 60_000, intervals: [2000] }).toMatch(/Done \(\d/)
  expect(await status()).toBe('running')

  // The JVM really got the tuned flags, with the whole heap reserved up front.
  const running = await page.evaluate((sid) => (window as unknown as ApiWindow).api.getServer(sid), id)
  if (process.platform === 'win32' && running?.pid) {
    const cmdline = execFileSync(
      'powershell',
      ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${running.pid}").CommandLine`],
      { encoding: 'utf8' }
    )
    expect(cmdline).toContain('-XX:+UseG1GC')
    expect(cmdline).toContain(`-Xms${running.maxRam}`)
    expect(cmdline).toContain(`-Xmx${running.maxRam}`)
  }

  // ── Tick time ─────────────────────────────────────────
  // The page is showing this server, so the app asks it how long its ticks
  // take ("tick query") and shows the answer.
  const latestLog = join(server.absolutePath, 'logs', 'latest.log')
  const answersInServerLog = (): number => (readFileSync(latestLog, 'utf8').match(/Target tick rate:/g) ?? []).length
  const answersInAppConsole = async (): Promise<number> => ((await logText()).match(/Average time per tick:/g) ?? []).length

  const tickTime = page.getByTestId('tick-time')
  await expect(tickTime).toHaveAttribute('data-state', 'ok', { timeout: 30_000 })
  await expect(page.getByTestId('tick-time-ms')).toHaveText(/^\d+\.\d$/)
  await expect(page.getByTestId('tick-time-details')).toHaveText(/^\d+\.\d TPS · P95 \d+\.\d ms$/)
  // The server did answer, in its own log; the app's console does not show
  // the answers to the app's own questions.
  expect(answersInServerLog()).toBeGreaterThan(0)
  expect(await answersInAppConsole()).toBe(0)

  // An answer to a question somebody typed is theirs to see.
  await page.evaluate((sid) => (window as unknown as ApiWindow).api.sendCommand(sid, 'tick query'), id)
  await expect.poll(answersInAppConsole, { timeout: 10_000 }).toBe(1)

  // Nobody looking, nobody asking: away from the page the questions stop.
  await page.evaluate(() => {
    window.location.hash = '#/'
  })
  await expect(tickTime).toHaveCount(0)
  await page.waitForTimeout(20_000) // the last "I am looking" runs out
  const whileAway = answersInServerLog()
  await page.waitForTimeout(40_000)
  expect(answersInServerLog()).toBe(whileAway)

  // Back on the page they start again.
  await page.evaluate((sid) => {
    window.location.hash = `#/servers/${sid}`
  }, id)
  await expect.poll(answersInServerLog, { timeout: 30_000 }).toBeGreaterThan(whileAway)
  await expect(tickTime).toHaveAttribute('data-state', 'ok', { timeout: 10_000 })
  expect(await answersInAppConsole()).toBe(1)

  // Paper created its plugin directory; nothing was put in mods/.
  expect(existsSync(join(server.absolutePath, 'plugins'))).toBe(true)

  // ── Plugins ───────────────────────────────────────────
  // Search, resolve and install a real plugin from Modrinth.
  const plugin = await page.evaluate(
    async ({ sid, mc }) => {
      const api = (window as unknown as ApiWindow).api
      const found = await api.searchMods({ source: 'modrinth', query: 'luckperms', loader: 'paper', gameVersion: mc, limit: 5 })
      const project = found.mods[0]
      const versions = await api.getModVersions('modrinth', project.id, mc, 'paper')
      await api.installMod(sid, 'modrinth', project.id, versions[0].id)
      return { hits: found.totalHits, slug: project.slug, installed: await api.getInstalledMods(sid) }
    },
    { sid: id, mc: MC_VERSION }
  )
  expect(plugin.hits).toBeGreaterThan(0)
  expect(plugin.installed).toHaveLength(1)
  expect(existsSync(join(server.absolutePath, 'plugins', plugin.installed[0].fileName))).toBe(true)
  expect(existsSync(join(server.absolutePath, 'mods'))).toBe(false)
  // CurseForge mods must never be offered for a plugin server.
  const cfError = await page.evaluate(
    (sid) => (window as unknown as ApiWindow).api.installMod(sid, 'curseforge', '1', '1').then(() => '', (e: Error) => e.message),
    id
  )
  expect(cfError).toMatch(/Modrinth/)

  // ── Shutdown ──────────────────────────────────────────
  await page.evaluate((sid) => (window as unknown as ApiWindow).api.stopServer(sid), id)
  await expect.poll(status, { timeout: 60_000, intervals: [1000] }).toBe('stopped')
})

test('provisions a Purpur server and verifies its checksum', async () => {
  const result = await page.evaluate(async (port) => {
    const api = (window as unknown as ApiWindow).api
    const versions: string[] = await api.getServerSoftwareVersions('purpur')
    const mc = versions[0]
    const builds: { version: string; stable: boolean }[] = await api.getModLoaderVersions('purpur', mc)
    const created = await api.createServer({
      name: 'Live Purpur', minecraftVersion: mc, port, minRam: '1G', maxRam: '2G',
      modLoader: 'purpur', modLoaderVersion: builds[0].version
    })
    return { id: created.id as string, mc, build: builds[0].version }
  }, PORT + 1)

  const state = (): Promise<{ status: string; log: string; path: string }> =>
    page.evaluate(async (sid) => {
      const api = (window as unknown as ApiWindow).api
      const s = await api.getServer(sid)
      const log = (await api.getServerLogs(sid)).map((l: { line: string }) => l.line).join(' | ')
      return { status: s.status, log, path: s.absolutePath }
    }, result.id)

  await expect.poll(async () => (await state()).status, { timeout: 5 * 60_000, intervals: [1000] }).toBe('stopped')
  const final = await state()
  expect(final.log).toMatch(/Verified purpur-.*\.jar \(md5 checksum OK\)/)
  expect(existsSync(join(final.path, 'server.jar'))).toBe(true)
})

test('lists versions for every engine through the shared HTTP client', async () => {
  const counts = await page.evaluate(async () => {
    const api = (window as unknown as ApiWindow).api
    const out: Record<string, number> = {}
    for (const loader of ['forge', 'neoforge', 'fabric', 'quilt']) {
      out[loader] = (await api.getModLoaderVersions(loader, '1.21.1')).length
    }
    for (const platform of ['paper', 'purpur', 'folia']) {
      out[platform] = (await api.getServerSoftwareVersions(platform)).length
    }
    return out
  })
  for (const [engine, count] of Object.entries(counts)) {
    expect(count, engine).toBeGreaterThan(0)
  }
})

/**
 * Remote host: needs a running msmd. Start one (`go run ./cmd/msmd -data <dir>
 * -addr 127.0.0.1:18444` in daemon/) and pass its address and token:
 *
 *   MSM_E2E_LIVE=1 MSM_E2E_LIVE_MSMD_URL=https://127.0.0.1:18444 \
 *   MSM_E2E_LIVE_MSMD_TOKEN=<contents of <dir>/token> npx playwright test e2e/live
 */
test('deploys a Paper server to a remote host', async () => {
  const baseUrl = process.env.MSM_E2E_LIVE_MSMD_URL
  const token = process.env.MSM_E2E_LIVE_MSMD_TOKEN
  test.skip(!baseUrl || !token, 'Set MSM_E2E_LIVE_MSMD_URL and MSM_E2E_LIVE_MSMD_TOKEN to test a remote host')
  // Three boots of a real server, a backup, a scheduled backup and a restore.
  test.setTimeout(30 * 60_000)

  const created = await page.evaluate(
    async ({ baseUrl, token, mc, port }) => {
      const api = (window as unknown as ApiWindow).api
      const host = await api.addHost({ name: 'Live host', baseUrl, token })
      const versions: string[] = await api.remoteSoftwareVersions(host.id, 'paper')
      const builds: { version: string; stable: boolean }[] = await api.remoteLoaderVersions(host.id, 'paper', mc)
      const build = (builds.find((b) => b.stable) ?? builds[0]).version
      const server = await api.createRemoteServer(host.id, {
        name: 'live-remote-paper', minecraftVersion: mc, modLoader: 'paper', modLoaderVersion: build,
        port, minRam: '1G', maxRam: '2G', jvmProfile: 'aikar'
      })
      return { hostId: host.id as string, serverId: server.id as string, listsVersion: versions.includes(mc), server }
    },
    { baseUrl: baseUrl as string, token: token as string, mc: MC_VERSION, port: PORT + 2 }
  )
  expect(created.listsVersion).toBe(true)
  expect(created.server.modLoader).toBe('paper')
  expect(created.server.jvmProfile).toBe('aikar')

  const remote = (): Promise<{ status: string; log: string }> =>
    page.evaluate(async ({ hostId, serverId }) => {
      const api = (window as unknown as ApiWindow).api
      const servers: { id: string; status: string }[] = await api.listRemoteServers(hostId)
      const log = (await api.remoteServerLogs(hostId, serverId)).map((l: { line: string }) => l.line).join(' | ')
      return { status: servers.find((s) => s.id === serverId)?.status ?? 'missing', log }
    }, created)

  try {
    await expect.poll(async () => (await remote()).status, { timeout: 5 * 60_000, intervals: [1000] }).toBe('stopped')
    expect((await remote()).log).toMatch(/Verified paper-.*\.jar \(sha256 checksum OK\)/)

    await page.evaluate(({ hostId, serverId }) => (window as unknown as ApiWindow).api.startRemoteServer(hostId, serverId), created)
    await expect.poll(async () => (await remote()).log, { timeout: 6 * 60_000, intervals: [2000] }).toMatch(/Done \(\d/)

    // Scheduled restart setting, and the host clock it refers to.
    const settings = await page.evaluate(async ({ hostId, serverId }) => {
      const api = (window as unknown as ApiWindow).api
      const rejected = await api.updateRemoteServer(hostId, serverId, { restartSchedule: '4:30' }).then(() => '', (e: Error) => e.message)
      const saved = await api.updateRemoteServer(hostId, serverId, { restartSchedule: '04:30' })
      const listed = (await api.listRemoteServers(hostId)).find((s: { id: string }) => s.id === serverId)
      const cleared = await api.updateRemoteServer(hostId, serverId, { restartSchedule: null })
      const missing = await api.restartRemoteServer(hostId, 'does-not-exist').then(() => '', (e: Error) => e.message)
      return { rejected, saved: saved.restartSchedule, listed: listed.restartSchedule, cleared: cleared.restartSchedule, missing, info: await api.hostInfo(hostId) }
    }, created)
    expect(settings.rejected).toMatch(/HH:MM/)
    expect(settings.saved).toBe('04:30')
    expect(settings.listed).toBe('04:30')
    expect(settings.cleared).toBeUndefined()
    // A genuine "not found" is not mistaken for an outdated daemon.
    expect(settings.missing).toMatch(/server not found/)
    expect(settings.info.time).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(Z|[+-]\d\d:\d\d)$/)
    expect(settings.info.timeZone).toBeTruthy()

    // Restart: the process is replaced and the server boots again.
    const pidOf = (): Promise<number | undefined> =>
      page.evaluate(async ({ hostId, serverId }) => {
        const servers: { id: string; pid?: number }[] = await (window as unknown as ApiWindow).api.listRemoteServers(hostId)
        return servers.find((s) => s.id === serverId)?.pid
      }, created)
    const firstPid = await pidOf()
    expect(firstPid).toBeTruthy()
    await page.evaluate(({ hostId, serverId }) => (window as unknown as ApiWindow).api.restartRemoteServer(hostId, serverId), created)
    await expect.poll(pidOf, { timeout: 2 * 60_000, intervals: [1000] }).not.toBe(firstPid)
    await expect.poll(async () => (await remote()).status, { timeout: 60_000, intervals: [1000] }).toBe('running')
    await expect
      .poll(async () => ((await remote()).log.match(/Done \(\d/g) ?? []).length, { timeout: 6 * 60_000, intervals: [2000] })
      .toBe(2)

    // Metrics: with the host on screen, the running server shows its players,
    // tick time, processor and memory, all measured by the host.
    await page.getByText('Remote Hosts', { exact: true }).first().click()
    await page.getByText('Live host', { exact: true }).first().click()
    const metrics = page.getByTestId(`remote-metrics-${created.serverId}`)
    await expect(metrics).toBeVisible({ timeout: 30_000 })
    await expect(metrics.getByTestId('remote-tick')).toHaveAttribute('data-state', 'ok', { timeout: 40_000 })
    await expect(metrics.getByTestId('remote-tick')).toHaveText(/^Tick \d+\.\d ms \/ 50 ms · \d+\.\d TPS · P95 \d+\.\d ms$/)
    await expect(metrics.getByTestId('remote-players')).toHaveText('Players 0/20', { timeout: 30_000 })
    if (process.platform === 'win32' || process.platform === 'linux') {
      await expect(metrics.getByTestId('remote-cpu')).toHaveText(/^CPU \d+%$/, { timeout: 30_000 })
      // The whole heap is reserved up front (1G at least): the JVM, not a wrapper, is what is measured.
      await expect(metrics.getByTestId('remote-memory')).toHaveText(/^RAM (0\.[3-9]\d|[1-9]\d*\.\d\d) GB$/)
    }
    // The host asked the server (msmd runs on this machine: its log is at
    // hand), and kept the answers to its own questions out of the console.
    const remoteLatestLog = join(created.server.dir as string, 'logs', 'latest.log')
    const remoteAnswers = (): number => (readFileSync(remoteLatestLog, 'utf8').match(/Target tick rate:/g) ?? []).length
    expect(remoteAnswers()).toBeGreaterThan(0)
    expect((await remote()).log).not.toMatch(/Average time per tick|Target tick rate/)
    // Nobody looking, nobody asking.
    await page.evaluate(() => {
      window.location.hash = '#/'
    })
    await expect(metrics).toHaveCount(0)
    await page.waitForTimeout(8_000) // a request already on its way
    const remoteWhileAway = remoteAnswers()
    await page.waitForTimeout(40_000)
    expect(remoteAnswers()).toBe(remoteWhileAway)

    // Backups, through the window on the hosts page. First of the running
    // server: the host pauses world saving for the copy.
    await page.getByText('Remote Hosts', { exact: true }).first().click()
    await page.getByText('Live host', { exact: true }).first().click()
    await page.getByRole('button', { name: 'Backups' }).click()
    const backups = page.getByTestId('remote-backups')
    const rows = page.getByTestId('remote-backup-row')
    await expect(backups.getByText('No backups yet.')).toBeVisible()
    await backups.getByRole('button', { name: 'Back up now' }).click()
    await expect(rows).toHaveCount(1, { timeout: 4 * 60_000 })
    await expect(page.getByText('Backup created.')).toBeVisible({ timeout: 30_000 })
    expect((await remote()).log).toMatch(/pausing world saving.*Automatic saving is now disabled.*Saved the game.*Backup finished: \d+ file/)
    const listed = await page.evaluate(
      ({ hostId, serverId }) => (window as unknown as ApiWindow).api.listRemoteBackups(hostId, serverId),
      created
    )
    expect(listed).toHaveLength(1)
    expect(listed[0].whileRunning).toBe(true)
    expect(listed[0].kind).toBe('manual')
    expect(listed[0].fileCount).toBeGreaterThan(10)
    // Saving is back on, and a running server cannot be restored onto.
    await expect.poll(async () => (await remote()).log, { timeout: 30_000 }).toMatch(/Backup finished.*Automatic saving is now enabled/)
    await expect(rows.first().getByRole('button', { name: 'Restore backup' })).toBeDisabled()
    const refused = await page.evaluate(
      ({ hostId, serverId, backupId }) =>
        (window as unknown as ApiWindow).api.restoreRemoteBackup(hostId, serverId, backupId).then(() => '', (e: Error) => e.message),
      { ...created, backupId: listed[0].id as string }
    )
    expect(refused).toMatch(/Stop the server before restoring a backup/)
    const missing = await page.evaluate(
      ({ hostId, serverId }) =>
        (window as unknown as ApiWindow).api.deleteRemoteBackup(hostId, serverId, '20200101-000000-manual').then(() => '', (e: Error) => e.message),
      created
    )
    // A backup that is not there is not mistaken for an outdated daemon.
    expect(missing).toMatch(/backup not found/)

    // A scheduled backup: set, in the window, for the next minute on the
    // host's clock. The host makes it on its own and keeps only the last one.
    const info = await page.evaluate(({ hostId }) => (window as unknown as ApiWindow).api.hostInfo(hostId), created)
    const clock = /T(\d{2}):(\d{2}):(\d{2})/.exec(info.time as string)
    expect(clock).not.toBeNull()
    const [hh, mm, ss] = (clock as RegExpExecArray).slice(1).map(Number)
    // Too close to the minute, the host's scheduler might first look after it.
    const due = (hh * 60 + mm + (ss >= 30 ? 2 : 1)) % 1440
    const at = `${String(Math.floor(due / 60)).padStart(2, '0')}:${String(due % 60).padStart(2, '0')}`
    const schedule = page.getByTestId('remote-backup-schedule')
    await schedule.getByRole('switch', { name: 'Back up every day' }).click()
    await schedule.getByLabel('Backup time').fill(at)
    await schedule.getByLabel('Scheduled backups to keep').fill('1')
    await schedule.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByText(`will be backed up every day at ${at} (host time), keeping the last 1.`)).toBeVisible({
      timeout: 30_000
    })
    await expect(rows).toHaveCount(2, { timeout: 4 * 60_000 })
    await expect(rows.first().getByText('scheduled', { exact: true })).toBeVisible()
    await expect(page.getByTestId('remote-backup-last-run')).toContainText('Last scheduled backup: made on', { timeout: 30_000 })
    const withScheduled = await page.evaluate(
      ({ hostId, serverId }) => (window as unknown as ApiWindow).api.listRemoteBackups(hostId, serverId),
      created
    )
    expect(withScheduled.map((b: { kind: string }) => b.kind)).toEqual(['scheduled', 'manual'])
    expect(withScheduled[0].whileRunning).toBe(true)
    expect((await remote()).log).toMatch(new RegExp(`Scheduled backup \\(${at}\\)\\.`))
    // The server kept running through it.
    expect((await remote()).status).toBe('running')

    await page.evaluate(({ hostId, serverId }) => (window as unknown as ApiWindow).api.stopRemoteServer(hostId, serverId), created)
    await expect.poll(async () => (await remote()).status, { timeout: 90_000, intervals: [1000] }).toBe('stopped')

    // Damage the stopped server (msmd runs on this machine), then restore
    // the newest backup: the one the schedule made.
    const serverDir = created.server.dir as string
    const level = join(serverDir, 'world', 'level.dat')
    const marker = join(serverDir, 'world', 'added-after-the-backup.txt')
    expect(existsSync(level)).toBe(true)
    rmSync(level)
    writeFileSync(marker, 'x')
    const restoreButton = rows.first().getByRole('button', { name: 'Restore backup' })
    await expect(restoreButton).toBeEnabled({ timeout: 30_000 })
    await restoreButton.click()
    await page.getByRole('button', { name: 'Restore', exact: true }).click()
    await expect(page.getByText('Backup restored. You can start the server now.')).toBeVisible({ timeout: 4 * 60_000 })
    // The state before the restore was kept as a backup of its own.
    await expect(rows).toHaveCount(3)
    await expect(backups.getByText('before restore')).toBeVisible()
    expect(existsSync(level)).toBe(true)
    expect(existsSync(marker)).toBe(false)
    expect(existsSync(`${serverDir}.restore-stage`) || existsSync(`${serverDir}.restore-aside`)).toBe(false)
    await page.keyboard.press('Escape')

    // The restored server boots.
    await page.evaluate(({ hostId, serverId }) => (window as unknown as ApiWindow).api.startRemoteServer(hostId, serverId), created)
    await expect
      .poll(async () => ((await remote()).log.match(/Done \(\d/g) ?? []).length, { timeout: 6 * 60_000, intervals: [2000] })
      .toBe(3)
    await page.evaluate(({ hostId, serverId }) => (window as unknown as ApiWindow).api.stopRemoteServer(hostId, serverId), created)
    await expect.poll(async () => (await remote()).status, { timeout: 90_000, intervals: [1000] }).toBe('stopped')

    // Deleting the server takes its backups on the host along.
    const backupsDir = join(dirname(dirname(serverDir)), 'backups', created.serverId)
    expect(existsSync(backupsDir)).toBe(true)
    await page.evaluate(({ hostId, serverId }) => (window as unknown as ApiWindow).api.deleteRemoteServer(hostId, serverId), created)
    await expect.poll(async () => (await remote()).status, { timeout: 30_000 }).toBe('missing')
    expect(existsSync(backupsDir)).toBe(false)
    expect(existsSync(serverDir)).toBe(false)
  } finally {
    await page
      .evaluate(({ hostId, serverId }) => (window as unknown as ApiWindow).api.deleteRemoteServer(hostId, serverId), created)
      .catch(() => undefined)
  }
})
