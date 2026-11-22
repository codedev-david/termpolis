// The exported pages at every screen size, from a tablet to a 5K monitor (acceptance items 1, 2, 3, 5 and 6 of the
// responsive brief): no text overlaps text, a panel or the toolbar; no text is cut off; nothing scrolls across the
// page; nothing is smaller than 12 CSS px; and on a big screen at DPR 1 the page's text grows. Each viewport opens
// the page once and walks it through its states: the city as it opens, the legend toggled, a building's card, an
// Ask with its results, and the 2D map. The document page is checked as the long read it is. Each state is saved as
// a PNG (to RESPONSIVE_SHOTS, default test-results/responsive-shots) for the before/after contact sheet.
//
// Chromium only (the electron and msedge projects): the page's layout is the same CSS everywhere, the other engines'
// own runs cover the page working there, and four engines at every size would add minutes to every run. The blocking
// run checks BLOCKING_VIEWPORTS (a tablet, a small laptop, 1080p and 4K); RESPONSIVE_FULL=1 checks all of VIEWPORTS,
// and RESPONSIVE_ONLY names some (see responsiveViewports).
//
// Two more cases, always run: an 800x700 page and a 768x1024 tablet with a long card open on a building picked from
// the Ask results. From 732 px the page keeps the Ask box's strip out of the framing, and when the card fits nowhere
// beside that strip (732 to 827 px) the framing drops it; either way the Ask box, the card and the framed building's
// name must stay clear of one another.
import fs from 'node:fs'
import path from 'node:path'
import type { CDPSession, Page } from '@playwright/test'
import { ask, askReady, expect, test } from './helpers'
import { DOCUMENT_HTML, KEYWORD_HTML, SMART_HTML } from './paths'
import { auditProblems, layoutAudit, medianFont, responsiveViewports, settleBudget, stillMoving, steady, type AuditOptions, type Viewport } from '../helpers/layoutAudit'
import { uiScale } from '../../src/shared/world/uiScale'

const SHOTS = path.resolve(process.env.RESPONSIVE_SHOTS ?? 'test-results/responsive-shots')
const PANELS = ['.wx-card', '.wx-ask-host', '.wx-legend', '.wx-toolbar', '.wx-header']
const CITY: AuditOptions = { panels: PANELS }
// The map figure and the wide tables scroll across in their own frames on purpose (the page never does).
const DOCUMENT: AuditOptions = { panels: [], verticalScroll: true, scrollX: ['.map', '.table-wrap'] }

/** The median text size a laptop shows (the 1920x1080 page measured on the code before this work: 12-13 px). On a
 *  bigger screen it must grow by the pages' own scale (uiScale, in CSS px, so a DPR 2 screen grows none). */
const LAPTOP_MEDIAN = 12
const wantMedian = (v: Viewport): number => LAPTOP_MEDIAN * uiScale(v.width, v.height)

/** Each page's size under test and the session that emulates it. Playwright puts its own viewport back after every
 *  screenshot (msedge: its 1280x800; Electron: the display's own DPR), so shoot emulates the size again after each. */
const emulated = new WeakMap<Page, { cdp: CDPSession; v: Viewport }>()

/** The window's size and DPR now, as `v`'s name would say it, or 'ok' when it is `v` (within a pixel: the window's own
 *  display scaling leaves a rounding pixel under emulation). */
const sizeNow = (page: Page, v: Viewport): Promise<string> =>
  page.evaluate(({ w, h, d }) => Math.abs(innerWidth - w) <= 1 && Math.abs(innerHeight - h) <= 1 && Math.abs(devicePixelRatio - d) < 0.01 ? 'ok' : `${innerWidth}x${innerHeight}@${devicePixelRatio}`, { w: v.width, h: v.height, d: v.dpr })

async function emulate(page: Page, cdp: CDPSession, v: Viewport): Promise<void> {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: v.width, height: v.height, deviceScaleFactor: v.dpr, mobile: false })
  await expect.poll(() => sizeNow(page, v), { timeout: 10_000 }).toBe('ok')
}

async function setViewport(page: Page, v: Viewport): Promise<void> {
  // The session stays attached: Chromium drops a session's emulation when it detaches. It closes with the page.
  const cdp = await page.context().newCDPSession(page)
  emulated.set(page, { cdp, v })
  await emulate(page, cdp, v)
}

/** When the test started, for settleBudget. */
let testStarted = Date.now()
test.beforeEach(() => { testStarted = Date.now() })

/** Waits until the page has settled (the city's frames, the label pass after a resize, the camera's moves): until its
 *  layout stops changing, not for a fixed time. A page still moving after 15 s, times how much slower than at 1080p a
 *  frame is, is a soft failure. The test renders in software, where a 4K frame takes about 0.4 s: the city's moves
 *  run on the clock and end on time, but each sample of the layout waits for a frame, and the label pass and the
 *  steady samples after a move take frames, not time. One settle waits at most a share of the test's time left
 *  (settleBudget), so a page that never settles still leaves the test its other states. The size is the emulated
 *  one (innerWidth), not Playwright's viewport. */
async function settle(page: Page, state: string): Promise<void> {
  const log: string[] = []
  const [w, h, dpr] = await page.evaluate(() => [innerWidth, innerHeight, devicePixelRatio])
  const slowness = Math.max(1, (w * h * dpr * dpr) / (1920 * 1080))
  const settled = await steady(page, null, settleBudget(15_000 * slowness, test.info().timeout, testStarted), log)
  expect.soft(settled, `${state}: the page settled${settled ? '' : ` (samples: ${log.join(', ')}; still moving: ${await stillMoving(page)})`}`).toBe(true)
}

async function shoot(page: Page, name: string, fullPage = false): Promise<void> {
  fs.mkdirSync(SHOTS, { recursive: true })
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage })
  const e = emulated.get(page)
  if (e && (await sizeNow(page, e.v)) !== 'ok') {
    // The session still holds the same override, so the same one sent again is ignored: clear it, then set it.
    await e.cdp.send('Emulation.clearDeviceMetricsOverride')
    await emulate(page, e.cdp, e.v)
  }
}

/** Audits the page as it is now; records every problem as a soft failure under `state`, and returns the median font. */
async function check(page: Page, state: string, opts: AuditOptions): Promise<number> {
  // Audited at the size under test, or the audit says nothing about it.
  const e = emulated.get(page)
  if (e) expect(await sizeNow(page, e.v), `${state}: the window is at ${e.v.name}`).toBe('ok')
  const r = await page.evaluate(layoutAudit, opts)
  expect.soft(r.texts, `${state}: the audit measured no text`).toBeGreaterThan(0)
  expect.soft(auditProblems(r), state).toEqual([])
  return medianFont(r)
}

/**
 * Clicks across the city until a card opens. Only points where the 3D view itself is hit, not a panel or a label, are
 * clicked: where the city sits moves with the size (beside the Ask strip from 732 px, centred below it).
 */
async function openCard(page: Page): Promise<boolean> {
  const card = page.locator('.wx-card')
  const points = await page.evaluate(() => {
    const view = (document.querySelector('.wx-view') as HTMLElement).getBoundingClientRect()
    const out: Array<[number, number]> = []
    for (let row = 1; row <= 11; row++) {
      for (let col = 1; col <= 13; col++) {
        const x = view.left + (view.width * col) / 14
        const y = view.top + (view.height * row) / 12
        const hit = document.elementFromPoint(x, y)
        if (hit instanceof HTMLCanvasElement && hit.closest('.wx-view')) out.push([x, y])
      }
    }
    // Nearest the view's middle first: the city is drawn there, the ground at the edges.
    const mx = view.left + view.width / 2
    const my = view.top + view.height / 2
    return out.sort((a, b) => Math.hypot(a[0] - mx, a[1] - my) - Math.hypot(b[0] - mx, b[1] - my))
  })
  for (const [x, y] of points) {
    await page.mouse.click(x, y)
    // The card opens on the click itself (the page picks on the same frame), so a short look is enough.
    if (await card.waitFor({ state: 'visible', timeout: 250 }).then(() => true, () => false)) return true
  }
  return false
}

for (const v of responsiveViewports()) {
  test.describe(`at ${v.name}`, () => {
    test.skip(({ browserName }) => browserName !== 'chromium', 'the layout is checked on Chromium (electron and msedge)')
    test(`the keyword page's city, card, Ask and 2D map fit with no overlap, cut-off or small text at ${v.name}`, async ({ open }) => {
      test.setTimeout(240_000)
      const { page } = await open(KEYWORD_HTML)
      await setViewport(page, v)
      await settle(page, 'city')
      const median = await check(page, 'city', CITY)
      await shoot(page, `export-keyword-city-${v.name}`)
      const want = wantMedian(v)
      expect.soft(median, `city: the median text size at ${v.name} (want at least ${want.toFixed(1)} px)`).toBeGreaterThanOrEqual(want - 0.5)

      // The legend the other way round from how it opened.
      const toggle = page.locator('.wx-legend button').first()
      if (await toggle.isVisible()) {
        await toggle.click()
        await settle(page, 'legend toggled')
        await check(page, 'legend toggled', CITY)
        await shoot(page, `export-keyword-legend-${v.name}`)
        await toggle.click()
        await settle(page, 'legend back')
      }

      expect.soft(await openCard(page), 'a click across the city opened a card').toBe(true)
      await settle(page, 'card')
      await check(page, 'card', CITY)
      await shoot(page, `export-keyword-card-${v.name}`)
      await page.keyboard.press('Escape')
      if (await page.locator('.wx-card').isVisible()) await page.locator('.wx-card-close').click()
      await expect(page.locator('.wx-card')).toBeHidden()
      await settle(page, 'card closed')

      await askReady(page)
      const input = page.locator('.wx-ask-input')
      await input.fill('how does memory search work')
      await input.press('Enter')
      await expect(page.locator('.wx-ask-results button.wx-ask-pick').first()).toBeVisible({ timeout: 15_000 })
      await settle(page, 'Ask results')
      await check(page, 'Ask results', CITY)
      await shoot(page, `export-keyword-ask-${v.name}`)

      await page.locator('.wx-toolbar button', { hasText: '2D map' }).click()
      await expect(page.locator('.wx-map2d')).toBeVisible()
      await settle(page, '2D map')
      await check(page, '2D map', CITY)
      await shoot(page, `export-keyword-map2d-${v.name}`)
    })

    test(`the smart page's city fits with no overlap, cut-off or small text at ${v.name}`, async ({ open }) => {
      test.setTimeout(180_000)
      const { page } = await open(SMART_HTML)
      await setViewport(page, v)
      await settle(page, 'city')
      await check(page, 'city', CITY)
      await shoot(page, `export-smart-city-${v.name}`)
    })

    test(`the document page reads at a comfortable size and line length, nothing cut off, at ${v.name}`, async ({ open }) => {
      test.setTimeout(120_000)
      const { page } = await open(DOCUMENT_HTML)
      await setViewport(page, v)
      await settle(page, 'document')
      const median = await check(page, 'document', DOCUMENT)
      const want = wantMedian(v)
      expect.soft(median, `document: the median text size at ${v.name} (want at least ${want.toFixed(1)} px)`).toBeGreaterThanOrEqual(want - 0.5)
      // Long reading keeps about 60-80 characters a line: no paragraph wider than 42em (about 85 characters).
      const wide = await page.evaluate(() =>
        Array.from(document.querySelectorAll<HTMLElement>('p, li')).filter((el) => el.getBoundingClientRect().width / parseFloat(getComputedStyle(el).fontSize) > 42 && (el.textContent ?? '').length > 120)
          .map((el) => `${el.tagName.toLowerCase()} ${Math.round(el.getBoundingClientRect().width / parseFloat(getComputedStyle(el).fontSize))}em "${(el.textContent ?? '').slice(0, 40)}"`))
      expect.soft(wide, 'paragraphs wider than 42em').toEqual([])
      // Every figure and table frame fits the page across. A map wider than its frame (kept so its labels read at 12px
      // or more) scrolls inside that frame, never the page; from a 1080p screen up it fits whole.
      const figures = await page.evaluate((fitsWhole) =>
        Array.from(document.querySelectorAll<HTMLElement>('figure, img, .table-wrap')).filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && (r.left < -1 || r.right > document.documentElement.clientWidth + 1) })
          .map((el) => `${el.tagName.toLowerCase()} ${Math.round(el.getBoundingClientRect().left)}-${Math.round(el.getBoundingClientRect().right)}`)
          .concat(Array.from(document.querySelectorAll<SVGSVGElement>('figure.map svg')).filter((svg) => {
            const frame = svg.parentElement as HTMLElement
            const over = frame.scrollWidth > frame.clientWidth + 1
            return over && (fitsWhole || getComputedStyle(frame).overflowX !== 'auto')
          }).map((svg) => `map ${Math.round(svg.getBoundingClientRect().width)} wide in a frame of ${(svg.parentElement as HTMLElement).clientWidth}`)), v.width >= 1920)
      expect.soft(figures, 'figures running off the page').toEqual([])
      await shoot(page, `export-document-top-${v.name}`)
      await shoot(page, `export-document-full-${v.name}`, true)
    })
  })
}

/** The pages a long card leaves least room on: no room is left below the card, and the room beside it is under the
 *  Ask box, so opening the card folds the Ask answer away until the card closes (800 px: the band where the framing
 *  gives up the box's strip for the card; 768x1024: a portrait tablet). */
const LONG_CARD_VIEWPORTS: Viewport[] = [
  { name: 'long-card-800x700', width: 800, height: 700, dpr: 1 },
  { name: 'long-card-768x1024', width: 768, height: 1024, dpr: 1 },
]
/** The fixture's longest card (Memory host: its how, why, claims and members run past any of these pages' height). */
const LONG_QUERY = 'memory host'
const LONG_ID = 'b-memhost'

interface Box { left: number; top: number; right: number; bottom: number }
const overlaps = (a: Box, b: Box): boolean => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1
const show = (b: Box): string => `${Math.round(b.left)},${Math.round(b.top)} to ${Math.round(b.right)},${Math.round(b.bottom)}`

for (const v of LONG_CARD_VIEWPORTS) {
  test(`with a long card open at ${v.width}x${v.height}, the Ask box, the card and the framed building's name stay clear of one another`, async ({ open, browserName }) => {
    test.skip(browserName !== 'chromium', 'the layout is checked on Chromium (electron and msedge)')
    test.setTimeout(180_000)
    const { page } = await open(KEYWORD_HTML)
    await setViewport(page, v)
    // Booted at this size, as a visitor's page is: the legend then starts as its chip (it opens from 1200x720).
    await page.reload()
    await page.evaluate(() => (window as unknown as { __worldExport: { ready: Promise<unknown> } }).__worldExport.ready)
    await settle(page, 'city')
    await askReady(page)
    const ids = await ask(page, LONG_QUERY)
    expect(ids, `${LONG_ID} among the results`).toContain(LONG_ID)
    const pickEl = page.locator(`.wx-ask-results button.wx-ask-pick[data-id="${LONG_ID}"]`)
    const name = ((await pickEl.locator('.wx-ask-name').textContent()) ?? '').trim()
    await pickEl.click()
    const card = page.locator('.wx-card')
    await expect(card).toBeVisible()
    await expect(card.locator('.wx-card-body h3').first()).toHaveText(name)
    // The flight to the building, the picture's move beside the card and the label pass after it.
    await settle(page, 'long card')
    const boxes = await page.evaluate((name) => {
      const box = (el: Element | null): { left: number; top: number; right: number; bottom: number } | null => {
        if (!el || (el as HTMLElement).hidden || getComputedStyle(el).display === 'none') return null
        const r = el.getBoundingClientRect()
        return r.width > 0 && r.height > 0 ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom } : null
      }
      const stage = document.querySelector('.wx-stage') as HTMLElement
      const labels = Array.from(document.querySelectorAll('.lw-bldg')).filter((el) => el.textContent === name).map(box).filter((b) => b !== null)
      return { card: box(document.querySelector('.wx-card')), ask: box(document.querySelector('.wx-ask-host')), labels, stage: box(stage), low: parseFloat(getComputedStyle(stage).getPropertyValue('--wx-low')) }
    }, name)
    const { card: c, ask: a, labels, stage } = boxes
    expect(c && a && stage, 'the card, the Ask box and the stage are drawn').toBeTruthy()
    // A long card: it runs down to its cap above the toolbar's strip, or the case shows nothing.
    expect(c!.bottom, `the ${name} card runs to its cap (${show(c!)}, stage ${show(stage!)})`).toBeGreaterThan(stage!.bottom - boxes.low - 24)
    expect.soft(overlaps(c!, a!), `the card (${show(c!)}) and the Ask box (${show(a!)}) overlap`).toBe(false)
    expect(labels.length, `the framed building's name (${name}) is drawn`).toBeGreaterThan(0)
    for (const l of labels) {
      expect.soft(overlaps(l, c!), `${name}'s name (${show(l)}) under the card (${show(c!)})`).toBe(false)
      expect.soft(overlaps(l, a!), `${name}'s name (${show(l)}) under the Ask box (${show(a!)})`).toBe(false)
    }
    // The answer folded away under the question, leaving a button that says what it holds and that it is collapsed;
    // the focus went from the clicked result to the card.
    const more = page.locator('.wx-ask-more')
    await expect(page.locator('.wx-ask-results')).toBeHidden()
    await expect(more).toBeVisible()
    await expect(more).toHaveText(/^Show \d+ answers?$/)
    await expect(more).toHaveAttribute('aria-expanded', 'false')
    expect(await page.evaluate(() => document.activeElement?.classList.contains('wx-card') ?? false), 'the focus is on the card').toBe(true)
    await check(page, 'long card', CITY)
    await shoot(page, `export-keyword-longcard-${v.width}x${v.height}`)
    // Esc closes the card: the answer comes back, and the focus goes back to the result that opened it.
    await page.keyboard.press('Escape')
    await expect(card).toBeHidden()
    await expect(pickEl).toBeVisible()
    await expect(more).toBeHidden()
    expect(await page.evaluate((id) => document.activeElement?.getAttribute('data-id') === id, LONG_ID), 'the focus is back on the result').toBe(true)
    await settle(page, 'card closed')
    await shoot(page, `export-keyword-longcard-closed-${v.width}x${v.height}`)
    // Opened again, folded again; the button brings the answer back with the card still open, focus on its first result.
    await pickEl.click()
    await expect(more).toBeVisible()
    await more.click()
    await expect(pickEl).toBeVisible()
    await expect(card).toBeVisible()
    expect(await page.evaluate(() => document.activeElement?.classList.contains('wx-ask-pick') ?? false), 'the focus is on a result').toBe(true)
    // The close button closes it, and the answer stays.
    await card.locator('.wx-card-close').click()
    await expect(card).toBeHidden()
    await expect(pickEl).toBeVisible()
  })
}
