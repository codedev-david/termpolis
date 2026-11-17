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
 *   - hovering a building shows its connections' labels, a few at most, none overlapping another;
 *   - clicking that building (where its hover labels gather) opens THAT building's card, which is
 *     drawn over the map's labels: the card is what is under its own centre, and wherever a label's
 *     box overlaps a panel the panel is on top; the close-up does not white out either.
 * Each time the pane opens, on the first frame it exists: it starts below the title bar, its
 * background is opaque, and neither it nor any ancestor is faded (their opacities multiply to 1).
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
interface Probe { screenPoint(id: string): { x: number; y: number } | null; drawn(): Drawn }

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

/** Waits until the world is on the canvas and the rise and the camera's flight are over. */
async function settled(): Promise<void> {
  await expect(canvas()).toBeVisible({ timeout: 60_000 })
  await expect(page.locator('[data-testid="world-canvas-host"]')).toHaveCSS('visibility', 'visible', { timeout: 60_000 })
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

/** Building ids from the stored world of `root` (also those with a connection, the busiest first), their names, and its district count. */
async function world(root: string): Promise<{ ids: string[]; connected: string[]; names: Record<string, string>; districts: number }> {
  return page.evaluate(async (r) => {
    interface Doc { buildings: { id: string; name: string }[]; districts: unknown[]; edges: { from: string; to: string }[] }
    const api = (window as unknown as { termpolis: { gitFindRoot: (c: string) => Promise<{ success: boolean; data?: string }>; worldGet: (c: string) => Promise<{ success: boolean; data?: Doc | null }> } }).termpolis
    const top = await api.gitFindRoot(r)
    const res = await api.worldGet(top.success && top.data ? top.data : r)
    if (!res.success || !res.data) return { ids: [], connected: [], names: {}, districts: 0 }
    const lines = new Map<string, number>()
    for (const e of res.data.edges) for (const end of [e.from, e.to]) lines.set(end, (lines.get(end) ?? 0) + 1)
    const ids = res.data.buildings.map((b) => b.id)
    // The busiest building first: its hover labels gather over it, the case where they caught the click.
    const connected = ids.filter((id) => lines.has(id)).sort((a, b) => (lines.get(b) as number) - (lines.get(a) as number))
    return { ids, connected, names: Object.fromEntries(res.data.buildings.map((b) => [b.id, b.name])), districts: res.data.districts.length }
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

/** Connection labels on show (the hovered or selected part's lines). */
const shownLineLabels = (): Promise<number> =>
  page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.lw-edge')].filter((el) => getComputedStyle(el).display !== 'none').length)

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

test.describe.serial('Lumopolis can be seen', () => {
  for (const [index, label] of ['small', 'big'].entries()) {
    test(`${index + 1}. the ${label} project is visible and readable in every theme`, async () => {
      test.setTimeout(240_000)
      const fx = fixtures.find((f) => f.label === label)!
      if (await pane().count()) {
        await page.locator('[data-testid="world-close"]').click()
        await expect(pane()).toHaveCount(0)
      }
      await createTerminal(`Visual ${label}`, fx.dir)
      const first = await openPane()
      // The pane sits under the title bar (the window controls stay usable) and is opaque from its
      // first frame, so the terminal never shows through while the world loads.
      expect(first.top, `pane top ${first.top} is above the title bar's bottom ${first.titleBottom}`).toBeGreaterThanOrEqual(first.titleBottom - 0.5)
      expect(first.titleBottom).toBeGreaterThan(0)
      expect(first.background, `the pane's first frame (${first.testid}) is not opaque`).toMatch(/^rgb\(/)
      expect(first.opacity, `the pane's first frame (${first.testid}) is faded`).toBe(1)

      await settled()
      const { ids, connected, names, districts } = await world(fx.dir)
      expect(ids.length).toBeGreaterThan(1)
      const wantLabels = Math.min(MIN_DISTRICT_LABELS, districts)

      for (const theme of THEMES) {
        await page.getByRole('combobox', { name: 'Theme' }).selectOption(theme)
        await page.locator('[data-testid="world-reset"]').click()
        await page.waitForTimeout(2500)

        const m = await measure(`${label}-${theme}-canvas.png`)
        console.log(`[world-visual] ${label} ${theme}: mean ${m.mean.toFixed(1)} (background ${m.bgY.toFixed(1)}), lit ${(m.lit * 100).toFixed(2)}%, white ${(m.white * 100).toFixed(3)}%`)
        expect(m.mean - m.bgY, `${label}/${theme}: the canvas is too dark (mean ${m.mean.toFixed(1)})`).toBeGreaterThan(MIN_MEAN_OVER_BACKGROUND)
        expect(m.lit, `${label}/${theme}: too few pixels stand out from the background`).toBeGreaterThan(MIN_LIT_FRACTION)
        expect(m.white, `${label}/${theme}: ${(m.white * 100).toFixed(2)}% of the canvas is saturated white`).toBeLessThan(MAX_WHITE_FRACTION)

        const labels = await districtLabels()
        const readable = labels.filter((l) => l.inside && l.opacity > 0.05 && l.visibility === 'visible' && l.font >= MIN_LABEL_FONT_PX)
        expect(readable.length, `${label}/${theme}: readable district labels ${JSON.stringify(labels)}`).toBeGreaterThanOrEqual(wantLabels)
        expect(await underLegend(ids), `${label}/${theme}: under the legend at overview`).toEqual([])
        await page.screenshot({ path: path.join(SHOTS, `${label}-${theme}-overview.png`) })

        // Hover: the building's connections light up with their labels (spec: hover shows how it
        // connects), a few at most and none over another.
        expect(await shownLineLabels(), `${label}/${theme}: line labels show before any hover`).toBe(0)
        const over = await aimAtABuilding(connected)
        await page.mouse.move(over.x, over.y)
        await expect.poll(shownLineLabels, { message: `${label}/${theme}: hovering shows no line labels` }).toBeGreaterThan(0)
        await page.waitForTimeout(600)
        expect(await shownLineLabels(), `${label}/${theme}: too many line labels on hover`).toBeLessThanOrEqual(MAX_HOVER_LINE_LABELS)
        expect(await overlappingLineLabels(), `${label}/${theme}: hover line labels overlap`).toEqual([])
        await page.screenshot({ path: path.join(SHOTS, `${label}-${theme}-hover.png`) })

        // The click lands where the hover labels gather: it must open the building's own card.
        await page.mouse.click(over.x, over.y)
        await expect(card()).toBeVisible()
        await expect(card().locator('h3').first(), `${label}/${theme}: the click opened another card`).toHaveText(names[over.id])
        await page.waitForTimeout(1500)
        expect(await panelsOverLabels(), `${label}/${theme}: a label is drawn over a panel`).toEqual([])
        expect(await overlappingLineLabels(), `${label}/${theme}: the selection's line labels overlap`).toEqual([])
        await page.screenshot({ path: path.join(SHOTS, `${label}-${theme}-click.png`) })
        const close = await measure(`${label}-${theme}-click-canvas.png`)
        console.log(`[world-visual] ${label} ${theme} close-up: white ${(close.white * 100).toFixed(3)}%`)
        expect(close.white, `${label}/${theme}: ${(close.white * 100).toFixed(2)}% of the close-up is saturated white`).toBeLessThan(MAX_WHITE_FRACTION)
        await page.locator('[data-testid="world-card-close"]').click()
        await expect(card()).toHaveCount(0)
        // Off the canvas, so the next theme starts with nothing hovered.
        await page.mouse.move(2, 400)
      }
      await page.getByRole('combobox', { name: 'Theme' }).selectOption('neon')

      // A resize fits the overview again: the city stays on the canvas and out of the legend's strip.
      await page.locator('[data-testid="world-reset"]').click()
      await page.waitForTimeout(2500)
      await page.setViewportSize({ width: 1000, height: 700 })
      await page.waitForTimeout(1500)
      expect(await underLegend(ids), `${label}: under the legend after a resize`).toEqual([])
      await page.screenshot({ path: path.join(SHOTS, `${label}-neon-resized.png`) })
      await page.setViewportSize({ width: 1280, height: 800 })
      await page.waitForTimeout(1500)
      expect(await underLegend(ids), `${label}: under the legend after resizing back`).toEqual([])
    })
  }
})
