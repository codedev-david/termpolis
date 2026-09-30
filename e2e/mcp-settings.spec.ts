/**
 * MCP Servers settings -- the gateway's human half, driven in the built app.
 *
 * The unit suites cover the inventory reader, the TOML scan and the IPC
 * handlers in isolation, and the component suite covers the panel against a
 * mocked API. What none of them can show is that the panel, the preload bridge
 * and the real main-process handlers agree: a channel renamed on one side of
 * contextBridge is invisible to every one of those suites and fatal here.
 *
 * The two properties worth proving in a real window:
 *   - a gateway write round trips through main and comes back persisted;
 *   - nothing spawns an upstream server unless a human clicks Test.
 */

import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { e2eLaunchArgs, dismissOnboarding } from './helpers/launch'

let app: ElectronApplication
let page: Page
let agentHome = ''

test.beforeAll(async () => {
  const { execSync } = await import('child_process')
  execSync('npx electron-vite build', { cwd: path.resolve('.'), stdio: 'pipe' })

  // A scratch agent home of this spec's own, where Claude Code counts as installed (its
  // config directory exists), so connecting the agents writes a registration for the
  // inventory to list. The shared global-setup home is empty, and never the real ~/.claude.
  agentHome = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-mcpsettings-home-'))
  fs.mkdirSync(path.join(agentHome, '.claude'))

  app = await electron.launch({
    args: e2eLaunchArgs('mcp-settings'),
    env: { ...process.env, NODE_ENV: 'test', TERMPOLIS_TEST_AGENTS: '1', TERMPOLIS_TEST_AGENT_HOME: agentHome },
  })
  page = await app.firstWindow()
  await dismissOnboarding(page)
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(1500)
})

test.afterAll(async () => {
  if (app) await app.close()
  if (agentHome) {
    try { fs.rmSync(agentHome, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

test.describe.serial('MCP settings', () => {
  test('1. the MCP tab opens and all three reads land', async () => {
    await page.locator('button[title="Settings"]').click()
    await expect(page.locator('[data-testid="settings-tabs"]')).toBeVisible()
    await page.locator('[data-testid="settings-tab-mcp"]').click()

    await expect(page.locator('[data-testid="mcp-settings"]')).toBeVisible()
    // Loading is a third render state with no gateway section in it, so waiting
    // for the gateway proves the IPC round trip completed rather than hanging.
    await expect(page.locator('[data-testid="mcp-gateway"]')).toBeVisible({ timeout: 15000 })
    await expect(page.locator('[data-testid="mcp-policy"]')).toBeVisible()
    await expect(page.locator('[data-testid="mcp-inventory"]')).toBeVisible()
    await expect(page.locator('[data-testid="mcp-unavailable"]')).toHaveCount(0)
  })

  test('2. a fresh profile starts closed, with no upstream servers', async () => {
    // The default the whole subsystem rests on. A build that shipped this as
    // `allow` would let any agent reach any configured server unasked.
    await expect(page.locator('[data-testid="mcp-gateway-empty"]')).toBeVisible()
    await expect(page.locator('[data-testid="mcp-policy-ask"]')).toHaveClass(/0e639c/)
  })

  test('3. adding a server round trips through the main process', async () => {
    await page.locator('[data-testid="mcp-add-id"]').fill('e2e-probe')
    await page.locator('[data-testid="mcp-add-command"]').fill('node')
    await page.locator('[data-testid="mcp-add-args"]').fill('--version')
    await page.locator('[data-testid="mcp-add"]').click()

    // The row follows the list main SENT BACK, so this reads what was persisted
    // rather than what was typed into the form.
    await expect(page.locator('[data-testid="mcp-server-e2e-probe"]')).toBeVisible({ timeout: 10000 })
    await expect(page.locator('[data-testid="mcp-error"]')).toHaveCount(0)
  })

  test('4. a new server is configured, not connected', async () => {
    // Probe-on-demand. Adding a server must not spawn it: `liveTransports()`
    // memoises stdio transports as live child processes, so a panel that
    // connected on render would fork every configured server on open.
    await expect(page.locator('[data-testid="mcp-server-status-e2e-probe"]')).toHaveText('configured')
  })

  test('5. a refused add is reported and changes nothing', async () => {
    await page.locator('[data-testid="mcp-add-id"]').fill('no-transport')
    await page.locator('[data-testid="mcp-add"]').click()

    await expect(page.locator('[data-testid="mcp-error"]')).toBeVisible({ timeout: 10000 })
    await expect(page.locator('[data-testid="mcp-server-no-transport"]')).toHaveCount(0)
    // Non-optimistic: the draft survives so the user can correct it.
    await expect(page.locator('[data-testid="mcp-add-id"]')).toHaveValue('no-transport')
  })

  test('6. the policy persists across a reload of the panel', async () => {
    await page.locator('[data-testid="mcp-policy-deny"]').click()
    await expect(page.locator('[data-testid="mcp-policy-deny"]')).toHaveClass(/0e639c/, { timeout: 10000 })

    // Leave the tab and come back: the panel re-reads from main on mount, so a
    // value that survives this was written to disk, not just held in state.
    await page.locator('[data-testid="settings-tab-general"]').click()
    await page.locator('[data-testid="settings-tab-mcp"]').click()
    await expect(page.locator('[data-testid="mcp-policy-deny"]')).toHaveClass(/0e639c/, { timeout: 15000 })
    await expect(page.locator('[data-testid="mcp-server-e2e-probe"]')).toBeVisible()
  })

  test('7. the inventory lists Termpolis itself once the agents are connected', async () => {
    // Since v1.49 Termpolis registers itself only after the user connects their agents
    // (dismissOnboarding's Skip tour keeps the tour's ticked "Connect agents"), and only
    // for an agent that is installed -- hence the scratch ~/.claude in beforeAll. This is
    // the end-to-end proof that the inventory reader parses what agentMcpRegistry writes.
    // Refresh re-reads the configs, so a connect that landed after the last mount still counts.
    await page.locator('[data-testid="mcp-refresh"]').click()
    await expect(page.locator('[data-testid="mcp-inv-termpolis"]')).toBeVisible({ timeout: 15000 })
  })

  test('8. removing a server round trips too', async () => {
    await page.locator('[data-testid="mcp-remove-e2e-probe"]').click()
    await expect(page.locator('[data-testid="mcp-server-e2e-probe"]')).toHaveCount(0, { timeout: 10000 })
  })
})
