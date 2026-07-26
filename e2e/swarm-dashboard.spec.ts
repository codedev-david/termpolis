/**
 * Swarm Dashboard — the UI contract, proven against the real app.
 *
 * `swarm-end-to-end.spec.ts` drives the whole conductor pipeline with a mock
 * agent CLI; it is thorough and slow and needs a shimmed `claude` on PATH. This
 * spec is the opposite: it takes no dependency on an agent binary at all, so it
 * is cheap enough to gate every push, and it pins the three things a user hits
 * first — and the one the docs make a promise about:
 *
 *   1. Ctrl+Shift+S (Cmd on macOS) opens the dashboard, and Tasks / Messages /
 *      Trace are all really there and really switch.
 *   2. **Start Swarm opens the directory picker BEFORE the wizard.** If the user
 *      dismisses the picker, no wizard appears and nothing is launched. This is
 *      the ordering the website docs describe, and it is a real invariant:
 *      `SwarmDashboard` renders `StartSwarmModal` only when `swarmCwd` is set,
 *      because every agent terminal the swarm spawns inherits that directory.
 *   3. When the picker DOES return a directory, the wizard opens.
 *
 * The picker is driven by re-registering `dialog:pick-directory` in the main
 * process, which is the only way to test the cancel path: a real
 * `dialog.showOpenDialog` would block a headless runner forever, and the
 * `TERMPOLIS_TEST_PROJECT_CWD` shim can only ever answer "yes".
 */
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import path from 'path'
import fs from 'fs'
import os from 'os'

let app: ElectronApplication | null = null
let page: Page | null = null
let isolatedUserData = ''
let projectDir = ''

/**
 * Everything is scoped to the dashboard's own modal, because "Start Swarm" is
 * NOT unique in the app — the empty-terminal welcome screen renders a card with
 * the same label, and an unscoped locator is a strict-mode violation rather than
 * a useful assertion.
 */
const dashboard = () => page!.locator('div.rounded-xl:has(> div > div > h2:text-is("Swarm Dashboard"))')
const tab = (label: string) => dashboard().locator(`button:has-text("${label}")`)
/** Unique to StartSwarmModal — the dashboard's launch control is a <button>. */
const wizardHeading = () => page!.locator('h2:text-is("Start Swarm")')
/** The dashboard's launch control, never the welcome-screen card. */
const startButton = () => dashboard().locator('button:has-text("Start Swarm")')
/** Tailwind's active-tab class. The inactive class only carries `hover:bg-…`, so
 *  matching the bare background is what makes "it switched" a real assertion. */
const ACTIVE_TAB = /bg-\[#37373d\]/

/** Replace the directory picker with one that answers deterministically. */
async function stubPicker(result: { success: boolean; data?: string; error?: string }): Promise<void> {
  await app!.evaluate(({ ipcMain }, r) => {
    ipcMain.removeHandler('dialog:pick-directory')
    ipcMain.handle('dialog:pick-directory', async () => r)
  }, result)
}

async function openDashboard(): Promise<void> {
  if (await dashboard().isVisible().catch(() => false)) return
  await page!.keyboard.press('ControlOrMeta+Shift+S')
  await expect(dashboard()).toBeVisible({ timeout: 15_000 })
}

test.beforeAll(async () => {
  test.setTimeout(300_000)
  const { execSync } = await import('child_process')
  execSync('npx electron-vite build', { cwd: path.resolve('.'), stdio: 'pipe' })

  // A real directory for the picker to return. Nothing is written to it — the
  // point is only that the wizard receives a genuine path.
  projectDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-swarmdash-')))
  // An isolated profile: without `--user-data-dir` this shares the single-instance
  // lock with any Termpolis already running and the launch dies with
  // "Target page … has been closed".
  isolatedUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-swarmdash-ud-'))

  app = await electron.launch({
    args: [
      path.resolve('out/main/index.js'),
      `--user-data-dir=${isolatedUserData}`,
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
    ],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      TERMPOLIS_TEST_AGENTS: '1',
      TERMPOLIS_SMOKE_SKIP_PICKERS: '1',
    },
  })
  app.process().stderr?.on('data', (d: Buffer) => console.log('[app stderr] ' + d.toString().trimEnd()))
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  const onboardDialog = page.locator('[aria-labelledby="onboarding-title"]')
  if (await onboardDialog.isVisible({ timeout: 5000 }).catch(() => false)) {
    await page.locator('button:has-text("Skip tour")').first().click({ force: true }).catch(() => {})
    await onboardDialog.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {})
  }
})

test.afterAll(async () => {
  try { await app?.close() } catch { /* already gone */ }
  for (const d of [projectDir, isolatedUserData]) {
    try { if (d) fs.rmSync(d, { recursive: true, force: true }) } catch { /* temp dir */ }
  }
})

test('Ctrl+Shift+S opens the dashboard and all three tabs switch', async () => {
  test.setTimeout(90_000)
  await openDashboard()

  for (const label of ['Tasks', 'Messages', 'Trace']) {
    await expect(tab(label)).toBeVisible()
  }
  // Tasks is the landing tab.
  await expect(tab('Tasks')).toHaveClass(ACTIVE_TAB)

  // Switching has to move the active marker, otherwise "the tab is there" proves
  // only that a label was rendered.
  await tab('Messages').click()
  await expect(tab('Messages')).toHaveClass(ACTIVE_TAB)
  await expect(tab('Tasks')).not.toHaveClass(ACTIVE_TAB)
  await tab('Trace').click()
  await expect(tab('Trace')).toHaveClass(ACTIVE_TAB)
  await expect(tab('Messages')).not.toHaveClass(ACTIVE_TAB)
  await tab('Tasks').click()
  await expect(tab('Tasks')).toHaveClass(ACTIVE_TAB)

  // No swarm has been started, so the launch control is offered, not locked.
  await expect(startButton()).toBeVisible()
  await expect(dashboard().locator('text=Swarm Active')).toHaveCount(0)
})

test('dismissing the directory picker launches nothing — no wizard, no swarm', async () => {
  test.setTimeout(90_000)
  await openDashboard()
  await stubPicker({ success: false, error: 'cancelled' })

  await startButton().click()

  // Give the click every chance to open something before asserting it didn't.
  await page!.waitForTimeout(3_000)
  await expect(wizardHeading()).toHaveCount(0)
  // And the dashboard is still sitting there, still offering to start one.
  await expect(startButton()).toBeVisible()
})

test('a chosen directory opens the wizard — the picker gates it, in that order', async () => {
  test.setTimeout(120_000)
  await openDashboard()
  await stubPicker({ success: true, data: projectDir })

  await startButton().click()

  // The wizard can only render once swarmCwd is set, and swarmCwd is only set
  // from the picker's result — so its appearance IS the ordering proof.
  await expect(wizardHeading()).toBeVisible({ timeout: 30_000 })

  // Whatever the conductor step resolves to on this runner (prepared, or the
  // "Claude Code Required" notice when no agent CLI is installed), the wizard is
  // open and owns the screen. Close it so the profile is left clean.
  const wizard = page!.locator('div.rounded-xl:has(> div > div > h2:text-is("Start Swarm"))')
  await wizard.locator('button:has(i.fa-xmark)').first().click({ force: true }).catch(() => {})
  await expect(wizardHeading()).toHaveCount(0, { timeout: 20_000 })
})
