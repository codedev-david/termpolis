/**
 * Context-pressure indicator E2E — verifies the live status-bar pill in the REAL
 * Electron app, end to end through the REAL event bus:
 *
 *   __testPublish (test seam) -> agentEventBus.publish -> main pushes 'agentActivity:event'
 *   -> useLiveContextPressure.onEvent -> agentActivity.query -> computePressure
 *   -> <ContextPressureIndicator> renders in <StatusBar>
 *
 * Only the event *source* is seeded (the claudeCodeWatcher that normally emits these
 * token_update events is unit-tested separately + shape-verified). Everything from the
 * bus onward is the production code path running in the real renderer.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { _electron as electron } from 'playwright'
import path from 'path'
import fs from 'fs'
import os from 'os'

let app: ElectronApplication
let page: Page
let isolatedUserData: string

test.beforeAll(async () => {
  const { execSync } = await import('child_process')
  execSync('npx electron-vite build', { cwd: path.resolve('.'), stdio: 'pipe' })

  isolatedUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-ctxpress-'))
  fs.writeFileSync(
    path.join(isolatedUserData, 'session.json'),
    JSON.stringify({ terminals: [], workspaces: [], defaultShell: 'powershell', viewMode: 'tabs' }),
  )

  app = await electron.launch({
    args: [
      path.resolve('out/main/index.js'),
      `--user-data-dir=${isolatedUserData}`,
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
    ],
    env: { ...process.env, NODE_ENV: 'test', TERMPOLIS_TEST_AGENTS: '1' },
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(1500)

  await page.evaluate(() => {
    try {
      localStorage.setItem('termpolis.onboarding.seen.v1', '1')
      localStorage.setItem('termpolis.telemetry.optIn', '0')
    } catch {}
  })
  const dlg = page.locator('[aria-labelledby="onboarding-title"]')
  if (await dlg.isVisible({ timeout: 5000 }).catch(() => false)) {
    await page.locator('button:has-text("Skip tour")').first().click({ force: true }).catch(() => {})
    await dlg.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {})
  }
})

test.afterAll(async () => {
  if (app) await app.close()
  if (isolatedUserData) {
    try { fs.rmSync(isolatedUserData, { recursive: true, force: true }) } catch {}
  }
})

async function focusTerminal(terminalId: string): Promise<void> {
  await page.evaluate((id) => {
    ;(window as any).__setActiveTerminal?.(id)
  }, terminalId)
}

async function publishTokenUpdate(used: number, terminalId: string): Promise<boolean> {
  return page.evaluate(({ used, terminalId }) => {
    const ev = {
      kind: 'token_update', terminalId, agentType: 'claude', taskId: 's1',
      summary: `in:${used}`,
      payload: { inputTokens: used, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    }
    return (window as any).agentActivity.__testPublish(ev).then((r: any) => !!r?.success)
  }, { used, terminalId })
}

test.describe.serial('Context-pressure indicator (real app, real bus)', () => {
  test('the agentActivity bridge + test-publish seam are exposed', async () => {
    const keys = await page.evaluate(() => Object.keys((window as any).agentActivity || {}))
    expect(keys).toEqual(expect.arrayContaining(['query', 'onEvent', '__testPublish']))
  })

  test('no pressure pill before any agent token usage', async () => {
    const visible = await page.getByTestId('context-pressure-indicator').isVisible().catch(() => false)
    expect(visible).toBe(false)
  })

  test('pill appears at WARN for a window ~65% full (through the real bus)', async () => {
    await focusTerminal('e2e-term')
    const published = await publishTokenUpdate(130_000, 'e2e-term') // 130k / 200k (Claude) = 65%
    expect(published).toBe(true)
    const pill = page.getByTestId('context-pressure-indicator')
    await expect(pill).toBeVisible({ timeout: 8000 })
    await expect(pill).toHaveAttribute('data-level', 'warn')
    await expect(pill).toHaveText(/ctx 65%/)
  })

  test('pill escalates to CRITICAL as the window fills', async () => {
    await publishTokenUpdate(196_000, 'e2e-term') // max(130k,196k)=196k → 98%
    const pill = page.getByTestId('context-pressure-indicator')
    await expect(pill).toHaveAttribute('data-level', 'critical', { timeout: 8000 })
    await expect(pill).toHaveText(/ctx 98%/)
  })

  test('pill hides when the focused terminal has no usage', async () => {
    await focusTerminal('e2e-empty') // a different terminal, no events
    await expect(page.getByTestId('context-pressure-indicator')).toBeHidden({ timeout: 8000 })
  })
})
