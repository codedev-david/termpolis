/**
 * Documentation Screenshot Harness
 * --------------------------------
 * Runs the app and captures labeled screenshots of every major feature in a
 * single test so that one flaky interaction can't cascade. Output lands in
 * e2e/screenshots/docs/ and is mirrored into ../termpolis-web/docs/screenshots/
 * after the run. Never uses Escape and never clicks the TitleBar close (these
 * can terminate the Electron window mid-run).
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { _electron as electron } from 'playwright'
import path from 'path'
import fs from 'fs'
import os from 'os'

const PROJECT_ROOT = path.resolve('.')
const OUT = path.join(PROJECT_ROOT, 'e2e', 'screenshots', 'docs')
const WEB_OUT = path.join(PROJECT_ROOT, '..', 'termpolis-web', 'docs', 'screenshots')

let app: ElectronApplication
let page: Page
let appAlive = true

async function ss(name: string): Promise<void> {
  if (!appAlive) return
  try {
    await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false, timeout: 5000 })
    console.log(`[docs-ss] ${name} ✓`)
  } catch (err) {
    const msg = (err as Error).message
    console.log(`[docs-ss] ${name} screenshot failed: ${msg}`)
    if (/closed|crashed/.test(msg)) appAlive = false
  }
}

async function step(name: string, fn: () => Promise<void>) {
  if (!appAlive) return
  try {
    await fn()
    await safeWait(300)
  } catch (err) {
    console.log(`[docs-ss] ${name} setup failed: ${(err as Error).message}`)
  }
  await ss(name)
}

async function safeWait(ms: number) {
  if (!appAlive) return
  try { await page.waitForTimeout(ms) } catch { appAlive = false }
}

async function click(selector: string, timeout = 1500): Promise<boolean> {
  if (!appAlive) return false
  try {
    const el = page.locator(selector).first()
    await el.waitFor({ state: 'visible', timeout })
    await el.click({ timeout })
    return true
  } catch {
    return false
  }
}

async function pressIf(combo: string) {
  if (!appAlive) return
  try { await page.keyboard.press(combo, { timeout: 1000 }) } catch { /* ignore */ }
}

async function clickBackdrop() {
  // Dismiss overlay modals by clicking the top-left pixel outside the modal.
  // Avoids Escape (can trigger confirm-close) and the titlebar close button.
  if (!appAlive) return
  try { await page.mouse.click(2, 100) } catch {}
  await safeWait(300)
}

test.describe.configure({ retries: 0 })

test.beforeAll(async () => {
  fs.mkdirSync(OUT, { recursive: true })

  const { execSync } = await import('child_process')
  try {
    execSync('npx electron-vite build', { cwd: PROJECT_ROOT, stdio: 'pipe' })
  } catch {
    execSync('npx electron-vite build', { cwd: PROJECT_ROOT, stdio: 'pipe' })
  }

  const dirs = [
    path.join(os.homedir(), 'AppData', 'Roaming', 'termpolis'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'Electron'),
    path.join(os.homedir(), '.config', 'termpolis'),
    path.join(os.homedir(), 'Library', 'Application Support', 'termpolis'),
  ]
  const cleanSession = JSON.stringify({
    terminals: [], workspaces: [], defaultShell: process.platform === 'win32' ? 'powershell' : 'bash', viewMode: 'tabs',
  })
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue
    try { fs.writeFileSync(path.join(dir, 'session.json'), cleanSession) } catch {}
    try { fs.unlinkSync(path.join(dir, 'lockfile')) } catch {}
  }

  app = await electron.launch({
    args: [path.resolve('out/main/index.js')],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      TERMPOLIS_TEST_AGENTS: '1',
    },
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  page.on('close', () => { appAlive = false })
  await page.waitForTimeout(2500)
})

test.afterAll(async () => {
  try { if (app) await app.close() } catch {}
  try {
    fs.mkdirSync(WEB_OUT, { recursive: true })
    const files = fs.readdirSync(OUT).filter(f => f.endsWith('.png'))
    for (const f of files) fs.copyFileSync(path.join(OUT, f), path.join(WEB_OUT, f))
    console.log(`[docs-ss] mirrored ${files.length} files to termpolis-web/docs/screenshots`)
  } catch (err) {
    console.log('[docs-ss] mirror failed:', (err as Error).message)
  }
})

test('capture all docs screenshots', async () => {
  test.setTimeout(600000)
  await expect(page.locator('text=Termpolis').first()).toBeVisible({ timeout: 15000 })

  // 01 — Welcome screen (fresh app)
  await step('01-welcome-screen', async () => { await safeWait(600) })

  // 02 — Sidebar in default state
  await step('02-sidebar-default', async () => { await safeWait(200) })

  // 03 — New terminal modal
  await step('03-new-terminal-modal', async () => {
    await pressIf('Control+T')
    await safeWait(500)
  })
  await clickBackdrop()

  // 04 — Create first terminal
  await step('04-terminal-running', async () => {
    const clicked =
      (await click('button:has-text("PowerShell")')) ||
      (await click('button:has-text("Bash")')) ||
      (await click('button[title*="Launch"]'))
    if (clicked) await safeWait(1500)
  })

  // 05 — Tab view with multiple terminals
  await step('05-tab-view-multiple', async () => {
    const clicked =
      (await click('button:has-text("PowerShell")')) ||
      (await click('button:has-text("Bash")')) ||
      (await click('button[title*="Launch"]'))
    if (clicked) await safeWait(1200)
  })

  // 06 — Split view
  await step('06-split-view', async () => {
    await click('button[title="Split View"]')
    await safeWait(700)
  })
  await click('button[title="Tab View"]')
  await safeWait(300)

  // 07 — Settings panel
  await step('07-settings-panel', async () => {
    await click('button[title="Settings"]')
    await safeWait(700)
  })

  // 08 — Themes section
  await step('08-themes-picker', async () => {
    await click('button:has-text("Themes"), button:has-text("Theme")')
    await safeWait(400)
  })

  // 09 — Keybindings
  await step('09-keybindings', async () => {
    await click('button:has-text("Keybindings"), button:has-text("Keybinding")')
    await safeWait(400)
  })

  // 10 — Agent capability ratings
  await step('10-agent-capability-ratings', async () => {
    await click('button:has-text("Agent Capability"), button:has-text("Capabilities"), button:has-text("Agents")')
    await safeWait(400)
  })

  // Close settings by clicking the Settings button again (toggle)
  await click('button[title="Settings"]')
  await safeWait(400)

  // 11 — Command palette
  await step('11-command-palette', async () => {
    await pressIf('Control+K')
    await safeWait(600)
  })

  // 11b — Filtered command palette
  await step('11b-command-palette-filtered', async () => {
    try { await page.keyboard.type('launch', { delay: 30 }) } catch {}
    await safeWait(400)
  })
  await clickBackdrop()

  // 12 — Prompt templates
  await step('12-prompt-templates', async () => {
    await pressIf('Control+Shift+P')
    await safeWait(600)
  })
  await clickBackdrop()

  // 13 — Workflow templates
  await step('13-workflow-templates', async () => {
    await click('button[title="Workflows"]')
    await safeWait(600)
  })
  await click('button[title="Workflows"]')
  await safeWait(300)

  // 14 — Context panel
  await step('14-context-panel', async () => {
    await pressIf('Control+Shift+E')
    await safeWait(700)
  })
  await pressIf('Control+Shift+E')
  await safeWait(300)

  // 15 — History search
  await step('15-history-search', async () => {
    await pressIf('Control+Shift+H')
    await safeWait(500)
  })
  await clickBackdrop()

  // 16 — Conversation search
  await step('16-conversation-search', async () => {
    await pressIf('Control+Shift+I')
    await safeWait(500)
  })
  await clickBackdrop()

  // 17 — Git panel
  await step('17-git-panel', async () => {
    await click('button[title="Git Panel"]')
    await safeWait(700)
  })
  await click('button[title="Git Panel"]')
  await safeWait(300)

  // 18 — Swarm Dashboard
  await step('18-swarm-dashboard', async () => {
    await pressIf('Control+Shift+S')
    await safeWait(900)
  })

  // 19 — Agents tab
  await step('19-swarm-agents-tab', async () => {
    await click('button:has-text("Agents")')
    await safeWait(400)
  })

  // 20 — Tasks tab
  await step('20-swarm-tasks-tab', async () => {
    await click('button:has-text("Tasks")')
    await safeWait(400)
  })

  // 21 — Messages tab
  await step('21-swarm-messages-tab', async () => {
    await click('button:has-text("Messages")')
    await safeWait(400)
  })

  // 22 — Start Swarm wizard
  await step('22-start-swarm-wizard', async () => {
    await click('button:has-text("Start Swarm"), button:has-text("Start a Swarm")')
    await safeWait(900)
  })

  // Close wizard + dashboard by toggling swarm hotkey
  await pressIf('Control+Shift+S')
  await safeWait(300)
  await pressIf('Control+Shift+S')
  await safeWait(300)

  // 23 — Activity feed
  await step('23-activity-feed', async () => {
    const activityBtn = page.locator('button[title*="Activity"]').first()
    if (await activityBtn.isVisible({ timeout: 500 }).catch(() => false)) {
      await activityBtn.click().catch(() => {})
    }
    await safeWait(500)
  })

  // 24 — Status bar
  await step('24-status-bar', async () => { await safeWait(200) })

  // 25 — Final state
  await step('25-final-state', async () => { await safeWait(200) })
})
