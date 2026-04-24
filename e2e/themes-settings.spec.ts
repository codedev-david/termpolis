/**
 * Termpolis Themes & Settings E2E Test Suite
 * Tests settings panel, theme selection, font size controls, sidebar collapse/expand,
 * section chevrons, and keybindings reset.
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

/** Helper: create a terminal via the Add Terminal modal with a given name and optional theme */
async function createTerminal(name: string, theme?: string) {
  const addBtn = page.locator('button:has-text("+ Add Terminal")').first()
  await addBtn.click()
  await page.waitForTimeout(500)

  // Clear and type the name
  const nameInput = page.locator('h2:has-text("New Terminal")').locator('..').locator('input').first()
  await nameInput.fill(name)

  // Select theme if specified
  if (theme) {
    const themeBtn = page.locator(`button:has-text("${theme}")`).first()
    await themeBtn.click()
    await page.waitForTimeout(200)
  }

  // Click Create
  const create = page.getByRole('button', { name: 'Create', exact: true })
  await create.click()
  await page.waitForTimeout(2000)
}

// ════════════════════════════════════════════════════════════
// ALL TESTS
// ════════════════════════════════════════════════════════════

test.describe.serial('Themes & Settings', () => {

  test('1. settings panel opens via gear icon in sidebar icon bar', async () => {
    // Click the gear icon (Settings button) in the sidebar icon bar
    const gearBtn = page.locator('button[title="Settings"]')
    await gearBtn.click()
    await page.waitForTimeout(500)

    // The settings panel should be visible with "Settings" heading
    const settingsHeading = page.locator('h1:has-text("Settings")')
    await expect(settingsHeading).toBeVisible()
  })

  test('2. settings panel shows Default Shell dropdown', async () => {
    const shellLabel = page.locator('label:has-text("Default Shell")')
    await expect(shellLabel).toBeVisible()

    // The dropdown (select) should exist near the label
    const shellSelect = page.locator('select').first()
    await expect(shellSelect).toBeVisible()
  })

  test('3. settings panel shows Autocomplete toggle', async () => {
    // Re-open settings if it closed after earlier tests (the panel can be
    // dismissed by some clicks/keys, so don't assume it's still open).
    const heading = page.locator('h1:has-text("Settings")')
    if (!(await heading.isVisible().catch(() => false))) {
      await page.locator('button[title="Settings"]').click()
      await page.waitForTimeout(500)
    }
    // "Enable Autocomplete" is rendered as plain text (not a <label>), so
    // we match on text content instead of the label element.
    const autocompleteLabel = page.getByText('Enable Autocomplete', { exact: true }).first()
    await expect(autocompleteLabel).toBeVisible({ timeout: 5000 })

    // A toggle button sits in the same row as the label. We don't require a
    // specific Tailwind class — just verify there's a button next to it.
    const toggleRow = autocompleteLabel.locator('..')
    const toggleBtn = toggleRow.locator('button').first()
    await expect(toggleBtn).toBeVisible()
  })

  test('4. settings panel has keybindings section', async () => {
    const keybindingsLabel = page.locator('label:has-text("Keyboard Shortcuts")')
    await expect(keybindingsLabel).toBeVisible()

    // Should have a table with Action and Shortcut headers
    const actionHeader = page.locator('th:has-text("Action")')
    const shortcutHeader = page.locator('th:has-text("Shortcut")')
    await expect(actionHeader).toBeVisible()
    await expect(shortcutHeader).toBeVisible()
  })

  test('5. close settings by clicking gear again', async () => {
    // Click the gear icon again to close settings
    const gearBtn = page.locator('button[title="Settings"]')
    await gearBtn.click()
    await page.waitForTimeout(500)

    // Settings heading should no longer be visible (Welcome screen or no settings)
    const settingsHeading = page.locator('h1:has-text("Settings")')
    await expect(settingsHeading).not.toBeVisible()
  })

  test('6. create a terminal, verify it uses default theme (dark background)', async () => {
    await createTerminal('DarkDefault')

    // The terminal should render with an xterm instance
    const xterm = page.locator('.xterm').first()
    await expect(xterm).toBeVisible()

    // The default dark theme background is #1e1e1e -- check the xterm viewport background
    const bgColor = await page.evaluate(() => {
      const viewport = document.querySelector('.xterm-viewport') as HTMLElement
      if (!viewport) return ''
      return getComputedStyle(viewport).backgroundColor
    })
    // #1e1e1e = rgb(30, 30, 30)
    expect(bgColor).toContain('30, 30, 30')
  })

  test('7. theme selection in terminal creation modal: 7 themes listed', async () => {
    // Open the Add Terminal modal
    const addBtn = page.locator('button:has-text("+ Add Terminal")').first()
    await addBtn.click()
    await page.waitForTimeout(500)

    // Check all 7 theme names are visible as buttons in the modal
    const expectedThemes = ['Dark', 'Light', 'Solarized Dark', 'Solarized Light', 'Monokai', 'Dracula', 'Nord']
    for (const themeName of expectedThemes) {
      const themeBtn = page.locator('.fixed').getByRole('button', { name: themeName, exact: true })
      await expect(themeBtn).toBeVisible()
    }

    // Cancel the modal
    const cancelBtn = page.getByRole('button', { name: 'Cancel' })
    await cancelBtn.click()
    await page.waitForTimeout(300)
  })

  test('8. create terminal with Monokai theme: background color differs from dark', async () => {
    await createTerminal('MonokaiTerm', 'Monokai')

    // Click the Monokai terminal in sidebar to activate it
    const monokaiTab = page.locator('text=MonokaiTerm').first()
    await monokaiTab.click()
    await page.waitForTimeout(1000)

    // Monokai background is #272822 = rgb(39, 40, 34), which differs from dark #1e1e1e = rgb(30, 30, 30)
    const bgColor = await page.evaluate(() => {
      const viewports = document.querySelectorAll('.xterm-viewport') as NodeListOf<HTMLElement>
      // Get the last viewport (most recently created terminal)
      const viewport = viewports[viewports.length - 1]
      if (!viewport) return ''
      return getComputedStyle(viewport).backgroundColor
    })
    // Monokai: rgb(39, 40, 34) -- should NOT be the dark theme rgb(30, 30, 30)
    expect(bgColor).not.toContain('30, 30, 30')
  })

  test('9. font size controls exist in terminal creation modal', async () => {
    // Open the Add Terminal modal
    const addBtn = page.locator('button:has-text("+ Add Terminal")').first()
    await addBtn.click()
    await page.waitForTimeout(500)

    // The font size section should have a number input and +/- buttons
    const fontSizeInput = page.locator('.fixed input[type="number"]')
    await expect(fontSizeInput).toBeVisible()

    // Verify default value is 14
    const value = await fontSizeInput.inputValue()
    expect(value).toBe('14')

    // The +/- stepper buttons flank the number input
    // Use the Unicode minus sign (U+2212) that the component renders
    const minusBtn = page.locator('.fixed').locator('button', { hasText: '\u2212' })
    const plusBtn = page.locator('.fixed').getByRole('button', { name: '+', exact: true })
    await expect(minusBtn).toBeVisible()
    await expect(plusBtn).toBeVisible()

    // Cancel
    const cancelBtn = page.getByRole('button', { name: 'Cancel' })
    await cancelBtn.click()
    await page.waitForTimeout(300)
  })

  test('10. sidebar collapse/expand: icon bar stays visible when collapsed', async () => {
    // Click the collapse button (chevron-left)
    const collapseBtn = page.locator('button[title="Collapse sidebar"]')
    await collapseBtn.click()
    await page.waitForTimeout(500)

    // Sidebar should be collapsed -- the aside should still exist but be narrow
    const aside = page.locator('aside')
    await expect(aside).toBeVisible()

    // The expand button should be visible (chevron-right icon)
    const expandBtn = page.locator('button[title="Expand sidebar"]')
    await expect(expandBtn).toBeVisible()

    // The full sidebar content (like "Terminals" section) should NOT be visible
    const terminalsSection = page.locator('text=Terminals').first()
    await expect(terminalsSection).not.toBeVisible()

    // Expand it back
    await expandBtn.click()
    await page.waitForTimeout(500)

    // Sidebar should be fully visible again
    await expect(terminalsSection).toBeVisible()
  })

  test('11. sidebar sections have collapse chevrons', async () => {
    // Check that AI Agents, Workspaces, and Terminals sections each have a collapse chevron button
    const sections = ['AI Agents', 'Workspaces', 'Terminals']
    for (const section of sections) {
      // Each section header is a button with the section name and a chevron icon
      const sectionBtn = page.locator(`button:has-text("${section}")`).filter({ has: page.locator('i.fa-solid') }).first()
      await expect(sectionBtn).toBeVisible()
    }
  })

  test('12. settings panel has reset keybindings option', async () => {
    // Open settings
    const gearBtn = page.locator('button[title="Settings"]')
    await gearBtn.click()
    await page.waitForTimeout(500)

    // Look for the "Reset All" button in the keybindings section
    const resetBtn = page.locator('button:has-text("Reset All")')
    await expect(resetBtn).toBeVisible()

    // Close settings
    await gearBtn.click()
    await page.waitForTimeout(300)
  })

})
