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
import { PNG } from 'pngjs'
import { execFileSync } from 'child_process'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { quitApp, ensureE2eBuild } from './helpers/launch'
import { edgeSummary } from '../src/shared/world/edgeText'

/**
 * Thresholds, from luminance Y = 0.2126 R + 0.7152 G + 0.0722 B (0 to 255) over the canvas with the
 * labels and panels hidden. The background is the canvas's most common Y; a pixel is "lit" when its
 * Y is LIT_MARGIN above it, and the mean is taken over the background's Y, so the lighter Blueprint
 * and Glass backgrounds never pass on their colour alone. A pixel is "white" when its darkest
 * channel is at least WHITE_MIN: saturated white, what a bloomed-out fog cloud or a knot of
 * lines turns into.
 *
 * Measured locally (SwiftShader, 1280x800 window), mean over background / lit / white:
 *
 *   | case                         | neon                     | blueprint                | glass                    |
 *   |------------------------------|--------------------------|--------------------------|--------------------------|
 *   | small, after fix round 1     | 11.6 / 8.23 % / 0.000 %  | 12.4 / 11.32 % / 0.000 % | 7.6 / 4.89 % / 0.004 %   |
 *   | big, after fix round 1       | 35.4 / 32.31 % / 0.000 % | 33.3 / 32.28 % / 0.000 % | 20.4 / 14.08 % / 0.002 % |
 *   | big, first pass (whited out) | 29.1 / 24.1 % / -        | 32.8 / 35.9 % / -        | 16.2 / 12.9 % / -        |
 *   | big, before Task 7 (fogged)  | 0.7 / 0.2 % / -          |                          |                          |
 *
 * The approved prototype's page measures 10.5 / 5.8 % (labels and panels included).
 * The floors sit under the dimmest fixed case and over the fogged one; the white cap sits over the
 * fixed cases and under the first pass's whiteout.
 */
const LIT_MARGIN = 32
const MIN_MEAN_OVER_BACKGROUND = 3.5
const MIN_LIT_FRACTION = 0.01
const WHITE_MIN = 235
const MAX_WHITE_FRACTION = 0.005
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

/** 168 files in 12 folders: each file imports two in its folder and the first file of the next folder. */
const BIG_AREAS = ['api', 'core', 'jobs', 'ui', 'data', 'auth', 'mail', 'billing', 'search', 'audit', 'files', 'admin']
function bigFiles(): Record<string, string> {
  const files: Record<string, string> = { 'package.json': JSON.stringify({ name: 'big', version: '1.0.0' }) }
  BIG_AREAS.forEach((area, a) => {
    const next = BIG_AREAS[(a + 1) % BIG_AREAS.length]
    for (let i = 0; i < 14; i++) {
      const imports = [1, 2].map((k) => (i - k >= 0 ? `import { f${i - k} } from './m${i - k}'\n` : '')).join('')
      const cross = i === 13 ? `import { f0 as n0 } from '../${next}/m0'\n` : ''
      const call = i === 13 ? ' + n0(x)' : ''
      files[`src/${area}/m${i}.ts`] = `${imports}${cross}export function f${i}(x: number): number {\n  return x + ${i}${call}\n}\n`
    }
  })
  return files
}

test.beforeAll(async () => {
  ensureE2eBuild()
  fs.mkdirSync(SHOTS, { recursive: true })
  fixtures.push({ label: 'small', dir: makeRepo('small', SMALL_FILES) }, { label: 'big', dir: makeRepo('big', bigFiles()) })

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

interface Drawn { changing: number }
interface Probe { screenPoint(id: string): { x: number; y: number } | null; linePoints(id: string): Array<{ x: number; y: number }>; pickAt(x: number, y: number): { kind: string; id: string } | null; drawn(): Drawn }

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
  const png = PNG.sync.read(buf)
  const n = png.width * png.height
  const ys = new Float32Array(n)
  const hist = new Array<number>(256).fill(0)
  let sum = 0
  let white = 0
  for (let p = 0; p < n; p++) {
    const i = p * 4
    if (Math.min(png.data[i], png.data[i + 1], png.data[i + 2]) >= WHITE_MIN) white++
    const y = 0.2126 * png.data[i] + 0.7152 * png.data[i + 1] + 0.0722 * png.data[i + 2]
    ys[p] = y
    sum += y
    hist[Math.round(y)]++
  }
  const bgY = hist.indexOf(Math.max(...hist))
  let lit = 0
  for (const y of ys) if (y > bgY + LIT_MARGIN) lit++
  return { mean: sum / n, lit: lit / n, white: white / n, bgY }
}

interface LabelState { text: string; inside: boolean; opacity: number; visibility: string; font: number }

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
      }
    })
  })

interface Line { id: string; from: string; to: string; label: string }
interface World { ids: string[]; connected: string[]; names: Record<string, string>; districts: number; edges: Line[] }

/** Building ids from the stored world of `root` (also those with a connection, the busiest first), their names, its district count and its lines. */
async function world(root: string): Promise<World> {
  return page.evaluate(async (r) => {
    interface Doc { buildings: { id: string; name: string }[]; districts: unknown[]; edges: { id: string; from: string; to: string; label: string }[] }
    const api = (window as unknown as { termpolis: { gitFindRoot: (c: string) => Promise<{ success: boolean; data?: string }>; worldGet: (c: string) => Promise<{ success: boolean; data?: Doc | null }> } }).termpolis
    const top = await api.gitFindRoot(r)
    const res = await api.worldGet(top.success && top.data ? top.data : r)
    if (!res.success || !res.data) return { ids: [], connected: [], names: {}, districts: 0, edges: [] }
    const lines = new Map<string, number>()
    for (const e of res.data.edges) for (const end of [e.from, e.to]) lines.set(end, (lines.get(end) ?? 0) + 1)
    const ids = res.data.buildings.map((b) => b.id)
    // The busiest building first: its hover labels gather over it, the case where they caught the click.
    const connected = ids.filter((id) => lines.has(id)).sort((a, b) => (lines.get(b) as number) - (lines.get(a) as number))
    const edges = res.data.edges.map((e) => ({ id: e.id, from: e.from, to: e.to, label: e.label }))
    return { ids, connected, names: Object.fromEntries(res.data.buildings.map((b) => [b.id, b.name])), districts: res.data.districts.length, edges }
  }, root)
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
  await page.locator('[data-testid="world-reset"]').click()
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
  return w.edges.find((e) => edgeSummary(e.label) === title && (e.from === at || e.to === at) && [e.from, e.to].every((x) => !w.names[x] || route.includes(w.names[x])))
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
  const w = await world(dir)
  const { ids, connected, names, districts } = w
  expect(ids.length).toBeGreaterThan(1)
  const wantLabels = Math.min(MIN_DISTRICT_LABELS, districts)

  for (const [t, theme] of themes.entries()) {
    await page.getByRole('combobox', { name: 'Theme' }).selectOption(theme)
    await toOverview()

    const m = await measure(`${tag}-${theme}-canvas.png`)
    console.log(`[world-visual] ${tag} ${theme}: mean ${m.mean.toFixed(1)} (background ${m.bgY.toFixed(1)}), lit ${(m.lit * 100).toFixed(2)}%, white ${(m.white * 100).toFixed(3)}%`)
    expect(m.mean - m.bgY, `${tag}/${theme}: the canvas is too dark (mean ${m.mean.toFixed(1)})`).toBeGreaterThan(MIN_MEAN_OVER_BACKGROUND)
    expect(m.lit, `${tag}/${theme}: too few pixels stand out from the background`).toBeGreaterThan(MIN_LIT_FRACTION)
    expect(m.white, `${tag}/${theme}: ${(m.white * 100).toFixed(2)}% of the canvas is saturated white`).toBeLessThan(MAX_WHITE_FRACTION)

    const labels = await districtLabels()
    const readable = labels.filter((l) => l.inside && l.opacity > 0.05 && l.visibility === 'visible' && l.font >= MIN_LABEL_FONT_PX)
    expect(readable.length, `${tag}/${theme}: readable district labels ${JSON.stringify(labels)}`).toBeGreaterThanOrEqual(wantLabels)
    expect(await underLegend(ids), `${tag}/${theme}: under the legend at overview`).toEqual([])
    expect(await overlappingLabels(), `${tag}/${theme}: labels overlap at overview`).toEqual([])
    // A still camera keeps the same labels: nothing flickers in or out.
    const still = await shownLabels()
    await page.waitForTimeout(400)
    expect(await shownLabels(), `${tag}/${theme}: the overview's labels change with the camera still`).toEqual(still)
    await page.screenshot({ path: path.join(SHOTS, `${tag}-${theme}-overview.png`) })

    // Hover: the building's connections light up with their labels (spec: hover shows how it
    // connects), a few at most, and no label over another.
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
    for (const end of [line!.from, line!.to]) {
      if (!names[end]) continue // an external: an orb, not a building
      expect(await probePoint(end), `${tag}/${theme}: ${names[end]}, an end of "${tagPt!.text}", is not in view`).not.toBeNull()
    }
    await page.screenshot({ path: path.join(SHOTS, `${tag}-${theme}-line-card.png`) })
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
      // drawn across a building's face rightly takes the click where it runs).
      await toOverview()
      const steady = await jitterAim(connected)
      for (const [dx, dy] of CLICK_JITTER) {
        await toOverview()
        await page.mouse.click(steady.x + dx, steady.y + dy)
        await expect(card(), `${tag}: no card for a click ${dx},${dy} px off ${names[steady.id]}`).toBeVisible()
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
      await page.getByRole('combobox', { name: 'Theme' }).selectOption('neon')

      // A resize fits the overview again: the city stays on the canvas and out of the legend's strip.
      await toOverview()
      await page.setViewportSize({ width: 1000, height: 700 })
      await page.waitForTimeout(1500)
      expect(await underLegend(ids), `${label}: under the legend after a resize`).toEqual([])
      expect(await overlappingLabels(), `${label}: labels overlap after a resize`).toEqual([])
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
})
