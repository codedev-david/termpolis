/**
 * The 3D map's frame times in CI (look spec §6.2, plan Task 2). Two worlds at 1920x1080: this repository (Termpolis
 * itself) and the generated one of 168 files in 12 folders (world-visual's big world, bigFiles(14)). For each:
 *   - the first frame is fast: the time from the first draw() to the frame that shows it (drawn().perf.firstFrameMs);
 *   - a 10 s scripted orbit, a mouse drag of 360° round the city, timed by the app's own frame-time sampler
 *     (window.__worldPerf, the counted frames between begin() and end()). The numbers are written to
 *     test-results/world-perf/<os>-<fixture>-<tier>.json and logged as a `world-perf {...}` line. Reported only: no
 *     assertion on the frame rate, which a hosted runner (no GPU, SwiftShader) cannot speak for;
 *   - in software, the orbit's p95 stays at or under that world's SOFTWARE_FLOOR_P95_MS, measured on ubuntu-24.04 (§6.2).
 *
 * Metrics only: no screenshot here is a golden image.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import path from 'path'
import fs from 'fs'
import { quitApp, ensureE2eBuild } from './helpers/launch'
import { bigFiles, createTerminal, expectPaneOpens, launchWorldApp, makeRepo, paletteType, removeDirs } from './helpers/world'

/**
 * The software floor (look spec §6.2): the most the orbit's p95 may reach when the map is drawn in software, one per
 * world. Each is 1.5 x the median p95 of that world's baseline orbits: 3 soak runs x 3 copies on ubuntu-24.04 at
 * 17cea296 (runs 45562373003, 45562384134, 45562403486), SwiftShader at the High tier, as software had no Flat tier
 * yet: Termpolis median 456.9 ms (383.2-533.2), big 262.1 ms (229.5-288.7). One floor for both (1.5 x 335.9 ms, the
 * median of all 18) would sit under the Termpolis orbit's own spread. Task 3 starts software at Flat, under these.
 * Asserted on Linux, where it was measured: macOS's runner draws on another SwiftShader backend (LLVM, not Subzero) and
 * its Termpolis orbit's p95 ran 227-859 ms over three copies, so there it is reported only.
 */
const SOFTWARE_FLOOR_P95_MS: Record<string, number> = { termpolis: 685, big: 393 }
/** The first frame's bound: in software, and on a GPU (wider than the spec's 400 ms, which Task 20 proves on real GPUs). */
const FIRST_FRAME_SOFTWARE_MS = 3000
const FIRST_FRAME_HARDWARE_MS = 1000
/** How long the scripted orbit takes, and how often the pointer moves during it. */
const ORBIT_MS = 10_000
const MOVE_EVERY_MS = 16
const VIEWPORT = { width: 1920, height: 1080 }
const OUT = path.resolve('test-results/world-perf')
const OS_NAME = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux'

interface Stats { frames: number; p50: number; p95: number; p99: number; worst: number }
interface Perf extends Stats { tier: 'high' | 'low' | 'flat'; auto: boolean; drops: number; firstFrameMs: number | null; resizeWorstMs: number }
interface Drawn { changing: number; drawCalls: number; triangles: number; software: boolean; perf: Perf }
interface Probe { drawn(): Drawn }
interface PerfProbe { begin(): void; end(): Stats }
interface OrbitResult extends Stats {
  os: string
  fixture: string
  tier: string
  auto: boolean
  software: boolean
  renderer: string
  drawCalls: number
  triangles: number
  drops: number
  firstFrameMs: number | null
  viewport: { width: number; height: number }
}

let app: ElectronApplication
let page: Page
let userDataDir: string
let bigDir: string
const FIXTURES: Array<{ label: string; dir: () => string }> = [
  { label: 'termpolis', dir: () => path.resolve('.') },
  { label: 'big', dir: () => bigDir },
]
const orbits = new Map<string, OrbitResult>()

test.beforeAll(async () => {
  ensureE2eBuild()
  fs.mkdirSync(OUT, { recursive: true })
  bigDir = makeRepo('perf-big', bigFiles(14))
  ;({ app, page, userDataDir } = await launchWorldApp())
  await page.setViewportSize(VIEWPORT)
  // Motion on, whatever this machine's setting: the looping motions keep the loop drawing between pointer moves.
  await page.emulateMedia({ reducedMotion: 'no-preference' })
})

test.afterAll(async () => {
  await quitApp(app)
  removeDirs([userDataDir, bigDir])
})

const pane = () => page.locator('[data-testid="world-view"]')
const canvas = () => page.locator('[data-testid="world-canvas-host"] canvas')
const drawn = (): Promise<Drawn> => page.evaluate(() => (window as unknown as { __termpolis_world: Probe }).__termpolis_world.drawn())

/** Whether the stored world of `root` is still the first map drawn from the file listing (or there is none yet). */
const provisional = (root: string): Promise<boolean> =>
  page.evaluate(async (r) => {
    const api = (window as unknown as { termpolis: { gitFindRoot: (c: string) => Promise<{ success: boolean; data?: string }>; worldGet: (c: string) => Promise<{ success: boolean; data?: { provisional?: boolean } | null }> } }).termpolis
    const top = await api.gitFindRoot(r)
    const res = await api.worldGet(top.success && top.data ? top.data : r)
    return !res.success || !res.data || res.data.provisional === true
  }, root)

/** Waits until the world is on the canvas and the rise and the camera's flight are over. */
async function settled(): Promise<void> {
  // A first open of a real repository maps the whole project first.
  await expect(canvas()).toBeVisible({ timeout: 240_000 })
  await expect(page.locator('[data-testid="world-canvas-host"]')).toHaveCSS('visibility', 'visible', { timeout: 240_000 })
  await expect.poll(async () => (await drawn()).changing, { timeout: 60_000 }).toBe(0)
  await page.waitForTimeout(2500)
}

/**
 * Opens the pane on `dir` (a terminal there, then Open Lumopolis) and waits until the rise and the flight are over. A
 * repository past the host's first-map size (Termpolis itself) is drawn first from its file listing and settles again
 * once the complete world is done: the orbit waits for that one.
 */
async function openOn(label: string, dir: string): Promise<void> {
  if (await pane().count()) {
    await page.locator('[data-testid="world-close"]').click()
    await expect(pane()).toHaveCount(0)
  }
  await createTerminal(page, `Perf ${label}`, dir)
  await paletteType(page, 'Open Lumopolis')
  await page.getByRole('button', { name: /^Open Lumopolis\s*See your project as a 3D world/ }).click()
  await expectPaneOpens(page)
  await settled()
  if (await provisional(dir)) {
    await expect.poll(() => provisional(dir), { timeout: 240_000 }).toBe(false)
    await settled()
  }
}

/** The GL renderer's name, as WEBGL_debug_renderer_info gives it to a page in this window (the map's GPU process). */
const rendererName = (): Promise<string> =>
  page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl')
    if (!gl) return 'no webgl'
    const info = gl.getExtension('WEBGL_debug_renderer_info') as { UNMASKED_RENDERER_WEBGL: number } | null
    return String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER))
  })

/** A point on the bare canvas (no label or panel over it) in the left half of the canvas, at its middle height. */
const dragStart = (): Promise<{ x: number; y: number; width: number; height: number }> =>
  page.evaluate(() => {
    const el = document.querySelector('[data-testid="world-canvas-host"] canvas') as HTMLCanvasElement
    const r = el.getBoundingClientRect()
    for (let dy = 0; dy < r.height / 3; dy += 8) {
      for (const y of [r.top + r.height / 2 + dy, r.top + r.height / 2 - dy]) {
        for (let x = r.left + 40; x < r.left + r.width / 3; x += 8) {
          if (document.elementFromPoint(x, y) === el) return { x, y, width: r.width, height: r.height }
        }
      }
    }
    throw new Error('no bare spot on the canvas to start the orbit from')
  })

/**
 * Drags the camera 360° round the city over ORBIT_MS. OrbitControls (three r160) turns 2π for a drag of the canvas's
 * height, so the drag covers that many pixels across, in strokes of at most half the canvas's width.
 */
async function orbit(): Promise<void> {
  const start = await dragStart()
  const stroke = Math.max(50, Math.min(start.width / 2, start.height))
  const strokes = Math.ceil(start.height / stroke)
  const each = start.height / strokes
  const strokeMs = ORBIT_MS / strokes
  for (let s = 0; s < strokes; s++) {
    await page.mouse.move(start.x, start.y)
    await page.mouse.down()
    const t0 = Date.now()
    for (let t = 0; t < strokeMs; t = Date.now() - t0) {
      await page.mouse.move(start.x + (each * t) / strokeMs, start.y)
      await page.waitForTimeout(MOVE_EVERY_MS)
    }
    await page.mouse.move(start.x + each, start.y)
    await page.mouse.up()
  }
  // The pointer off the canvas, so no hover is left behind.
  await page.mouse.move(2, 400)
}

test.describe.serial('Lumopolis frame times (look spec 6.2)', () => {
  for (const fx of FIXTURES) {
    test(`the first frame is fast (${fx.label})`, async () => {
      test.setTimeout(420_000)
      await openOn(fx.label, fx.dir())
      const d = await drawn()
      const limit = d.software ? FIRST_FRAME_SOFTWARE_MS : FIRST_FRAME_HARDWARE_MS
      console.log(`world-perf first frame ${fx.label}: ${d.perf.firstFrameMs} ms (${d.software ? 'software' : 'hardware'}, limit ${limit} ms)`)
      expect(d.perf.firstFrameMs, 'no frame was ever drawn').not.toBeNull()
      expect(d.perf.firstFrameMs as number, `${fx.label}: the first frame took too long`).toBeLessThanOrEqual(limit)
    })

    test(`a 10 s scripted orbit reports frame times (${fx.label})`, async () => {
      test.setTimeout(120_000)
      await expect(pane()).toBeVisible()
      await page.evaluate(() => (window as unknown as { __worldPerf: PerfProbe }).__worldPerf.begin())
      await orbit()
      const stats = await page.evaluate(() => (window as unknown as { __worldPerf: PerfProbe }).__worldPerf.end())
      const d = await drawn()
      const result: OrbitResult = {
        os: OS_NAME,
        fixture: fx.label,
        tier: d.perf.tier,
        auto: d.perf.auto,
        software: d.software,
        renderer: await rendererName(),
        ...stats,
        drawCalls: d.drawCalls,
        triangles: d.triangles,
        drops: d.perf.drops,
        firstFrameMs: d.perf.firstFrameMs,
        viewport: VIEWPORT,
      }
      orbits.set(fx.label, result)
      fs.writeFileSync(path.join(OUT, `${OS_NAME}-${fx.label}-${d.perf.tier}.json`), `${JSON.stringify(result, null, 2)}\n`)
      console.log(`world-perf ${JSON.stringify(result)}`)
      expect(stats.frames, `${fx.label}: the orbit counted no frames`).toBeGreaterThan(0)
    })

    // The floor only, for now: that software starts at Flat is asserted here once Task 3 gives it a Flat tier.
    test(`in software the orbit stays within the floor (${fx.label})`, async () => {
      const r = orbits.get(fx.label)
      expect(r, 'the orbit test did not run').toBeDefined()
      test.skip(!r!.software, 'drawn on a GPU: the floor is for software')
      test.skip(OS_NAME !== 'linux', 'the floor was measured on ubuntu-24.04: reported only on this system')
      const floor = SOFTWARE_FLOOR_P95_MS[fx.label]
      expect(r!.p95, `${fx.label}: the orbit p95 ${r!.p95} ms is over the software floor ${floor} ms`).toBeLessThanOrEqual(floor)
    })
  }

  // The governor's drop in software (Task 3 turns it on).
  test.fixme('forced High in software drops through Low to Flat within 8 s and never rises', async () => {})
})
