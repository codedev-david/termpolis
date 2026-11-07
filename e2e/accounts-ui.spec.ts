/**
 * The in-app account UI (account-switcher-ui.md): Settings ▸ Accounts as the account manager, the
 * Add account wizard, and a sign-in in the sheet, with no terminal and nothing to type.
 *
 * Never a real agent: Claude Code is e2e/mocks/mock-claude-accounts.cjs, first on PATH through
 * e2e/test-shims-accounts, which signs in with a pasted code and answers `claude auth status`
 * (tests/electron/accountsUiE2eMock.test.ts proves it answers the way main asks). Every agent
 * config is a scratch home (TERMPOLIS_TEST_AGENT_HOME), and the app a scratch profile. Nothing
 * opens a browser: the mock prints the sign-in address and opens nothing, and Open again isn't
 * clicked.
 *
 * With no account registered there is no account UI at all (D13): no chip, no Switch account…
 * in the palette. The switch in place, its queue and the limit card are the unit tests' (the
 * switch engine's own screens, FakeTerminal), and David's live tests.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { _electron as electron } from 'playwright'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { dismissOnboarding, e2eLaunchArgs, ensureE2eBuild, quitApp } from './helpers/launch'

const LABEL = 'accounts-ui'
const SHIMS = path.resolve('e2e', 'test-shims-accounts')
const EMAIL = 'codedev@example.test'

let app: ElectronApplication
let page: Page
let agentHome = ''

test.beforeAll(async () => {
  ensureE2eBuild()
  agentHome = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-accounts-ui-home-'))
  // Claude Code's main profile, signed out: the mock reads no sign-in in it.
  fs.mkdirSync(path.join(agentHome, '.claude'))
  // The Unix shim loses its +x bit through some npm/git paths.
  try { fs.chmodSync(path.join(SHIMS, 'claude'), 0o755) } catch { /* windows */ }
  const sep = process.platform === 'win32' ? ';' : ':'
  app = await electron.launch({
    args: e2eLaunchArgs(LABEL),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      TERMPOLIS_TEST_AGENTS: '1',
      TERMPOLIS_TEST_AGENT_HOME: agentHome,
      PATH: `${SHIMS}${sep}${process.env.PATH ?? ''}`,
      // The mock sign-in: it waits for a code, and 'good-code' signs in as EMAIL.
      MOCK_LOGIN_MODE: 'code',
      MOCK_SIGNED_IN_EMAIL: EMAIL,
    },
  })
  page = await app.firstWindow()
  await dismissOnboarding(page)
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(1500)
})

test.afterAll(async () => {
  await quitApp(app)
  if (agentHome) {
    try { fs.rmSync(agentHome, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

async function paletteOffers(text: string): Promise<boolean> {
  await page.keyboard.press('Control+k')
  const input = page.locator('input[placeholder="Type a command..."]')
  await expect(input).toBeVisible({ timeout: 10_000 })
  await input.fill('switch account')
  const offered = await page.getByText(text, { exact: true }).isVisible().catch(() => false)
  await page.keyboard.press('Escape')
  await expect(input).toBeHidden({ timeout: 10_000 })
  return offered
}

test.describe.serial('the in-app account UI', () => {
  test('1. with no account registered there is no account UI (D13)', async () => {
    await expect(page.locator('[data-testid="account-chip"]')).toHaveCount(0)
    expect(await paletteOffers('Switch account…')).toBe(false)
  })

  test('2. Settings ▸ Accounts lists each agent, each with Add account', async () => {
    await page.locator('button[title="Settings"]').click()
    await expect(page.locator('[data-testid="settings-tabs"]')).toBeVisible()
    await page.locator('[data-testid="settings-tab-accounts"]').click()
    for (const agent of ['claude', 'codex', 'agy']) {
      await expect(page.locator(`[data-testid="accounts-card-${agent}"]`)).toBeVisible({ timeout: 15_000 })
      await expect(page.locator(`[data-testid="accounts-add-${agent}"]`)).toBeVisible()
    }
    await expect(page.locator('[data-testid="accounts-empty-claude"]')).toContainText('uses your main profile')
  })

  test('3. the wizard adds a Gemini account: a name, a colour and its Google email', async () => {
    await page.locator('[data-testid="accounts-add-agy"]').click()
    const sheet = page.locator('[data-testid="add-account"]')
    await expect(sheet).toBeVisible()
    await expect(sheet).toContainText('Add a Gemini')
    await page.locator('[data-testid="add-account-label"]').fill('home')
    await page.locator('[data-testid="add-account-color"]').nth(4).click()
    await page.locator('[data-testid="add-account-email"]').fill('me@example.test')
    await page.locator('[data-testid="add-account-submit"]').click()
    await expect(page.locator('[data-testid="add-account-done-headline"]')).toHaveText('Added home.', { timeout: 15_000 })
    await page.locator('[data-testid="add-account-finish"]').click()
    await expect(sheet).toBeHidden()
    const card = page.locator('[data-testid="accounts-card-agy"] [data-testid^="account-row-"]')
    await expect(card).toHaveCount(1)
    await expect(card).toContainText('home')
    await expect(card).toContainText('me@example.test')
  })

  test('4. the wizard adds a Claude Code account and signs it in, in the sheet, with no terminal', async () => {
    const terminalsBefore = await page.locator('[data-terminal-id]').count()
    await page.locator('[data-testid="accounts-add-claude"]').click()
    await page.locator('[data-testid="add-account-label"]').fill('codedev')
    await expect(page.locator('[data-testid="add-account-submit"]')).toHaveText('Add and sign in')
    await page.locator('[data-testid="add-account-submit"]').click()
    await expect(page.locator('[data-testid="add-account-sign-in-step"]')).toBeVisible({ timeout: 20_000 })
    // How to sign in, as buttons; then the CLI's own steps, read from its hidden session.
    await page.locator('[data-testid="sign-in-method-claudeai"]').click()
    await expect(page.locator('[data-testid="sign-in-browser"]')).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('[data-testid="sign-in-address"]')).toContainText('https://claude.com/cai/oauth/authorize')
    await page.locator('[data-testid="sign-in-input"]').fill('good-code')
    await page.locator('[data-testid="sign-in-submit"]').click()
    // The field is cleared at once: the code is never kept on screen.
    await expect(page.locator('[data-testid="sign-in-input"]')).toHaveCount(0, { timeout: 30_000 })
    await expect(page.locator('[data-testid="sign-in-success"]')).toContainText(EMAIL, { timeout: 30_000 })
    await page.locator('[data-testid="sign-in-done"]').click()
    await expect(page.locator('[data-testid="add-account-done-headline"]')).toHaveText(`codedev is signed in as ${EMAIL}.`)
    await page.locator('[data-testid="add-account-finish"]').click()
    await expect(page.locator('[data-testid="add-account"]')).toBeHidden()
    // Its card, signed in as the CLI says; the main profile is listed too, as main.
    const claude = page.locator('[data-testid="accounts-card-claude"]')
    await expect(claude.locator('[data-testid^="account-row-"]')).toHaveCount(2, { timeout: 15_000 })
    await expect(claude).toContainText('codedev')
    await expect(claude).toContainText(`signed in as ${EMAIL}`)
    // No terminal was opened for any of it.
    expect(await page.locator('[data-terminal-id]').count()).toBe(terminalsBefore)
    // The profile it signed in is the scratch home's, never a real one.
    expect(fs.readFileSync(path.join(agentHome, '.claude-codedev', '.mock-signed-in'), 'utf8')).toBe(EMAIL)
  })

  test('5. renames an account in place on its card', async () => {
    const label = page.locator('[data-testid="accounts-card-claude"] [data-testid^="account-label-"]', { hasText: 'codedev' })
    await label.click()
    const field = page.locator('[data-testid="accounts-card-claude"] [data-testid^="account-edit-label-"]')
    await expect(field).toBeFocused()
    await field.fill('side')
    await field.press('Enter')
    await expect(page.locator('[data-testid="accounts-card-claude"] [data-testid^="account-label-"]', { hasText: 'side' })).toBeVisible({ timeout: 15_000 })
  })

  test('6. with two Claude Code accounts, the palette offers Switch account…', async () => {
    await page.keyboard.press('Escape')
    expect(await paletteOffers('Switch account…')).toBe(true)
  })
})
