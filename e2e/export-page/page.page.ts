/**
 * The exported page in every browser (spec 5.3): the city paints, a card opens on click and is read-only, a tour
 * runs, Esc clears the selection and a second Esc does no harm, keyword Ask answers at once (before smart Ask is
 * ready), and picking a result flies to it and opens its card. Without WebGL the 2D map shows and Ask still
 * answers. Every test also proves the page made no request: the context aborts everything but the page's own file
 * and logs every request, and nothing but that file (and data:/blob: URLs) may appear; nor may any CSP violation.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { ASK_LOADING, SELF_LOAD_UNSEEN, ask, askReady, askState, cityClip, expect, paint, test, type Opened } from './helpers'
import { FIXTURE_DIR, FIXTURE_JSON, KEYWORD_HTML, SMART_HTML } from './paths'
import { FRAME_FLIGHT_S } from '../../src/renderer/src/world/engine/cameraRig'

const world = JSON.parse(fs.readFileSync(FIXTURE_JSON, 'utf8')) as { tours: Array<{ title: string; steps: Array<{ caption: string }> }> }
const SMART_BROWSERS = new Set(['electron', 'msedge'])

/** Whether the page drew the 3D city (a canvas in the view) rather than the 2D map. */
const in3d = async (page: Page): Promise<boolean> => (await page.locator('.wx-view canvas').count()) > 0

/**
 * Page time from a pick to a camera at rest on the building: the flight (FRAME_FLIGHT_S), then half a second for the
 * picture's move to the free area beside the card (easeArea closes 1 - e^-12t of the gap: past 99.7% by then).
 */
const LANDED_MS = FRAME_FLIGHT_S * 1000 + 500

/**
 * Stops the page's clock where it is. pauseAt takes a time that must still be ahead of the page's, and the page's
 * time is read before the pause reaches it: on a busy page the pause arrives late (465 ms after the reading in Edge
 * on a CI runner, against the 100 ms it allowed) and is refused with "Cannot fast-forward to the past". pauseAt has
 * stopped the clock by then all the same (it stops it before it moves it on), so the second reading is of a stopped
 * clock, and a pause 100 ms ahead of that cannot come too late. A second refusal means that no longer holds: it fails.
 */
async function pauseClock(page: Page): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const at = await page.evaluate(() => Date.now() + 100)
    try {
      await page.clock.pauseAt(at)
      return
    } catch (e) {
      if (attempt > 0 || !/Cannot fast-forward to the past/.test(String(e))) throw e
    }
  }
}

/** Lets the city settle after load: its first frames, labels and the camera's opening move. */
const settle = (page: Page): Promise<void> => page.waitForTimeout(1500)

/**
 * Clicks across the middle of the city until a card opens (the page offers no hook to find a building's point:
 * the exported page carries none, by design). In the 2D map it clicks the first building instead.
 */
async function openCardByClick(page: Page): Promise<void> {
  const card = page.locator('.wx-card')
  if (!(await in3d(page))) {
    await page.locator('.wx-map2d [data-kind="building"][data-id]').first().click()
    await expect(card).toBeVisible()
    return
  }
  const clip = await cityClip(page)
  for (let row = 1; row <= 6; row++) {
    for (let col = 1; col <= 8; col++) {
      await page.mouse.click(clip.x + (clip.width * col) / 9, clip.y + (clip.height * row) / 7)
      if (await card.isVisible()) return
      // A click that missed every building closes any card and, after a pick, flies back: give it time.
      await page.waitForTimeout(120)
      if (await card.isVisible()) return
    }
  }
  throw new Error('no click across the city opened a card')
}

/**
 * How far the label of the building named `name` sits from the middle of the city's free area (cityClip), as a
 * share of that area's half-diagonal; null when no such label is drawn. The page exposes no camera (by design), but
 * its labels are DOM elements the viewer places over each building, so a label at the middle is a building framed
 * there.
 */
async function labelOffset(page: Page, name: string): Promise<number | null> {
  const clip = await cityClip(page)
  return page.evaluate(({ name, clip }) => {
    const cx = clip.x + clip.width / 2
    const cy = clip.y + clip.height / 2
    const half = Math.hypot(clip.width, clip.height) / 2
    let best: number | null = null
    for (const el of Array.from(document.querySelectorAll('.lw-bldg'))) {
      if (el.textContent !== name || getComputedStyle(el).display === 'none') continue
      const r = el.getBoundingClientRect()
      if (r.width === 0 && r.height === 0) continue
      const d = Math.hypot(r.x + r.width / 2 - cx, r.y + r.height / 2 - cy) / half
      if (best === null || d < best) best = d
    }
    return best
  }, { name, clip })
}

/** What every test ends on: no request left the page, the page threw nothing, and its CSP refused nothing. */
async function noRequestsNoErrors(o: Opened): Promise<void> {
  expect(o.foreign(), 'requests other than the page itself').toEqual([])
  expect(o.errors, 'errors thrown in the page').toEqual([])
  expect(await o.violations(), 'CSP violations').toEqual([])
}

test('the request log is live: a copy of the page without its CSP that asks for one image is caught asking', async ({ open }, info) => {
  // The control for every "no request" check in these specs, in every project. Firefox needs it most: it reports
  // no request for the page's own file:// load (SELF_LOAD_UNSEEN), so the fixture can't prove its log live there.
  const html = fs.readFileSync(KEYWORD_HTML, 'utf8')
  const meta = /<meta http-equiv="Content-Security-Policy" content="[^"]*">/
  expect(html, 'the keyword page carries its CSP').toMatch(meta)
  // A reserved name (.invalid) on https and its default port: a blocked port (such as 9) is refused by Firefox and
  // WebKit before any request event, and the route aborts this one before any lookup.
  const canary = 'https://export-canary.invalid/canary.png'
  const copy = path.join(FIXTURE_DIR, 'request-canary.html')
  fs.writeFileSync(copy, html.replace(meta, '').replace('</body>', `<img alt="" src="${canary}"></body>`))
  const o = await open(copy)
  // The route aborts it, so it never leaves the machine; what matters is that the log saw it and foreign() reports it.
  await expect.poll(() => o.foreign(), { message: `foreign() reports the canary (${info.project.name}${SELF_LOAD_UNSEEN.has(info.project.name) ? ', whose own file:// load is unseen' : ''})` }).toContain(canary)
  expect(o.foreign()).toEqual([canary])
})

test('the city paints, and no card shows at start', async ({ open }, info) => {
  const o = await open(KEYWORD_HTML)
  expect((await askReady(o.page)).state).toBe('keyword')
  await expect(o.page.locator('.wx-card')).toBeHidden()
  if (!(await in3d(o.page))) {
    // A browser without WebGL in this runner: the page shows the 2D map. Electron and Edge must draw the city.
    expect(SMART_BROWSERS.has(info.project.name), `${info.project.name} drew no 3D city`).toBe(false)
    await expect(o.page.locator('.wx-map2d')).toBeVisible()
    info.annotations.push({ type: 'no-webgl', description: `${info.project.name} has no WebGL here: the 2D map showed` })
  } else {
    await settle(o.page)
    const lit = paint(await o.page.screenshot({ clip: await cityClip(o.page) }))
    info.annotations.push({ type: 'city', description: `lit ${(lit.lit * 100).toFixed(1)}%, ${lit.colours} colours` })
    expect(lit.lit, 'share of the city view that is not background').toBeGreaterThan(0.02)
    expect(lit.colours).toBeGreaterThan(20)
  }
  await noRequestsNoErrors(o)
})

test('without WebGL the 2D map shows and keyword Ask answers', async ({ open }) => {
  const o = await open(KEYWORD_HTML, { noWebGL: true })
  await expect(o.page.locator('.wx-map2d')).toBeVisible()
  await expect(o.page.locator('.wx-view canvas')).toHaveCount(0)
  expect(await ask(o.page, 'what draws the 3D city')).toContain('b-lumo-pane')
  // A part in the map opens its card there.
  await o.page.locator('.wx-map2d [data-kind="building"][data-id]').first().click()
  await expect(o.page.locator('.wx-card')).toBeVisible()
  await noRequestsNoErrors(o)
})

test('a card opens on click and is read-only', async ({ open }) => {
  const o = await open(KEYWORD_HTML)
  await askReady(o.page)
  await settle(o.page)
  await openCardByClick(o.page)
  await expect(o.page.locator('.wx-card-body h3').first()).not.toBeEmpty()
  await expect(o.page.locator('[data-confirm]')).toHaveCount(0)
  await expect(o.page.locator('.wx-card button.confirm')).toHaveCount(0)
  await noRequestsNoErrors(o)
})

test('a tour runs', async ({ open }) => {
  const o = await open(KEYWORD_HTML)
  await askReady(o.page)
  const tour = world.tours[0]
  // Every caption the card shows is written down in the page as it goes in. A step can be on screen for little more
  // than its 1.4 s pause, and on a slow software-WebGL page each call into it can take half a second (the click
  // itself took 3.7 s in Edge on a CI runner): asked from here, the first caption had come and gone before the
  // first look. The page's own record misses none, however slowly it is read.
  await o.page.evaluate(() => {
    const seen: string[] = []
    ;(window as unknown as { __tourCaptions: string[] }).__tourCaptions = seen
    new MutationObserver((records) => {
      for (const r of records) {
        for (const n of Array.from(r.addedNodes)) {
          if (!(n instanceof Element)) continue
          const caption = n.matches('.tour-caption') ? n : n.querySelector('.tour-caption')
          if (caption) seen.push(caption.textContent ?? '')
        }
      }
    }).observe(document.querySelector('.wx-card') as Element, { childList: true, subtree: true })
  })
  const captions = (): Promise<string[]> => o.page.evaluate(() => [...(window as unknown as { __tourCaptions: string[] }).__tourCaptions])
  await o.page.locator('[data-control="tour"]', { hasText: tour.title }).click()
  const card = o.page.locator('.wx-card')
  await expect(card).toBeVisible()
  if (await in3d(o.page)) {
    // The city plays it: each step's caption in the card, in order, the first one first.
    await expect.poll(async () => (await captions()).slice(0, 2), { message: 'the first two captions the card showed', timeout: 15_000 })
      .toEqual([tour.steps[0].caption, tour.steps[1].caption])
  } else {
    await expect(card.locator('ol li')).toHaveCount(tour.steps.length)
  }
  await noRequestsNoErrors(o)
})

test('one Esc clears the selection, and a second Esc does nothing harmful', async ({ open }) => {
  const o = await open(KEYWORD_HTML)
  await askReady(o.page)
  await settle(o.page)
  await openCardByClick(o.page)
  const card = o.page.locator('.wx-card')
  await o.page.keyboard.press('Escape')
  await expect(card).toBeHidden()
  await o.page.keyboard.press('Escape')
  await o.page.waitForTimeout(500)
  await expect(card).toBeHidden()
  await expect(o.page.locator('.wx-page')).toBeVisible()
  await expect(o.page.locator('.wx-broken')).toHaveCount(0)
  expect((await ask(o.page, 'where do the terminal shells actually run')).length).toBeGreaterThan(0)
  await noRequestsNoErrors(o)
})

test('keyword Ask answers before smart Ask is ready', async ({ open }, info) => {
  // The ORT wasm is held back, so smart Ask is still loading while the question is asked.
  const o = await open(SMART_HTML, { holdWasm: true })
  await expect(o.page.locator('.wx-ask')).toHaveAttribute('data-state', 'loading')
  await expect(o.page.locator('.wx-ask-status')).toHaveText(ASK_LOADING)
  const ids = await ask(o.page, 'how does the phone connect to my desktop')
  expect(ids.length).toBeGreaterThan(0)
  expect(await askState(o.page)).toBe('loading')
  await o.releaseWasm()
  const ready = await askReady(o.page)
  if (SMART_BROWSERS.has(info.project.name)) expect(ready.state).toBe('smart')
  else expect(['smart', 'failed']).toContain(ready.state)
  await noRequestsNoErrors(o)
})

test('clicking a result flies to it and opens its card', async ({ open }) => {
  // The page's clock is Playwright's, so the first reading can be taken with time stopped (see below).
  const o = await open(KEYWORD_HTML, { clock: true })
  await askReady(o.page)
  await settle(o.page)
  const three = await in3d(o.page)
  // Lesson distiller stands at a corner of the fixture city (-48, 0, 41): with no flight its label sits about
  // 1.0 of the half-diagonal from the middle of the free area, and the flight brings it to about 0.1. A building
  // near the middle (Terminal host, about 0.2 before any flight) could not show a camera that never moved, and
  // one framed off-centre among far neighbours (Linked machines, 0.32 -> 0.35) does not come to the middle.
  const ids = await ask(o.page, 'lesson distiller')
  expect(ids, 'Lesson distiller among the results').toContain('b-distiller')
  const first = o.page.locator('.wx-ask-results button.wx-ask-pick[data-id="b-distiller"]')
  const name = (await first.locator('.wx-ask-name').textContent()) ?? ''
  const reading = (): Promise<number | null> => labelOffset(o.page, name)
  let from: number | null = null
  let landed: number | null = null
  if (three) {
    // The first reading is taken with the camera near-still. Hovering the building cannot draw its label here: at the
    // opening view a district's slab stands for its buildings, so a hover picks the district. So time stops (the
    // page's frames, timers and clock with it, and the idle turn), the click selects the building, and the clock
    // is stepped one frame at a time until the selected building's label is drawn. The flight (1.5 s, eased in)
    // has then barely moved the camera: the reading has been up to 7% under that of a camera that never moved.
    await pauseClock(o.page)
    try {
      await expect(first).toBeVisible()
      await first.click({ force: true }) // no actionability wait: it watches animation frames, and they are stopped
      for (let step = 0; step < 10 && from === null; step++) {
        await o.page.clock.runFor(16)
        from = await reading()
      }
      // The rest of the flight runs on the stopped clock too, frame by frame, to past its landing and the picture's
      // move to the free area beside the card. Where the camera ends up then depends on the page's time alone, never
      // on how long this browser takes to answer: Firefox on a macOS runner once stalled over 4 s on a frame
      // mid-flight, and a 5 s wait for the label, counted on the runner's clock, ran out before the camera landed.
      if (from !== null) {
        await o.page.clock.runFor(LANDED_MS)
        landed = await reading()
      }
    } finally {
      // Also on a failure, so its trace shows the page running rather than frozen.
      await o.page.clock.resume().catch(() => undefined)
    }
    expect(from, `the label of ${name} is drawn once it is picked`).not.toBeNull()
  } else {
    await first.click()
  }
  const card = o.page.locator('.wx-card')
  await expect(card).toBeVisible()
  await expect(card.locator('.wx-card-body h3').first()).toHaveText(name)
  if (three) {
    // The camera flew to it: the label came to the middle of the city, well nearer than it started.
    // A camera that never moved fails both: the label stays where the first reading found it.
    const start = from as number
    test.info().annotations.push({ type: 'fly', description: `${name}: label at ${start.toFixed(3)} of the half-diagonal from the middle with the camera near-still; at ${landed === null ? 'none' : landed.toFixed(3)} once landed` })
    expect(landed, `the label of ${name} is drawn once the camera has landed`).not.toBeNull()
    expect(landed as number, `the label of ${name} reaches the middle of the city`).toBeLessThan(0.2)
    expect(start, `the label of ${name} starts far from the middle, so the flight has somewhere to go`).toBeGreaterThan(0.4)
    expect(landed as number, `the label of ${name} came well nearer the middle than it started (${start.toFixed(3)})`).toBeLessThan(start / 2)
  }
  await noRequestsNoErrors(o)
})

test('the pages fit their size budgets', () => {
  const info = test.info()
  test.skip(info.project.name !== 'electron', 'a check of the files, once')
  const smart = fs.statSync(SMART_HTML).size
  const keyword = fs.statSync(KEYWORD_HTML).size
  const fixture = fs.statSync(FIXTURE_JSON).size
  info.annotations.push({ type: 'sizes', description: `smart ${smart} B, keyword ${keyword} B, fixture JSON ${fixture} B` })
  expect(smart).toBeLessThan(40 * 1024 * 1024)
  expect(keyword).toBeLessThan(1.5 * 1024 * 1024 + fixture)
})
