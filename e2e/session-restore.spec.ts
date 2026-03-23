/**
 * Termpolis Session Restore E2E Test Suite
 * Tests session persistence and restore across app restarts: terminals, view mode,
 * workspaces, settings, and AI profiles survive close/relaunch cycles.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { _electron as electron } from 'playwright'
import path from 'path'
import fs from 'fs'

let app: ElectronApplication
let page: Page

const launchArgs = [path.resolve('out/main/index.js')]
const launchEnv = {
  ...process.env,
  NODE_ENV: 'test',
  TERMPOLIS_TEST_AGENTS: '1',
  TERMPOLIS_TEST_TIMING: '1',
}

/** Launch (or relaunch) the Electron app and wait for it to be ready */
async function launchApp() {
  app = await electron.launch({ args: launchArgs, env: launchEnv })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(3000) // wait for restore + agent init
}

/** Close the app and wait for session to flush */
async function closeApp() {
  await page.waitForTimeout(2000) // let session auto-save (debounced 500ms)
  await app.close()
}

/** Restart: close then relaunch with delay for single-instance lock release */
async function restart() {
  await closeApp()
  // Wait for the Electron single-instance lock to fully release on Windows
  await new Promise(r => setTimeout(r, 2000))
  await launchApp()
}

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

/** Helper: get the number of terminals in the sidebar */
async function getSidebarTerminalCount(): Promise<number> {
  return await page.evaluate(() => {
    const aside = document.querySelector('aside')
    if (!aside) return 0
    return aside.querySelectorAll('button[aria-label^="Close "]').length
  })
}

/** Helper: close a terminal by name */
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

/** Helper: get the current view mode from the toggle button title */
async function getViewToggleTitle(): Promise<string> {
  const toggle = page.locator('button[title="Split View"], button[title="Tab View"]')
  return await toggle.getAttribute('title') ?? ''
}

/** Helper: ensure sidebar is expanded */
async function ensureSidebarExpanded() {
  const expandBtn = page.locator('button[title="Expand sidebar"]')
  if (await expandBtn.isVisible().catch(() => false)) {
    await expandBtn.click()
    await page.waitForTimeout(300)
  }
}

/** Helper: toggle view mode */
async function toggleView() {
  const toggle = page.locator('button[title="Split View"], button[title="Tab View"]')
  await toggle.click()
  await page.waitForTimeout(500)
}

/** Helper: save the current terminals as a workspace */
async function saveWorkspace(name: string) {
  const saveBtn = page.locator('button:has-text("+ Save Workspace")').first()
  await saveBtn.click()
  await page.waitForTimeout(300)

  const nameInput = page.locator('input[placeholder="Workspace name"]')
  await nameInput.fill(name)

  const confirmBtn = page.locator('button:has-text("Save")').last()
  await confirmBtn.click()
  await page.waitForTimeout(500)
}

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

  await launchApp()
})

test.afterAll(async () => {
  if (app) await app.close()
})

// ════════════════════════════════════════════════════════════
// ALL TESTS
// ════════════════════════════════════════════════════════════

test.describe.serial('Session Restore', () => {

  test('1. create terminal, restart app: terminal is restored', async () => {
    await createTerminal('Restore-1')

    // Verify terminal exists before restart
    const entry = page.locator('text=Restore-1').first()
    await expect(entry).toBeVisible()

    await restart()

    // After restart, the terminal should be restored in the sidebar
    const restored = page.locator('text=Restore-1').first()
    await expect(restored).toBeVisible({ timeout: 10000 })
  })

  test('2. restored terminal has the correct name in sidebar', async () => {
    // After restart from test 1, verify the name is exactly what we created
    const sidebarEntry = page.locator('aside').locator('text=Restore-1').first()
    await expect(sidebarEntry).toBeVisible()
    const text = await sidebarEntry.textContent()
    expect(text).toContain('Restore-1')
  })

  test('3. restored terminal has correct shell type shown in status bar', async () => {
    // Click the restored terminal to make it active
    const termTab = page.locator('text=Restore-1').first()
    await termTab.click()
    await page.waitForTimeout(1000)

    // The status bar should show the shell type (PowerShell is the default on Windows)
    const shellSpan = page.locator('span[title="Shell"]')
    await expect(shellSpan).toBeVisible({ timeout: 5000 })
    const shellText = await shellSpan.textContent()
    // Should contain a known shell label
    expect(shellText).toMatch(/PowerShell|Bash|CMD|Zsh|Git Bash/)
  })

  test('4. create 2 terminals, restart: both restored', async () => {
    await createTerminal('Multi-A')
    await createTerminal('Multi-B')

    await restart()

    // Both terminals should be restored
    const multiA = page.locator('text=Multi-A').first()
    const multiB = page.locator('text=Multi-B').first()
    await expect(multiA).toBeVisible({ timeout: 10000 })
    await expect(multiB).toBeVisible({ timeout: 10000 })
  })

  test('5. restore preserves tab view mode', async () => {
    // We should be in tab view (the default) — toggle title should say "Split View"
    const title = await getViewToggleTitle()
    expect(title).toBe('Split View') // means currently in tab mode
  })

  test('6. switch to split view, restart: split view restored', async () => {
    // Switch to split view
    await toggleView()
    await page.waitForTimeout(500)
    const titleBefore = await getViewToggleTitle()
    expect(titleBefore).toBe('Tab View') // means currently in split mode

    // Force a session save by triggering a store change that's in the save dependency list.
    // The save effect depends on terminals/workspaces/keybindings/aiProfiles/promptTemplates,
    // NOT viewMode directly. Saving a workspace triggers the save which captures current viewMode.
    await saveWorkspace('Split-Check-WS')
    await page.waitForTimeout(2000) // wait for debounced save (1s) to flush

    await restart()

    // After restart, should still be in split view
    const titleAfter = await getViewToggleTitle()
    expect(titleAfter).toBe('Tab View') // still in split mode
  })

  test('7. session with no terminals: shows Welcome screen on launch', async () => {
    // Close all terminals
    const terminalNames = await page.evaluate(() => {
      const aside = document.querySelector('aside')
      if (!aside) return []
      const buttons = aside.querySelectorAll('button[aria-label^="Close "]')
      return Array.from(buttons).map(b => b.getAttribute('aria-label')?.replace('Close ', ''))
    })

    // Switch back to tab view first (easier to close terminals)
    const viewTitle = await getViewToggleTitle()
    if (viewTitle === 'Tab View') {
      await toggleView() // go back to tabs
    }

    for (const name of terminalNames) {
      if (name) await closeTerminalByName(name)
    }
    await page.waitForTimeout(500)

    // Verify no terminals remain
    const count = await getSidebarTerminalCount()
    expect(count).toBe(0)

    await restart()

    // Welcome screen should be visible
    const welcome = page.locator('text=Welcome to Termpolis')
    await expect(welcome).toBeVisible({ timeout: 10000 })
  })

  test('8. terminal sidebar count matches after restore', async () => {
    // Ensure we are in tab view for consistent behavior
    const viewTitle = await getViewToggleTitle()
    if (viewTitle === 'Tab View') {
      await toggleView() // switch to tabs
    }

    // Create 3 terminals
    await createTerminal('Count-A')
    await createTerminal('Count-B')
    await createTerminal('Count-C')

    const countBefore = await getSidebarTerminalCount()
    expect(countBefore).toBe(3)

    await restart()

    // Wait for terminals to fully restore
    await page.waitForTimeout(2000)

    const countAfter = await getSidebarTerminalCount()
    expect(countAfter).toBe(3)
  })

  test('9. closing all restored terminals shows Welcome screen', async () => {
    // We have 3 terminals from test 8: Count-A, Count-B, Count-C
    await closeTerminalByName('Count-A')
    await closeTerminalByName('Count-B')
    await closeTerminalByName('Count-C')

    const count = await getSidebarTerminalCount()
    expect(count).toBe(0)

    const welcome = page.locator('text=Welcome to Termpolis')
    await expect(welcome).toBeVisible({ timeout: 5000 })
  })

  test('10. settings persist: change default shell, restart, verify preserved', async () => {
    // Ensure sidebar is expanded
    await ensureSidebarExpanded()

    // Open settings
    const gearBtn = page.locator('button[title="Settings"]')
    await gearBtn.click()
    await page.waitForTimeout(500)

    // The settings panel should be visible
    const settingsHeading = page.locator('h1:has-text("Settings")')
    await expect(settingsHeading).toBeVisible()

    // Change the default shell via the select dropdown
    const shellSelect = page.locator('select').first()
    await expect(shellSelect).toBeVisible()

    // Get current value and pick a different one
    const currentShell = await shellSelect.inputValue()

    // Select a different shell — try cmd if currently powershell, otherwise powershell
    const newShell = currentShell === 'powershell' ? 'cmd' : 'powershell'
    await shellSelect.selectOption(newShell)
    await page.waitForTimeout(500)

    // Close settings
    await gearBtn.click()
    await page.waitForTimeout(300)

    // The save effect depends on terminals/workspaces/etc, not defaultShell directly.
    // Creating a terminal triggers the save which captures the current defaultShell.
    await createTerminal('Settings-Trigger')
    await page.waitForTimeout(2000) // wait for debounced save

    await restart()

    // Ensure sidebar is expanded after restart
    await ensureSidebarExpanded()

    // Open settings again and verify the shell was preserved
    const gearBtn2 = page.locator('button[title="Settings"]')
    await gearBtn2.click()
    await page.waitForTimeout(500)

    const shellSelect2 = page.locator('select').first()
    const restoredShell = await shellSelect2.inputValue()
    expect(restoredShell).toBe(newShell)

    // Close settings
    await gearBtn2.click()
    await page.waitForTimeout(300)
  })

  test('11. workspaces persist across restarts', async () => {
    // Create a terminal and save it as a workspace
    await createTerminal('WS-Persist')
    await saveWorkspace('Persistent WS')
    await page.waitForTimeout(500)

    // Verify the workspace appears
    const wsEntry = page.locator('text=Persistent WS').first()
    await expect(wsEntry).toBeVisible()

    await restart()

    // Ensure sidebar is expanded after restart
    await ensureSidebarExpanded()

    // After restart, the workspace should still be listed
    const restoredWs = page.locator('text=Persistent WS').first()
    await expect(restoredWs).toBeVisible({ timeout: 10000 })
  })

  test('12. AI profiles (custom) persist across restarts', async () => {
    // Ensure sidebar is expanded and AI Agents section is visible
    await ensureSidebarExpanded()

    // Click the "+" button to add a custom AI profile
    const addProfileBtn = page.locator('button[title="Add custom AI profile"]')
    await expect(addProfileBtn).toBeVisible({ timeout: 5000 })
    await addProfileBtn.click()
    await page.waitForTimeout(500)

    // Fill in the profile form
    const nameInput = page.locator('input[placeholder="Name (e.g. My Agent)"]')
    await expect(nameInput).toBeVisible()
    await nameInput.fill('Test Agent')

    const cmdInput = page.locator('input[placeholder="Command (e.g. claude --model opus)"]')
    await cmdInput.fill('echo test-agent')

    // Submit the form — the Add button is inside the fixed overlay form
    const addBtn = page.locator('.fixed button:has-text("Add")').first()
    await addBtn.click()
    await page.waitForTimeout(2000) // wait for debounced save

    // Verify the custom profile appears in the sidebar
    const profileEntry = page.locator('text=Test Agent').first()
    await expect(profileEntry).toBeVisible()

    await restart()

    // Ensure sidebar is expanded after restart
    await ensureSidebarExpanded()

    // After restart, the custom AI profile should still be listed
    const restoredProfile = page.locator('text=Test Agent').first()
    await expect(restoredProfile).toBeVisible({ timeout: 10000 })
  })

})
