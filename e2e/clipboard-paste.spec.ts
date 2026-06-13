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

  // --- COPY: select terminal text, right-click a Copy variant, read the REAL OS
  // clipboard. Copy reads xterm's BUFFER model (term.getSelection()), so it works
  // headlessly regardless of the GPU/canvas renderer. (Copy as Image uses a WebGL
  // canvas capture that xvfb can't reliably produce, so it's exercised by the unit
  // test for the clipboard:write-image IPC, not here.) ---

  /** Put `marker` on a clean top line and triple-click to select that line.
   *  Returns the click point so the caller can right-click the same spot. */
  async function selectMarkerLine(marker: string): Promise<{ x: number; y: number }> {
    const term = page.locator('.xterm').first()
    await term.click() // focus xterm
    await page.keyboard.press('Enter')   // submit whatever is on the input line
    await page.waitForTimeout(250)
    await page.keyboard.type('clear')    // reset to a top-of-screen prompt
    await page.keyboard.press('Enter')
    await page.waitForTimeout(500)
    await page.keyboard.type(marker)     // lands on the (now top) input line
    await expect(page.locator('.xterm-rows')).toContainText(marker, { timeout: 8000 })
    const box = await page.locator('.xterm-screen').first().boundingBox()
    if (!box) throw new Error('no .xterm-screen bounding box')
    const pt = { x: box.x + 40, y: box.y + 8 } // first text row
    await page.mouse.click(pt.x, pt.y, { clickCount: 3 }) // xterm triple-click = select line
    return pt
  }

  const readClip = () => app.evaluate(async ({ clipboard }) => clipboard.readText())

  test('right-click Copy puts the selected terminal text on the real clipboard', async () => {
    const marker = 'zz_copy_plain_71'
    const pt = await selectMarkerLine(marker)
    await app.evaluate(async ({ clipboard }) => clipboard.writeText('__cleared__')) // prove freshness
    await page.mouse.click(pt.x, pt.y, { button: 'right' })
    const menu = page.locator('[data-testid="terminal-context-menu"]')
    await expect(menu).toBeVisible({ timeout: 5000 })
    await menu.locator('button').filter({ hasText: 'Copy' }).first().click() // plain "Copy"
    await expect.poll(readClip, { timeout: 10000 }).toContain(marker)
  })

  test('right-click "Copy as Code Block" writes the markdown form to the clipboard', async () => {
    const marker = 'zz_copy_codeblock_72'
    const pt = await selectMarkerLine(marker)
    await app.evaluate(async ({ clipboard }) => clipboard.writeText('__cleared__'))
    await page.mouse.click(pt.x, pt.y, { button: 'right' })
    const menu = page.locator('[data-testid="terminal-context-menu"]')
    await expect(menu).toBeVisible({ timeout: 5000 })
    await menu.locator('button').filter({ hasText: 'Copy as Code Block' }).click()
    // The plain-text flavor is a ```-fenced block that contains the selected line.
    await expect.poll(readClip, { timeout: 10000 }).toContain(marker)
  })
})
