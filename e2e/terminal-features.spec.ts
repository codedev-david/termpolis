/**
 * Termpolis Terminal Features E2E Test Suite
 * Tests terminal creation, rendering, interaction, context menus, status bar,
 * command palette, history search, sidebar collapse, and more.
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

  // Clear and type the name
  const nameInput = page.locator('h2:has-text("New Terminal")').locator('..').locator('input').first()
  await nameInput.fill(name)

  // Click Create
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

// ════════════════════════════════════════════════════════════
// ALL TESTS
// ════════════════════════════════════════════════════════════

test.describe.serial('Terminal Features', () => {

  test('1. add terminal modal has shell dropdown, name input, and theme picker', async () => {
    const addBtn = page.locator('button:has-text("+ Add Terminal")').first()
    await addBtn.click()
    await page.waitForTimeout(500)

    // Modal should be visible
    const modalTitle = page.locator('h2:has-text("New Terminal")')
    await expect(modalTitle).toBeVisible()

    // Name input exists
    const nameInput = modalTitle.locator('..').locator('input').first()
    await expect(nameInput).toBeVisible()

    // Shell dropdown exists (select element under "Shell" label)
    const shellSelect = page.locator('label:has-text("Shell") select')
    await expect(shellSelect).toBeVisible()

    // Theme section exists with theme buttons
    const themeSection = page.locator('text=Theme').first()
    await expect(themeSection).toBeVisible()

    // Cancel the modal
    const cancelBtn = page.getByRole('button', { name: 'Cancel' })
    await cancelBtn.click()
    await page.waitForTimeout(300)
  })

  test('2. terminal renders with xterm element', async () => {
    await createTerminal('TestTerm1')

    // xterm renders a .xterm container with screen content
    const xtermEl = page.locator('.xterm')
    await expect(xtermEl.first()).toBeVisible()
    const count = await xtermEl.count()
    expect(count).toBeGreaterThanOrEqual(1)
  })

  test('3. terminal shows shell prompt after creation', async () => {
    // Wait for the terminal to show some output (shell prompt)
    await page.waitForTimeout(2000)

    const xtermContent = page.locator('.xterm').first()
    const text = await xtermContent.textContent() ?? ''
    // Shell prompt should contain something (PS prompt, $, >, etc.)
    expect(text.length).toBeGreaterThan(0)
  })

  test('4. type a command in terminal, verify output appears', async () => {
    // Focus the terminal textarea (xterm helper)
    const xterm = page.locator('.xterm-helper-textarea').first()
    await xterm.focus()

    // Type a command
    await page.keyboard.type('echo TESTOUTPUT789')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(2000)

    // Verify the output appears in the terminal
    const termContent = page.locator('.xterm').first()
    const text = await termContent.textContent() ?? ''
    expect(text).toContain('TESTOUTPUT789')
  })

  test('5. right-click terminal area shows context menu', async () => {
    // Right-click on the terminal container
    const termContainer = page.locator('.xterm').first()
    await termContainer.click({ button: 'right' })
    await page.waitForTimeout(300)

    // Context menu should appear (it has a fixed z-50 div with bg-[#2d2d2d])
    const contextMenu = page.locator('.fixed.z-50.bg-\\[\\#2d2d2d\\]')
    await expect(contextMenu).toBeVisible()
  })

  test('6. context menu has Copy, Paste, Export options', async () => {
    // Context menu should already be visible from previous test
    const contextMenu = page.locator('.fixed.z-50.bg-\\[\\#2d2d2d\\]')

    // Check for Copy, Paste, and Export options
    const copyBtn = contextMenu.locator('button:has-text("Copy")')
    await expect(copyBtn).toBeVisible()

    const pasteBtn = contextMenu.locator('button:has-text("Paste")')
    await expect(pasteBtn).toBeVisible()

    const exportBtn = contextMenu.locator('button:has-text("Export")')
    const exportCount = await exportBtn.count()
    expect(exportCount).toBeGreaterThanOrEqual(1)

    // Dismiss context menu by clicking elsewhere
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
  })

  test('7. terminal status bar shows shell type', async () => {
    // The status bar has a blue background (bg-[#007acc]) and shows the shell type
    const statusBar = page.locator('.bg-\\[\\#007acc\\]').first()
    await expect(statusBar).toBeVisible()

    const statusText = await statusBar.textContent() ?? ''
    // Should contain a shell label like PowerShell, Bash, CMD, etc.
    const hasShellLabel = ['PowerShell', 'Bash', 'CMD', 'Zsh', 'Git Bash'].some(s => statusText.includes(s))
    expect(hasShellLabel).toBe(true)
  })

  test('8. terminal status bar shows current directory', async () => {
    const statusBar = page.locator('.bg-\\[\\#007acc\\]').first()
    const statusText = await statusBar.textContent() ?? ''
    // Should contain a directory path (Windows or Unix style)
    const hasPath = statusText.includes('C:\\') || statusText.includes('/home') || statusText.includes('/Users')
    expect(hasPath).toBe(true)
  })

  test('9. terminal count in sidebar header updates', async () => {
    // The sidebar shows "Terminals (N)" count
    const termCountLabel = page.locator('text=Terminals').first()
    await expect(termCountLabel).toBeVisible()

    // We have 1 terminal currently
    const sidebarText = await termCountLabel.textContent() ?? ''
    expect(sidebarText).toContain('(1)')
  })

  test('10. multiple terminals: create 2nd, verify both listed in sidebar', async () => {
    await createTerminal('TestTerm2')

    // Both terminal names should be visible in the sidebar
    const term1 = page.locator('aside').locator('text=TestTerm1').first()
    const term2 = page.locator('aside').locator('text=TestTerm2').first()
    await expect(term1).toBeVisible()
    await expect(term2).toBeVisible()

    // Count should show 2
    const count = await getSidebarTerminalCount()
    expect(count).toBe(2)
  })

  test('11. close terminal: X button removes it from sidebar', async () => {
    const countBefore = await getSidebarTerminalCount()
    await closeTerminalByName('TestTerm2')
    const countAfter = await getSidebarTerminalCount()
    expect(countAfter).toBe(countBefore - 1)

    // TestTerm2 should no longer be in sidebar
    const term2 = page.locator('aside').locator('text=TestTerm2')
    const term2Count = await term2.count()
    expect(term2Count).toBe(0)
  })

  test('12. terminal name editable via tab popover (right-click)', async () => {
    // Right-click on the terminal tab in the sidebar to open the popover
    const termTab = page.locator('aside').locator('text=TestTerm1').first()
    await termTab.click({ button: 'right' })
    await page.waitForTimeout(500)

    // The TabPopover should appear with a name input
    const popover = page.locator('.z-50.bg-\\[\\#252526\\]').last()
    await expect(popover).toBeVisible()

    // Find the name input in the popover and change it
    const nameInput = popover.locator('input[type="text"], input:not([type])').first()
    await expect(nameInput).toBeVisible()
    await nameInput.fill('RenamedTerm')

    // Click Save
    const saveBtn = popover.locator('button:has-text("Save")')
    await saveBtn.click()
    await page.waitForTimeout(500)

    // Verify the renamed terminal appears in sidebar
    const renamed = page.locator('aside').locator('text=RenamedTerm').first()
    await expect(renamed).toBeVisible()
  })

  test('13. command history search: Ctrl+Shift+H opens search modal', async () => {
    await page.keyboard.press('Control+Shift+H')
    await page.waitForTimeout(500)

    // The history search modal should appear with a search input
    const historyModal = page.locator('input[placeholder="Search command history…"]')
    await expect(historyModal).toBeVisible()

    // Close it with Escape
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
  })

  test('14. command palette: Ctrl+K opens palette overlay', async () => {
    await page.keyboard.press('Control+k')
    await page.waitForTimeout(500)

    // The command palette should appear with "Type a command..." placeholder
    const paletteInput = page.locator('input[placeholder="Type a command..."]')
    await expect(paletteInput).toBeVisible()
  })

  test('15. command palette: typing filters commands', async () => {
    // Palette should still be open from previous test
    const paletteInput = page.locator('input[placeholder="Type a command..."]')
    await paletteInput.fill('new terminal')
    await page.waitForTimeout(300)

    // Should show the "New Terminal" command in results
    const newTerminalResult = page.locator('button:has-text("New Terminal")').first()
    await expect(newTerminalResult).toBeVisible()

    // Other unrelated commands should be filtered out
    // Type something that matches fewer commands
    await paletteInput.fill('toggle sidebar')
    await page.waitForTimeout(300)

    const toggleResult = page.locator('button:has-text("Toggle Sidebar")').first()
    await expect(toggleResult).toBeVisible()
  })

  test('16. command palette: Escape closes it', async () => {
    // Palette should still be open from previous test
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)

    // Palette input should no longer be visible
    const paletteInput = page.locator('input[placeholder="Type a command..."]')
    await expect(paletteInput).not.toBeVisible()
  })

  test('17. sidebar collapse: clicking chevron collapses sidebar', async () => {
    // Find the collapse sidebar button (chevron-left icon)
    const collapseBtn = page.locator('aside button[title="Collapse sidebar"]')
    await expect(collapseBtn).toBeVisible()
    await collapseBtn.click()
    await page.waitForTimeout(500)

    // Sidebar should be collapsed (narrow, ~40px wide)
    const collapsedSidebar = page.locator('aside')
    const width = await collapsedSidebar.evaluate(el => el.getBoundingClientRect().width)
    expect(width).toBeLessThanOrEqual(50)

    // The "Add Terminal" button should not be visible in collapsed state
    const addBtn = page.locator('button:has-text("+ Add Terminal")')
    await expect(addBtn).not.toBeVisible()
  })

  test('18. sidebar expand: clicking chevron expands sidebar back', async () => {
    // Find the expand button (chevron-right in collapsed sidebar)
    const expandBtn = page.locator('aside button[title="Expand sidebar"]')
    await expect(expandBtn).toBeVisible()
    await expandBtn.click()
    await page.waitForTimeout(500)

    // Sidebar should be expanded again
    const sidebar = page.locator('aside')
    const width = await sidebar.evaluate(el => el.getBoundingClientRect().width)
    expect(width).toBeGreaterThanOrEqual(200)

    // Add Terminal button should be visible again
    const addBtn = page.locator('button:has-text("+ Add Terminal")')
    await expect(addBtn).toBeVisible()
  })

})
