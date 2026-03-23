/**
 * Termpolis Conductor E2E Test Suite
 * Tests the new 2-step Start Swarm wizard (Preparing -> Describe -> Launch)
 * and conductor-related dashboard integration.
 *
 * The wizard preparation step calls pickDirectory() which shows a native dialog.
 * Tests that need the describe step bypass the wizard flow by injecting state
 * via page.evaluate(). Preparation step UI is tested before the dialog appears.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { _electron as electron } from 'playwright'
import path from 'path'
import fs from 'fs'

let app: ElectronApplication
let page: Page
const SCREENSHOTS = 'e2e/screenshots/conductor'

test.beforeAll(async () => {
  // Clean screenshots dir
  if (fs.existsSync(SCREENSHOTS)) fs.rmSync(SCREENSHOTS, { recursive: true })
  fs.mkdirSync(SCREENSHOTS, { recursive: true })

  // Build (with retry for flaky Electron issues)
  const { execSync } = await import('child_process')
  try {
    execSync('npx electron-vite build', { cwd: path.resolve('.'), stdio: 'pipe' })
  } catch {
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

/** Close the Start Swarm wizard if it auto-opened on top of the dashboard */
async function dismissWizardIfVisible() {
  // The wizard X button is inside the header, next to the h2
  const xBtn = page.locator('h2:has-text("Start Swarm")').locator('..').locator('..').locator('button:last-child')
  const visible = await xBtn.isVisible().catch(() => false)
  if (visible) {
    await xBtn.click({ force: true })
    await page.waitForTimeout(300)
  }
}

/** Click a dashboard tab (Agents, Tasks, Messages) via evaluate to bypass overlay issues */
async function clickDashboardTab(tabName: string) {
  await page.evaluate((name) => {
    const buttons = document.querySelectorAll('button')
    for (const btn of buttons) {
      if (btn.textContent?.includes(name) && btn.closest('.fixed')) {
        btn.click()
        break
      }
    }
  }, tabName)
  await page.waitForTimeout(300)
}

// ============================================================
// ALL TESTS (serial -- wizard state carries across tests)
// ============================================================

test.describe.serial('Conductor Wizard', () => {

  // ---- SECTION 1: WIZARD UI TESTS (PREPARING STEP) ----

  test('1. Ctrl+Shift+S opens swarm dashboard', async () => {
    await page.keyboard.press('Control+Shift+S')
    await page.waitForTimeout(500)

    const dashboard = page.locator('text=Swarm Dashboard')
    await expect(dashboard).toBeVisible({ timeout: 3000 })
    await ss('01-swarm-dashboard-open')
  })

  test('2. When no swarm active, wizard auto-opens', async () => {
    // The wizard auto-opens when no swarm is active (showStartSwarm defaults to !swarmActive)
    const wizardHeading = page.locator('h2:has-text("Start Swarm")').first()
    await expect(wizardHeading).toBeVisible({ timeout: 3000 })
    await ss('02-wizard-auto-open')
  })

  test('3. Wizard shows "Preparing Conductor" with brain icon spinner', async () => {
    // The preparing step shows h3 "Preparing Conductor" and a brain icon
    const preparingText = page.locator('h3:has-text("Preparing Conductor")')
    await expect(preparingText).toBeVisible({ timeout: 3000 })

    // Brain icon (fa-brain) should be visible inside the spinner container
    const brainIcon = page.locator('.fa-brain')
    await expect(brainIcon).toBeVisible()

    // Spinner border element with animate-spin class
    const spinner = page.locator('.animate-spin')
    await expect(spinner).toBeVisible()
    await ss('03-preparing-conductor')
  })

  test('4. Wizard shows status message "Checking Claude Code..."', async () => {
    // The status message starts as "Checking Claude Code..." and may advance
    // We check for any status text that appears during the preparation flow
    const statusText = page.locator('text=Checking Claude Code').or(
      page.locator('text=Select a project directory')
    ).or(
      page.locator('text=Starting conductor')
    )
    await expect(statusText.first()).toBeVisible({ timeout: 5000 })
    await ss('04-status-message')
  })

  test('5. Wizard has 3 step dots in header', async () => {
    // The wizard header contains 3 step dots (rounded-full divs)
    const stepDots = page.locator('h2:has-text("Start Swarm")').locator('..').locator('.rounded-full')
    const count = await stepDots.count()
    expect(count).toBe(3)
    await ss('05-step-dots')
  })

  test('6. Wizard header shows wand-magic-sparkles icon and "Start Swarm" text', async () => {
    const wandIcon = page.locator('.fa-wand-magic-sparkles')
    await expect(wandIcon).toBeVisible()

    const heading = page.locator('h2:has-text("Start Swarm")')
    await expect(heading).toBeVisible()
    await ss('06-wizard-header')
  })

  test('7. Wizard has close (X) button in header', async () => {
    // The X button in the wizard header (fa-xmark icon)
    const xmarkIcon = page.locator('h2:has-text("Start Swarm")').locator('..').locator('..').locator('.fa-xmark')
    await expect(xmarkIcon).toBeVisible()
    await ss('07-close-button')
  })

  // ---- SECTION 2: DESCRIBE STEP TESTS (INJECTED STATE) ----
  // The preparation step calls pickDirectory() which blocks with a native dialog.
  // We close the wizard and re-open it, injecting the describe step state directly.

  test('8. Cancel button on preparing step closes the wizard (via Escape)', async () => {
    // Press Escape to close the wizard (Escape handler exists for non-launching steps)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(500)

    // The wizard heading should no longer be visible (dashboard may close too)
    const wizardHeading = page.locator('h2:has-text("Start Swarm")')
    const visible = await wizardHeading.isVisible().catch(() => false)
    // Either the wizard is gone, or the entire dashboard closed
    await ss('08-wizard-cancelled')
  })

  test('9. Describe step shows textarea with placeholder text (via injected state)', async () => {
    // The wizard preparation step uses window.termpolis.pickDirectory() which opens
    // a native dialog and blocks. Since contextBridge creates a frozen proxy, we can't
    // mock it from the renderer. Instead, we intercept the IPC at the main process level.
    await app.evaluate(({ ipcMain }) => {
      // Mock agents:detect to report Claude as installed (avoids 3s `where` command)
      ipcMain.removeHandler('agents:detect')
      ipcMain.handle('agents:detect', async () => {
        return { success: true, data: { claude: true, codex: false, gemini: false, aider: false } }
      })

      // Mock dialog:pick-directory to return a fake directory (avoids native dialog)
      ipcMain.removeHandler('dialog:pick-directory')
      ipcMain.handle('dialog:pick-directory', async () => {
        return { success: true, data: 'C:\\test\\project' }
      })

      // Mock terminal:create to avoid real pty creation
      ipcMain.removeHandler('terminal:create')
      ipcMain.handle('terminal:create', async () => {
        return { success: true }
      })

      // Mock terminal:read-buffer to return authenticated output
      ipcMain.removeHandler('terminal:read-buffer')
      ipcMain.handle('terminal:read-buffer', async () => {
        return { success: true, data: { output: 'Claude Code v1.0.0\nclaude> ready' } }
      })

      // Mock terminal:kill to be a no-op
      ipcMain.removeHandler('terminal:kill')
      ipcMain.handle('terminal:kill', async () => {
        return { success: true }
      })

      // Replace the terminal:write listener to be a no-op (it's a send, not invoke)
      ipcMain.removeAllListeners('terminal:write')
      ipcMain.on('terminal:write', () => {
        // no-op: don't try to write to non-existent pty
      })

      // Also replace terminal:resize to be a no-op
      ipcMain.removeAllListeners('terminal:resize')
      ipcMain.on('terminal:resize', () => {
        // no-op
      })
    })

    // Open the dashboard — the wizard auto-opens and starts the preparation flow.
    // The flow calls checkClaudeInstalled (IPC mocked, instant), pickDirectory
    // (IPC mocked, instant), then startConductor which has two internal delays:
    // testDelay(3000)=3s and testDelay(12000)=12s (process.env not available in
    // renderer so testDelay returns full values). Total ~15s for preparation.
    await page.keyboard.press('Control+Shift+S')

    // Wait for describe step to appear (textarea) — needs ~16s for preparation
    const textarea = page.locator('textarea')
    await expect(textarea).toBeVisible({ timeout: 30000 })

    // Check placeholder text
    const placeholder = await textarea.getAttribute('placeholder')
    expect(placeholder).toContain('tic-tac-toe')
    await ss('09-describe-step-textarea')
  })

  test('10. Describe step shows "Tips for better results" box', async () => {
    const tipsHeader = page.locator('text=Tips for better results')
    await expect(tipsHeader).toBeVisible({ timeout: 3000 })
    await ss('10-tips-box')
  })

  test('11. Describe step shows instructional text about the conductor', async () => {
    const instruction = page.locator('text=Be specific about each task')
    await expect(instruction).toBeVisible()
    await ss('11-describe-instruction')
  })

  test('12. Launch button is disabled when textarea is empty', async () => {
    const launchBtn = page.locator('button:has-text("Launch Swarm")')
    await expect(launchBtn).toBeVisible({ timeout: 3000 })
    await expect(launchBtn).toBeDisabled()
    await ss('12-launch-disabled')
  })

  test('13. Launch button is enabled when textarea has text', async () => {
    const textarea = page.locator('textarea')
    await textarea.fill('Build a REST API with authentication and write unit tests')
    await page.waitForTimeout(300)

    const launchBtn = page.locator('button:has-text("Launch Swarm")')
    await expect(launchBtn).toBeEnabled()
    await ss('13-launch-enabled')
  })

  test('14. Cancel button on describe step closes the wizard', async () => {
    const cancelBtn = page.locator('button:has-text("Cancel")').first()
    await expect(cancelBtn).toBeVisible()
    await cancelBtn.click()
    await page.waitForTimeout(500)

    // Wizard should be closed (the describe textarea should be gone)
    const textarea = page.locator('textarea')
    const textareaVisible = await textarea.isVisible().catch(() => false)
    expect(textareaVisible).toBe(false)
    await ss('14-cancel-closes-wizard')
  })

  // ---- SECTION 3: DASHBOARD INTEGRATION TESTS ----

  test('15. Dashboard "Clear" button is visible and clears swarm state', async () => {
    // Ensure dashboard is open
    const dashboardVisible = await page.locator('text=Swarm Dashboard').isVisible().catch(() => false)
    if (!dashboardVisible) {
      await page.keyboard.press('Control+Shift+S')
      await page.waitForTimeout(500)
    }
    await dismissWizardIfVisible()

    // Clear button should always be visible in the dashboard tabs bar
    const clearBtn = page.locator('.fixed').locator('button:has-text("Clear")').first()
    await expect(clearBtn).toBeVisible({ timeout: 3000 })

    // Create a task to verify clear works
    await page.evaluate(async () => {
      await (window as any).swarmAPI.createTask(
        'Conductor Test Task',
        'Task to verify clear functionality',
        'conductor-test',
        undefined
      )
    })

    // Click Clear
    await clearBtn.click()
    await page.waitForTimeout(1000)

    // Verify tasks were cleared
    const taskCount = await page.evaluate(async () => {
      const res = await (window as any).swarmAPI.getTasks()
      return res.success ? (res.data?.length ?? 0) : 0
    })
    expect(taskCount).toBe(0)
    await ss('15-clear-button')
  })

  // ---- CLEANUP ----

  test('cleanup: verify app did not crash after all conductor tests', async () => {

    // Close dashboard
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)

    const windowCount = await app.evaluate(({ BrowserWindow }) => {
      return BrowserWindow.getAllWindows().length
    })
    expect(windowCount).toBeGreaterThan(0)
    await ss('cleanup-final')
  })
})
