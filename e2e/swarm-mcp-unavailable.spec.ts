/**
 * Swarm MCP-Unavailable — End-to-End Regression Guard
 * ---------------------------------------------------
 * Simulates the v1.11.5 production failure: Claude Code's MCP registration
 * has silently failed (because ~/.mcp.json points at a missing adapter file),
 * so the conductor answers the prompt directly instead of orchestrating the
 * swarm. Real Claude Code emitted the exact phrase
 *
 *   "Note: swarm MCP tools weren't available in this session, so I built it
 *    directly rather than orchestrating multiple agents."
 *
 * Before the fix, Termpolis had NO idea this happened. The swarm UI just
 * sat in the "running" state forever, and a confused user clicked Debug
 * to discover the bypass.
 *
 * This test sets MOCK_CLAUDE_BYPASS_MCP=1, which makes e2e/mocks/mock-claude.cjs
 * print the exact bypass message and exit. The renderer's conductor
 * monitoring loop (src/renderer/src/lib/conductorManager.ts) MUST:
 *   1. Detect the bypass text in the conductor terminal buffer
 *   2. Set a swarm notification with a "MCP tools unavailable — restart"
 *      message (so the user sees something, not a forever-spinner)
 *   3. Mark the swarm inactive (so the UI exits the "running" state)
 *
 * If ANY of those steps regress, this test fails.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { _electron as electron } from 'playwright'
import path from 'path'
import fs from 'fs'
import os from 'os'

let app: ElectronApplication
let page: Page

const PROJECT_ROOT = path.resolve('.')
const SHIM_DIR = path.join(PROJECT_ROOT, 'e2e', 'test-shims')
const SCREENSHOTS = 'e2e/screenshots/swarm-mcp-unavailable'

function userDataDir(): string {
  if (process.platform === 'win32') return path.join(os.homedir(), 'AppData', 'Roaming', 'termpolis')
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'termpolis')
  return path.join(os.homedir(), '.config', 'termpolis')
}

test.beforeAll(async () => {
  if (fs.existsSync(SCREENSHOTS)) fs.rmSync(SCREENSHOTS, { recursive: true })
  fs.mkdirSync(SCREENSHOTS, { recursive: true })

  try { fs.chmodSync(path.join(SHIM_DIR, 'claude'), 0o755) } catch {}

  const { execSync } = await import('child_process')
  try {
    execSync('npx electron-vite build', { cwd: PROJECT_ROOT, stdio: 'pipe' })
  } catch {
    execSync('npx electron-vite build', { cwd: PROJECT_ROOT, stdio: 'pipe' })
  }

  const candidates = [
    path.join(os.homedir(), 'AppData', 'Roaming', 'termpolis'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'Electron'),
    path.join(os.homedir(), '.config', 'termpolis'),
    path.join(os.homedir(), 'Library', 'Application Support', 'termpolis'),
  ]
  const cleanSession = JSON.stringify({
    terminals: [], workspaces: [], defaultShell: process.platform === 'win32' ? 'powershell' : 'bash', viewMode: 'tabs',
  })
  for (const dir of candidates) {
    if (!fs.existsSync(dir)) continue
    try { fs.writeFileSync(path.join(dir, 'session.json'), cleanSession) } catch {}
    try {
      const lockfile = path.join(dir, 'lockfile')
      if (fs.existsSync(lockfile)) fs.unlinkSync(lockfile)
    } catch {}
  }

  app = await electron.launch({
    args: [path.resolve('out/main/index.js')],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      TERMPOLIS_TEST_AGENTS: '1',
      TERMPOLIS_TEST_TIMING: '1',
      TERMPOLIS_TEST_PROJECT_CWD: PROJECT_ROOT,
      TERMPOLIS_TEST_SHIM_DIR: SHIM_DIR,
      // This is the magic env var: mock-claude.cjs will print the
      // MCP-unavailable message and exit instead of driving the swarm.
      MOCK_CLAUDE_BYPASS_MCP: '1',
    },
  })

  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(3000)

  // Verify MCP is up before triggering the swarm
  const udir = userDataDir()
  for (let i = 0; i < 30; i++) {
    if (fs.existsSync(path.join(udir, 'mcp-token'))) break
    await page.waitForTimeout(500)
  }

  await page.evaluate(async () => {
    await (window as any).swarmAPI.clear()
  })
})

test.afterAll(async () => {
  if (app) await app.close()
})

test.describe.serial('Swarm detects MCP-unavailable bypass', () => {
  test('1. Launch the swarm with a bypassed conductor', async () => {
    await page.keyboard.press('Control+Shift+S')
    await expect(page.locator('text=Swarm Dashboard').first()).toBeVisible({ timeout: 10000 })

    const dashboard = page.locator('.fixed').filter({ hasText: 'Swarm Dashboard' }).first()
    const startBtn = dashboard.locator('button:has-text("Start Swarm")').first()
    await startBtn.click()

    await expect(page.locator('h2:has-text("Start Swarm")')).toBeVisible({ timeout: 5000 })

    const wizard = page.locator('.fixed').filter({ has: page.locator('h2:has-text("Start Swarm")') }).first()
    await expect(wizard.getByText('Describe what you want built', { exact: true })).toBeVisible({ timeout: 60000 })

    const goal = wizard.locator('textarea[placeholder*="contact form"]').first()
    await goal.click()
    await goal.fill('Something that will never actually run because the mock bypasses MCP.')

    const launch = wizard.locator('button:has-text("Launch Swarm")').first()
    await expect(launch).toBeEnabled()
    await launch.click()

    await page.waitForTimeout(2500)
    await page.screenshot({ path: `${SCREENSHOTS}/01-launched.png` })
  })

  test('2. Renderer detects the MCP-unavailable text and surfaces an error notification', async () => {
    // The conductor monitor polls on an interval; give it up to 30s to fire.
    let notification: { message: string; type: string } | null = null
    for (let i = 0; i < 60; i++) {
      notification = await page.evaluate(() => {
        const getState = (window as any).__termpolis_test_state
        if (typeof getState !== 'function') return null
        return getState().swarmNotification ?? null
      })
      if (notification && /MCP tools unavailable|without.*swarm|bypass/i.test(notification.message)) break
      await page.waitForTimeout(500)
    }

    await page.screenshot({ path: `${SCREENSHOTS}/02-notification.png` })
    expect(notification).toBeTruthy()
    expect(notification!.type).toBe('error')
    // Surface the exact remediation: restart so MCP re-registers
    expect(notification!.message.toLowerCase()).toMatch(/restart|re.?register/)
  })

  test('3. Swarm is marked inactive — UI exits the "running" state', async () => {
    // setSwarmActive(false) was called in the detection branch. Verify.
    let isActive = true
    for (let i = 0; i < 40; i++) {
      isActive = await page.evaluate(() => {
        const getState = (window as any).__termpolis_test_state
        if (typeof getState !== 'function') return true
        return !!getState().swarmActive
      })
      if (!isActive) break
      await page.waitForTimeout(500)
    }
    expect(isActive).toBe(false)
  })

  test('4. No swarm tasks were created (conductor bypassed orchestration)', async () => {
    // The detection branch explicitly guards against false positives: if
    // swarm_create_task or create_terminal was observed, the bypass regex
    // is ignored. So zero tasks is the signature of a genuine bypass.
    const tasks = await page.evaluate(async () => {
      try {
        const res = await (window as any).swarmAPI.getTasks()
        return res && res.data ? res.data : (res ?? [])
      } catch {
        return []
      }
    })
    expect(Array.isArray(tasks)).toBe(true)
    expect(tasks.length).toBe(0)
  })
})
