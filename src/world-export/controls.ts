// The exported page around the city: a slim header, the controls (theme, layers, the proposal picker, tours, the
// 2D switch, reset view), the legend and the card panel showing the engine's own read-only card HTML. Plain DOM,
// no React. The page is read-only: there is no annotate, Build it, Re-layout, bookmark or editing control, the
// cards are rendered with readOnly (no Confirm or Edit, evidence as plain text), and nothing is stored in the
// browser. A technology chip (data-tech) only opens that term's glossary card, itself read-only.
import { buildingCard, DEFAULT_LAYERS, edgeCard, escapeHtml as esc, renderFallback, techCard, THEMES, usesTech, type WorldViewer } from '../renderer/src/world/engine'
import type { ThemeName } from '../renderer/src/world/engine'
import { freeArea } from '../renderer/src/world/engine/viewMath'
import type { AskKind } from '../shared/world/askIndex'
import { REMOVALS_ID } from '../shared/world/designPatch'
import type { PageMeta } from '../shared/world/exportMeta'
import { uiScale } from '../shared/world/uiScale'
import type { Tour, WorldDoc } from '../shared/world/types'

export const MADE_WITH_URL = 'https://termpolis.com'

/**
 * "<Project>, exported from Termpolis on <date> · commit <head7>", and " (uncommitted changes)" when the tree was
 * dirty. A world with no commit (a design, a folder without git) has no commit part at all, dirty flag included.
 */
export function headerText(meta: PageMeta): string {
  const at = `${meta.project}, exported from Termpolis on ${meta.exportedOn}`
  return meta.head7 === '' ? at : `${at} · commit ${meta.head7}${meta.dirty ? ' (uncommitted changes)' : ''}`
}

/** The engine's themes, named for the picker ("neon" shows as "Neon"). The viewer starts on neon. */
const themeOptions = (): Array<[string, string]> => Object.keys(THEMES).map((t): [string, string] => [t, t.charAt(0).toUpperCase() + t.slice(1)])
const FIRST_THEME: ThemeName = 'neon'
/** The page's type size at scale 1 (a 1080p laptop): 1rem. A big screen scales the root (uiScale), so all of it grows. */
const BASE_PX = 13
/** `px` at scale 1, in rem: every length on the page but its hairline borders grows with the root. */
const r = (px: number): string => `${+(px / BASE_PX).toFixed(4)}rem`
const CARD_INSET = 12
const CARD_WIDTH = 340
const ASK_WIDTH = 320
/** From this width (CSS px at scale 1) the Ask box keeps its strip on the right out of the city's framing. */
const WIDE_PX = 732
/** From this size (CSS px at scale 1) the legend opens with the page; on a smaller screen it starts as its chip, out of the map's way. */
const LEGEND_OPEN_W = 1200
const LEGEND_OPEN_H = 720
/** Room (CSS px at scale 1) the Ask box always leaves the legend's chip between it and the toolbar. */
const LEGEND_CHIP_ROOM = 48
const LEGEND_MAX_CARGO = 10

/**
 * One stylesheet for the whole page (the CSP allows inline styles, never a stylesheet from elsewhere). Lengths are in
 * rem, so the page scales with its root (BASE_PX times uiScale, set as the window changes size); --wx-low (the
 * toolbar's strip) and --wx-top (where the Ask box ends) follow the panels as they change size. Nothing readable is
 * under 12px at scale 1. The 2D map scrolls above the toolbar's strip (an opaque bottom border), so none of its text
 * passes under the toolbar.
 */
export const PAGE_CSS = `
html{font-size:${BASE_PX}px}
.wx-page{position:fixed;inset:0;display:flex;flex-direction:column;background:#03050a;color:#e2e8f0;font:1rem/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
.wx-page [hidden]{display:none!important}
.wx-header{display:flex;flex-wrap:wrap;gap:${r(4)} ${r(16)};align-items:center;justify-content:space-between;padding:${r(6)} ${r(14)};font-size:${r(12)};color:#94a3b8;border-bottom:1px solid rgba(148,163,184,.18)}
.wx-header a{color:#7dd3fc}
.wx-stage{position:relative;flex:1 1 auto;min-height:0;overflow:hidden;--wx-low:${r(56)};--wx-top:${r(CARD_INSET + 48)}}
.wx-view{position:absolute;inset:0;z-index:0}
.wx-map2d{position:absolute;inset:0;box-sizing:border-box;overflow:auto;padding:${r(12)} ${r(16)};border-bottom:var(--wx-low) solid #0b1220;background:#0b1220}
.wx-map2d [data-kind]{cursor:pointer}
.wx-map2d ul{padding-left:${r(18)}}
.wx-panel{background:rgba(8,12,22,.82);backdrop-filter:blur(10px);border:1px solid rgba(148,163,184,.18);border-radius:${r(12)};color:#e2e8f0}
.wx-card{position:absolute;top:${r(CARD_INSET)};left:${r(CARD_INSET)};width:${r(CARD_WIDTH)};max-width:calc(100% - ${r(CARD_INSET * 2)});max-height:calc(100% - var(--wx-low) - ${r(CARD_INSET)});display:flex;flex-direction:column;box-sizing:border-box;padding:${r(12)} ${r(6)} ${r(12)} ${r(14)};z-index:3}
.wx-card-close{position:absolute;top:${r(8)};right:calc(${r(10)} + var(--wx-card-gutter, 0px));padding:${r(2)} ${r(7)};border:0;border-radius:${r(6)};background:transparent;color:#94a3b8;font:inherit;font-size:${r(16)};line-height:1.2;cursor:pointer}
.wx-card-body{overflow-y:auto;min-height:0;padding-right:${r(8)};overflow-wrap:anywhere;scrollbar-width:thin;scrollbar-color:rgba(125,211,252,.55) rgba(148,163,184,.12)}
.wx-card-body h3{margin:0 0 ${r(4)};padding-right:${r(26)};font-size:${r(16)};font-weight:600;color:#f1f5f9}
.wx-card-body h4{margin:${r(12)} 0 ${r(4)};font-size:${r(12)};font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:#7dd3fc}
.wx-card-body p{margin:${r(4)} 0}
.wx-card-body ul{margin:${r(2)} 0;padding-left:${r(16)}}
.wx-card-body ul.claims{list-style:none;padding-left:0}
.wx-card-body .muted{color:#94a3b8;font-size:${r(12)}}
.wx-card-body .proc{font-size:${r(12)};background:rgba(148,163,184,.1);border-radius:${r(6)};padding:${r(4)} ${r(8)};margin:${r(6)} 0}
.wx-card-body .tag,.wx-card-body .claim .state{display:inline-block;padding:${r(1)} ${r(8)};border-radius:99px;font-size:${r(12)};background:#334155;color:#cbd5e1;margin-right:${r(4)}}
.wx-card-body .status-verified,.wx-card-body .claim[data-state=verified] .state{background:#14532d;color:#4ade80}
.wx-card-body .status-built,.wx-card-body .claim[data-state=observed] .state{background:#1e3a5f;color:#7dd3fc}
.wx-card-body .status-gap,.wx-card-body .claim[data-state=inferred] .state{background:#451a03;color:#fbbf24}
.wx-card-body .status-proposed{background:#1e293b;color:#93c5fd}
.wx-card-body .chip{display:inline-block;margin:${r(2)} ${r(3)} ${r(2)} 0;padding:${r(2)} ${r(8)};border-radius:99px;font-size:${r(12)};background:rgba(167,139,250,.14);border:1px solid rgba(167,139,250,.45);color:#ede9fe}
.wx-card-body .chip[data-tech]{cursor:pointer}
.wx-card-body .cargo{display:inline-block;width:${r(10)};height:${r(10)};border-radius:${r(2)};margin-right:${r(6)}}
.wx-card-body a{color:#7dd3fc;cursor:pointer;text-decoration:underline dotted}
.wx-card-body .ev-ref{font-family:ui-monospace,monospace;font-size:${r(12)};color:#94a3b8}
.wx-ask-host{position:absolute;top:${r(CARD_INSET)};right:${r(CARD_INSET)};width:${r(ASK_WIDTH)};max-width:calc(100% - ${r(CARD_INSET * 2)});max-height:calc(100% - var(--wx-low) - ${r(CARD_INSET + LEGEND_CHIP_ROOM)});display:flex;flex-direction:column;box-sizing:border-box;z-index:4}
.wx-ask{display:flex;flex-direction:column;min-height:0;padding:${r(10)} ${r(12)}}
.wx-ask-input{width:100%;box-sizing:border-box;padding:${r(6)} ${r(10)};border-radius:${r(8)};border:1px solid rgba(148,163,184,.35);background:rgba(15,23,42,.9);color:#e2e8f0;font:inherit}
.wx-ask-status,.wx-ask-none{margin:${r(6)} 0 0;font-size:${r(12)};color:#fbbf24}
.wx-ask-none{color:#94a3b8}
.wx-ask-results{list-style:none;margin:${r(6)} 0 0;padding:0;min-height:0;overflow-y:auto}
.wx-ask-pick{display:block;width:100%;text-align:left;margin:${r(4)} 0;padding:${r(6)} ${r(8)};border-radius:${r(8)};border:1px solid rgba(148,163,184,.18);background:rgba(15,23,42,.6);color:inherit;font:inherit;cursor:pointer}
.wx-ask-head{display:flex;gap:${r(8)};align-items:baseline;justify-content:space-between}
.wx-ask-kind{flex:none;font-size:${r(12)};color:#7dd3fc}
.wx-ask-first{display:block;font-size:${r(12)};color:#94a3b8}
.wx-ask-caption{margin:${r(6)} 0 0;font-size:${r(12)};color:#94a3b8}
.wx-ask[data-folded] .wx-ask-results,.wx-ask[data-folded] .wx-ask-none,.wx-ask[data-folded] .wx-ask-caption{display:none}
.wx-ask-more{display:block;margin:${r(6)} 0 0;padding:${r(4)} ${r(10)};border-radius:${r(8)};border:1px solid rgba(125,211,252,.4);background:rgba(15,23,42,.6);color:#7dd3fc;font:inherit;font-size:${r(12)};cursor:pointer}
.wx-ask-more[hidden]{display:none}
.wx-toolbar{position:absolute;left:${r(CARD_INSET)};right:${r(CARD_INSET)};bottom:${r(CARD_INSET)};display:flex;flex-wrap:wrap;justify-content:space-between;gap:${r(6)} ${r(18)};align-items:center;padding:${r(6)} ${r(10)};z-index:2}
.wx-tools{display:flex;flex-wrap:wrap;gap:${r(6)} ${r(12)};align-items:center}
.wx-toolbar label{display:inline-flex;gap:${r(4)};align-items:center;font-size:${r(12)};white-space:nowrap}
.wx-toolbar input[type=checkbox]{width:${r(13)};height:${r(13)};margin:0}
.wx-toolbar button,.wx-toolbar select{padding:${r(2)} ${r(8)};border-radius:${r(6)};border:1px solid rgba(125,211,252,.4);background:transparent;color:#7dd3fc;font:inherit;font-size:${r(12)};white-space:nowrap;cursor:pointer}
.wx-toolbar select option{background:#0b1220;color:#e2e8f0}
.wx-legend{position:absolute;right:${r(CARD_INSET)};bottom:var(--wx-low);width:${r(220)};max-height:calc(100% - var(--wx-low) - var(--wx-top));overflow:auto;box-sizing:border-box;padding:${r(8)} ${r(12)};font-size:${r(12)};z-index:2}
.wx-legend-toggle{display:flex;width:100%;justify-content:space-between;background:none;border:0;padding:0;color:inherit;font:inherit;font-weight:600;cursor:pointer}
.wx-legend b{display:block;margin:${r(8)} 0 ${r(4)}}
.wx-legend .row{display:flex;gap:${r(8)};align-items:center;margin:${r(2)} 0;font-size:${r(12)};overflow-wrap:anywhere}
.wx-legend .row svg{width:${r(16)};height:${r(16)};flex:none}
.wx-legend .sw{width:${r(20)};height:${r(10)};border-radius:${r(3)};flex:none;box-sizing:border-box}
.wx-legend .muted{color:#94a3b8;margin:0 0 ${r(4)}}
`

/** A colour from the world doc, used only inside a style attribute: anything but a plain hex colour becomes grey. */
const safeColor = (c: string): string => (/^#[0-9a-f]{3,8}$/i.test(c) ? c : '#94a3b8')

const SHAPES: Record<'cube' | 'sphere' | 'octa' | 'tetra', string> = {
  cube: '<rect x="3" y="3" width="10" height="10"/>',
  sphere: '<circle cx="8" cy="8" r="6"/>',
  octa: '<polygon points="8,1 15,8 8,15 1,8"/>',
  tetra: '<polygon points="8,2 15,14 1,14"/>',
}

/** The legend's body, as the app's WorldLegend: the busiest cargo, what lines and buildings show, and the programs with processes on. */
export function legendHtml(doc: WorldDoc, processes: boolean): string {
  const count = new Map<string, number>()
  for (const e of doc.edges) count.set(e.cargo, (count.get(e.cargo) ?? 0) + 1)
  const ranked = Object.keys(doc.cargo).map((k, i) => ({ k, i, n: count.get(k) ?? 0 })).filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n || a.i - b.i).map((x) => x.k)
  const shown = ranked.slice(0, LEGEND_MAX_CARGO)
  const more = ranked.length - shown.length
  const row = (swatch: string, text: string): string => `<div class="row"><span class="sw" aria-hidden="true" style="${swatch}"></span><span>${esc(text)}</span></div>`
  let html = ''
  if (shown.length > 0) {
    html += '<b>What&#39;s moving on the lines</b>' + shown.map((k) => {
      const c = doc.cargo[k]
      return `<div class="row" data-cargo><svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="${safeColor(c.color)}">${SHAPES[c.shape] ?? SHAPES.cube}</svg><span>${esc(c.label)}</span></div>`
    }).join('')
    if (more > 0) html += `<p class="muted">+${more} more on fewer lines</p>`
  }
  html += '<b>Lines</b>'
    + row('height:4px;border-radius:2px;background:#94a3b8', 'Solid: a built connection')
    + row('height:0;border-radius:0;border-top:3px dashed #94a3b8', 'Dashed: planned, or a guess the code does not show')
    + row('height:6px;background:#94a3b8', 'Thicker: busier')
    + '<b>Buildings</b>'
    + row('border:2px solid #4ade80;border-radius:99px', 'Green ring: tests pass')
    + row('border:2px solid #fbbf24', 'Amber: no tests')
    + row('border:2px dashed #93c5fd', 'Wireframe: planned only')
    + row('background:radial-gradient(#cbd5e1aa, transparent 70%)', 'Fog: partly unknown')
  const used = new Set(doc.buildings.map((b) => b.process))
  const procs = Object.keys(doc.processes).filter((k) => used.has(k))
  if (processes && procs.length > 0) {
    html += '<b>What runs where</b><p class="muted">Each bubble is a separate program. If one stalls or crashes, the others keep running.</p>'
      + procs.map((k) => row(`border:1px dashed ${safeColor(doc.processes[k].color)}`, doc.processes[k].label)).join('')
  }
  return html
}

/** A tour as a card, for the 2D map (the 3D city plays it instead). */
const tourCard = (t: Tour): string =>
  `<h3>${esc(t.title)}</h3><ol>${t.steps.map((s) => `<li>${esc(s.caption)}</li>`).join('')}</ol>`

export interface Page {
  /** Where the Ask box goes. */
  askHost: HTMLElement
  /** Where the 3D viewer is created. */
  viewHost: HTMLElement
  /** The card panel: shows the engine's card HTML, or closes on null. It is the viewer's renderCard. */
  showCard(html: string | null): void
  /** Wires the controls to the viewer; null without WebGL (the page then shows the 2D map only). */
  attach(viewer: WorldViewer | null): void
  /** Opens what an Ask result names: a part's card, a term's card, or a tour. */
  pick(id: string, kind: AskKind): void
  /** The Ask box (AskBox): its answer folds away while it would cover the open card or the part the card frames. */
  setAsk(ask: PageAsk): void
}

/** What the page needs of the Ask box (AskBox) to fold its answer away for a card and bring it back. */
export interface PageAsk {
  fold(): boolean
  unfold(): void
  folded(): boolean
  withAnswer<T>(read: () => T): T
}

/** A panel's box in the stage, edge by edge (CSS px). */
interface Rect { l: number; t: number; r: number; b: number }
const rectOf = (e: HTMLElement): Rect => ({ l: e.offsetLeft, t: e.offsetTop, r: e.offsetLeft + e.offsetWidth, b: e.offsetTop + e.offsetHeight })
const meets = (a: Rect, b: Rect): boolean => a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b

const make = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag)
  e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

const checkbox = (label: string, layer: string, checked: boolean, onChange: (on: boolean) => void): HTMLLabelElement => {
  const l = make('label', 'wx-layer')
  const box = document.createElement('input')
  box.type = 'checkbox'
  box.checked = checked
  box.setAttribute('data-layer', layer)
  box.addEventListener('change', () => onChange(box.checked))
  l.append(box, document.createTextNode(label))
  return l
}

const select = (label: string, testId: string, options: Array<[string, string]>, value: string, onChange: (v: string) => void): HTMLLabelElement => {
  const l = make('label', 'wx-select')
  const s = document.createElement('select')
  s.setAttribute('data-control', testId)
  for (const [v, text] of options) {
    const o = document.createElement('option')
    o.value = v
    o.textContent = text
    s.appendChild(o)
  }
  s.value = value
  s.addEventListener('change', () => onChange(s.value))
  l.append(document.createTextNode(label), s)
  return l
}

const button = (text: string, control: string, onClick: () => void): HTMLButtonElement => {
  const b = make('button', 'wx-button', text)
  b.type = 'button'
  b.setAttribute('data-control', control)
  b.addEventListener('click', onClick)
  return b
}

/** Builds the page inside `parent`. The viewer comes later (attach), because it needs showCard as its renderCard. */
export function buildPage(parent: HTMLElement, doc: WorldDoc, meta: PageMeta): Page {
  const style = document.createElement('style')
  style.textContent = PAGE_CSS
  document.head.appendChild(style)

  const page = make('div', 'wx-page')
  const header = make('header', 'wx-header')
  const made = make('a', 'wx-made', 'Made with Lumopolis in Termpolis')
  made.href = MADE_WITH_URL
  made.target = '_blank'
  made.rel = 'noopener noreferrer'
  header.append(make('span', 'wx-title', headerText(meta)), made)

  const stage = make('div', 'wx-stage')
  const viewHost = make('div', 'wx-view')
  // Drawn when first shown (drawMap): a big world opening on the 3D city never builds a map nobody sees.
  const map2d = make('div', 'wx-map2d')
  map2d.hidden = true
  const card = make('aside', 'wx-card wx-panel')
  card.setAttribute('aria-label', 'Lumopolis details')
  card.hidden = true
  // Focusable from script: an Ask result folded away under the focus hands it to the card it opened.
  card.tabIndex = -1
  const close = make('button', 'wx-card-close', '×')
  close.type = 'button'
  close.setAttribute('aria-label', 'Close')
  const cardBody = make('div', 'wx-card-body')
  card.append(close, cardBody)
  const askHost = make('div', 'wx-ask-host wx-panel')
  const toolbar = make('div', 'wx-toolbar wx-panel')
  toolbar.setAttribute('aria-label', 'Lumopolis controls')
  const legend = make('section', 'wx-legend wx-panel')
  legend.setAttribute('aria-label', 'Lumopolis legend')
  stage.append(viewHost, map2d, card, askHost, legend, toolbar)
  page.append(header, stage)
  parent.appendChild(page)

  let viewer: WorldViewer | null = null
  let flat = true
  let processes = DEFAULT_LAYERS.processes
  const plan = doc.layers.plan
  const has = (id: string | undefined): id is string => id !== undefined && plan.some((p) => p.id === id)
  // A design world's export keeps its whole plan (the design is what it exports): it opens on the Removals
  // proposal, when the design removes parts, so they are drawn as removed. A proposal export opens on its one.
  const design = doc.projectKey.startsWith('design:')
  /** The plan both views show: the city's layers (planned, proposal), and the 2D map drawn from the same two. */
  const layers = { planned: DEFAULT_LAYERS.planned, proposal: has(meta.proposalId) ? meta.proposalId : design && has(REMOVALS_ID) ? REMOVALS_ID : null }
  /** The 2D map shows `layers` as they are now; false: it is drawn again before it is shown. */
  let mapDrawn = false
  const drawMap = (): void => {
    map2d.innerHTML = renderFallback(doc, meta.project, layers)
    mapDrawn = true
  }
  const setPlan = (change: Partial<typeof layers>): void => {
    Object.assign(layers, change)
    viewer?.setLayers(change)
    if (flat) drawMap()
    else mapDrawn = false
  }
  /** How much bigger than a laptop's the page draws, for this window (uiScale). */
  let scale = 1
  const sizeRoot = (): void => {
    scale = uiScale(window.innerWidth, window.innerHeight)
    document.documentElement.style.fontSize = `${BASE_PX * scale}px`
  }
  sizeRoot()
  // Open on a screen with room for the legend beside the city; a tablet or a small laptop gets its chip.
  let legendOpen = (parent.clientWidth || window.innerWidth) / scale >= LEGEND_OPEN_W && window.innerHeight / scale >= LEGEND_OPEN_H

  /**
   * Fits the page to the window: the root's size, the strips the panels take (--wx-low under the toolbar, --wx-top
   * under the Ask box), and the viewer's reserves, label size and the panels its labels keep out from under. Every
   * length is measured, so it holds whatever the scale and however the toolbar wraps.
   */
  /** The strip under the toolbar the city keeps clear of (CSS px). */
  const lowStrip = (): number => toolbar.offsetHeight + CARD_INSET * scale * 2
  /** The Ask box's strip on the right the city's framing keeps clear of: from WIDE_PX, 0 below it. */
  const askStrip = (): number => (stage.clientWidth >= WIDE_PX * scale ? askHost.offsetWidth + CARD_INSET * scale * 2 : 0)
  const layout = (): void => {
    sizeRoot()
    fitAnswer()
    const inset = CARD_INSET * scale
    const low = lowStrip()
    stage.style.setProperty('--wx-low', `${low}px`)
    stage.style.setProperty('--wx-top', `${askHost.offsetTop + askHost.offsetHeight + inset}px`)
    // A capped card's scrollbar takes the body's right edge: the close button moves left by its width (0 when overlaid or none).
    const gutter = cardBody.offsetWidth - cardBody.clientWidth
    if (gutter > 0) card.style.setProperty('--wx-card-gutter', `${gutter}px`)
    else card.style.removeProperty('--wx-card-gutter')
    if (!viewer) return
    viewer.setLabelScale(scale)
    // From WIDE_PX, not from three times the strip: between the two the Ask box still covers the right.
    viewer.setRightReserve(askStrip(), WIDE_PX * scale)
    viewer.setBottomReserve(low)
    viewer.setCardReserve(card.hidden ? 0 : card.offsetLeft + card.offsetWidth + inset, card.hidden ? 0 : card.offsetTop + card.offsetHeight + inset)
  }
  let ask: PageAsk | null = null
  /** The answer is folded for the open card; the user opened it again while that card is open. */
  let foldedForCard = false
  let userOpened = false
  /** What had the focus when the card opened, to hand it back when the card closes. */
  let opener: HTMLElement | null = null
  /** An Esc is closing the card: with nothing to hand the focus back to, the question gets it. */
  let escClosing = false
  /** A folded answer the user brought back (its button, the question, a new answer) stays open while this card is. */
  const noteUserOpen = (a: PageAsk): void => {
    if (foldedForCard && !a.folded()) { foldedForCard = false; userOpened = true }
  }
  /**
   * Whether the Ask answer, shown, would cover the open card, or in the 3D city the part of the view its part is
   * framed in (freeArea, as the viewer works it out from the same reserves). A short card leaves room below it, clear
   * of the answer; a long one on a page under about 830 px at scale 1 leaves the room beside it, under the answer.
   */
  const answerCovers = (a: PageAsk): boolean => {
    const box = a.withAnswer(() => rectOf(askHost))
    const c = rectOf(card)
    if (meets(box, c)) return true
    if (!viewer || flat) return false
    const inset = CARD_INSET * scale
    const w = stage.clientWidth
    const h = stage.clientHeight
    const f = freeArea(w, h, askStrip(), lowStrip(), [c.r + inset, c.b + inset], WIDE_PX * scale)
    return meets(box, { l: f.left, t: f.top, r: w - f.right, b: h - f.bottom })
  }
  /**
   * Folds the answer away while it would cover the open card or its framed part, and brings it back when it no longer
   * would: the card closed, or the window grew. The focus, if it was on a result, goes to the card.
   */
  const fitAnswer = (): void => {
    if (!ask) return
    noteUserOpen(ask)
    const want = !card.hidden && !userOpened && answerCovers(ask)
    if (want && !foldedForCard) {
      const onResult = askHost.contains(document.activeElement) && !(document.activeElement instanceof HTMLInputElement)
      foldedForCard = ask.fold()
      if (foldedForCard && onResult) card.focus({ preventScroll: true })
    } else if (!want && foldedForCard) {
      foldedForCard = false
      ask.unfold()
    }
  }
  /**
   * A closed card hands the focus it held back to what opened it, while that is still on the page and shown; after an
   * Esc with nothing to go back to, to the question. Focus somewhere else stays where it is.
   */
  const handFocusBack = (): void => {
    const at = document.activeElement as HTMLElement
    const back = opener
    opener = null
    if (!card.contains(at) && !(escClosing && at === document.body)) return
    const question = askHost.querySelector('input')
    if (back && back.isConnected && !back.closest('[hidden]')) back.focus({ preventScroll: true })
    else if (escClosing && question) question.focus({ preventScroll: true })
    else if (card.contains(at)) at.blur()
  }
  const showCard = (html: string | null): void => {
    const wasOpen = !card.hidden
    if (ask) noteUserOpen(ask)
    card.hidden = html === null || html === ''
    cardBody.innerHTML = card.hidden ? '' : (html as string)
    cardBody.scrollTop = 0
    if (!card.hidden) {
      userOpened = false
      if (!wasOpen) opener = document.activeElement === document.body ? null : (document.activeElement as HTMLElement)
    }
    layout()
    if (wasOpen && card.hidden) handFocusBack()
  }
  /** Closes the card; in 3D the camera also flies back to the overview (as the app's close and Esc do). */
  const closeCard = (): void => {
    showCard(null)
    if (viewer && !flat) viewer.resetView()
  }

  const drawLegend = (): void => {
    legend.textContent = ''
    const toggle = make('button', 'wx-legend-toggle')
    toggle.type = 'button'
    toggle.setAttribute('aria-expanded', String(legendOpen))
    toggle.append(make('span', '', 'Legend'), make('span', '', legendOpen ? '−' : '+'))
    toggle.addEventListener('click', () => { legendOpen = !legendOpen; drawLegend() })
    legend.appendChild(toggle)
    if (!legendOpen) return
    const body = make('div', 'wx-legend-body')
    body.innerHTML = legendHtml(doc, processes)
    legend.appendChild(body)
  }

  const openPart = (id: string): void => {
    if (viewer && !flat) { void viewer.apply({ type: 'openCard', id }); return }
    showCard(buildingCard(doc, id, 'none', { readOnly: true }) || edgeCard(doc, id, { readOnly: true }) || null)
  }
  const openTech = (term: string): void => {
    if (viewer && !flat) {
      void viewer.apply({ type: 'openCard', id: 'tech:' + term })
      void viewer.apply({ type: 'highlight', ids: usesTech(doc, term) })
      return
    }
    showCard(techCard(doc, term))
  }
  const playTour = (t: Tour): void => {
    if (viewer && !flat) { void viewer.play([{ type: 'tour', steps: t.steps }]); return }
    showCard(tourCard(t))
  }

  card.addEventListener('click', (e) => {
    const target = e.target as Element
    if (target.closest('.wx-card-close')) { closeCard(); return }
    const chip = target.closest('[data-tech]')
    if (chip) { e.preventDefault(); openTech(chip.getAttribute('data-tech') as string); return }
    const link = target.closest('[data-node],[data-edge]')
    if (!link) return
    e.preventDefault()
    openPart(link.getAttribute('data-node') ?? (link.getAttribute('data-edge') as string))
  })
  map2d.addEventListener('click', (e) => {
    const item = (e.target as Element).closest('[data-kind][data-id]')
    if (!item) return
    if (item.getAttribute('data-kind') === 'district') { showCard(null); return }
    openPart(item.getAttribute('data-id') as string)
  })
  // Esc outside the 3D view (the viewer handles its own while it has focus): close the card, back to the overview.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || viewHost.contains(e.target as Node)) return
    escClosing = true
    try { closeCard() } finally { escClosing = false }
  })

  const setFlat = (on: boolean): void => {
    flat = on
    if (on && !mapDrawn) drawMap()
    map2d.hidden = !on
    viewHost.hidden = on
    // A running tour stops with the city: a step waiting out its dwell would write its caption over the map.
    if (on) viewer?.cancelActions()
    viewer?.setPaused(on)
    showCard(null)
  }

  const attach = (v: WorldViewer | null): void => {
    viewer = v
    toolbar.textContent = ''
    // Two groups that wrap as wholes on a narrow screen: what is drawn (left), and what to do (right).
    const tools = make('div', 'wx-tools')
    const actions = make('div', 'wx-tools wx-actions')
    toolbar.append(tools, actions)
    if (v) {
      v.setLayers({ proposal: layers.proposal })
      // The controls start where the viewer's layers start (DEFAULT_LAYERS), so each shows what is drawn.
      tools.append(
        select('Theme', 'theme', themeOptions(), FIRST_THEME, (t) => v.setTheme(t as ThemeName)),
        select('Names', 'labels', [['jobs', 'What it does'], ['tech', 'Technology']], DEFAULT_LAYERS.labels, (l) => v.setLayers({ labels: l as 'jobs' | 'tech' })),
        checkbox('Processes', 'processes', DEFAULT_LAYERS.processes, (on) => { processes = on; v.setLayers({ processes: on }); drawLegend() }),
        checkbox('All line labels', 'allLineLabels', DEFAULT_LAYERS.allLineLabels, (on) => v.setLayers({ allLineLabels: on })),
      )
    }
    // The plan's controls work on the 2D map too, so a page without WebGL shows the proposal it was exported with.
    const planned = checkbox('Planned parts', 'planned', layers.planned, (on) => setPlan({ planned: on }))
    tools.appendChild(planned)
    // A proposal export and a design world with a plan have proposals to pick. Picking one draws the planned
    // parts again, so "Planned parts" is ticked to match.
    if (layers.proposal !== null || (design && plan.length > 0)) {
      const options: Array<[string, string]> = [['', design ? 'No proposal' : 'Built world only'], ...plan.map((p): [string, string] => [p.id, p.title])]
      tools.appendChild(select('Proposal', 'proposal', options, layers.proposal ?? '', (id) => {
        setPlan({ proposal: id === '' ? null : id, planned: true })
        ;(planned.firstChild as HTMLInputElement).checked = true
      }))
    }
    for (const t of doc.tours) actions.appendChild(button(t.title, 'tour', () => playTour(t)))
    if (v) {
      const toggle = button('2D map', 'map2d', () => showFlat(!flat))
      const showFlat = (on: boolean): void => {
        setFlat(on)
        toggle.textContent = on ? '3D city' : '2D map'
        toggle.setAttribute('aria-pressed', String(on))
      }
      toggle.setAttribute('aria-pressed', 'false')
      actions.appendChild(toggle)
      // The city's graphics stopped (a lost WebGL context): the 2D map shows, and the switch back to the city waits
      // until they return. Lost a second time, the viewer gives up on 3D ('flat') and the switch stays away.
      v.on('graphics', (g) => {
        toggle.hidden = g !== 'restored'
        if (g !== 'restored' && !flat) showFlat(true)
      })
    }
    actions.appendChild(button('Reset view', 'reset', () => { showCard(null); viewer?.resetView() }))
    setFlat(v === null)
    drawLegend()
    // The labels keep out from under every panel over the city (the header is above it).
    v?.setPanels([card, askHost, legend, toolbar])
    layout()
  }
  window.addEventListener('resize', layout)
  // A wrapping toolbar or a growing Ask box moves the strips the other panels keep clear of; a card meeting its cap
  // gains a scrollbar (the body's content box narrows), which the close button moves clear of. The fit runs on the
  // next frame, once per frame: fitting inside the observer's callback resizes the panels it watches, a loop WebKit
  // reports as a page error.
  if (typeof ResizeObserver === 'function') {
    let queued = false
    const watch = new ResizeObserver(() => {
      if (queued) return
      queued = true
      requestAnimationFrame(() => { queued = false; layout() })
    })
    watch.observe(toolbar)
    watch.observe(askHost)
    watch.observe(cardBody)
  }

  const pick = (id: string, kind: AskKind): void => {
    if (kind === 'term') { openTech(id.slice('tech:'.length)); return }
    if (kind !== 'tour') { openPart(id); return }
    const tour = doc.tours.find((t) => t.id === id)
    if (tour) playTour(tour)
  }

  return { askHost, viewHost, showCard, attach, pick, setAsk: (a) => { ask = a; layout() } }
}
