/**
 * Memory panel E2E — drives the real Electron app to prove the persistent-memory
 * UI actually works end-to-end (open, controls present, primer-inject path, and
 * discoverability via the Command Palette). Closes the "never watched it run in
 * the real app" gap for the memory feature.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { _electron as electron } from 'playwright'
import path from 'path'
import fs from 'fs'
import os from 'os'

let app: ElectronApplication
let page: Page
let userDataDir: string

test.beforeAll(async () => {
  const { execSync } = await import('child_process')
  execSync('npx electron-vite build', { cwd: path.resolve('.'), stdio: 'pipe' })

  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-mem-e2e-'))
  fs.writeFileSync(
    path.join(userDataDir, 'session.json'),
    JSON.stringify({ terminals: [], workspaces: [], defaultShell: 'powershell', viewMode: 'tabs' }),
  )

  app = await electron.launch({
    args: [
      path.resolve('out/main/index.js'),
      `--user-data-dir=${userDataDir}`,
      // Ubuntu CI runners ship chrome-sandbox without SUID root → Electron aborts
      // before JS runs. Pass --no-sandbox up-front on Linux (as the other specs do).
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
    ],
    env: { ...process.env, NODE_ENV: 'test', TERMPOLIS_SMOKE_SKIP_PICKERS: '1' },
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(1500)

  // Pre-dismiss the first-run onboarding modal so it doesn't trap the keyboard.
  await page.evaluate(() => {
    try {
      localStorage.setItem('termpolis.onboarding.seen.v1', '1')
      localStorage.setItem('termpolis.telemetry.optIn', '0')
    } catch {
      /* ignore */
    }
  })
  const onboardDialog = page.locator('[aria-labelledby="onboarding-title"]')
  if (await onboardDialog.isVisible({ timeout: 5000 }).catch(() => false)) {
    await page.locator('button:has-text("Skip tour")').first().click({ force: true }).catch(() => {})
    await onboardDialog.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {})
  }
})

test.afterAll(async () => {
  if (app) await app.close()
  if (userDataDir) {
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

const queryInput = () => page.locator('input[aria-label="Memory query"]')
const closeBtn = () => page.locator('button[aria-label="Close memory panel"]')

test.describe.serial('Memory panel', () => {
  test('1. Ctrl+Shift+M opens the Memory panel with its controls', async () => {
    await page.keyboard.press('Control+Shift+M')
    await page.waitForTimeout(800)

    await expect(queryInput()).toBeVisible()
    await expect(page.getByRole('button', { name: /Index past conversations/i })).toBeVisible()
    await expect(page.getByRole('button', { name: /Index this repo/i })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Inject primer' })).toBeVisible()

    await closeBtn().click()
    await page.waitForTimeout(300)
    await expect(queryInput()).not.toBeVisible()
  })

  test('2. the Command Palette lists a Memory command', async () => {
    await page.keyboard.press('Control+k')
    await page.waitForTimeout(400)
    const input = page.locator('input[placeholder="Type a command..."]')
    await expect(input).toBeVisible()
    await input.fill('memory')
    await page.waitForTimeout(300)

    const results = page.locator('.fixed.z-50 .overflow-y-auto button')
    const labels = (await results.allTextContents()).join(' ')
    expect(labels).toContain('Memory')

    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
  })

  test('3. panel controls respond — inject-primer warns without a query (no crash)', async () => {
    await page.keyboard.press('Control+Shift+M')
    await page.waitForTimeout(600)
    await expect(queryInput()).toBeVisible()

    await page.getByRole('button', { name: 'Inject primer' }).click()
    await page.waitForTimeout(300)
    await expect(page.getByText(/Type what you are working on/)).toBeVisible()

    await closeBtn().click()
    await page.waitForTimeout(300)
  })
})
