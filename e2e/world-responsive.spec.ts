/**
 * Lumopolis in the real app from a tablet to a 4K monitor, with the pane at its own default width and dragged
 * narrow beside the terminals by its divider: acceptance items 1, 2, 3, 5 and 6 of the responsive brief, measured
 * in the DOM by e2e/helpers/layoutAudit.ts. No text overlaps text, a panel or the toolbar (the map's labels
 * included); no text is cut off; nothing scrolls across; nothing is under 12 CSS px; and the pane's median text is
 * at least the laptop's 12 px times the pane's own scale (uiScale), so on a big screen at DPR 1 it grows.
 *
 * States: the home and its dialogs (Design something new, Open a git repository…, Use a token), a loaded world in
 * 3D with the legend both ways, a building's card, the toolbar's More menu where the pane folds it, the 2D map, an
 * Ask answer, the Export and Document dialogs, and the Build it dialog of a design; and an Ask answer made while memory
 * says it is locked, with the note that says so, at 768x1024 and 5120x2880 (WPA fix M8: the memory process runs behind
 * e2e/mocks/memory-host-lockable.mjs, the real one with a lock switch). Every state is saved as a PNG
 * (RESPONSIVE_SHOTS, default test-results/responsive-shots) for the contact sheet.
 *
 * Sizes: the blocking run checks BLOCKING_VIEWPORTS (768x1024, 1366x768, 1920x1080, 3840x2160) at the pane's
 * default width, and 3840x2160 also with the pane dragged to 640 and 480 px, where the narrow pane's scale floor
 * shows. RESPONSIVE_FULL=1 checks every size of VIEWPORTS (DPR 1 and 2) at all three widths, by hand;
 * RESPONSIVE_ONLY names sizes to look at again. RESPONSIVE_REDUCED=1 (the macOS CI job, whose software-rendered 4K
 * run would not fit the job's time) checks a MacBook's 1280x800 and 1440x900 at DPR 2 at the default width, and the
 * larger dragged to 480 (paneWidths). At 768x1024 the row has no room for the pane beside the terminals,
 * so the pane lies over them, which is checked too.
 *
 * The world is this repository with labelling off (names from the code); the Ask answer and the design are
 * mock-claude's canned ones (MOCK_CLAUDE_WORLD_ANSWER), as in world-ask.spec.ts and lumopolis-sources.spec.ts, the
 * answer a typical short paragraph citing two pieces of evidence (MOCK_CLAUDE_ANSWER_PARAGRAPH, seedEvidence). The
 * Use a token dialog comes from a clone of the local https git server of lumopolis-private-repos.spec.ts, with its
 * fake login helper; nothing is ever signed in or sent, and without that server (no git-http-backend or openssl)
 * that one dialog is skipped and says so.
 */
import { test, expect, type ElectronApplication, type Page, type CDPSession, type Locator } from '@playwright/test'
import { _electron as electron } from 'playwright'
import { randomBytes } from 'crypto'
import { PNG } from 'pngjs'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { quitApp, ensureE2eBuild, e2eShimEnv } from './helpers/launch'
import { auditProblems, layoutAudit, medianFont, paneWidths, responsiveViewports, REDUCED_SPLIT_AT, settleBudget, stillMoving, steady, VIEWPORTS, type AuditOptions, type Viewport } from './helpers/layoutAudit'
import { uiScale } from '../src/shared/world/uiScale'
import { CORNER_MAX_LEVELS, cornerPatches, drawnBackground, levelsApart, MAX_WHITE_FRACTION, MIN_LIT_FRACTION, pngMetrics } from './worldPixels'
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
  '[data-map-panel]', // an open toolbar menu (Bookmarks, More, Export): no map label under it
]
// An open toolbar menu drops over the legend and the map on purpose; what it covers is hidden while it is open.
const WORLD: AuditOptions = { root: PANE, panels: PANELS, popups: ['[data-map-panel]'] }
const RUN = responsiveViewports()
const FULL = process.env.RESPONSIVE_FULL === '1'
/** askRunner's MAP_FAILED: the ask could not read the stored world, and offers Retry. */
const MAP_FAILED = "Lumopolis couldn't load this project's map. Try again."
/** Soft polls: a size that fails one is recorded, and the run goes on to the next. */
const softly = expect.configure({ soft: true })
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
/** The memory process's lock switch (e2e/mocks/memory-host-lockable.mjs): the word `locked` in it makes the memory say it is locked. */
let memoryLockFile: string
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
  // Held at High (look spec §5.1), the tier these checks were set at: the painted check's corners are the background as
  // the composer tone maps it, and its lit share counts the bloom. Auto, drawn in software as here, starts at Flat, which
  // draws the background as it is and lights less of the canvas.
  fs.writeFileSync(path.join(userDataDir, 'world-settings.json'), JSON.stringify({ worldLabelling: false, quality: 'high' }))
  memoryLockFile = path.join(userDataDir, 'test-memory-lock')
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
  // (as lumopolis-private-repos.spec.ts runs it). The computer's own login helpers are kept out of the app. The
  // app's Lumopolis git leaves an inherited GIT_CONFIG_GLOBAL out, so the helper config is git's XDG global config
  // ($XDG_CONFIG_HOME/git/config; GIT_CONFIG_GLOBAL names it too). On Windows HOME, which there moves only git's
  // home, points at an empty folder as well, so no ~/.gitconfig of the computer is read.
  const gitEnv: Record<string, string> = {}
  if (missing === null) {
    gitWork = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-responsive-git-'))
    server = await startGitHttps({ user: gitUser, reply: gitReply, dir: path.join(gitWork, 'server') })
    const gitHome = path.join(gitWork, 'home')
    fs.mkdirSync(path.join(gitHome, 'xdg', 'git'), { recursive: true })
    const config = path.join(gitHome, 'xdg', 'git', 'config')
    fs.writeFileSync(config, fakeHelperConfig())
    Object.assign(gitEnv, {
      GIT_SSL_CAINFO: server.caFile,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: config,
      XDG_CONFIG_HOME: path.join(gitHome, 'xdg'),
      ...(process.platform === 'win32' ? { HOME: gitHome } : {}),
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
      MOCK_CLAUDE_ANSWER_PARAGRAPH: '1',
      MOCK_CLAUDE_REPLY_DELAY_MS: '300',
      // The real memory process behind a switch that can make it say it is locked (WPA fix M8, the last world test).
      TERMPOLIS_TEST_MEMORY_HOST_PATH: path.resolve('e2e', 'mocks', 'memory-host-lockable.mjs'),
      TERMPOLIS_TEST_MEMORY_REAL_HOST: path.resolve('out', 'main', 'memoryHost.js'),
      TERMPOLIS_TEST_MEMORY_LOCK_FILE: memoryLockFile,
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

/** A size's pixels over a 1080p screen's: how much longer than there a frame drawn in software takes, at least 1. */
const frameCost = (s: Viewport | null): number => Math.max(1, s ? (s.width * s.height * s.dpr * s.dpr) / (1920 * 1080) : 1)

async function emulate(v: Viewport): Promise<void> {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: v.width, height: v.height, deviceScaleFactor: v.dpr, mobile: false })
  // The page answers once its frame is drawn: a 5K frame drawn in software, at the size left or the size asked for,
  // can take longer than 10 s on its own.
  await expect.poll(() => sizeNow(v), { timeout: 10_000 * Math.max(frameCost(current), frameCost(v)) }).toBe('ok')
}

async function setViewport(v: Viewport): Promise<void> {
  if (current === v) return
  await emulate(v)
  current = v
}

async function shoot(name: string): Promise<void> {
  // A 4K or 5K frame drawn in software takes longer than the default 30 s to capture.
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), timeout: 120_000 })
  await reEmulate()
}

/**
 * Playwright puts the window's own DPR back after a screenshot. The session still holds the same override, so the
 * same one sent again is ignored: clear it, then set it.
 */
async function reEmulate(): Promise<void> {
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

/**
 * Waits until the world is on the canvas and still. The changes a newer world plays (rises, pulses, fades) are
 * counted on the wall clock, so they end about a second after it loads; the wait for them still gets the caller's
 * budget, as a world just swapped in at 5K, drawn in software, once held the count open for over 30 s.
 */
async function settled(compileMs = 120_000): Promise<void> {
  await expect(page.locator('[data-testid="world-canvas-host"] canvas')).toBeVisible({ timeout: compileMs })
  await expect(page.locator('[data-testid="world-canvas-host"]')).toHaveCSS('visibility', 'visible', { timeout: compileMs })
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __termpolis_world?: Probe }).__termpolis_world?.drawn().changing ?? -1), { timeout: compileMs })
    .toBe(0)
  await still('the world')
}

/** Whether the stored world of `root` is still the first map drawn from the file listing (or no world yet): a
 *  repository past the host's first-map size (Termpolis itself) is drawn that way first, with its "Still reading the
 *  files" notice up, and settles in place once the complete world is done. */
const provisional = (root: string): Promise<boolean> =>
  page.evaluate(async (r) => {
    const api = (window as unknown as { termpolis: { gitFindRoot: (c: string) => Promise<{ success: boolean; data?: string }>; worldGet: (c: string) => Promise<{ success: boolean; data?: { provisional?: boolean } | null }> } }).termpolis
    const top = await api.gitFindRoot(r)
    const res = await api.worldGet(top.success && top.data ? top.data : r)
    return !res.success || !res.data || res.data.provisional === true
  }, root)

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

/** Clicks the first district slab found on a grid across the stage (from the overview a big city's district is one
 *  slab, and a click on it frames its buildings); false when none is under the bare canvas. */
async function intoDistrict(): Promise<boolean> {
  const at = await page.evaluate(() => {
    const probe = (window as unknown as { __termpolis_world?: Probe }).__termpolis_world
    const host = document.querySelector('[data-testid="world-canvas-host"]')
    if (!probe || !host) return null
    const r = host.getBoundingClientRect()
    for (let row = 4; row <= 44; row++) {
      for (let col = 4; col <= 44; col++) {
        const x = r.left + (r.width * col) / 48
        const y = r.top + (r.height * row) / 48
        const el = document.elementFromPoint(x, y)
        if (el && host.contains(el) && probe.pickAt(x, y)?.kind === 'district') return { x, y }
      }
    }
    return null
  })
  if (!at) return false
  await page.mouse.click(at.x, at.y)
  return true
}

/**
 * Opens a building's card as a person would: a building found from the overview, or else a district stepped into
 * first (a click on its slab frames its buildings). A big city in a tall, narrow pane shows its districts as slabs
 * with no building the grid can hit: at 3840x2160 with the pane at 640 or 480 the termpolis repository's overview
 * opened only the orb of t.example.com, a reserved test host, which Lumopolis no longer draws as an outside service.
 */
async function openCardInCity(where: string): Promise<boolean> {
  if (await openCard()) return true
  if (!(await intoDistrict())) return false
  await glideDone(`district at ${where}`)
  return openCard()
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
  }, { message: 'the pane lies over the terminals or beside them, measured on this window', timeout: 10_000 * frameCost(current) }).toBe(true)
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
    await expect.poll(async () => Math.abs((await paneState()).pane - now) > 0.5 || Math.abs(now - target) <= SPLIT_TOLERANCE_PX, { timeout: 10_000 * frameCost(current) }).toBe(true)
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
const LAYOUTS = RUN.flatMap((v) => paneWidths(v).map((width) => ({ v, width })))

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

/** How many square pixels of the boxes of `a` and `b` lie on each other (0 when either is not on screen). */
async function overlapOf(a: string, b: string): Promise<number> {
  return page.evaluate(([sa, sb]) => {
    const x = document.querySelector(sa)
    const y = document.querySelector(sb)
    if (!x || !y) return 0
    const p = x.getBoundingClientRect()
    const q = y.getBoundingClientRect()
    return Math.max(0, Math.min(p.right, q.right) - Math.max(p.left, q.left)) * Math.max(0, Math.min(p.bottom, q.bottom) - Math.max(p.top, q.top))
  }, [a, b] as const)
}

/** The layouts the notice is checked at (fix round 1, I4): the 416 px pane it covered the legend in at 1280x800@2x,
 *  that size's default pane, a tablet and 5K. The macOS reduced run keeps to the MacBook size. */
const NOTICE_LAYOUTS: Array<{ v: Viewport; width: number | null }> = [
  { name: '1280x800@2x', width: 416 },
  { name: '1280x800@2x', width: null },
  { name: '768x1024', width: null },
  { name: '5120x2880', width: null },
]
  .filter((l) => process.env.RESPONSIVE_REDUCED !== '1' || l.name === '1280x800@2x')
  .map((l) => ({ v: VIEWPORTS.find((x) => x.name === l.name) as Viewport, width: l.width }))

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
 * The share of the map's pixels brighter than its background (its most common tone), labels and panels hidden: the
 * stars and the city. At 5120x2880 with the pane 480 wide the overview stood past the camera's far plane once, and
 * the whole map was black.
 */
async function litShare(): Promise<number> {
  const style = await page.addStyleTag({
    content: '.lw-labels, [data-testid="world-stage"] > :not([data-testid="world-canvas-host"]) { visibility: hidden !important }',
  })
  try {
    await page.waitForTimeout(300)
    // A clip of the page, not an element shot: at 5K a frame takes seconds, and an element shot waits for two frames
    // in a row with the canvas still, which once ran out its time after half an hour of sizes. CSS scale keeps the
    // PNG at the layout's own size.
    const box = await page.locator('[data-testid="world-canvas-host"] canvas').first().boundingBox()
    if (!box) return 0
    const png = PNG.sync.read(await page.screenshot({ clip: box, scale: 'css', timeout: 120_000 }))
    await reEmulate()
    const n = png.width * png.height
    const ys = new Uint8Array(n)
    const hist = new Array<number>(256).fill(0)
    for (let p = 0; p < n; p++) {
      const i = p * 4
      ys[p] = Math.round(0.2126 * png.data[i] + 0.7152 * png.data[i + 1] + 0.0722 * png.data[i + 2])
      hist[ys[p]]++
    }
    const bg = hist.indexOf(Math.max(...hist))
    lastLitBackground = bg
    let lit = 0
    for (const y of ys) if (y > bg + 24) lit++
    return lit / n
  } finally {
    await style.evaluate((el) => (el as Element).remove())
  }
}
/** The background tone litShare last measured (0 black, 255 white), for mapCanvasState. */
let lastLitBackground = -1

/**
 * What the map's canvas held, for the message of an unlit map: the shot's background tone, the canvas's size on the
 * page and its drawing buffer's, whether its WebGL context is lost, and the GPU's MAX_RENDERBUFFER_SIZE and
 * MAX_VIEWPORT_DIMS. Asking the canvas for webgl2 hands back the viewer's own context; it makes none.
 */
async function mapCanvasState(): Promise<string> {
  const state = await page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>('[data-testid="world-canvas-host"] canvas')
    if (!c) return 'no canvas'
    const gl = c.getContext('webgl2') as WebGL2RenderingContext | null
    if (!gl) return `canvas ${c.clientWidth}x${c.clientHeight}, buffer ${c.width}x${c.height}, no webgl2 context`
    const lost = gl.isContextLost()
    const rb = lost ? '?' : String(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE))
    const vp = lost ? '?' : Array.from(gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array).join('x')
    return `canvas ${c.clientWidth}x${c.clientHeight}, buffer ${gl.drawingBufferWidth}x${gl.drawingBufferHeight} of ${c.width}x${c.height}, context lost ${lost}, max renderbuffer ${rb}, max viewport ${vp}`
  })
  return `background ${lastLitBackground}, ${state}`
}

/**
 * Whether the open card shows a typical answer without a scroll: its first heading and the first two items after it
 * (a claim, a sentence or a list entry; true where it has fewer), the second ending above the fade while more lies
 * below (CARD_FADE_PX). At 1366x768 with an answer open the card was held at its 168 px minimum and its first items
 * scrolled.
 */
async function cardShowsTwoItems(): Promise<boolean> {
  return page.evaluate((fade) => {
    const body = document.querySelector('[data-testid="world-card-body"]')
    const h = body?.querySelector('h4')
    if (!body || !h) return true
    const items: Element[] = []
    for (let el = h.nextElementSibling; el && items.length < 2; el = el.nextElementSibling) {
      if (el.tagName === 'H4') continue
      if (el.tagName === 'UL' || el.tagName === 'OL') items.push(...Array.from(el.children).slice(0, 2 - items.length))
      else items.push(el)
    }
    if (items.length === 0) return true
    const end = body.getBoundingClientRect().bottom - (body.hasAttribute('data-more') ? fade : 0)
    return items[items.length - 1].getBoundingClientRect().bottom <= end + 0.5 && body.scrollTop === 0
  }, CARD_FADE_PX)
}

/**
 * Whether the open card shows the start of its first line without a scroll: the first character of the first text
 * under its first heading (the heading itself where nothing follows) ends above the card body's bottom edge. True
 * when the card has no heading. Measured on the character, not the element, since a long claim wraps: a card too
 * short for its first claim once showed the heading and nothing under it.
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

/**
 * The problems of the open card's bottom edge, empty when there are none: a line of text cut by the edge must lie in
 * the fade (WorldCard's CARD_FADE_PX), and the fade must be drawn while anything lies below. A card held at its cap
 * once cut a list item in half at its bottom edge, with nothing to say more lay below.
 */
async function cardEdgeProblems(): Promise<string[]> {
  return page.evaluate((fade) => {
    const body = document.querySelector<HTMLElement>('[data-testid="world-card-body"]')
    if (!body) return []
    const edge = body.getBoundingClientRect().bottom
    const out: string[] = []
    let below = false
    const walk = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, { acceptNode: (n) => ((n.textContent ?? '').trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP) })
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const range = document.createRange()
      range.selectNodeContents(n)
      for (const r of Array.from(range.getClientRects())) {
        if (r.height < 1) continue
        if (r.bottom > edge + 0.5) below = true
        // A line the edge cuts starts above it and ends below it; it must start inside the fade.
        if (r.top < edge - 0.5 && r.bottom > edge + 0.5 && r.top < edge - fade - 0.5) {
          out.push(`"${(n.textContent ?? '').trim().slice(0, 30)}" is cut at the edge ${Math.round(edge - r.top)} px into it, above the ${fade} px fade`)
        }
      }
    }
    const cs = getComputedStyle(body) as CSSStyleDeclaration & { webkitMaskImage?: string }
    const mask = cs.maskImage || cs.webkitMaskImage || 'none'
    if (below && (!body.hasAttribute('data-more') || mask === 'none')) out.push('text lies below the edge with no fade drawn')
    return out
  }, CARD_FADE_PX)
}

/** WorldCard's CARD_FADE_PX: how deep the card's bottom edge fades while more lies below. */
const CARD_FADE_PX = 24

/**
 * The problems of the open answer, empty when it reads without a scroll: its scroller at the top, and its first line
 * (the heading) and its first two evidence chips (E1 and E2) wholly inside the scroller's box. A chip that is not
 * there (the answer still appearing, or the prompt carried no evidence) is named.
 */
async function answerProblems(): Promise<string[]> {
  return page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>('[data-testid="world-answer-scroll"]')
    const text = document.querySelector('[data-testid="world-answer-text"]')
    if (!scroller || !text) return ['no answer on show']
    const out: string[] = []
    if (scroller.scrollTop !== 0) out.push(`the answer is scrolled ${scroller.scrollTop} px`)
    const box = scroller.getBoundingClientRect()
    const inside = (r: DOMRect): boolean => r.top >= box.top - 0.5 && r.bottom <= box.bottom + 0.5 && r.left >= box.left - 0.5 && r.right <= box.right + 0.5
    // The heading: the first paragraph up to its first line break.
    const first = text.firstElementChild
    if (!first) out.push('the answer has no text')
    else {
      const range = document.createRange()
      range.setStart(first, 0)
      const br = first.querySelector('br')
      if (br) range.setEndBefore(br)
      else range.setEnd(first, first.childNodes.length)
      const lines = Array.from(range.getClientRects()).filter((r) => r.width >= 1 && r.height >= 1)
      if (lines.length === 0 || !lines.every(inside)) out.push('the heading is not wholly on show')
    }
    for (const label of ['E1', 'E2']) {
      const chip = scroller.querySelector(`button[data-evidence="${label}"]`)
      if (!chip) out.push(`no ${label} chip`)
      else if (!inside(chip.getBoundingClientRect())) out.push(`the ${label} chip is not wholly on show`)
    }
    return out
  })
}

/** WorldLegend's LEGEND_ASIDE_PX: from this canvas width (in the legend's own pixels) the opened legend's strip is kept clear. */
const LEGEND_ASIDE_PX = 600

/** threeRenderer's BUFFER_SETTLE_MS: how long the view's size holds before its drawing buffer is fitted to it (the e2e run does not load three). */
const BUFFER_SETTLE_MS = 150

/**
 * What of the city lies under the opened legend's panel: the building names on show whose boxes meet it, and the
 * buildings a click would pick at a grid of points over it (every 8 px), whatever is drawn over them. Round 3 saw the
 * opened legend lie over the city in a 640 px pane at 1366x768. The panel's box is scaled by the zoom it is under, as
 * click() does, where Chromium measures a zoomed box in its own pixels.
 */
async function underLegend(): Promise<{ names: string[]; buildings: string[] }> {
  return page.evaluate(() => {
    type Pick = { kind: string; id: string } | null
    const legend = document.querySelector('[data-testid="world-legend"]')
    const probe = (window as unknown as { __termpolis_world?: { pickAt(x: number, y: number): Pick } }).__termpolis_world
    if (!legend || !probe) return { names: [], buildings: [] }
    let z = 1
    if (typeof (legend as unknown as { currentCSSZoom?: unknown }).currentCSSZoom !== 'number') {
      for (let e: Element | null = legend; e; e = e.parentElement) {
        const own = parseFloat(getComputedStyle(e).zoom)
        if (own > 0) z *= own
      }
    }
    const b = legend.getBoundingClientRect()
    const L = { left: b.left * z, top: b.top * z, right: b.right * z, bottom: b.bottom * z }
    const meets = (r: DOMRect): boolean => Math.min(r.right, L.right) - Math.max(r.left, L.left) > 0.5 && Math.min(r.bottom, L.bottom) - Math.max(r.top, L.top) > 0.5
    const names = Array.from(document.querySelectorAll<HTMLElement>('.lw-labels > *'))
      .filter((el) => {
        const cs = getComputedStyle(el)
        return cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0 && meets(el.getBoundingClientRect())
      })
      .map((el) => el.textContent ?? '')
    const ids = new Set<string>()
    for (let y = L.top + 4; y < L.bottom; y += 8) {
      for (let x = L.left + 4; x < L.right; x += 8) {
        const hit = probe.pickAt(x, y)
        if (hit && hit.kind === 'node') ids.add(hit.id)
      }
    }
    return { names, buildings: Array.from(ids) }
  })
}

/**
 * Waits for the camera's glide to end (the probe's flight) after a change that refits the city, then for the pane to
 * be still. Two frames go first, so a glide the change has yet to start is not read as over.
 */
async function glideDone(state: string): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => {
    const done = setTimeout(resolve, 1000)
    requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(done); resolve() }))
  }))
  await expect.poll(
    () => page.evaluate(() => (window as unknown as { __termpolis_world?: { drawn(): { visual: { flight: { active: boolean } } } } }).__termpolis_world?.drawn().visual.flight.active ?? false),
    { message: `${state}: the camera's glide ends`, timeout: 15_000 * slowness },
  ).toBe(false)
  await still(state)
}

/**
 * With the legend opened and the canvas wide enough for its strip to be kept clear (legendReserveFrom), no building
 * and no building name lies under its panel. `scale` is the pane's uiScale.
 */
async function expectLegendClear(state: string, scale: number): Promise<void> {
  const toggle = page.locator('[data-testid="world-legend-toggle"]')
  if ((await toggle.count()) === 0 || (await toggle.getAttribute('aria-expanded')) !== 'true') return
  const wide = await page.evaluate((min) => {
    const host = document.querySelector('[data-testid="world-canvas-host"]')
    return host !== null && host.getBoundingClientRect().width >= min
  }, LEGEND_ASIDE_PX * scale)
  if (!wide) return
  const under = await underLegend()
  expect.soft(under.buildings, `${state}: no building lies under the opened legend`).toEqual([])
  expect.soft(under.names, `${state}: no building name lies under the opened legend`).toEqual([])
}

/**
 * Gives the stored world's buildings evidence for an answer to cite: labelling is off here, so they have none, and
 * an ask's prompt would carry no E labels. Each building with files and no how-claim gets one, citing its first two
 * files (repository-relative, as the store requires). The ask reads the stored world afresh, so its prompt carries E1
 * and E2 for mock-claude's paragraph; the pane's own copy, and so its cards, stay as drawn. A compile that saves in
 * between drops them again, which answerProblems names as a missing chip. Written whole and moved into place, so the
 * world host never reads half a file. Returns how many buildings were given one.
 */
function seedEvidence(): number {
  const dir = path.join(userDataDir, 'world')
  let seeded = 0
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (!name.endsWith('.json') || name.endsWith('.stages.json')) continue
    const file = path.join(dir, name)
    let doc: { buildings?: Array<{ how?: unknown[]; members?: unknown[] }> }
    try {
      doc = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      continue
    }
    if (!Array.isArray(doc.buildings)) continue
    let changed = false
    for (const b of doc.buildings) {
      const files = (Array.isArray(b.members) ? b.members : []).filter((m): m is string => typeof m === 'string' && m !== '' && !path.isAbsolute(m) && !/^[A-Za-z]:/.test(m) && !/(^|[\\/])\.\.([\\/]|$)/.test(m))
      if (!Array.isArray(b.how) || b.how.length > 0 || files.length === 0) continue
      b.how = [{ text: 'It is one part of the whole.', state: 'observed', evidence: files.slice(0, 2).map((ref) => ({ kind: 'file', ref })) }]
      changed = true
      seeded++
    }
    if (!changed) continue
    fs.writeFileSync(`${file}.seed`, JSON.stringify(doc))
    fs.renameSync(`${file}.seed`, file)
  }
  return seeded
}

/** The app log's Lumopolis ask lines from line `from` on (main writes it under the user data folder), and how many lines it has. */
function askLog(from = 0): { lines: string[]; total: number } {
  try {
    const all = fs.readFileSync(path.join(userDataDir, 'app.log'), 'utf8').split(/\r?\n/)
    return { lines: all.slice(from).filter((l) => l.includes('[world] ask:')), total: all.length }
  } catch {
    return { lines: [], total: 0 }
  }
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
    // The loaded world is the complete one: the first map from the listing is replaced in place, its notice with it.
    if (await provisional(path.resolve('.'))) {
      await expect.poll(() => provisional(path.resolve('.')), { timeout: 240_000 }).toBe(false)
      await settled(180_000)
    }
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
      const lit = await litShare()
      // An unlit map says what the canvas held (mapCanvasState), so a blank map in CI tells a lost WebGL context or an
      // oversized drawing buffer apart from a slow capture.
      const why = lit > 0.0005 ? '' : ` (${await mapCanvasState()})`
      expect.soft(lit, `the stars and the city are drawn on the map at ${tag}${why}`).toBeGreaterThan(0.0005)
      const scale = uiScale(v.width, v.height, at.w)
      await expectLegendClear(`world at ${tag}`, scale)
      await shoot(`app-world-${name}`)

      const toggle = page.locator('[data-testid="world-legend-toggle"]')
      if (await toggle.isVisible()) {
        const before = await toggle.getAttribute('aria-expanded')
        // One real mouse click on a zoomed button (the pane draws at 1.5 at 4K), where it must land.
        const zoomed = uiScale(v.width, v.height, at.w) > 1
        await click(toggle, zoomed && !clickedZoomed)
        if (zoomed) clickedZoomed = true
        await expect(toggle).not.toHaveAttribute('aria-expanded', before ?? '')
        // Opened or closed, the legend refits the city to what it leaves free: the glide ends before anything is measured.
        await glideDone(`legend toggled at ${tag}`)
        await check(`legend toggled at ${tag}`)
        await expectLegendClear(`legend toggled at ${tag}`, scale)
        await shoot(`app-legend-${name}`)
        await click(toggle)
        await expect(toggle).toHaveAttribute('aria-expanded', before ?? '')
      }

      expect.soft(await openCardInCity(tag), `a building's card opened at ${tag}`).toBe(true)
      // The card never lies on the legend (at 1280x800 on Linux it once covered most of the Legend button).
      expect.soft(await cardOnLegend(), `the card leaves the legend clear at ${tag}`).toBe(0)
      expect.soft(await cardShowsFirstLine(), `the card shows its first heading and the line under it at ${tag}`).toBe(true)
      expect.soft(await cardShowsTwoItems(), `the card shows its first heading and two items under it at ${tag}`).toBe(true)
      expect.soft(await cardEdgeProblems(), `the card cuts no line at its bottom edge outside its fade at ${tag}`).toEqual([])
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
        // Evidence for the answer to cite, given again before each ask in case a compile saved the world meanwhile.
        const seeded = seedEvidence()
        const logFrom = askLog().total
        const askT0 = Date.now()
        await askBox.fill('How does the memory search work?')
        await askBox.press('Enter')
        // The answer comes from a mock agent started through PowerShell, which can take a while to start on a busy
        // machine, so the wait is the app's own limits: 15 s to load the world, 10 s for each of the matches, the run
        // environment and the memory primer (which took over 100 s here before it had a limit), and 90 s for the agent.
        // The ask runner's own worst case (map load, three steps, the agent), plus slack for handing back and drawing the answer.
        const ASK_MS = 15_000 + 3 * 10_000 + 90_000 + 30_000
        const answer = page.locator('[data-testid="world-answer"]')
        const alert = page.getByRole('alert').filter({ has: page.getByRole('button', { name: 'Retry' }) })
        // Retry is pressed only for the map that could not be read (askRunner's MAP_FAILED), as a person would; any
        // other failure fails here. Each retry is recorded with the app log's reason, and a size that needs more than
        // one is a soft failure: round 3 saw the 15 s read run out twice in a row at 3440x1440.
        let retries = 0
        for (;;) {
          await expect(answer.or(alert).first()).toBeVisible({ timeout: ASK_MS })
          if (await answer.isVisible()) break
          const said = (await alert.first().textContent()) ?? ''
          expect(said, `the ask at ${tag} failed`).toContain(MAP_FAILED)
          retries++
          test.info().annotations.push({ type: 'ask retried', description: `${tag}, retry ${retries}: ${askLog(logFrom).lines.join(' | ') || 'nothing in the app log'}` })
          if (retries > 3) break
          await click(alert.first().getByRole('button', { name: 'Retry' }))
        }
        expect.soft(retries, `the map was read for the ask at ${tag} with at most one retry`).toBeLessThanOrEqual(1)
        await expect(answer).toBeVisible({ timeout: ASK_MS })
        const asked = askLog(logFrom).lines
        test.info().annotations.push({ type: 'ask time', description: `${Math.round((Date.now() - askT0) / 1000)} s at ${tag}${asked.length > 0 ? `; ${asked.join(' | ')}` : ''}` })
        // The answer reads without a scroll: its heading and the two pieces of evidence it cites.
        await softly.poll(answerProblems, { message: `the answer's heading and its E1 and E2 read without a scroll at ${tag} (${seeded} buildings given evidence)`, timeout: 10_000 }).toEqual([])
        await check(`answer at ${tag}`)
        // The answer's card reads without a scroll even with the answer's taller ask bar under it.
        await softly.poll(cardShowsTwoItems, { message: `the answer's card shows its first heading and two items under it at ${tag}`, timeout: 10_000 }).toBe(true)
        expect.soft(await cardEdgeProblems(), `the answer's card cuts no line at its bottom edge outside its fade at ${tag}`).toEqual([])
        // The heights the two share the pane by, for the report.
        const heights = await page.evaluate(() => {
          const h = (sel: string): number => Math.round(document.querySelector(sel)?.getBoundingClientRect().height ?? 0)
          return `card ${h('[data-testid="world-card"]')} px, answer ${h('[data-testid="world-answer"]')} px (text ${h('[data-testid="world-answer-scroll"]')} px)`
        })
        test.info().annotations.push({ type: 'answer heights', description: `${tag}: ${heights}` })
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

  test('the canvas is painted, never blank or white, at 3840x2160 and 5120x2880', async () => {
    // Look spec §5.3: a 4K or 5K drawing buffer the GPU cannot hold must not leave a blank or white canvas. Each tier
    // draws inside its pixel budget, and the theme's background sits behind the canvas. The reduced run (software-drawn
    // macOS) checks 3840x2160 only, as it does for its other checks.
    test.setTimeout(1_800_000)
    const names = process.env.RESPONSIVE_REDUCED === '1' ? ['3840x2160'] : ['3840x2160', '5120x2880']
    const sizes = VIEWPORTS.filter((v) => names.includes(v.name))
    expect(sizes).toHaveLength(names.length)
    if (!(await page.locator(PANE).isVisible())) {
      // Run on its own (the world test before it opens the world, and leaves it open).
      await setViewport(sizes[0])
      await createTerminal('Repo', path.resolve('.'))
      await openPane()
    }
    await settled(180_000)
    for (const v of sizes) {
      await setViewport(v)
      await settled()
      const host = page.locator('[data-testid="world-canvas-host"]')
      await expect(host, `the 3D map is still up at ${v.name} (the watchdog did not drop it to 2D)`).toBeVisible()
      const bg = await host.evaluate((el) => getComputedStyle(el).getPropertyValue('--world-bg').trim())
      expect(bg, `the canvas host carries the theme background at ${v.name}`).toMatch(/^#[0-9a-f]{6}$/i)
      const style = await page.addStyleTag({
        content: '.lw-labels, [data-testid="world-stage"] > :not([data-testid="world-canvas-host"]) { visibility: hidden !important }',
      })
      let buf: Buffer
      try {
        await page.waitForTimeout(300)
        // A clip of the page at CSS scale, as litShare takes it: an element shot of a 5K software frame can run out its time.
        const box = await host.locator('canvas').first().boundingBox()
        expect(box, `the map has a canvas at ${v.name}`).not.toBeNull()
        buf = await page.screenshot({ clip: box!, scale: 'css', timeout: 120_000, path: path.join(SHOTS, `app-painted-${v.name}.png`) })
        await reEmulate()
      } finally {
        await style.evaluate((el) => (el as Element).remove())
      }
      const m = pngMetrics(buf)
      const why = m.lit > MIN_LIT_FRACTION ? '' : ` (${await mapCanvasState()})`
      softly(m.lit, `the city is drawn at ${v.name}: ${(m.lit * 100).toFixed(2)}% lit${why}`).toBeGreaterThan(MIN_LIT_FRACTION)
      softly(m.white, `the canvas is not whited out at ${v.name}: ${(m.white * 100).toFixed(3)}% white`).toBeLessThan(MAX_WHITE_FRACTION)
      // The corners are the theme background as the frame draws it (tone mapped, drawnBackground), not blank or white.
      const corners = cornerPatches(buf)
      const theme = drawnBackground(bg)
      console.log(`[world-responsive] painted ${v.name}: lit ${(m.lit * 100).toFixed(2)}%, white ${(m.white * 100).toFixed(3)}%, theme ${bg} drawn rgb ${theme.join(',')}, corners ${corners.map((c) => c.join(',')).join(' / ')}`)
      for (const [i, c] of corners.entries()) {
        softly(levelsApart(c, theme), `corner ${i} at ${v.name} is the theme background ${bg} (drawn rgb ${theme.join(',')}), not blank or white (it is rgb ${c.join(',')})`).toBeLessThanOrEqual(CORNER_MAX_LEVELS)
      }
    }
  })

  test('an answer made while memory is locked, or with no saved notes matching, says so, and fits with that note at 768x1024 and the largest size the run checks (WPA fix M8, WPA2 M8)', async () => {
    test.setTimeout(1_800_000)
    // A reduced run (the macOS CI job, which renders in software) checks its own largest size, 1440x900@2x, instead of 5K:
    // a software-drawn 5120x2880 world starves the runner's few cores, as the reduced run's own header says. Every other run checks 5K.
    const big = process.env.RESPONSIVE_REDUCED === '1' ? REDUCED_SPLIT_AT : '5120x2880'
    const sizes = VIEWPORTS.filter((v) => v.name === '768x1024' || v.name === big)
    expect(sizes).toHaveLength(2)
    if (!(await page.locator(PANE).isVisible())) {
      // Run on its own (the world test before it opens the world, and leaves it open).
      await setViewport(sizes[0])
      await createTerminal('Repo', path.resolve('.'))
      await openPane()
    }
    await settled(180_000)
    if (await provisional(path.resolve('.'))) {
      await expect.poll(() => provisional(path.resolve('.')), { timeout: 240_000 }).toBe(false)
      await settled(180_000)
    }
    // The memory process's switch (e2e/mocks/memory-host-lockable.mjs): `locked` says the store is locked; `empty` (WPA2 M8)
    // answers every search and listing with no notes, a healthy store with nothing saved for the question.
    const NOTES = [
      { word: 'locked', text: 'Answered without project memory (memory is locked).', name: 'locked' },
      { word: 'empty', text: 'No saved notes matched this question, so this answer comes from the code alone.', name: 'empty' },
    ]
    for (const n of NOTES) {
      try {
        fs.writeFileSync(memoryLockFile, n.word)
        // The store only locks by reloading, which tells main the memory changed and drops the Ask's cached primers. The switch
        // above reloads nothing, so a delete (of nothing) stands in for that: every delete crosses the same change boundary.
        await page.evaluate(() => (window as unknown as { termpolis: { memoryDelete: (id: string) => Promise<unknown> } }).termpolis.memoryDelete('wpa-m8-no-such-note'))
        for (const v of sizes) {
          const at = await layoutAt(v, null)
          expect(at, `the pane opens at its default width at ${v.name}`).not.toBeNull()
          if (!at) continue
          await settled()
          const askBox = page.getByPlaceholder('Ask about this project…')
          seedEvidence()
          await askBox.fill('How does the memory search work?')
          await askBox.press('Enter')
          // The ask runner's own worst case (map load, three steps, the agent), plus slack for handing back and drawing the answer.
          const ASK_MS = 15_000 + 3 * 10_000 + 90_000 + 30_000
          const answer = page.locator('[data-testid="world-answer"]')
          const alert = page.getByRole('alert').filter({ has: page.getByRole('button', { name: 'Retry' }) })
          for (let retries = 0; ; retries++) {
            await expect(answer.or(alert).first()).toBeVisible({ timeout: ASK_MS })
            if (await answer.isVisible()) break
            expect((await alert.first().textContent()) ?? '', `the ask at ${at.tag} failed`).toContain(MAP_FAILED)
            expect(retries, `the map was read for the ask at ${at.tag}`).toBeLessThan(3)
            await click(alert.first().getByRole('button', { name: 'Retry' }))
          }
          // The answer says it was made without the project memory, and why (askPrimer: the store is locked, or no notes matched).
          const note = page.locator('[data-testid="world-answer-memory"]')
          await expect(note).toHaveText(n.text, { timeout: 10_000 })
          // The note lies inside the answer panel, whole: not cut off at its edge, and nothing scrolls across.
          const box = await note.evaluate((el) => {
            const panel = el.closest('[data-testid="world-answer"]') as HTMLElement
            const r = el.getBoundingClientRect()
            const p = panel.getBoundingClientRect()
            return { inside: r.left >= p.left - 1 && r.right <= p.right + 1 && r.width > 0 && r.height > 0, wide: el.scrollWidth <= el.clientWidth + 1, across: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1 }
          })
          expect.soft(box, `the ${n.name} note fits in the answer at ${at.tag}`).toEqual({ inside: true, wide: true, across: true })
          await check(`answer with the ${n.name} note at ${at.tag}`)
          await shoot(`app-answer-${n.name}-${at.name}`)
          await click(page.getByRole('button', { name: 'Close answer' }))
          await expect(answer).toHaveCount(0)
          await closeCard()
        }
      } finally {
        fs.writeFileSync(memoryLockFile, '')
      }
    }
  })

  test("a folder past the map's cap: its files note keeps clear of the legend, open or shut, and of a card", async () => {
    // Fix round 1, I4: the notice slot is laid out in the free area (noticeBox). A folder of more files than a map
    // walks keeps its "Showing the first …" note up on the complete world, so it can be measured at leisure.
    test.setTimeout(1_800_000)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-responsive-capped-'))
    try {
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'capped', version: '1.0.0' }))
      for (let f = 0; f < 81; f++) {
        const folder = path.join(dir, 'src', `f${String(f).padStart(2, '0')}`)
        fs.mkdirSync(folder, { recursive: true })
        await Promise.all(Array.from({ length: 250 }, (_, i) => fs.promises.writeFile(path.join(folder, `m${i}.ts`), `export const v${i} = ${i}\n`)))
      }
      const mapped = await page.evaluate(
        (r) => (window as unknown as { termpolis: { worldMapProject: (c: string) => Promise<{ success: boolean; error?: string }> } }).termpolis.worldMapProject(r),
        dir,
      )
      expect(mapped.error ?? '').toBe('')
      await page.evaluate((folder) => window.dispatchEvent(new CustomEvent('termpolis:openWorld', { detail: { folder } })), dir)
      await expect(page.locator(PANE)).toBeVisible({ timeout: 60_000 })
      const NOTE = '[data-testid="world-notice"]'
      // The first map from the listing comes first, with its "Still reading" note: the note every big project shows
      // while its files are read keeps clear of the legend, open or shut, and inside the pane (fix round 2, m6).
      const reading = page.locator(NOTE, { hasText: 'Still reading the files' })
      await expect(reading).toBeVisible({ timeout: 300_000 })
      const toggle = page.locator('[data-testid="world-legend-toggle"]')
      for (let pass = 0; pass < 2; pass++) {
        if (!(await reading.isVisible())) break
        const state = `legend ${(await toggle.getAttribute('aria-expanded')) === 'true' ? 'open' : 'shut'} on the first map`
        expect.soft(await overlapOf(NOTE, '[data-testid="world-legend"]'), `the first map's note leaves the legend clear, ${state}`).toBe(0)
        const inside = await page.evaluate(([n, p]) => {
          const a = document.querySelector(n)?.getBoundingClientRect()
          const b = document.querySelector(p)?.getBoundingClientRect()
          return !!a && !!b && a.left >= b.left - 1 && a.right <= b.right + 1 && a.top >= b.top - 1 && a.bottom <= b.bottom + 1
        }, [NOTE, PANE] as const)
        expect.soft(inside, `the first map's note lies inside the pane, ${state}`).toBe(true)
        await shoot(`app-notice-first-map-${pass}`)
        await click(toggle)
      }
      const note = page.locator(NOTE, { hasText: 'Showing the first ' })
      await expect(note).toBeVisible({ timeout: 600_000 })
      await settled(600_000)
      // Every layout the pane fits is measured: only a set pane width the row cannot hold is skipped (fix round 2, m6).
      let measured = 0
      for (const { v, width } of NOTICE_LAYOUTS) {
        const at = await layoutAt(v, width)
        if (!at) continue
        measured++
        await settled()
        const { tag, name } = at
        await expect(note).toBeVisible()
        for (let pass = 0; pass < 2; pass++) {
          const state = `legend ${(await toggle.getAttribute('aria-expanded')) === 'true' ? 'open' : 'shut'} at ${tag}`
          await glideDone(state)
          expect.soft(await overlapOf(NOTE, '[data-testid="world-legend"]'), `the notice leaves the legend clear, ${state}`).toBe(0)
          await check(`notice, ${state}`)
          await shoot(`app-notice-${name}-${pass}`)
          await click(toggle)
        }
        // A card open over the city, with the legend as it opens by default: the notice clears both. A city this big
        // shows its districts as slabs from the overview, so a district is stepped into (a click on its slab) first.
        let opened = await openCardInCity(tag)
        if (!opened) {
          // At 5K a frame drawn in software can outlast the camera's flight to the building, so the card is opened at
          // the laptop size and the window taken back to this size with it still open: it is measured here all the same.
          const laptop = VIEWPORTS.find((x) => x.name === '1280x800@2x') as Viewport
          await layoutAt(laptop, null)
          await settled()
          if (await openCardInCity(`${tag}, opened at the laptop size`)) {
            await layoutAt(v, width)
            await settled()
            opened = await page.locator('[data-testid="world-card"]').isVisible()
          }
        }
        expect.soft(opened, `a building's card opened at ${tag}`).toBe(true)
        await glideDone(`card at ${tag}`)
        await expect(note).toBeVisible()
        expect.soft(await overlapOf(NOTE, '[data-testid="world-card"]'), `the notice leaves the card clear at ${tag}`).toBe(0)
        expect.soft(await overlapOf(NOTE, '[data-testid="world-legend"]'), `the notice leaves the legend clear with a card open at ${tag}`).toBe(0)
        await check(`notice with a card at ${tag}`)
        // Inside a district of thousands of parts, a 5K frame drawn in software takes longer than a capture may: the
        // card's measures above are the check there, and the picture is taken at the smaller sizes.
        if (v.width * v.height <= 3840 * 2160) await shoot(`app-notice-card-${name}`)
        await closeCard()
      }
      expect(measured, 'the notice was measured at every layout with a default pane, at least').toBeGreaterThanOrEqual(NOTICE_LAYOUTS.filter((l) => l.width === null).length)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('dragging the pane divider with a line card open stays smooth', async () => {
    // Look plan Task 5 (WP2 M-a): a line's close-up is searched once and only re-aimed on each resize, so the drag never
    // waits on a search. Each resize's own work is timed in the app (perf.resizeWorstMs, from the window's start), and no
    // task of the page runs over 200 ms while the divider moves: 300 px in 40 steps over 2 s, as a hand drags it. The
    // drawing buffer is fitted only once the size holds (threeRenderer's BUFFER_SETTLE_MS): in software rendering a fit
    // waits on the GPU's frames for 250 ms and more, so a task that starts that long after the last move is the drag
    // held still, not the drag; the buffer is checked fitted to the narrowed view after it.
    test.setTimeout(600_000)
    const v = VIEWPORTS.find((x) => x.name === '1920x1080') as Viewport
    await setViewport(v)
    slowness = 1
    if (!(await page.locator(PANE).isVisible())) {
      await createTerminal('Repo', path.resolve('.'))
      await openPane()
    }
    // The repository's own world, whose line is picked below: the test before this one leaves its big project's world in
    // the pane (and deletes the project), so the world is asked for by folder, as any opener does.
    const root = await page.evaluate(async (r) => {
      const top = await (window as unknown as { termpolis: { gitFindRoot: (c: string) => Promise<{ success: boolean; data?: string }> } }).termpolis.gitFindRoot(r)
      return top.success && top.data ? top.data : r
    }, path.resolve('.'))
    await page.evaluate((folder) => window.dispatchEvent(new CustomEvent('termpolis:openWorld', { detail: { folder } })), root)
    await expect(page.locator(PANE)).toBeVisible({ timeout: 60_000 })
    await settled(180_000)
    if (await provisional(root)) {
      await expect.poll(() => provisional(root), { timeout: 240_000 }).toBe(false)
      await settled(180_000)
    }
    const width = await split(null)
    expect(width, 'the pane sits beside the terminals at 1920x1080').not.toBeNull()
    expect((await paneState()).overlays, 'the pane has a divider at 1920x1080').toBe(false)
    // A line between two buildings, its card opened as the agent opens one, with both ends in view in its close-up. The
    // world opens from far away, where its buildings stand under their districts' slabs and none can be pointed at, and a
    // district shown folded into parts draws no building of its own, so a line of the doc may have an end that is never
    // on the map: each line is tried in its own close-up until one shows both ends.
    const lines = await page.evaluate(async (r) => {
      type Doc = { buildings: { id: string }[]; edges: { id: string; from: string; to: string }[] }
      const api = (window as unknown as { termpolis: { gitFindRoot: (c: string) => Promise<{ success: boolean; data?: string }>; worldGet: (c: string) => Promise<{ success: boolean; data?: Doc | null }> } }).termpolis
      const top = await api.gitFindRoot(r)
      const res = await api.worldGet(top.success && top.data ? top.data : r)
      if (!res.success || !res.data) return []
      const ids = new Set(res.data.buildings.map((x) => x.id))
      return res.data.edges.filter((x) => x.from !== x.to && ids.has(x.from) && ids.has(x.to)).map((x) => ({ id: x.id, from: x.from, to: x.to }))
    }, path.resolve('.'))
    expect(lines.length, 'the world has a line between two buildings').toBeGreaterThan(0)
    // Both ends of the line on the canvas: in its box, as the probe projects them (null: not drawn, or not to be pointed at).
    const endsInView = (ends: string[]): Promise<string[]> => page.evaluate((ends) => {
      const probe = (window as unknown as { __termpolis_world: { screenPoint(id: string): { x: number; y: number } | null } }).__termpolis_world
      const r = (document.querySelector('[data-testid="world-canvas-host"] canvas') as HTMLCanvasElement).getBoundingClientRect()
      return ends.filter((x) => {
        const p = probe.screenPoint(x)
        return !p || p.x < r.left || p.x > r.right || p.y < r.top || p.y > r.bottom
      })
    }, ends)
    const tried: string[] = []
    let line: { id: string; from: string; to: string } | null = null
    for (const l of lines.slice(0, 12)) {
      await page.evaluate((id) => (window as unknown as { __termpolis_world: { apply(a: { type: 'openCard'; id: string }): Promise<void> } }).__termpolis_world.apply({ type: 'openCard', id }), l.id)
      await expect(page.locator('[data-testid="world-card"]'), `the card of line ${l.id} is open`).toBeVisible({ timeout: 30_000 })
      await glideDone(`the card of line ${l.id} opened`)
      const out = await endsInView([l.from, l.to])
      if (out.length === 0) { line = l; break }
      tried.push(`${l.id} (not in view: ${out.join(', ')})`)
      await closeCard()
    }
    if (!line) throw new Error(`no line of the world showed both ends in its close-up; tried ${lines.length} of ${lines.length > 12 ? '12 first' : 'them'}: ${tried.join('; ')}`)
    const { from, to } = line
    console.log(`[world-responsive] divider drag: line ${line.id}, both ends in view in its close-up, after ${tried.length} other line(s)${tried.length ? `: ${tried.join('; ')}` : ''}`)
    await page.evaluate(() => {
      const w = window as unknown as { __longTasks: Array<{ start: number; ms: number }>; __moves: number[]; __longObs?: PerformanceObserver; __worldPerf: { begin(): void } }
      w.__longTasks = []
      w.__moves = []
      window.addEventListener('pointermove', () => { w.__moves.push(performance.now()) }, { capture: true })
      w.__longObs = new PerformanceObserver((list) => { for (const t of list.getEntries()) w.__longTasks.push({ start: t.startTime, ms: t.duration }) })
      w.__longObs.observe({ type: 'longtask', buffered: false })
      w.__worldPerf.begin()
    })
    const box = await page.locator('[data-testid="world-pane-divider"]').boundingBox()
    if (!box) throw new Error('the divider has no box')
    const x = box.x + box.width / 2
    const y = box.y + box.height / 2
    await page.mouse.move(x, y)
    await page.mouse.down()
    // To the right narrows the pane: 300 px in 40 steps, one every 50 ms.
    for (let k = 1; k <= 40; k++) {
      await page.mouse.move(x + (300 * k) / 40, y)
      await page.waitForTimeout(50)
    }
    await page.mouse.up()
    const after = await page.evaluate((settleMs) => {
      const w = window as unknown as { __longTasks: Array<{ start: number; ms: number }>; __moves: number[]; __longObs?: PerformanceObserver; __worldPerf: { end(): { frames: number } }; __termpolis_world: { drawn(): { perf: { resizeWorstMs: number; tier: string } } } }
      w.__longObs?.disconnect()
      const perf = w.__termpolis_world.drawn().perf
      // A task is the drag's when it starts within the settle time of a move (the move's resize and the frames after it);
      // later, the hand held still and the buffer was fitted.
      const sinceMove = (t: number): number => t - Math.max(-Infinity, ...w.__moves.filter((m) => m <= t))
      const tasks = w.__longTasks.map((t) => ({ ms: t.ms, still: sinceMove(t.start) >= settleMs }))
      const gaps = w.__moves.slice(1).map((m, i) => m - w.__moves[i])
      return { resizeWorstMs: perf.resizeWorstMs, tier: perf.tier, tasks, moves: w.__moves.length, widestGap: Math.max(0, ...gaps), frames: w.__worldPerf.end().frames }
    }, BUFFER_SETTLE_MS)
    const show = (xs: Array<{ ms: number }>): string => xs.map((t) => t.ms.toFixed(0)).join(', ') || 'none'
    console.log(`[world-responsive] divider drag with a line card open: worst resize ${after.resizeWorstMs.toFixed(1)} ms, ${after.frames} frames, tier ${after.tier}, ${after.moves} moves (widest gap ${after.widestGap.toFixed(0)} ms), long tasks of the drag ${show(after.tasks.filter((t) => !t.still))}, once it held still ${show(after.tasks.filter((t) => t.still))}`)
    expect((await paneState()).pane, 'the drag narrowed the pane').toBeLessThan((width as number) - 200)
    softly(after.resizeWorstMs, 'the drag resized the view, timed').toBeGreaterThan(0)
    softly(after.resizeWorstMs, 'each resize during the drag takes under 16 ms of its own').toBeLessThan(16)
    softly(after.tasks.filter((t) => !t.still && t.ms > 200).map((t) => Math.round(t.ms)), 'no task of the page runs over 200 ms during the drag').toEqual([])
    await glideDone('the divider dragged')
    // The size held: the buffer is fitted to the narrowed view (its shape, at whatever pixel ratio the tier draws at).
    await expect.poll(() => page.evaluate(() => {
      const c = document.querySelector<HTMLCanvasElement>('[data-testid="world-canvas-host"] canvas')
      return c ? Math.abs(c.width / c.height - c.clientWidth / c.clientHeight) : Infinity
    }), { message: "the drawing buffer is fitted to the view's new shape once the drag holds still", timeout: 10_000 }).toBeLessThan(0.02)
    expect(await endsInView([from, to]), 'both ends of the line are in view after the drag').toEqual([])
    await expect(page.locator('[data-testid="world-card"]'), 'the line card is still open').toBeVisible()
    await closeCard()
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
