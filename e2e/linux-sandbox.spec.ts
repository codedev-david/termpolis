/**
 * The Linux app must work with Chromium's sandbox ON (issue #32).
 *
 * Every other spec passes `--no-sandbox` on Linux, so none of them can see this: on Fedora 44 the
 * AppImage died at launch because the app itself appended `no-sandbox` after Chromium had already
 * started its zygote inside the user-namespace sandbox. Each renderer was then told it was
 * unsandboxed while it still was, failed to create shared memory in /dev/shm, and took the window
 * down with `FATAL:platform_shared_memory_region_posix.cc`.
 *
 * This launch passes no sandbox flag at all, the way the AppImage starts wherever user namespaces
 * work, and checks a real shell round trip through the window. It needs a kernel that allows
 * unprivileged user namespaces (CI's Ubuntu 24.04 restricts them by default; the e2e job lifts
 * that and sets TERMPOLIS_E2E_SANDBOX=1), so it is skipped everywhere else.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { _electron as electron } from 'playwright'
import path from 'path'
import fs from 'fs'
import { e2eUserDataDir, dismissOnboarding } from './helpers/launch'

test.skip(
  process.platform !== 'linux' || process.env.TERMPOLIS_E2E_SANDBOX !== '1',
  'needs Linux with unprivileged user namespaces (TERMPOLIS_E2E_SANDBOX=1)',
)

let app: ElectronApplication
let page: Page
let output = ''

test.afterAll(async () => {
  if (app) await app.close()
})

test('the window and a terminal work with the sandbox on', async () => {
  test.setTimeout(120_000)
  const userData = e2eUserDataDir('linux-sandbox')
  fs.writeFileSync(path.join(userData, 'session.json'), JSON.stringify({
    terminals: [], workspaces: [], defaultShell: 'bash', viewMode: 'tabs',
  }))

  app = await electron.launch({
    // Deliberately no --no-sandbox.
    args: [path.resolve('out/main/index.js'), `--user-data-dir=${userData}`],
    env: { ...process.env, NODE_ENV: 'test' },
  })
  app.process().stderr?.on('data', (d: Buffer) => { output += d.toString() })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await dismissOnboarding(page)

  await page.locator('button:has-text("+ Add Terminal")').first().click()
  const nameInput = page.locator('h2:has-text("New Terminal")').locator('..').locator('input').first()
  await nameInput.fill('Sandboxed')
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 15000 })

  await page.locator('.xterm').first().click()
  await page.keyboard.type('echo sandboxed_$((6*7))')
  await page.keyboard.press('Enter')
  const terminalText = async (): Promise<string> =>
    await page.evaluate(() =>
      (window as unknown as { __termpolis_terminal_text?: () => string }).__termpolis_terminal_text?.() ?? '')
  await expect.poll(terminalText, { timeout: 15000 }).toContain('sandboxed_42')

  expect(output).not.toMatch(/FATAL:platform_shared_memory|No usable sandbox/)
  // ...and nothing in the app turned the sandbox off behind Chromium's back.
  expect(await app.evaluate(({ app: electronApp }) => electronApp.commandLine.hasSwitch('no-sandbox'))).toBe(false)
})
