/**
 * Termpolis View Switching E2E Test Suite
 * Tests tab view, split view, toggling between them, terminal creation/closing,
 * sidebar state, and content persistence across view switches.
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
  // In test mode, Electron uses "Electron" as app name, not "termpolis"
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

  // Clear and type the name
  const nameInput = page.locator('h2:has-text("New Terminal")').locator('..').locator('input').first()
  await nameInput.fill(name)

  // Click Create
  const create = page.getByRole('button', { name: 'Create', exact: true })
  await create.click()
  await page.waitForTimeout(2000)
}

/** Helper: get the current view mode from the toggle button title */
async function getViewToggleTitle(): Promise<string> {
  const toggle = page.locator('button[title="Split View"], button[title="Tab View"]')
  return await toggle.getAttribute('title') ?? ''
}

/** Helper: click the view mode toggle button */
async function toggleView() {
  const toggle = page.locator('button[title="Split View"], button[title="Tab View"]')
  await toggle.click()
  await page.waitForTimeout(500)
}

/** Helper: get terminal count from sidebar by counting close buttons */
async function getSidebarTerminalCount(): Promise<number> {
  return await page.evaluate(() => {
    // The sidebar is an <aside> element; count close buttons within it
    const aside = document.querySelector('aside')
    if (!aside) return 0
    return aside.querySelectorAll('button[aria-label^="Close "]').length
  })
}

/** Helper: close a terminal by name using Playwright locator click */
async function closeTerminalByName(name: string) {
  // Use Playwright's locator click which properly triggers React synthetic events
  // The close button is in the sidebar (inside <aside>) with aria-label="Close {name}"
  const closeBtn = page.locator(`aside button[aria-label="Close ${name}"]`).first()
  const visible = await closeBtn.isVisible().catch(() => false)
  if (visible) {
    await closeBtn.click()
    await page.waitForTimeout(1000)
    return true
  }
  return false
}

// ════════════════════════════════════════════════════════════
// ALL TESTS
// ════════════════════════════════════════════════════════════

test.describe.serial('View Switching', () => {

  test('1. create two terminals via Add Terminal flow', async () => {
    await createTerminal('Alpha')
    await createTerminal('Beta')

    // Both should appear in the sidebar terminal list
    const alpha = page.locator('text=Alpha').first()
    const beta = page.locator('text=Beta').first()
    await expect(alpha).toBeVisible()
    await expect(beta).toBeVisible()
  })

  test('2. tab view: clicking sidebar tabs switches visible terminal', async () => {
    // We should be in tab view by default — toggle title should say "Split View"
    const title = await getViewToggleTitle()
    expect(title).toBe('Split View') // means we are currently in tabs

    // Click Alpha in the sidebar to activate it
    const alphaTab = page.locator('text=Alpha').first()
    await alphaTab.click()
    await page.waitForTimeout(300)

    // The sidebar should highlight Alpha (active has bg-[#37373d])
    const alphaRow = page.locator('.bg-\\[\\#37373d\\]').filter({ hasText: 'Alpha' })
    await expect(alphaRow).toBeVisible()

    // Click Beta in the sidebar
    const betaTab = page.locator('text=Beta').first()
    await betaTab.click()
    await page.waitForTimeout(300)

    // Beta row should now be highlighted
    const betaRow = page.locator('.bg-\\[\\#37373d\\]').filter({ hasText: 'Beta' })
    await expect(betaRow).toBeVisible()
  })

  test('3. toggle to split view', async () => {
    await toggleView()

    // After toggling, the button title should now say "Tab View" (meaning we are in split mode)
    const title = await getViewToggleTitle()
    expect(title).toBe('Tab View')
  })

  test('4. split view: both terminals visible simultaneously', async () => {
    // In split view, each terminal gets a PaneRenderer header bar with the terminal name
    const alphaHeader = page.locator('text=Alpha').first()
    const betaHeader = page.locator('text=Beta').first()
    await expect(alphaHeader).toBeVisible()
    await expect(betaHeader).toBeVisible()

    // There should be xterm instances for both terminals
    const xtermInstances = page.locator('.xterm')
    const count = await xtermInstances.count()
    expect(count).toBeGreaterThanOrEqual(2)
  })

  test('5. toggle back to tabs: correct terminal shown', async () => {
    await toggleView()

    // Should be back in tab view — toggle title says "Split View"
    const title = await getViewToggleTitle()
    expect(title).toBe('Split View')

    // An active terminal should be highlighted in the sidebar
    const activeRow = page.locator('.bg-\\[\\#37373d\\]').first()
    await expect(activeRow).toBeVisible()

    // The sidebar should still show both terminals
    await expect(page.locator('text=Alpha').first()).toBeVisible()
    await expect(page.locator('text=Beta').first()).toBeVisible()
  })

  test('6. create 3rd terminal, switch to split: 3 panes visible', async () => {
    await createTerminal('Gamma')

    // Switch to split view
    await toggleView()
    await page.waitForTimeout(500)

    // All three terminal names should be visible in the pane headers
    for (const name of ['Alpha', 'Beta', 'Gamma']) {
      const header = page.locator(`text=${name}`).first()
      await expect(header).toBeVisible()
    }
  })

  test('7. create 4th terminal, split view: grid layout with all 4 panes', async () => {
    // Toggle back to tabs first to create terminal
    await toggleView()
    await createTerminal('Delta')

    // Switch to split view
    await toggleView()
    await page.waitForTimeout(500)

    // All four terminal names should be visible
    for (const name of ['Alpha', 'Beta', 'Gamma', 'Delta']) {
      const header = page.locator(`text=${name}`).first()
      await expect(header).toBeVisible()
    }

    // In split view, multiple xterm containers are rendered
    const xtermInstances = page.locator('.xterm')
    const count = await xtermInstances.count()
    expect(count).toBeGreaterThanOrEqual(2)
  })

  test('8. close a terminal in split view: remaining terminals reflow', async () => {
    // We are in split view with 4 terminals
    const countBefore = await getSidebarTerminalCount()

    // Close Delta via DOM click dispatch (bypasses Playwright event issues)
    await closeTerminalByName('Delta')

    const countAfter = await getSidebarTerminalCount()
    expect(countAfter).toBeLessThan(countBefore)

    // Alpha, Beta, Gamma should still be visible
    for (const name of ['Alpha', 'Beta', 'Gamma']) {
      const header = page.locator(`text=${name}`).first()
      await expect(header).toBeVisible()
    }
  })

  test('9. close a terminal in tab view: tab removed, next tab activates', async () => {
    // Switch to tab view
    await toggleView()
    await page.waitForTimeout(1000)

    // First, activate Gamma by clicking it in the sidebar
    const gammaTab = page.locator('text=Gamma').first()
    await gammaTab.click()
    await page.waitForTimeout(500)

    const countBefore = await getSidebarTerminalCount()

    // Close Gamma via DOM click
    await closeTerminalByName('Gamma')

    const countAfter = await getSidebarTerminalCount()
    expect(countAfter).toBeLessThan(countBefore)

    // Another terminal should be active
    const activeRow = page.locator('.bg-\\[\\#37373d\\]').first()
    await expect(activeRow).toBeVisible()
  })

  test('10. sidebar terminal list count updates as terminals are added/removed', async () => {
    // Get current count (should be 2: Alpha, Beta)
    const countBefore = await getSidebarTerminalCount()
    expect(countBefore).toBe(2)

    // Add a new terminal
    await createTerminal('Epsilon')

    // Count should increase by 1
    const countAfter = await getSidebarTerminalCount()
    expect(countAfter).toBe(3)
  })

  test('11. terminal names shown in sidebar match created names', async () => {
    // Verify all expected terminal names appear in the sidebar
    for (const name of ['Alpha', 'Beta', 'Epsilon']) {
      const entry = page.locator(`text=${name}`).first()
      await expect(entry).toBeVisible()
    }
  })

  test('12. active terminal highlighted in sidebar', async () => {
    // Click Alpha to make it active
    const alphaTab = page.locator('text=Alpha').first()
    await alphaTab.click()
    await page.waitForTimeout(300)

    // Alpha's row should have the active background class
    const activeRow = page.locator('.bg-\\[\\#37373d\\]').filter({ hasText: 'Alpha' })
    await expect(activeRow).toBeVisible()

    // Beta should NOT have the active background
    const betaRow = page.locator('.bg-\\[\\#37373d\\]').filter({ hasText: 'Beta' })
    const betaActive = await betaRow.count()
    expect(betaActive).toBe(0)
  })

  test('13. close all terminals: returns to Welcome screen', async () => {
    // Close all remaining terminals via DOM click dispatch
    const terminals = ['Alpha', 'Beta', 'Epsilon']
    for (const name of terminals) {
      await closeTerminalByName(name)
    }

    // Welcome screen should reappear
    const welcome = page.locator('text=Welcome to Termpolis')
    await expect(welcome).toBeVisible({ timeout: 5000 })
  })

  test('14. split view panes have header bars with terminal names', async () => {
    // Create two fresh terminals
    await createTerminal('Foo')
    await createTerminal('Bar')

    // Switch to split view
    await toggleView()
    await page.waitForTimeout(500)

    // Each pane should have a header bar (bg-[#2d2d2d]) with the terminal name
    const fooHeader = page.locator('.bg-\\[\\#2d2d2d\\]').filter({ hasText: 'Foo' })
    const barHeader = page.locator('.bg-\\[\\#2d2d2d\\]').filter({ hasText: 'Bar' })
    await expect(fooHeader).toBeVisible()
    await expect(barHeader).toBeVisible()
  })

  test('15. per-pane split button creates a new pane without React errors', async () => {
    // We should currently be in split view with Foo and Bar panes from test 14.
    // Capture any console errors during the split action.
    const consoleErrors: string[] = []
    const errorListener = (msg: any) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text())
    }
    page.on('console', errorListener)

    // Count panes before
    const xtermsBefore = await page.locator('.xterm').count()

    // Click "Split Right" on Foo's pane header
    const fooHeader = page.locator('.bg-\\[\\#2d2d2d\\]').filter({ hasText: 'Foo' }).first()
    const splitRightBtn = fooHeader.locator('button[title="Split Right"]').first()
    await splitRightBtn.click()
    await page.waitForTimeout(1500)

    // A new pane labeled "Foo (split)" should now be visible
    const splitPane = page.locator('.bg-\\[\\#2d2d2d\\]').filter({ hasText: 'Foo (split)' })
    await expect(splitPane).toBeVisible({ timeout: 3000 })

    // Pane count should have increased
    const xtermsAfter = await page.locator('.xterm').count()
    expect(xtermsAfter).toBeGreaterThan(xtermsBefore)

    // No "Rendered more hooks" or hooks-order React errors
    const hooksErrors = consoleErrors.filter(e => /Rendered (more|fewer) hooks|order of Hooks/i.test(e))
    expect(hooksErrors, `unexpected hooks error(s):\n${hooksErrors.join('\n')}`).toEqual([])

    page.off('console', errorListener)
  })

  test('16. tab switching preserves terminal content', async () => {
    // Switch back to tab view
    await toggleView()
    await page.waitForTimeout(300)

    // Activate Foo
    const fooTab = page.locator('text=Foo').first()
    await fooTab.click()
    await page.waitForTimeout(500)

    // Type something into the terminal
    const xterm = page.locator('.xterm-helper-textarea').first()
    await xterm.focus()
    await page.keyboard.type('echo VIEWTEST123')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(1000)

    // Switch to Bar
    const barTab = page.locator('text=Bar').first()
    await barTab.click()
    await page.waitForTimeout(500)

    // Switch back to Foo
    await fooTab.click()
    await page.waitForTimeout(500)

    // The typed text should still be visible in the terminal buffer
    const termContent = page.locator('.xterm')
    const text = await termContent.first().textContent() ?? ''
    expect(text).toContain('VIEWTEST123')
  })

})
