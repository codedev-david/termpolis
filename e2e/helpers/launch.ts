/**
 * Shared Electron launch args for e2e specs.
 *
 * Why this exists: 34 of the 52 specs on disk had never been executed by CI, and when
 * the whole directory was finally run every single one of them died at
 * `electron.launch: Process failed to launch!` — not on a stale assertion, but because
 * they launched with `args: [path.resolve('out/main/index.js')]` and nothing else:
 *
 *   - Linux CI runners have no usable sandbox for Electron, so the process exits
 *     immediately without `--no-sandbox`. Every spec CI *did* run already passed it;
 *     the ones it didn't run never learned.
 *   - Without `--user-data-dir` a spec shares the single-instance lock with any other
 *     Termpolis on the box — a developer's running app, or the previous spec still
 *     shutting down — and the second instance quits on startup, which surfaces as the
 *     same opaque launch failure.
 *
 * Centralising it means a new spec inherits both fixes instead of rediscovering them.
 */
import type { Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'

/**
 * Args for `electron.launch()`: the built main entry, a private user-data dir, and
 * `--no-sandbox` on Linux. `label` only shapes the temp dir name so a failed run is
 * traceable to the spec that made it.
 */
/** One temp profile per label, so a relaunch inside the same spec keeps its state. */
const userDataDirs = new Map<string, string>()

/**
 * The isolated Electron `userData` directory for `label`, created on first use.
 *
 * Under `--user-data-dir=X`, `app.getPath('userData')` IS `X` — so anything the app writes
 * into its profile (`mcp-token`, `session.json`, the memory store) lands directly in here.
 * Specs that need to seed or read those files must call this instead of hand-building
 * `~/AppData/Roaming/termpolis/...`: that path is Windows-only, and now that every spec
 * runs against its own profile it is also simply the wrong directory — it points at the
 * developer's REAL Termpolis profile, which the whole-suite run would then clobber.
 */
export function e2eUserDataDir(label = 'e2e'): string {
  let dir = userDataDirs.get(label)
  if (!dir) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), `termpolis-${label}-`))
    userDataDirs.set(label, dir)
  }
  return dir
}

export function e2eLaunchArgs(label = 'e2e'): string[] {
  return [
    path.resolve('out/main/index.js'),
    `--user-data-dir=${e2eUserDataDir(label)}`,
    ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
  ]
}

/**
 * Clear the first-run onboarding tour before a spec touches the UI.
 *
 * `OnboardingModal` renders `fixed inset-0 z-[200] bg-black/80` whenever
 * `termpolis.onboarding.seen.v1` is absent from localStorage — a full-screen overlay that
 * swallows every pointer event underneath it. Each spec now launches with its own fresh
 * `--user-data-dir` (see above), so localStorage starts empty on EVERY run and the tour is
 * always up. That single overlay accounted for the large majority of the whole-suite
 * failures: ~108 `locator.click: Timeout 30000ms exceeded` plus the
 * `strict mode violation: 'Welcome to Termpolis' resolved to 2 elements` cases, where the
 * modal heading collided with the welcome screen's.
 *
 * Writing the flag stops it coming back after a reload; clicking "Skip tour" clears the
 * instance that is already mounted. Both are needed, and both are safe to run when the
 * tour never appeared.
 */
export async function dismissOnboarding(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded').catch(() => {})
  await page.evaluate(() => {
    try {
      localStorage.setItem('termpolis.onboarding.seen.v1', '1')
      localStorage.setItem('termpolis.telemetry.optIn', '0')
    } catch { /* renderer not ready yet — the click path below still clears it */ }
  }).catch(() => {})

  const dialog = page.locator('[aria-labelledby="onboarding-title"]')
  if (await dialog.isVisible({ timeout: 5000 }).catch(() => false)) {
    await page.locator('button:has-text("Skip tour")').first().click({ force: true }).catch(() => {})
    await dialog.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {})
  }
}
