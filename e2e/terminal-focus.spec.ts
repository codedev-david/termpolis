/**
 * Terminal-focus E2E — guards the "input is always ready" promise: switching the
 * active terminal (Alt+<n> or clicking its sidebar tab) must move the caret to
 * that terminal's xterm input line, even when re-selecting the already-active one
 * (the focusNonce mechanism in terminalStore). The headless unit suite proves the
 * store bumps focusNonce and the voice hook calls focusActiveTerminal(), but only
 * a real Electron run proves the xterm <textarea> actually ends up focused.
 *
 * Isolated --user-data-dir so it owns its own single-instance lock and coexists
 * with a developer's running app (mirrors voice-capture.spec.ts).
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { _electron as electron } from 'playwright'
import path from 'path'
import fs from 'fs'
import os from 'os'

let app: ElectronApplication
let page: Page
let isolatedUserData: string

/** True when keyboard focus is on an xterm input line (its hidden helper textarea). */
function focusedOnTerminal(p: Page): Promise<boolean> {
  return p.evaluate(() => {
    const a = document.activeElement as HTMLElement | null
    return !!a && a.classList.contains('xterm-helper-textarea')
  })
}

test.beforeAll(async () => {
  const { execSync } = await import('child_process')
  execSync('npx electron-vite build', { cwd: path.resolve('.'), stdio: 'pipe' })

  isolatedUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-focus-'))
  // Seed a benign session (voice off — this spec is purely about switch-focus).
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

  // Pre-dismiss first-run onboarding so it doesn't intercept clicks/keys.
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

test.describe.serial('Terminal switch focuses the input line', () => {
  test('1. creating terminals leaves the caret on the active terminal', async () => {
    await createTerminal('FocusA')
    await createTerminal('FocusB')
    // The just-created terminal is active; its xterm input should hold focus.
    await expect.poll(() => focusedOnTerminal(page), { timeout: 8000 }).toBe(true)
  })

  test('2. Alt+<n> moves the caret to the selected terminal', async () => {
    // Move focus OFF the terminal first so we can prove the switch re-grabs it.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await page.keyboard.press('Alt+1')
    await expect.poll(() => focusedOnTerminal(page), { timeout: 8000 }).toBe(true)

    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await page.keyboard.press('Alt+2')
    await expect.poll(() => focusedOnTerminal(page), { timeout: 8000 }).toBe(true)
  })

  test('3. re-selecting the ALREADY-active terminal still re-focuses (focusNonce)', async () => {
    // Terminal 2 is active. Blur, then re-select it — focusNonce must re-fire the
    // focus effect even though activeTerminalId did not change.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    expect(await focusedOnTerminal(page)).toBe(false)
    await page.keyboard.press('Alt+2')
    await expect.poll(() => focusedOnTerminal(page), { timeout: 8000 }).toBe(true)
  })

  test('4. clicking a terminal tab focuses its input line', async () => {
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    // Click the first terminal's sidebar tab.
    await page.locator('text=FocusA').first().click()
    await expect.poll(() => focusedOnTerminal(page), { timeout: 8000 }).toBe(true)
  })
})
