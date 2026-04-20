/**
 * Documentation Screenshot Harness
 * --------------------------------
 * Drives every major UI state and writes a single screenshot per state to
 * e2e/screenshots/docs/. Mirrors the finished set into
 * ../termpolis-web/docs/screenshots/ so the website picks it up on next deploy.
 *
 * Design rules learned the hard way:
 *  - Never click TitleBar buttons (aria-label="Close" matches the app close).
 *  - Never press Escape when no modal is open — risks app confirm-close.
 *  - Every step waits for a visible signal that the target panel actually
 *    opened (or closed) before screenshotting, so we don't capture an
 *    unchanged frame.
 *  - If a state can't be opened for any reason, capture whatever is on screen
 *    but log and move on — later states shouldn't cascade-fail.
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
    await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false, timeout: 6000 })
    console.log(`[docs-ss] ${name} \u2713`)
  } catch (err) {
    const msg = (err as Error).message
    console.log(`[docs-ss] ${name} screenshot failed: ${msg}`)
    if (/closed|crashed/.test(msg)) appAlive = false
  }
}

async function safeWait(ms: number) {
  if (!appAlive) return
  try { await page.waitForTimeout(ms) } catch { appAlive = false }
}

async function clickIf(selector: string, timeout = 2000): Promise<boolean> {
  if (!appAlive) return false
  try {
    const el = page.locator(selector).first()
    await el.waitFor({ state: 'visible', timeout })
    await el.click({ timeout, force: false })
    return true
  } catch {
    return false
  }
}

async function forceClickIf(selector: string, timeout = 2000): Promise<boolean> {
  if (!appAlive) return false
  try {
    const el = page.locator(selector).first()
    await el.waitFor({ state: 'visible', timeout })
    await el.click({ timeout, force: true })
    return true
  } catch {
    return false
  }
}

async function pressIf(combo: string) {
  if (!appAlive) return
  try { await page.keyboard.press(combo, { timeout: 1000 }) } catch {}
}

async function waitForText(text: string, timeout = 3000): Promise<boolean> {
  if (!appAlive) return false
  try {
    await page.locator(`text=${text}`).first().waitFor({ state: 'visible', timeout })
    return true
  } catch {
    return false
  }
}

async function waitForHidden(selector: string, timeout = 3000): Promise<boolean> {
  if (!appAlive) return false
  try {
    await page.locator(selector).first().waitFor({ state: 'hidden', timeout })
    return true
  } catch {
    return false
  }
}

// Dismiss overlay modals by clicking the top-left pixel — outside the modal,
// safely inside the renderer viewport, not on any TitleBar button.
async function clickBackdrop() {
  if (!appAlive) return
  try { await page.mouse.click(4, 200) } catch {}
  await safeWait(350)
}

// Scroll the element matching the given text into view. Uses Playwright's
// built-in scrollIntoViewIfNeeded, which walks up to the real scroll ancestor.
async function scrollToText(text: string) {
  if (!appAlive) return
  try {
    await page.locator(`text=${text}`).first().scrollIntoViewIfNeeded({ timeout: 2000 })
  } catch {}
}

test.describe.configure({ retries: 0 })

test.beforeAll(async () => {
  fs.mkdirSync(OUT, { recursive: true })
  // Clean prior captures so duplicates don't stick around.
  try {
    for (const f of fs.readdirSync(OUT)) {
      if (f.endsWith('.png')) fs.unlinkSync(path.join(OUT, f))
    }
  } catch {}

  const { execSync } = await import('child_process')
  try { execSync('npx electron-vite build', { cwd: PROJECT_ROOT, stdio: 'pipe' }) }
  catch { execSync('npx electron-vite build', { cwd: PROJECT_ROOT, stdio: 'pipe' }) }

  const dirs = [
    path.join(os.homedir(), 'AppData', 'Roaming', 'termpolis'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'Electron'),
    path.join(os.homedir(), '.config', 'termpolis'),
    path.join(os.homedir(), 'Library', 'Application Support', 'termpolis'),
  ]
  const cleanSession = JSON.stringify({
    terminals: [], workspaces: [],
    defaultShell: process.platform === 'win32' ? 'powershell' : 'bash',
    viewMode: 'tabs',
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
      // pickDirectory() short-circuits to this path so Start Swarm works.
      TERMPOLIS_TEST_PROJECT_CWD: PROJECT_ROOT,
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
    const keep = new Set(files)
    for (const f of fs.readdirSync(WEB_OUT)) {
      if (f.endsWith('.png') && !keep.has(f)) {
        try { fs.unlinkSync(path.join(WEB_OUT, f)) } catch {}
      }
    }
    for (const f of files) fs.copyFileSync(path.join(OUT, f), path.join(WEB_OUT, f))
    console.log(`[docs-ss] mirrored ${files.length} files to termpolis-web/docs/screenshots`)
  } catch (err) {
    console.log('[docs-ss] mirror failed:', (err as Error).message)
  }
})

test('capture all docs screenshots', async () => {
  test.setTimeout(600000)
  await expect(page.locator('text=Termpolis').first()).toBeVisible({ timeout: 15000 })

  // 01 — Welcome screen, fresh app
  await safeWait(800)
  await ss('01-welcome-screen')

  // 02 — Sidebar default: open the Launch AI Agent dropdown to show the
  // agent picker state (visually distinct from the plain Welcome in 01).
  await clickIf('button:has(span:text-is("Launch AI Agent"))', 2000)
  await safeWait(500)
  await ss('02-sidebar-default')
  // Close picker by clicking in the dark header strip (x=700, y=50) —
  // below TitleBar, above Welcome content, well clear of sidebar items.
  try { await page.mouse.click(700, 50) } catch {}
  await safeWait(300)

  // 03 — New terminal modal — opened via the Welcome screen button.
  // Capture it in its default state (Dark theme selected).
  await clickIf('button:has(span:text-is("New Terminal"))', 3000)
  await waitForText('New Terminal', 2500)
  await safeWait(500)
  await ss('03-new-terminal-modal')

  // 08 — Themes picker: click a different theme pill so the selection
  // indicator and preview differ from 03.
  await clickIf('button:has-text("Dracula")', 1500)
  await safeWait(300)
  // Also change a color to further differentiate
  const colorSwatch = page.locator('button[aria-label="#F48FB1"]').first()
  if (await colorSwatch.isVisible().catch(() => false)) {
    await colorSwatch.click({ timeout: 1500 }).catch(() => {})
  }
  await safeWait(400)
  await ss('08-themes-picker')

  // Confirm — click Create in the modal. The Create button is visible inside
  // the AddTerminalModal; clicking it calls handleCreateTerminal which in turn
  // spawns a PTY and closes the modal.
  const createBtn = page.locator('button.bg-\\[\\#0078d4\\]:has-text("Create")').first()
  const visible = await createBtn.isVisible().catch(() => false)
  console.log(`[docs-ss] Create btn visible: ${visible}`)
  if (visible) {
    try {
      await createBtn.click({ timeout: 3000 })
      console.log('[docs-ss] Create clicked')
    } catch (e) {
      console.log(`[docs-ss] Create click failed: ${(e as Error).message}`)
    }
  }
  // Wait up to 5s for the modal h2 "New Terminal" to detach.
  const dismissed = await waitForHidden('h2:text-is("New Terminal")', 5000)
  console.log(`[docs-ss] modal dismissed: ${dismissed}`)
  if (!dismissed) {
    console.log('[docs-ss] retrying Create with force')
    await page.locator('button.bg-\\[\\#0078d4\\]:has-text("Create")').first()
      .click({ timeout: 2000, force: true }).catch(e => console.log(`[docs-ss] retry failed: ${e.message}`))
    await waitForHidden('h2:text-is("New Terminal")', 3000)
  }
  // Wait for the xterm canvas to appear so we capture a running terminal.
  await page.locator('.xterm').first().waitFor({ state: 'visible', timeout: 6000 }).catch(() => {})
  await safeWait(1500)
  await ss('04-terminal-running')

  // 05 — Multiple terminals: spawn a second one via the sidebar's
  // "+ Add Terminal" button (more reliable than a keyboard shortcut in test).
  await clickIf('button:has-text("Add Terminal")', 2000)
  await page.locator('h2:text-is("New Terminal")').first()
    .waitFor({ state: 'visible', timeout: 3000 }).catch(() => {})
  const create2 = page.locator('button.bg-\\[\\#0078d4\\]:has-text("Create")').first()
  if (await create2.isVisible().catch(() => false)) {
    await create2.click({ timeout: 3000 }).catch(() => {})
  }
  await waitForHidden('h2:text-is("New Terminal")', 5000)
  await safeWait(1400)
  await ss('05-tab-view-multiple')

  // 06 — Split view via sidebar toggle (title="Split View" or "Tab View")
  if (await clickIf('button[title="Split View"]', 2000)) {
    await safeWait(700)
  }
  await ss('06-split-view')
  // Revert so later shots look normal
  await clickIf('button[title="Tab View"]', 1500)
  await safeWait(300)

  // 07 — Settings panel (top — default shell + autocomplete visible)
  await clickIf('button[title="Settings"]', 2000)
  await waitForText('Settings', 2000)
  // Ensure we're at the top
  try {
    await page.evaluate(() => {
      const panes = document.querySelectorAll<HTMLElement>('.overflow-y-auto')
      panes.forEach(p => { p.scrollTop = 0 })
    })
  } catch {}
  await safeWait(500)
  await ss('07-settings-panel')

  // 09 — Keybindings section. Scroll the settings pane directly since the
  // scroll ancestor is a specific `overflow-y-auto` container inside a flex
  // column that Playwright's scrollIntoViewIfNeeded sometimes misses.
  await page.evaluate(() => {
    const label = Array.from(document.querySelectorAll<HTMLElement>('label'))
      .find(el => el.textContent?.trim() === 'Keyboard Shortcuts')
    if (label) {
      label.scrollIntoView({ block: 'start', behavior: 'instant' as ScrollBehavior })
    }
  }).catch(() => {})
  await safeWait(600)
  await ss('09-keybindings')

  // 10 — Agent Capability Ratings section
  await page.evaluate(() => {
    const h3 = Array.from(document.querySelectorAll<HTMLElement>('h3'))
      .find(el => el.textContent?.trim() === 'Agent Capability Ratings')
    if (h3) {
      h3.scrollIntoView({ block: 'start', behavior: 'instant' as ScrollBehavior })
    }
  }).catch(() => {})
  await safeWait(600)
  await ss('10-agent-capability-ratings')

  // Close Settings
  await clickIf('button[title="Settings"]', 1500)
  await safeWait(400)

  // 11 — Command palette. App listens for `e.key === 'k'` (lowercase); Playwright
  // would send 'K' for 'Control+K', so pass the key lowercase explicitly.
  await pressIf('Control+k')
  await page.locator('input[placeholder="Type a command..."]').first()
    .waitFor({ state: 'visible', timeout: 2000 }).catch(() => {})
  await safeWait(400)
  await ss('11-command-palette')

  // 11b — Filter the palette
  try { await page.keyboard.type('launch', { delay: 40 }) } catch {}
  await safeWait(400)
  await ss('11b-command-palette-filtered')
  await pressIf('Escape')
  await waitForHidden('input[placeholder="Type a command..."]', 2000)
  await safeWait(300)

  // 12 — Prompt templates
  await pressIf('Control+Shift+P')
  await waitForText('Prompt Templates', 2000)
  await safeWait(400)
  await ss('12-prompt-templates')
  await pressIf('Escape')
  await waitForHidden('text=Prompt Templates', 2000)
  await safeWait(300)

  // 13 — Workflow templates. Sidebar "Workflows" button only *opens*; there's
  // no Escape handler either, so close by clicking the backdrop at a coordinate
  // that sits to the right of the sidebar and to the left of the centered modal.
  await clickIf('button[title="Workflows"]', 2000)
  await page.locator('h2:text-is("Workflow Templates")').first()
    .waitFor({ state: 'visible', timeout: 2000 }).catch(() => {})
  await safeWait(500)
  await ss('13-workflow-templates')
  try { await page.mouse.click(350, 400) } catch {}
  await waitForHidden('h2:text-is("Workflow Templates")', 2000)
  await safeWait(300)

  // 14 — Context panel (right-hand file tree)
  await pressIf('Control+Shift+E')
  await safeWait(700)
  await ss('14-context-panel')
  await pressIf('Control+Shift+E')
  await safeWait(300)

  // 15 — History search
  await pressIf('Control+Shift+H')
  await safeWait(600)
  await ss('15-history-search')
  await pressIf('Escape')
  await safeWait(300)

  // 16 — Conversation search
  await pressIf('Control+Shift+I')
  await safeWait(600)
  await ss('16-conversation-search')
  await pressIf('Escape')
  await safeWait(300)

  // 17 — Git panel. Same story as Workflows — sidebar button only opens; close
  // via Escape (GitPanel has its own Escape handler).
  await clickIf('button[title="Git Panel"]', 2000)
  await safeWait(800)
  await ss('17-git-panel')
  await pressIf('Escape')
  await safeWait(300)

  // 18 — Swarm Dashboard with "Clear Swarm" confirmation modal open. This gives
  // a visually distinct first dashboard capture (showing a documentable
  // feature — stopping a swarm) before we switch tabs.
  await pressIf('Control+Shift+S')
  await page.locator('h2:text-is("Swarm Dashboard")').first()
    .waitFor({ state: 'visible', timeout: 4000 }).catch(() => {})
  await safeWait(400)
  await clickIf('button[title="Clear all messages and tasks"]', 2000)
  await page.locator('h3:text-is("Clear Swarm")').first()
    .waitFor({ state: 'visible', timeout: 2000 }).catch(() => {})
  await safeWait(500)
  await ss('18-swarm-dashboard')

  // Dismiss the Clear Swarm confirmation, then capture the plain Tasks tab
  await clickIf('div:has(h3:text-is("Clear Swarm")) >> button:has-text("Cancel")', 1500)
  await waitForHidden('h3:text-is("Clear Swarm")', 2000)
  await safeWait(300)

  // 19 — Tasks tab active (plain dashboard with no modal overlay)
  await clickIf('button:has-text("Messages")', 1500)
  await safeWait(300)
  await clickIf('button:has-text("Tasks")', 1500)
  await safeWait(500)
  try { await page.mouse.move(600, 600) } catch {}
  await safeWait(200)
  await ss('19-swarm-tasks-tab')

  // 20 — Messages tab
  await clickIf('button:has-text("Messages")', 1500)
  await safeWait(500)
  await ss('20-swarm-messages-tab')

  // 21 — Trace tab
  await clickIf('button:has-text("Trace")', 1500)
  await safeWait(500)
  await ss('21-swarm-trace-tab')

  // 22 — Start Swarm wizard. Back on Tasks tab first, then click the
  // dashboard's own Start Swarm button. pickDirectory() returns the
  // TERMPOLIS_TEST_PROJECT_CWD path, which opens the wizard overlay.
  await clickIf('button:has-text("Tasks")', 1500)
  await safeWait(300)
  await clickIf('button:has-text("Start Swarm")', 2500)
  // Wait for the wizard header, then wait long enough for prepare() to
  // progress to the describe step (the form with Goal, Constraints, etc.)
  await page.locator('h2:text-is("Start Swarm")').first()
    .waitFor({ state: 'visible', timeout: 5000 }).catch(() => {})
  // Prefer to screenshot the describe step, but fall back to preparing.
  const described = await waitForText('Describe what you want built', 10000)
  await safeWait(described ? 600 : 1200)
  await ss('22-start-swarm-wizard')

  // Close wizard via Escape (stopConductor happens async in the background
  // after this, but nothing downstream needs the IPC channel except the
  // app's own shutdown).
  if (await page.locator('h2:text-is("Start Swarm")').first().isVisible().catch(() => false)) {
    await pressIf('Escape')
    await waitForHidden('h2:text-is("Start Swarm")', 3000)
  }
  await safeWait(500)

  // Close the dashboard too
  if (await page.locator('h2:text-is("Swarm Dashboard")').first().isVisible().catch(() => false)) {
    await pressIf('Escape')
    await waitForHidden('h2:text-is("Swarm Dashboard")', 3000)
  }
  await safeWait(500)

  // 23 — Activity feed (Ctrl+Shift+A per App.tsx registration)
  await pressIf('Control+Shift+A')
  await safeWait(800)
  await ss('23-activity-feed')
  await pressIf('Control+Shift+A')
  await safeWait(300)

  // 24 — Status bar: hover over the bottom strip to show its tooltip/highlight,
  // making it visually distinct from the plain terminal view in 25.
  await clickIf('.xterm', 1500)
  await safeWait(300)
  try {
    const viewport = page.viewportSize()
    if (viewport) {
      await page.mouse.move(viewport.width / 2, viewport.height - 12)
    }
  } catch {}
  await safeWait(500)
  await ss('24-status-bar')

  // 25 — Final state: collapse the sidebar via Ctrl+B (if bound) for a
  // clean zoomed-out terminal frame that differs from 24's status-bar hover.
  try { await page.mouse.move(400, 400) } catch {}
  await pressIf('Control+B')
  await safeWait(500)
  await ss('25-final-state')
  // Restore sidebar for cleanup
  await pressIf('Control+B')
  await safeWait(200)
})
