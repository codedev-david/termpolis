/**
 * Termpolis Visual Regression E2E Test Suite
 * Uses Playwright's toHaveScreenshot() to capture and compare baseline screenshots.
 * First run creates baselines; subsequent runs compare against them and fail on visual drift.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { _electron as electron } from 'playwright'
import path from 'path'
import fs from 'fs'

let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  // Build the app
  const { execSync } = await import('child_process')
  execSync('npx electron-vite build', { cwd: path.resolve('.'), stdio: 'pipe' })

  // Clear session so we start fresh on the Welcome screen
  const os = await import('os')
  const sessionPaths = [
    path.join(os.homedir(), 'AppData', 'Roaming', 'termpolis', 'session.json'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'Electron', 'session.json'),
  ]
  const cleanSession = JSON.stringify({
    terminals: [], workspaces: [], defaultShell: 'powershell', viewMode: 'tabs'
  })
  for (const sessionPath of sessionPaths) {
    if (fs.existsSync(sessionPath)) {
      fs.writeFileSync(sessionPath, cleanSession)
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

/** Helper: create a terminal via the Add Terminal modal with a given name */
async function createTerminal(name: string) {
  const addBtn = page.locator('button:has-text("+ Add Terminal")').first()
  await addBtn.click()
  await page.waitForTimeout(500)

  const nameInput = page.locator('h2:has-text("New Terminal")').locator('..').locator('input').first()
  await nameInput.fill(name)

  const create = page.getByRole('button', { name: 'Create', exact: true })
  await create.click()
  await page.waitForTimeout(2000)
}

/** Helper: click the view mode toggle button */
async function toggleView() {
  const toggle = page.locator('button[title="Split View"], button[title="Tab View"]')
  await toggle.click()
  await page.waitForTimeout(500)
}

/** Helper: close a terminal by name */
async function closeTerminalByName(name: string) {
  const closeBtn = page.locator(`aside button[aria-label="Close ${name}"]`).first()
  const visible = await closeBtn.isVisible().catch(() => false)
  if (visible) {
    await closeBtn.click()
    await page.waitForTimeout(1000)
  }
}

const screenshotOpts = { maxDiffPixelRatio: 0.05 }

// ════════════════════════════════════════════════════════════
// VISUAL REGRESSION TESTS
// ════════════════════════════════════════════════════════════

test.describe.serial('Visual Regression', () => {

  test('1. welcome screen', async () => {
    const welcome = page.locator('text=Welcome to Termpolis')
    await expect(welcome).toBeVisible({ timeout: 5000 })
    await page.waitForTimeout(500)
    await expect(page).toHaveScreenshot('welcome-screen.png', screenshotOpts)
  })

  test('2. add terminal modal', async () => {
    const addBtn = page.locator('button:has-text("+ Add Terminal")').first()
    await addBtn.click()
    await page.waitForTimeout(500)

    const modal = page.locator('h2:has-text("New Terminal")').locator('..')
    await expect(modal).toBeVisible()
    await expect(page).toHaveScreenshot('add-terminal-modal.png', screenshotOpts)

    // Close modal by clicking Cancel
    const cancelBtn = page.getByRole('button', { name: 'Cancel' })
    await cancelBtn.click()
    await page.waitForTimeout(500)
  })

  test('3. dark theme terminal', async () => {
    await createTerminal('Visual-Test-1')

    // Wait for terminal to fully render
    await page.waitForTimeout(1000)

    const terminalArea = page.locator('.xterm').first()
    await expect(terminalArea).toBeVisible()
    await expect(page).toHaveScreenshot('dark-theme-terminal.png', screenshotOpts)
  })

  test('4. settings panel', async () => {
    const settingsBtn = page.locator('button[title="Settings"]')
    await settingsBtn.click()
    await page.waitForTimeout(500)

    await expect(page).toHaveScreenshot('settings-panel.png', screenshotOpts)

    // Close settings by clicking it again
    await settingsBtn.click()
    await page.waitForTimeout(300)
  })

  test('5. command palette', async () => {
    await page.keyboard.press('Control+k')
    await page.waitForTimeout(500)

    await expect(page).toHaveScreenshot('command-palette.png', screenshotOpts)

    // Close palette
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
  })

  test('6. split view with 2 terminals', async () => {
    await createTerminal('Visual-Test-2')

    // Switch to split view
    await toggleView()
    await page.waitForTimeout(1000)

    // Both terminals should be visible
    await expect(page.locator('text=Visual-Test-1').first()).toBeVisible()
    await expect(page.locator('text=Visual-Test-2').first()).toBeVisible()

    await expect(page).toHaveScreenshot('split-view-2-terminals.png', screenshotOpts)
  })

  test('7. split view with 4 terminals', async () => {
    // Switch back to tabs to create more terminals
    await toggleView()
    await createTerminal('Visual-Test-3')
    await createTerminal('Visual-Test-4')

    // Switch to split view for 2x2 grid
    await toggleView()
    await page.waitForTimeout(1000)

    for (const name of ['Visual-Test-1', 'Visual-Test-2', 'Visual-Test-3', 'Visual-Test-4']) {
      await expect(page.locator(`text=${name}`).first()).toBeVisible()
    }

    await expect(page).toHaveScreenshot('split-view-4-terminals.png', screenshotOpts)

    // Switch back to tabs for subsequent tests
    await toggleView()
    await page.waitForTimeout(300)
  })

  test('8. swarm wizard step 1 - agent selection', async () => {
    const swarmBtn = page.locator('button[title="Swarm Dashboard"]')
    await swarmBtn.click()
    await page.waitForTimeout(500)

    // The StartSwarmModal opens by default when swarm is not active
    // Step 1 is agent selection - verify it's visible
    await expect(page.locator('text=Start Swarm').first()).toBeVisible()
    await expect(page).toHaveScreenshot('swarm-wizard-step1.png', screenshotOpts)
  })

  test('9. swarm wizard step 2 - task description', async () => {
    // Select 2 agents by dispatching click events directly on the button elements
    // force:true bypasses actionability but React synthetic events need proper DOM dispatch
    await page.evaluate(() => {
      const buttons = document.querySelectorAll('button')
      const agents = ['Claude Code', 'OpenAI Codex']
      for (const btn of buttons) {
        if (agents.some(a => btn.textContent?.includes(a))) {
          btn.click()
        }
      }
    })
    await page.waitForTimeout(500)

    // Click Next to advance to describe step
    await page.evaluate(() => {
      const buttons = document.querySelectorAll('button')
      for (const btn of buttons) {
        if (btn.textContent?.trim() === 'Next' && !btn.disabled) {
          btn.click()
          return
        }
      }
    })
    await page.waitForTimeout(500)

    await expect(page).toHaveScreenshot('swarm-wizard-step2.png', screenshotOpts)

    // Close: first Escape closes the StartSwarmModal, second closes SwarmDashboard
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(500)
    // Ensure no overlay is blocking by checking and force-closing via evaluate
    await page.evaluate(() => {
      document.querySelectorAll('.fixed.inset-0').forEach(el => el.remove())
    })
    await page.waitForTimeout(300)
  })

  test('10. sidebar collapsed', async () => {
    const collapseBtn = page.locator('button[title="Collapse sidebar"]')
    await collapseBtn.click()
    await page.waitForTimeout(500)

    await expect(page).toHaveScreenshot('sidebar-collapsed.png', screenshotOpts)
  })

  test('11. sidebar expanded', async () => {
    const expandBtn = page.locator('button[title="Expand sidebar"]')
    await expandBtn.click()
    await page.waitForTimeout(500)

    await expect(page).toHaveScreenshot('sidebar-expanded.png', screenshotOpts)
  })

  test('12. context menu', async () => {
    // Right-click a terminal in the sidebar to open the context popover
    const terminalTab = page.locator('text=Visual-Test-1').first()
    await terminalTab.click({ button: 'right' })
    await page.waitForTimeout(500)

    await expect(page).toHaveScreenshot('context-menu.png', screenshotOpts)

    // Close by pressing Escape
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
  })

  // Cleanup: close all terminals to leave clean state
  test('cleanup: close all terminals', async () => {
    for (const name of ['Visual-Test-1', 'Visual-Test-2', 'Visual-Test-3', 'Visual-Test-4']) {
      await closeTerminalByName(name)
    }
    const welcome = page.locator('text=Welcome to Termpolis')
    await expect(welcome).toBeVisible({ timeout: 5000 })
  })

})
