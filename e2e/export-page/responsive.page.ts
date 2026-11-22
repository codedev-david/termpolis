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
import fs from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { askReady, cityClip, expect, test } from './helpers'
import { DOCUMENT_HTML, KEYWORD_HTML, SMART_HTML } from './paths'
import { auditProblems, layoutAudit, medianFont, responsiveViewports, steady, type AuditOptions, type Viewport } from '../helpers/layoutAudit'
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

async function setViewport(page: Page, v: Viewport): Promise<void> {
  // The session stays attached: Chromium drops a session's emulation when it detaches. It closes with the page.
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: v.width, height: v.height, deviceScaleFactor: v.dpr, mobile: false })
  // Within a pixel: the window's own display scaling leaves a rounding pixel under emulation.
  await expect.poll(() => page.evaluate(({ w, h, d }) => Math.abs(innerWidth - w) <= 1 && Math.abs(innerHeight - h) <= 1 && Math.abs(devicePixelRatio - d) < 0.01 ? 'ok' : `${innerWidth}x${innerHeight}@${devicePixelRatio}`, { w: v.width, h: v.height, d: v.dpr }), { timeout: 10_000 }).toBe('ok')
}

/** Waits until the page has settled (the city's frames, the label pass after a resize, the camera's moves): until its
 *  layout stops changing, not for a fixed time. A page still moving after 15 s is a soft failure. */
async function settle(page: Page, state: string): Promise<void> {
  expect.soft(await steady(page), `${state}: the page settled`).toBe(true)
}

async function shoot(page: Page, name: string, fullPage = false): Promise<void> {
  fs.mkdirSync(SHOTS, { recursive: true })
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage })
}

/** Audits the page as it is now; records every problem as a soft failure under `state`, and returns the median font. */
async function check(page: Page, state: string, opts: AuditOptions): Promise<number> {
  const r = await page.evaluate(layoutAudit, opts)
  expect.soft(r.texts, `${state}: the audit measured no text`).toBeGreaterThan(0)
  expect.soft(auditProblems(r), state).toEqual([])
  return medianFont(r)
}

async function openCard(page: Page): Promise<boolean> {
  const card = page.locator('.wx-card')
  const clip = await cityClip(page)
  for (let row = 1; row <= 6; row++) {
    for (let col = 1; col <= 8; col++) {
      await page.mouse.click(clip.x + (clip.width * col) / 9, clip.y + (clip.height * row) / 7)
      // The card opens on the click itself (the page picks on the same frame), so a short look is enough.
      if (await card.waitFor({ state: 'visible', timeout: 250 }).then(() => true, () => false)) return true
    }
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
