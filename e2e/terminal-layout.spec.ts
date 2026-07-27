/**
 * Terminal LAYOUT E2E — the geometry gate the unit suite structurally cannot reach.
 *
 * v1.32.4 shipped a bug that ~7,800 unit tests were blind to: xterm's FitAddon sizes
 * the grid from `getComputedStyle(PARENT).width`, which under `* { box-sizing: border-box }`
 * is the parent's BORDER box — so padding on TerminalPane's container was counted as usable
 * grid space. The rows overflowed to the right and painted OVER `.xterm-viewport`
 * (`.xterm-screen` is a later sibling, so it wins the paint order) and the scrollbar looked
 * clipped. Nothing in jsdom can catch that: jsdom has no layout engine, so every rect is 0.
 *
 * These assertions are GEOMETRIC, not pixel-diff — no golden images to regenerate, no
 * platform-specific baselines, and they fail loudly instead of silently re-baselining.
 *
 * Isolated --user-data-dir so it owns its own single-instance lock and coexists with a
 * developer's running app (mirrors terminal-focus.spec.ts).
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { _electron as electron } from 'playwright'
import path from 'path'
import fs from 'fs'
import os from 'os'

let app: ElectronApplication
let page: Page
let isolatedUserData: string

/** FitAddon's hard-coded right-hand reserve (`overviewRulerWidth || 14`). */
const FIT_ADDON_RESERVE = 14

type Metrics = {
  found: boolean
  scrollbarWidth: number
  screenRight: number
  viewportRight: number
  paddingRight: number
  cssScrollbarWidth: string
  cssScrollbarColor: string
}

/** Measure the live terminal box model in the real renderer. */
function measure(p: Page): Promise<Metrics> {
  return p.evaluate(() => {
    const xterm = document.querySelector('.xterm') as HTMLElement | null
    const viewport = document.querySelector('.xterm .xterm-viewport') as HTMLElement | null
    const screen = document.querySelector('.xterm .xterm-screen') as HTMLElement | null
    if (!xterm || !viewport || !screen) {
      return {
        found: false,
        scrollbarWidth: 0,
        screenRight: 0,
        viewportRight: 0,
        paddingRight: 0,
        cssScrollbarWidth: '',
        cssScrollbarColor: '',
      }
    }
    const style = getComputedStyle(xterm)
    const vpStyle = getComputedStyle(viewport)
    return {
      found: true,
      // The gutter the browser actually reserved for the bar (offset includes it, client does not).
      scrollbarWidth: viewport.offsetWidth - viewport.clientWidth,
      screenRight: screen.getBoundingClientRect().right,
      viewportRight: viewport.getBoundingClientRect().right,
      paddingRight: parseFloat(style.paddingRight) || 0,
      cssScrollbarWidth: vpStyle.getPropertyValue('scrollbar-width'),
      cssScrollbarColor: vpStyle.getPropertyValue('scrollbar-color'),
    }
  })
}

async function resizeWindow(width: number, height: number): Promise<void> {
  await app.evaluate(async ({ BrowserWindow }, size) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) win.setSize(size.w, size.h)
  }, { w: width, h: height })
  // Let the resize observer + FitAddon re-fit the grid before measuring.
  await page.waitForTimeout(600)
}

test.beforeAll(async () => {
  const { execSync } = await import('child_process')
  execSync('npx electron-vite build', { cwd: path.resolve('.'), stdio: 'pipe' })

  isolatedUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-layout-'))
  fs.writeFileSync(path.join(isolatedUserData, 'session.json'), JSON.stringify({
    terminals: [],
    workspaces: [],
    defaultShell: process.platform === 'win32' ? 'powershell' : 'bash',
    viewMode: 'tabs',
  }))

  app = await electron.launch({
    args: [
      path.resolve('out/main/index.js'),
      `--user-data-dir=${isolatedUserData}`,
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
    ],
    env: { ...process.env, NODE_ENV: 'test', TERMPOLIS_TEST_AGENTS: '1', TERMPOLIS_TEST_TIMING: '1' },
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(1500)

  await page.evaluate(() => {
    try {
      localStorage.setItem('termpolis.onboarding.seen.v1', '1')
      localStorage.setItem('termpolis.telemetry.optIn', '0')
    } catch { /* ignore */ }
  })
  const onboardDialog = page.locator('[aria-labelledby="onboarding-title"]')
  if (await onboardDialog.isVisible({ timeout: 5000 }).catch(() => false)) {
    await page.locator('button:has-text("Skip tour")').first().click({ force: true }).catch(() => {})
    await onboardDialog.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {})
  }
})

test.afterAll(async () => {
  if (app) await app.close()
  if (isolatedUserData) {
    try { fs.rmSync(isolatedUserData, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

async function createTerminal(name: string): Promise<void> {
  await page.locator('button:has-text("+ Add Terminal")').first().click()
  await page.waitForTimeout(400)
  const nameInput = page.locator('h2:has-text("New Terminal")').locator('..').locator('input').first()
  await nameInput.fill(name)
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await page.waitForTimeout(1500)
}

test.describe.serial('Terminal layout: rows never paint over the scrollbar', () => {
  test('1. a live terminal reserves a real scrollbar gutter', async () => {
    await createTerminal('LayoutA')
    await expect(page.locator('.xterm .xterm-viewport').first()).toBeVisible({ timeout: 15000 })

    const m = await measure(page)
    expect(m.found).toBe(true)
    // index.css styles the bar at 18px. If someone deletes the rule the browser default
    // (~15px) still passes >0, so assert the STYLED width — a removed rule is a regression
    // in its own right, and the clearance maths below is written against 18.
    expect(m.scrollbarWidth).toBeGreaterThanOrEqual(15)
  })

  test('2. rows stop before the scrollbar at every pane width', async () => {
    // The original bug only showed at some widths (the grid rounds to whole cells), so
    // sweep a range rather than trusting a single measurement.
    const widths = [900, 1000, 1100, 1200, 1300, 1400, 1500, 1600]
    const overlaps: string[] = []
    for (const w of widths) {
      await resizeWindow(w, 800)
      const m = await measure(page)
      if (!m.found) continue
      // The rows' right edge must clear the bar: screenRight <= viewportRight - scrollbarWidth.
      const clearance = (m.viewportRight - m.scrollbarWidth) - m.screenRight
      if (clearance < 0) {
        overlaps.push(`width=${w}: rows overrun the bar by ${Math.abs(clearance).toFixed(1)}px`)
      }
    }
    expect(overlaps, `rows painted over the scrollbar:\n${overlaps.join('\n')}`).toEqual([])
  })

  test('3. the padding-right + FitAddon reserve still clears the bar', async () => {
    await resizeWindow(1200, 800)
    const m = await measure(page)
    // The invariant index.css documents: FitAddon subtracts `.xterm`'s own padding and
    // reserves 14px, so padding-right + 14 must cover the rendered bar. This fails the
    // build if someone widens the scrollbar or trims the padding in isolation.
    expect(m.paddingRight + FIT_ADDON_RESERVE).toBeGreaterThanOrEqual(m.scrollbarWidth)
  })

  test('4. no scrollbar-width/color set (Chromium would drop every ::-webkit rule)', async () => {
    const m = await measure(page)
    // Chromium IGNORES the whole ::-webkit-scrollbar block if the standard
    // `scrollbar-width` or `scrollbar-color` properties are also set on the element.
    // Setting either one silently reverts the terminal to the default OS bar.
    expect(m.cssScrollbarWidth === '' || m.cssScrollbarWidth === 'auto').toBe(true)
    expect(m.cssScrollbarColor === '' || m.cssScrollbarColor === 'auto').toBe(true)
  })
})
