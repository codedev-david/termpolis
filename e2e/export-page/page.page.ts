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

const world = JSON.parse(fs.readFileSync(FIXTURE_JSON, 'utf8')) as { tours: Array<{ title: string; steps: Array<{ caption: string }> }> }
const SMART_BROWSERS = new Set(['electron', 'msedge'])

/** Whether the page drew the 3D city (a canvas in the view) rather than the 2D map. */
const in3d = async (page: Page): Promise<boolean> => (await page.locator('.wx-view canvas').count()) > 0

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
  await o.page.locator('[data-control="tour"]', { hasText: tour.title }).click()
  const card = o.page.locator('.wx-card')
  await expect(card).toBeVisible()
  if (await in3d(o.page)) {
    // The city plays it: each step's caption in the card, in order.
    await expect(card.locator('.tour-caption')).toHaveText(tour.steps[0].caption)
    await expect(card.locator('.tour-caption')).toHaveText(tour.steps[1].caption, { timeout: 15_000 })
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
  const o = await open(KEYWORD_HTML)
  await askReady(o.page)
  await settle(o.page)
  const three = await in3d(o.page)
  // Lesson distiller stands at a corner of the fixture city (-48, 0, 41), far from the middle of the opening
  // view (about 0.56 of the half-diagonal), and the flight brings its label to about 0.09. A building near the
  // middle (Terminal host, about 0.2 before any flight) could not show a camera that never moved, and one framed
  // off-centre among far neighbours (Linked machines, 0.32 -> 0.35) does not come to the middle at all.
  const ids = await ask(o.page, 'lesson distiller')
  expect(ids, 'Lesson distiller among the results').toContain('b-distiller')
  const first = o.page.locator('.wx-ask-results button.wx-ask-pick[data-id="b-distiller"]')
  const name = (await first.locator('.wx-ask-name').textContent()) ?? ''
  await first.click()
  // The first reading, taken as soon as the click lands: the camera takes 1.5 s to frame a building
  // (FRAME_FLIGHT_S), so this is where the label sits before the flight, and it is drawn because the
  // building is now selected. Polled only until the label first shows (a frame or two), not until it moves.
  // Every reading is kept: the first drawn one is where the flight starts, the last is where it ends.
  const seen: (number | null)[] = []
  const reading = async (): Promise<number | null> => {
    const v = await labelOffset(o.page, name)
    seen.push(v)
    return v
  }
  if (three) {
    await expect.poll(reading, { message: `the label of ${name} is drawn once it is picked`, intervals: [16], timeout: 2000 }).not.toBeNull()
  }
  const card = o.page.locator('.wx-card')
  await expect(card).toBeVisible()
  await expect(card.locator('.wx-card-body h3').first()).toHaveText(name)
  if (three) {
    // The camera flew to it: the label ends in the middle of the city, and well nearer than it started.
    // A camera that never moved fails both: the label stays where the first reading found it.
    const from = seen.find((v): v is number => v !== null) as number
    await expect.poll(reading, { message: `the label of ${name} reaches the middle of the city`, intervals: [100], timeout: 5000 }).toBeLessThan(0.2)
    const to = seen[seen.length - 1] as number
    test.info().annotations.push({ type: 'fly', description: `${name}: label ${from.toFixed(3)} -> ${to.toFixed(3)} of the half-diagonal from the middle` })
    expect(from, `the label of ${name} starts far from the middle, so the flight has somewhere to go`).toBeGreaterThan(0.4)
    expect(to, `the label of ${name} ends well nearer the middle than it started (${from.toFixed(3)})`).toBeLessThan(from / 2)
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
