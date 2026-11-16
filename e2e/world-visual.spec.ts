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
 *   - at least MIN_DISTRICT_LABELS district labels are on the canvas, visible and readable;
 *   - clicking a building opens its card.
 * Each time the pane opens, on the first frame it exists: it starts below the title bar and its
 * background is opaque.
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
 * and Glass backgrounds never pass on their colour alone.
 *
 * Measured locally (SwiftShader, 1280x800 window), mean over background / lit fraction:
 *   fixed:  small  neon 7.7 / 4.5 %   blueprint 11.6 / 12.1 %   glass 5.2 / 2.1 %
 *           big    neon 29.1 / 24.1 %  blueprint 32.8 / 35.9 %   glass 16.2 / 12.9 %
 *   before the fix (the old fog and label fade): big neon 0.7 / 0.2 % (the city fogged to black),
 *           small neon 2.5 / 1.6 %.
 *   The approved prototype's page measures 10.5 / 5.8 % (labels and panels included).
 * The floors sit under the dimmest fixed case (the small project in Glass) and over the broken ones.
 */
const LIT_MARGIN = 32
const MIN_MEAN_OVER_BACKGROUND = 3.5
const MIN_LIT_FRACTION = 0.01
/** District labels that must be readable at overview (fewer if the world has fewer districts). */
const MIN_DISTRICT_LABELS = 4
/** The smallest label font a person can read on the map. */
const MIN_LABEL_FONT_PX = 11

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

interface FirstFrame { top: number; titleBottom: number; background: string; testid: string }

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
      w.__firstPane = {
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
async function measure(file: string): Promise<{ mean: number; lit: number; bgY: number }> {
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
  for (let p = 0; p < n; p++) {
    const i = p * 4
    const y = 0.2126 * png.data[i] + 0.7152 * png.data[i + 1] + 0.0722 * png.data[i + 2]
    ys[p] = y
    sum += y
    hist[Math.round(y)]++
  }
  const bgY = hist.indexOf(Math.max(...hist))
  let lit = 0
  for (const y of ys) if (y > bgY + LIT_MARGIN) lit++
  return { mean: sum / n, lit: lit / n, bgY }
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

/** Building ids from the stored world of `root`, and its district count. */
async function world(root: string): Promise<{ ids: string[]; districts: number }> {
  return page.evaluate(async (r) => {
    interface Doc { buildings: { id: string }[]; districts: unknown[] }
    const api = (window as unknown as { termpolis: { gitFindRoot: (c: string) => Promise<{ success: boolean; data?: string }>; worldGet: (c: string) => Promise<{ success: boolean; data?: Doc | null }> } }).termpolis
    const top = await api.gitFindRoot(r)
    const res = await api.worldGet(top.success && top.data ? top.data : r)
    return res.success && res.data ? { ids: res.data.buildings.map((b) => b.id), districts: res.data.districts.length } : { ids: [], districts: 0 }
  }, root)
}

/** Clicks the first building whose point on screen has the bare canvas under it. */
async function clickABuilding(ids: string[]): Promise<void> {
  for (const id of ids) {
    const pt = await page.evaluate((b) => {
      const p = (window as unknown as { __termpolis_world?: Probe }).__termpolis_world?.screenPoint(b) ?? null
      const host = document.querySelector('[data-testid="world-canvas-host"] canvas')
      return p && document.elementFromPoint(p.x, p.y) === host ? p : null
    }, id)
    if (pt) {
      await page.mouse.click(pt.x, pt.y)
      return
    }
  }
  throw new Error(`no building of ${ids.length} has the bare canvas under it`)
}

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

      await settled()
      const { ids, districts } = await world(fx.dir)
      expect(ids.length).toBeGreaterThan(1)
      const wantLabels = Math.min(MIN_DISTRICT_LABELS, districts)

      for (const theme of THEMES) {
        await page.getByRole('combobox', { name: 'Theme' }).selectOption(theme)
        await page.locator('[data-testid="world-reset"]').click()
        await page.waitForTimeout(2500)

        const m = await measure(`${label}-${theme}-canvas.png`)
        console.log(`[world-visual] ${label} ${theme}: mean ${m.mean.toFixed(1)} (background ${m.bgY.toFixed(1)}), lit ${(m.lit * 100).toFixed(2)}%`)
        expect(m.mean - m.bgY, `${label}/${theme}: the canvas is too dark (mean ${m.mean.toFixed(1)})`).toBeGreaterThan(MIN_MEAN_OVER_BACKGROUND)
        expect(m.lit, `${label}/${theme}: too few pixels stand out from the background`).toBeGreaterThan(MIN_LIT_FRACTION)

        const labels = await districtLabels()
        const readable = labels.filter((l) => l.inside && l.opacity > 0.05 && l.visibility === 'visible' && l.font >= MIN_LABEL_FONT_PX)
        expect(readable.length, `${label}/${theme}: readable district labels ${JSON.stringify(labels)}`).toBeGreaterThanOrEqual(wantLabels)
        await page.screenshot({ path: path.join(SHOTS, `${label}-${theme}-overview.png`) })

        await clickABuilding(ids)
        await expect(card()).toBeVisible()
        await page.waitForTimeout(1500)
        await page.screenshot({ path: path.join(SHOTS, `${label}-${theme}-click.png`) })
        await page.locator('[data-testid="world-card-close"]').click()
        await expect(card()).toHaveCount(0)
      }
      await page.getByRole('combobox', { name: 'Theme' }).selectOption('neon')
    })
  }
})
