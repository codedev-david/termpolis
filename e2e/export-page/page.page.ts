/**
 * The exported page in every browser (spec 5.3): the city paints, a card opens on click and is read-only, a tour
 * runs, Esc clears the selection and a second Esc does no harm, keyword Ask answers at once (before smart Ask is
 * ready), and picking a result flies to it and opens its card. Without WebGL the 2D map shows and Ask still
 * answers. Every test also proves the page made no request: the context aborts everything but the page's own file
 * and logs every request, and nothing but that file (and data:/blob: URLs) may appear; nor may any CSP violation.
 */
import fs from 'node:fs'
import type { Page } from '@playwright/test'
import { ASK_LOADING, ask, askReady, askState, cityClip, expect, paint, test, type Opened } from './helpers'
import { FIXTURE_JSON, KEYWORD_HTML, SMART_HTML } from './paths'

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

/** What every test ends on: no request left the page, the page threw nothing, and its CSP refused nothing. */
async function noRequestsNoErrors(o: Opened): Promise<void> {
  expect(o.foreign(), 'requests other than the page itself').toEqual([])
  expect(o.errors, 'errors thrown in the page').toEqual([])
  expect(await o.violations(), 'CSP violations').toEqual([])
}

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
  const before = three ? await o.page.screenshot({ clip: await cityClip(o.page) }) : null
  const ids = await ask(o.page, 'where do the terminal shells actually run')
  const first = o.page.locator('.wx-ask-results button.wx-ask-pick').first()
  const name = (await first.locator('.wx-ask-name').textContent()) ?? ''
  expect(ids[0]).not.toBe('')
  await first.click()
  const card = o.page.locator('.wx-card')
  await expect(card).toBeVisible()
  await expect(card.locator('.wx-card-body h3').first()).toHaveText(name)
  if (before) {
    // The camera flew: the middle of the city no longer looks as it did.
    await settle(o.page)
    const after = await o.page.screenshot({ clip: await cityClip(o.page) })
    expect(after.equals(before), 'the city view changed after the pick').toBe(false)
  }
  await noRequestsNoErrors(o)
})

test('the pages fit their size budgets', () => {
  const info = test.info()
  const smart = fs.statSync(SMART_HTML).size
  const keyword = fs.statSync(KEYWORD_HTML).size
  const fixture = fs.statSync(FIXTURE_JSON).size
  info.annotations.push({ type: 'sizes', description: `smart ${smart} B, keyword ${keyword} B, fixture JSON ${fixture} B` })
  expect(smart).toBeLessThan(40 * 1024 * 1024)
  expect(keyword).toBeLessThan(1.5 * 1024 * 1024 + fixture)
})
