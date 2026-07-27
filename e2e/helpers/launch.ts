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
 * Make `e2e/test-shims/claude` look like an installed Claude Code to BOTH consumers.
 *
 * `TERMPOLIS_TEST_SHIM_DIR` alone is not enough: terminalManager.ts prepends it to the
 * PATH of spawned PTYs only, while the Start Swarm wizard gates on `agents:detect`, which
 * runs `which claude` in the MAIN process against `getExtendedPath()` — built from
 * `process.env.PATH`. So on a runner with no real binary the wizard rendered
 * "Claude Code Required" and every swarm spec sat waiting for a Describe step that was
 * never going to come. Prepending the shim dir to PATH satisfies the detector too.
 */
export function e2eShimEnv(label = 'e2e'): {
  TERMPOLIS_TEST_SHIM_DIR: string
  TERMPOLIS_TEST_USER_DATA_DIR: string
  PATH: string
} {
  const shimDir = path.resolve('e2e', 'test-shims')
  // The Unix shim loses its +x bit through some npm/git paths.
  try { fs.chmodSync(path.join(shimDir, 'claude'), 0o755) } catch { /* windows / already set */ }
  const sep = process.platform === 'win32' ? ';' : ':'
  return {
    TERMPOLIS_TEST_SHIM_DIR: shimDir,
    // The mocks talk to the app's MCP server, whose token the app writes into its
    // userData dir. That used to be the OS default path, so `mock-claude.cjs` hardcoded
    // it; now every spec runs under its own `--user-data-dir`, and the mock died with
    // ENOENT on `~/.config/termpolis/mcp-token`. `label` MUST match the one passed to
    // `e2eLaunchArgs`, or the mock reads a profile the app never wrote to.
    TERMPOLIS_TEST_USER_DATA_DIR: e2eUserDataDir(label),
    PATH: `${shimDir}${sep}${process.env.PATH ?? ''}`,
  }
}

/**
 * Clear any full-screen overlay a previous test left up.
 *
 * `test.describe.serial` specs share one window, so a modal that one test leaves open
 * becomes the NEXT test's `locator.click: Timeout 30000ms exceeded` — the click lands on
 * a `fixed inset-0` backdrop instead of the button underneath, and the error names the
 * innocent button rather than the modal. Escape alone is not enough: InstallHint and the
 * close-confirm have no key handler and only close via their own control or a backdrop
 * click, so try the explicit dismiss button first and fall back to Escape, then the
 * backdrop corner. `pointer-events-none` overlays are decorative and never intercept.
 */
export async function dismissOverlays(page: Page, attempts = 4): Promise<void> {
  const overlay = page.locator('div.fixed.inset-0:not(.pointer-events-none)').first()
  for (let i = 0; i < attempts; i++) {
    if (!(await overlay.isVisible({ timeout: 500 }).catch(() => false))) return
    const dismiss = page
      .locator('div.fixed.inset-0 button')
      .filter({ hasText: /^(Cancel|Close|Dismiss|Not now|Skip tour)$/ })
      .first()
    if (await dismiss.isVisible({ timeout: 500 }).catch(() => false)) {
      await dismiss.click({ timeout: 2000 }).catch(() => {})
    } else {
      await page.keyboard.press('Escape')
      await page.waitForTimeout(200)
      if (await overlay.isVisible({ timeout: 500 }).catch(() => false)) {
        await overlay.click({ position: { x: 5, y: 5 }, timeout: 2000 }).catch(() => {})
      }
    }
    await page.waitForTimeout(300)
  }
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
