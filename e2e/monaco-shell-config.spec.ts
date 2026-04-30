/**
 * Regression gate for the Shell Config Files "Loading..." bug.
 *
 * Background: @monaco-editor/react defaults to fetching Monaco from
 * cdn.jsdelivr.net. Our renderer's CSP restricts script-src to 'self', so
 * the CDN fetch is blocked and the editor sits on the "Loading..." text
 * forever. (Sentry surfaced this as issue #4: "DOM error event on <script>
 * (https://cdn.jsdelivr.net/npm/monaco-editor@0.55.1/min/vs/loader.js)".)
 *
 * The fix in src/renderer/src/lib/monaco-setup.ts wires loader.config to
 * the locally-bundled monaco module, so this test asserts the actual
 * Monaco DOM (.monaco-editor + .view-lines) renders within a few seconds
 * — not the "Loading..." placeholder.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { _electron as electron } from 'playwright'
import path from 'path'
import fs from 'fs'

let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  const { execSync } = await import('child_process')
  execSync('npx electron-vite build', { cwd: path.resolve('.'), stdio: 'pipe' })

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

test.describe.serial('Shell Config Files Monaco editor', () => {
  test('does not attempt to load Monaco from the CDN', async () => {
    // The fix: loader.config({ monaco }) routes to the bundled module, so
    // the CDN script tag should never be inserted into the document.
    await page.locator('button[title="Settings"]').click()
    await page.waitForTimeout(500)

    const heading = page.locator('h1:has-text("Settings")')
    await expect(heading).toBeVisible()

    const cdnScripts = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('script'))
        .map(s => s.src)
        .filter(src => src.includes('cdn.jsdelivr.net') && src.includes('monaco'))
    })
    expect(cdnScripts).toEqual([])
  })

  test('Monaco editor renders for .bashrc — not stuck on Loading...', async () => {
    // Settings should already be open from the previous test in this
    // serial describe; reopen if it isn't.
    const heading = page.locator('h1:has-text("Settings")')
    if (!(await heading.isVisible().catch(() => false))) {
      await page.locator('button[title="Settings"]').click()
      await page.waitForTimeout(500)
    }

    // Scroll the Shell Config Files section into view.
    const sectionLabel = page.locator('label:has-text("Shell Config Files")')
    await sectionLabel.scrollIntoViewIfNeeded()
    await expect(sectionLabel).toBeVisible()

    // Click the .bashrc tab to ensure it's the active editor file.
    const bashrcTab = page.getByRole('button', { name: '.bashrc', exact: true })
    if (await bashrcTab.isVisible().catch(() => false)) {
      await bashrcTab.click()
      await page.waitForTimeout(300)
    }

    // The bundled Monaco renders a `.monaco-editor` root with `.view-lines`
    // inside. If the loader were still hitting the CDN, neither would
    // appear — only the "Loading..." placeholder would.
    const monacoRoot = page.locator('.monaco-editor').first()
    await expect(monacoRoot).toBeVisible({ timeout: 15000 })

    const viewLines = page.locator('.monaco-editor .view-lines').first()
    await expect(viewLines).toBeVisible({ timeout: 15000 })

    // The Loading placeholder text should NOT be present anywhere in the
    // shell-config region.
    const loadingText = page.getByText('Loading...', { exact: true })
    await expect(loadingText).not.toBeVisible()
  })

  test('MonacoEnvironment.getWorker is installed (CSP-safe worker spawn)', async () => {
    const hasGetWorker = await page.evaluate(() => {
      const env = (self as unknown as { MonacoEnvironment?: { getWorker?: unknown } }).MonacoEnvironment
      return Boolean(env && typeof env.getWorker === 'function')
    })
    expect(hasGetWorker).toBe(true)
  })
})
