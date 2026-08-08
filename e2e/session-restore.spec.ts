/**
 * Termpolis Session Restore E2E Test Suite
 * Tests session persistence and restore across app restarts: view mode, workspaces,
 * settings, and AI profiles survive close/relaunch cycles.
 *
 * Loose terminals deliberately do NOT. Every launch starts on a clean slate; restoring a
 * saved group of terminals is a WORKSPACE's job and happens only when the user asks for it.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { _electron as electron } from 'playwright'
import path from 'path'
import fs from 'fs'
import { e2eLaunchArgs, e2eUserDataDir, dismissOnboarding } from './helpers/launch'

let app: ElectronApplication
let page: Page

// Same profile on every relaunch — this spec's whole point is that state survives a restart.
const launchArgs = e2eLaunchArgs('session-restore')
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
  await dismissOnboarding(page)
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

  // Start fresh on the Welcome screen. Seeded into this spec's own profile — the old code
  // wrote into ~/AppData/Roaming/termpolis, i.e. the developer's REAL session layout.
  const sessionPaths = [path.join(e2eUserDataDir('session-restore'), 'session.json')]
  const cleanSession = JSON.stringify({
    terminals: [], workspaces: [],
    defaultShell: process.platform === 'win32' ? 'powershell' : 'bash',
    viewMode: 'tabs',
  })
  for (const sessionPath of sessionPaths) {
    fs.writeFileSync(sessionPath, cleanSession)
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
  // Every test here tears down and relaunches Electron at least once — a full app boot,
  // node-pty spawn and session rehydrate, not a page reload. Under the sharded run four of
  // these compete for one runner and the 120s default is genuinely tight: test 11 hit it,
  // then passed on retry, i.e. flaky for want of headroom rather than broken. `test.slow()`
  // triples the budget for the file instead of hiding it behind `retries`.
  test.slow()

  // Loose terminals are deliberately NOT restored. Auto-restore resurrected shells whose
  // processes were long dead and competed with WORKSPACES for ownership of "which terminals
  // are open". Saving a group of terminals for a project is a workspace's job, and a
  // workspace is restored explicitly by the user — never silently at boot. Everything else
  // in this file (view mode, settings, workspaces, AI profiles) still persists.
  test('1. create terminal, restart app: terminal is NOT restored', async () => {
    await createTerminal('Restore-1')

    // Verify terminal exists before restart
    const entry = page.locator('text=Restore-1').first()
    await expect(entry).toBeVisible()

    await restart()

    // After restart the terminal is gone — every launch starts clean
    const restored = page.locator('text=Restore-1')
    await expect(restored).toHaveCount(0, { timeout: 10000 })
  })

  test('2. a clean-slate launch has an empty sidebar and the Welcome screen', async () => {
    await ensureSidebarExpanded()
    const count = await getSidebarTerminalCount()
    expect(count).toBe(0)

    const welcome = page.locator('text=Welcome to Termpolis')
    await expect(welcome).toBeVisible({ timeout: 10000 })
  })

  test('3. a terminal created after launch shows its shell type in the status bar', async () => {
    // Nothing is restored any more, so the shell-label check has to run against a
    // freshly created terminal rather than a resurrected one.
    await createTerminal('Shell-Check')

    const termTab = page.locator('text=Shell-Check').first()
    await termTab.click()
    await page.waitForTimeout(1000)

    // The status bar should show the shell type (PowerShell is the default on Windows)
    const shellSpan = page.locator('span[title="Shell"]')
    await expect(shellSpan).toBeVisible({ timeout: 5000 })
    const shellText = await shellSpan.textContent()
    // Should contain a known shell label
    expect(shellText).toMatch(/PowerShell|Bash|CMD|Zsh|Git Bash/)
  })

  test('4. create 2 terminals, restart: neither comes back', async () => {
    await createTerminal('Multi-A')
    await createTerminal('Multi-B')

    await restart()
    await ensureSidebarExpanded()

    // Neither terminal — nor the one left over from test 3 — survives the relaunch
    await expect(page.locator('text=Multi-A')).toHaveCount(0, { timeout: 10000 })
    await expect(page.locator('text=Multi-B')).toHaveCount(0)
    await expect(page.locator('text=Shell-Check')).toHaveCount(0)
    expect(await getSidebarTerminalCount()).toBe(0)
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
    // A terminal has to exist first: "+ Save Workspace" is disabled at zero terminals, and the
    // previous test's restart left the app with none.
    await createTerminal('Split-WS-Seed')
    await saveWorkspace('Split-Check-WS')
    await page.waitForTimeout(2000) // wait for debounced save (1s) to flush

    await restart()

    // After restart, should still be in split view
    const titleAfter = await getViewToggleTitle()
    expect(titleAfter).toBe('Tab View') // still in split mode
  })

  test('7. closing every terminal by hand also lands on the Welcome screen', async () => {
    // Switch back to tab view first (easier to close terminals)
    const viewTitle = await getViewToggleTitle()
    if (viewTitle === 'Tab View') {
      await toggleView() // go back to tabs
    }

    // Seed the terminals to close — the previous test's restart left none behind.
    await createTerminal('Close-A')
    await createTerminal('Close-B')

    const terminalNames = await page.evaluate(() => {
      const aside = document.querySelector('aside')
      if (!aside) return []
      const buttons = aside.querySelectorAll('button[aria-label^="Close "]')
      return Array.from(buttons).map(b => b.getAttribute('aria-label')?.replace('Close ', ''))
    })
    expect(terminalNames.length).toBeGreaterThan(0)

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

  test('8. sidebar terminal count drops to zero across a restart', async () => {
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
    await ensureSidebarExpanded()

    // Give a would-be restore every chance to run before asserting it didn't
    await page.waitForTimeout(2000)

    const countAfter = await getSidebarTerminalCount()
    expect(countAfter).toBe(0)
  })

  test('9. a WORKSPACE keeps its terminals across a restart and restores on demand', async () => {
    // The positive half of the contract: loose terminals vanish, but the terminals saved
    // INTO a workspace survive the relaunch and come back when the user clicks it.
    await createTerminal('WS-Term-A')
    await createTerminal('WS-Term-B')
    await saveWorkspace('Restore-WS')
    await page.waitForTimeout(2000) // let the debounced save flush

    await restart()
    await ensureSidebarExpanded()

    // Nothing loose came back...
    expect(await getSidebarTerminalCount()).toBe(0)

    // ...but the workspace did, with its terminals intact
    const ws = page.locator('aside').locator('text=Restore-WS').first()
    await expect(ws).toBeVisible({ timeout: 10000 })

    await ws.click()
    await page.waitForTimeout(3000) // spawning two shells

    await expect(page.locator('text=WS-Term-A').first()).toBeVisible({ timeout: 10000 })
    await expect(page.locator('text=WS-Term-B').first()).toBeVisible({ timeout: 10000 })
    expect(await getSidebarTerminalCount()).toBe(2)
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

  test('13. a workspace restores the AI AGENT, not just its shell', async () => {
    // Workspaces are the only restore path now, so "restores an AI terminal" has to
    // mean the agent is running again — not an empty prompt in the right directory.
    // The workspace is seeded straight into the session file because launching a real
    // agent from the sidebar needs a native directory picker.
    if (app) await app.close()
    const sessionPath = path.join(e2eUserDataDir('session-restore'), 'session.json')
    const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'))
    session.terminals = []
    session.workspaces = [
      ...(session.workspaces ?? []),
      {
        id: 'ws-agent',
        name: 'Agent-WS',
        terminals: [{
          name: 'Claude Agent', color: '#D97706', shellType: 'powershell',
          cwd: process.cwd(), fontSize: 14, theme: 'dark', fontFamily: 'monospace',
          agentCommand: 'claude',
        }],
      },
    ]
    fs.writeFileSync(sessionPath, JSON.stringify(session))
    await launchApp()
    await ensureSidebarExpanded()

    const ws = page.locator('aside').locator('text=Agent-WS').first()
    await expect(ws).toBeVisible({ timeout: 10000 })
    await ws.click()
    await expect(page.locator('text=Claude Agent').first()).toBeVisible({ timeout: 15000 })
    expect(await getSidebarTerminalCount()).toBe(1)

    // The mock Claude only prints its trust prompt once it has actually been typed into
    // the restored shell, so seeing it in the PTY buffer proves the relaunch happened.
    // Read the buffer over IPC rather than off the xterm DOM: the canvas renderer keeps
    // no .xterm-rows to scrape.
    await expect(async () => {
      const id = JSON.parse(fs.readFileSync(sessionPath, 'utf8')).terminals?.[0]?.id
      expect(id, 'restored terminal not persisted yet').toBeTruthy()
      const res = await page.evaluate((tid: string) => window.termpolis.readTerminalBuffer(tid), id)
      expect((res as any)?.data?.output ?? '').toContain('Quick safety check')
    }).toPass({ timeout: 30000 })
  })

})
