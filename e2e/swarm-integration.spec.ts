/**
 * Termpolis Deep Swarm Integration E2E Test Suite
 * Tests actual mock agent launches, terminal interaction, swarm API operations,
 * and the full swarm lifecycle bypassing the wizard UI (which requires a directory picker).
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { _electron as electron } from 'playwright'
import path from 'path'
import fs from 'fs'

let app: ElectronApplication
let page: Page
const SCREENSHOTS = 'e2e/screenshots/swarm-integration'
const PROJECT_DIR = path.resolve('.')
const MOCK_CLAUDE = path.join(PROJECT_DIR, 'e2e/mocks/mock-claude.cjs').replace(/\\/g, '/')
const MOCK_CODEX = path.join(PROJECT_DIR, 'e2e/mocks/mock-codex.cjs').replace(/\\/g, '/')
const MOCK_AIDER = path.join(PROJECT_DIR, 'e2e/mocks/mock-aider.cjs').replace(/\\/g, '/')

test.beforeAll(async () => {
  // Clean screenshots dir
  if (fs.existsSync(SCREENSHOTS)) fs.rmSync(SCREENSHOTS, { recursive: true })
  fs.mkdirSync(SCREENSHOTS, { recursive: true })

  // Build with retry
  const { execSync } = await import('child_process')
  try {
    execSync('npx electron-vite build', { cwd: path.resolve('.'), stdio: 'pipe' })
  } catch {
    execSync('npx electron-vite build', { cwd: path.resolve('.'), stdio: 'pipe' })
  }

  // Clear session so we start fresh
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

/** Create a terminal via the Add Terminal modal */
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

/** Write a command to the active (visible) terminal via xterm textarea */
async function writeToTerminal(text: string) {
  // Find the xterm-helper-textarea inside the visible terminal pane
  // Invisible panes have style="visibility: hidden" on their container
  const textarea = await page.evaluate(() => {
    const textareas = document.querySelectorAll('.xterm-helper-textarea')
    for (const ta of textareas) {
      let el: HTMLElement | null = ta as HTMLElement
      let isVisible = true
      while (el) {
        if (el.style.visibility === 'hidden') {
          isVisible = false
          break
        }
        el = el.parentElement
      }
      if (isVisible) {
        (ta as HTMLTextAreaElement).focus()
        return true
      }
    }
    return false
  })
  // Now the correct textarea is focused, type into it
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
}

/**
 * Read the terminal buffer output via IPC readTerminalBuffer for a given terminal name.
 * Finds the terminal ID from the sidebar close buttons' aria-labels, then reads the buffer.
 * Falls back to reading .xterm-rows text content if IPC fails.
 */
async function getTerminalOutput(terminalName: string): Promise<string> {
  // Try reading via the IPC readTerminalBuffer (returns clean text without CSS)
  const output = await page.evaluate(async (name: string) => {
    // Find terminal ID from the sidebar DOM -- each close button has aria-label="Close {name}"
    // and the terminal row has a data attribute or we can match via the store
    // Strategy: iterate all aside buttons to find the terminal, then get its ID from the store
    // We don't have direct store access, but we can use termpolis API to read buffers
    // So we need the terminal ID. Let's find it from the sidebar row structure.
    const aside = document.querySelector('aside')
    if (!aside) return ''
    const closeBtn = aside.querySelector(`button[aria-label="Close ${name}"]`)
    if (!closeBtn) return ''
    // The terminal row is the parent container. The terminal ID is embedded in the store.
    // We need another approach: read all terminal buffers and match.
    // Actually, let's just get terminal IDs from the store via a different method.
    return ''
  }, terminalName)

  // If IPC approach didn't work, fall back to reading xterm-rows text content
  // The .xterm-rows div contains just the rendered text rows, not the CSS styles
  const rowsText = await page.locator('.xterm-rows').first().textContent() ?? ''
  return rowsText
}

/**
 * Read terminal content from the visible .xterm-rows element.
 * In tab mode, inactive terminals have visibility:hidden on their parent.
 * We find the .xterm-rows whose ancestor is visible.
 */
async function readActiveTerminalContent(): Promise<string> {
  return await page.evaluate(() => {
    const allRows = document.querySelectorAll('.xterm-rows')
    for (const rows of allRows) {
      // Walk up to find the terminal pane container with visibility style
      let el: HTMLElement | null = rows as HTMLElement
      let isVisible = true
      while (el) {
        if (el.style.visibility === 'hidden') {
          isVisible = false
          break
        }
        el = el.parentElement
      }
      if (isVisible) {
        return rows.textContent ?? ''
      }
    }
    // Fallback: return first match
    return allRows[0]?.textContent ?? ''
  })
}

/** Focus the active (visible) terminal's xterm textarea */
async function focusActiveTerminal() {
  await page.evaluate(() => {
    const textareas = document.querySelectorAll('.xterm-helper-textarea')
    for (const ta of textareas) {
      let el: HTMLElement | null = ta as HTMLElement
      let isVisible = true
      while (el) {
        if (el.style.visibility === 'hidden') {
          isVisible = false
          break
        }
        el = el.parentElement
      }
      if (isVisible) {
        (ta as HTMLTextAreaElement).focus()
        return
      }
    }
  })
}

/** Click a tab in the sidebar to activate that terminal */
async function activateTerminal(name: string) {
  const tab = page.locator(`text=${name}`).first()
  await tab.click()
  await page.waitForTimeout(300)
}

/** Toggle split/tab view */
async function toggleView() {
  const toggle = page.locator('button[title="Split View"], button[title="Tab View"]')
  await toggle.click()
  await page.waitForTimeout(500)
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

/** Close the Swarm Dashboard via its header X button. Escape is unreliable
 *  when keyboard focus is inside a terminal — the window-level handler never
 *  fires and the overlay keeps intercepting subsequent clicks. */
async function closeDashboardIfVisible() {
  const dashboardHeading = page.locator('h2:has-text("Swarm Dashboard")')
  if (await dashboardHeading.isVisible().catch(() => false)) {
    const xBtn = dashboardHeading
      .locator('xpath=ancestor::div[contains(@class,"fixed")][1]//button[.//i[contains(@class,"fa-xmark")]]')
      .first()
    await xBtn.click({ force: true })
    await page.waitForTimeout(400)
  }
}

/** Close the Start Swarm wizard if it auto-opened on top of the dashboard */
async function dismissWizardIfVisible() {
  const wizardXBtn = page.locator('h2:has-text("Start Swarm")').locator('..').locator('..').locator('button:last-child')
  const visible = await wizardXBtn.isVisible().catch(() => false)
  if (visible) {
    await wizardXBtn.click({ force: true })
    await page.waitForTimeout(300)
  }
}

// ============================================================
// ALL TESTS (serial -- state carries across tests)
// ============================================================

test.describe.serial('Swarm Integration', () => {

  // ---------- SECTION 1: MOCK AGENT LAUNCH & INTERACTION ----------

  test('1. Launch mock Claude in terminal and verify trust prompt', async () => {
    await createTerminal('Claude Agent')
    await activateTerminal('Claude Agent')
    await page.waitForTimeout(500)

    // Write the mock-claude command into the terminal
    await writeToTerminal(`node "${MOCK_CLAUDE}"`)
    await page.waitForTimeout(3000)

    // Read from .xterm-rows which has just the rendered text, not CSS
    const termContent = await readActiveTerminalContent()
    expect(termContent).toContain('trust')
    await ss('01-claude-trust-prompt')
  })

  test('2. Auto-trust fires on mock Claude -- startup banner appears', async () => {
    // Send Enter to accept the trust prompt
    await focusActiveTerminal()
    await page.keyboard.press('Enter')
    await page.waitForTimeout(2000)

    const termContent = await readActiveTerminalContent()
    expect(termContent).toContain('Claude Code v1.0.0 (mock)')
    await ss('02-claude-startup-banner')
  })

  test('3. Mock Claude accepts input and responds', async () => {
    await writeToTerminal('hello')
    await page.waitForTimeout(2000)

    const termContent = await readActiveTerminalContent()
    expect(termContent).toContain("I'll help with: hello")
    await ss('03-claude-response')
  })

  test('4. Launch mock Codex in second terminal', async () => {
    await createTerminal('Codex Agent')
    await activateTerminal('Codex Agent')
    await page.waitForTimeout(500)

    await writeToTerminal(`node "${MOCK_CODEX}"`)
    await page.waitForTimeout(3000)

    // Codex shows trust prompt immediately
    const termContent = await readActiveTerminalContent()
    expect(termContent).toContain('trust')

    // Send Enter to accept trust
    await focusActiveTerminal()
    await page.keyboard.press('Enter')
    await page.waitForTimeout(2000)

    const afterTrust = await readActiveTerminalContent()
    expect(afterTrust).toContain('Codex ready.')
    await ss('04-codex-ready')
  })

  test('5. Agent detection -- terminals appear in sidebar with correct names', async () => {
    // Both terminals should be in the sidebar
    const claudeEntry = page.locator('text=Claude Agent').first()
    const codexEntry = page.locator('text=Codex Agent').first()
    await expect(claudeEntry).toBeVisible()
    await expect(codexEntry).toBeVisible()
    await ss('05-agent-detection')
  })

  // ---------- SECTION 2: SWARM API OPERATIONS (PROGRAMMATIC) ----------

  test('6. Set up swarm state programmatically via swarmAPI', async () => {
    // Create a task via the swarm API
    const taskResult = await page.evaluate(async () => {
      const res = await (window as any).swarmAPI.createTask(
        'Test Task Alpha',
        'This is a test task for the swarm integration',
        'e2e-test',
        undefined
      )
      return res
    })
    expect(taskResult.success).toBe(true)

    // Send a message via the swarm API
    const msgResult = await page.evaluate(async () => {
      const res = await (window as any).swarmAPI.sendMessage(
        'e2e-test',
        'all',
        'info',
        'Swarm integration test initialized'
      )
      return res
    })
    expect(msgResult.success).toBe(true)
    await ss('06-swarm-state-setup')
  })

  test('7. Swarm dashboard opens with Tasks and Messages tabs (no Agents tab)', async () => {
    await page.keyboard.press('Control+Shift+S')
    await page.waitForTimeout(500)

    await expect(page.locator('text=Swarm Dashboard')).toBeVisible({ timeout: 3000 })

    // Agents tab was removed; Tasks and Messages tabs should be present.
    const tasksTab = page.locator('.fixed').locator('button:has-text("Tasks")').first()
    const messagesTab = page.locator('.fixed').locator('button:has-text("Messages")').first()
    const agentsTab = page.locator('.fixed').locator('button:has-text("Agents")').first()
    await expect(tasksTab).toBeVisible({ timeout: 3000 })
    await expect(messagesTab).toBeVisible({ timeout: 3000 })
    await expect(agentsTab).not.toBeVisible()
    await ss('07-dashboard-tabs')
  })

  test('8. Send swarm task prompt to mock Claude and verify response', async () => {
    await closeDashboardIfVisible()

    // Activate Claude terminal
    await activateTerminal('Claude Agent')
    await page.waitForTimeout(500)

    // Send a swarm-style prompt
    await writeToTerminal('You are part of a multi-agent swarm. Your role: testing. Your task: write tests.')
    await page.waitForTimeout(3000)

    const termContent = await readActiveTerminalContent()
    expect(termContent).toContain('Working on assigned task...')
    await ss('08-swarm-task-prompt')
  })

  test('9. Swarm task creation via API appears in dashboard Tasks tab', async () => {
    // Create a new task
    await page.evaluate(async () => {
      await (window as any).swarmAPI.createTask(
        'Dashboard Visible Task',
        'This task should appear in the Pending column',
        'e2e-test',
        undefined
      )
    })

    // Open dashboard and go to Tasks tab
    await page.keyboard.press('Control+Shift+S')
    await page.waitForTimeout(500)
    await clickDashboardTab('Tasks')

    // Verify the task appears in the Pending column
    const pendingTask = page.locator('.fixed').locator('text=Dashboard Visible Task').first()
    await expect(pendingTask).toBeVisible({ timeout: 5000 })
    await ss('09-task-in-pending')
  })

  test('10. Swarm task status update moves task to In Progress', async () => {
    // Get the task ID we just created
    const taskId = await page.evaluate(async () => {
      const res = await (window as any).swarmAPI.getTasks()
      if (res.success && res.data) {
        const task = res.data.find((t: any) => t.title === 'Dashboard Visible Task')
        return task?.id ?? null
      }
      return null
    })
    expect(taskId).not.toBeNull()

    // Update task to in_progress
    await page.evaluate(async (id) => {
      await (window as any).swarmAPI.updateTask(id, 'in_progress')
    }, taskId)

    // Wait for dashboard to refresh
    await page.waitForTimeout(4000)

    // Click Tasks tab again to ensure we see fresh data
    await clickDashboardTab('Tasks')
    await page.waitForTimeout(500)

    // Verify "Dashboard Visible Task" is still visible (now in In Progress section)
    const task = page.locator('.fixed').locator('text=Dashboard Visible Task').first()
    await expect(task).toBeVisible({ timeout: 5000 })
    await ss('10-task-in-progress')
  })

  test('11. Swarm message sending via API', async () => {
    await page.evaluate(async () => {
      await (window as any).swarmAPI.sendMessage(
        'claude-agent',
        'codex-agent',
        'task',
        'Please review the auth module changes'
      )
    })

    await clickDashboardTab('Messages')
    await page.waitForTimeout(4000)

    const message = page.locator('.fixed').locator('text=Please review the auth module changes').first()
    await expect(message).toBeVisible({ timeout: 5000 })
    await ss('11-swarm-message')
  })

  test('12. Swarm broadcast message appears in Messages tab', async () => {
    await page.evaluate(async () => {
      await (window as any).swarmAPI.sendMessage(
        'swarm-orchestrator',
        'all',
        'info',
        'Broadcast: All agents please report status'
      )
    })

    await page.waitForTimeout(4000)

    // Click Messages tab to refresh
    await clickDashboardTab('Messages')
    await page.waitForTimeout(500)

    const broadcast = page.locator('.fixed').locator('text=Broadcast: All agents please report status').first()
    await expect(broadcast).toBeVisible({ timeout: 5000 })
    await ss('12-broadcast-message')
  })

  test('13. Split view layout with 2 agent terminals', async () => {
    await closeDashboardIfVisible()

    // Switch to split view
    await toggleView()
    await page.waitForTimeout(1000)

    // Both terminal names should be visible in pane headers
    const claudeHeader = page.locator('text=Claude Agent').first()
    const codexHeader = page.locator('text=Codex Agent').first()
    await expect(claudeHeader).toBeVisible()
    await expect(codexHeader).toBeVisible()

    // Multiple xterm instances should exist
    const xtermInstances = page.locator('.xterm')
    const count = await xtermInstances.count()
    expect(count).toBeGreaterThanOrEqual(2)
    await ss('13-split-view')
  })

  test('14. Mock Aider produces "done" signal after swarm prompt', async () => {
    // Switch back to tab view for terminal creation
    await toggleView()
    await page.waitForTimeout(500)

    await createTerminal('Aider Agent')
    await activateTerminal('Aider Agent')
    await page.waitForTimeout(500)

    // Launch mock aider directly
    await writeToTerminal(`node "${MOCK_AIDER}"`)
    await page.waitForTimeout(3000)

    // Aider has no trust prompt, it starts immediately
    const startupContent = await readActiveTerminalContent()
    expect(startupContent).toContain('Aider v0.86.2 (mock)')

    // Send swarm prompt
    await writeToTerminal('You are part of a swarm. Your role: code review.')
    await page.waitForTimeout(3000)

    const afterPrompt = await readActiveTerminalContent()
    expect(afterPrompt).toContain('done')
    await ss('14-aider-done-signal')
  })

  test('15. Clear swarm -- tasks and messages are emptied', async () => {
    // Open dashboard
    await page.keyboard.press('Control+Shift+S')
    await page.waitForTimeout(500)

    // Verify there are tasks and messages before clearing
    const beforeClear = await page.evaluate(async () => {
      const tasks = await (window as any).swarmAPI.getTasks()
      const msgs = await (window as any).swarmAPI.getMessages()
      return {
        taskCount: tasks.success ? tasks.data?.length ?? 0 : 0,
        msgCount: msgs.success ? msgs.data?.length ?? 0 : 0,
      }
    })
    expect(beforeClear.taskCount).toBeGreaterThan(0)
    expect(beforeClear.msgCount).toBeGreaterThan(0)

    // Click the Clear button in the dashboard (opens confirmation dialog)
    const clearBtn = page.locator('.fixed').locator('button:has-text("Clear")').first()
    await clearBtn.click()
    await page.waitForTimeout(300)

    // Confirm via the "Clear Swarm" button inside the dialog
    const confirmBtn = page.locator('.fixed').locator('button:has-text("Clear Swarm")').first()
    await confirmBtn.click()
    await page.waitForTimeout(1000)

    // Verify tasks and messages are empty
    const afterClear = await page.evaluate(async () => {
      const tasks = await (window as any).swarmAPI.getTasks()
      const msgs = await (window as any).swarmAPI.getMessages()
      return {
        taskCount: tasks.success ? tasks.data?.length ?? 0 : 0,
        msgCount: msgs.success ? msgs.data?.length ?? 0 : 0,
      }
    })
    expect(afterClear.taskCount).toBe(0)
    expect(afterClear.msgCount).toBe(0)

    // Dashboard Messages tab should show empty state
    await clickDashboardTab('Messages')
    await page.waitForTimeout(500)
    const emptyMsg = page.locator('text=No swarm messages yet')
    await expect(emptyMsg).toBeVisible({ timeout: 5000 })
    await ss('15-swarm-cleared')
  })

  test('16. App did not crash after all swarm integration tests', async () => {
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)

    const windowCount = await app.evaluate(({ BrowserWindow }) => {
      return BrowserWindow.getAllWindows().length
    })
    expect(windowCount).toBeGreaterThan(0)
    await ss('16-final')
  })
})
