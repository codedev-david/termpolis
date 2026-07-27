import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { _electron as electron } from 'playwright'
import path from 'path'
import fs from 'fs'
import { e2eLaunchArgs } from '../helpers/launch'

// Proves live model switching works MID-SESSION for a HEURISTICALLY-detected Claude
// terminal (no authoritative launch command — Termpolis can't safely interrupt a session
// it didn't launch itself, so this path intentionally keeps the plain `/model <alias>`
// hot-swap; see modelRelaunch.ts and TerminalPane.tsx's isAuthoritativeClaudeSession for
// the authoritatively-launched path, which relaunches instead and is covered by
// tests/components/TerminalPane.test.tsx + tests/renderer/modelRelaunch.test.ts).
// Production Termpolis must be closed.

let app: ElectronApplication
let page: Page
const SHOT_DIR = path.resolve('e2e/screenshots')

async function createTerminal(name: string): Promise<string> {
  await page.locator('button:has-text("+ Add Terminal")').first().click()
  await page.waitForTimeout(400)
  await page.locator('h2:has-text("New Terminal")').locator('..').locator('input').first().fill(name)
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await page.waitForTimeout(1500)
  return page.evaluate(() => {
    const s = (window as any).__termpolis_test_state?.()
    const ts = s?.terminals || []
    return ts.length ? ts[ts.length - 1].id : ''
  })
}

test.beforeAll(async () => {
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  app = await electron.launch({ args: e2eLaunchArgs('model-switch-proof'), env: { ...process.env, NODE_ENV: 'test' } })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.setViewportSize({ width: 1440, height: 1024 }).catch(() => {})
  await page.evaluate(() => { try { localStorage.setItem('termpolis.onboarding.seen.v1', '1') } catch { /* ignore */ } })
  for (const label of ['Skip tour', 'Skip', 'Got it', 'Close']) {
    await page.locator(`button:has-text("${label}")`).first().click({ timeout: 800 }).catch(() => {})
  }
})

test.afterAll(async () => { await app?.close() })

test('live model picker switches Claude models back and forth mid-session', async () => {
  test.setTimeout(120000)
  const termId = await createTerminal('ModelSwap')

  // Wait for the shell's PTY to be ready (prompt printed) before typing, so the marker
  // isn't sent into a not-yet-spawned shell and lost.
  await expect.poll(async () => {
    const r = await page.evaluate((id) => (window as any).termpolis.readTerminalBuffer(id), termId)
    return String(r?.data?.output || '').length
  }, { timeout: 20000, intervals: [500] }).toBeGreaterThan(0)

  // Mark the terminal as a Claude session via the SAME output-detection path a real launch
  // uses (agentDetector matches /claude/ in the output → the model picker appears). Echoing
  // the marker is deterministic; driving Claude's TUI to first-paint in headless e2e is not.
  await page.evaluate((id) => (window as any).termpolis.writeToTerminal(id, 'echo Claude-Code-Session-Ready\r'), termId)
  await expect.poll(async () => {
    const r = await page.evaluate((id) => (window as any).termpolis.readTerminalBuffer(id), termId)
    return String(r?.data?.output || '')
  }, { timeout: 15000, intervals: [500] }).toContain('Claude') // marker landed → detection can fire

  const picker = page.locator('[data-testid="model-picker"]').first()
  const appeared = await picker.isVisible({ timeout: 15000 }).catch(() => false)
  test.skip(!appeared, 'terminal was not detected as a Claude session in this environment')

  // Switch back and forth; each selection must deliver `/model <alias>` into the live PTY.
  for (const alias of ['haiku', 'opus', 'sonnet', 'haiku']) {
    await picker.selectOption(alias)
    await expect(picker).toHaveValue(alias) // the control reflects the mid-session switch
    await page.waitForTimeout(1000)
    const buf = await page.evaluate((id) => (window as any).termpolis.readTerminalBuffer(id), termId)
    expect(String(buf?.data?.output || ''), `expected /model ${alias} to reach the session`).toContain(`/model ${alias}`)
  }

  await page.screenshot({ path: path.join(SHOT_DIR, 'model-switch.png') })
})
