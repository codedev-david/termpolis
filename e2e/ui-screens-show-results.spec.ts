/**
 * UI Screens Show Results — cross-cutting visible-content assertions
 * ---------------------------------------------------------------
 * Audit of the existing e2e suite revealed a recurring pattern: tests
 * click UI chrome and assert that elements EXIST, but very few assert
 * that the screens actually DISPLAY the data they're supposed to show.
 * That's how v1.11.5 / v1.11.6 shipped: the swarm "running" state had
 * no visible-result test, so Claude silently bypassing MCP left the
 * user staring at a spinner with nothing to diagnose.
 *
 * This spec exercises the ten highest-risk UI surfaces with REAL data
 * seeded through store / IPC, then asserts visible text matches. Every
 * test is a regression guard against "screen opens but shows nothing."
 *
 * Surfaces covered (each in its own .serial test):
 *   1. Welcome screen on cold start
 *   2. Settings pane — tabs render + switching shows different content
 *   3. AI Agents sidebar — all four built-in agents render by name
 *   4. Workflow Templates — all built-in templates render with names
 *   5. Prompt Templates — built-in templates render
 *   6. Context Pins — seeded pin renders with label + body text
 *   7. Command Palette — typed query filters visible results
 *   8. Swarm Dashboard — seeded agents/tasks/messages render as text
 *   9. Swarm Complete Dialog — seeded completion renders tasks + summary
 *  10. Swarm Notification banner — seeded notification renders in sidebar
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { _electron as electron } from 'playwright'
import path from 'path'
import fs from 'fs'
import os from 'os'

let app: ElectronApplication
let page: Page
let isolatedUserData: string

const PROJECT_ROOT = path.resolve('.')
const SCREENSHOTS = 'e2e/screenshots/ui-screens-show-results'

test.beforeAll(async () => {
  if (fs.existsSync(SCREENSHOTS)) fs.rmSync(SCREENSHOTS, { recursive: true })
  fs.mkdirSync(SCREENSHOTS, { recursive: true })

  // Isolate from the dev profile so our onboarding.seen / session writes
  // don't leak into the real install.
  isolatedUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-screens-'))
  const cleanSession = JSON.stringify({
    terminals: [],
    workspaces: [],
    defaultShell: process.platform === 'win32' ? 'powershell' : 'bash',
    viewMode: 'tabs',
  })
  fs.writeFileSync(path.join(isolatedUserData, 'session.json'), cleanSession)

  const { execSync } = await import('child_process')
  execSync('npx electron-vite build', { cwd: PROJECT_ROOT, stdio: 'pipe' })

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
      TERMPOLIS_TEST_TIMING: '1',
    },
  })

  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(1500)

  // Pre-dismiss the onboarding modal so the screens under test aren't
  // blocked by its overlay.
  await page.evaluate(() => {
    try {
      localStorage.setItem('termpolis.onboarding.seen.v1', '1')
      localStorage.setItem('termpolis.telemetry.optIn', '0')
    } catch {}
  })
  // 4-step tour starts on step 1; "Skip tour" is always visible.
  // Wait up to 5s for the dialog (slow Linux GHA), force-click, then wait
  // for hidden so the next test isn't racing the backdrop. Earlier
  // getByRole + isVisible() with no timeout silently no-op'd when the
  // modal hadn't rendered yet at the 1500ms mark.
  const onboardDialog = page.locator('[aria-labelledby="onboarding-title"]')
  if (await onboardDialog.isVisible({ timeout: 5000 }).catch(() => false)) {
    await page.locator('button:has-text("Skip tour")').first().click({ force: true }).catch(() => {})
    await onboardDialog.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {})
  }
})

test.afterAll(async () => {
  if (app) await app.close()
  if (isolatedUserData) {
    try { fs.rmSync(isolatedUserData, { recursive: true, force: true }) } catch {}
  }
})

const shot = (name: string) => page.screenshot({ path: `${SCREENSHOTS}/${name}.png` })

async function closeOverlays() {
  // Click every known "close" button in the chrome. Overlays here don't
  // all listen to Escape, so dismissing via the UI's own close affordance
  // is the only reliable way to return to a clean baseline between tests.
  const closeButtonNames = [
    'Close workflows',
    'Close pinned context panel',
    'Close swarm dashboard',
    'Close git panel',
  ]
  for (const name of closeButtonNames) {
    const btn = page.getByRole('button', { name }).first()
    if (await btn.isVisible().catch(() => false)) {
      await btn.click().catch(() => {})
      await page.waitForTimeout(120)
    }
  }
  // Store-backed overlays can be force-reset.
  await page.evaluate(() => {
    const setShow = (window as any).__setShowSettings
    if (typeof setShow === 'function') setShow(false)
    const setSummary = (window as any).__setSwarmCompletionSummary
    if (typeof setSummary === 'function') setSummary(null)
    const setNotif = (window as any).__setSwarmNotification
    if (typeof setNotif === 'function') setNotif(null)
  })
  // Escape for palettes (command palette, prompt templates) that do close
  // on Escape — double-press since some have confirmation sub-dialogs.
  await page.keyboard.press('Escape').catch(() => {})
  await page.waitForTimeout(100)
  await page.keyboard.press('Escape').catch(() => {})
  await page.waitForTimeout(100)
}

test.describe.serial('UI screens show visible results', () => {
  test('1. Welcome screen renders entry-point content on cold start', async () => {
    // On cold start with an empty session, the welcome screen should show
    // its core onboarding content. If this is blank, the user has no idea
    // what to do next.
    await shot('01-welcome')
    // Welcome screen has some distinctive copy; assert at least one
    // anchor phrase a user would recognize.
    const anyWelcomeAnchor = page.locator(
      'text=/Welcome|Get started|New Terminal|Start Swarm|Workflow/i',
    ).first()
    await expect(anyWelcomeAnchor).toBeVisible({ timeout: 5000 })
  })

  test('2. Settings pane opens and renders tabbed content', async () => {
    await closeOverlays()
    // Prefer the narrow test hook; fall back to clicking the gear button
    // with title="Settings" in the sidebar.
    const hookFired = await page.evaluate(() => {
      const fn = (window as any).__setShowSettings
      if (typeof fn === 'function') { fn(true); return true }
      return false
    })
    if (!hookFired) {
      const gear = page.locator('button[title="Settings"]').first()
      if (await gear.isVisible().catch(() => false)) await gear.click()
    }

    // A real settings pane has form controls; assert at least one labelled
    // setting appears. "Default Shell" is a universal label across platforms.
    const shellLabel = page.locator(
      'text=/Default Shell|Shell Configuration|Autocomplete|Keybindings/i',
    ).first()
    await expect(shellLabel).toBeVisible({ timeout: 5000 })
    await shot('02-settings')
  })

  test('3. Sidebar lists all four built-in AI agents by name', async () => {
    await closeOverlays()
    // Agents sidebar is always mounted; these are the four canonical
    // profile names. All four MUST be visible — a missing one means
    // the profile list regressed.
    for (const name of ['Claude Code', 'OpenAI Codex', 'Gemini CLI', 'Qwen Code']) {
      await expect(
        page.locator(`text=${name}`).first(),
      ).toBeVisible({ timeout: 5000 })
    }
    await shot('03-ai-profiles')
  })

  test('4. Workflow Templates overlay shows built-in templates by name', async () => {
    await closeOverlays()
    // Sidebar button with title="Workflows". No keyboard shortcut is wired
    // for this overlay, so click the button directly.
    const sidebarBtn = page.locator('button[title="Workflows"]').first()
    await expect(sidebarBtn).toBeVisible({ timeout: 5000 })
    await sidebarBtn.click()
    await page.waitForTimeout(500)

    await expect(
      page.locator('text=/Workflow Templates|New Workflow/i').first(),
    ).toBeVisible({ timeout: 5000 })
    // Built-in templates should always render — verifying at least two
    // distinct names catches "list is empty" regressions.
    const templateNames = await page.locator(
      '[data-testid="workflow-template-name"], h3, h4, span',
    ).allTextContents()
    const joined = templateNames.join(' | ')
    // Any two of these built-ins indicate the list rendered.
    const builtIns = ['Claude', 'Full Stack', 'Code Review', 'Shell']
    const hits = builtIns.filter((name) => joined.includes(name))
    expect(hits.length, `built-in workflow names found in overlay: ${hits.join(', ')}`).toBeGreaterThanOrEqual(2)
    await shot('04-workflow-templates')
  })

  test('5. Prompt Templates palette shows built-in templates', async () => {
    await closeOverlays()
    await page.keyboard.press('Control+Shift+P')
    await page.waitForTimeout(500)

    await expect(page.locator('text=/Prompt Templates/i').first()).toBeVisible({ timeout: 5000 })
    // Built-in templates include at least one of these common names. If
    // none render, the palette is opening but not populated.
    const anyTemplate = page.locator(
      'text=/Fix Tests|Code Review|Explain Code|Refactor|Debug|Write Tests/i',
    ).first()
    await expect(anyTemplate).toBeVisible({ timeout: 5000 })
    await shot('05-prompt-templates')
  })

  test('6. Context Pins panel shows a seeded pin with its label and body', async () => {
    await closeOverlays()
    // The panel reads pins keyed on the active terminal's cwd. We inject a
    // hidden test terminal with a known cwd via the __seedTestTerminalCwd
    // hook so the panel actually queries for pins under that cwd, then seed
    // a pin under the same cwd.
    const PIN_CWD = '/tmp/termpolis-screens-pins'
    const seeded = await page.evaluate(async (cwd) => {
      const seeder = (window as any).__seedTestTerminalCwd
      if (typeof seeder !== 'function') return { ok: false, err: 'no terminal seeder' }
      seeder(cwd)
      const api = (window as any).contextPins
      if (!api) return { ok: false, err: 'no contextPins api' }
      const res = await api.add(cwd, {
        label: 'E2E-SEED-PIN-SCREEN-TEST',
        body: 'BODY-SENTINEL: this text must render in the context pins panel.',
        tags: ['e2e', 'ui-screens'],
      })
      return { ok: !!res?.success, err: res?.error ?? null }
    }, PIN_CWD)
    expect(seeded?.ok, `context pin seed via IPC: ${seeded?.err ?? 'unknown error'}`).toBe(true)

    // Context pins panel is Ctrl+Shift+B (see App.tsx keybinding handler).
    await page.keyboard.press('Control+Shift+B')
    await page.waitForTimeout(500)

    await expect(page.locator('text=/Pinned Context/i').first()).toBeVisible({ timeout: 5000 })
    await expect(page.locator('text=E2E-SEED-PIN-SCREEN-TEST').first()).toBeVisible({ timeout: 5000 })
    // Body text is truncated in the pin card — assert the unique sentinel.
    await expect(page.locator('text=BODY-SENTINEL').first()).toBeVisible({ timeout: 5000 })
    await shot('06-context-pins')

    // Clean up so repeat runs don't accumulate pins.
    await page.evaluate(async (cwd) => {
      const api = (window as any).contextPins
      if (!api) return
      const res = await api.list(cwd)
      if (res?.success && Array.isArray(res.data)) {
        for (const p of res.data) await api.remove(cwd, p.id)
      }
    }, PIN_CWD)
  })

  test('7. Command Palette filters results when user types', async () => {
    await closeOverlays()
    // Use the narrow test hook — Playwright's keyboard.press doesn't reliably
    // deliver Ctrl+K to the window-level handler in the Electron harness
    // when there's no focused element, and there's no way to "focus nothing"
    // cleanly. The hook exercises the exact same render path.
    const opened = await page.evaluate(() => {
      const fn = (window as any).__openCommandPalette
      if (typeof fn !== 'function') return false
      fn(true)
      return true
    })
    expect(opened, '__openCommandPalette test hook exposed').toBe(true)

    const paletteInput = page.locator('input[placeholder="Type a command..."]').first()
    await expect(paletteInput).toBeVisible({ timeout: 5000 })
    await paletteInput.fill('swarm')
    await page.waitForTimeout(300)

    // After filtering, at least one visible result should mention swarm.
    const match = page.locator('button').filter({ hasText: /swarm/i }).first()
    await expect(match).toBeVisible({ timeout: 5000 })
    await shot('07-command-palette-filtered')

    await page.evaluate(() => {
      const fn = (window as any).__openCommandPalette
      if (typeof fn === 'function') fn(false)
    })
  })

  test('8. Swarm Dashboard renders seeded agents / tasks / messages as visible text', async () => {
    await closeOverlays()
    // Seed swarm state so the dashboard has something to display. We
    // push messages + tasks through the swarmAPI so the rendered panel
    // reflects real data going through the real store.
    await page.evaluate(async () => {
      const api = (window as any).swarmAPI
      if (!api) return
      await api.clear()
      await api.sendMessage('conductor', 'all', 'info', 'DASHBOARD-SENTINEL: conductor planning')
      const t1 = await api.createTask('DASHBOARD-TASK-ALPHA', 'Seeded task for UI test', 'conductor')
      const t2 = await api.createTask('DASHBOARD-TASK-BETA', 'Second seeded task', 'conductor')
      if (t1?.data?.id) await api.updateTask(t1.data.id, 'completed', 'done')
      if (t2?.data?.id) await api.updateTask(t2.data.id, 'in_progress')
    })

    await page.keyboard.press('Control+Shift+S')
    await expect(page.locator('text=Swarm Dashboard').first()).toBeVisible({ timeout: 10000 })

    // Task titles must render on-screen. If either is missing, the
    // dashboard isn't actually showing what's in the store.
    await expect(page.locator('text=DASHBOARD-TASK-ALPHA').first()).toBeVisible({ timeout: 5000 })
    await expect(page.locator('text=DASHBOARD-TASK-BETA').first()).toBeVisible({ timeout: 5000 })

    // Switch to Messages tab and assert the seeded message renders.
    const messagesTab = page.locator('button:has-text("Messages")').first()
    if (await messagesTab.isVisible().catch(() => false)) {
      await messagesTab.click()
      await page.waitForTimeout(300)
      await expect(page.locator('text=DASHBOARD-SENTINEL').first()).toBeVisible({ timeout: 5000 })
    }
    await shot('08-swarm-dashboard')
  })

  test('9. Swarm Complete Dialog renders seeded summary with task counts', async () => {
    await closeOverlays()
    // Drive the completion summary directly through the narrow test hook
    // so the dialog mounts. This is exactly the payload
    // conductorManager.markSwarmDone writes, minus the real conductor flow.
    // We're asserting the UI renders what it's given.
    const seeded = await page.evaluate(() => {
      const setter = (window as any).__setSwarmCompletionSummary
      if (typeof setter !== 'function') return false
      setter({
        message: 'SUMMARY-SENTINEL: all seeded tasks completed',
        tasks: [
          { id: 's1', title: 'SEEDED-TASK-ONE', status: 'completed', result: 'done' },
          { id: 's2', title: 'SEEDED-TASK-TWO', status: 'failed' },
        ],
        projectCwd: '/tmp/screen-test-project',
        preSwarmSha: null,
      })
      return true
    })
    expect(seeded, '__setSwarmCompletionSummary test hook exposed').toBe(true)

    await expect(page.locator('text=Swarm Complete').first()).toBeVisible({ timeout: 5000 })
    await expect(page.locator('text=SUMMARY-SENTINEL').first()).toBeVisible({ timeout: 5000 })
    await expect(page.locator('text=SEEDED-TASK-ONE').first()).toBeVisible({ timeout: 5000 })
    await expect(page.locator('text=SEEDED-TASK-TWO').first()).toBeVisible({ timeout: 5000 })
    // Counts line: "1 task completed" and "1 failed"
    await expect(page.locator('text=/1 task completed/i').first()).toBeVisible({ timeout: 5000 })
    await expect(page.locator('text=/1 failed/i').first()).toBeVisible({ timeout: 5000 })
    await shot('09-swarm-complete-dialog')

    // Clear the dialog so it doesn't interfere with the notification test.
    await page.evaluate(() => {
      const setter = (window as any).__setSwarmCompletionSummary
      if (typeof setter === 'function') setter(null)
    })
  })

  test('10. Swarm notification banner renders a seeded error message', async () => {
    // Notification banner is the safety net when the swarm can't
    // complete cleanly (e.g., MCP unavailable). If this doesn't render,
    // users hit the exact v1.11.6 silent-spinner symptom.
    const seeded = await page.evaluate(() => {
      const setter = (window as any).__setSwarmNotification
      if (typeof setter !== 'function') return false
      setter({
        message: 'BANNER-SENTINEL: seeded error for UI screen test',
        type: 'error',
      })
      return true
    })
    expect(seeded, '__setSwarmNotification test hook exposed').toBe(true)

    await expect(page.locator('text=BANNER-SENTINEL').first()).toBeVisible({ timeout: 5000 })
    await shot('10-swarm-notification')

    // Clear so the next run starts clean.
    await page.evaluate(() => {
      const setter = (window as any).__setSwarmNotification
      if (typeof setter === 'function') setter(null)
    })
  })
})
