import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 120000,
  retries: 1,
  workers: 1, // Electron requires sequential — only one instance at a time
  globalSetup: './e2e/global-setup.ts',
  use: {
    trace: 'on-first-retry',
  },
})
