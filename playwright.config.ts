import { defineConfig } from '@playwright/test'

/**
 * End-to-end smoke tests for the built Electron app.
 *
 * They drive the real application (`out/`), so run `npm run build` first —
 * `npm run test:e2e` does both. No browser download is needed: Playwright
 * launches the Electron binary that is already installed.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  }
})
