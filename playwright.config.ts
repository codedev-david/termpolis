import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  // e2e/manual holds specs that structurally cannot gate hosted CI — a real agent CLI on
  // PATH, the developer's real memory store, Windows-only screenshot baselines. They are
  // excluded here rather than deleted; run them with playwright.manual.config.ts.
  // See e2e/manual/README.md.
  testIgnore: ['**/manual/**'],
  timeout: 120000,
  retries: 1,
  workers: 1, // Electron requires sequential — only one instance at a time
  globalSetup: './e2e/global-setup.ts',
  use: {
    trace: 'on-first-retry',
  },
})
