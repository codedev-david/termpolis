/**
 * Clipboard E2E — proves the terminal right-click menu's clipboard path works
 * END-TO-END in the real Electron app, against the REAL OS clipboard. The unit
 * suite mocks the clipboard, so it can prove the wiring but not that a real
 * right-click → menu click actually reads the OS clipboard and injects it — the
 * exact "copy/paste does nothing" failure mode that keeps getting reported.
 *
 * This test:
 *   1. puts a known marker on the OS clipboard via Electron's native `clipboard`
 *      module (main process),
 *   2. right-clicks the terminal to open the context menu,
 *   3. clicks "Paste",
 *   4. asserts the marker lands in the terminal.
 *
 * That exercises the real chain: menu button onClick → window.termpolis
 * clipboardReadText IPC → main `clipboard.readText()` → writeToTerminal → PTY
 * echo. The menu's Copy items use the identical IPC mechanism (clipboardWriteText),
 * so a working Paste proves the menu → native-clipboard bridge end-to-end.
 *
 * Isolated --user-data-dir gives it its own single-instance lock so it coexists
 * with a developer's running app.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { _electron as electron } from 'playwright'
import path from 'path'
import fs from 'fs'
import os from 'os'

let app: ElectronApplication
let page: Page
let isolatedUserData: string

const MARKER = 'termpolis_paste_e2e_marker_42'

test.describe.serial('Terminal clipboard (real OS clipboard)', () => {
  test.setTimeout(120_000)

  test.beforeAll(async () => {
    const { execSync } = await import('child_process')
    execSync('npx electron-vite build', { cwd: path.resolve('.'), stdio: 'pipe' })

    isolatedUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-clip-'))
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
      env: { ...process.env, NODE_ENV: 'test', TERMPOLIS_TEST_AGENTS: '1', TERMPOLIS_TEST_TIMING: '1' },
    })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForTimeout(1500)

    await page.evaluate(() => {
      try {
        localStorage.setItem('termpolis.onboarding.seen.v1', '1')
        localStorage.setItem('termpolis.telemetry.optIn', '0')
      } catch {}
    })
    const onboardDialog = page.locator('[aria-labelledby="onboarding-title"]')
    if (await onboardDialog.isVisible({ timeout: 5000 }).catch(() => false)) {
      await page.locator('button:has-text("Skip tour")').first().click({ force: true }).catch(() => {})
      await onboardDialog.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {})
    }
  })

  test.afterAll(async () => {
    if (app) await app.close()
    if (isolatedUserData) { try { fs.rmSync(isolatedUserData, { recursive: true, force: true }) } catch {} }
  })

  test('right-click Paste injects the real OS clipboard into the terminal', async () => {
    // Create a plain terminal.
    await page.locator('button:has-text("+ Add Terminal")').first().click()
    await page.waitForTimeout(400)
    const nameInput = page.locator('h2:has-text("New Terminal")').locator('..').locator('input').first()
    await nameInput.fill('ClipTerm')
    await page.getByRole('button', { name: 'Create', exact: true }).click()
    await page.waitForTimeout(1500)

    const term = page.locator('.xterm').first()
    await expect(term).toBeVisible({ timeout: 10000 })

    // Put a known marker on the REAL OS clipboard via Electron's native module.
    await app.evaluate(async ({ clipboard }, marker) => clipboard.writeText(marker), MARKER)

    // Right-click the terminal → the context menu opens.
    await term.click({ button: 'right' })
    const menu = page.locator('[data-testid="terminal-context-menu"]')
    await expect(menu).toBeVisible({ timeout: 5000 })

    // Click Paste → reads the OS clipboard via native IPC and writes to the PTY.
    await menu.locator('button:has-text("Paste")').click()

    // The marker is echoed by the shell on the input line.
    await expect(page.locator('.xterm-rows')).toContainText(MARKER, { timeout: 15000 })
  })
})
