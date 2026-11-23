import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { mkdtempSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

const repoRoot = resolve(__dirname, '..')

let app: ElectronApplication
let page: Page
let userDataDir: string

/** Uncaught renderer exceptions and Content-Security-Policy violations. */
const pageErrors: string[] = []
const cspViolations: string[] = []

test.beforeAll(async () => {
  // Isolated profile: the test must never touch the user's real database.
  userDataDir = mkdtempSync(join(tmpdir(), 'msm-e2e-'))

  // By default the tests run the build in out/. Set MSM_E2E_EXECUTABLE to a
  // packaged binary (e.g. dist/win-unpacked/MinecraftServerManager.exe) to run
  // the same checks against the packaged app.
  const packaged = process.env.MSM_E2E_EXECUTABLE
  app = await electron.launch(
    packaged
      ? { executablePath: resolve(repoRoot, packaged), args: [`--user-data-dir=${userDataDir}`] }
      : { cwd: repoRoot, args: ['.', `--user-data-dir=${userDataDir}`] }
  )

  page = await app.firstWindow()
  page.on('pageerror', (err) => pageErrors.push(err.message))
  page.on('console', (msg) => {
    if (msg.type() === 'error' && /content security policy/i.test(msg.text())) {
      cspViolations.push(msg.text())
    }
  })
  await page.waitForLoadState('domcontentloaded')
})

test.afterAll(async () => {
  await app?.close()
  if (userDataDir) {
    try {
      rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch {
      /* the OS may still hold a handle for a moment; the temp dir is disposable */
    }
  }
})

test('starts and renders the dashboard', async () => {
  await expect(page).toHaveTitle('Minecraft Server Manager')
  await expect(page.getByRole('heading', { name: 'Dashboard Overview' })).toBeVisible()
})

test('uses the isolated profile for its database', async () => {
  const reported = await app.evaluate(({ app }) => app.getPath('userData'))
  expect(resolve(reported)).toBe(resolve(userDataDir))
  expect(existsSync(join(userDataDir, 'data', 'minecraft-server-manager.db'))).toBe(true)
})

test('navigates to every section from the sidebar', async () => {
  const sections: Array<{ nav: string; heading: string | RegExp }> = [
    { nav: 'Servers', heading: /Server Fleet/ },
    { nav: 'Modpacks', heading: 'Modpacks' },
    { nav: 'Remote Hosts', heading: 'Remote Hosts' },
    { nav: 'Mods', heading: 'Mod Browser' },
    { nav: 'Settings', heading: 'Settings' },
    { nav: 'Dashboard', heading: 'Dashboard Overview' }
  ]

  for (const { nav, heading } of sections) {
    await page.getByText(nav, { exact: true }).first().click()
    await expect(page.getByRole('heading', { name: heading }).first()).toBeVisible()
  }
})

test('opens the create-server form', async () => {
  await page.evaluate(() => {
    window.location.hash = '#/servers/create'
  })
  await expect(page.getByText('Server Name').first()).toBeVisible()
  await page.evaluate(() => {
    window.location.hash = '#/'
  })
  await expect(page.getByRole('heading', { name: 'Dashboard Overview' })).toBeVisible()
})

test('exposes only the preload bridge to the renderer', async () => {
  const surface = await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>
    const api = w.api as Record<string, unknown> | undefined
    return {
      hasApi: typeof api === 'object' && api !== null,
      hasRequire: typeof w.require !== 'undefined',
      hasProcess: typeof w.process !== 'undefined',
      hasInstallModLoader: !!api && 'installModLoader' in api
    }
  })
  expect(surface.hasApi).toBe(true)
  expect(surface.hasRequire).toBe(false)
  expect(surface.hasProcess).toBe(false)
  // The renderer must not be able to run a loader installer in an arbitrary directory.
  expect(surface.hasInstallModLoader).toBe(false)
})

test('answers IPC calls from the main process', async () => {
  const result = await page.evaluate(async () => {
    const api = (window as unknown as { api: Record<string, (...a: unknown[]) => Promise<unknown>> }).api
    return {
      servers: await api.listServers(),
      version: await api.getVersion()
    }
  })
  expect(result.servers).toEqual([])
  expect(typeof result.version).toBe('string')
})

test('refuses to open non-web URLs', async () => {
  const outcome = await page.evaluate(async () => {
    const api = (window as unknown as { api: { openExternal: (u: string) => Promise<void> } }).api
    try {
      await api.openExternal('file:///C:/Windows/System32/calc.exe')
      return 'opened'
    } catch (e) {
      return String(e)
    }
  })
  expect(outcome).not.toBe('opened')
  expect(outcome).toMatch(/http\(s\)/)
})

test('ships a Content-Security-Policy that blocks injected script', async () => {
  const csp = await page.evaluate(
    () => document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ?? ''
  )
  expect(csp).toContain("script-src 'self'")
  expect(csp).toContain("object-src 'none'")
  expect(csp).not.toContain("'unsafe-eval'")

  // Inline <script> and inline event handlers are what an HTML-injection bug would use.
  const inlineScriptRan = await page.evaluate(async () => {
    const w = window as unknown as { __msmInlineScript?: boolean }
    const script = document.createElement('script')
    script.textContent = 'window.__msmInlineScript = true'
    document.body.appendChild(script)
    await new Promise((r) => setTimeout(r, 100))
    script.remove()
    return w.__msmInlineScript === true
  })
  expect(inlineScriptRan).toBe(false)

  const inlineHandlerRan = await page.evaluate(async () => {
    const w = window as unknown as { __msmInline?: boolean }
    const holder = document.createElement('div')
    holder.innerHTML = '<img src="data:image/png;base64,AAAA" onerror="window.__msmInline = true">'
    document.body.appendChild(holder)
    await new Promise((r) => setTimeout(r, 300))
    holder.remove()
    return w.__msmInline === true
  })
  expect(inlineHandlerRan).toBe(false)
})

test('raised no uncaught errors while browsing', async () => {
  expect(pageErrors).toEqual([])
})

test("the app's own scripts, styles and fonts load without CSP violations", async () => {
  // The previous test injects an inline script and an inline handler on purpose;
  // those are the only violations allowed.
  const own = cspViolations.filter((v) => !/inline script|inline event handler/i.test(v))
  expect(own).toEqual([])
  expect(cspViolations.length).toBeGreaterThanOrEqual(2)
})
