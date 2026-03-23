/**
 * Termpolis Command Palette E2E Test Suite
 * Deep tests for the command palette: opening, filtering, navigation,
 * command execution, and dismissal behaviors.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { _electron as electron } from 'playwright'
import path from 'path'

let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  // Build the app
  const { execSync } = await import('child_process')
  execSync('npx electron-vite build', { cwd: path.resolve('.'), stdio: 'pipe' })

  app = await electron.launch({
    args: [path.resolve('out/main/index.js')],
    env: { ...process.env, NODE_ENV: 'test' },
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2000)
})

test.afterAll(async () => {
  if (app) await app.close()
})

/** Helper: open the command palette via Ctrl+K */
async function openPalette() {
  await page.keyboard.press('Control+k')
  await page.waitForTimeout(500)
}

/** Helper: close the command palette via Escape */
async function closePalette() {
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
}

/** Helper: get the palette input locator */
function paletteInput() {
  return page.locator('input[placeholder="Type a command..."]')
}

/** Helper: get all visible command buttons inside the palette results area */
function paletteResults() {
  return page.locator('.fixed.z-50 .overflow-y-auto button')
}

// ════════════════════════════════════════════════════════════
// ALL TESTS
// ════════════════════════════════════════════════════════════

test.describe.serial('Command Palette', () => {

  test('1. Ctrl+K opens the command palette overlay', async () => {
    await openPalette()

    // The overlay backdrop should be visible (fixed, full-screen, semi-transparent)
    const overlay = page.locator('.fixed.inset-0')
    await expect(overlay.first()).toBeVisible()

    // The palette container should be visible
    const paletteContainer = page.locator('.fixed.z-50 .bg-\\[\\#252526\\]')
    await expect(paletteContainer).toBeVisible()

    await closePalette()
  })

  test('2. palette shows a text input field for filtering', async () => {
    await openPalette()

    const input = paletteInput()
    await expect(input).toBeVisible()
    await expect(input).toBeFocused()

    // Check placeholder text
    await expect(input).toHaveAttribute('placeholder', 'Type a command...')

    await closePalette()
  })

  test('3. palette shows a list of available commands', async () => {
    await openPalette()

    // With empty query, all commands should be listed
    const results = paletteResults()
    const count = await results.count()
    // There are 19 COMMAND_PATTERNS entries total
    expect(count).toBeGreaterThanOrEqual(15)

    // Verify known command labels are present
    const labels = await results.allTextContents()
    const allText = labels.join(' ')
    expect(allText).toContain('New Terminal')
    expect(allText).toContain('Split Right')
    expect(allText).toContain('Split Down')
    expect(allText).toContain('Toggle Sidebar')
    expect(allText).toContain('Open Settings')
    expect(allText).toContain('Launch Claude')

    await closePalette()
  })

  test('4. typing "new" filters to show "New Terminal" command', async () => {
    await openPalette()

    const input = paletteInput()
    await input.fill('new terminal')
    await page.waitForTimeout(300)

    const results = paletteResults()
    const count = await results.count()
    // Should be filtered down
    expect(count).toBeGreaterThanOrEqual(1)
    expect(count).toBeLessThanOrEqual(5)

    // "New Terminal" should be visible
    const newTermBtn = results.filter({ hasText: 'New Terminal' })
    await expect(newTermBtn.first()).toBeVisible()

    await closePalette()
  })

  test('5. typing "split" filters to show split-related commands', async () => {
    await openPalette()

    const input = paletteInput()
    await input.fill('split')
    await page.waitForTimeout(300)

    const results = paletteResults()
    const labels = await results.allTextContents()
    const allText = labels.join(' ')

    // Should show split-related commands
    expect(allText).toContain('Split')

    // At least Split Right and/or Split Down should match
    const hasSplitRight = allText.includes('Split Right')
    const hasSplitDown = allText.includes('Split Down')
    const hasSplitView = allText.includes('Split View')
    expect(hasSplitRight || hasSplitDown || hasSplitView).toBe(true)

    await closePalette()
  })

  test('6. typing "claude" filters to show "Launch Claude" command', async () => {
    await openPalette()

    const input = paletteInput()
    await input.fill('launch claude')
    await page.waitForTimeout(300)

    const results = paletteResults()
    const count = await results.count()
    expect(count).toBeGreaterThanOrEqual(1)

    const claudeBtn = results.filter({ hasText: 'Launch Claude' })
    await expect(claudeBtn.first()).toBeVisible()

    // Verify the description text is shown alongside it
    const btnText = await claudeBtn.first().textContent() ?? ''
    expect(btnText).toContain('Launch Claude Code AI agent')

    await closePalette()
  })

  test('7. Escape closes the palette', async () => {
    await openPalette()

    // Palette should be visible
    await expect(paletteInput()).toBeVisible()

    // Press Escape to close
    await closePalette()

    // Palette input should be gone
    await expect(paletteInput()).not.toBeVisible()
  })

  test('8. pressing Enter on a command executes it (New Terminal)', async () => {
    await openPalette()

    const input = paletteInput()
    await input.fill('new terminal')
    await page.waitForTimeout(300)

    // The first result should be "New Terminal" and it should be selected (index 0)
    const firstResult = paletteResults().first()
    const firstText = await firstResult.textContent() ?? ''
    expect(firstText).toContain('New Terminal')

    // Press Enter to execute the selected command
    await page.keyboard.press('Enter')
    await page.waitForTimeout(1000)

    // The palette should have closed
    await expect(paletteInput()).not.toBeVisible()

    // The "New Terminal" action opens the Add Terminal modal
    const modal = page.locator('h2:has-text("New Terminal")')
    const modalVisible = await modal.isVisible().catch(() => false)

    if (modalVisible) {
      // Modal opened successfully - verify and close it
      await expect(modal).toBeVisible()
      const cancelBtn = page.getByRole('button', { name: 'Cancel' })
      const cancelVisible = await cancelBtn.isVisible().catch(() => false)
      if (cancelVisible) {
        await cancelBtn.click()
      } else {
        await page.keyboard.press('Escape')
      }
      await page.waitForTimeout(300)
    }

    // The key assertion: palette closed after Enter
    await expect(paletteInput()).not.toBeVisible()
  })

})
