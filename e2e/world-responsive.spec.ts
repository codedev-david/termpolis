/**
 * Lumopolis in the real app from a tablet to a 4K monitor, with the pane at its own default width and dragged
 * narrow beside the terminals by its divider: acceptance items 1, 2, 3, 5 and 6 of the responsive brief, measured
 * in the DOM by e2e/helpers/layoutAudit.ts. No text overlaps text, a panel or the toolbar (the map's labels
 * included); no text is cut off; nothing scrolls across; nothing is under 12 CSS px; and the pane's median text is
 * at least the laptop's 12 px times the pane's own scale (uiScale), so on a big screen at DPR 1 it grows.
 *
 * States: the home and its dialogs (Design something new, Open a git repository…, Use a token), a loaded world in
 * 3D with the legend both ways, a building's card, the toolbar's More menu where the pane folds it, the 2D map, an
 * Ask answer, the Export and Document dialogs, and the Build it dialog of a design. Every state is saved as a PNG
 * (RESPONSIVE_SHOTS, default test-results/responsive-shots) for the contact sheet.
 *
 * Sizes: the blocking run checks BLOCKING_VIEWPORTS (768x1024, 1366x768, 1920x1080, 3840x2160) at the pane's
 * default width, and 3840x2160 also with the pane dragged to 640 and 480 px, where the narrow pane's scale floor
 * shows. RESPONSIVE_FULL=1 checks every size of VIEWPORTS (DPR 1 and 2) at all three widths, by hand;
 * RESPONSIVE_ONLY names sizes to look at again. RESPONSIVE_REDUCED=1 (the macOS CI job, whose software-rendered 4K
 * run would not fit the job's time) checks a MacBook's 1440x900 at DPR 2 alone, at the default width and at 480. At 768x1024 the row has no room for the pane beside the terminals,
 * so the pane lies over them, which is checked too.
 *
 * The world is this repository with labelling off (names from the code); the Ask answer and the design are
 * mock-claude's canned ones (MOCK_CLAUDE_WORLD_ANSWER), as in world-ask.spec.ts and lumopolis-sources.spec.ts. The
 * Use a token dialog comes from a clone of the local https git server of lumopolis-private-repos.spec.ts, with its
 * fake login helper; nothing is ever signed in or sent, and without that server (no git-http-backend or openssl)
 * that one dialog is skipped and says so.
 */
import { test, expect, type ElectronApplication, type Page, type CDPSession, type Locator } from '@playwright/test'
import { _electron as electron } from 'playwright'
import { randomBytes } from 'crypto'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { quitApp, ensureE2eBuild, e2eShimEnv } from './helpers/launch'
import { auditProblems, layoutAudit, medianFont, responsiveViewports, settleBudget, stillMoving, steady, type AuditOptions, type Viewport } from './helpers/layoutAudit'
import { uiScale } from '../src/shared/world/uiScale'
import { fakeHelperConfig, fixtureSkipReason, startGitHttps, type GitHttps } from '../tests/fixtures/gitHttps/server'

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
const RUN = responsiveViewports()
const FULL = process.env.RESPONSIVE_FULL === '1'
/** The size a blocking run also drags the pane narrow at: 4K, where a narrow pane's scale floor shows. */
const SPLIT_AT = '3840x2160'
/** The pane widths each size is checked at: its default (null: 40% of the row), then dragged narrow. */
/** The reduced run (RESPONSIVE_REDUCED=1): one size, at its default width and dragged to the narrowest. */
const REDUCED = !FULL && process.env.RESPONSIVE_REDUCED === '1'
const widths = (v: Viewport): Array<number | null> => (REDUCED ? [null, 480] : [null, ...(FULL || v.name === SPLIT_AT ? [640, 480] : [])])
/** How near the dragged pane must come to the width asked for. */
const SPLIT_TOLERANCE_PX = 8
/** The median text size a laptop shows, before the pane's own scale. */
const LAPTOP_MEDIAN = 12

const missing = fixtureSkipReason()
const gitUser = `u${randomBytes(6).toString('hex')}`
const gitReply = randomBytes(20).toString('hex')
let server: GitHttps | undefined
let gitWork: string | undefined

let app: ElectronApplication
let page: Page
let cdp: CDPSession
let userDataDir: string
let shimDir: string
let shims: Record<string, string>
let current: Viewport | null = null

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
  // The local git server for the Use a token dialog, with the fake login helper as the only helper git knows
  // (as lumopolis-private-repos.spec.ts runs it). The computer's own login helpers are kept out of the app.
  const gitEnv: Record<string, string> = {}
  if (missing === null) {
    gitWork = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-responsive-git-'))
    server = await startGitHttps({ user: gitUser, reply: gitReply, dir: path.join(gitWork, 'server') })
    const config = path.join(gitWork, 'helper.gitconfig')
    fs.writeFileSync(config, fakeHelperConfig())
    Object.assign(gitEnv, {
      GIT_SSL_CAINFO: server.caFile,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: config,
      FAKE_HELPER_LOG: path.join(gitWork, 'helper.log'),
      FAKE_HELPER_USER: gitUser,
      FAKE_HELPER_REPLY: gitReply,
    })
  }
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string' && !/^(GCM_|FAKE_HELPER_)/i.test(k)) env[k] = v
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
      ...env,
      ...shims,
      ...gitEnv,
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
  await setViewport(RUN[0])
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
  await server?.stop()
  for (const d of [userDataDir, shimDir, gitWork]) {
    try {
      if (d) fs.rmSync(d, { recursive: true, force: true })
    } catch {
      /* temp dir */
    }
  }
})

/** The window's size and DPR now, or 'ok' when it is `v` (within a pixel: the window's own display scaling leaves a
 *  rounding pixel under emulation). */
const sizeNow = (v: Viewport): Promise<string> =>
  page.evaluate(({ w, h, d }) => (Math.abs(innerWidth - w) <= 1 && Math.abs(innerHeight - h) <= 1 && Math.abs(devicePixelRatio - d) < 0.01 ? 'ok' : `${innerWidth}x${innerHeight}@${devicePixelRatio}`), { w: v.width, h: v.height, d: v.dpr })

async function emulate(v: Viewport): Promise<void> {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: v.width, height: v.height, deviceScaleFactor: v.dpr, mobile: false })
  await expect.poll(() => sizeNow(v), { timeout: 10_000 }).toBe('ok')
}

async function setViewport(v: Viewport): Promise<void> {
  if (current === v) return
  await emulate(v)
  current = v
}

async function shoot(name: string): Promise<void> {
  // A 4K or 5K frame drawn in software takes longer than the default 30 s to capture.
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), timeout: 120_000 })
  // Playwright puts the window's own DPR back after a screenshot. The session still holds the same override, so the
  // same one sent again is ignored: clear it, then set it.
  if (current && (await sizeNow(current)) !== 'ok') {
    await cdp.send('Emulation.clearDeviceMetricsOverride')
    await emulate(current)
  }
}

/** When the test started, for settleBudget. */
let testStarted = Date.now()
test.beforeEach(() => { testStarted = Date.now() })

/** Waits until the pane's layout has stopped changing (layoutAudit's steady), a soft failure when it never does. The
 *  wait scales by `slowness`: the city's moves run on the clock and end on time, but in the software-rendered 4K
 *  window each sample of the layout waits for a frame, and the label pass and the steady samples after a move take
 *  frames, not time. One wait takes at most a share of the test's time left (settleBudget), so a pane that never
 *  settles still leaves the test its other states. */
async function still(state: string): Promise<void> {
  const log: string[] = []
  const settled = await steady(page, PANE, settleBudget(15_000 * slowness, test.info().timeout, testStarted), log)
  expect.soft(settled, `${state}: the pane settled${settled ? '' : ` (samples: ${log.join(', ')}; still moving: ${await stillMoving(page, PANE)})`}`).toBe(true)
}

/** Audits the pane (or `root`) as it is now, every problem a soft failure under `state`; returns the median font. */
async function check(state: string, opts: AuditOptions = WORLD): Promise<number> {
  // Audited at the size under test, or the audit says nothing about it.
  if (current) expect(await sizeNow(current), `${state}: the window is at ${current.name}`).toBe('ok')
  await still(state)
  const r = await page.evaluate(layoutAudit, opts)
  expect.soft(r.texts, `${state}: the audit measured no text`).toBeGreaterThan(0)
  expect.soft(auditProblems(r), state).toEqual([])
  return medianFont(r)
}

/** The pane's median text is at least the laptop's times the scale the pane draws at, at its width `paneWidth`. */
function expectMedian(median: number, state: string, v: Viewport, paneWidth: number): void {
  const want = LAPTOP_MEDIAN * uiScale(v.width, v.height, paneWidth)
  expect.soft(median, `${state}: the median text size (want at least ${want.toFixed(1)} px)`).toBeGreaterThanOrEqual(want - 0.5)
}

/**
 * Clicks `target` with the mouse, at the middle of its box on screen. The pane's panels are CSS-zoomed on a big
 * screen, and the Chromium local runs use (Electron 30, before standard zoom) measures a zoomed element in the zoomed
 * box's own pixels, so Playwright's own click aims beside it there: the box is scaled up by the zoom it is under, as
 * src/renderer/src/world/engine/screenRect.ts does (Chromium 128 and later, which CI's Electron is, measures it on
 * screen already). When something else lies at that point, `strict` fails the test; otherwise the press falls back to
 * Enter on the focused element, the one place Electron 30 would force the keyboard, and the run says so.
 */
async function click(target: Locator, strict = false): Promise<void> {
  await expect(target).toBeVisible()
  const at = await target.evaluate((el) => {
    const r = el.getBoundingClientRect()
    let z = 1
    if (typeof (el as unknown as { currentCSSZoom?: unknown }).currentCSSZoom !== 'number') {
      for (let e: Element | null = el; e; e = e.parentElement) {
        const own = parseFloat(getComputedStyle(e).zoom)
        if (own > 0) z *= own
      }
    }
    const x = (r.left + r.width / 2) * z
    const y = (r.top + r.height / 2) * z
    const hit = document.elementFromPoint(x, y)
    return { x, y, hits: hit !== null && (hit === el || el.contains(hit)), label: el.getAttribute('data-testid') ?? el.textContent ?? '' }
  })
  if (strict) expect(at.hits, `the mouse lands on ${at.label} at ${Math.round(at.x)},${Math.round(at.y)}`).toBe(true)
  if (at.hits) {
    await page.mouse.click(at.x, at.y)
    return
  }
  test.info().annotations.push({ type: 'keyboard press', description: `${at.label}: something else lies at its middle, pressed with Enter` })
  await target.focus()
  await page.keyboard.press('Enter')
}

async function createTerminal(name: string, cwd: string): Promise<void> {
  await page.locator('button:has-text("+ Add Terminal")').first().click()
  const dialog = page.locator('h2:has-text("New Terminal")').locator('..')
  await expect(dialog).toBeVisible()
  await dialog.locator('input').first().fill(name)
  await dialog.locator('input[placeholder="Home directory"]').fill(cwd)
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.locator('main .xterm').first()).toBeVisible({ timeout: 30_000 })
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

/** Waits until the world is on the canvas and still. */
async function settled(compileMs = 120_000): Promise<void> {
  await expect(page.locator('[data-testid="world-canvas-host"] canvas')).toBeVisible({ timeout: compileMs })
  await expect(page.locator('[data-testid="world-canvas-host"]')).toHaveCSS('visibility', 'visible', { timeout: compileMs })
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __termpolis_world?: Probe }).__termpolis_world?.drawn().changing ?? -1), { timeout: 30_000 })
    .toBe(0)
  await still('the world')
}

/**
 * How many times slower than at 1080p a frame is in the window now: the test renders in software, so the time a frame
 * takes grows with the pixels drawn (at 3840x2160 about 226 ms). Waits that hang on frames scale by it.
 */
let slowness = 1

/** Clicks the first building found on a grid across the stage; true when its card opened. */
async function openCard(): Promise<boolean> {
  // A few tries: in the test's software-rendered 4K window a frame takes long enough that the city can
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
    if (await page.locator('[data-testid="world-card"]').waitFor({ state: 'visible', timeout: 15_000 * slowness }).then(() => true, () => false)) return true
  }
  return false
}

async function closeCard(): Promise<void> {
  const card = page.locator('[data-testid="world-card"]')
  if (await card.isVisible()) {
    await page.keyboard.press('Escape')
    if (await card.isVisible()) await click(card.getByRole('button', { name: /close/i }).first())
  }
  await expect(card).toHaveCount(0)
}

/** The pane's measured width, and what the room and the divider say about it. */
async function paneState(): Promise<{ pane: number; main: number; overlays: boolean; position: string; terminals: number; max: number | null }> {
  return page.evaluate((sel) => {
    const pane = document.querySelector(sel) as HTMLElement
    const main = document.querySelector('main') as HTMLElement
    const divider = document.querySelector('[data-testid="world-pane-divider"]')
    return {
      pane: pane.getBoundingClientRect().width,
      main: main.clientWidth,
      overlays: divider === null,
      position: getComputedStyle(pane).position,
      terminals: main.querySelectorAll('.xterm').length,
      max: divider ? Number(divider.getAttribute('aria-valuemax')) : null,
    }
  }, PANE)
}

/**
 * Drags the pane's divider with the mouse until the pane is `width` px wide (null: its default, 40% of the row), as a
 * person does, and checks the measured pane comes within SPLIT_TOLERANCE_PX of it. Returns the pane's width, or null
 * when the row has no room for that width (the run notes it and skips that width). Where the row is too narrow for
 * the pane beside the terminals there is no divider: the pane lies over the terminals across the row's width, and the
 * terminals stay mounted under it.
 */
async function split(width: number | null): Promise<number | null> {
  // The app measures the row after the window changes and lays the pane out again a frame later: wait for it to be
  // either over the terminals across their column or beside them, with the divider's limit measured on the new row
  // (the row less the terminals' 320 px minimum and the 4 px divider), not the last window's.
  await expect.poll(async () => {
    const now = await paneState()
    if (now.overlays) return Math.abs(now.pane - now.main) <= 1
    return now.position !== 'absolute' && now.max !== null && Math.abs(now.max - (now.main + now.pane - 320)) <= 2
  }, { message: 'the pane lies over the terminals or beside them, measured on this window', timeout: 10_000 }).toBe(true)
  const s = await paneState()
  if (s.overlays) {
    expect(s.position, 'the pane lies over the terminals').toBe('absolute')
    expect(Math.abs(s.pane - s.main), `the pane covers the terminals' column (${s.pane} of ${s.main} px)`).toBeLessThanOrEqual(1)
    await expect(page.locator('main')).toHaveCount(1)
    return width === null ? Math.round(s.pane) : null
  }
  // The room is the terminals' column, the divider and the pane; the default is 40% of it.
  const target = width ?? Math.max(360, Math.round((s.main + s.pane + 4) * 0.4))
  if (s.max !== null && target > s.max) {
    test.info().annotations.push({ type: 'skipped width', description: `${width} px: the row holds a pane of at most ${s.max} px here` })
    return null
  }
  const divider = page.locator('[data-testid="world-pane-divider"]')
  for (let attempt = 0; attempt < 3; attempt++) {
    const now = (await paneState()).pane
    if (Math.abs(now - target) <= SPLIT_TOLERANCE_PX) break
    const box = await divider.boundingBox()
    if (!box) throw new Error('the divider has no box')
    const x = box.x + box.width / 2
    const y = box.y + box.height / 2
    await page.mouse.move(x, y)
    await page.mouse.down()
    // To the right narrows the pane.
    await page.mouse.move(x + (now - target), y, { steps: 5 })
    await page.mouse.up()
    await expect.poll(async () => Math.abs((await paneState()).pane - now) > 0.5 || Math.abs(now - target) <= SPLIT_TOLERANCE_PX, { timeout: 10_000 }).toBe(true)
  }
  const got = (await paneState()).pane
  expect(Math.abs(got - target), `the dragged pane is ${Math.round(got)} px, asked for ${target}`).toBeLessThanOrEqual(SPLIT_TOLERANCE_PX)
  return Math.round(got)
}

/** Puts the window at `v` and the pane at `width`; the names a state is reported and saved under, or null to skip. */
async function layoutAt(v: Viewport, width: number | null): Promise<{ w: number; tag: string; name: string } | null> {
  await setViewport(v)
  slowness = Math.max(1, (v.width * v.height * v.dpr * v.dpr) / (1920 * 1080))
  const w = await split(width)
  if (w === null) return null
  return { w, tag: `${v.name} pane ${width === null ? 'default' : width} (${w}px)`, name: `${v.name}-${width === null ? 'default' : `w${width}`}` }
}

/** Every size and width the run checks. */
const LAYOUTS = RUN.flatMap((v) => widths(v).map((width) => ({ v, width })))

/**
 * The toolbar as a person sees it: how many rows its controls take (the close button in the corner and the
 * labelling cost line under the rows left out), and whether the close button sits beside the first row rather
 * than on a row of its own. Measured on screen, apart from how WorldToolbar counts its own rows.
 */
async function toolbarLayout(): Promise<{ rows: number; closeBeside: boolean }> {
  return page.evaluate(() => {
    const bar = document.querySelector('[aria-label="Lumopolis controls"]') as HTMLElement
    const close = bar.querySelector('[data-testid="world-close"]') as HTMLElement
    const rows: Array<{ top: number; bottom: number }> = []
    const boxes = Array.from(bar.querySelectorAll<HTMLElement>(':scope > *, :scope > * > button'))
      .filter((el) => el !== close && el.dataset.testid !== 'world-label-cost' && !el.closest('[role="group"]'))
      .map((el) => el.getBoundingClientRect())
      .filter((r) => r.width >= 1 && r.height >= 1)
      .sort((a, b) => a.top - b.top)
    for (const r of boxes) {
      const row = rows.find((w) => r.top < w.bottom && r.bottom > w.top)
      if (row) { row.top = Math.min(row.top, r.top); row.bottom = Math.max(row.bottom, r.bottom) } else rows.push({ top: r.top, bottom: r.bottom })
    }
    const c = close.getBoundingClientRect()
    const mid = (c.top + c.bottom) / 2
    return { rows: rows.length, closeBeside: rows.length > 0 && mid >= rows[0].top && mid <= rows[0].bottom }
  })
}

/** How many square pixels of the open card and the legend (its button or its panel) lie on each other. */
async function cardOnLegend(): Promise<number> {
  return page.evaluate(() => {
    const card = document.querySelector('[data-testid="world-card"]')
    const legend = document.querySelector('[data-testid="world-legend"]')
    if (!card || !legend) return 0
    const a = card.getBoundingClientRect()
    const b = legend.getBoundingClientRect()
    return Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top))
  })
}

/**
 * The map labels on show drawn fainter than the readable floor (LABEL_MIN_OPACITY in viewMath, 0.6), by text and
 * opacity. A label is either readable or not drawn: at 1280x800 on macOS a line label and a building name once sat
 * behind the scene at about 15% contrast. A label at opacity 0 (a floor name put away) is not on show.
 */
async function faintLabels(): Promise<string[]> {
  return page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('.lw-labels > *'))
    .map((el) => ({ el, cs: getComputedStyle(el) }))
    .filter(({ cs }) => cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0 && Number(cs.opacity) < 0.6 - 1e-6)
    .map(({ el, cs }) => `${el.textContent ?? ''} (${cs.opacity})`))
}

/**
 * Whether the open card shows its first heading and the first line under it without a scroll (true where it has no
 * heading). At 1280x800 on Linux the card once cut its "What it does" heading in half, and a line card stopped
 * mid-sentence, the one sentence that explains the line behind a scroll inside a scroll.
 */
async function cardShowsFirstLine(): Promise<boolean> {
  return page.evaluate(() => {
    const body = document.querySelector('[data-testid="world-card-body"]')
    const h = body?.querySelector('h4')
    if (!body || !h) return true
    const under = h.nextElementSibling ?? h
    const walk = document.createTreeWalker(under, NodeFilter.SHOW_TEXT, { acceptNode: (n) => ((n.textContent ?? '').trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP) })
    const text = walk.nextNode() ?? h.firstChild
    if (!text) return true
    const range = document.createRange()
    range.setStart(text, 0)
    range.setEnd(text, Math.min(1, (text.textContent ?? '').length))
    return range.getBoundingClientRect().bottom <= body.getBoundingClientRect().bottom + 0.5
  })
}

/** Opens the toolbar's More menu when the pane folds it (true), so a folded control can be reached. */
async function openMore(): Promise<boolean> {
  const more = page.locator('[data-testid="world-more"]')
  if (!(await more.isVisible())) return false
  if ((await more.getAttribute('aria-expanded')) !== 'true') await click(more)
  await expect(page.locator('[data-testid="world-more-menu"]')).toBeVisible()
  return true
}

async function closeMore(): Promise<void> {
  const more = page.locator('[data-testid="world-more"]')
  if ((await more.count()) === 0 || (await more.getAttribute('aria-expanded')) !== 'true') return
  await click(more)
  await expect(page.locator('[data-testid="world-more-menu"]')).toHaveCount(0)
}

/** Presses a toolbar control that a narrow pane folds into More, leaving the menu shut. */
async function pressFolded(testid: string): Promise<void> {
  await openMore()
  await click(page.locator(`[data-testid="${testid}"]`))
  await closeMore()
}

const home = (): Locator => page.locator('[data-testid="world-home"]')

async function closePane(): Promise<void> {
  await click(page.locator('[data-testid="world-close"]'))
  await expect(page.locator(PANE)).toHaveCount(0)
}

/** Checks the dialog `testid` at every size and width of the run, opened once by `open` and closed by its Cancel. */
async function checkDialog(testid: string, label: string, open: () => Promise<void>): Promise<void> {
  const dialog = page.locator(`[data-testid="${testid}"]`)
  await open()
  await expect(dialog).toBeVisible({ timeout: 30_000 })
  for (const { v, width } of LAYOUTS) {
    const at = await layoutAt(v, width)
    if (!at) continue
    await check(`${label} dialog at ${at.tag}`, { root: `[data-testid="${testid}"]`, panels: [] })
    await shoot(`app-dialog-${label}-${at.name}`)
  }
  // Esc closes the dialog and only it (the dialog on top: the token dialog leaves the clone dialog under it); the
  // pane stays open.
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(page.locator(PANE)).toBeVisible()
}

test.describe.serial('Lumopolis at every screen size', () => {
  test('the home and its dialogs fit at every size and width', async () => {
    test.setTimeout(900_000)
    await openPane()
    await expect(home()).toBeVisible({ timeout: 30_000 })
    for (const { v, width } of LAYOUTS) {
      const at = await layoutAt(v, width)
      if (!at) continue
      expectMedian(await check(`home at ${at.tag}`), `home at ${at.tag}`, v, at.w)
      await shoot(`app-home-${at.name}`)
    }
    await checkDialog('world-design-start', 'design', () => click(home().getByRole('button', { name: /^Design something new/ })))
    await checkDialog('world-clone', 'clone', () => click(home().getByRole('button', { name: /^Open a git repository/ })))
    if (server) {
      // Use a token: a clone of the local server meets its sign-in and offers it. The dialog is checked and cancelled.
      await setViewport(RUN[0])
      await split(null)
      await click(home().getByRole('button', { name: /^Open a git repository/ }))
      const clone = page.locator('[data-testid="world-clone"]')
      await clone.getByPlaceholder('https://github.com/owner/repo.git').fill(server.url)
      await click(clone.getByRole('button', { name: 'Clone', exact: true }))
      await expect(page.locator('[data-testid="world-clone-use-token"]')).toBeVisible({ timeout: 60_000 })
      await checkDialog('world-repo-access', 'token', () => click(page.locator('[data-testid="world-clone-use-token"]')))
      await click(clone.getByRole('button', { name: 'Cancel', exact: true }))
      await expect(clone).toHaveCount(0)
    } else {
      test.info().annotations.push({ type: 'skipped dialog', description: `Use a token: the local https git server cannot run here: ${missing}` })
    }
    await closePane()
  })

  test('a loaded world, its card, More menu, 2D map, answer and dialogs fit at every size and width', async () => {
    // The full matrix walks 11 sizes at three widths, the 5K ones at several seconds a frame.
    test.setTimeout(FULL ? 10_800_000 : 3_000_000)
    await setViewport(RUN[RUN.length - 1])
    await createTerminal('Repo', path.resolve('.'))
    await openPane()
    await settled(180_000)
    let clickedZoomed = false
    for (const { v, width } of LAYOUTS) {
      const at = await layoutAt(v, width)
      if (!at) continue
      await settled()
      const { tag, name } = at
      if (width === null && (v.name === '768x1024' || (await paneState()).overlays)) {
        expect((await paneState()).terminals, `the terminals stay mounted under the pane at ${tag}`).toBeGreaterThan(0)
      }
      expectMedian(await check(`world at ${tag}`), `world at ${tag}`, v, at.w)
      // The toolbar keeps to two rows, its close button beside the first (at 1280x800 on Linux it once took four
      // rows, the close button alone on the last).
      const bar = await toolbarLayout()
      expect.soft(bar.rows, `the toolbar keeps to two rows at ${tag}`).toBeLessThanOrEqual(2)
      expect.soft(bar.closeBeside, `the close button sits beside the toolbar's first row at ${tag}`).toBe(true)
      expect.soft(await faintLabels(), `no map label is drawn too faint to read at ${tag}`).toEqual([])
      await shoot(`app-world-${name}`)

      const toggle = page.locator('[data-testid="world-legend-toggle"]')
      if (await toggle.isVisible()) {
        const before = await toggle.getAttribute('aria-expanded')
        // One real mouse click on a zoomed button (the pane draws at 1.5 at 4K), where it must land.
        const zoomed = uiScale(v.width, v.height, at.w) > 1
        await click(toggle, zoomed && !clickedZoomed)
        if (zoomed) clickedZoomed = true
        await expect(toggle).not.toHaveAttribute('aria-expanded', before ?? '')
        await check(`legend toggled at ${tag}`)
        await shoot(`app-legend-${name}`)
        await click(toggle)
        await expect(toggle).toHaveAttribute('aria-expanded', before ?? '')
      }

      expect.soft(await openCard(), `a building's card opened at ${tag}`).toBe(true)
      // The card never lies on the legend (at 1280x800 on Linux it once covered most of the Legend button).
      expect.soft(await cardOnLegend(), `the card leaves the legend clear at ${tag}`).toBe(0)
      expect.soft(await cardShowsFirstLine(), `the card shows its first heading and the line under it at ${tag}`).toBe(true)
      // With a part selected the rest is dimmed: names too faint to read are put away, not drawn as a smudge.
      expect.soft(await faintLabels(), `no map label is drawn too faint to read with the card open at ${tag}`).toEqual([])
      await check(`card at ${tag}`)
      await shoot(`app-card-${name}`)
      await closeCard()

      if (await openMore()) {
        await check(`More menu at ${tag}`)
        await shoot(`app-more-${name}`)
        await closeMore()
      }

      const host = page.locator('[data-testid="world-canvas-host"]')
      await pressFolded('world-map2d')
      await expect(host).toHaveCSS('visibility', 'hidden')
      await check(`2D map at ${tag}`)
      await shoot(`app-map2d-${name}`)
      await pressFolded('world-map2d')
      await expect(host).toHaveCSS('visibility', 'visible')

      if (width === null) {
        const askBox = page.getByPlaceholder('Ask about this project…')
        await askBox.fill('How does the memory search work?')
        await askBox.press('Enter')
        // The ask reads the stored world with a 15 s limit; in this software-rendered window, with the repo's own
        // world refreshing as the run writes screenshots into it, that read can run out once. The app then offers
        // Retry, which is what a person would press: the size checks are about the answer once it is there. The
        // answer comes from a mock agent started through PowerShell, which can take a while to start on a busy
        // machine, so the waits are the app's own limits: 15 s to read the world and 90 s for the agent.
        const ASK_MS = 15_000 + 90_000
        const answer = page.locator('[data-testid="world-answer"]')
        const retry = page.getByRole('alert').getByRole('button', { name: 'Retry' })
        await expect(answer.or(retry).first()).toBeVisible({ timeout: ASK_MS })
        if (await retry.isVisible()) {
          test.info().annotations.push({ type: 'ask retried', description: `the world read ran out at ${tag}` })
          await click(retry)
        }
        await expect(answer).toBeVisible({ timeout: ASK_MS })
        await check(`answer at ${tag}`)
        await shoot(`app-answer-${name}`)
        await click(page.getByRole('button', { name: 'Close answer' }))
        await expect(page.locator('[data-testid="world-answer"]')).toHaveCount(0)
        // An answer shows its first part in the map, with that part's card open: shut it, so the next size starts
        // from the bare world.
        await closeCard()
      }

      for (const [item, testid, label] of [['world-export-world', 'world-export-dialog', 'export'], ['world-export-document', 'world-document-dialog', 'document']] as const) {
        await click(page.locator('[data-testid="world-export"]'))
        await click(page.locator(`[data-testid="${item}"]`))
        // The Document dialog opens after a picture of the map is taken on the next frame: in the test's
        // software-rendered 4K window a frame and the picture take seconds, not the milliseconds a GPU takes.
        await expect(page.locator(`[data-testid="${testid}"]`)).toBeVisible({ timeout: 30_000 })
        await check(`${label} dialog at ${tag}`, { root: `[data-testid="${testid}"]`, panels: [] })
        await shoot(`app-dialog-${label}-${name}`)
        await page.keyboard.press('Escape')
        if (await page.locator(`[data-testid="${testid}"]`).isVisible()) await click(page.locator(`[data-testid="${testid}"]`).getByRole('button', { name: /^(Cancel|Close)$/ }).first())
        await expect(page.locator(`[data-testid="${testid}"]`)).toHaveCount(0)
      }
    }
    expect(clickedZoomed, 'a zoomed button was clicked with the mouse').toBe(RUN.some((v) => uiScale(v.width, v.height) > 1))
  })

  test("a design's Build it dialog fits at every size and width", async () => {
    test.setTimeout(900_000)
    await setViewport(RUN[RUN.length - 1])
    await split(null)
    await page.getByRole('combobox', { name: 'Worlds' }).selectOption('__home')
    await expect(home()).toBeVisible()
    await click(home().getByRole('button', { name: /^Design something new/ }))
    const start = page.getByRole('dialog', { name: 'Design something new' })
    await start.getByPlaceholder('Describe the app you want…').fill('A small shop with a catalog and orders')
    await click(start.getByRole('button', { name: 'Design it' }))
    await expect(page.locator('[data-testid="world-build-it-open"]')).toBeVisible({ timeout: 60_000 })
    await checkDialog('world-build-it', 'build', () => click(page.locator('[data-testid="world-build-it-open"]')))
  })
})
