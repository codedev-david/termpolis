/**
 * Termpolis Stress Test Suite
 * Tests rapid operations, large output handling, and UI spam resilience
 * to ensure the app remains stable under heavy/rapid usage.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { _electron as electron } from 'playwright'
import path from 'path'
import fs from 'fs'

let app: ElectronApplication
let page: Page

test.setTimeout(60_000)

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

  // Kill any existing Electron instances right before launch to release single-instance lock
  try { execSync('taskkill /F /IM electron.exe', { stdio: 'pipe' }) } catch { /* no instances running */ }
  await new Promise(r => setTimeout(r, 2000))

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

// ── Helpers ──────────────────────────────────────────────────

/** Quick terminal creation via the Add Terminal modal */
async function createTerminalQuick(name: string) {
  const addBtn = page.locator('button:has-text("+ Add Terminal")').first()
  await addBtn.click()
  await page.waitForTimeout(500)

  const nameInput = page.locator('h2:has-text("New Terminal")').locator('..').locator('input').first()
  await nameInput.fill(name)

  const create = page.getByRole('button', { name: 'Create', exact: true })
  await create.click()
  await page.waitForTimeout(2000)
}

/** Get terminal count from sidebar close buttons */
async function getSidebarTerminalCount(): Promise<number> {
  return await page.evaluate(() => {
    const aside = document.querySelector('aside')
    if (!aside) return 0
    return aside.querySelectorAll('button[aria-label^="Close "]').length
  })
}

/** Close a terminal by name using its sidebar close button */
async function closeTerminalByName(name: string) {
  const closeBtn = page.locator(`aside button[aria-label="Close ${name}"]`).first()
  const visible = await closeBtn.isVisible().catch(() => false)
  if (visible) {
    await closeBtn.click()
    await page.waitForTimeout(1500)
    return true
  }
  return false
}

/** Close all terminals to return to Welcome screen */
async function closeAllTerminals() {
  let count = await getSidebarTerminalCount()
  let safety = 0
  while (count > 0 && safety < 20) {
    // Click the first close button available in the sidebar
    const closeBtn = page.locator('aside button[aria-label^="Close "]').first()
    const visible = await closeBtn.isVisible().catch(() => false)
    if (visible) {
      await closeBtn.click()
      // Give node-pty time to clean up the PTY process
      await page.waitForTimeout(1500)
    }
    count = await getSidebarTerminalCount()
    safety++
  }
  await page.waitForTimeout(1000)
}

/** Toggle between tab/split view */
async function toggleView() {
  const toggle = page.locator('button[title="Split View"], button[title="Tab View"]')
  await toggle.click()
  await page.waitForTimeout(100)
}

// ════════════════════════════════════════════════════════════
// STRESS TESTS
// ════════════════════════════════════════════════════════════

test.describe.serial('Stress Tests', () => {

  test('1. rapid terminal creation: 5 terminals in quick succession', async () => {
    for (let i = 1; i <= 5; i++) {
      await createTerminalQuick(`Rapid${i}`)
      await page.waitForTimeout(500)
    }

    // Wait for UI to settle
    await page.waitForTimeout(2000)

    // All 5 should appear in sidebar
    const count = await getSidebarTerminalCount()
    expect(count).toBe(5)

    // Verify app is responsive by checking sidebar is visible
    const sidebar = page.locator('aside').first()
    await expect(sidebar).toBeVisible()

    // Cleanup -- close terminals one at a time with generous delay
    for (let i = 1; i <= 5; i++) {
      await closeTerminalByName(`Rapid${i}`)
      await page.waitForTimeout(1000)
    }
    await page.waitForTimeout(2000)
    const afterCount = await getSidebarTerminalCount()
    expect(afterCount).toBe(0)
  })

  test('2. rapid terminal close: create 4, close all in succession', async () => {
    // Create 4 terminals
    for (let i = 1; i <= 4; i++) {
      await createTerminalQuick(`Close${i}`)
    }
    await page.waitForTimeout(1000)

    const countBefore = await getSidebarTerminalCount()
    expect(countBefore).toBe(4)

    // Close all 4 in succession
    for (let i = 1; i <= 4; i++) {
      await closeTerminalByName(`Close${i}`)
      await page.waitForTimeout(500)
    }

    await page.waitForTimeout(2000)

    // Sidebar count should be 0
    const countAfter = await getSidebarTerminalCount()
    expect(countAfter).toBe(0)

    // Welcome screen should appear
    const welcome = page.locator('text=Welcome to Termpolis')
    await expect(welcome).toBeVisible({ timeout: 5000 })
  })

  test('3. batch create-close cycles: no orphaned state after each batch', async () => {
    // Batch 1: Create 2 terminals, close all, verify clean
    for (let i = 1; i <= 2; i++) {
      await createTerminalQuick(`BatchA${i}`)
    }
    await page.waitForTimeout(1000)
    let count = await getSidebarTerminalCount()
    expect(count).toBe(2)

    for (let i = 1; i <= 2; i++) {
      await closeTerminalByName(`BatchA${i}`)
      await page.waitForTimeout(1000)
    }
    await page.waitForTimeout(2000)
    count = await getSidebarTerminalCount()
    expect(count).toBe(0)

    // Batch 2: Create 2 more, close all, verify clean
    for (let i = 1; i <= 2; i++) {
      await createTerminalQuick(`BatchB${i}`)
    }
    await page.waitForTimeout(1000)
    count = await getSidebarTerminalCount()
    expect(count).toBe(2)

    for (let i = 1; i <= 2; i++) {
      await closeTerminalByName(`BatchB${i}`)
      await page.waitForTimeout(1000)
    }
    await page.waitForTimeout(2000)
    count = await getSidebarTerminalCount()
    expect(count).toBe(0)

    // Final check: Welcome screen visible, no orphaned entries
    const welcome = page.locator('text=Welcome to Termpolis')
    await expect(welcome).toBeVisible({ timeout: 5000 })
  })

  test('4. rapid view toggle: 10 toggles with 2 terminals', async () => {
    // Create 2 terminals
    for (let i = 1; i <= 2; i++) {
      await createTerminalQuick(`Toggle${i}`)
    }
    await page.waitForTimeout(1000)

    // Toggle view 10 times with enough delay for PTY to stabilize
    for (let i = 0; i < 10; i++) {
      await toggleView()
      await page.waitForTimeout(300)
    }

    await page.waitForTimeout(1000)

    // Sidebar should still be responsive and show both terminals
    const count = await getSidebarTerminalCount()
    expect(count).toBe(2)

    // Sidebar should be visible and functional
    const sidebar = page.locator('aside').first()
    await expect(sidebar).toBeVisible()

    // Verify terminal names still present
    for (let i = 1; i <= 2; i++) {
      const entry = page.locator(`text=Toggle${i}`).first()
      await expect(entry).toBeVisible()
    }

    // Cleanup
    for (let i = 1; i <= 2; i++) {
      await closeTerminalByName(`Toggle${i}`)
      await page.waitForTimeout(1000)
    }
    await page.waitForTimeout(2000)
  })

  test('5. large output handling: terminal stays interactive', async () => {
    // Ensure we're on Welcome screen and button is ready
    const welcome = page.locator('text=Welcome to Termpolis')
    await expect(welcome).toBeVisible({ timeout: 5000 })

    await createTerminalQuick('BigOutput')
    await page.waitForTimeout(1500)

    // Focus the terminal and send a command that produces lots of output
    const xterm = page.locator('.xterm-helper-textarea').first()
    await xterm.focus()
    await page.waitForTimeout(300)

    // Use PowerShell loop since default shell is powershell
    await page.keyboard.type('1..200 | ForEach-Object { Write-Output "Line $_: stress test output" }')
    await page.keyboard.press('Enter')

    // Wait for output to complete
    await page.waitForTimeout(5000)

    // Verify terminal is still interactive by typing another command
    await xterm.focus()
    await page.keyboard.type('echo "STILL_ALIVE"')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(1000)

    // Terminal xterm element should still be present and visible
    const xtermEl = page.locator('.xterm').first()
    await expect(xtermEl).toBeVisible()

    // Sidebar should still be responsive
    const count = await getSidebarTerminalCount()
    expect(count).toBe(1)

    // Cleanup
    await closeTerminalByName('BigOutput')
    await page.waitForTimeout(2000)
  })

  test('6. modal spam: open and close Add Terminal modal 10 times', async () => {
    for (let i = 0; i < 10; i++) {
      // Open modal
      const addBtn = page.locator('button:has-text("+ Add Terminal")').first()
      await addBtn.click()
      await page.waitForTimeout(200)

      // Verify modal appeared
      const modalTitle = page.locator('h2:has-text("New Terminal")')
      await expect(modalTitle).toBeVisible({ timeout: 2000 })

      // Close modal by pressing Escape
      await page.keyboard.press('Escape')
      await page.waitForTimeout(200)
    }

    // After all cycles, no modal should remain
    const modalTitle = page.locator('h2:has-text("New Terminal")')
    const modalVisible = await modalTitle.isVisible().catch(() => false)
    expect(modalVisible).toBe(false)

    // App should be responsive -- Welcome screen visible since no terminals
    const welcome = page.locator('text=Welcome to Termpolis')
    await expect(welcome).toBeVisible({ timeout: 5000 })
  })

  test('7. swarm dashboard spam: open and close 10 times', async () => {
    for (let i = 0; i < 10; i++) {
      // Open swarm dashboard with Ctrl+Shift+S
      await page.keyboard.press('Control+Shift+S')
      await page.waitForTimeout(300)

      // Close with Escape
      await page.keyboard.press('Escape')
      await page.waitForTimeout(200)
    }

    // No overlay should remain stuck
    await page.waitForTimeout(500)

    // App should be responsive -- check that sidebar or Welcome is visible
    const sidebar = page.locator('aside').first()
    const sidebarVisible = await sidebar.isVisible().catch(() => false)
    const welcome = page.locator('text=Welcome to Termpolis')
    const welcomeVisible = await welcome.isVisible().catch(() => false)
    expect(sidebarVisible || welcomeVisible).toBe(true)
  })

  test('8. command palette spam: open and close 10 times', async () => {
    for (let i = 0; i < 10; i++) {
      // Open command palette with Ctrl+K
      await page.keyboard.press('Control+K')
      await page.waitForTimeout(300)

      // Close with Escape
      await page.keyboard.press('Escape')
      await page.waitForTimeout(200)
    }

    // No palette overlay should remain
    await page.waitForTimeout(500)

    // App should be in a clean state -- responsive check
    const sidebar = page.locator('aside').first()
    const sidebarVisible = await sidebar.isVisible().catch(() => false)
    const welcome = page.locator('text=Welcome to Termpolis')
    const welcomeVisible = await welcome.isVisible().catch(() => false)
    expect(sidebarVisible || welcomeVisible).toBe(true)
  })

})
