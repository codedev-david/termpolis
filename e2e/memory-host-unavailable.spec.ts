/**
 * Memory host unavailable E2E (v1.54.5 typing hotfix, package P6) — drives the REAL Electron app.
 *
 * WHY. When the memory process (a utilityProcess) could not start or kept dying, memoryClient loaded the
 * whole store inside the MAIN process instead. That load is synchronous: 4.3 s on a 475 MB store, up to
 * 18.8 s with the index rebuild, on the thread that paints the window and echoes every keystroke. Above a
 * store-size limit (256 MB by default, TERMPOLIS_MEMORY_INPROC_MAX_MB) the client now stays off the main
 * thread: memory is "unavailable", every memory call is refused with an honest error, Settings says so,
 * and the process is retried in the background. The unit suite proves the client with a scripted host;
 * this proves the same story against a real utilityProcess that really dies, and that the healthy path
 * is untouched.
 *
 * Three launches of the real app, each with its own profile (the order does not matter):
 *   1. CONTROL — nothing wrong: the memory process comes up, the panel says so.
 *   2. The memory process dies at once and the store is above the limit (a 4 KB store against a ~1 KB
 *      limit): status 'unavailable', memory calls refused with the fixed text, Settings says so.
 *   3. CONTROL — the same dying process with the guard switched off: the old in-process fallback.
 *
 * The dying process is a one-line script that the app is told to run as its memory process through
 * TERMPOLIS_TEST_MEMORY_HOST_PATH (the same kind of seam as TERMPOLIS_TEST_SHIM_DIR).
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { _electron as electron } from 'playwright'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { quitApp, ensureE2eBuild } from './helpers/launch'

interface Launched {
  app: ElectronApplication
  page: Page
  userDataDir: string
}

/** A store of 4 KB of blank lines: valid for the real store, and well above a 0.001 MB (~1 KB) limit. */
function seedStore(userDataDir: string): void {
  fs.writeFileSync(path.join(userDataDir, 'swarm-memory.jsonl'), '\n'.repeat(4_000))
}

async function launch(label: string, extraEnv: Record<string, string>, seed?: (userDataDir: string) => void): Promise<Launched> {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `termpolis-${label}-`))
  fs.writeFileSync(
    path.join(userDataDir, 'session.json'),
    JSON.stringify({ terminals: [], workspaces: [], defaultShell: 'powershell', viewMode: 'tabs' }),
  )
  seed?.(userDataDir)

  const app = await electron.launch({
    args: [
      path.resolve('out/main/index.js'),
      `--user-data-dir=${userDataDir}`,
      // Ubuntu CI runners ship chrome-sandbox without SUID root → Electron aborts before JS runs.
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
    ],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      TERMPOLIS_SMOKE_SKIP_PICKERS: '1',
      ...extraEnv,
    },
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(1500)

  // Pre-dismiss the first-run onboarding modal so it doesn't trap the keyboard.
  await page.evaluate(() => {
    try {
      localStorage.setItem('termpolis.onboarding.seen.v1', '1')
      localStorage.setItem('termpolis.telemetry.optIn', '0')
    } catch {
      /* ignore */
    }
  })
  const onboardDialog = page.locator('[aria-labelledby="onboarding-title"]')
  if (await onboardDialog.isVisible({ timeout: 5000 }).catch(() => false)) {
    await page.locator('button:has-text("Skip tour")').first().click({ force: true }).catch(() => {})
    await onboardDialog.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {})
  }
  return { app, page, userDataDir }
}

async function teardown(l: Launched | undefined): Promise<void> {
  if (!l) return
  await quitApp(l.app)
  try { fs.rmSync(l.userDataDir, { recursive: true, force: true }) } catch { /* ignore */ }
}

/** A script that stands in for the memory process and dies at once, as one that cannot start does. */
function dyingHostScript(): { file: string; remove: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-memhost-script-'))
  const file = path.join(dir, 'memory-host-dies.js')
  fs.writeFileSync(file, 'process.exit(3)\n')
  return { file, remove: () => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ } } }
}

type Status = { success: boolean; data?: { mode: string; pid: number | null; attempt?: number; storeMB?: number | null; limitMB?: number; reason?: string }; error?: string }
const hostStatus = (page: Page): Promise<Status> =>
  page.evaluate(() => (window as unknown as { termpolis: { memoryHostStatus: () => Promise<unknown> } }).termpolis.memoryHostStatus() as Promise<Status>)

async function openMemorySettings(page: Page): Promise<void> {
  await page.evaluate(() => (window as unknown as { __setShowSettings: (v: boolean) => void }).__setShowSettings(true))
  const tab = page.locator('[data-testid="settings-tab-memory"]')
  await expect(tab).toBeVisible({ timeout: 10_000 })
  await tab.click()
  await expect(page.getByTestId('memory-learning-settings')).toBeVisible({ timeout: 10_000 })
}

test.beforeAll(() => {
  ensureE2eBuild()
})

test.describe('memory host: unavailable instead of a main-thread load', () => {
  // Each test launches its own app, waits for the memory process to settle, then opens Settings: more
  // than the 120 s default on a loaded Windows runner.
  test.describe.configure({ timeout: 180_000 })

  test('1. CONTROL: a healthy start is unchanged: the memory process comes up and Settings says so', async () => {
    let l: Launched | undefined
    try {
      l = await launch('memhost-ok', {}, seedStore)
      await expect
        .poll(async () => (await hostStatus(l!.page)).data?.mode, { timeout: 60_000, intervals: [500, 1000, 2000] })
        .toBe('host')
      const status = await hostStatus(l.page)
      expect(typeof status.data?.pid).toBe('number')   // a real second process
      expect(status.data?.attempt).toBeUndefined()      // nothing unavailable to report: no extra keys

      await openMemorySettings(l.page)
      const panel = l.page.getByTestId('brain-process-panel')
      await expect(panel).toHaveAttribute('data-mode', 'host', { timeout: 15_000 })
      await expect(panel).toContainText('Memory runs in its own process')
    } finally {
      await teardown(l)
    }
  })

  test('2. a memory process that dies, above the limit: unavailable, honest errors, and Settings says so', async () => {
    let l: Launched | undefined
    try {
      const script = dyingHostScript()
      try {
        l = await launch(
          'memhost-unavailable',
          { TERMPOLIS_TEST_MEMORY_HOST_PATH: script.file, TERMPOLIS_MEMORY_INPROC_MAX_MB: '0.001' },
          seedStore,
        )
        await expect
          .poll(async () => (await hostStatus(l!.page)).data?.mode, { timeout: 60_000, intervals: [500, 1000, 2000] })
          .toBe('unavailable')
        const status = await hostStatus(l.page)
        // (No assertion on the pid: a retry's child is alive for a moment every few seconds.)
        expect(status.data?.attempt).toBeGreaterThanOrEqual(1)
        expect(status.data?.limitMB).toBe(0)                     // 0.001 MB rounds to 0: the limit WAS applied
        expect(String(status.data?.reason).length).toBeGreaterThan(0) // it says WHY

        // The main thread did not load the store: had it, this count would be an answer, not a refusal.
        const count = await l.page.evaluate(() =>
          (window as unknown as { termpolis: { memoryCount: () => Promise<{ success: boolean; error?: string }> } }).termpolis.memoryCount(),
        )
        expect(count.success).toBe(false)
        expect(count.error).toMatch(/^Memory is unavailable \(/)

        await openMemorySettings(l.page)
        const panel = l.page.getByTestId('brain-process-panel')
        await expect(panel).toHaveAttribute('data-mode', 'unavailable', { timeout: 15_000 })
        await expect(panel).toContainText('Memory is unavailable, retrying')
        await expect(panel).not.toContainText('Memory is running on the main thread')
      } finally {
        script.remove()
      }
    } finally {
      await teardown(l)
    }
  })

  test('3. CONTROL: with the guard switched off, the same dying process still falls back to the main thread', async () => {
    let l: Launched | undefined
    try {
      const script = dyingHostScript()
      try {
        l = await launch(
          'memhost-guard-off',
          { TERMPOLIS_TEST_MEMORY_HOST_PATH: script.file, TERMPOLIS_MEMORY_INPROC_MAX_MB: '0.001', TERMPOLIS_MEMORY_INPROC_GUARD: 'off' },
          seedStore,
        )
        await expect
          .poll(async () => (await hostStatus(l!.page)).data?.mode, { timeout: 60_000, intervals: [500, 1000, 2000] })
          .toBe('inproc')

        // Today's behaviour, kept: the store is served from the main thread.
        const count = await l.page.evaluate(() =>
          (window as unknown as { termpolis: { memoryCount: () => Promise<{ success: boolean; data?: number }> } }).termpolis.memoryCount(),
        )
        expect(count.success).toBe(true)

        await openMemorySettings(l.page)
        const panel = l.page.getByTestId('brain-process-panel')
        await expect(panel).toHaveAttribute('data-mode', 'inproc', { timeout: 15_000 })
        await expect(panel).toContainText('Memory is running on the main thread')
      } finally {
        script.remove()
      }
    } finally {
      await teardown(l)
    }
  })
})
