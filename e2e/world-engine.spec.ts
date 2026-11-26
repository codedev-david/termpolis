/**
 * Lumopolis engine e2e: the standalone dist-world/world-viewer.js bundle in a real Electron
 * window with software WebGL. Loads the fixture world, clicks a building, checks the inspector
 * card, closes it with Esc. Task 14 adds more.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { _electron as electron } from 'playwright'
import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { e2eUserDataDir, quitApp } from './helpers/launch'

let app: ElectronApplication
let page: Page
const consoleErrors: string[] = []

const BUNDLE = path.resolve('dist-world/world-viewer.js')
const SOURCES = ['src/renderer/src/world', 'src/shared/world'].map((d) => path.resolve(d))

/** Newest mtime of any file under the given folders. */
function newestSource(dirs: string[]): number {
  let newest = 0
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else newest = Math.max(newest, fs.statSync(p).mtimeMs)
    }
  }
  for (const d of dirs) walk(d)
  return newest
}

test.beforeAll(async () => {
  // Rebuild when the bundle is missing or older than any engine/validator source, so the spec
  // never passes against a stale bundle.
  if (!fs.existsSync(BUNDLE) || fs.statSync(BUNDLE).mtimeMs < newestSource(SOURCES)) {
    execSync('npm run build:world-viewer', { cwd: path.resolve('.'), stdio: 'pipe', timeout: 180_000 })
  }
  // The website loads this one file on its own: it must not import anything (Three is inlined).
  const bundle = fs.readFileSync(BUNDLE, 'utf8')
  expect(bundle.match(/^\s*import\s*[\w*{"']/m), 'world-viewer.js must be standalone (no import statements)').toBeNull()
  expect(bundle.match(/(?:^|[^\w$.])import\s*\(/m), 'world-viewer.js must not import() other chunks').toBeNull()
  app = await electron.launch({
    args: [
      path.resolve('tests/e2e/fixtures/world-harness-main.cjs'),
      `--user-data-dir=${e2eUserDataDir('world-engine')}`,
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
    ],
  })
  page = await app.firstWindow()
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })
  page.on('pageerror', (err) => { consoleErrors.push(String(err)) })
  await page.waitForSelector('body[data-ready="1"]', { timeout: 30_000 })
})

test.afterAll(async () => {
  await quitApp(app)
})

test('draws the world on a canvas that fills its container', async () => {
  const size = await page.locator('#view canvas').evaluate((c: HTMLCanvasElement) => {
    const r = c.getBoundingClientRect()
    const v = (c.parentElement as HTMLElement).getBoundingClientRect()
    return { w: r.width, h: r.height, vw: v.width, vh: v.height, ww: window.innerWidth, wh: window.innerHeight, bw: c.width, bh: c.height }
  })
  // #view is inset: 0, so it is the window; the canvas must fill (at least 90% of) both.
  expect(size.vw).toBeGreaterThanOrEqual(size.ww * 0.9)
  expect(size.vh).toBeGreaterThanOrEqual(size.wh * 0.9)
  expect(size.w).toBeGreaterThanOrEqual(size.vw * 0.9)
  expect(size.h).toBeGreaterThanOrEqual(size.vh * 0.9)
  // and its drawing buffer is real (the harness draws at Auto: High on a GPU, Flat in software, both at the full pixel
  // ratio here; Low would draw at three quarters of it)
  expect(size.bw).toBeGreaterThanOrEqual(size.w * 0.9)
  expect(size.bh).toBeGreaterThanOrEqual(size.h * 0.9)
})

test('clicking a building opens its card, Esc closes it', async () => {
  const card = page.locator('#card')
  await expect(card).toBeHidden()
  const pt = await page.evaluate(() => (window as unknown as { __worldTest: { project(id: string): Promise<{ x: number; y: number }> } }).__worldTest.project('b1'))
  await page.mouse.click(pt.x, pt.y)
  await expect(card).toBeVisible()
  await expect(card.locator('h3').first()).toHaveText('Desktop app')
  await page.keyboard.press('Escape')
  await expect(card).toBeHidden()
})

// Watch it grow: fixture B is fixture A plus two buildings (b3, b4).
const WORLD_A = JSON.parse(fs.readFileSync(path.resolve('tests/shared/fixtures/world.min.json'), 'utf8')) as unknown
const WORLD_B = JSON.parse(fs.readFileSync(path.resolve('tests/shared/fixtures/world.grown.json'), 'utf8')) as unknown

type Visual = { ringAngle: number; fogDrift: number; wirePulse: number; selectionRingAngle: number }
interface Harness {
  load(doc: unknown, opts?: { animateFrom?: unknown }): void
  requestFrame(): void
  drawn(): { changing: number; presented: number; visual: Visual; hot: string[]; tier: string; slabs: number; slabLooks: Array<{ id: string; heat: number; hot: boolean; outline: boolean; fading: boolean; fog: boolean }> }
  project(id: string): Promise<{ x: number; y: number }>
  screenPoint(id: string): { x: number; y: number } | null
}
type HarnessWindow = { __worldTest: Harness }

/** Loads A, then B growing from A; returns how many changes were animating right after. */
async function growAtoB(): Promise<number> {
  return page.evaluate(([a, b]) => {
    const t = (window as unknown as HarnessWindow).__worldTest
    t.load(a)
    t.load(b, { animateFrom: a })
    return t.drawn().changing
  }, [WORLD_A, WORLD_B] as const)
}

test('with reduced motion a grown world appears at once and the toast says what changed', async () => {
  expect(await growAtoB()).toBe(0)
  await expect(page.locator('#view .lw-toast')).toHaveText('+2 parts')
  await expect(page.locator('#view .lw-toast')).toHaveAttribute('aria-live', 'polite')
})

test('load A, then B with 2 added: after 1 s both are visible and the toast reads +2 parts', async () => {
  await page.goto(page.url().split('?')[0] + '?motion=1')
  await page.waitForSelector('body[data-ready="1"]', { timeout: 30_000 })
  expect(await growAtoB()).toBeGreaterThanOrEqual(2) // b3 and b4 rising
  await page.waitForTimeout(1000)
  // Checked first: the toast goes about 3 s after the load, and the poll below may use up to 2 s more.
  await expect(page.locator('#view .lw-toast')).toHaveText('+2 parts')
  // The rise lasts 900 ms of wall-clock time, but frames on a busy software-GL runner can come late:
  // poll for the settled count instead of asserting it at a fixed instant.
  await expect.poll(() => page.evaluate(() => (window as unknown as HarnessWindow).__worldTest.drawn().changing), { timeout: 2000 }).toBe(0)
  for (const id of ['b3', 'b4']) {
    const point = await page.evaluate(async (bid) => {
      const t = (window as unknown as HarnessWindow).__worldTest
      await t.project(bid)
      return t.screenPoint(bid)
    }, id)
    expect(point, `${id} is drawn and in view`).not.toBeNull()
  }
})

/** The four motions as the last frame drew them. Only those: the rest of `visual` (which line labels show, say) is layout, not motion. */
const readMotion = (): Promise<Visual> => page.evaluate(() => {
  const { ringAngle, fogDrift, wirePulse, selectionRingAngle } = (window as unknown as HarnessWindow).__worldTest.drawn().visual
  return { ringAngle, fogDrift, wirePulse, selectionRingAngle }
})

/** Loads A with its first building guessed (so it is fog), selects the verified one, and reads the four motions 800 ms apart. */
async function motionTwice(): Promise<[Visual, Visual]> {
  await page.waitForSelector('body[data-ready="1"]', { timeout: 30_000 })
  const point = await page.evaluate(async (a) => {
    const t = (window as unknown as HarnessWindow).__worldTest
    const doc = JSON.parse(JSON.stringify(a)) as { buildings: Array<{ id: string; how: Array<{ state: string }>; why: Array<{ state: string }> }> }
    for (const c of [...doc.buildings[0].how, ...doc.buildings[0].why]) c.state = 'inferred'
    t.load(doc)
    return t.project('b2')
  }, WORLD_A)
  await page.mouse.click(point.x, point.y)
  await expect(page.locator('#card')).toBeVisible()
  const first = await readMotion()
  await page.waitForTimeout(800)
  return [first, await readMotion()]
}

/** Frames presented so far (drawn().presented), each read asking for one more. */
const presentedNow = (): Promise<number> => page.evaluate(() => {
  const t = (window as unknown as HarnessWindow).__worldTest
  t.requestFrame()
  return t.drawn().presented
})

test('reduced motion freezes the ring, fog drift, wireframe pulse and selection ring', async () => {
  const base = page.url().split('?')[0]
  await page.goto(base) // reduced motion: the harness default
  const [a] = await motionTwice()
  // Frozen is judged across frames drawn: a busy software runner may draw none in 800 ms, and with no frame drawn a
  // ring that turns reads the same twice (look A2 review N9). Two more frames are asked for and waited for.
  const drawnBefore = await presentedNow()
  await expect.poll(async () => (await presentedNow()) - drawnBefore, { message: 'two frames are drawn between the two reads', timeout: 10_000 }).toBeGreaterThanOrEqual(2)
  const b = await readMotion()
  expect(b, 'with reduced motion, nothing moves across the frames drawn').toEqual(a)
  await page.goto(base + '?motion=1')
  const [c] = await motionTwice()
  // Moving, the ring and the fog drift change from frame to frame. Drawn in software on a busy runner, no frame may be
  // drawn in the 800 ms above (the macOS soak 45830192658 read the same ring angle 800 ms apart), so the next drawn
  // frame is waited for: a frozen ring never changes, however long the wait.
  await expect.poll(async () => {
    const d = await readMotion()
    return { ring: d.ringAngle !== c.ringAngle, fog: d.fogDrift !== c.fogDrift }
  }, { message: 'with motion on, the ring turns and the fog drifts', timeout: 10_000 }).toEqual({ ring: true, fog: true })
})

test('a building with live latency is drawn hot, and one without is not', async () => {
  await page.goto(page.url().split('?')[0])
  await page.waitForSelector('body[data-ready="1"]', { timeout: 30_000 })
  const hot = await page.evaluate((a) => {
    const t = (window as unknown as HarnessWindow).__worldTest
    const doc = JSON.parse(JSON.stringify(a)) as { layers: { live?: unknown } }
    doc.layers.live = { b2: { latencyMs: 600 } }
    t.load(doc)
    return t.drawn().hot
  }, WORLD_A)
  expect(hot).toEqual(['b2'])
})

test('from far away a hot building makes its district slab hot', async () => {
  // The home view is the districts tier, where the buildings hide under their slabs: the slab must
  // carry its hottest building's heat (spec 5.11), as it carries planned, changed, fading and fog.
  await page.goto(page.url().split('?')[0])
  await page.waitForSelector('body[data-ready="1"]', { timeout: 30_000 })
  const looks = (): Promise<{ tier: string; slabs: number; slabLooks: Array<{ id: string; heat: number; hot: boolean; outline: boolean; fading: boolean; fog: boolean }> }> => page.evaluate(() => {
    const d = (window as unknown as HarnessWindow).__worldTest.drawn()
    return { tier: d.tier, slabs: d.slabs, slabLooks: d.slabLooks }
  })
  // Cold first: no live data, no hot slab.
  await expect.poll(async () => (await looks()).tier, { timeout: 5000 }).toBe('districts')
  expect((await looks()).slabLooks).toEqual([{ id: 'd1', heat: 0, hot: false, outline: false, fading: false, fog: false }])
  await page.evaluate((a) => {
    const doc = JSON.parse(JSON.stringify(a)) as { layers: { live?: unknown } }
    doc.layers.live = { b2: { latencyMs: 600 } }
    ;(window as unknown as HarnessWindow).__worldTest.load(doc)
  }, WORLD_A)
  await expect.poll(async () => (await looks()).tier, { timeout: 5000 }).toBe('districts')
  const far = await looks()
  expect(far.slabs).toBe(1)
  expect(far.slabLooks).toHaveLength(1)
  expect(far.slabLooks[0]).toMatchObject({ id: 'd1', hot: true, outline: false, fading: false, fog: false })
  expect(far.slabLooks[0].heat).toBeGreaterThan(0)
})

test('logs no console errors', async () => {
  expect(consoleErrors).toEqual([])
  // The harness's own early collector also sees errors raised before the spec's listeners attached.
  const early = await page.evaluate(() => (window as unknown as { __errors: string[] }).__errors)
  expect(early).toEqual([])
})
