/**
 * End-to-end gate for the in-app Report-a-Problem flow.
 *
 * The modal itself has deep unit coverage (ReportProblemModal.test.tsx).
 * This spec verifies the plumbing that unit tests can't see:
 *  - the "Help / Support" entry point in StatusBar opens the Help modal
 *  - the "Report a problem" button in Help opens the Report modal
 *  - the Report modal collects diagnostics from the main process via IPC
 *  - submit calls the `openExternal` IPC channel with a real GitHub
 *    new-issue URL whose body contains the user's title/description and
 *    the diagnostics block
 *
 * We stub `window.termpolis.openExternal` in the renderer so no real
 * browser launches during CI. `collectDiagnostics` is left real so the
 * whole main<->renderer round-trip is exercised.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { _electron as electron } from 'playwright'
import path from 'path'
import fs from 'fs'

let app: ElectronApplication
let page: Page
const SCREENSHOTS = 'e2e/screenshots/report-problem'

test.beforeAll(async () => {
  if (fs.existsSync(SCREENSHOTS)) fs.rmSync(SCREENSHOTS, { recursive: true })
  fs.mkdirSync(SCREENSHOTS, { recursive: true })

  const { execSync } = await import('child_process')
  execSync('npx electron-vite build', { cwd: path.resolve('.'), stdio: 'pipe' })

  app = await electron.launch({
    args: [
      path.resolve('out/main/index.js'),
      // Linux CI (xvfb) rejects chrome-sandbox because the binary isn't
      // SUID-owned by root. App code later sets --no-sandbox, but by then
      // chromium has already aborted. Mirror the pattern used by chrome-smoke.
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
    ],
    env: { ...process.env, NODE_ENV: 'test' },
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(1500)

  // Dismiss the onboarding modal if it's up. The 4-step tour starts on
  // step 1; "Skip tour" is the always-visible dismissal control.
  const onboardDialog = page.locator('[aria-labelledby="onboarding-title"]')
  if (await onboardDialog.isVisible({ timeout: 5000 }).catch(() => false)) {
    await page.locator('button:has-text("Skip tour")').first().click({ force: true }).catch(() => {})
    await onboardDialog.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {})
  }
  await page.evaluate(() => {
    try { localStorage.setItem('termpolis.onboarding.seen.v1', '1') } catch {}
  }).catch(() => {})
})

test.afterAll(async () => {
  if (app) await app.close()
})

async function ss(name: string) {
  await page.screenshot({ path: `${SCREENSHOTS}/${name}.png`, fullPage: true })
}

test.describe.serial('Report-a-Problem flow', () => {
  test('Help / Support in StatusBar opens the Help modal', async () => {
    await page.locator('button:has-text("Help / Support")').first().click()
    await expect(page.locator('[data-testid="help-report-problem"]')).toBeVisible({ timeout: 5000 })
    await ss('1-help-modal-open')
  })

  test('Clicking "Report a problem" opens the Report modal', async () => {
    await page.locator('[data-testid="help-report-problem"]').click()
    await expect(page.locator('[data-testid="report-problem-modal"]')).toBeVisible({ timeout: 5000 })
    await expect(page.locator('[data-testid="report-title-input"]')).toBeFocused()
    await ss('2-report-modal-open')
  })

  test('Diagnostics preview appears (main-process IPC round-trip)', async () => {
    // If diagnostics:collect fails or the preload shim is broken, the
    // preview block never renders. This is the e2e-only signal that the
    // main<->renderer bridge is wired correctly.
    await expect(page.locator('[data-testid="report-diagnostics-preview"]'))
      .toBeVisible({ timeout: 5000 })
    const text = await page.locator('[data-testid="report-diagnostics-preview"]').textContent()
    expect(text).toContain('App version')
    expect(text).toContain('Electron')
  })

  test('Submit invokes openExternal with a GitHub new-issue URL', async () => {
    // contextBridge freezes window.termpolis, so the renderer-side override
    // is silently ignored. Instead we stub shell.openExternal in the main
    // process, which is what the IPC handler actually calls.
    await app.evaluate(({ shell }) => {
      const s = shell as any
      s.__reportUrls = []
      s.__origOpenExternal = shell.openExternal.bind(shell)
      shell.openExternal = async (url: string) => {
        s.__reportUrls.push(url)
        return undefined
      }
    })

    const titleInput = page.locator('[data-testid="report-title-input"]')
    const descInput = page.locator('[data-testid="report-description-input"]')
    await titleInput.click()
    await titleInput.fill('Terminal hang on split')
    await descInput.click()
    await descInput.fill('Opened a split view and the pane froze after 30s.')

    // Wait for submit to become enabled before clicking — on slower CI the
    // controlled-component re-render can lag behind the fill.
    const submit = page.locator('[data-testid="report-submit"]')
    await expect(submit).toBeEnabled({ timeout: 5000 })
    await ss('3-before-submit')
    await submit.click()

    // Modal should close on success
    await expect(page.locator('[data-testid="report-problem-modal"]'))
      .toBeHidden({ timeout: 5000 })

    const urls: string[] = await app.evaluate(({ shell }) => (shell as any).__reportUrls)
    expect(urls).toHaveLength(1)
    const parsed = new URL(urls[0])
    expect(parsed.origin).toBe('https://github.com')
    expect(parsed.pathname).toBe('/codedev-david/termpolis/issues/new')
    expect(parsed.searchParams.get('title')).toBe('Terminal hang on split')
    expect(parsed.searchParams.get('labels')).toBe('bug,user-report')
    const body = parsed.searchParams.get('body') || ''
    expect(body).toContain('Opened a split view and the pane froze after 30s.')
    // Diagnostics block should be present since we never unchecked it
    expect(body).toContain('App version')
    expect(body).toContain('Electron')

    // Restore so we don't leak the stub across test files
    await app.evaluate(({ shell }) => {
      const s = shell as any
      if (s.__origOpenExternal) shell.openExternal = s.__origOpenExternal
    })
    await ss('4-submitted')
  })
})
