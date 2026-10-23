import { defineConfig } from '@playwright/test'

/**
 * Visual regression for the course assistant panel.
 *
 *   pnpm exec playwright test                      # compare against the baseline
 *   pnpm exec playwright test --update-snapshots   # refresh the baseline
 *
 * The harness GUI is served by `dsh web`; point DSH_WEB_URL at it if it is not
 * on the default port. Edge is used as the browser so no Chromium download is
 * needed (playwright install is unnecessary on Windows).
 */
const rawUrl = process.env.DSH_WEB_URL || 'http://127.0.0.1:54763'

/** DSH_WEB_URL may be the full printed URL (it carries ?token=…): strip it for baseURL. */
const baseURL = (() => {
  try {
    const url = new URL(rawUrl)
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return rawUrl
  }
})()

export default defineConfig({
  testDir: './tests',
  timeout: 90_000,
  expect: {
    timeout: 20_000,
    toHaveScreenshot: { maxDiffPixelRatio: 0.02, animations: 'disabled' },
  },
  reporter: [['list']],
  use: {
    baseURL,
    channel: process.env.DSH_BROWSER_CHANNEL || 'msedge',
    viewport: { width: 1280, height: 900 },
    trace: 'off',
    screenshot: 'off',
  },
})
