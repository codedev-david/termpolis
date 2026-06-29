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
  test('Ctrl+Shift+F opens the find bar, finds a keyword in scrollback, Escape closes it', async () => {
    await createTerminal('SearchTerm')

    // Print a unique marker, then push it well up into the scrollback with filler
    // lines so it is no longer in the visible viewport.
    const xterm = page.locator('.xterm-helper-textarea').first()
    await xterm.focus()
    await page.keyboard.type('echo FINDME_MARKER_42 && for i in $(seq 1 80); do echo "scroll filler $i"; done')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(2500)

    // Open the find bar with the keybinding (proves the TerminalPane wiring).
    await page.keyboard.press('Control+Shift+F')
    const bar = page.locator('[data-testid="terminal-search"]')
    await expect(bar).toBeVisible({ timeout: 5000 })

    // The input auto-focuses; search for the marker now living in scrollback.
    const input = page.locator('[data-testid="terminal-search-input"]')
    await input.fill('FINDME_MARKER_42')

    // The real SearchAddon scanned the whole buffer (incl. scrollback) and the bar
    // shows "<active>/<total>" with at least one match — proving scrollback search.
    const count = page.locator('[data-testid="terminal-search-count"]')
    await expect(count).toHaveText(/\d+\/[1-9]\d*/, { timeout: 5000 })

    // Escape closes the bar.
    await input.press('Escape')
    await expect(bar).not.toBeVisible({ timeout: 5000 })
  })
})
