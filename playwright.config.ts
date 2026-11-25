import { defineConfig } from '@playwright/test'

// The two Lumopolis specs that take most of a CI run (world-responsive about 13 minutes on Windows, world-visual
// about 11). Playwright shards by test count, and these sort last, so both landed in shard 4, which then ran
// 32-44 minutes against the others' 5-12 and hit its step timeout. CI runs each in a job of its own and sets
// TERMPOLIS_E2E_SKIP_HEAVY=1 on the four count shards so they are not run twice. A local run runs everything.
const HEAVY_SPECS = ['**/world-responsive.spec.ts', '**/world-visual.spec.ts', '**/world-perf.spec.ts']

export default defineConfig({
  testDir: './e2e',
  // e2e/manual holds specs that structurally cannot gate hosted CI — a real agent CLI on
  // PATH, the developer's real memory store, Windows-only screenshot baselines. They are
  // excluded here rather than deleted; run them with playwright.manual.config.ts.
  // See e2e/manual/README.md.
  testIgnore: ['**/manual/**', ...(process.env.TERMPOLIS_E2E_SKIP_HEAVY === '1' ? HEAVY_SPECS : [])],
  timeout: 120000,
  retries: 1,
  workers: 1, // Electron requires sequential — only one instance at a time
  globalSetup: './e2e/global-setup.ts',
  use: {
    trace: 'on-first-retry',
  },
})
