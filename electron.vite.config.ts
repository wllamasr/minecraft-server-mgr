import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { TanStackRouterVite } from '@tanstack/router-plugin/vite'

/**
 * Content-Security-Policy for the packaged renderer.
 *
 * - Scripts: only the bundled files. No inline script, no eval, no remote code.
 * - Styles: Mantine injects inline styles; the UI fonts come from Google Fonts.
 * - Images: mod icons and screenshots are served by Modrinth/CurseForge CDNs.
 * - No network access from the renderer (`connect-src 'self'`): every request
 *   goes through the main process via `window.api`.
 */
export const RENDERER_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: https:",
  "connect-src 'self'",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'self'",
  "form-action 'none'"
].join('; ')

/**
 * Inject the CSP `<meta>` tag into the production build only. The dev server
 * needs inline scripts and a websocket for hot-module reload, which this
 * policy forbids on purpose.
 */
function cspPlugin(): Plugin {
  return {
    name: 'msm-renderer-csp',
    apply: 'build',
    transformIndexHtml() {
      return [
        {
          tag: 'meta',
          attrs: { 'http-equiv': 'Content-Security-Policy', content: RENDERER_CSP },
          injectTo: 'head-prepend'
        }
      ]
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        external: ['better-sqlite3']
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [
      TanStackRouterVite({
        target: 'react',
        autoCodeSplitting: true,
        routesDirectory: resolve('src/renderer/src/routes'),
        generatedRouteTree: resolve('src/renderer/src/routeTree.gen.ts')
      }),
      react(),
      cspPlugin()
    ]
  }
})
