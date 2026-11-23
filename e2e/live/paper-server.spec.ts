import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { execFileSync } from 'child_process'
import { mkdtempSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

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

    await page.evaluate(({ hostId, serverId }) => (window as unknown as ApiWindow).api.stopRemoteServer(hostId, serverId), created)
    await expect.poll(async () => (await remote()).status, { timeout: 90_000, intervals: [1000] }).toBe('stopped')
  } finally {
    await page
      .evaluate(({ hostId, serverId }) => (window as unknown as ApiWindow).api.deleteRemoteServer(hostId, serverId), created)
      .catch(() => undefined)
  }
})
