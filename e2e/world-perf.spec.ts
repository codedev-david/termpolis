/**
 * The 3D map's frame times in CI (look spec §6.2, plan Task 2). Two worlds at 1920x1080: this repository (Termpolis
 * itself) and the generated one of 168 files in 12 folders (world-visual's big world, bigFiles(14)). For each:
 *   - the first frame is fast: the time from the first draw() to the frame that shows it (drawn().perf.firstFrameMs),
 *     held to a ratio of a small warm-up world's first frame in the same launch (FIRST_FRAME_RATIO says why);
 *   - a warm-up orbit, then ORBITS counted scripted orbits of 10 s each, a mouse drag of 360° round the city, timed by the app's own frame-time
 *     sampler (window.__worldPerf, the counted frames between begin() and end()). The numbers (the orbit whose p95 is the
 *     median, and every orbit) are written to test-results/world-perf/<os>-<fixture>-<tier>.json and logged as a
 *     `world-perf {...}` line;
 *   - in software on Linux and Windows, the median orbit's p95 stays at or under this system's floor for that world
 *     (SOFTWARE_FLOOR_P95_MS).
 *
 * Metrics only: no screenshot here is a golden image.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import path from 'path'
import fs from 'fs'
import { quitApp, ensureE2eBuild } from './helpers/launch'
import { bigFiles, createTerminal, expectPaneOpens, launchWorldApp, makeRepo, paletteType, removeDirs } from './helpers/world'

/**
 * The CI guards below are regression guards for GPU-less hosted runners. They are not the spec's targets (look spec
 * §5.2 and §6: 60 fps, a p95 of at most 16.7 ms on integrated graphics at 1080p in High, Low at 60 fps on a weak GPU,
 * and a first frame of at most 400 ms on the reference iGPU and 3 s in software), which Task 20 measures on real
 * machines (`npm run perf:world`, written to docs/perf/lumopolis/). Each guard is made so that a slower runner moves
 * what it is compared with as well, not the bound: a bound taken as the slowest runner seen so far x 1.3 has to be
 * raised each time a slower one turns up.
 *
 * The software floor (§6.2): the most the median orbit's p95 may reach when the map is drawn in software, per system and
 * per world. Each is the worst counted orbit's p95 seen on that system's runner x 1.3, rounded up to 10 ms; SwiftShader
 * at the High tier, as software has no Flat tier yet (Task 3 starts it at Flat, under these). Every world's first orbit
 * is a warm-up and is not counted: it is the one that draws parts for the first time (their shaders compiled, their
 * labels laid out) and was the slowest of three in 7 of 8 Termpolis copies on Linux and in every one on macOS.
 * Asserted on Linux and Windows, where a person can draw in software (a virtual machine with no GPU, Windows' basic
 * render driver) and the runners draw on SwiftShader's Subzero backend. Not asserted on macOS: a Mac draws Lumopolis in
 * software only in a VM or with its GPU blocklisted, and the macOS runner's LLVM backend swings 2-5x from one runner to
 * the next on one commit (the big world's median orbit 100-504 ms), so a bound there would track runners, not the app.
 * The macOS numbers are still written to the JSON and the upload.
 */
const SOFTWARE_FLOOR_P95_MS: Record<string, Record<string, number>> = {
  linux: { termpolis: 810, big: 440 },
  windows: { termpolis: 510, big: 300 },
}
/**
 * The first frame (§5.2), in software: the spec opens a small world first (the warm-up, WARM_UP_FILES files in each of
 * the 12 folders) and holds each world's first frame to FIRST_FRAME_RATIO x the warm-up's own first frame in the same
 * launch. That cold first frame carries the runner's cost of drawing in software: the GPU process's first raster task
 * (1.1-1.5 s on a fresh macOS runner, the compositor holding the swaps meanwhile: FLAKES, soak 45591853353) and
 * SwiftShader compiling each shader, which its LLVM backend on macOS does again for every new view. On one commit
 * (c81e0a7f) macOS's Termpolis first frame was 539 ms on one runner and 5707 ms on another. Timing each world after
 * the warm-up open did not remove that spread (a287b581: 2.2-4.6 s on macOS; on Linux 1.1-2.4 s, where the same worlds
 * took 0.4-1.6 s without it), so the time alone is not asserted. The ratio is: on one runner the warm-up's first frame
 * and the worlds' move together (macOS 3.6-4.0 s and 2.2-4.6 s, Linux 1.1-1.9 s and 1.1-2.4 s, Windows 0.25-0.65 s and
 * 0.25-0.39 s). The worst ratio seen is 1.53 (Windows, the big world, soak 45646568734) over 20 first frames on the
 * three systems (soaks 45646550636, 45646568734, 45646589568); x 1.3 is 1.99, and the bound is 2.5 because 20 is a
 * small sample and one world's ratio on one system spans 0.5-1.5. It grows when the app's first frame costs more for a
 * bigger world (building, uploading and drawing it); a cost that every first frame pays alike is Task 20's to find on
 * real hardware. Above it all, the first frame must come before
 * the product's own software watchdog drops the map to 2D (FIRST_FRAME_MS_SW in createWorldViewer.ts). On a GPU the
 * bound is FIRST_FRAME_HARDWARE_MS, wider than the 400 ms target that Task 20 times.
 */
const WARM_UP_FILES = 2
const FIRST_FRAME_RATIO = 2.5
const FIRST_FRAME_WATCHDOG_MS = 15_000
const FIRST_FRAME_HARDWARE_MS = 1000
/**
 * How many counted orbits each world's gate takes the median of (after one warm-up orbit): one slow orbit on a shared
 * runner does not fail the gate.
 */
const ORBITS = 3
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
  coldFirstFrameMs: number | null
  warmUpOrbit: Stats
  orbits: Stats[]
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
let warmDir: string
let coldFirstFrameMs: number | null = null
const FIXTURES: Array<{ label: string; dir: () => string }> = [
  { label: 'termpolis', dir: () => path.resolve('.') },
  { label: 'big', dir: () => bigDir },
]
const orbits = new Map<string, OrbitResult>()

test.beforeAll(async () => {
  test.setTimeout(420_000)
  ensureE2eBuild()
  fs.mkdirSync(OUT, { recursive: true })
  bigDir = makeRepo('perf-big', bigFiles(14))
  warmDir = makeRepo('perf-warm', bigFiles(WARM_UP_FILES))
  ;({ app, page, userDataDir } = await launchWorldApp())
  await page.setViewportSize(VIEWPORT)
  // Motion on, whatever this machine's setting: the looping motions keep the loop drawing between pointer moves.
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  // The warm-up: the runner's cold cost of drawing in software is paid here, on a small world of the same kinds.
  await openOn('warm-up', warmDir)
  coldFirstFrameMs = (await drawn()).perf.firstFrameMs
  console.log(`world-perf cold first frame (warm-up world): ${coldFirstFrameMs} ms`)
})

test.afterAll(async () => {
  await quitApp(app)
  removeDirs([userDataDir, bigDir, warmDir])
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
      const ms = d.perf.firstFrameMs
      const ratio = ms !== null && coldFirstFrameMs ? ms / coldFirstFrameMs : null
      console.log(
        `world-perf first frame ${fx.label}: ${ms} ms, ${ratio?.toFixed(2)} x the warm-up's ${coldFirstFrameMs} ms ` +
          `(${d.software ? `software, limits ${FIRST_FRAME_RATIO} x and ${FIRST_FRAME_WATCHDOG_MS} ms` : `hardware, limit ${FIRST_FRAME_HARDWARE_MS} ms`})`,
      )
      expect(ms, 'no frame was ever drawn').not.toBeNull()
      if (!d.software) {
        expect(ms as number, `${fx.label}: the first frame took too long`).toBeLessThanOrEqual(FIRST_FRAME_HARDWARE_MS)
        return
      }
      expect(ms as number, `${fx.label}: the first frame came after the software watchdog's wait`).toBeLessThan(FIRST_FRAME_WATCHDOG_MS)
      expect(coldFirstFrameMs, 'the warm-up world drew no frame').not.toBeNull()
      expect(ratio as number, `${fx.label}: the first frame took ${ratio?.toFixed(2)} x the warm-up world's`).toBeLessThanOrEqual(FIRST_FRAME_RATIO)
    })

    test(`${ORBITS} scripted orbits of 10 s after a warm-up orbit report frame times (${fx.label})`, async () => {
      test.setTimeout(60_000 + (ORBITS + 1) * 40_000)
      await expect(pane()).toBeVisible()
      // The warm-up orbit: the parts it shows for the first time are drawn here, not in a counted orbit.
      await page.evaluate(() => (window as unknown as { __worldPerf: PerfProbe }).__worldPerf.begin())
      await orbit()
      const warmUp = await page.evaluate(() => (window as unknown as { __worldPerf: PerfProbe }).__worldPerf.end())
      console.log(`world-perf warm-up orbit ${fx.label} (not counted): ${JSON.stringify(warmUp)}`)
      await page.waitForTimeout(500)
      const runs: Stats[] = []
      for (let i = 0; i < ORBITS; i++) {
        await page.evaluate(() => (window as unknown as { __worldPerf: PerfProbe }).__worldPerf.begin())
        await orbit()
        runs.push(await page.evaluate(() => (window as unknown as { __worldPerf: PerfProbe }).__worldPerf.end()))
        console.log(`world-perf orbit ${i + 1} ${fx.label}: ${JSON.stringify(runs[i])}`)
        await page.waitForTimeout(500)
      }
      // The orbit whose p95 is the median: its own numbers, so p50/p95/p99 come from one orbit.
      const stats = [...runs].sort((a, b) => a.p95 - b.p95)[Math.floor(runs.length / 2)]
      const d = await drawn()
      const result: OrbitResult = {
        os: OS_NAME,
        coldFirstFrameMs,
        warmUpOrbit: warmUp,
        orbits: runs,
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
      for (const r of runs) expect(r.frames, `${fx.label}: an orbit counted no frames`).toBeGreaterThan(0)
    })

    // The floor only, for now: that software starts at Flat is asserted here once Task 3 gives it a Flat tier.
    test(`in software the median orbit stays within the floor (${fx.label})`, async () => {
      const r = orbits.get(fx.label)
      expect(r, 'the orbit test did not run').toBeDefined()
      test.skip(!r!.software, 'drawn on a GPU: the floor is for software')
      test.skip(!(OS_NAME in SOFTWARE_FLOOR_P95_MS), 'reported only on macOS: SOFTWARE_FLOOR_P95_MS says why')
      const floor = SOFTWARE_FLOOR_P95_MS[OS_NAME][fx.label]
      expect(r!.p95, `${fx.label}: the median orbit p95 ${r!.p95} ms is over the ${OS_NAME} software floor ${floor} ms`).toBeLessThanOrEqual(floor)
    })
  }

  // The governor's drop in software (Task 3 turns it on).
  test.fixme('forced High in software drops through Low to Flat within 8 s and never rises', async () => {})
})
