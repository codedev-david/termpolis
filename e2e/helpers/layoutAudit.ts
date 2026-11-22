// The responsive layout audit the responsive specs run in the page (e2e/world-responsive.spec.ts for the app's
// Lumopolis pane, e2e/export-page/responsive.page.ts for the exported pages). It measures the DOM as a person
// would see it and returns what is wrong, as readable lines:
//   - overlaps:    two pieces of visible text (text runs, controls, the map's labels) whose boxes intersect by more
//                  than `tolerance` pixels across AND down;
//   - underPanels: visible text that intersects a panel it is not part of (a map label painted over the legend);
//   - clipped:     text cut off by an ancestor that hides overflow without scrolling, or running out of its own
//                  box, unless it is shortened on purpose (text-overflow: ellipsis) and carries its full text in a
//                  title or aria-label;
//   - crowded:     a district's name (bare text, no pill round it) side by side with another map label on one row,
//                  less than one and a half font sizes apart, so the two read as one phrase ("CORE SHRINKS WHAT
//                  CLAUDE SENDS");
//   - outside:     visible text outside the viewport (left and right; up and down too unless the page scrolls);
//   - scroll:      a horizontal scrollbar on the page or anywhere inside the root (a box that scrolls across, unless
//                  it matches `scrollX`: a wide table or figure that scrolls on purpose), or a panel wider inside
//                  than out without scrolling;
//   - small:       text under `minFont` CSS pixels (`captionFont` for elements matching `captions`), taking any CSS
//                  zoom, and an SVG drawn smaller or bigger than its viewBox, into account.
// A text field's text is measured by its content box (inside its padding), so an icon button sitting in that padding
// (a voice button at the end of a text box) is not an overlap. Text that a scrolling panel has scrolled out of sight
// is not on screen and is not audited. Labels faded below
// MIN_OPACITY are not on show. `fonts` is each visible text's font size in CSS pixels, for the big-screen check.
// The function is passed to page.evaluate: it must not reference anything outside itself.

export interface AuditOptions {
  /** Only text inside this element is audited (default: the whole body). */
  root?: string
  /** Panels text must stay out of unless it is inside them. */
  panels: string[]
  /** Elements whose text may be as small as captionFont (tiny legend captions). */
  captions?: string[]
  /** Elements not audited at all (decorative, or covered by a dialog). */
  ignore?: string[]
  minFont?: number
  captionFont?: number
  tolerance?: number
  /** The page itself scrolls up and down (a long document): text below the fold is fine. */
  verticalScroll?: boolean
  /** Boxes that may scroll across on purpose (a wide table or figure in its own scrolling frame). */
  scrollX?: string[]
  /**
   * Open menus that drop over the page on purpose (a toolbar's More menu). A control or text a menu covers, where
   * the menu is the one on top, is hidden while it is open, not overlapped; and the menu's own text, where it is on
   * top, is not under a panel. A map label it covers is still reported: labels keep off the panels, menus included.
   */
  popups?: string[]
}

export interface AuditResult {
  overlaps: string[]
  crowded: string[]
  underPanels: string[]
  clipped: string[]
  outside: string[]
  scroll: string[]
  small: string[]
  /** How many pieces of visible text were measured (a positive control: 0 means the audit saw nothing). */
  texts: number
  /** The font size of every visible text, CSS pixels, zoom and SVG scaling included. */
  fonts: number[]
}

export function layoutAudit(opts: AuditOptions): AuditResult {
  const MIN_OPACITY = 0.1
  const tol = opts.tolerance ?? 2
  const minFont = opts.minFont ?? 12
  const captionFont = opts.captionFont ?? 11
  const root = opts.root ? document.querySelector<HTMLElement>(opts.root) : document.body
  const out: AuditResult = { overlaps: [], crowded: [], underPanels: [], clipped: [], outside: [], scroll: [], small: [], texts: 0, fonts: [] }
  if (!root) {
    out.scroll.push(`no element for ${opts.root}`)
    return out
  }
  const vw = document.documentElement.clientWidth
  const vh = document.documentElement.clientHeight
  const matches = (el: Element, sels: string[] | undefined): boolean => !!sels && sels.some((s) => el.closest(s) !== null)
  // An element's effective CSS zoom: currentCSSZoom where the browser has it, else the product of every
  // ancestor's own zoom (Electron's Chromium has no currentCSSZoom, and its font sizes are the unzoomed ones).
  interface Rect { left: number; top: number; right: number; bottom: number }
  const zooms = new Map<Element, number>()
  const zoomOf = (el: Element): number => {
    const own = (el as unknown as { currentCSSZoom?: number }).currentCSSZoom
    if (typeof own === 'number') return own
    const known = zooms.get(el)
    if (known !== undefined) return known
    const z = parseFloat(getComputedStyle(el).zoom)
    const total = (z > 0 ? z : 1) * (el.parentElement ? zoomOf(el.parentElement) : 1)
    zooms.set(el, total)
    return total
  }
  // A Chromium before standard CSS zoom (128) measures a zoomed box, and everything in it, in that box's own
  // pixels: its boxes are scaled back to the page's here.
  const legacyZoom = !('currentCSSZoom' in document.documentElement)
  const onScreen = (r: { left: number; top: number; right: number; bottom: number; width: number; height: number }, el: Element): Rect => {
    const z = legacyZoom ? zoomOf(el) : 1
    return { left: r.left * z, top: r.top * z, right: r.right * z, bottom: r.bottom * z }
  }
  const rectOf = (el: Element): Rect => onScreen(el.getBoundingClientRect(), el)
  const shown = (el: Element): boolean => {
    let opacity = 1
    for (let e: Element | null = el; e; e = e.parentElement) {
      const cs = getComputedStyle(e)
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse' || cs.contentVisibility === 'hidden') return false
      opacity *= Number(cs.opacity)
    }
    return opacity >= MIN_OPACITY
  }
  const describe = (el: Element, text: string): string => {
    const id = el.getAttribute('data-testid') || el.getAttribute('data-control') || ''
    const cls = typeof el.className === 'string' && el.className.trim() !== '' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : ''
    const t = text.replace(/\s+/g, ' ').trim()
    return `${el.tagName.toLowerCase()}${cls}${id ? `[${id}]` : ''} "${t.length > 40 ? t.slice(0, 39) + '…' : t}"`
  }
  const box = (r: { left: number; top: number; right: number; bottom: number }): string => `${Math.round(r.left)},${Math.round(r.top)}-${Math.round(r.right)},${Math.round(r.bottom)}`
  interface Item { el: Element; label: string; r: Rect; label3d: boolean; font: number }

  const CONTROL = 'button, select, input:not([type=checkbox]):not([type=radio]):not([type=hidden]), textarea, [role="button"], [role="switch"]'
  const items: Item[] = []
  const seen = new Set<Element>()

  /** The box once every scrolling ancestor has cut it to what it shows; null when scrolled out of sight. Records clipping by non-scrolling ancestors. */
  const visibleRect = (el: Element, r: Rect, label: string): Rect | null => {
    // Copied field by field: a DOMRect keeps its sides on its prototype, so a spread would copy none of them.
    let v: Rect = { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
    const ellipsis = (e: Element): boolean => getComputedStyle(e).textOverflow === 'ellipsis' && !!(e.closest('[title]')?.getAttribute('title') || e.getAttribute('aria-label'))
    for (let a: Element | null = el; a && a !== document.documentElement; a = a.parentElement) {
      const cs = getComputedStyle(a)
      const ox = cs.overflowX
      const oy = cs.overflowY
      if (ox === 'visible' && oy === 'visible') continue
      const ar = rectOf(a)
      const z = zoomOf(a)
      // The padding box: the border box less the borders (client box), where content is cut.
      const left = ar.left + a.clientLeft * z
      const top = ar.top + a.clientTop * z
      const clip: Rect = { left, top, right: left + a.clientWidth * z, bottom: top + a.clientHeight * z }
      const scrollsX = ox === 'auto' || ox === 'scroll'
      const scrollsY = oy === 'auto' || oy === 'scroll'
      const cutX = !scrollsX && ox !== 'visible' && (v.left < clip.left - tol || v.right > clip.right + tol)
      const cutY = !scrollsY && oy !== 'visible' && (v.top < clip.top - tol || v.bottom > clip.bottom + tol)
      if ((cutX || cutY) && !ellipsis(a) && !ellipsis(el)) {
        // Fully outside a non-scrolling box is hidden on purpose (an off-stage label, a closed drawer), not cut.
        const inside = v.right > clip.left && v.left < clip.right && v.bottom > clip.top && v.top < clip.bottom
        if (inside) out.clipped.push(`${label} ${box(v)} cut by ${describe(a, '')} ${box(clip)}`)
        else return null
      }
      if (scrollsX || ox !== 'visible') v = { ...v, left: Math.max(v.left, clip.left), right: Math.min(v.right, clip.right) }
      if (scrollsY || oy !== 'visible') v = { ...v, top: Math.max(v.top, clip.top), bottom: Math.min(v.bottom, clip.bottom) }
      if (v.right - v.left <= 0.5 || v.bottom - v.top <= 0.5) return null
    }
    return v
  }

  // The size a text shows at, CSS pixels: its font size times any CSS zoom, and inside an SVG times the SVG's own
  // scale (its box on screen over its viewBox, the smaller of across and down as preserveAspectRatio "meet" draws
  // it): a 12px map label in an SVG drawn at half its natural width shows at 6px. The SVG's box is measured on
  // screen, so the zoom is already in it.
  const fontOf = (el: Element): number => {
    const size = parseFloat(getComputedStyle(el).fontSize)
    const svg = el instanceof SVGElement ? (el instanceof SVGSVGElement ? el : el.ownerSVGElement) : null
    const vb = svg ? svg.viewBox.baseVal : null
    if (svg && vb && vb.width > 0 && vb.height > 0) {
      const r = rectOf(svg)
      return size * Math.min((r.right - r.left) / vb.width, (r.bottom - r.top) / vb.height)
    }
    return size * zoomOf(el)
  }
  const add = (el: Element, text: string, r: Rect, label3d: boolean): void => {
    if (r.right - r.left < 0.5 || r.bottom - r.top < 0.5) return
    const label = describe(el, text)
    const v = visibleRect(el, r, label)
    if (!v) return
    const px = fontOf(el)
    items.push({ el, label, r: v, label3d, font: px })
    out.fonts.push(px)
    const least = matches(el, opts.captions) ? captionFont : minFont
    if (px < least - 0.01) out.small.push(`${label} ${px.toFixed(1)}px < ${least}px`)
  }

  // The map's labels and the controls are measured whole (a label's pill, a button's box); other text by its runs.
  for (const el of Array.from(root.querySelectorAll<HTMLElement>(`.lw-labels > *, ${CONTROL}`))) {
    if (matches(el, opts.ignore) || !shown(el)) continue
    const text = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value || el.placeholder : el instanceof HTMLSelectElement ? el.selectedOptions[0]?.textContent ?? '' : el.textContent ?? ''
    if (text.trim() === '' && !(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
      // An icon-only button still takes room: it is checked against text, but has no font to check.
      const r = rectOf(el)
      if (r.right > r.left && r.bottom > r.top && !el.closest('.lw-labels')) {
        const v = visibleRect(el, r, describe(el, el.getAttribute('aria-label') || '(icon)'))
        if (v) items.push({ el, label: describe(el, el.getAttribute('aria-label') || '(icon)'), r: v, label3d: false, font: 0 })
      }
      seen.add(el)
      continue
    }
    seen.add(el)
    let r: Rect = rectOf(el)
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      // The text of a field is inside its padding and borders.
      const cs = getComputedStyle(el)
      const z = zoomOf(el)
      const side = (k: string): number => (parseFloat(cs.getPropertyValue(`padding-${k}`)) + parseFloat(cs.getPropertyValue(`border-${k}-width`))) * z
      r = { left: r.left + side('left'), top: r.top + side('top'), right: r.right - side('right'), bottom: r.bottom - side('bottom') }
    }
    add(el, text, r, el.closest('.lw-labels') !== null)
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const range = document.createRange()
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n.textContent ?? ''
    if (t.trim() === '') continue
    const el = n.parentElement
    if (!el || el.closest('script, style, noscript, template, option, title, svg title') || matches(el, opts.ignore)) continue
    let owned = false
    for (const s of seen) if (s.contains(el)) { owned = true; break }
    if (owned || !shown(el)) continue
    range.selectNodeContents(n)
    const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0.5 && r.height > 0.5)
    for (const r of rects) add(el, t, onScreen(r, el), false)
  }
  out.texts = items.length

  // What the open menus cover, and which of their text is on top (the menu is what a click there would reach).
  const popups = (opts.popups ?? []).flatMap((s) => Array.from(root.querySelectorAll<HTMLElement>(s))).filter((p) => shown(p))
  const popupAt = (x: number, y: number): HTMLElement | null => {
    const hit = document.elementFromPoint(x, y)
    return hit ? popups.find((p) => p.contains(hit)) ?? null : null
  }
  const covered = new Set<Item>()
  const onTop = new Set<Item>()
  for (const it of items) {
    const own = popups.find((p) => p.contains(it.el))
    if (own) {
      if (popupAt((it.r.left + it.r.right) / 2, (it.r.top + it.r.bottom) / 2) === own) onTop.add(it)
      continue
    }
    if (it.label3d) continue
    for (const p of popups) {
      const pr = rectOf(p)
      const l = Math.max(it.r.left, pr.left)
      const r = Math.min(it.r.right, pr.right)
      const t = Math.max(it.r.top, pr.top)
      const b = Math.min(it.r.bottom, pr.bottom)
      if (r - l > tol && b - t > tol && popupAt((l + r) / 2, (t + b) / 2) === p) { covered.add(it); break }
    }
  }

  for (let i = 0; i < items.length; i++) {
    const a = items[i]
    const ra = a.r
    if (ra.left < -tol || ra.right > vw + tol || (!opts.verticalScroll && (ra.top < -tol || ra.bottom > vh + tol))) out.outside.push(`${a.label} ${box(ra)} viewport ${vw}x${vh}`)
    for (let j = i + 1; j < items.length; j++) {
      const b = items[j]
      if (a.el === b.el || a.el.contains(b.el) || b.el.contains(a.el)) continue
      if (covered.has(a) || covered.has(b)) continue
      const rb = b.r
      const x = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left)
      const y = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top)
      if (x > tol && y > tol) out.overlaps.push(`${a.label} ${box(ra)} / ${b.label} ${box(rb)}`)
      else if (a.label3d && b.label3d && (a.el.matches('.lw-district') || b.el.matches('.lw-district')) && y > 0.5 * Math.min(ra.bottom - ra.top, rb.bottom - rb.top) && -x < 1.5 * Math.max(a.font, b.font)) {
        out.crowded.push(`${a.label} ${box(ra)} / ${b.label} ${box(rb)} ${Math.round(-x)}px apart`)
      }
    }
  }

  const panels = opts.panels.flatMap((s) => Array.from(root.querySelectorAll<HTMLElement>(s))).filter((p) => shown(p))
  for (const p of panels) {
    const pr = rectOf(p)
    if (pr.right - pr.left < 1 || pr.bottom - pr.top < 1) continue
    const name = describe(p, p.getAttribute('aria-label') || '')
    for (const it of items) {
      if (p.contains(it.el) || it.el.contains(p) || covered.has(it) || onTop.has(it)) continue
      // Text inside another panel that this one is inside (a menu in the toolbar) is that panel's business.
      const x = Math.min(it.r.right, pr.right) - Math.max(it.r.left, pr.left)
      const y = Math.min(it.r.bottom, pr.bottom) - Math.max(it.r.top, pr.top)
      if (x > tol && y > tol) out.underPanels.push(`${it.label} ${box(it.r)} / panel ${name} ${box(pr)}`)
    }
    const cs = getComputedStyle(p)
    if (cs.overflowX !== 'auto' && cs.overflowX !== 'scroll' && p.scrollWidth > p.clientWidth + 1) out.scroll.push(`panel ${name} is ${p.scrollWidth}px wide inside, ${p.clientWidth}px out`)
  }
  // Anything inside the root that scrolls across: text running past a narrow pane, hidden behind a scrollbar.
  for (const el of [root, ...Array.from(root.querySelectorAll<HTMLElement>('*'))]) {
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) continue
    const cs = getComputedStyle(el)
    if (cs.overflowX !== 'auto' && cs.overflowX !== 'scroll') continue
    if (el.scrollWidth <= el.clientWidth + 1 || matches(el, opts.scrollX) || !shown(el)) continue
    out.scroll.push(`${describe(el, el.getAttribute('aria-label') || '')} scrolls across: ${el.scrollWidth}px inside, ${el.clientWidth}px out`)
  }
  const doc = document.scrollingElement ?? document.documentElement
  if (doc.scrollWidth > doc.clientWidth + 1) out.scroll.push(`the page scrolls across: ${doc.scrollWidth}px in a ${doc.clientWidth}px window`)
  if (!opts.verticalScroll && doc.scrollHeight > doc.clientHeight + 1) out.scroll.push(`the page scrolls down: ${doc.scrollHeight}px in a ${doc.clientHeight}px window`)
  return out
}

/** The viewports every responsive spec covers: CSS size and device pixel ratio. */
export interface Viewport { name: string; width: number; height: number; dpr: number }
export const VIEWPORTS: Viewport[] = [
  { name: '768x1024', width: 768, height: 1024, dpr: 1 },
  { name: '1024x768', width: 1024, height: 768, dpr: 1 },
  { name: '1280x800', width: 1280, height: 800, dpr: 1 },
  { name: '1280x800@2x', width: 1280, height: 800, dpr: 2 },
  { name: '1366x768', width: 1366, height: 768, dpr: 1 },
  // A MacBook's screen: 2880x1800 device pixels at 200%, 1440x900 CSS pixels.
  { name: '1440x900@2x', width: 1440, height: 900, dpr: 2 },
  { name: '1920x1080', width: 1920, height: 1080, dpr: 1 },
  { name: '2560x1440', width: 2560, height: 1440, dpr: 1 },
  { name: '3440x1440', width: 3440, height: 1440, dpr: 1 },
  // A 4K screen at 200% scaling: 3840x2160 device pixels, 1920x1080 CSS pixels.
  { name: '3840x2160@2x', width: 1920, height: 1080, dpr: 2 },
  { name: '3840x2160', width: 3840, height: 2160, dpr: 1 },
  { name: '5120x2880', width: 5120, height: 2880, dpr: 1 },
]

/** The sizes the blocking runs check: a tablet, a small laptop, 1080p and a 4K monitor at DPR 1. */
export const BLOCKING_VIEWPORTS = ['768x1024', '1366x768', '1920x1080', '3840x2160']
/** The size a reduced run checks (RESPONSIVE_REDUCED=1, the macOS CI job): a MacBook's screen at DPR 2. */
export const REDUCED_VIEWPORTS = ['1440x900@2x']

/**
 * The viewports a responsive spec runs: those RESPONSIVE_ONLY names (comma separated, to look again at one size),
 * else all of VIEWPORTS with RESPONSIVE_FULL=1 (the full matrix at DPR 1 and 2, run by hand), else REDUCED_VIEWPORTS
 * with RESPONSIVE_REDUCED=1, else BLOCKING_VIEWPORTS.
 */
export function responsiveViewports(env: Record<string, string | undefined> = process.env): Viewport[] {
  const only = (env.RESPONSIVE_ONLY ?? '').split(',').map((n) => n.trim()).filter(Boolean)
  if (only.length > 0) return VIEWPORTS.filter((v) => only.includes(v.name))
  if (env.RESPONSIVE_FULL === '1') return VIEWPORTS
  if (env.RESPONSIVE_REDUCED === '1') return VIEWPORTS.filter((v) => REDUCED_VIEWPORTS.includes(v.name))
  return VIEWPORTS.filter((v) => BLOCKING_VIEWPORTS.includes(v.name))
}

/** The problems of an audit as one list, each line prefixed by its kind. */
export function auditProblems(r: AuditResult): string[] {
  return [
    ...r.overlaps.map((s) => `overlap: ${s}`),
    ...r.crowded.map((s) => `crowded: ${s}`),
    ...r.underPanels.map((s) => `under a panel: ${s}`),
    ...r.clipped.map((s) => `clipped: ${s}`),
    ...r.outside.map((s) => `outside: ${s}`),
    ...r.scroll.map((s) => `scroll: ${s}`),
    ...r.small.map((s) => `too small: ${s}`),
  ]
}

/** The median of the fonts measured (0 for none). */
export function medianFont(r: AuditResult): number {
  if (r.fonts.length === 0) return 0
  const s = [...r.fonts].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

/**
 * A fingerprint of where everything under `root` (a selector; the body when null) is drawn, and of its text. Runs in
 * the page: equal fingerprints across a few samples mean the layout has settled (the label pass, the camera's move, a
 * streaming answer).
 */
export async function layoutSignature(root: string | null): Promise<string> {
  // Two frames first (a second at most, should the page not be drawing), so every sample follows a drawn frame: a page
  // that has yet to draw since a resize does not read as settled.
  await new Promise<void>((resolve) => {
    const done = setTimeout(resolve, 1000)
    requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(done); resolve() }))
  })
  const top = root ? document.querySelector(root) : document.body
  if (!top) return 'none'
  let h = 0
  const add = (n: number): void => {
    h = (h * 31 + Math.round(n)) | 0
  }
  const all = Array.from(top.querySelectorAll('*'))
  add(all.length)
  for (const e of all) {
    const r = e.getBoundingClientRect()
    add(r.left)
    add(r.top)
    add(r.width)
    add(r.height)
  }
  add((top.textContent ?? '').length)
  return String(h)
}

/**
 * What still moves under `root`: the elements whose box changed between two looks a drawn frame and 250 ms apart,
 * named by tag, test id or class (up to 8), for the message of a page that never settled.
 */
export async function movers(root: string | null): Promise<string[]> {
  const look = async (): Promise<Map<Element, string>> => {
    await new Promise<void>((resolve) => {
      const done = setTimeout(resolve, 1000)
      requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(done); resolve() }))
    })
    const top = root ? document.querySelector(root) : document.body
    const m = new Map<Element, string>()
    for (const e of top ? Array.from(top.querySelectorAll('*')) : []) {
      const r = e.getBoundingClientRect()
      m.set(e, `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`)
    }
    return m
  }
  const a = await look()
  const texts = new Map<Element, number>()
  a.forEach((_box, e) => { if (e.childElementCount === 0) texts.set(e, (e.textContent ?? '').length) })
  await new Promise((resolve) => setTimeout(resolve, 250))
  const b = await look()
  const name = (e: Element): string => {
    const id = e.getAttribute('data-testid')
    const cls = typeof e.className === 'string' ? e.className.split(/\s+/).filter(Boolean).slice(0, 2).join('.') : ''
    return `${e.tagName.toLowerCase()}${id ? `[${id}]` : cls ? `.${cls}` : ''} "${(e.textContent ?? '').trim().slice(0, 24)}"`
  }
  const out: string[] = []
  b.forEach((now, e) => {
    const was = a.get(e)
    if (out.length < 8 && was !== now) out.push(`${name(e)} ${was ?? 'new'} -> ${now}`)
  })
  // The signature also counts the elements and the text, so a removed element or a text that changed length without
  // moving is named too.
  a.forEach((was, e) => {
    if (out.length < 8 && !b.has(e)) out.push(`${name(e)} ${was} -> gone`)
  })
  b.forEach((_now, e) => {
    const before = texts.get(e)
    const after = e.childElementCount === 0 ? (e.textContent ?? '').length : before
    if (out.length < 8 && before !== undefined && after !== before) out.push(`${name(e)} text ${before} -> ${after} chars`)
  })
  return out
}

/** The page's own evaluate, so this file needs nothing from Playwright. */
interface Evaluates { evaluate<R, A>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R> }

/** What `movers` names over up to four pairs of looks, for a page that moves now and then rather than all the time. */
export async function stillMoving(page: Evaluates, root: string | null = null): Promise<string> {
  for (let i = 0; i < 4; i++) {
    const found = await page.evaluate(movers, root)
    if (found.length > 0) return found.join('; ')
  }
  return 'nothing in four pairs of looks'
}

/** The share of a test's time left that one settle may wait: a page that never settles fails that settle (softly)
 *  and still leaves the test the time to walk its other states. */
export const SETTLE_SHARE = 0.25
/**
 * How long one settle may wait: `want` (already scaled for a slow window), but no more than SETTLE_SHARE of what a
 * `timeout` ms test started at `startedAt` has left, and at least a second. With no test timeout (0), `want`.
 */
export function settleBudget(want: number, timeout: number, startedAt: number, now = Date.now()): number {
  if (!(timeout > 0)) return want
  return Math.max(1_000, Math.min(want, (timeout - (now - startedAt)) * SETTLE_SHARE))
}

/**
 * Waits, instead of a fixed time, until the layout under `root` has stayed the same for STEADY_SAMPLES samples
 * STEADY_EVERY_MS apart; false when it was still moving after `timeout` ms. `log`, when given, gets each sample's time
 * and whether it moved, and what was moving at the third sample that moved.
 */
const STEADY_EVERY_MS = 250
const STEADY_SAMPLES = 4
export async function steady(page: Evaluates, root: string | null = null, timeout = 15_000, log?: string[]): Promise<boolean> {
  const start = Date.now()
  const end = start + timeout
  let last = await page.evaluate(layoutSignature, root)
  let same = 0
  while (Date.now() < end) {
    await new Promise((resolve) => setTimeout(resolve, STEADY_EVERY_MS))
    const now = await page.evaluate(layoutSignature, root)
    log?.push(`${Date.now() - start}ms ${now === last ? 'same' : 'moved'}`)
    if (log && now !== last && log.length === 3) log.push(`moving then: ${(await page.evaluate(movers, root)).join('; ') || 'nothing'}`)
    same = now === last ? same + 1 : 0
    if (same >= STEADY_SAMPLES - 1) return true
    last = now
  }
  return false
}
