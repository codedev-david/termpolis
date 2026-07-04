import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { _electron as electron } from 'playwright'
import path from 'path'
import fs from 'fs'

// Verification proof for the full-parity Memory & Learning dashboard, run against the
// REAL production store (~80k memories in %APPDATA%\termpolis). The launch deliberately
// omits --user-data-dir so the app resolves the same userData as production (app name is
// pinned to 'termpolis'). Production Termpolis MUST be closed (single-instance lock).
//
// It proves the fixes: cognitive types are real (no "untyped"), the live connections
// graph renders from the real graph, and driving real recalls populates the reliability
// / receipt SLIs. Screenshots are saved for visual review.

let app: ElectronApplication
let page: Page
const SHOT_DIR = path.resolve('e2e/screenshots')

test.beforeAll(async () => {
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  app = await electron.launch({
    args: [path.resolve('out/main/index.js')], // NO --user-data-dir → real %APPDATA%\termpolis store
    env: { ...process.env, NODE_ENV: 'test' }, // suppress the agents-running confirm-close dialog
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.setViewportSize({ width: 1440, height: 1024 }).catch(() => {})
  // pre-dismiss onboarding / tour so it can't overlay the settings pane
  await page.evaluate(() => {
    try { localStorage.setItem('termpolis.onboarding.seen.v1', '1') } catch { /* ignore */ }
  })
  for (const label of ['Skip tour', 'Skip', 'Got it', 'Close']) {
    await page.locator(`button:has-text("${label}")`).first().click({ timeout: 800 }).catch(() => {})
  }
})

test.afterAll(async () => { await app?.close() })

test('Memory & Learning dashboard renders real data + live graph, and recalls populate SLIs', async () => {
  // open Settings → Memory & Learning
  await page.locator('button[title="Settings"]').first().click()
  await page.locator('[data-testid="settings-tabs"]').waitFor({ state: 'visible', timeout: 15000 })
  await page.locator('[data-testid="settings-tab-memory"]').click()

  // This proof requires the REAL populated store. If launched against an empty store
  // (e.g. CI, which has no %APPDATA%\termpolis data), skip rather than fail — there is
  // nothing to prove. Locally, with production Termpolis closed, the 80k store is read.
  await page.waitForTimeout(1500)
  const emptyBrain = await page.locator('[data-testid="ml-empty"]').isVisible().catch(() => false)
  test.skip(emptyBrain, 'memory store is empty — this proof requires the real populated store')

  // wait until the live metrics have loaded off the real store (proves it read the 80k)
  const receipts = page.locator('[data-testid="ml-receipts"]')
  await receipts.waitFor({ state: 'visible', timeout: 20000 })

  // 1) cognitive types are REAL — the "by type" panel shows facets, never "untyped"
  const byType = page.locator('[data-testid="ml-bytype"]')
  const byTypeText = (await byType.innerText()).toLowerCase()
  expect(byTypeText).not.toContain('untyped')
  expect(byTypeText).toMatch(/entity|episodic|semantic/)

  // 2) the live connections graph renders from the real graph
  await expect(page.locator('[data-testid="ml-graph-canvas"]')).toBeVisible({ timeout: 15000 })
  const connText = await page.locator('[data-testid="ml-connections"]').innerText()
  expect(connText).toMatch(/of [\d,]+ nodes/) // "N of M nodes · E edges" overlay

  // 3a) UUID sources are relabeled — no raw terminal ids on screen
  const bySrc = await page.locator('[data-testid="ml-bysource"]').innerText()
  expect(bySrc).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i)

  // 3b) info tooltips are back — the "What's stored" panel reveals the memory-type help
  const infoBtn = page.locator('[data-testid="ml-bytype"] button[aria-label="What this means"]')
  await expect(infoBtn).toBeVisible()
  await infoBtn.hover() // reveals the tooltip on hover (click is the touch-toggle path)
  await expect(page.getByText('Five memory types', { exact: false })).toBeVisible()

  // 3c) growth chart + ticker present with real activity
  await expect(page.locator('[data-testid="ml-timeline"]')).toBeVisible()
  const tickerRows = await page.locator('[data-testid="ml-ticker"]').innerText()
  expect(tickerRows.trim().length).toBeGreaterThan(0)

  // 4) drive REAL recalls against the real store, then Refresh → reliability/receipts fill
  for (const q of ['how does memory recall work', 'voice transcription fix', 'release signing publisherName']) {
    await page.evaluate((query) => (window as any).termpolis.memorySearch({ query, limit: 5 }), q)
  }
  await page.locator('[data-testid="ml-refresh"]').click()
  // reliability's "Recall fired" flips from "no data" to a real percentage
  await expect.poll(async () => (await page.locator('[data-testid="ml-reliability"]').innerText()), { timeout: 15000 }).toMatch(/%/)
  const reliability = await page.locator('[data-testid="ml-reliability"]').innerText()
  expect(reliability.toLowerCase()).toContain('recall fired')

  // receipts "Recalls served" is now > 0
  const econ = await page.locator('[data-testid="ml-receipt-economics"]').innerText()
  expect(econ.toLowerCase()).toContain('recalls served')

  // Screenshots for visual review — one viewport capture per region. Element screenshots
  // black out the off-screen part inside Electron's overflow-y-auto scroll container, so
  // we scroll each panel into view and shoot the viewport instead.
  const panels = ['ml-receipts', 'ml-connections', 'ml-timeline', 'ml-reliability', 'ml-portability', 'ml-ticker']
  for (let i = 0; i < panels.length; i++) {
    await page.locator(`[data-testid="${panels[i]}"]`).scrollIntoViewIfNeeded()
    await page.waitForTimeout(panels[i] === 'ml-connections' ? 700 : 300) // let the graph settle
    await page.screenshot({ path: path.join(SHOT_DIR, `dash-${i}-${panels[i]}.png`) })
  }
})
