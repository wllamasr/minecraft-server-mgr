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
