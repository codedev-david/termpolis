/**
 * Lumopolis in the real app at every screen size, from a tablet to a 5K monitor, with the pane at its own
 * default width and split narrow beside the terminals (about 640 and 480 px): acceptance items 1, 2, 3, 5 and 6
 * of the responsive brief, measured in the DOM by e2e/helpers/layoutAudit.ts. No text overlaps text, a panel or
 * the toolbar (the map's labels included); no text is cut off; nothing scrolls across; nothing is under 12 CSS px;
 * and on a big screen at DPR 1 the pane's text grows. States: the home and its two dialogs, a loaded world in 3D
 * with the legend both ways, a building's card, the 2D map, an Ask answer, and the Export and Document dialogs.
 * Every state is saved as a PNG (RESPONSIVE_SHOTS, default test-results/responsive-shots) for the contact sheet.
 *
 * The world is this repository with labelling off (names from the code); the Ask answer is mock-claude's canned
 * one (MOCK_CLAUDE_WORLD_ANSWER), as in world-ask.spec.ts.
 */
import { test, expect, type ElectronApplication, type Page, type CDPSession, type Locator } from '@playwright/test'
import { _electron as electron } from 'playwright'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { quitApp, ensureE2eBuild, e2eShimEnv } from './helpers/launch'
import { VIEWPORTS, auditProblems, layoutAudit, medianFont, type AuditOptions, type Viewport } from './helpers/layoutAudit'

const SHOTS = path.resolve(process.env.RESPONSIVE_SHOTS ?? 'test-results/responsive-shots')
const PANE = '[data-testid="world-view"]'
const PANELS = [
  '[aria-label="Lumopolis controls"]',
  '[data-testid="world-legend"]',
  '[data-testid="world-card"]',
  '[data-testid="world-ask-slot"]',
  '[data-testid="world-notice"]',
  '[role="dialog"]',
  '[role="alertdialog"]',
]
const WORLD: AuditOptions = { root: PANE, panels: PANELS }
/** The pane widths each window is checked at: its default (40% of the row), then split narrow. */
const SPLITS: Array<number | null> = [null, 640, 480]
/** The windows to check: every one, or those RESPONSIVE_ONLY names (comma separated), to look again at one size. */
const ONLY = process.env.RESPONSIVE_ONLY?.split(',').map((n) => n.trim()).filter(Boolean)
const RUN = ONLY && ONLY.length > 0 ? VIEWPORTS.filter((v) => ONLY.includes(v.name)) : VIEWPORTS
/** The windows the dialogs are checked at: a tablet, a laptop and a 4K monitor at DPR 1. */
const DIALOG_VIEWPORTS = new Set(['768x1024', '1280x800', '3840x2160'])

/** How much bigger a big screen's text must be than a laptop's: half the window's growth past 1920x1080 at DPR 1. */
const growth = (v: Viewport): number => (v.dpr === 1 ? Math.max(1, 1 + (Math.min(v.width / 1920, v.height / 1080) - 1) * 0.5) : 1)
const LAPTOP_MEDIAN = 12

let app: ElectronApplication
let page: Page
let cdp: CDPSession
let userDataDir: string
let shimDir: string
let shims: Record<string, string>

interface Probe { pickAt(x: number, y: number): { kind: string; id: string } | null; drawn(): { changing: number } }

test.beforeAll(async () => {
  ensureE2eBuild()
  fs.mkdirSync(SHOTS, { recursive: true })
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-responsive-ud-'))
  fs.writeFileSync(
    path.join(userDataDir, 'session.json'),
    JSON.stringify({ terminals: [], workspaces: [], defaultShell: process.platform === 'win32' ? 'powershell' : 'bash', viewMode: 'tabs' }),
  )
  fs.writeFileSync(path.join(userDataDir, 'world-settings.json'), JSON.stringify({ worldLabelling: false }))
  // The Ask's agent is mock-claude (see world-ask.spec.ts for why Windows needs the .ps1).
  shims = e2eShimEnv('world-responsive')
  shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-responsive-shim-'))
  if (process.platform === 'win32') {
    const mock = path.resolve('e2e', 'mocks', 'mock-claude.cjs')
    fs.writeFileSync(path.join(shimDir, 'claude.ps1'), `& node '${mock}' @args
exit $LASTEXITCODE
`)
  }
  app = await electron.launch({
    args: [
      path.resolve('out/main/index.js'),
      `--user-data-dir=${userDataDir}`,
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
    ],
    env: {
      ...process.env,
      ...shims,
      PATH: `${shimDir}${path.delimiter}${shims.PATH}`,
      PSExecutionPolicyPreference: 'Bypass',
      NODE_ENV: 'test',
      TERMPOLIS_SMOKE_SKIP_PICKERS: '1',
      TERMPOLIS_TEST_WORLD_PROBE: '1',
      MOCK_CLAUDE_WORLD_ANSWER: '1',
      MOCK_CLAUDE_REPLY_DELAY_MS: '300',
    },
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  // The session stays attached: Chromium drops a session's emulation when it detaches.
  cdp = await page.context().newCDPSession(page)
  await setViewport(VIEWPORTS[2])
  await page.waitForTimeout(1500)
  await page.evaluate(() => {
    try {
      localStorage.setItem('termpolis.onboarding.seen.v1', '1')
      localStorage.setItem('termpolis.telemetry.optIn', '0')
      localStorage.removeItem('termpolis.world.paneWidth')
    } catch {
      /* ignore */
    }
  })
  const onboardDialog = page.locator('[aria-labelledby="onboarding-title"]')
  if (await onboardDialog.isVisible({ timeout: 5000 }).catch(() => false)) {
    await page.locator('button:has-text("Skip tour")').first().click({ force: true }).catch(() => {})
    await onboardDialog.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {})
  }
})

test.afterAll(async () => {
  await quitApp(app)
  for (const d of [userDataDir, shimDir]) {
    try {
      if (d) fs.rmSync(d, { recursive: true, force: true })
    } catch {
      /* temp dir */
    }
  }
})

async function setViewport(v: Viewport): Promise<void> {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: v.width, height: v.height, deviceScaleFactor: v.dpr, mobile: false })
  // Within a pixel: the window's own display scaling leaves a rounding pixel under emulation.
  await expect
    .poll(() => page.evaluate(({ w, h, d }) => (Math.abs(innerWidth - w) <= 1 && Math.abs(innerHeight - h) <= 1 && Math.abs(devicePixelRatio - d) < 0.01 ? 'ok' : `${innerWidth}x${innerHeight}@${devicePixelRatio}`), { w: v.width, h: v.height, d: v.dpr }), { timeout: 10_000 })
    .toBe('ok')
}

async function shoot(name: string): Promise<void> {
  // A 5K frame drawn in software takes longer than the default 30 s to capture.
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), timeout: 120_000 })
}

/** Audits the pane (or `root`) as it is now, every problem a soft failure under `state`; returns the median font. */
async function check(state: string, opts: AuditOptions = WORLD): Promise<number> {
  const r = await page.evaluate(layoutAudit, opts)
  expect.soft(r.texts, `${state}: the audit measured no text`).toBeGreaterThan(0)
  expect.soft(auditProblems(r), state).toEqual([])
  return medianFont(r)
}

async function createTerminal(name: string, cwd: string): Promise<void> {
  await page.locator('button:has-text("+ Add Terminal")').first().click()
  const dialog = page.locator('h2:has-text("New Terminal")').locator('..')
  await expect(dialog).toBeVisible()
  await dialog.locator('input').first().fill(name)
  await dialog.locator('input[placeholder="Home directory"]').fill(cwd)
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await page.waitForTimeout(1500)
}

async function openPane(): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.press('ControlOrMeta+k')
  const input = page.getByPlaceholder('Type a command...')
  await expect(input).toBeVisible()
  await input.fill('Open Lumopolis')
  await page.getByRole('button', { name: /^Open Lumopolis\s*See your project as a 3D world/ }).click()
  await expect(page.locator(PANE)).toBeVisible({ timeout: 30_000 })
}

/**
 * Presses a button in the pane with Enter, as the keyboard does. The pane's panels are CSS-zoomed on a big screen,
 * and the Chromium that local runs use (Electron 30, before standard zoom) reports their boxes unzoomed, so a mouse
 * click aims beside the button; Enter on the focused button is the same press on every Chromium.
 */
async function press(button: Locator): Promise<void> {
  await button.focus()
  await page.keyboard.press('Enter')
}

async function closePane(): Promise<void> {
  await press(page.locator('[data-testid="world-close"]'))
  await expect(page.locator(PANE)).toHaveCount(0)
}

/** Waits until the world is on the canvas and still. */
async function settled(compileMs = 120_000): Promise<void> {
  await expect(page.locator('[data-testid="world-canvas-host"] canvas')).toBeVisible({ timeout: compileMs })
  await expect(page.locator('[data-testid="world-canvas-host"]')).toHaveCSS('visibility', 'visible', { timeout: compileMs })
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __termpolis_world?: Probe }).__termpolis_world?.drawn().changing ?? -1), { timeout: 30_000 })
    .toBe(0)
  await page.waitForTimeout(1500)
}

/** Clicks the first building found on a grid across the stage; true when its card opened. */
async function openCard(): Promise<boolean> {
  // A few tries: in the test's software-rendered 5K window a frame takes long enough that the city can
  // settle between finding a building and clicking it.
  for (let attempt = 0; attempt < 3; attempt++) {
    const at = await page.evaluate(() => {
      const probe = (window as unknown as { __termpolis_world?: Probe }).__termpolis_world
      const host = document.querySelector('[data-testid="world-canvas-host"]')
      if (!probe || !host) return null
      const r = host.getBoundingClientRect()
      // A fine grid: on a big monitor the city's buildings are small in a tall pane, and a coarse one misses them all.
      for (let row = 4; row <= 44; row++) {
        for (let col = 4; col <= 44; col++) {
          const x = r.left + (r.width * col) / 48
          const y = r.top + (r.height * row) / 48
          const el = document.elementFromPoint(x, y)
          if (el && host.contains(el) && probe.pickAt(x, y)?.kind === 'node') return { x, y }
        }
      }
      return null
    })
    if (!at) return false
    await page.mouse.click(at.x, at.y)
    // The card opens once the camera has flown to the building: frames are slow in the test's software-rendered window.
    await expect(page.locator('[data-testid="world-card"]')).toBeVisible({ timeout: 15_000 }).catch(() => {})
    if (await page.locator('[data-testid="world-card"]').isVisible()) return true
  }
  return false
}

async function closeCard(): Promise<void> {
  const card = page.locator('[data-testid="world-card"]')
  if (await card.isVisible()) {
    await page.keyboard.press('Escape')
    if (await card.isVisible()) await press(card.getByRole('button', { name: /close/i }).first()).catch(() => {})
  }
  await page.waitForTimeout(600)
}

/** Sets the pane's saved width (null: its default) and opens it again so it takes it. */
async function split(width: number | null): Promise<void> {
  await closePane()
  await page.evaluate((w) => {
    try {
      if (w === null) localStorage.removeItem('termpolis.world.paneWidth')
      else localStorage.setItem('termpolis.world.paneWidth', String(w))
    } catch {
      /* ignore */
    }
  }, width)
  await openPane()
  await settled()
}

test.describe.serial('Lumopolis at every screen size', () => {
  test('the home and its dialogs fit at every size', async () => {
    test.setTimeout(600_000)
    await openPane()
    await expect(page.locator('[data-testid="world-home"]')).toBeVisible({ timeout: 30_000 })
    for (const v of RUN) {
      await setViewport(v)
      await page.waitForTimeout(600)
      const median = await check(`home at ${v.name}`)
      const want = LAPTOP_MEDIAN * growth(v)
      expect.soft(median, `home at ${v.name}: the median text size (want at least ${want.toFixed(1)} px)`).toBeGreaterThanOrEqual(want - 0.5)
      await shoot(`app-home-${v.name}`)
      if (!DIALOG_VIEWPORTS.has(v.name)) continue
      for (const [choice, testid, name] of [['Design something new', 'world-design-start', 'design'], ['Open a git repository…', 'world-clone', 'clone']] as const) {
        await press(page.getByRole('button', { name: new RegExp(`^${choice}`) }))
        await expect(page.locator(`[data-testid="${testid}"]`)).toBeVisible()
        await check(`${name} dialog at ${v.name}`, { root: `[data-testid="${testid}"]`, panels: [] })
        await shoot(`app-dialog-${name}-${v.name}`)
        // Cancel, not Esc: the home's two dialogs leave Esc to the pane, whose second Esc closes the pane.
        await press(page.locator(`[data-testid="${testid}"]`).getByRole('button', { name: /^(Cancel|Close)$/ }).first())
        await expect(page.locator(`[data-testid="${testid}"]`)).toHaveCount(0)
      }
    }
    await closePane()
    await setViewport(VIEWPORTS[2])
  })

  test('a loaded world, its card, 2D map, answer and dialogs fit at every size and split', async () => {
    test.setTimeout(3_000_000)
    await createTerminal('Repo', path.resolve('.'))
    await openPane()
    await settled(180_000)
    for (const v of RUN) {
      await setViewport(v)
      for (const width of SPLITS) {
        await split(width)
        const w = await page.locator(PANE).evaluate((el) => Math.round(el.getBoundingClientRect().width))
        const tag = `${v.name} pane ${width === null ? 'default' : width}`
        const name = `${v.name}-${width === null ? 'default' : `w${width}`}`
        const median = await check(`world at ${tag} (${w}px)`)
        if (width === null) {
          const want = LAPTOP_MEDIAN * growth(v)
          expect.soft(median, `world at ${tag}: the median text size (want at least ${want.toFixed(1)} px)`).toBeGreaterThanOrEqual(want - 0.5)
        }
        await shoot(`app-world-${name}`)

        const toggle = page.locator('[data-testid="world-legend-toggle"]')
        if (await toggle.isVisible()) {
          await press(toggle)
          await page.waitForTimeout(900)
          await check(`legend toggled at ${tag}`)
          await shoot(`app-legend-${name}`)
          await press(toggle)
          await page.waitForTimeout(600)
        }

        expect.soft(await openCard(), `a building's card opened at ${tag}`).toBe(true)
        await page.waitForTimeout(1500)
        await check(`card at ${tag}`)
        await shoot(`app-card-${name}`)
        await closeCard()

        await press(page.locator('[data-testid="world-map2d"]'))
        await page.waitForTimeout(800)
        await check(`2D map at ${tag}`)
        await shoot(`app-map2d-${name}`)
        await press(page.locator('[data-testid="world-map2d"]'))
        await page.waitForTimeout(800)

        if (width !== null) continue
        const askBox = page.getByPlaceholder('Ask about this project…')
        await askBox.fill('How does the memory search work?')
        await askBox.press('Enter')
        await expect(page.locator('[data-testid="world-answer"]')).toBeVisible({ timeout: 30_000 })
        await page.waitForTimeout(4000)
        await check(`answer at ${tag}`)
        await shoot(`app-answer-${name}`)
        await press(page.getByRole('button', { name: 'Close answer' }))
        await page.waitForTimeout(800)

        if (!DIALOG_VIEWPORTS.has(v.name)) continue
        for (const [item, testid, label] of [['world-export-world', 'world-export-dialog', 'export'], ['world-export-document', 'world-document-dialog', 'document']] as const) {
          await press(page.locator('[data-testid="world-export"]'))
          await press(page.locator(`[data-testid="${item}"]`))
          // The Document dialog opens after a picture of the map is taken on the next frame: in the test's
          // software-rendered 4K window a frame and the picture take seconds, not the milliseconds a GPU takes.
          await expect(page.locator(`[data-testid="${testid}"]`)).toBeVisible({ timeout: 30_000 })
          await page.waitForTimeout(1500)
          await check(`${label} dialog at ${tag}`, { root: `[data-testid="${testid}"]`, panels: [] })
          await shoot(`app-dialog-${label}-${name}`)
          await page.keyboard.press('Escape')
          if (await page.locator(`[data-testid="${testid}"]`).isVisible()) await press(page.locator(`[data-testid="${testid}"]`).getByRole('button', { name: /^(Cancel|Close)$/ }).first())
          await expect(page.locator(`[data-testid="${testid}"]`)).toHaveCount(0)
        }
      }
    }
  })
})
