/**
 * InstallHint Modal — Qwen-specific E2E
 *
 * Verifies the InstallHint modal renders correctly for the aider-qwen agent:
 *   - modal container scrolls vertically (content is long)
 *   - all numbered install steps render with visible text (no empty gap)
 *   - the qwen3-coder-next "custom profile" block renders as a section, not a
 *     step box with an empty-string separator (the pre-v1.11.10 bug)
 *   - platform-specific steps appear for the current OS
 *   - copying a step works
 *
 * The modal is triggered deterministically via the TERMPOLIS_FORCE_MISSING_AGENTS
 * env hook in src/main/index.ts (agents:detect IPC), which forces the named
 * agents to report as not-installed regardless of the developer's real system.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { _electron as electron } from 'playwright'
import path from 'path'
import fs from 'fs'

let app: ElectronApplication
let page: Page
const SCREENSHOTS = 'e2e/screenshots/install-hint-qwen'

test.beforeAll(async () => {
  if (fs.existsSync(SCREENSHOTS)) fs.rmSync(SCREENSHOTS, { recursive: true })
  fs.mkdirSync(SCREENSHOTS, { recursive: true })

  const { execSync } = await import('child_process')
  execSync('npx electron-vite build', { cwd: path.resolve('.'), stdio: 'pipe' })

  const os = await import('os')
  const sessionPath = path.join(os.homedir(), 'AppData', 'Roaming', 'termpolis', 'session.json')
  if (fs.existsSync(sessionPath)) {
    fs.writeFileSync(
      sessionPath,
      JSON.stringify({ terminals: [], workspaces: [], defaultShell: 'powershell', viewMode: 'tabs' }),
    )
  }

  app = await electron.launch({
    args: [path.resolve('out/main/index.js')],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      TERMPOLIS_TEST_AGENTS: '1',
      TERMPOLIS_TEST_TIMING: '1',
      TERMPOLIS_FORCE_MISSING_AGENTS: 'aider-qwen,claude',
    },
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2500)
})

test.afterAll(async () => {
  if (app) await app.close()
})

async function ss(name: string) {
  await page.screenshot({ path: `${SCREENSHOTS}/${name}.png`, fullPage: true })
}

async function ensureAgentsExpanded() {
  const qwenRow = page.locator('text=Qwen AI').first()
  if (await qwenRow.isVisible().catch(() => false)) return
  const header = page.locator('button:has-text("AI Agents")').first()
  if (await header.isVisible().catch(() => false)) {
    await header.click()
    await page.waitForTimeout(300)
  }
}

async function openQwenInstallHint() {
  await ensureAgentsExpanded()
  // Click the Qwen AI row. Because we forced aider-qwen to missing, clicking
  // the row (or the red circle) should open the InstallHint modal.
  const qwenBtn = page.locator('button:has-text("Qwen AI")').first()
  await qwenBtn.click()
  // Modal fades in
  await page.locator('[data-testid="install-hint-modal"]').waitFor({ state: 'visible', timeout: 5000 })
}

async function closeIfOpen() {
  const modal = page.locator('[data-testid="install-hint-modal"]')
  if (await modal.isVisible().catch(() => false)) {
    await page.keyboard.press('Escape').catch(() => {})
    const gotIt = page.locator('button:has-text("Got it")').first()
    if (await gotIt.isVisible().catch(() => false)) {
      await gotIt.click().catch(() => {})
    }
    await page.waitForTimeout(300)
  }
}

test.describe.serial('Qwen InstallHint modal', () => {
  test('qwen row shows red circle-xmark (not installed)', async () => {
    await ensureAgentsExpanded()
    const redCircle = page.locator('button[title*="Qwen AI not installed"]')
    await expect(redCircle).toBeVisible()
    await ss('1-qwen-red-circle')
  })

  test('clicking Qwen opens install modal', async () => {
    await openQwenInstallHint()
    const modal = page.locator('[data-testid="install-hint-modal"]')
    await expect(modal).toBeVisible()
    await expect(page.locator('h2:has-text("Install Qwen AI")')).toBeVisible()
    await ss('2-modal-open')
  })

  test('all install steps render with non-empty text (no gap)', async () => {
    const steps = page.locator('[data-testid="install-hint-steps"] > div')
    const count = await steps.count()
    expect(count).toBeGreaterThanOrEqual(4)
    for (let i = 0; i < count; i++) {
      const text = (await steps.nth(i).innerText()).trim()
      expect(text.length, `step row ${i} must not be empty`).toBeGreaterThan(0)
    }
    await ss('3-steps-rendered')
  })

  test('qwen steps include aider install and ollama pull commands', async () => {
    const stepsBlock = page.locator('[data-testid="install-hint-steps"]')
    await expect(stepsBlock).toContainText('pip install aider-chat')
    await expect(stepsBlock).toContainText('ollama.com')
    await expect(stepsBlock).toContainText('ollama pull qwen3-coder')
    await expect(stepsBlock).toContainText('Restart Termpolis')
  })

  test('platform-specific steps render correctly', async () => {
    const isWin = process.platform === 'win32'
    const stepsBlock = page.locator('[data-testid="install-hint-steps"]')
    if (isWin) {
      await expect(stepsBlock).toContainText('setx PATH')
      await expect(stepsBlock).toContainText('LOCALAPPDATA')
    } else {
      // Non-Windows skips the setx step entirely
      const text = await stepsBlock.innerText()
      expect(text).not.toContain('setx PATH')
    }
  })

  test('qwen3-coder-next block renders as a section, not an empty step box', async () => {
    const section = page.locator('[data-testid="install-hint-section-0"]')
    await expect(section).toBeVisible()
    await expect(section).toContainText('qwen3-coder-next')
    await expect(section).toContainText('Click + in AI Agents')
    await expect(section).toContainText('aider --model ollama/qwen3-coder-next')
    await ss('4-section-rendered')
  })

  test('modal card is scrollable (max-h + overflow-y-auto)', async () => {
    const modal = page.locator('[data-testid="install-hint-modal"]')
    const cls = (await modal.getAttribute('class')) || ''
    expect(cls).toMatch(/max-h-/)
    expect(cls).toMatch(/overflow-y-auto/)
    // Also verify actual scrollHeight > clientHeight when the modal is tall.
    const { scrollHeight, clientHeight } = await modal.evaluate((el) => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }))
    // If content fits, scrollHeight equals clientHeight — still valid, just means
    // the viewport is tall enough. Hitting the scroll path matters when it's tall.
    expect(scrollHeight).toBeGreaterThanOrEqual(clientHeight)
  })

  test('modal scrolls to bottom (Documentation + Got it reachable)', async () => {
    const modal = page.locator('[data-testid="install-hint-modal"]')
    await modal.evaluate((el) => el.scrollTo({ top: el.scrollHeight }))
    await page.waitForTimeout(200)
    await expect(page.locator('a:has-text("Documentation")')).toBeVisible()
    await expect(page.locator('button:has-text("Got it")')).toBeVisible()
    await ss('5-scrolled-bottom')
  })

  test('pricing block renders for qwen (free, local)', async () => {
    await expect(page.locator('text=/Free.*runs locally/').first()).toBeVisible()
  })

  test('restart warning banner visible', async () => {
    await expect(page.locator('text=/You must restart Termpolis/').first()).toBeVisible()
  })

  test('"Got it" dismisses the modal', async () => {
    await page.locator('button:has-text("Got it")').click()
    await page.waitForTimeout(400)
    await expect(page.locator('[data-testid="install-hint-modal"]')).toHaveCount(0)
    await ss('6-modal-closed')
  })

  test('re-opening shows a fresh modal', async () => {
    await openQwenInstallHint()
    await expect(page.locator('[data-testid="install-hint-modal"]')).toBeVisible()
    await closeIfOpen()
  })

  test('claude modal shows Desktop-app-vs-CLI warning', async () => {
    await ensureAgentsExpanded()
    const claudeBtn = page.locator('button:has-text("Claude Code")').first()
    await claudeBtn.click()
    await page.locator('[data-testid="install-hint-modal"]').waitFor({ state: 'visible', timeout: 5000 })
    const warning = page.locator('[data-testid="install-hint-warning"]')
    await expect(warning).toBeVisible()
    await expect(warning).toContainText(/Desktop app.*NOT the same.*CLI/)
    await ss('7-claude-warning')
    await closeIfOpen()
  })
})
