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
 *     (SOFTWARE_FLOOR_P95_MS) and, against the runner's own speed, under ORBIT_PER_GL;
 *   - in software on Linux and Windows, once both worlds are drawn: each world's first frame stays under this system's
 *     time (FIRST_FRAME_SW_MS), and the first frames against the runner's own speed under FIRST_FRAME_PER_GL;
 *   - the quality governor (look spec §5.1, plan Task 3): in software an Auto map starts at Flat, and one forced to
 *     start at High steps down through Low to Flat within its system's GOVERNOR_FLAT_MS of its first frame and never
 *     rises; its orbit at Flat is written to <os>-big-flat.json and, on Linux and Windows, held to the big world's floor.
 *
 * Every measure above but the governor's is taken with the Quality held at High (the profile's world settings), the
 * tier its bounds were set at: Auto would draw them at Flat in software, where they would no longer catch what they
 * were set to, and the tier must not change while a measure is taken.
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
 * at the High tier, where these runs hold the Quality (an Auto map starts at Flat in software, under these). Every world's first orbit
 * is a warm-up and is not counted: it is the one that draws parts for the first time (their shaders compiled, their
 * labels laid out) and was the slowest of three in 7 of 8 Termpolis copies on Linux and in every one on macOS.
 * Asserted on Linux and Windows, where a person can draw in software (a virtual machine with no GPU, Windows' basic
 * render driver) and the runners draw on SwiftShader's Subzero backend. Not asserted on macOS: a Mac draws Lumopolis in
 * software only in a VM or with its GPU blocklisted, and the macOS runner's LLVM backend swings 2-5x from one runner to
 * the next on one commit (the big world's median orbit 100-504 ms), so a bound there would track runners, not the app.
 * The macOS numbers are still written to the JSON and the upload.
 * Linux's floors were raised from 810 / 440 ms when a slower Linux runner turned up (look-a2 soaks 45763264132 and
 * 45765629026: runnerSpeed()'s glMs 103-111 ms, where every runner before ran 62-79): there the median orbits ran
 * 705-846 / 420-462 ms at the same draw calls and triangles, 6.3-8.0 / 3.8-4.5 x glMs against 5.2-6.4 / 3.5-4.2 on the
 * others (ORBIT_PER_GL; Windows, on runners of either speed, ran as before), so x 1.3: 1100 / 610 ms. Windows' worst is
 * still 344.4 / 209.7 ms.
 */
const SOFTWARE_FLOOR_P95_MS: Record<string, Record<string, number>> = {
  linux: { termpolis: 1100, big: 610 },
  windows: { termpolis: 510, big: 300 },
}
/**
 * The median orbit against the runner's own speed (§6.2): the median orbit's p95 / the glMs runnerSpeed() timed
 * before the warm-up in the same launch (FIRST_FRAME_PER_GL's unit). A floor in ms has to sit over the slowest runner
 * seen, so it cannot see an app that got 2x slower on a fast one (Linux's Termpolis orbit: 394 ms on one runner, 846
 * on another, in one soak); a slower runner moves glMs as well. Per system and per world, the worst seen x 1.3,
 * rounded up to 0.1, from the soaks 45740645423, 45747049554, 45763264132, 45765629026 and 45770181769 (Linux, 17
 * Termpolis and 15 big launches) and 45747055496, 45763270474, 45765632881 and 45770194385 (Windows, 10 each):
 *   - Linux: Termpolis 4.63-8.01 (worst 845.5 / 105.6, 45765629026), so 10.5; big 2.69-4.48 (462.2 / 103.2,
 *     45763264132), so 5.9;
 *   - Windows: Termpolis 2.63-3.31 (344.4 / 104.1, 45763270474), so 4.4; big 1.47-1.94 (204.9 / 105.4, 45747055496),
 *     so 2.6.
 * Twice the work on every frame doubles the measure: over the bound on every Windows launch seen, and on Linux, where
 * the orbit swings 1.7x against glMs from one runner to the next, on 14 of 17 Termpolis and 14 of 15 big launches.
 * A staged 2x (every frame drawn twice) failed it on every copy of each system, in both worlds (look-a2 report).
 * macOS is reported only, as SOFTWARE_FLOOR_P95_MS says (0.54-2.23 in soaks 45763276618 and 45765636039).
 */
const ORBIT_PER_GL: Record<string, Record<string, number>> = {
  linux: { termpolis: 10.5, big: 5.9 },
  windows: { termpolis: 4.4, big: 2.6 },
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
 * 0.25-0.39 s). The worst ratio seen is 2.04 (Linux, the Termpolis world, soak 45731354296, where that copy's warm-up
 * drew in 779 ms against 1.0-1.3 s on the other Linux copies) over 52 first frames on the three systems (the a287b581
 * soaks 45646550636, 45646568734 and 45646589568, and the 2-copy soaks 45651837832, 45652182123, 45716423172,
 * 45728023782, 45728044383, 45728064997, 45731354296 and 45731375685); x 1.3 is 2.65, and the bound is 2.7. Linux's
 * Termpolis ratio alone spans 0.97-2.04. It grows when the app's first frame costs more for a
 * bigger world (building, uploading and drawing it); a cost that every first frame pays alike is Task 20's to find on
 * real hardware. Above it all, the first frame must come before
 * the product's own software watchdog drops the map to 2D (FIRST_FRAME_MS_SW in createWorldViewer.ts). On a GPU the
 * bound is FIRST_FRAME_HARDWARE_MS, wider than the 400 ms target that Task 20 times.
 */
const WARM_UP_FILES = 2
const FIRST_FRAME_RATIO = 2.7
/**
 * Each world's first frame in software, in time (§6.2). The spec's target is 3 s in software, on real machines with the
 * GPU off (Task 20's software run); this is the CI guard, per system, the worst world's first frame seen on that
 * system's runner x 1.3, rounded up to 10 ms, and no more than the 3 s target where that is less:
 *   - Windows: worst 1010 ms (the Termpolis world, soak 45740654778), x 1.3 = 1313: 1320 ms;
 *   - Linux: worst 2411 ms (the Termpolis world, soak 45646550636), x 1.3 = 3134: 3140 ms. That is over the 3 s
 *     target, a CI-runner deviation (spec §6.2): the Linux runner's SwiftShader is slower than the software the target
 *     is for, and 3 s would fail runs the app did nothing to slow;
 *   - macOS: reported only (1.1-5.0 s on its LLVM backend, worst 4994 ms in soak 45733807004).
 * The time alone cannot see an app that got 2x slower on every world: Linux's worlds ran 1.0-2.4 s, more than 2x apart
 * from one runner to the next. FIRST_FRAME_PER_GL can.
 */
const FIRST_FRAME_SW_MS: Record<string, number> = { linux: 3140, windows: 1320 }
/**
 * The first frames against the runner's own speed (§6.2): a cost every first frame pays alike (a uniform regression)
 * moves the warm-up and the worlds together, so FIRST_FRAME_RATIO cannot see it. Before the warm-up, runnerSpeed()
 * times the runner on a fixed job that runs no app code; its `glMs` (compiling, linking and drawing shader programs in
 * software, the bulk of a first frame there) is the unit. Two measures, per system, each the worst seen x 1.3, rounded
 * up to 0.1:
 *   - `warm`: the warm-up world's first frame / glMs;
 *   - `median`: the median of the three first frames (the warm-up and both worlds) / glMs.
 * From 16 launches per system on one commit (5c97a9c1): Linux soaks 45740645423 and 45743471773, warm 13.1-22.1 and
 * median 15.2-20.2, so 28.8 and 26.3; Windows soaks 45740654778 and 45743478746, warm 8.9-11.8 and median 5.0-9.6, so
 * 15.4 and 12.6. A 2x first frame on every world doubles both. On Linux the median catches it (2 x 15.2 = 30.4, over
 * 26.3); on Windows the warm-up does (2 x 8.9 = 17.8, over 15.4), where one launch's Termpolis world at 1010 ms spreads
 * the median 1.9x. The median against the runner's whole time (glMs + jsMs, jsMs a fixed allocate, sort and hash job)
 * or against jsMs alone spread 1.9-2.0x on Windows as well, and the warm-up alone spreads 1.7x on Linux, so each
 * system needs both measures to catch a 2x on either.
 * The staged 2x (window.__worldFirstFrameSlowdown, under the worldProbe flag) fails on both: see the look-a1 report.
 * macOS is reported only: 3 launches (soak 45740663763), warm 8.4-12.4 and median 5.2-12.4.
 */
const FIRST_FRAME_PER_GL: Record<string, { warm: number; median: number }> = {
  linux: { warm: 28.8, median: 26.3 },
  windows: { warm: 15.4, median: 12.6 },
}
const FIRST_FRAME_WATCHDOG_MS = 15_000
/**
 * The governor (look spec §5.1, plan Task 3's acceptance): an Auto map forced to start at High, drawn in software at
 * 1080p and kept drawing by an orbit, reaches Flat through Low within this long of its first frame, per system.
 *
 * Each step takes two windows over the budget (DROP_WINDOWS) of WINDOW_MS (2 s) of counted time each, so the rules' own
 * least is 8 s, the plan's target: no run can meet it, since the wall clock runs past the counted time (software paces
 * its frames, and a gap a frame is held back for is not counted), and the poll sees a change up to 100 ms late. Each bound
 * is the worst seen on that system's runner x 1.3, rounded up to 100 ms, as the other bounds here: Linux 11177 ms and
 * Windows 10067 ms, in 3 and 4 runs (soaks 45763264132, 45763270474: Low at 4.8-5.3 s, Flat at 9.5-11.2 s). A deviation,
 * recorded in the look spec §6.2. macOS is logged, not asserted, as its other bounds are (Flat at 10.6-12.0 s, soak
 * 45763276618).
 */
const GOVERNOR_FLAT_MS: Record<string, number> = { linux: 14_600, windows: 13_100 }
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
/** The runner's speed timed before the warm-up, the unit of FIRST_FRAME_PER_GL. */
let warmUpSpeed: { jsMs: number; glMs: number } | null = null
/** Each world's first frame (ms) and whether it was drawn in software. */
const firstFrames = new Map<string, { ms: number; software: boolean }>()
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
  // Held at High: the bounds below were set there (see the top of this file). The governor's test picks Auto.
  ;({ app, page, userDataDir } = await launchWorldApp({ worldSettings: { quality: 'high' } }))
  await page.setViewportSize(VIEWPORT)
  // Motion on, whatever this machine's setting: the looping motions keep the loop drawing between pointer moves.
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  // The warm-up: the runner's cold cost of drawing in software is paid here, on a small world of the same kinds.
  warmUpSpeed = await runnerSpeed()
  console.log(`world-perf runner speed before warm-up: ${JSON.stringify(warmUpSpeed)}`)
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

/**
 * The runner's own speed, timed in the map's renderer by fixed workloads that run no app code: `jsMs`, the median of 5
 * runs of a fixed allocate, sort and hash job (the kind of work a scene build does), and `glMs`, the median of 3 runs
 * that compile and link 6 shader programs never seen before (a literal salt in each) in a fresh WebGL context of this
 * window, draw each once and read a pixel back (SwiftShader's compile and raster, the bulk of a first frame in software).
 */
const runnerSpeed = (): Promise<{ jsMs: number; glMs: number }> =>
  page.evaluate(() => {
    const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
    const js = (): number => {
      const t0 = performance.now()
      const items: Array<{ x: number; y: number; k: string }> = []
      for (let i = 0; i < 150_000; i++) items.push({ x: Math.sin(i) * i, y: Math.sqrt(i), k: `n${i % 977}` })
      items.sort((a, b) => a.x - b.x)
      const sums = new Map<string, number>()
      for (const o of items) sums.set(o.k, (sums.get(o.k) ?? 0) + o.y)
      let acc = 0
      for (const v of sums.values()) acc += v
      if (!Number.isFinite(acc)) throw new Error('runner speed: the job went wrong')
      return performance.now() - t0
    }
    const gl = (): number => {
      const c = document.createElement('canvas')
      c.width = 256
      c.height = 256
      const g = c.getContext('webgl')
      if (!g) return NaN
      const t0 = performance.now()
      const quad = g.createBuffer()
      g.bindBuffer(g.ARRAY_BUFFER, quad)
      g.bufferData(g.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), g.STATIC_DRAW)
      for (let n = 0; n < 6; n++) {
        const salt = `${Math.random().toFixed(8)}`
        const shader = (type: number, src: string): WebGLShader => {
          const sh = g.createShader(type) as WebGLShader
          g.shaderSource(sh, src)
          g.compileShader(sh)
          return sh
        }
        const prog = g.createProgram() as WebGLProgram
        g.attachShader(prog, shader(g.VERTEX_SHADER, `attribute vec2 p; varying vec2 v; void main() { v = p * ${salt}; gl_Position = vec4(p, 0.0, 1.0); }`))
        g.attachShader(
          prog,
          shader(
            g.FRAGMENT_SHADER,
            `precision highp float; varying vec2 v; void main() { vec3 c = vec3(0.0); for (int i = 0; i < 48; i++) { float f = float(i) * ${salt}; c += vec3(sin(v.x * f + 1.3), cos(v.y * f), fract(sin(dot(v, vec2(12.9898, 78.233)) + f) * 43758.5453)) / 48.0; } gl_FragColor = vec4(normalize(c + 0.001), 1.0); }`,
          ),
        )
        g.linkProgram(prog)
        if (!g.getProgramParameter(prog, g.LINK_STATUS)) throw new Error(`runner speed: ${g.getProgramInfoLog(prog)}`)
        g.useProgram(prog)
        const loc = g.getAttribLocation(prog, 'p')
        g.enableVertexAttribArray(loc)
        g.vertexAttribPointer(loc, 2, g.FLOAT, false, 0, 0)
        g.drawArrays(g.TRIANGLES, 0, 3)
      }
      g.readPixels(0, 0, 1, 1, g.RGBA, g.UNSIGNED_BYTE, new Uint8Array(4))
      const ms = performance.now() - t0
      g.getExtension('WEBGL_lose_context')?.loseContext()
      return ms
    }
    return { jsMs: median([js(), js(), js(), js(), js()]), glMs: median([gl(), gl(), gl()]) }
  })

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
      const speed = await runnerSpeed()
      console.log(`world-perf runner speed before ${fx.label}: ${JSON.stringify(speed)}`)
      await openOn(fx.label, fx.dir())
      const d = await drawn()
      const ms = d.perf.firstFrameMs
      const ratio = ms !== null && coldFirstFrameMs ? ms / coldFirstFrameMs : null
      console.log(
        `world-perf first frame ${fx.label}: ${ms} ms, ${ratio?.toFixed(2)} x the warm-up's ${coldFirstFrameMs} ms ` +
          `(${d.software ? `software, limits ${FIRST_FRAME_RATIO} x and ${FIRST_FRAME_WATCHDOG_MS} ms` : `hardware, limit ${FIRST_FRAME_HARDWARE_MS} ms`})`,
      )
      expect(ms, 'no frame was ever drawn').not.toBeNull()
      firstFrames.set(fx.label, { ms: ms as number, software: d.software })
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
      // The tier must not change while a measure is taken: held at High, it never does.
      expect.soft(d.perf.tier, `${fx.label}: drawn at another tier than the Quality held`).toBe('high')
      expect.soft(d.perf.auto, `${fx.label}: the Quality is not held`).toBe(false)
      fs.writeFileSync(path.join(OUT, `${OS_NAME}-${fx.label}-${d.perf.tier}.json`), `${JSON.stringify(result, null, 2)}\n`)
      console.log(`world-perf ${JSON.stringify(result)}`)
      for (const r of runs) expect(r.frames, `${fx.label}: an orbit counted no frames`).toBeGreaterThan(0)
    })

    // At High, held (that an Auto map starts at Flat in software is the governor's test, below).
    test(`in software the median orbit stays within the floor (${fx.label})`, async () => {
      const r = orbits.get(fx.label)
      expect(r, 'the orbit test did not run').toBeDefined()
      test.skip(!r!.software, 'drawn on a GPU: the floor is for software')
      expect(warmUpSpeed?.glMs, 'the runner speed was not timed').toBeGreaterThan(0)
      const perGl = r!.p95 / (warmUpSpeed as { glMs: number }).glMs
      console.log(`world-perf ${fx.label} median orbit against the runner: ${perGl.toFixed(2)} x glMs ${(warmUpSpeed as { glMs: number }).glMs.toFixed(1)} ms`)
      test.skip(!(OS_NAME in SOFTWARE_FLOOR_P95_MS), 'reported only on macOS: SOFTWARE_FLOOR_P95_MS says why')
      const floor = SOFTWARE_FLOOR_P95_MS[OS_NAME][fx.label]
      const bound = ORBIT_PER_GL[OS_NAME][fx.label]
      expect.soft(r!.p95, `${fx.label}: the median orbit p95 ${r!.p95} ms is over the ${OS_NAME} software floor ${floor} ms`).toBeLessThanOrEqual(floor)
      expect.soft(perGl, `${fx.label}: the median orbit p95 is ${perGl.toFixed(2)} x the runner's glMs, over ${bound}`).toBeLessThanOrEqual(bound)
    })
  }

  // After both worlds: the time and the runner checks see every first frame at once, each failure reported.
  test("in software the first frames hold to this system's time and to the runner's speed", async () => {
    expect([...firstFrames.keys()], "a world's first-frame test did not record its frame").toEqual(FIXTURES.map((f) => f.label))
    test.skip(![...firstFrames.values()].every((f) => f.software), 'drawn on a GPU: FIRST_FRAME_HARDWARE_MS holds it')
    expect(coldFirstFrameMs, 'the warm-up world drew no frame').not.toBeNull()
    expect(warmUpSpeed?.glMs, 'the runner speed was not timed').toBeGreaterThan(0)
    const gl = (warmUpSpeed as { glMs: number }).glMs
    const all = [coldFirstFrameMs as number, ...[...firstFrames.values()].map((f) => f.ms)].sort((a, b) => a - b)
    const per = { warm: (coldFirstFrameMs as number) / gl, median: all[Math.floor(all.length / 2)] / gl }
    const time = FIRST_FRAME_SW_MS[OS_NAME]
    const bound = FIRST_FRAME_PER_GL[OS_NAME]
    console.log(
      `world-perf first frames against the runner: warm ${per.warm.toFixed(2)}, median ${per.median.toFixed(2)} x glMs ${gl.toFixed(1)} ms ` +
        `(${bound ? `limits ${bound.warm} and ${bound.median}, ${time} ms per world` : 'reported only'})`,
    )
    test.skip(!bound, 'reported only on macOS: FIRST_FRAME_SW_MS and FIRST_FRAME_PER_GL say why')
    for (const [label, f] of firstFrames) {
      expect.soft(f.ms, `${label}: the first frame ${f.ms} ms is over the ${OS_NAME} software time ${time} ms`).toBeLessThanOrEqual(time)
    }
    expect.soft(per.warm, `the warm-up's first frame is ${per.warm.toFixed(2)} x the runner's glMs, over ${bound.warm}`).toBeLessThanOrEqual(bound.warm)
    expect.soft(per.median, `the first frames' median is ${per.median.toFixed(2)} x the runner's glMs, over ${bound.median}`).toBeLessThanOrEqual(bound.median)
  })

  // The governor in software (look spec §5.1): Auto starts at Flat; forced to start at High it steps down by itself.
  test('forced High in software drops through Low to Flat in time and never rises', async () => {
    test.setTimeout(420_000)
    test.skip(![...firstFrames.values()].every((f) => f.software), 'drawn on a GPU: a fast machine keeps High, so nothing drops')
    // Auto from here on, as the Quality menu saves it.
    await page.evaluate(() => (window as unknown as { termpolis: { worldSettingsSet(p: { quality: string }): Promise<unknown> } }).termpolis.worldSettingsSet({ quality: 'auto' }))
    // Software starts at Flat.
    await openOn('warm-up, Auto', warmDir)
    const auto = (await drawn()).perf
    expect(auto.tier, 'an Auto map drawn in software did not start at Flat').toBe('flat')
    expect(auto.auto).toBe(true)

    // Forced to start at High (window.__worldStartTier, read when the viewer is made, under the worldProbe flag).
    await page.locator('[data-testid="world-close"]').click()
    await expect(pane()).toHaveCount(0)
    await page.evaluate(() => { (window as unknown as { __worldStartTier?: string }).__worldStartTier = 'high' })
    await createTerminal(page, 'Perf governor', bigDir)
    await paletteType(page, 'Open Lumopolis')
    await page.getByRole('button', { name: /^Open Lumopolis\s*See your project as a 3D world/ }).click()
    await expectPaneOpens(page)
    // The tier as each change is seen (every 100 ms), timed from the first frame shown.
    await expect
      .poll(() => page.evaluate(() => !!(window as unknown as { __termpolis_world?: unknown }).__termpolis_world), { timeout: 240_000 })
      .toBe(true)
    await page.evaluate(() => {
      type W = { __termpolis_world?: { drawn(): Drawn }; __tierLog?: { first: number | null; seen: Array<{ at: number; tier: string }> }; __tierPoll?: number }
      const w = window as unknown as W
      const log = { first: null as number | null, seen: [] as Array<{ at: number; tier: string }> }
      w.__tierLog = log
      const read = (): void => {
        const p = w.__termpolis_world?.drawn().perf
        if (!p) return
        const at = performance.now()
        if (log.first === null && p.firstFrameMs !== null) log.first = at
        if (!log.seen.length || log.seen[log.seen.length - 1].tier !== p.tier) log.seen.push({ at, tier: p.tier })
      }
      read()
      w.__tierPoll = window.setInterval(read, 100)
    })
    const tierLog = (): Promise<{ first: number | null; seen: Array<{ at: number; tier: string }> }> =>
      page.evaluate(() => (window as unknown as { __tierLog: { first: number | null; seen: Array<{ at: number; tier: string }> } }).__tierLog)
    await expect(canvas()).toBeVisible({ timeout: 240_000 })
    await expect(page.locator('[data-testid="world-canvas-host"]')).toHaveCSS('visibility', 'visible', { timeout: 240_000 })
    // Kept drawing (only frames drawn one after another are timed): orbits until Flat, then two more, 20 s past the
    // 10 s of fast windows a rise needs (RISE_HOLD_MS): a warm-up orbit at Flat and a counted one, Flat's frame times.
    const until = Date.now() + 120_000
    while (Date.now() < until && (await drawn()).perf.tier !== 'flat') await orbit()
    await orbit()
    await page.evaluate(() => (window as unknown as { __worldPerf: PerfProbe }).__worldPerf.begin())
    await orbit()
    const flat = await page.evaluate(() => (window as unknown as { __worldPerf: PerfProbe }).__worldPerf.end())
    await page.evaluate(() => window.clearInterval((window as unknown as { __tierPoll: number }).__tierPoll))
    const log = await tierLog()
    const first = log.first as number
    const steps = log.seen.map((s) => `${s.tier} at ${first === null ? '?' : Math.round(s.at - first)} ms`)
    console.log(`world-perf governor: ${steps.join(', ')} (first frame ${log.first === null ? 'never' : 'seen'})`)
    expect(log.first, 'no frame was ever drawn at High').not.toBeNull()
    expect(log.seen.map((s) => s.tier), `the tiers seen: ${steps.join(', ')}`).toEqual(['high', 'low', 'flat'])
    const flatAt = log.seen[2].at - first
    const bound = GOVERNOR_FLAT_MS[OS_NAME]
    if (bound !== undefined) expect(flatAt, `Flat came ${Math.round(flatAt)} ms after the first frame (${OS_NAME} bound ${bound} ms)`).toBeLessThanOrEqual(bound)
    const end = (await drawn()).perf
    expect(end.tier, 'the map rose from Flat').toBe('flat')
    expect(end.auto).toBe(true)
    // The big world's orbit at Flat, in software (spec §6.2's floor is for Flat): written, logged and held to the floor.
    const result = { os: OS_NAME, fixture: 'big', tier: 'flat', auto: true, software: true, renderer: await rendererName(), ...flat, governor: steps, viewport: VIEWPORT }
    fs.writeFileSync(path.join(OUT, `${OS_NAME}-big-flat.json`), `${JSON.stringify(result, null, 2)}\n`)
    console.log(`world-perf ${JSON.stringify(result)}`)
    expect(flat.frames, 'the orbit at Flat counted no frames').toBeGreaterThan(0)
    const floor = SOFTWARE_FLOOR_P95_MS[OS_NAME]?.big
    if (floor !== undefined) expect(flat.p95, `big at Flat: the orbit p95 ${flat.p95} ms is over the ${OS_NAME} software floor ${floor} ms`).toBeLessThanOrEqual(floor)
  })
})
