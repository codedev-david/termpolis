/**
 * Termpolis Error Resilience E2E Test Suite
 * Tests error handling, resilience to rapid actions, orphaned state cleanup,
 * and MCP health status visibility.
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

/** Helper: close a terminal by name using sidebar close button */
async function closeTerminalByName(name: string) {
  const closeBtn = page.locator(`aside button[aria-label="Close ${name}"]`).first()
  const visible = await closeBtn.isVisible().catch(() => false)
  if (visible) {
    await closeBtn.click()
    await page.waitForTimeout(1000)
    return true
  }
  return false
}

/** Helper: get terminal count from sidebar by counting close buttons */
async function getSidebarTerminalCount(): Promise<number> {
  return await page.evaluate(() => {
    const aside = document.querySelector('aside')
    if (!aside) return 0
    return aside.querySelectorAll('button[aria-label^="Close "]').length
  })
}

/** Helper: click the view mode toggle button */
async function toggleView() {
  const toggle = page.locator('button[title="Split View"], button[title="Tab View"]')
  await toggle.click()
  await page.waitForTimeout(500)
}

// ════════════════════════════════════════════════════════════
// ALL TESTS
// ════════════════════════════════════════════════════════════

test.describe.serial('Error Resilience', () => {

  test('1. app launches without crashing (smoke test)', async () => {
    // The app should be running and showing either the Welcome screen or main UI
    const window = await app.firstWindow()
    expect(window).toBeTruthy()

    // The page should have loaded content — check for the app root or a known element
    const body = page.locator('body')
    await expect(body).toBeVisible()

    // Check there are no crash dialogs or blank screens — body should have child elements
    const childCount = await page.evaluate(() => document.body.children.length)
    expect(childCount).toBeGreaterThan(0)

    // Verify the Welcome screen or sidebar is present (app rendered successfully)
    const hasWelcome = await page.locator('text=Welcome to Termpolis').isVisible().catch(() => false)
    const hasSidebar = await page.locator('aside').isVisible().catch(() => false)
    expect(hasWelcome || hasSidebar).toBe(true)
  })

  test('2. close all terminals: returns to Welcome screen without errors', async () => {
    // Create two terminals first
    await createTerminal('Resilience-A')
    await createTerminal('Resilience-B')

    // Verify they exist in sidebar
    const countBefore = await getSidebarTerminalCount()
    expect(countBefore).toBe(2)

    // Close both terminals
    await closeTerminalByName('Resilience-B')
    await closeTerminalByName('Resilience-A')

    // Sidebar should have zero terminals
    const countAfter = await getSidebarTerminalCount()
    expect(countAfter).toBe(0)

    // Welcome screen should reappear
    const welcome = page.locator('text=Welcome to Termpolis')
    await expect(welcome).toBeVisible({ timeout: 5000 })
  })

  test('3. rapid view toggle: switch 5 times quickly without freezing', async () => {
    // Create a terminal so the view toggle is meaningful
    await createTerminal('RapidTest')

    // Rapidly toggle between tab and split view 5 times
    for (let i = 0; i < 5; i++) {
      const toggle = page.locator('button[title="Split View"], button[title="Tab View"]')
      await toggle.click()
      // Minimal delay to simulate rapid clicking
      await page.waitForTimeout(200)
    }

    // Wait a moment for any async rendering to settle
    await page.waitForTimeout(1000)

    // App should not be frozen — verify the sidebar is still interactive
    const sidebarEntry = page.locator('text=RapidTest').first()
    await expect(sidebarEntry).toBeVisible({ timeout: 5000 })

    // Clicking the sidebar entry should still work (app is responsive)
    await sidebarEntry.click()
    await page.waitForTimeout(500)

    // The terminal should be highlighted as active
    const activeRow = page.locator('.bg-\\[\\#37373d\\]').filter({ hasText: 'RapidTest' })
    await expect(activeRow).toBeVisible()

    // Clean up — ensure we are back in tab view for subsequent tests
    const toggleTitle = await page.locator('button[title="Split View"], button[title="Tab View"]').getAttribute('title') ?? ''
    if (toggleTitle === 'Tab View') {
      await toggleView()
    }

    // Close the terminal
    await closeTerminalByName('RapidTest')
  })

  test('4. create and immediately close terminal: no orphaned state in sidebar', async () => {
    // Start from Welcome screen — verify sidebar is empty
    const countBefore = await getSidebarTerminalCount()
    expect(countBefore).toBe(0)

    // Create a terminal
    await createTerminal('Ephemeral')

    // Verify it appeared
    const countDuring = await getSidebarTerminalCount()
    expect(countDuring).toBe(1)

    // Immediately close it
    await closeTerminalByName('Ephemeral')

    // Sidebar should be back to zero — no orphaned entries
    const countAfter = await getSidebarTerminalCount()
    expect(countAfter).toBe(0)

    // No stale references — the terminal name should not appear anywhere in the sidebar
    const orphaned = await page.locator('aside').locator('text=Ephemeral').count()
    expect(orphaned).toBe(0)

    // Welcome screen should be back
    const welcome = page.locator('text=Welcome to Termpolis')
    await expect(welcome).toBeVisible({ timeout: 5000 })
  })

  test('5. MCP health check: status bar shows MCP server status', async () => {
    // The status bar should display MCP connection info referencing localhost:9315
    // Look for the status bar area (typically at the bottom of the app)
    const statusBar = page.locator('[class*="status"], footer, [class*="StatusBar"], [class*="statusbar"]').first()
    const statusBarVisible = await statusBar.isVisible().catch(() => false)

    if (statusBarVisible) {
      // Check for MCP-related text in the status bar
      const statusText = await statusBar.textContent() ?? ''
      const hasMcpInfo = statusText.includes('MCP') || statusText.includes('9315') || statusText.includes('localhost')
      expect(hasMcpInfo).toBe(true)
    } else {
      // If no explicit status bar, look for MCP indicator anywhere on screen
      const mcpIndicator = page.locator('text=/MCP|9315|localhost:9315/').first()
      const mcpVisible = await mcpIndicator.isVisible({ timeout: 3000 }).catch(() => false)

      // Also check if the info is available via the page content
      const pageText = await page.evaluate(() => document.body.innerText)
      const hasMcpReference = pageText.includes('MCP') || pageText.includes('9315')

      expect(mcpVisible || hasMcpReference).toBe(true)
    }
  })

})
