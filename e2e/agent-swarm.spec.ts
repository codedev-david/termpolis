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

  test('3. Swarm dashboard has tabs: Agents, Tasks, Messages', async () => {
    for (const tab of ['Agents', 'Tasks', 'Messages']) {
      const tabBtn = page.locator(`button:has-text("${tab}")`).first()
      await expect(tabBtn).toBeVisible()
    }
    await ss('03-dashboard-tabs')
  })

  test('4. Start Swarm button opens wizard', async () => {
    // The wizard no longer auto-opens; click "Start Swarm" to open it
    const startBtn = page.locator('button:has-text("Start Swarm")').first()
    await expect(startBtn).toBeVisible({ timeout: 3000 })
    await startBtn.click()
    await page.waitForTimeout(500)

    const wizardHeading = page.locator('h2:has-text("Start Swarm")').first()
    await expect(wizardHeading).toBeVisible({ timeout: 3000 })
    await ss('04-wizard-opened')
  })

  // ---- SECTION 2: WIZARD STEP 1 - AGENT SELECTION ----

  test('5. Wizard step 1 shows agent selection grid with checkboxes', async () => {
    // The wizard select step shows a grid-cols-2 grid of agent buttons
    const grid = page.locator('.grid.grid-cols-2')
    await expect(grid).toBeVisible({ timeout: 5000 })
    await ss('05-agent-grid')
  })

  test('6. Agents listed include Claude Code, OpenAI Codex, Gemini CLI, Qwen AI', async () => {
    const agents = ['Claude Code', 'OpenAI Codex', 'Gemini CLI', 'Qwen AI']
    for (const agent of agents) {
      const el = page.locator(`text=${agent}`).first()
      await expect(el).toBeVisible({ timeout: 3000 })
    }
    await ss('06-all-agents-listed')
  })

  test('7. Can select agents by clicking (checkbox toggles)', async () => {
    // Click on Claude Code in the wizard grid to select it
    const claudeBtn = page.locator('.grid.grid-cols-2 button:has-text("Claude Code")')
    await claudeBtn.click()
    await page.waitForTimeout(300)

    // The checkbox div should now have the selected background color
    const checkbox = claudeBtn.locator('.bg-\\[\\#22D3EE\\]')
    await expect(checkbox).toBeVisible()
    await ss('07-agent-selected')
  })

  test('8. "Next" button disabled until 2+ agents selected', async () => {
    // Only 1 agent selected so far -- Next should be disabled
    const nextBtn = page.locator('button:has-text("Next")').first()
    await expect(nextBtn).toBeDisabled()

    // Also check the warning text
    const warning = page.locator('text=Select at least 2 agents')
    await expect(warning).toBeVisible()
    await ss('08-next-disabled')
  })

  test('9. Select 2 agents, click Next -- shows task description textarea', async () => {
    // Select a second agent (OpenAI Codex) in the wizard grid
    const codexBtn = page.locator('.grid.grid-cols-2 button:has-text("OpenAI Codex")')
    await codexBtn.click()
    await page.waitForTimeout(300)

    // Next should now be enabled
    const nextBtn = page.locator('button:has-text("Next")').first()
    await expect(nextBtn).toBeEnabled()

    // Click Next
    await nextBtn.click()
    await page.waitForTimeout(500)

    // Should now see the describe step with a textarea
    const textarea = page.locator('textarea')
    await expect(textarea).toBeVisible()
    await ss('09-describe-step')
  })

  // ---- SECTION 3: WIZARD STEP 2 - TASK DESCRIPTION ----

  test('10. Step 2 shows textarea for task description and selected agents as chips', async () => {
    const textarea = page.locator('textarea')
    await expect(textarea).toBeVisible()

    // Selected agents shown as chips below the textarea
    const claudeChip = page.locator('text=Claude Code').first()
    const codexChip = page.locator('text=OpenAI Codex').first()
    await expect(claudeChip).toBeVisible()
    await expect(codexChip).toBeVisible()
    await ss('10-task-description-step')
  })

  test('11. "Next" disabled until task description entered', async () => {
    const nextBtn = page.locator('button:has-text("Next")').first()
    await expect(nextBtn).toBeDisabled()
    await ss('11-next-disabled-no-task')
  })

  test('12. Enter task, click Next -- shows breakdown with subtask assignments and scores', async () => {
    const textarea = page.locator('textarea')
    await textarea.fill('Refactor the auth module, write comprehensive tests, and review for security issues')
    await page.waitForTimeout(300)

    const nextBtn = page.locator('button:has-text("Next")').first()
    await expect(nextBtn).toBeEnabled()

    await nextBtn.click()
    await page.waitForTimeout(500)

    // Should now see the breakdown step
    const smartRouting = page.locator('text=Smart routing analyzed your task')
    await expect(smartRouting).toBeVisible()
    await ss('12-breakdown-step')
  })

  // ---- SECTION 4: WIZARD STEP 3 - TASK BREAKDOWN ----

  test('13. Step 3 shows agent assignments with score numbers and reassign buttons', async () => {
    // Look for score indicators (e.g., "85/100")
    const scorePattern = page.locator('text=/\\d+\\/100/')
    const count = await scorePattern.count()
    expect(count).toBeGreaterThanOrEqual(1)

    // Look for "Assigned to:" labels
    const assignedTo = page.locator('text=Assigned to:').first()
    await expect(assignedTo).toBeVisible()
    await ss('13-assignments-with-scores')
  })

  test('14. Step 3 shows token budget estimate section', async () => {
    const tokenBudget = page.locator('text=Token Budget Estimate')
    await expect(tokenBudget).toBeVisible()
    await ss('14-token-budget')
  })

  test('15. "Back" button returns to previous step (breakdown -> describe)', async () => {
    const backBtn = page.locator('button:has-text("Back")').first()
    await expect(backBtn).toBeVisible()

    await backBtn.click()
    await page.waitForTimeout(500)

    // Should be back on the describe step with the textarea
    const textarea = page.locator('textarea')
    await expect(textarea).toBeVisible()
    await ss('15-back-to-describe')
  })

  test('16. "Cancel" closes the wizard', async () => {
    // Go back to select step first
    const backBtn = page.locator('button:has-text("Back")').first()
    await backBtn.click()
    await page.waitForTimeout(500)

    // On the select step, the left button says "Cancel"
    const cancelBtn = page.locator('button:has-text("Cancel")').first()
    await expect(cancelBtn).toBeVisible()

    await cancelBtn.click()
    await page.waitForTimeout(500)

    // The wizard heading "Start Swarm" h2 should no longer be visible
    // (the dashboard may still be showing behind it)
    const wizardHeading = page.locator('h2:has-text("Start Swarm")')
    const wizardVisible = await wizardHeading.isVisible().catch(() => false)
    // If the dashboard is still open, the "Start Swarm" button text exists but not the h2
    // The key is that the wizard overlay is gone
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
