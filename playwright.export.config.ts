import { defineConfig } from '@playwright/test'

/**
 * The exported Lumopolis page, proven offline in four browsers. globalSetup exports the fixture world once
 * (test-results/export-fixture/{smart,keyword,document}.html) and every spec opens those files from disk.
 *
 * The specs are named *.page.ts, so playwright.config.ts (the app's e2e, *.spec.ts) never picks them up. The
 * `electron` project opens the page in an Electron BrowserWindow (e2e/export-page/electronHost.cjs); the others in
 * the browser itself. msedge exists only on Windows, and chrome (the installed Google Chrome) is run only on macOS, where
 * it shows what a person's real Chromium does on a Mac; CI's export-page job names the projects each OS runs.
 */
export default defineConfig({
  testDir: 'e2e/export-page',
  testMatch: '**/*.page.ts',
  globalSetup: 'e2e/export-page/globalSetup.ts',
  outputDir: 'test-results/export-page',
  timeout: 120_000,
  retries: 1,
  // One at a time: a smart page holds about 40 MB of model and wasm, and the Ask-ready budget is measured.
  workers: 1,
  // No `trace` here: the specs launch their own browsers, so tracing is done in the `open` fixture (helpers.ts).
  use: { viewport: { width: 1280, height: 800 } },
  projects: [
    { name: 'electron' },
    ...(process.platform === 'win32' ? [{ name: 'msedge', use: { browserName: 'chromium' as const, channel: 'msedge' } }] : []),
    ...(process.platform === 'darwin' ? [{ name: 'chrome', use: { browserName: 'chromium' as const, channel: 'chrome' } }] : []),
    { name: 'firefox', use: { browserName: 'firefox' as const } },
    { name: 'webkit', use: { browserName: 'webkit' as const } },
  ],
})
