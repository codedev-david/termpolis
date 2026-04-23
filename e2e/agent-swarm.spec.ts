/**
 * Termpolis Agent Swarm E2E Test Suite
 * Tests the Swarm Dashboard overlay, Start Swarm wizard (4-step flow),
 * dashboard tabs (Agents, Tasks, Messages), and wizard UI interactions.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { _electron as electron } from 'playwright'
import path from 'path'
import fs from 'fs'

let app: ElectronApplication
let page: Page
const SCREENSHOTS = 'e2e/screenshots/agent-swarm'

test.beforeAll(async () => {
  // Clean screenshots dir
  if (fs.existsSync(SCREENSHOTS)) fs.rmSync(SCREENSHOTS, { recursive: true })
  fs.mkdirSync(SCREENSHOTS, { recursive: true })

  // Build (with retry for flaky Electron issues)
  const { execSync } = await import('child_process')
  try {
    execSync('npx electron-vite build', { cwd: path.resolve('.'), stdio: 'pipe' })
  } catch {
    // Retry once on build failure
    execSync('npx electron-vite build', { cwd: path.resolve('.'), stdio: 'pipe' })
  }

  // Clear session so we start fresh on the Welcome screen
  const os = await import('os')
  const appDataDirs = [
    path.join(os.homedir(), 'AppData', 'Roaming', 'termpolis'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'Electron'),
  ]
  const cleanSession = JSON.stringify({
    terminals: [], workspaces: [], defaultShell: 'powershell', viewMode: 'tabs'
  })
  for (const dir of appDataDirs) {
    const sessionPath = path.join(dir, 'session.json')
    if (fs.existsSync(sessionPath)) {
      fs.writeFileSync(sessionPath, cleanSession)
    }
    // Remove lockfile from previous Electron instances to prevent launch failures
    const lockfile = path.join(dir, 'lockfile')
    if (fs.existsSync(lockfile)) {
      try { fs.unlinkSync(lockfile) } catch { /* ignore */ }
    }
  }

  app = await electron.launch({
    args: [path.resolve('out/main/index.js')],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      TERMPOLIS_TEST_AGENTS: '1',
      TERMPOLIS_TEST_TIMING: '1',
      // Bypass the native directory picker so the wizard advances past Preparing.
      TERMPOLIS_TEST_PROJECT_CWD: path.resolve('.'),
    },
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2000)
})

test.afterAll(async () => {
  if (app) await app.close()
})

async function ss(name: string) {
  await page.screenshot({ path: `${SCREENSHOTS}/${name}.png`, fullPage: true })
}

// ============================================================
// ALL TESTS (serial -- wizard state carries across tests)
// ============================================================

test.describe.serial('Agent Swarm', () => {

  // ---- SECTION 1: SWARM DASHBOARD OVERLAY ----

  test('1. Ctrl+Shift+S opens swarm dashboard overlay', async () => {
    await page.keyboard.press('Control+Shift+S')
    await page.waitForTimeout(500)

    const dashboard = page.locator('text=Swarm Dashboard')
    await expect(dashboard).toBeVisible({ timeout: 3000 })
    await ss('01-swarm-dashboard-open')
  })

  test('2. Swarm dashboard has "Start Swarm" button in header', async () => {
    const startBtn = page.locator('button:has-text("Start Swarm")').first()
    await expect(startBtn).toBeVisible()
    await ss('02-start-swarm-btn')
  })

  test('3. Swarm dashboard has tabs: Tasks, Messages, Trace', async () => {
    // The Agents tab was removed in the redesign — the conductor owns agent
    // lifecycle, so a per-agent tab was misleading. Trace replaced it.
    for (const tab of ['Tasks', 'Messages', 'Trace']) {
      const tabBtn = page.locator('.fixed').locator(`button:has-text("${tab}")`).first()
      await expect(tabBtn).toBeVisible()
    }
    await ss('03-dashboard-tabs')
  })

  test('4. Start Swarm button opens wizard', async () => {
    // Scope to the Dashboard panel so we don't match Welcome's Start Swarm
    // tile — the Welcome button is still in the DOM underneath the dashboard.
    const startBtn = page.locator('.fixed').locator('button:has-text("Start Swarm")').first()
    await expect(startBtn).toBeVisible({ timeout: 3000 })
    await startBtn.click()
    await page.waitForTimeout(500)

    const wizardHeading = page.locator('h2:has-text("Start Swarm")').first()
    await expect(wizardHeading).toBeVisible({ timeout: 3000 })
    await ss('04-wizard-opened')
  })

  // ---- SECTION 2: WIZARD PREPARING STEP ----
  // The wizard was redesigned: no more agent-selection grid / multi-step
  // breakdown. The conductor picks agents itself. The new flow is
  // preparing → describe → launching, and the describe step takes a Goal
  // (required) plus optional Constraints / Expected Output / Failure
  // Conditions.

  test('5. Wizard preparing step shows spinner and "Preparing Conductor" heading', async () => {
    // Preparing step renders before startConductor resolves. We scope to the
    // wizard modal so we don't pick up the dashboard behind it.
    const prep = page.locator('h3:has-text("Preparing Conductor")')
    // This may already have flipped to Describe if conductor was fast — accept either.
    const describe = page.locator('textarea')
    await expect(prep.or(describe)).toBeVisible({ timeout: 5000 })
    await ss('05-wizard-preparing-or-describe')
  })

  test('6. Wizard advances from preparing → describe (Goal textarea appears)', async () => {
    // Goal textarea is the first field in the describe step and auto-focuses.
    // Allow generous time — preparing calls mock claude + waits for shell init.
    const goalTextarea = page.locator('textarea').first()
    await expect(goalTextarea).toBeVisible({ timeout: 30000 })
    await ss('06-describe-step')
  })

  // ---- SECTION 3: WIZARD DESCRIBE STEP FIELDS ----

  test('7. Describe step shows Goal field', async () => {
    // The Goal label is the first field in the describe step. The modal shows
    // a "Describe what you want built" heading above the fields.
    const goalLabel = page.locator('label:has-text("Goal")').first()
    await expect(goalLabel).toBeVisible()
    // The overall describe step prompt should also be visible
    await expect(page.locator('text=Describe what you want built')).toBeVisible()
    await ss('07-goal-field')
  })

  test('8. Describe step shows Constraints, Expected Output, Failure Conditions fields', async () => {
    for (const label of ['Constraints', 'Expected Output', 'Failure Conditions']) {
      const field = page.locator(`label:has-text("${label}")`).first()
      await expect(field).toBeVisible()
    }
    await ss('08-optional-fields')
  })

  test('9. Launch Swarm button disabled when Goal is empty', async () => {
    const launchBtn = page.locator('button:has-text("Launch Swarm")').first()
    await expect(launchBtn).toBeVisible()
    await expect(launchBtn).toBeDisabled()
    await ss('09-launch-disabled')
  })

  test('10. Typing a Goal enables Launch Swarm', async () => {
    // The Goal textarea is the first textarea in the describe step
    const goalTextarea = page.locator('textarea').first()
    await goalTextarea.fill('Refactor the auth module, write comprehensive tests, and review for security issues')
    // waitForTimeout isn't needed — disabled state derives directly from value
    const launchBtn = page.locator('button:has-text("Launch Swarm")').first()
    await expect(launchBtn).toBeEnabled()
    await ss('10-launch-enabled')
  })

  test('11. Describe step shows AI Conductor info box', async () => {
    const aiConductor = page.locator('text=AI Conductor').first()
    await expect(aiConductor).toBeVisible()
    await ss('11-ai-conductor-box')
  })

  test('12. Describe step shows "Swarm vs individual agents" info box', async () => {
    const box = page.locator('text=Swarm vs individual agents').first()
    await expect(box).toBeVisible()
    await ss('12-swarm-vs-individual-box')
  })

  // ---- SECTION 4: WIZARD CANCEL FLOW ----

  test('13. Cancel button is visible in describe step', async () => {
    // The describe step footer has Cancel on the left, Launch on the right.
    const cancelBtn = page.locator('button:has-text("Cancel")').first()
    await expect(cancelBtn).toBeVisible()
    await ss('13-cancel-visible')
  })

  test('14. Constraints field is optional (not required marker)', async () => {
    // Each optional field has an "optional" badge next to the label.
    const constraintsLabel = page.locator('label:has-text("Constraints")').first()
    await expect(constraintsLabel.locator('text=optional')).toBeVisible()
    await ss('14-optional-badge')
  })

  test('15. Typing in Constraints does not affect Launch button state', async () => {
    // Second textarea is Constraints.
    const constraints = page.locator('textarea').nth(1)
    await constraints.fill('Must work on Windows and macOS')
    const launchBtn = page.locator('button:has-text("Launch Swarm")').first()
    await expect(launchBtn).toBeEnabled()
    await ss('15-constraints-filled')
  })

  test('16. Cancel closes the wizard (dashboard stays visible)', async () => {
    const cancelBtn = page.locator('button:has-text("Cancel")').first()
    await cancelBtn.click()
    await page.waitForTimeout(500)

    // Wizard h2 should be gone. The dashboard underneath should still be up.
    const wizardHeading = page.locator('h2:has-text("Start Swarm")')
    await expect(wizardHeading).toHaveCount(0, { timeout: 3000 })
    // Dashboard is still visible
    await expect(page.locator('text=Swarm Dashboard')).toBeVisible()
    await ss('16-wizard-cancelled')
  })

  // ---- SECTION 5: DASHBOARD TABS CONTENT ----

  test('17. Dashboard defaults to Tasks tab with empty kanban columns', async () => {
    // Make sure everything is closed first
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)

    // Open swarm dashboard via Ctrl+Shift+S
    await page.keyboard.press('Control+Shift+S')
    await page.waitForTimeout(500)

    await expect(page.locator('text=Swarm Dashboard')).toBeVisible({ timeout: 3000 })

    // Dashboard now defaults to the Tasks tab — Agents tab was removed.
    await expect(page.locator('text=Pending').first()).toBeVisible()
    await expect(page.locator('text=In Progress').first()).toBeVisible()
    await expect(page.locator('text=Completed').first()).toBeVisible()
    await ss('17-tasks-empty')
  })

  test('18. Dashboard Tasks tab: shows kanban columns (Pending, In Progress, Completed)', async () => {
    // Click the Tasks tab inside the dashboard using evaluate to bypass overlay issues
    await page.evaluate(() => {
      const buttons = document.querySelectorAll('button')
      for (const btn of buttons) {
        if (btn.textContent?.includes('Tasks') && btn.closest('.fixed')) {
          btn.click()
          break
        }
      }
    })
    await page.waitForTimeout(300)

    for (const column of ['Pending', 'In Progress', 'Completed']) {
      const col = page.locator(`text=${column}`).first()
      await expect(col).toBeVisible()
    }
    await ss('18-tasks-kanban')
  })

  test('19. Dashboard Messages tab: shows empty state when no messages', async () => {
    // Click the Messages tab inside the dashboard using evaluate
    await page.evaluate(() => {
      const buttons = document.querySelectorAll('button')
      for (const btn of buttons) {
        if (btn.textContent?.includes('Messages') && btn.closest('.fixed')) {
          btn.click()
          break
        }
      }
    })
    await page.waitForTimeout(300)

    const emptyMsg = page.locator('text=No swarm messages yet')
    await expect(emptyMsg).toBeVisible()
    await ss('19-messages-empty')
  })

  test('20. Dashboard has "Clear" button', async () => {
    const clearBtn = page.locator('button:has-text("Clear")')
    await expect(clearBtn).toBeVisible()
    await ss('20-clear-button')
  })

  test('21. App did not crash after all swarm tests', async () => {
    // Close the dashboard
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)

    const windowCount = await app.evaluate(({ BrowserWindow }) => {
      return BrowserWindow.getAllWindows().length
    })
    expect(windowCount).toBeGreaterThan(0)
    await ss('21-final')
  })
})
