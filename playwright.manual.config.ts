import { defineConfig } from '@playwright/test'

/**
 * The manually-run e2e specs (`e2e/manual/`).
 *
 * These need something a hosted runner does not have — a real `claude`/`codex`/`agy`
 * binary, the developer's actual memory store, Windows screenshot baselines — so the main
 * config ignores them and they are never a build gate. They still have to be runnable on
 * demand, which is why they live behind their own config rather than a `testIgnore` that
 * would also block an explicit invocation.
 *
 *   npm run test:e2e:manual
 *   npm run test:e2e:manual -- e2e/manual/visual-regression.spec.ts
 *
 * `retries: 0` because a human is watching: a first-run failure is the answer, not noise
 * to retry away.
 */
export default defineConfig({
  testDir: './e2e/manual',
  timeout: 120000,
  retries: 0,
  workers: 1, // Electron requires sequential — only one instance at a time
  globalSetup: './e2e/global-setup.ts',
  use: {
    trace: 'on-first-retry',
  },
})
