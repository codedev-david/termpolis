/**
 * Documentation Screenshot Harness
 * --------------------------------
 * Drives every major UI state and writes a single screenshot per state to
 * e2e/screenshots/docs/. Mirrors the finished set into
 * ../termpolis-web/docs/screenshots/ so the website picks it up on next deploy.
 *
 * Design rules learned the hard way:
 *  - Never click TitleBar buttons (aria-label="Close" matches the app close).
 *  - Never press Escape when no modal is open â€” risks app confirm-close.
 *  - Every step waits for a visible signal that the target panel actually
 *    opened (or closed) before screenshotting, so we don't capture an
 *    unchanged frame.
 *  - If a state can't be opened for any reason, capture whatever is on screen
 *    but log and move on â€” later states shouldn't cascade-fail.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { _electron as electron } from 'playwright'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { e2eLaunchArgs } from './helpers/launch'

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

// Dismiss overlay modals by clicking the top-left pixel â€” outside the modal,
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

// Reliably close ANY open modal. All app modals render a full-screen
// `div.fixed.inset-0` backdrop whose onClick calls onClose â€” so clicking the
// backdrop element itself dismisses them (Escape is unreliable: some modals
// have no Escape handler, and one modal's text â€” e.g. "Prompt Templates" â€” also
// lives in the StatusBar, breaking text-based waitForHidden). Loops to peel off
// nested modals (wizard-over-dashboard), with an Escape fallback per pass.
async function closeModals() {
  if (!appAlive) return
  for (let i = 0; i < 6; i++) {
    await pressIf('Escape') // closes Escape-aware modals (PromptTemplates, SwarmDashboard)
    await safeWait(120)
    const done = await page.evaluate(() => {
      // NOTE: position:fixed elements always have offsetParent === null, so we
      // measure visibility with getBoundingClientRect, not offsetParent.
      const vis = (el: Element) => { const r = el.getBoundingClientRect(); return r.width > 20 && r.height > 20 }
      const overlays = Array.from(document.querySelectorAll<HTMLElement>('div.fixed.inset-0')).filter(vis)
      // The Quick Start Guide / Help modal has NO backdrop-onClose and ignores
      // Escape â€” close it via its visible "Close"/"Skip tour" button. Matching
      // button TEXT is safe; the TitleBar app-close uses an aria-label, not text.
      const textClose = Array.from(document.querySelectorAll<HTMLElement>('button')).filter(vis)
        .find(b => { const t = (b.textContent || '').trim(); return t === 'Close' || t === 'Skip tour' })
      if (overlays.length === 0 && !textClose) return true
      const top = overlays[overlays.length - 1]
      const aria = top && top.querySelector<HTMLElement>('button[aria-label*="lose"], button[aria-label*="workflows"]')
      if (aria) aria.click()
      else if (textClose) textClose.click()
      else if (top) top.click() // backdrop-click â†’ onClose
      return false
    }).catch(() => true)
    await safeWait(250)
    if (done) break
  }
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
    args: e2eLaunchArgs('docs-screenshots'),
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

  // 01 â€” Welcome screen, fresh app (capture BEFORE dismissing onboarding so
  // screenshot 01 shows the Welcome-to-Termpolis dialog as new users see it).
  await safeWait(800)
  await ss('01-welcome-screen')

  // Dismiss the onboarding modal so it doesn't overlay every subsequent
  // capture. The 4-step tour starts on step 1, so "Skip tour" (always
  // visible) is the right control. ("Get started" only appears on step 4.)
  // If the modal isn't visible (e.g. already acknowledged on a previous
  // run) the clickIf returns false and we move on.
  const onboardingDismissed = await clickIf('button:has-text("Skip tour")', 3000)
  if (onboardingDismissed) {
    await waitForHidden('h2:text-is("Welcome to Termpolis")', 3000)
    await safeWait(400)
  }

  // 02 â€” Sidebar default: open the Launch AI Agent dropdown to show the
  // agent picker state (visually distinct from the plain Welcome in 01).
  await clickIf('button:has(span:text-is("Launch AI Agent"))', 2000)
  await safeWait(500)
  await ss('02-sidebar-default')
  // Close picker by clicking in the dark header strip (x=700, y=50) â€”
  // below TitleBar, above Welcome content, well clear of sidebar items.
  try { await page.mouse.click(700, 50) } catch {}
  await safeWait(300)

  // 03 â€” New terminal modal â€” opened via the Welcome screen button.
  // Capture it in its default state (Dark theme selected).
  await clickIf('button:has(span:text-is("New Terminal"))', 3000)
  await waitForText('New Terminal', 2500)
  await safeWait(500)
  await ss('03-new-terminal-modal')

  // 08 â€” Themes picker: click a different theme pill so the selection
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

  // Confirm â€” click Create in the modal. The Create button is visible inside
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

  // 05 â€” Multiple terminals: spawn a second one via the sidebar's
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

  // 06 â€” Split view via sidebar toggle. Confirm the toggle actually applied by
  // waiting for the button title to flip to "Tab View" before capturing.
  await clickIf('button[title="Split View"]', 2500)
  await page.locator('button[title="Tab View"]').first()
    .waitFor({ state: 'visible', timeout: 2500 }).catch(() => {})
  await safeWait(800)
  await ss('06-split-view')
  // Revert so later shots look normal
  await clickIf('button[title="Tab View"]', 1500)
  await safeWait(300)

  // 07 â€” Settings panel (top â€” default shell + autocomplete visible)
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

  // 09 â€” Keybindings TAB. Settings is now tabbed (settings-tab-*), so switch
  // tabs by click; scrolling to the section does nothing (it's a different tab).
  await clickIf('[data-testid="settings-tab-keybindings"]', 2500)
  await waitForText('Keyboard Shortcuts', 2500)
  await safeWait(400)
  await ss('09-keybindings')

  // 10 â€” Agent Ratings TAB
  await clickIf('[data-testid="settings-tab-agents"]', 2500)
  await waitForText('Agent Capability Ratings', 2500)
  await safeWait(400)
  await ss('10-agent-capability-ratings')

  // Close Settings
  await clickIf('button[title="Settings"]', 1500)
  await safeWait(400)

  // 11 â€” Command palette. App listens for `e.key === 'k'` (lowercase); Playwright
  // would send 'K' for 'Control+K', so pass the key lowercase explicitly.
  await pressIf('Control+k')
  await page.locator('input[placeholder="Type a command..."]').first()
    .waitFor({ state: 'visible', timeout: 2000 }).catch(() => {})
  await safeWait(400)
  await ss('11-command-palette')

  // 11b â€” Filter the palette
  try { await page.keyboard.type('launch', { delay: 40 }) } catch {}
  await safeWait(400)
  await ss('11b-command-palette-filtered')
  await pressIf('Escape')
  await waitForHidden('input[placeholder="Type a command..."]', 2000)
  await safeWait(300)

  // 12 â€” Prompt templates (Ctrl+Shift+P). Scope the wait to the modal H2 â€” the
  // StatusBar also renders the text "Prompt Templates", which broke text waits.
  await pressIf('Control+Shift+P')
  await page.locator('h2:text-is("Prompt Templates")').first()
    .waitFor({ state: 'visible', timeout: 2500 }).catch(() => {})
  await safeWait(400)
  await ss('12-prompt-templates')
  await closeModals() // must fully close, or it blocks the Workflows button (13/13b)

  // 13 â€” Workflow designer (the New Workflow overlay opens from the permanent
  // Workflows sidebar section; the old toolbar icon + templates modal are gone).
  await clickIf('button[title="Start Workflow"]', 2500)
  await page.locator('[role="dialog"][aria-label="Workflow"]')
    .waitFor({ state: 'visible', timeout: 3000 }).catch(() => {})
  await safeWait(500)
  await ss('13-workflow-templates')

  // 13b â€” Create-workflow form (the Design tab where steps are authored)
  await clickIf('button[aria-label="Design tab"]', 1500)
  await safeWait(500)
  await ss('13b-workflow-create')
  await clickIf('button[aria-label="Close workflow"]', 1500)
  await safeWait(300)
  await closeModals()

  // 14 â€” Context panel (right-hand file tree)
  await pressIf('Control+Shift+E')
  await safeWait(700)
  await ss('14-context-panel')
  await pressIf('Control+Shift+E')
  await safeWait(300)

  // 15 â€” History search
  await pressIf('Control+Shift+H')
  await safeWait(600)
  await ss('15-history-search')
  await pressIf('Escape')
  await safeWait(300)

  // 16 â€” Conversation search
  await pressIf('Control+Shift+I')
  await safeWait(600)
  await ss('16-conversation-search')
  await pressIf('Escape')
  await safeWait(300)

  // 17 â€” Git panel. Same story as Workflows â€” sidebar button only opens; close
  // via Escape (GitPanel has its own Escape handler).
  await clickIf('button[title="Git Panel"]', 2000)
  await safeWait(800)
  await ss('17-git-panel')
  await pressIf('Escape')
  await safeWait(300)

  // 18 â€” Swarm Dashboard with "Clear Swarm" confirmation modal open. This gives
  // a visually distinct first dashboard capture (showing a documentable
  // feature â€” stopping a swarm) before we switch tabs.
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

  // 19 â€” Tasks tab active (plain dashboard with no modal overlay)
  await clickIf('button:has-text("Messages")', 1500)
  await safeWait(300)
  await clickIf('button:has-text("Tasks")', 1500)
  await safeWait(500)
  try { await page.mouse.move(600, 600) } catch {}
  await safeWait(200)
  await ss('19-swarm-tasks-tab')

  // 20 â€” Messages tab
  await clickIf('button:has-text("Messages")', 1500)
  await safeWait(500)
  await ss('20-swarm-messages-tab')

  // 21 â€” Trace tab
  await clickIf('button:has-text("Trace")', 1500)
  await safeWait(500)
  await ss('21-swarm-trace-tab')

  // 22 â€” Start Swarm wizard. Back on Tasks tab first, then click the
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

  // Close the wizard AND the dashboard reliably. Escape is gated while the
  // wizard shows, and the dashboard only closes via its X / backdrop â€” so peel
  // both off with closeModals() (it loops for nested modals). This was the cause
  // of the 28â€“31 cascade: a lingering dashboard blocked the Settings panel.
  await closeModals()
  await waitForHidden('h2:text-is("Swarm Dashboard")', 3000)
  await safeWait(500)

  // 23 â€” Activity feed (Ctrl+Shift+A per App.tsx registration)
  await pressIf('Control+Shift+A')
  await safeWait(800)
  await ss('23-activity-feed')
  await pressIf('Control+Shift+A')
  await safeWait(300)

  // 24 â€” Status bar: a full-window shot is indistinguishable from the plain tab
  // view (05), so CLIP to the bottom strip â€” that's what the caption describes.
  await clickIf('.xterm', 1500)
  await safeWait(300)
  try {
    const vp = page.viewportSize()
    if (vp) {
      await page.mouse.move(vp.width / 2, vp.height - 12)
      await safeWait(400)
      await page.screenshot({ path: path.join(OUT, '24-status-bar.png'), clip: { x: 0, y: vp.height - 32, width: vp.width, height: 32 }, timeout: 6000 })
      console.log('[docs-ss] 24-status-bar (clipped) âœ“')
    } else {
      await ss('24-status-bar')
    }
  } catch { await ss('24-status-bar') }

  // 25 â€” Final state: collapse the sidebar via Ctrl+B (if bound) for a
  // clean zoomed-out terminal frame that differs from 24's status-bar hover.
  try { await page.mouse.move(400, 400) } catch {}
  await pressIf('Control+B')
  await safeWait(500)
  await ss('25-final-state')
  // Restore sidebar for cleanup
  await pressIf('Control+B')
  await safeWait(200)

  // ---------------------------------------------------------------------
  // v1.11.43+ additions â€” Help / Past Sessions / AI Security Center /
  // Live Observability panels. These shots back the new sections in
  // termpolis-web/docs.html so the marketing site stops being two months
  // out of date.
  // ---------------------------------------------------------------------

  // 26 â€” Help modal opens via the StatusBar "Help / Support" button (the
  // Ctrl+/ shortcut routes to Settingsâ†’Keybindings instead). Click that
  // button and screenshot the modal showing keyboard-shortcuts + Show-tour-again
  // affordance + observability + security sections.
  await clickIf('button:has-text("Help / Support")', 3000)
  await safeWait(800)
  await ss('26-help-modal')
  // Scroll the Help modal body down so this second shot differs from 26 and
  // reveals the lower sections (Security / Observability). Scroll every scroll
  // container that's actually scrollable â€” the help modal's body is the only
  // one open at this point.
  await page.evaluate(() => {
    document.querySelectorAll<HTMLElement>('.overflow-y-auto').forEach(p => {
      if (p.scrollHeight > p.clientHeight) p.scrollTop = Math.round(p.scrollHeight * 0.55)
    })
  }).catch(() => {})
  await safeWait(500)
  await ss('27-help-security-section')
  await pressIf('Escape')
  await safeWait(400)

  // 28 â€” AI Security Center (Settings â†’ AI Security TAB, top of panel).
  await closeModals()
  await clickIf('button[title="Settings"]', 2500)
  await page.locator('[data-testid="settings-tabs"]').first()
    .waitFor({ state: 'visible', timeout: 3000 }).catch(() => {})
  await clickIf('[data-testid="settings-tab-security"]', 2500)
  await page.locator('[data-testid="security-watchers"]').first()
    .waitFor({ state: 'visible', timeout: 3000 }).catch(() => {})
  await safeWait(400)
  {
    // Reset scroll to top of the security panel
    await page.evaluate(() => {
      const panes = document.querySelectorAll<HTMLElement>('.overflow-y-auto')
      panes.forEach(p => { p.scrollTop = 0 })
    }).catch(() => {})
    await safeWait(300)
    await ss('28-security-center-top')

    // 29 â€” Background watchers card (sensitive-file + per-agent egress).
    await page.evaluate(() => {
      const card = document.querySelector<HTMLElement>('[data-testid="security-watchers"]')
      if (card) card.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior })
    }).catch(() => {})
    await safeWait(400)
    await ss('29-security-watchers')

    // 30 â€” Manual pre-paste scanner with a hit. Paste a fake-shape AWS key
    // (a-repeat fails entropy heuristic locally, but the panel scan accepts
    // any input and runs the regex set in main; we want a positive hit.)
    await page.evaluate(() => {
      const ta = document.querySelector<HTMLTextAreaElement>('textarea[placeholder*="Paste the prompt"]')
      if (ta) {
        // Synthesize a value + dispatch React-friendly input event.
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
        setter?.call(ta, 'AKIAIOSFODNN7EXAMPLE\nghp_' + 'a'.repeat(36))
        ta.dispatchEvent(new Event('input', { bubbles: true }))
      }
    }).catch(() => {})
    await safeWait(300)
    await clickIf('[data-testid="security-scan-btn"]', 1500)
    await safeWait(500)
    // Scroll to the result list / Copy redacted button so the hits show.
    await page.evaluate(() => {
      const btn = document.querySelector<HTMLElement>('[data-testid="security-scan-btn"]')
      if (btn) btn.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior })
    }).catch(() => {})
    await safeWait(300)
    await ss('30-security-scanner-hit')
  }
  // Close Settings
  await clickIf('button[title="Settings"]', 1500)
  await safeWait(400)

  // 31 â€” Past AI Sessions browser (button lives inside the terminal pane).
  await clickIf('[data-testid="past-ai-sessions-btn"]', 2500)
  await safeWait(900)
  await ss('31-past-ai-sessions')
  await pressIf('Escape')
  await safeWait(300)

  // 32 â€” Live observability: Context Pins (Ctrl+Shift+B per Help modal).
  await pressIf('Control+Shift+B')
  await safeWait(700)
  await ss('32-context-pins')
  await pressIf('Control+Shift+B')
  await safeWait(300)

  // 33 â€” Live observability: Redundancy (Ctrl+Shift+D).
  await pressIf('Control+Shift+D')
  await safeWait(700)
  await ss('33-redundancy')
  await pressIf('Control+Shift+D')
  await safeWait(300)

  // 34 â€” Live observability: Efficiency (Ctrl+Shift+Y).
  await pressIf('Control+Shift+Y')
  await safeWait(700)
  await ss('34-efficiency')
  await pressIf('Control+Shift+Y')
  await safeWait(300)
})
