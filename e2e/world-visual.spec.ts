/**
 * Lumopolis can be SEEN (Task 7, visual fidelity). The other world specs prove that the scene holds
 * the right objects; this one fails when a person looking at the pane would not see them: a city
 * fogged to black, labels in the DOM at opacity 0, or a pane that hides the window controls or lets
 * the terminal show through while it opens.
 *
 * For a small project and for a generated one of 168 files in 12 folders (the big one is what put
 * the overview camera far enough out for the fixed fog to swallow the city), in each theme:
 *   - the canvas at overview, with the DOM overlays hidden, is bright enough (mean luminance) and
 *     has enough pixels clearly above the theme's background (lit fraction);
 *   - no part of it whites out: few pixels are saturated white (fog and bloom stay below saturation,
 *     also where many lines meet at one building);
 *   - at least MIN_DISTRICT_LABELS district labels are on the canvas, visible and readable;
 *   - the overview leaves the legend's strip free: no building and no district label under it, also
 *     after the window is resized;
 *   - hovering a building shows its connections' labels, a few at most;
 *   - clicking that building (where its hover labels gather) opens THAT building's card, also when
 *     the click lands a few pixels off the aim point; the card is drawn over the map's labels: the
 *     card is what is under its own centre, and wherever a label's box overlaps a panel the panel is
 *     on top; the close-up does not white out either;
 *   - no two labels on show overlap (district, building and line names alike), at overview, on
 *     hover and after the click, and the overview's labels hold still;
 *   - clicking one of the selected building's line labels opens that line's card with the camera
 *     outside, both ends of the line in view, and no white-out;
 *   - clicking a line itself, over open ground, opens its card.
 * Each time the pane opens, on the first frame it exists: it starts below the title bar, its
 * background is opaque, and neither it nor any ancestor is faded (their opacities multiply to 1).
 * The same checks run on this repository (Termpolis itself), whose busy districts piled their
 * building names into an unreadable stack before the labels were placed (semantic zoom).
 *
 * Screenshots go to test-results/world-visual/, which the e2e-soak workflow uploads, so a CI run
 * gives screenshots of the real build.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { _electron as electron } from 'playwright'
import { execFileSync } from 'child_process'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { quitApp, ensureE2eBuild } from './helpers/launch'
import { closeMore, toolbarControl } from './helpers/worldToolbar'
import { edgeSummary } from '../src/shared/world/edgeText'
import { MAX_WHITE_FRACTION, MIN_LIT_FRACTION, MIN_MEAN_OVER_BACKGROUND, pngMetrics } from './worldPixels'
import { bigFiles } from './helpers/world'

// The thresholds (LIT_MARGIN and the rest), their measurements and the pixel math live in worldPixels.ts.
/** District labels that must be readable at overview (fewer if the world has fewer districts). */
const MIN_DISTRICT_LABELS = 4
/** The smallest label font a person can read on the map. */
const MIN_LABEL_FONT_PX = 11
/** The most line labels a hovered building shows (threeRenderer HOVER_EDGE_LABELS). */
const MAX_HOVER_LINE_LABELS = 6
/** Where else round the aim point a click must open the same building's card, in pixels. */
const CLICK_JITTER: Array<[number, number]> = [[2, 0], [-2, 0], [0, 3], [0, -3]]

const THEMES = ['neon', 'blueprint', 'glass'] as const
const SHOTS = path.resolve('test-results/world-visual')

let app: ElectronApplication
let page: Page
let userDataDir: string
const fixtures: Array<{ label: string; dir: string }> = []

/** Writes `files` under a new temp folder and makes it a git repository with every file staged. */
function makeRepo(label: string, files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `termpolis-visual-${label}-`))
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), text)
  }
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['add', '-A'], { cwd: dir })
  return dir
}

/** A small app: four folders that import from each other. */
const SMALL_FILES: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'shop', version: '1.0.0' }),
  'src/api/server.ts': "import { listItems } from '../store/items'\nimport { check } from '../auth/session'\nexport function serve(): string[] {\n  check()\n  return listItems()\n}\n",
  'src/api/routes.ts': "import { serve } from './server'\nexport const routes = { '/items': serve }\n",
  'src/store/items.ts': "import { db } from './db'\nexport function listItems(): string[] {\n  return db.all()\n}\n",
  'src/store/db.ts': 'export const db = { all: (): string[] => [] }\n',
  'src/auth/session.ts': "import { db } from '../store/db'\nexport function check(): boolean {\n  return db.all().length >= 0\n}\n",
  'src/ui/App.ts': "import { routes } from '../api/routes'\nexport function app(): number {\n  return Object.keys(routes).length\n}\n",
  'src/ui/List.ts': "import { app } from './App'\nexport const list = (): number => app()\n",
}

/**
 * The small app plus a passing Vitest report for a test of the store's db (so the store's building is
 * verified and carries the rotating ring) and a call to an outside web service (an external, drawn as an orb).
 */
const MOTION_FILES = (): Record<string, string> => ({
  ...SMALL_FILES,
  'src/store/db.test.ts': "import { db } from './db'\nexport const seen = db.all().length === 0\n",
  'src/api/remote.ts': "export async function remoteItems(): Promise<unknown> {\n  return (await fetch('https://api.shopco.dev/items')).json()\n}\n",
  'vitest-report.json': JSON.stringify({ testResults: [{ name: 'src/store/db.test.ts', status: 'passed', endTime: Date.now() }] }),
})

test.beforeAll(async () => {
  ensureE2eBuild()
  fs.mkdirSync(SHOTS, { recursive: true })
  fixtures.push({ label: 'small', dir: makeRepo('small', SMALL_FILES) }, { label: 'big', dir: makeRepo('big', bigFiles(14)) }, { label: 'huge', dir: makeRepo('huge', bigFiles(50)) }, { label: 'motion', dir: makeRepo('motion', MOTION_FILES()) })

  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-visual-ud-'))
  fs.writeFileSync(
    path.join(userDataDir, 'session.json'),
    JSON.stringify({ terminals: [], workspaces: [], defaultShell: process.platform === 'win32' ? 'powershell' : 'bash', viewMode: 'tabs' }),
  )
  // Names from the code alone: no model is asked to describe the parts.
  fs.writeFileSync(path.join(userDataDir, 'world-settings.json'), JSON.stringify({ worldLabelling: false }))

  app = await electron.launch({
    args: [
      path.resolve('out/main/index.js'),
      `--user-data-dir=${userDataDir}`,
      // Software GL (SwiftShader), so a runner with no GPU still gets a WebGL context.
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
    ],
    env: { ...process.env, NODE_ENV: 'test', TERMPOLIS_SMOKE_SKIP_PICKERS: '1', TERMPOLIS_TEST_WORLD_PROBE: '1' },
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.waitForTimeout(1500)
  await page.evaluate(() => {
    try {
      localStorage.setItem('termpolis.onboarding.seen.v1', '1')
      localStorage.setItem('termpolis.telemetry.optIn', '0')
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
  for (const d of [userDataDir, ...fixtures.map((f) => f.dir)]) {
    try {
      if (d) fs.rmSync(d, { recursive: true, force: true })
    } catch {
      /* temp dir */
    }
  }
})

const pane = () => page.locator('[data-testid="world-view"]')
const canvas = () => page.locator('[data-testid="world-canvas-host"] canvas')
const card = () => page.locator('[data-testid="world-card"]')

interface Drawn { changing: number; conduits: number; tier: string; drawCalls: number; buildings: number; districts: number; slabs: number }
interface Probe { screenPoint(id: string): { x: number; y: number } | null; linePoints(id: string): Array<{ x: number; y: number }>; pickAt(x: number, y: number): { kind: string; id: string } | null; drawn(): Drawn; apply(a: { type: 'focus'; ids: string[] }): Promise<void> }

/** Adds a terminal whose working folder is `cwd` (the Add Terminal dialog's folder field). */
async function createTerminal(name: string, cwd: string): Promise<void> {
  await page.locator('button:has-text("+ Add Terminal")').first().click()
  const dialog = page.locator('h2:has-text("New Terminal")').locator('..')
  await expect(dialog).toBeVisible()
  await dialog.locator('input').first().fill(name)
  await dialog.locator('input[placeholder="Home directory"]').fill(cwd)
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await page.waitForTimeout(1500)
}

interface FirstFrame { top: number; titleBottom: number; background: string; testid: string; opacity: number }

/** Opens the pane from the command palette, recording the pane on the first frame it exists. */
async function openPane(): Promise<FirstFrame> {
  await page.evaluate(() => {
    const w = window as unknown as { __firstPane?: FirstFrame }
    delete w.__firstPane
    const tick = (): void => {
      const el = document.querySelector<HTMLElement>('[data-testid="world-view-opening"], [data-testid="world-view"]')
      if (!el) {
        requestAnimationFrame(tick)
        return
      }
      const bar = document.querySelector('[data-testid="title-bar"]')
      // The pane and every ancestor: a fade anywhere up the tree lets the terminal show through.
      let opacity = 1
      for (let e: Element | null = el; e; e = e.parentElement) opacity *= Number(getComputedStyle(e).opacity)
      w.__firstPane = {
        opacity,
        top: el.getBoundingClientRect().top,
        titleBottom: bar ? bar.getBoundingClientRect().bottom : 0,
        background: getComputedStyle(el).backgroundColor,
        testid: el.dataset.testid ?? '',
      }
    }
    requestAnimationFrame(tick)
  })
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.press('ControlOrMeta+k')
  const input = page.getByPlaceholder('Type a command...')
  await expect(input).toBeVisible()
  await input.fill('Open Lumopolis')
  await page.getByRole('button', { name: /^Open Lumopolis\s*See your project as a 3D world/ }).click()
  await expect.poll(() => page.evaluate(() => (window as unknown as { __firstPane?: FirstFrame }).__firstPane ?? null)).not.toBeNull()
  return (await page.evaluate(() => (window as unknown as { __firstPane?: FirstFrame }).__firstPane))!
}

/**
 * Waits until the world is on the canvas and the rise and the camera's flight are over. `compileMs`
 * bounds the wait for the canvas: a first open of a real repository maps the whole project first.
 */
async function settled(compileMs = 60_000): Promise<void> {
  await expect(canvas()).toBeVisible({ timeout: compileMs })
  await expect(page.locator('[data-testid="world-canvas-host"]')).toHaveCSS('visibility', 'visible', { timeout: compileMs })
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __termpolis_world?: Probe }).__termpolis_world?.drawn().changing ?? -1), { timeout: 30_000 })
    .toBe(0)
  await page.waitForTimeout(2500)
}

/** Mean luminance and lit fraction of the canvas alone (labels and panels hidden for the shot),
 *  against the canvas's own background: its most common luminance (the tone mapping shifts the
 *  theme's background colour, so the colour in themes.ts is not what is on screen). */
async function measure(file: string): Promise<{ mean: number; lit: number; white: number; bgY: number }> {
  const style = await page.addStyleTag({
    content: '.lw-labels, [data-testid="world-stage"] > :not([data-testid="world-canvas-host"]) { visibility: hidden !important }',
  })
  await page.waitForTimeout(300)
  const buf = await canvas().screenshot({ path: path.join(SHOTS, file) })
  await style.evaluate((el) => el.remove())
  return pngMetrics(buf)
}

interface LabelState { text: string; inside: boolean; opacity: number; visibility: string; font: number; box: string }

/** Every district label: whether its box is on the canvas, its effective opacity and its font size. */
const districtLabels = (): Promise<LabelState[]> =>
  page.evaluate(() => {
    const c = document.querySelector('[data-testid="world-canvas-host"] canvas')!.getBoundingClientRect()
    return [...document.querySelectorAll<HTMLElement>('.lw-district')].map((el) => {
      const r = el.getBoundingClientRect()
      let opacity = 1
      for (let e: HTMLElement | null = el; e && e !== document.body; e = e.parentElement) opacity *= Number(getComputedStyle(e).opacity)
      const cs = getComputedStyle(el)
      return {
        text: el.textContent ?? '',
        inside: r.width > 0 && r.height > 0 && r.left >= c.left && r.right <= c.right && r.top >= c.top && r.bottom <= c.bottom,
        opacity,
        visibility: cs.visibility,
        font: parseFloat(cs.fontSize),
        box: `label ${Math.round(r.left)},${Math.round(r.top)}-${Math.round(r.right)},${Math.round(r.bottom)} canvas ${Math.round(c.left)},${Math.round(c.top)}-${Math.round(c.right)},${Math.round(c.bottom)}`,
      }
    })
  })

/**
 * The ask bar's controls (its chips, its input and its buttons) whose box runs past the pane's stage,
 * as "text: box": in a narrow pane the chips must wrap and the input shrink, not clip at the edges.
 */
const askOutsideStage = (): Promise<string[]> =>
  page.evaluate(() => {
    const s = document.querySelector('[data-testid="world-stage"]')!.getBoundingClientRect()
    const out: string[] = []
    for (const el of document.querySelectorAll<HTMLElement>('[data-testid="world-ask"] button, [data-testid="world-ask"] input')) {
      const r = el.getBoundingClientRect()
      if (r.width === 0 && r.height === 0) continue
      if (r.left < s.left - 0.5 || r.right > s.right + 0.5 || r.top < s.top - 0.5 || r.bottom > s.bottom + 0.5) {
        out.push(`${el.textContent || el.getAttribute('placeholder') || el.getAttribute('aria-label') || el.tagName}: ${Math.round(r.left)},${Math.round(r.top)}-${Math.round(r.right)},${Math.round(r.bottom)} stage ${Math.round(s.left)},${Math.round(s.top)}-${Math.round(s.right)},${Math.round(s.bottom)}`)
      }
    }
    return out
  })

/** Pairs of district labels on show whose boxes overlap by more than a pixel, as "a / b". */
const overlappingDistrictLabels = (): Promise<string[]> =>
  page.evaluate(() => {
    const boxes = [...document.querySelectorAll<HTMLElement>('.lw-district')]
      .filter((el) => getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility === 'visible')
      .map((el) => ({ t: el.textContent ?? '', r: el.getBoundingClientRect() }))
      .filter((b) => b.r.width > 0 && b.r.height > 0)
    const out: string[] = []
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i].r
        const b = boxes[j].r
        if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1) out.push(`${boxes[i].t} / ${boxes[j].t}`)
      }
    }
    return out
  })

interface Line { id: string; from: string; to: string; label: string }
interface World { ids: string[]; connected: string[]; names: Record<string, string>; districts: number; edges: Line[]; provisional: boolean }

/** Building ids from the stored world of `root` (also those with a connection, the busiest first), their names, its district count and its lines,
 *  and whether it is still the first map drawn from the file listing (or no world yet). */
async function world(root: string): Promise<World> {
  return page.evaluate(async (r) => {
    interface Doc { buildings: { id: string; name: string }[]; districts: unknown[]; edges: { id: string; from: string; to: string; label: string }[]; provisional?: boolean }
    const api = (window as unknown as { termpolis: { gitFindRoot: (c: string) => Promise<{ success: boolean; data?: string }>; worldGet: (c: string) => Promise<{ success: boolean; data?: Doc | null }> } }).termpolis
    const top = await api.gitFindRoot(r)
    const res = await api.worldGet(top.success && top.data ? top.data : r)
    if (!res.success || !res.data) return { ids: [], connected: [], names: {}, districts: 0, edges: [], provisional: true }
    const lines = new Map<string, number>()
    for (const e of res.data.edges) for (const end of [e.from, e.to]) lines.set(end, (lines.get(end) ?? 0) + 1)
    const ids = res.data.buildings.map((b) => b.id)
    // The busiest building first: its hover labels gather over it, the case where they caught the click.
    const connected = ids.filter((id) => lines.has(id)).sort((a, b) => (lines.get(b) as number) - (lines.get(a) as number))
    const edges = res.data.edges.map((e) => ({ id: e.id, from: e.from, to: e.to, label: e.label }))
    return { ids, connected, names: Object.fromEntries(res.data.buildings.map((b) => [b.id, b.name])), districts: res.data.districts.length, edges, provisional: res.data.provisional === true }
  }, root)
}

/**
 * From the overview (the districts tier: one slab per district, no buildings to hover) wheels in
 * until the buildings show, then takes the pointer off the canvas.
 */
async function toBuildingsTier(further = 0): Promise<void> {
  // The tier, and the frames drawn, as the last frame drawn left them, and the camera's distance now.
  const state = (): Promise<{ tier: string; frames: number; dist: number }> =>
    page.evaluate(() => {
      const probe = (window as unknown as { __termpolis_world: { drawn(): { tier: string; frames: number }; cameraState(): { pos: number[]; target: number[] } } }).__termpolis_world
      const d = probe.drawn()
      const c = probe.cameraState()
      return { tier: d.tier, frames: d.frames, dist: Math.hypot(...c.pos.map((v, k) => v - c.target[k])) }
    })
  // The tier for the camera after a notch. The tier is set as a frame is drawn, so it is read from a frame begun
  // after the notch moved the camera: drawn in software, no frame is drawn while the GPU is still drawing the last
  // (SOFTWARE_FENCE_MAX_MS, 10 s at most), so the tier can trail a notch by a frame. Read at a fixed time after the
  // notch it named the tier of one notch earlier now and then, the wheeling stopped a notch early or late, and the
  // click checks below came in at another camera than the one their aim point was found from.
  const notch = async (): Promise<string> => {
    const before = (await state()).dist
    await page.mouse.wheel(0, -100)
    await expect.poll(async () => (await state()).dist, { message: 'a wheel notch never moved the camera', timeout: 5_000 }).not.toBe(before)
    const moved = (await state()).frames
    await expect.poll(async () => (await state()).frames, { message: 'no frame was drawn after a wheel notch', timeout: 15_000 }).toBeGreaterThan(moved)
    return (await state()).tier
  }
  const box = await page.locator('[data-testid="world-canvas-host"] canvas').boundingBox()
  // This window reports a device pixel ratio a hair under 1 (0.99999998), and OrbitControls
  // (three r160) divides the wheel delta by `devicePixelRatio | 0`: zero, so one notch would fly
  // straight to the nearest distance. Reported as exactly 1, a notch of 100 px is the intended 5%.
  await page.evaluate(() => { if ((window.devicePixelRatio | 0) === 0) Object.defineProperty(window, 'devicePixelRatio', { get: () => 1, configurable: true }) })
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
  // OrbitControls scales the distance by 0.95 per 100 px of wheel: about 14 steps from the overview to half its distance.
  let tier = (await state()).tier
  for (let i = 0; i < 40 && tier === 'districts'; i++) tier = await notch()
  expect(tier, 'wheeling in from the overview never reached the buildings').not.toBe('districts')
  // `further` notches more, past the first one that shows buildings.
  for (let i = 0; i < further; i++) await notch()
  await page.mouse.move(2, 400)
  await page.waitForTimeout(1500)
}

/** The first building whose point on screen has the bare canvas under it, and that point. */
async function aimAtABuilding(ids: string[]): Promise<{ id: string; x: number; y: number }> {
  for (const id of ids) {
    const pt = await page.evaluate((b) => {
      const p = (window as unknown as { __termpolis_world?: Probe }).__termpolis_world?.screenPoint(b) ?? null
      const host = document.querySelector('[data-testid="world-canvas-host"] canvas')
      return p && document.elementFromPoint(p.x, p.y) === host ? p : null
    }, id)
    if (pt) return { id, ...pt }
  }
  throw new Error(`no building of ${ids.length} has the bare canvas under it`)
}

/**
 * The first building (the busiest first) whose aim point has the bare canvas under it and which the
 * renderer's pick gives the building there and at every CLICK_JITTER point round it.
 */
async function jitterAim(ids: string[]): Promise<{ id: string; x: number; y: number }> {
  const pt = await page.evaluate(({ all, jitter }) => {
    const probe = (window as unknown as { __termpolis_world?: Probe }).__termpolis_world
    const host = document.querySelector('[data-testid="world-canvas-host"] canvas')
    for (const id of all) {
      const p = probe?.screenPoint(id) ?? null
      if (!p || document.elementFromPoint(p.x, p.y) !== host) continue
      if ([[0, 0], ...jitter].every(([dx, dy]) => probe?.pickAt(p.x + dx, p.y + dy)?.id === id && document.elementFromPoint(p.x + dx, p.y + dy) === host)) return { id, ...p }
    }
    return null
  }, { all: ids, jitter: CLICK_JITTER })
  if (!pt) throw new Error(`no building of ${ids.length} has every point round its aim point to itself`)
  return pt
}

/** Connection labels on show (the hovered or selected part's lines). */
const shownLineLabels = (): Promise<number> =>
  page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.lw-edge')].filter((el) => getComputedStyle(el).display !== 'none').length)

/** Every label on show over the canvas (district, building, floor, process and line names), as "kind text". */
const shownLabels = (): Promise<string[]> =>
  page.evaluate(() => {
    const c = document.querySelector('[data-testid="world-canvas-host"] canvas')!.getBoundingClientRect()
    return [...document.querySelectorAll<HTMLElement>('.lw-labels > *')]
      .filter((el) => {
        const r = el.getBoundingClientRect()
        return getComputedStyle(el).display !== 'none' && r.width > 0 && r.right > c.left && r.left < c.right && r.bottom > c.top && r.top < c.bottom
      })
      .map((el) => `${el.className} ${el.textContent ?? ''}`)
      .sort()
  })

/** Pairs of labels on show over the canvas, of any kind, whose boxes overlap by more than a pixel, as "a / b". */
const overlappingLabels = (): Promise<string[]> =>
  page.evaluate(() => {
    const c = document.querySelector('[data-testid="world-canvas-host"] canvas')!.getBoundingClientRect()
    const boxes = [...document.querySelectorAll<HTMLElement>('.lw-labels > *')]
      .filter((el) => getComputedStyle(el).display !== 'none')
      .map((el) => ({ t: `${el.className} "${el.textContent ?? ''}"`, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.width > 0 && r.right > c.left && r.left < c.right && r.bottom > c.top && r.top < c.bottom)
    const out: string[] = []
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i].r
        const b = boxes[j].r
        if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1) out.push(`${boxes[i].t} / ${boxes[j].t}`)
      }
    }
    return out
  })

/** The probe's point for a building or line id. */
const probePoint = (id: string): Promise<{ x: number; y: number } | null> =>
  page.evaluate((x) => (window as unknown as { __termpolis_world?: Probe }).__termpolis_world?.screenPoint(x) ?? null, id)

/** Pairs of shown connection labels whose boxes overlap, as "a / b". */
const overlappingLineLabels = (): Promise<string[]> =>
  page.evaluate(() => {
    const shown = [...document.querySelectorAll<HTMLElement>('.lw-edge')].filter((el) => getComputedStyle(el).display !== 'none')
    const boxes = shown.map((el) => ({ t: el.textContent ?? '', r: el.getBoundingClientRect() }))
    const out: string[] = []
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i].r
        const b = boxes[j].r
        if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1) out.push(`${boxes[i].t} / ${boxes[j].t}`)
      }
    }
    return out
  })

/**
 * What the legend covers at overview: the buildings whose visible point on screen (the probe finds
 * one only on the canvas) is under the legend's box, and the district labels whose box overlaps it
 * or runs past the canvas edge.
 */
const underLegend = (ids: string[]): Promise<string[]> =>
  page.evaluate((all) => {
    const legend = document.querySelector('[data-testid="world-legend"]')
    const probe = (window as unknown as { __termpolis_world?: Probe }).__termpolis_world
    if (!legend || !probe) return ['no legend or probe']
    const l = legend.getBoundingClientRect()
    const c = document.querySelector('[data-testid="world-canvas-host"] canvas')!.getBoundingClientRect()
    const out: string[] = []
    for (const id of all) {
      const p = probe.screenPoint(id)
      if (!p) continue
      if (p.x >= l.left && p.x <= l.right && p.y >= l.top && p.y <= l.bottom) out.push(`building ${id}`)
    }
    for (const el of document.querySelectorAll<HTMLElement>('.lw-district')) {
      const r = el.getBoundingClientRect()
      if (r.width === 0 || getComputedStyle(el).display === 'none') continue
      if (r.left < c.left - 1 || r.right > c.right + 1 || r.top < c.top - 1 || r.bottom > c.bottom + 1) out.push(`district ${el.textContent} cut off by the canvas edge`)
      if (Math.min(r.right, l.right) - Math.max(r.left, l.left) > 1 && Math.min(r.bottom, l.bottom) - Math.max(r.top, l.top) > 1) out.push(`district ${el.textContent}`)
    }
    return out
  }, ids)

/**
 * Whether the card and the other panels are drawn over the labels: the card is the element under its
 * own centre, and for each label whose box overlaps a panel's, the panel is on top at the middle of
 * the overlap. Returns what failed, empty when nothing did.
 */
const panelsOverLabels = (): Promise<string[]> =>
  page.evaluate(() => {
    // Labels ignore the pointer (pointer-events: none), and elementFromPoint looks through such
    // elements; let them be hit for the check, so one painted over a panel is found.
    const hit = document.createElement('style')
    hit.textContent = '.lw-labels, .lw-labels * { pointer-events: auto !important }'
    document.head.appendChild(hit)
    const bad: string[] = []
    const cardEl = document.querySelector('[data-testid="world-card"]')!
    const c = cardEl.getBoundingClientRect()
    const atCentre = document.elementFromPoint(c.left + c.width / 2, c.top + c.height / 2)
    if (!atCentre || !cardEl.contains(atCentre)) bad.push(`card centre shows ${atCentre?.className ?? 'nothing'}`)
    const stage = document.querySelector('[data-testid="world-stage"]')!
    const panels = [...stage.children].filter((el) => el.getAttribute('data-testid') !== 'world-canvas-host')
    const labels = [...document.querySelectorAll<HTMLElement>('.lw-labels > *')].filter((el) => {
      const cs = getComputedStyle(el)
      return cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.05
    })
    for (const panel of panels) {
      const p = panel.getBoundingClientRect()
      if (p.width === 0 || p.height === 0) continue
      for (const l of labels) {
        const r = l.getBoundingClientRect()
        const x0 = Math.max(r.left, p.left)
        const x1 = Math.min(r.right, p.right)
        const y0 = Math.max(r.top, p.top)
        const y1 = Math.min(r.bottom, p.bottom)
        if (x1 - x0 < 1 || y1 - y0 < 1) continue
        const top = document.elementFromPoint((x0 + x1) / 2, (y0 + y1) / 2)
        if (!top || !panel.contains(top)) bad.push(`label "${l.textContent}" over ${panel.getAttribute('data-testid') ?? panel.tagName}`)
      }
    }
    hit.remove()
    return bad
  })

/** Back to the overview, nothing hovered or open. */
async function toOverview(): Promise<void> {
  if (await card().count()) await page.locator('[data-testid="world-card-close"]').click()
  await expect(card()).toHaveCount(0)
  await page.mouse.move(2, 400)
  await (await toolbarControl(page, 'world-reset')).click()
  await page.waitForTimeout(2500)
}

/** Whether line `id` can be seen: one of its points with no building in front is on the bare canvas (no panel over it). */
async function lineInSight(id: string): Promise<boolean> {
  return page.evaluate((id) => {
    const probe = (window as unknown as { __termpolis_world?: Probe }).__termpolis_world
    const host = document.querySelector('[data-testid="world-canvas-host"] canvas')
    return !!probe && !!host && probe.linePoints(id).some((p) => document.elementFromPoint(p.x, p.y) === host)
  }, id)
}

/** The line on the open card: one of `at`'s lines with the card's title, whose ends' names its "From → To" line holds. */
function cardLine(w: World, at: string, title: string, route: string): Line | undefined {
  // The route reads "from -> to" (an arrow between the two names): each named end must be one of
  // the two names exactly, so "main" does not match a route through "mainAgentIntegrationIpc.test".
  const ends = route.split('→').map((s) => s.trim())
  return w.edges.find((e) => edgeSummary(e.label) === title && (e.from === at || e.to === at) && [e.from, e.to].every((x) => !w.names[x] || ends.includes(w.names[x])))
}

/**
 * The checks of one world in the given themes (see the top of the file). `tag` names the shots;
 * `extra` (the first theme only) adds the click jitter and the click on a line over open ground.
 */
async function checkWorld(tag: string, dir: string, themes: readonly string[]): Promise<void> {
  if (await pane().count()) {
    await page.locator('[data-testid="world-close"]').click()
    await expect(pane()).toHaveCount(0)
  }
  await createTerminal(`Visual ${tag}`, dir)
  const first = await openPane()
  // The pane sits under the title bar (the window controls stay usable) and is opaque from its
  // first frame, so the terminal never shows through while the world loads.
  expect(first.top, `pane top ${first.top} is above the title bar's bottom ${first.titleBottom}`).toBeGreaterThanOrEqual(first.titleBottom - 0.5)
  expect(first.titleBottom).toBeGreaterThan(0)
  expect(first.background, `the pane's first frame (${first.testid}) is not opaque`).toMatch(/^rgb\(/)
  expect(first.opacity, `the pane's first frame (${first.testid}) is faded`).toBe(1)

  await settled(240_000)
  // A repository past the host's first-map size (Termpolis itself) is drawn first from its file listing, with no lines,
  // and settles in place once the complete world is done: the checks wait for that one.
  if ((await world(dir)).provisional) {
    await expect.poll(async () => (await world(dir)).provisional, { timeout: 240_000 }).toBe(false)
    await settled(240_000)
  }
  const w = await world(dir)
  const { ids, connected, names, districts } = w
  expect(ids.length).toBeGreaterThan(1)
  const wantLabels = Math.min(MIN_DISTRICT_LABELS, districts)

  for (const [t, theme] of themes.entries()) {
    await (await toolbarControl(page, 'world-theme')).selectOption(theme)
    await closeMore(page)
    await toOverview()

    const m = await measure(`${tag}-${theme}-canvas.png`)
    console.log(`[world-visual] ${tag} ${theme}: mean ${m.mean.toFixed(1)} (background ${m.bgY.toFixed(1)}), lit ${(m.lit * 100).toFixed(2)}%, white ${(m.white * 100).toFixed(3)}%`)
    expect(m.mean - m.bgY, `${tag}/${theme}: the canvas is too dark (mean ${m.mean.toFixed(1)})`).toBeGreaterThan(MIN_MEAN_OVER_BACKGROUND)
    expect(m.lit, `${tag}/${theme}: too few pixels stand out from the background`).toBeGreaterThan(MIN_LIT_FRACTION)
    expect(m.white, `${tag}/${theme}: ${(m.white * 100).toFixed(2)}% of the canvas is saturated white`).toBeLessThan(MAX_WHITE_FRACTION)

    const labels = await districtLabels()
    const readable = labels.filter((l) => l.inside && l.opacity > 0.05 && l.visibility === 'visible' && l.font >= MIN_LABEL_FONT_PX)
    if (readable.length < wantLabels) await page.locator('[data-testid="world-canvas-host"]').screenshot({ path: test.info().outputPath(`${tag}-${theme}-host.png`) })
    expect(readable.length, `${tag}/${theme}: readable district labels ${JSON.stringify(labels)}`).toBeGreaterThanOrEqual(wantLabels)
    expect(await underLegend(ids), `${tag}/${theme}: under the legend at overview`).toEqual([])
    expect(await overlappingLabels(), `${tag}/${theme}: labels overlap at overview`).toEqual([])
    if (tag === 'small') {
      // The pane at its default width (40% of the window, a portrait canvas): every district of the
      // small project is named, and no two names overlap.
      const paneWidth = await pane().evaluate((el) => Math.round(el.getBoundingClientRect().width))
      expect(readable.map((l) => l.text).sort(), `${tag}/${theme}: every district named in a ${paneWidth} px pane ${JSON.stringify(labels)}`).toEqual(labels.map((l) => l.text).sort())
      expect(readable.length, `${tag}/${theme}: district labels in a ${paneWidth} px pane`).toBe(districts)
      expect(await overlappingDistrictLabels(), `${tag}/${theme}: district labels overlap in a ${paneWidth} px pane`).toEqual([])
    }
    if (t === 0) expect(await askOutsideStage(), `${tag}: the ask bar runs past the pane`).toEqual([])
    // A still camera keeps the same labels: nothing flickers in or out.
    const still = await shownLabels()
    await page.waitForTimeout(400)
    expect(await shownLabels(), `${tag}/${theme}: the overview's labels change with the camera still`).toEqual(still)
    await page.screenshot({ path: path.join(SHOTS, `${tag}-${theme}-overview.png`) })

    // Hover: the building's connections light up with their labels (spec: hover shows how it
    // connects), a few at most, and no label over another. The overview shows district slabs, so
    // first closer, where the buildings stand.
    await toBuildingsTier()
    expect(await shownLineLabels(), `${tag}/${theme}: line labels show before any hover`).toBe(0)
    const over = await aimAtABuilding(connected)
    await page.mouse.move(over.x, over.y)
    await expect.poll(shownLineLabels, { message: `${tag}/${theme}: hovering shows no line labels` }).toBeGreaterThan(0)
    await page.waitForTimeout(600)
    expect(await shownLineLabels(), `${tag}/${theme}: too many line labels on hover`).toBeLessThanOrEqual(MAX_HOVER_LINE_LABELS)
    expect(await overlappingLabels(), `${tag}/${theme}: labels overlap on hover`).toEqual([])
    await page.screenshot({ path: path.join(SHOTS, `${tag}-${theme}-hover.png`) })

    // The click lands where the hover labels gather: it must open the building's own card.
    await page.mouse.click(over.x, over.y)
    await expect(card()).toBeVisible()
    await expect(card().locator('h3').first(), `${tag}/${theme}: the click opened another card`).toHaveText(names[over.id])
    await page.waitForTimeout(1500)
    expect(await panelsOverLabels(), `${tag}/${theme}: a label is drawn over a panel`).toEqual([])
    expect(await overlappingLabels(), `${tag}/${theme}: labels overlap after the click`).toEqual([])
    await page.screenshot({ path: path.join(SHOTS, `${tag}-${theme}-click.png`) })
    const close = await measure(`${tag}-${theme}-click-canvas.png`)
    console.log(`[world-visual] ${tag} ${theme} close-up: white ${(close.white * 100).toFixed(3)}%`)
    expect(close.white, `${tag}/${theme}: ${(close.white * 100).toFixed(2)}% of the close-up is saturated white`).toBeLessThan(MAX_WHITE_FRACTION)

    // A line label of the selected building opens the line's card: the camera frames the line from
    // outside, both ends in view (each has a point on screen where a click picks it), no white-out.
    const tagPt = await page.evaluate(() => {
      for (const el of document.querySelectorAll<HTMLElement>('.lw-edge')) {
        if (getComputedStyle(el).display === 'none') continue
        const r = el.getBoundingClientRect()
        const x = r.left + r.width / 2
        const y = r.top + r.height / 2
        const hit = document.elementFromPoint(x, y)
        if (hit && el.contains(hit)) return { x, y, text: el.textContent ?? '' }
      }
      return null
    })
    expect(tagPt, `${tag}/${theme}: no line label of the selection can be clicked`).not.toBeNull()
    await page.mouse.click(tagPt!.x, tagPt!.y)
    await expect(card()).toBeVisible()
    await expect(card().locator('h3').first(), `${tag}/${theme}: the line label opened another card`).toHaveText(tagPt!.text)
    await page.mouse.move(2, 400)
    await page.waitForTimeout(1800)
    const line = cardLine(w, over.id, tagPt!.text, (await card().locator('p.muted').first().textContent()) ?? '')
    expect(line, `${tag}/${theme}: the line card names no line of the world`).toBeTruthy()
    // The shot first, so a failing end below can be seen.
    await page.screenshot({ path: path.join(SHOTS, `${tag}-${theme}-line-card.png`) })
    for (const end of [line!.from, line!.to]) {
      if (!names[end]) continue // an external: an orb, not a building
      expect(await probePoint(end), `${tag}/${theme}: ${names[end]}, an end of "${tagPt!.text}", is not in view`).not.toBeNull()
    }
    // The line itself is in sight, not hidden behind the towers in front of it: seen from the
    // camera, some stretch of it has no building in front of it and no panel over it.
    expect(await lineInSight(line!.id), `${tag}/${theme}: "${tagPt!.text}" is hidden in its own close-up`).toBe(true)
    expect(await overlappingLabels(), `${tag}/${theme}: labels overlap on the line card`).toEqual([])
    expect(await panelsOverLabels(), `${tag}/${theme}: a label is drawn over the line card`).toEqual([])
    const lineClose = await measure(`${tag}-${theme}-line-card-canvas.png`)
    console.log(`[world-visual] ${tag} ${theme} line close-up: white ${(lineClose.white * 100).toFixed(3)}%`)
    expect(lineClose.white, `${tag}/${theme}: ${(lineClose.white * 100).toFixed(2)}% of the line close-up is saturated white`).toBeLessThan(MAX_WHITE_FRACTION)

    if (t === 0) {
      // A real click a few pixels off the aim point opens the same building's card, at a building
      // whose aim point and every point round it the renderer's pick gives to that building (a line
      // drawn across a building's face rightly takes the click where it runs). From the same
      // distance in each time: the overview itself shows district slabs, no buildings.
      // A big world's buildings can be too small at the first buildings notch for any to fill the
      // jitter round its aim point, so the camera goes a few notches nearer until one does.
      let further = 0
      let steady: { id: string; x: number; y: number } | null = null
      for (; further <= 12; further += 4) {
        await toOverview()
        await toBuildingsTier(further)
        steady = await jitterAim(connected).catch(() => null)
        if (steady) break
      }
      if (!steady) throw new Error(`no steady aim on ${connected} at any zoom tried (up to ${further - 4} further)`)
      for (const [dx, dy] of CLICK_JITTER) {
        await toOverview()
        await toBuildingsTier(further)
        // What the page holds at the click point just before the click, so a miss names its cause.
        const at = await page.evaluate(({ id, x, y }) => {
          const probe = (window as unknown as { __termpolis_world?: Probe }).__termpolis_world
          const p = probe?.screenPoint(id) ?? null
          const el = document.elementFromPoint(x, y) as HTMLElement | null
          const pick = probe?.pickAt(x, y) ?? null
          return `aim ${p ? `${p.x.toFixed(1)},${p.y.toFixed(1)}` : 'none'}; pick ${pick ? `${pick.kind}:${pick.id}` : 'none'}; top ${el ? `${el.tagName.toLowerCase()}.${el.className}` : 'none'}`
        }, { id: steady.id, x: steady.x + dx, y: steady.y + dy })
        await page.mouse.click(steady.x + dx, steady.y + dy)
        if (!(await card().count())) await page.locator('[data-testid="world-canvas-host"]').screenshot({ path: test.info().outputPath(`${tag}-jitter-${dx}-${dy}-host.png`) })
        await expect(card(), `${tag}: no card for a click ${dx},${dy} px off ${names[steady.id]} (steady ${steady.x.toFixed(1)},${steady.y.toFixed(1)}; ${at})`).toBeVisible()
        await expect(card().locator('h3').first(), `${tag}: a click ${dx},${dy} px off the aim point opened another card`).toHaveText(names[steady.id])
      }
      // A line clicked where it runs over open ground opens its card.
      await toOverview()
      let opened = false
      for (const e of w.edges) {
        if (e.from === e.to) continue
        const pt = await page.evaluate(async (id) => {
          const p = (window as unknown as { __termpolis_world?: Probe }).__termpolis_world?.screenPoint(id) ?? null
          const host = document.querySelector('[data-testid="world-canvas-host"] canvas')
          return p && document.elementFromPoint(p.x, p.y) === host ? p : null
        }, e.id)
        if (!pt) continue
        await page.mouse.click(pt.x, pt.y)
        await expect(card(), `${tag}: clicking the line ${e.id} opened no card`).toBeVisible()
        await expect(card().locator('h3').first(), `${tag}: clicking the line ${e.id} opened another card`).toHaveText(edgeSummary(e.label))
        await expect(card().locator('p.muted').first()).toContainText('→')
        opened = true
        break
      }
      expect(opened, `${tag}: no line of ${w.edges.length} runs over open ground in view`).toBe(true)
      // From the overview a district is one slab: the pick there gives the district, and a click on
      // it focuses the district as choosing it in the tree does (no card; the camera frames its buildings).
      await toOverview()
      const slab = await page.evaluate(() => {
        const probe = (window as unknown as { __termpolis_world: Probe }).__termpolis_world
        const host = document.querySelector('[data-testid="world-canvas-host"] canvas') as HTMLCanvasElement
        const r = host.getBoundingClientRect()
        for (let y = r.top + 8; y < r.bottom; y += 8) {
          for (let x = r.left + 8; x < r.right; x += 8) {
            const hit = probe.pickAt(x, y)
            if (hit?.kind === 'district' && document.elementFromPoint(x, y) === host) return { x, y, id: hit.id }
          }
        }
        return null
      })
      expect(slab, `${tag}: no district slab has the bare canvas over it at the overview`).not.toBeNull()
      const target = (): Promise<number[]> => page.evaluate(() => (window as unknown as { __termpolis_world: { cameraState(): { target: number[] } } }).__termpolis_world.cameraState().target)
      const before = await target()
      await page.mouse.click(slab!.x, slab!.y)
      await expect.poll(async () => Math.hypot(...(await target()).map((v, k) => v - before[k])), { message: `${tag}: clicking the slab of ${slab!.id} did not frame the district`, timeout: 5000 }).toBeGreaterThan(0.5)
      await expect(card(), `${tag}: a district has no card`).toHaveCount(0)
    }
    await toOverview()
  }
}

test.describe.serial('Lumopolis can be seen', () => {
  for (const [index, label] of ['small', 'big'].entries()) {
    test(`${index + 1}. the ${label} project is visible and readable in every theme`, async () => {
      test.setTimeout(420_000)
      const fx = fixtures.find((f) => f.label === label)!
      await checkWorld(label, fx.dir, THEMES)
      const { ids } = await world(fx.dir)
      await (await toolbarControl(page, 'world-theme')).selectOption('neon')
      await closeMore(page)

      // A resize fits the overview again: the city stays on the canvas and out of the legend's strip.
      await toOverview()
      await page.setViewportSize({ width: 1000, height: 700 })
      await page.waitForTimeout(1500)
      expect(await underLegend(ids), `${label}: under the legend after a resize`).toEqual([])
      expect(await overlappingLabels(), `${label}: labels overlap after a resize`).toEqual([])
      expect(await askOutsideStage(), `${label}: the ask bar runs past the pane after a resize`).toEqual([])
      await page.screenshot({ path: path.join(SHOTS, `${label}-neon-resized.png`) })
      await page.setViewportSize({ width: 1280, height: 800 })
      await page.waitForTimeout(1500)
      expect(await underLegend(ids), `${label}: under the legend after resizing back`).toEqual([])
    })
  }

  test('3. this repository (Termpolis) keeps its labels apart and its clicks true', async () => {
    test.setTimeout(420_000)
    await checkWorld('termpolis', path.resolve('.'), ['neon'])
  })

  /** The world compiler's building cap (src/main/world/group.ts), read from its source: group.ts imports main-process modules. */
  function compilerBuildingCap(): number {
    const m = /export const DEFAULT_MAX_BUILDINGS = (\d+)/.exec(fs.readFileSync(path.resolve('src/main/world/group.ts'), 'utf8'))
    if (!m) throw new Error('DEFAULT_MAX_BUILDINGS not found in src/main/world/group.ts')
    return Number(m[1])
  }

  test('4. a 600-file world draws in under 150 draw calls and changes tier with distance', async () => {
    test.setTimeout(420_000)
    const fx = fixtures.find((f) => f.label === 'huge')!
    if (await pane().count()) {
      await page.locator('[data-testid="world-close"]').click()
      await expect(pane()).toHaveCount(0)
    }
    await createTerminal('Visual huge', fx.dir)
    await openPane()
    await settled(240_000)
    const { ids } = await world(fx.dir)
    expect(ids.length).toBeGreaterThan(1)
    await (await toolbarControl(page, 'world-theme')).selectOption('neon')
    await closeMore(page)
    await toOverview()
    const drawn = (): Promise<Drawn> => page.evaluate(() => (window as unknown as { __termpolis_world: Probe }).__termpolis_world.drawn())
    const far = await drawn()
    console.log(`[world-visual] huge: ${far.buildings} buildings in ${far.districts} districts (${far.slabs} slabs), ${far.drawCalls} draw calls at the overview (tier ${far.tier}, ${far.conduits} conduits)`)
    await page.screenshot({ path: path.join(SHOTS, 'huge-neon-overview.png') })
    expect(far.tier).toBe('districts')
    // 600 files group into as many buildings as the compiler allows, and from far away each district is one slab.
    expect(far.buildings).toBe(compilerBuildingCap())
    expect(far.districts).toBeGreaterThan(1)
    expect(far.slabs).toBe(far.districts)
    // Every conduit is still its own draw call (lines are not batched).
    expect(far.drawCalls).toBeGreaterThanOrEqual(far.conduits)
    expect(far.drawCalls, `${far.drawCalls} draw calls at the overview`).toBeLessThan(150)
    expect(far.drawCalls).toBeGreaterThan(0)

    await page.evaluate((id) => (window as unknown as { __termpolis_world: Probe }).__termpolis_world.apply({ type: 'focus', ids: [id] }), ids[0])
    await expect.poll(async () => (await drawn()).tier, { timeout: 10_000 }).toBe('floors')
    await page.waitForTimeout(1500)
    const near = await drawn()
    console.log(`[world-visual] huge: ${near.drawCalls} draw calls focused on one building (tier ${near.tier})`)
    expect(near.slabs).toBe(0)
    await page.screenshot({ path: path.join(SHOTS, 'huge-neon-focused.png') })
    await toOverview()
    await expect.poll(async () => (await drawn()).tier, { timeout: 10_000 }).toBe('districts')
  })
})

/**
 * What is drawn, read off the renderer's own objects (drawn().visual), on the small app with a
 * verified store and an outside service, in the neon theme at high quality (the default), with
 * motion on: the exploded building, the orbit and the flying keys, the ring, the bloom, the stars
 * and dust, the hexagonal platforms and their lights, the floors, the orbs, the eased flights and
 * the line labels.
 */
interface Visual {
  ringAngle: number; bloom: boolean; stars: number; dust: number
  platformSides: Record<string, number>; platformLights: number
  floorOrder: Record<string, string[]>; orbs: string[]; exploded: string | null; explodeGap: number
  flight: { active: boolean; t: number; eased: number }; lineLabels: number
}
interface MotionDoc { buildings: { id: string; floors: { name: string }[] }[]; externals: { id: string }[]; edges: { id: string }[]; districts: { id: string }[] }
type Cam = { pos: number[]; target: number[] }

test.describe.serial('Lumopolis draws what the spec describes', () => {
  let motionDoc: MotionDoc
  const visual = (): Promise<Visual> => page.evaluate(() => (window as unknown as { __termpolis_world: { drawn(): { visual: Visual } } }).__termpolis_world.drawn().visual)
  const cam = (): Promise<Cam> => page.evaluate(() => (window as unknown as { __termpolis_world: { cameraState(): Cam } }).__termpolis_world.cameraState())
  const dist = (c: Cam): number => Math.hypot(...c.pos.map((v, k) => v - c.target[k]))
  /** A point on the bare canvas, away from every part, near the canvas's middle. */
  const bareSpot = (): Promise<{ x: number; y: number }> =>
    page.evaluate(() => {
      const probe = (window as unknown as { __termpolis_world: Probe }).__termpolis_world
      const host = document.querySelector('[data-testid="world-canvas-host"] canvas') as HTMLCanvasElement
      const r = host.getBoundingClientRect()
      const cx = r.left + r.width / 2
      const cy = r.top + r.height / 2
      let best: { x: number; y: number; d: number } | null = null
      for (let y = r.top + 40; y < r.bottom - 40; y += 12) {
        for (let x = r.left + 40; x < r.right - 40; x += 12) {
          if (probe.pickAt(x, y) !== null || document.elementFromPoint(x, y) !== host) continue
          const d = Math.hypot(x - cx, y - cy)
          if (!best || d < best.d) best = { x, y, d }
        }
      }
      if (!best) throw new Error('no bare spot on the canvas')
      return { x: best.x, y: best.y }
    })

  test.beforeAll(async () => {
    test.setTimeout(420_000)
    // Motion on, whatever this machine's setting: the rings, flights and keys stand still with reduced motion.
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    if (await pane().count()) {
      await page.locator('[data-testid="world-close"]').click()
      await expect(pane()).toHaveCount(0)
    }
    const fx = fixtures.find((f) => f.label === 'motion')!
    await createTerminal('Visual motion', fx.dir)
    await openPane()
    await settled(240_000)
    await (await toolbarControl(page, 'world-theme')).selectOption('neon')
    await closeMore(page)
    // OrbitControls (three r160) divides the wheel delta by `devicePixelRatio | 0` (see toBuildingsTier).
    await page.evaluate(() => { if ((window.devicePixelRatio | 0) === 0) Object.defineProperty(window, 'devicePixelRatio', { get: () => 1, configurable: true }) })
    motionDoc = await page.evaluate(async (r) => {
      const api = (window as unknown as { termpolis: { gitFindRoot: (c: string) => Promise<{ success: boolean; data?: string }>; worldGet: (c: string) => Promise<{ success: boolean; data?: MotionDoc | null }> } }).termpolis
      const top = await api.gitFindRoot(r)
      const res = await api.worldGet(top.success && top.data ? top.data : r)
      return res.data as MotionDoc
    }, fx.dir)
    expect(motionDoc.buildings.length).toBeGreaterThan(1)
    await toOverview()
  })

  test('the first double-click on a building explodes it floor by floor, and selects no page text', async () => {
    await toOverview()
    await toBuildingsTier()
    await expect(card()).toHaveCount(0)
    await page.evaluate(() => getSelection()?.removeAllRanges())
    // Film bugs 5 and 6: nothing selected or open yet, the first double-click explodes the building
    // (its first click no longer opens a card over it), and selects none of the page's text.
    const at = await jitterAim(motionDoc.buildings.map((b) => b.id))
    await page.mouse.dblclick(at.x, at.y)
    await expect.poll(async () => (await visual()).exploded, { timeout: 5000 }).toBe(at.id)
    await expect.poll(async () => (await visual()).explodeGap, { timeout: 5000 }).toBeGreaterThan(0)
    expect(await page.evaluate(() => getSelection()?.toString() ?? '')).toBe('')
  })

  test('an exploded building stays exploded through a live change, and the change toast is in plain view at 1920x1080 and in a small window', async () => {
    const exploded = (await visual()).exploded
    expect(exploded).not.toBeNull()
    const dir = fixtures.find((f) => f.label === 'motion')!.dir
    test.setTimeout(420_000)
    // Main watches a folder once it has indexed its code. The terminal's own index of this folder can
    // still be waiting behind an earlier, bigger repository's (test 3 maps this one), so it is asked for
    // here and awaited: the watcher is on before the change.
    const indexed = await page.evaluate(async (r) => {
      const api = (window as unknown as { termpolis: { gitFindRoot: (c: string) => Promise<{ success: boolean; data?: string }>; memoryIngestCode: (root: string) => Promise<{ success: boolean; error?: string }> } }).termpolis
      const top = await api.gitFindRoot(r)
      const res = await api.memoryIngestCode(top.success && top.data ? top.data : r)
      return res.success ? '' : String(res.error)
    }, dir)
    expect(indexed).toBe('')
    const sizes: Array<[number, number]> = [[1920, 1080], [900, 600]]
    for (const [i, [width, height]] of sizes.entries()) {
      await page.setViewportSize({ width, height })
      await page.waitForTimeout(3500) // any toast still up has gone
      // Waits in the page for the toast and measures it the moment it shows (it stays up 3 s).
      const shown = page.evaluate(() => new Promise<{ text: string; hits: boolean[]; over: string[]; inHost: boolean; overAsk: boolean; overLegend: boolean }>((resolve, reject) => {
        const t0 = performance.now()
        const tick = (): void => {
          const el = document.querySelector<HTMLElement>('.lw-toast')
          if (el && !el.hidden && el.textContent) {
            const r = el.getBoundingClientRect()
            // The toast lets clicks through (pointer-events none), so hit-testing finds what is
            // painted over it only while it takes them.
            const was = el.style.pointerEvents
            el.style.pointerEvents = 'auto'
            const cx = (r.left + r.right) / 2
            const cy = (r.top + r.bottom) / 2
            const points: Array<[number, number]> = [[cx, cy], [r.left + 4, cy], [r.right - 4, cy], [cx, r.top + 2], [cx, r.bottom - 2]]
            const tops = points.map(([x, y]) => document.elementFromPoint(x, y))
            const hits = tops.map((at) => at !== null && (at === el || el.contains(at)))
            // What lies over it where it is covered, to name in the failure.
            const over = tops.map((at, k) => (hits[k] || at === null ? '' : `${at.tagName.toLowerCase()}${at.getAttribute('data-testid') ? `[${at.getAttribute('data-testid')}]` : ''}.${String(at.getAttribute('class') ?? '').split(' ')[0]}`))
            el.style.pointerEvents = was
            const meets = (sel: string): boolean => {
              const n = document.querySelector(sel)
              if (!n) return false
              const b = n.getBoundingClientRect()
              return b.width > 0 && b.height > 0 && r.left < b.right && b.left < r.right && r.top < b.bottom && b.top < r.bottom
            }
            const host = document.querySelector('[data-testid="world-canvas-host"]')!.getBoundingClientRect()
            const inHost = r.left >= host.left && r.right <= host.right && r.top >= host.top && r.bottom <= host.bottom
            resolve({ text: el.textContent, hits, over, inHost, overAsk: meets('[data-testid="world-ask"]'), overLegend: meets('[data-testid="world-legend"]') })
            return
          }
          if (performance.now() - t0 > 90_000) { reject(new Error('no change toast within 90 s')); return }
          setTimeout(tick, 40)
        }
        tick()
      }))
      // A live change: a new file in the ui part (its members change, so the toast says "1 changed").
      // The watcher recompiles and the pane loads the new world over the old one.
      fs.writeFileSync(path.join(dir, `src/ui/More${i}.ts`), `import { list } from './List'\nexport const more${i} = (): number => list() + ${i}\n`)
      const toast = await shown
      await page.screenshot({ path: path.join(SHOTS, `live-change-toast-${width}x${height}.png`) })
      expect(toast.text.length).toBeGreaterThan(0)
      expect(toast.hits, `toast "${toast.text}" at ${width}x${height}: centre, left, right, top, bottom on top (under: ${toast.over.join(', ')})`).toEqual([true, true, true, true, true])
      expect(toast.inHost).toBe(true)
      expect(toast.overAsk).toBe(false)
      expect(toast.overLegend).toBe(false)
      // Film bug 6: the reload kept the exploded building.
      expect((await visual()).exploded).toBe(exploded)
    }
    // The later tests compare against motionDoc: the added files go, and the world is back as it was.
    for (const i of sizes.keys()) fs.rmSync(path.join(dir, `src/ui/More${i}.ts`))
    const members = async (): Promise<string> => page.evaluate(async (r) => {
      const api = (window as unknown as { termpolis: { gitFindRoot: (c: string) => Promise<{ success: boolean; data?: string }>; worldGet: (c: string) => Promise<{ success: boolean; data?: { buildings: { members: string[] }[] } | null }> } }).termpolis
      const top = await api.gitFindRoot(r)
      const res = await api.worldGet(top.success && top.data ? top.data : r)
      return JSON.stringify((res.data?.buildings ?? []).map((b) => b.members))
    }, dir)
    await expect.poll(async () => (await members()).includes('More'), { timeout: 90_000 }).toBe(false)
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.waitForTimeout(1000)
    await toOverview()
  })

  test('orbit drags and wheel zooms the camera', async () => {
    await toOverview()
    const spot = await bareSpot()
    const before = await cam()
    await page.mouse.move(spot.x, spot.y)
    await page.mouse.down()
    for (let i = 1; i <= 10; i++) await page.mouse.move(spot.x + i * 15, spot.y + i * 3)
    await page.mouse.up()
    await page.waitForTimeout(800)
    const dragged = await cam()
    expect(Math.hypot(...dragged.pos.map((v, k) => v - before.pos[k])), 'a drag did not orbit the camera').toBeGreaterThan(0.5)
    await page.mouse.wheel(0, -400)
    await expect.poll(async () => dist(await cam()), { timeout: 5000, message: 'the wheel did not zoom in' }).toBeLessThan(dist(dragged) - 0.5)
    await toOverview()
  })

  test('W and Q fly the camera', async () => {
    await toOverview()
    // W flies forward. The overview looks along +z, so the camera is first orbited round (dragged
    // across bare canvas) until it looks along -z.
    const facing = (c: Cam): number => (c.target[2] - c.pos[2]) / Math.hypot(c.target[0] - c.pos[0], c.target[2] - c.pos[2])
    for (let i = 0; i < 40 && facing(await cam()) > -0.9; i++) {
      const spot = await bareSpot()
      await page.mouse.move(spot.x, spot.y)
      await page.mouse.down()
      for (let k = 1; k <= 4; k++) await page.mouse.move(spot.x + k * 10, spot.y)
      await page.mouse.up()
      await page.waitForTimeout(150)
    }
    await page.waitForTimeout(800)
    expect(facing(await cam()), 'the camera never came round to look along -z').toBeLessThan(-0.85)
    await page.mouse.move(2, 400)
    await page.locator('[data-testid="world-canvas-host"]').focus()
    const start = await cam()
    await page.keyboard.down('w')
    await page.waitForTimeout(500)
    await page.keyboard.up('w')
    await page.waitForTimeout(200)
    const afterW = await cam()
    expect(afterW.target[2], 'W did not move the target along -z').toBeLessThan(start.target[2] - 0.5)
    // Q and E move straight down and up (threeRenderer's WASD/QE keys).
    await page.keyboard.down('q')
    await page.waitForTimeout(500)
    await page.keyboard.up('q')
    await page.waitForTimeout(200)
    const afterQ = await cam()
    expect(afterQ.target[1], 'Q did not move the target down').toBeLessThan(afterW.target[1] - 0.5)
    await page.keyboard.down('e')
    await page.waitForTimeout(500)
    await page.keyboard.up('e')
    await page.waitForTimeout(200)
    expect((await cam()).target[1], 'E did not move the target up').toBeGreaterThan(afterQ.target[1] + 0.5)
    await toOverview()
  })

  test('verified buildings carry a rotating ring', async () => {
    // Test reports are found with node's fs.promises.glob (Node 22+, Electron 32+). An older Electron,
    // such as a local node_modules that predates the pinned one, finds none, so nothing is verified.
    const node = Number((await app.evaluate(() => process.versions.node)).split('.')[0])
    test.skip(node < 22, `this Electron runs Node ${node}, which has no fs.promises.glob to find the test report`)
    const a = (await visual()).ringAngle
    await page.waitForTimeout(500)
    const statuses = await page.evaluate(async (r) => {
      const api = (window as unknown as { termpolis: { gitFindRoot: (c: string) => Promise<{ success: boolean; data?: string }>; worldGet: (c: string) => Promise<{ success: boolean; data?: { buildings: { id: string; status: string; members: string[]; claims?: unknown }[] } | null }> } }).termpolis
      const top = await api.gitFindRoot(r)
      const res = await api.worldGet(top.success && top.data ? top.data : r)
      return JSON.stringify(res.data?.buildings.map((b) => [b.id, b.status, b.members]))
    }, fixtures.find((f) => f.label === 'motion')!.dir)
    // Drawn in software the looping motions are drawn up to SOFTWARE_LOOP_MAX_MS (500 ms) apart: wait for the next one.
    await expect.poll(async () => (await visual()).ringAngle, { timeout: 5000, message: `no ring turns: ${statuses}` }).toBeGreaterThan(a)
  })

  test('bloom, starfield and dust are on', async () => {
    const v = await visual()
    expect(v.bloom).toBe(true)
    expect(v.stars).toBeGreaterThanOrEqual(1000)
    expect(v.dust).toBeGreaterThan(0)
  })

  test('district platforms are hexagons with pooled light', async () => {
    const v = await visual()
    const sides = Object.values(v.platformSides)
    expect(sides.length).toBe(motionDoc.districts.length)
    expect(sides.every((n) => n === 6), `platform sides ${JSON.stringify(v.platformSides)}`).toBe(true)
    expect(v.platformLights).toBeGreaterThanOrEqual(motionDoc.districts.length)
  })

  test('floors stack in pipeline order', async () => {
    const v = await visual()
    for (const b of motionDoc.buildings) expect(v.floorOrder[b.id], `floors of ${b.id}`).toEqual(b.floors.map((f) => f.name))
  })

  test('externals float as orbs', async () => {
    const v = await visual()
    expect(motionDoc.externals.length).toBeGreaterThan(0)
    expect([...v.orbs].sort()).toEqual(motionDoc.externals.map((x) => x.id).sort())
  })

  test('camera flights ease', async () => {
    // One flight's frames, as drawn. In software one frame can take longer than the whole flight: the macOS soak
    // (45728064997) drew t=0.002 and t=0.012, then t=1. The ease is a function of t alone, so points from more than one
    // flight to the same building lie on the same curve: the test flies again, at most FLIGHTS times, until it has
    // seen at least 4 distinct points, and checks them all together.
    const FLIGHTS = 4
    const fly = async (): Promise<Array<{ t: number; eased: number }>> => page.evaluate(async (id) => {
      const probe = (window as unknown as { __termpolis_world: { drawn(): { visual: Visual }; apply(a: { type: 'focus'; ids: string[] }): Promise<void> } }).__termpolis_world
      void probe.apply({ type: 'focus', ids: [id] })
      const out: Array<{ t: number; eased: number }> = []
      const t0 = performance.now()
      await new Promise<void>((done) => {
        const tick = (): void => {
          const f = probe.drawn().visual.flight
          if (f.active) out.push({ t: f.t, eased: f.eased })
          if ((out.length > 0 && !f.active) || performance.now() - t0 > 8000) done()
          else requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      })
      return out
    }, motionDoc.buildings[0].id)
    const flights: Array<Array<{ t: number; eased: number }>> = []
    let pts: Array<{ t: number; eased: number }> = []
    for (let n = 0; n < FLIGHTS && pts.length < 4; n++) {
      await toOverview()
      const samples = await fly()
      // Each flight's own points must rise with time: a sample never goes back along the flight.
      for (let i = 1; i < samples.length; i++) expect(samples[i].t, `flight ${n} went back at sample ${i}: ${JSON.stringify(samples)}`).toBeGreaterThanOrEqual(samples[i - 1].t)
      flights.push(samples)
      // Distinct points of every flight so far, in order of t.
      pts = flights.flat().sort((a, b) => a.t - b.t).filter((p, i, all) => i === 0 || p.t > all[i - 1].t)
    }
    expect(pts.length, `flight samples ${JSON.stringify(flights)}`).toBeGreaterThanOrEqual(4)
    for (let i = 1; i < pts.length; i++) expect(pts[i].eased, `eased falls at sample ${i}`).toBeGreaterThanOrEqual(pts[i - 1].eased)
    // Eased: slow off the mark, fastest mid-flight (the rise per unit of time, so uneven frames do not count).
    const rate = (i: number): number => (pts[i + 1].eased - pts[i].eased) / (pts[i + 1].t - pts[i].t)
    const mid = pts.findIndex((p) => p.t >= 0.5)
    const m = Math.max(1, Math.min(pts.length - 2, mid > 0 ? mid - 1 : Math.floor(pts.length / 2)))
    // An ease in and out runs behind a straight line before the middle and ahead of it after.
    for (const p of pts) {
      if (p.t > 0.05 && p.t < 0.45) expect(p.eased, `not eased in at t=${p.t}: ${JSON.stringify(pts)}`).toBeLessThan(p.t)
      if (p.t > 0.55 && p.t < 0.95) expect(p.eased, `not eased out at t=${p.t}: ${JSON.stringify(pts)}`).toBeGreaterThan(p.t)
    }
    // The first step is slow off the mark only when it was seen: a slow runner's first frame of the
    // flight can come well into it (macOS CI's first sample was at t=0.56, already slowing down).
    // And only when that step ends before the middle. In software only one frame is in flight, and the
    // macOS soak's second drawn frame of a flight came at t=0.71 and t=0.92. A step from 0 to there
    // averages eased(t)/t, which for an ease in and out is above 1 once t is past the middle (the check
    // above holds eased(t) > t there). The step after it, near the end, is slowing down, so that
    // comparison fails for a correct ease. The ease itself is still checked at every point by the loop above.
    if (pts[0].t < 0.25 && pts[1].t <= 0.5) expect(rate(0), `first step ${rate(0)} vs middle step ${rate(m)}: ${JSON.stringify(pts)}`).toBeLessThan(rate(m))
    await toOverview()
  })

  test('label every line shows one label per edge', async () => {
    await toOverview()
    const toggle = await toolbarControl(page, 'world-layer-allLineLabels')
    if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click()
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')
    // An open More menu is a panel the labels keep out from under, so it is shut before the labels are counted.
    await closeMore(page)
    await expect.poll(async () => (await visual()).lineLabels, { timeout: 5000 }).toBe(motionDoc.edges.length)
    const off = await toolbarControl(page, 'world-layer-allLineLabels')
    await off.click()
    await expect(off).toHaveAttribute('aria-pressed', 'false')
    await closeMore(page)
  })
})
