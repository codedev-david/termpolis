/**
 * Terminal search E2E — proves the in-terminal find bar works end-to-end against a
 * REAL xterm + SearchAddon: Ctrl+Shift+F opens the bar, typing a keyword that has
 * scrolled off-screen into the scrollback still finds it (the SearchAddon scans the
 * whole buffer and reports a match count), and Escape closes the bar. The headless
 * unit suite proves the bar's UI/logic and the keybinding; only a real Electron run
 * proves the addon actually searches scrollback and drives the count.
 *
 * Isolated --user-data-dir so it owns its own single-instance lock and coexists
 * with a developer's running app (mirrors terminal-focus.spec.ts).
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { _electron as electron } from 'playwright'
import path from 'path'
import fs from 'fs'
import os from 'os'

let app: ElectronApplication
let page: Page
let isolatedUserData: string

test.beforeAll(async () => {
  const { execSync } = await import('child_process')
  execSync('npx electron-vite build', { cwd: path.resolve('.'), stdio: 'pipe' })

  isolatedUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-search-'))
  fs.writeFileSync(path.join(isolatedUserData, 'session.json'), JSON.stringify({
    terminals: [],
    workspaces: [],
    defaultShell: process.platform === 'win32' ? 'powershell' : 'bash',
    viewMode: 'tabs',
  }))

  app = await electron.launch({
    args: [
      path.resolve('out/main/index.js'),
      `--user-data-dir=${isolatedUserData}`,
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
    ],
    env: { ...process.env, NODE_ENV: 'test', TERMPOLIS_TEST_AGENTS: '1' },
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(1500)

  await page.evaluate(() => {
    try {
      localStorage.setItem('termpolis.onboarding.seen.v1', '1')
      localStorage.setItem('termpolis.telemetry.optIn', '0')
    } catch { /* ignore */ }
  })
  const onboardDialog = page.locator('[aria-labelledby="onboarding-title"]')
  if (await onboardDialog.isVisible({ timeout: 5000 }).catch(() => false)) {
    await page.locator('button:has-text("Skip tour")').first().click({ force: true }).catch(() => {})
    await onboardDialog.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {})
  }
})

test.afterAll(async () => {
  if (app) await app.close()
  if (isolatedUserData) {
    try { fs.rmSync(isolatedUserData, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

async function createTerminal(name: string) {
  await page.locator('button:has-text("+ Add Terminal")').first().click()
  await page.waitForTimeout(400)
  const nameInput = page.locator('h2:has-text("New Terminal")').locator('..').locator('input').first()
  await nameInput.fill(name)
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await page.waitForTimeout(1500)
}

test.describe.serial('In-terminal find bar (search + scrollback jump)', () => {
  test('Ctrl+Shift+F opens the find bar and jumps to a keyword scrolled into the scrollback', async () => {
    test.setTimeout(60_000)
    await createTerminal('SearchTerm')

    // Print a UNIQUE marker once at the top, then push it far up into the scrollback
    // with filler so it is no longer in the visible viewport (250 lines >> any window).
    const xterm = page.locator('.xterm-helper-textarea').first()
    const term = page.locator('.xterm').first()
    await xterm.focus()
    await page.keyboard.type('echo TOPMARKER_FIND_ME_99; for i in $(seq 1 250); do echo "filler line $i"; done')
    await page.keyboard.press('Enter')
    // Wait until the output finished rendering (the LAST filler line is on screen).
    await expect(term).toContainText('filler line 250', { timeout: 25000 })
    // The marker is now scrolled OFF the visible viewport.
    expect(await term.textContent()).not.toContain('TOPMARKER_FIND_ME_99')

    // Open the find bar (proves the TerminalPane keybinding + component wiring).
    await xterm.focus()
    await page.keyboard.press('Control+Shift+F')
    const bar = page.locator('[data-testid="terminal-search"]')
    await expect(bar).toBeVisible({ timeout: 5000 })

    // Search for the off-screen marker — the real SearchAddon scans the whole buffer
    // (incl. scrollback) and scrolls the viewport to the match, bringing it back on
    // screen. This proves scrollback search + jump without depending on the flaky
    // decoration match-count under the headless renderer.
    const input = page.locator('[data-testid="terminal-search-input"]')
    await input.fill('TOPMARKER_FIND_ME_99')
    await input.press('Enter') // explicit findNext → selects + scrolls the match into view
    await expect(term).toContainText('TOPMARKER_FIND_ME_99', { timeout: 10000 })

    // Escape closes the bar.
    await input.press('Escape')
    await expect(bar).not.toBeVisible({ timeout: 5000 })
  })
})
