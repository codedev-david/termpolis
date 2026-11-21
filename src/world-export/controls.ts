// The exported page around the city: a slim header, the controls (theme, layers, the proposal picker, tours, the
// 2D switch, reset view), the legend and the card panel showing the engine's own read-only card HTML. Plain DOM,
// no React. The page is read-only: there is no annotate, Build it, Re-layout, bookmark or editing control, the
// cards are rendered with readOnly (no Confirm or Edit, evidence as plain text), and nothing is stored in the
// browser. A technology chip (data-tech) only opens that term's glossary card, itself read-only.
import { buildingCard, edgeCard, escapeHtml as esc, renderFallback, techCard, usesTech, type WorldViewer } from '../renderer/src/world/engine'
import type { ThemeName } from '../renderer/src/world/engine'
import type { AskKind } from '../shared/world/askIndex'
import type { Tour, WorldDoc } from '../shared/world/types'

/** The page's `meta` block, written by the export. */
export interface PageMeta { project: string; exportedOn: string; head7: string; dirty: boolean; proposalId?: string }

export const MADE_WITH_URL = 'https://termpolis.com'

/** "<Project>, exported from Termpolis on <date> · commit <head7>", and " (uncommitted changes)" when the tree was dirty. */
export function headerText(meta: PageMeta): string {
  return `${meta.project}, exported from Termpolis on ${meta.exportedOn} · commit ${meta.head7}${meta.dirty ? ' (uncommitted changes)' : ''}`
}

const THEME_NAMES: Array<[ThemeName, string]> = [['neon', 'Neon'], ['blueprint', 'Blueprint'], ['glass', 'Glass']]
const CARD_INSET = 12
const CARD_WIDTH = 340
const ASK_WIDTH = 320
/** From this width the Ask box keeps its strip on the right out of the city's framing. */
const WIDE_PX = 732
const TOOLBAR_RESERVE = 56
const LEGEND_MAX_CARGO = 10

/** One stylesheet for the whole page (the CSP allows inline styles, never a stylesheet from elsewhere). */
export const PAGE_CSS = `
.wx-page{position:fixed;inset:0;display:flex;flex-direction:column;background:#03050a;color:#e2e8f0;font:13px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
.wx-header{display:flex;flex-wrap:wrap;gap:4px 16px;align-items:center;justify-content:space-between;padding:6px 14px;font-size:12px;color:#94a3b8;border-bottom:1px solid rgba(148,163,184,.18)}
.wx-header a{color:#7dd3fc}
.wx-stage{position:relative;flex:1 1 auto;min-height:0;overflow:hidden}
.wx-view{position:absolute;inset:0}
.wx-map2d{position:absolute;inset:0;overflow:auto;padding:12px 16px 72px;background:#0b1220}
.wx-map2d [data-kind]{cursor:pointer}
.wx-map2d ul{padding-left:18px}
.wx-panel{background:rgba(8,12,22,.82);backdrop-filter:blur(10px);border:1px solid rgba(148,163,184,.18);border-radius:12px;color:#e2e8f0}
.wx-card{position:absolute;top:${CARD_INSET}px;left:${CARD_INSET}px;width:${CARD_WIDTH}px;max-width:calc(100% - ${CARD_INSET * 2}px);max-height:calc(100% - 110px);display:flex;flex-direction:column;box-sizing:border-box;padding:12px 6px 12px 14px;z-index:3}
.wx-card-close{position:absolute;top:8px;right:10px;padding:2px 7px;border:0;border-radius:6px;background:transparent;color:#94a3b8;cursor:pointer}
.wx-card-body{overflow-y:auto;padding-right:8px;overflow-wrap:anywhere}
.wx-card-body h3{margin:0 0 4px;padding-right:26px;font-size:16px;font-weight:600;color:#f1f5f9}
.wx-card-body h4{margin:12px 0 4px;font-size:11px;font-weight:600;letter-spacing:1px;text-transform:uppercase;color:#7dd3fc}
.wx-card-body p{margin:4px 0}
.wx-card-body ul{margin:2px 0;padding-left:16px}
.wx-card-body ul.claims{list-style:none;padding-left:0}
.wx-card-body .muted{color:#94a3b8;font-size:12px}
.wx-card-body .proc{font-size:12px;background:rgba(148,163,184,.1);border-radius:6px;padding:4px 8px;margin:6px 0}
.wx-card-body .tag,.wx-card-body .claim .state{display:inline-block;padding:1px 8px;border-radius:99px;font-size:11px;background:#334155;color:#cbd5e1;margin-right:4px}
.wx-card-body .status-verified,.wx-card-body .claim[data-state=verified] .state{background:#14532d;color:#4ade80}
.wx-card-body .status-built,.wx-card-body .claim[data-state=observed] .state{background:#1e3a5f;color:#7dd3fc}
.wx-card-body .status-gap,.wx-card-body .claim[data-state=inferred] .state{background:#451a03;color:#fbbf24}
.wx-card-body .status-proposed{background:#1e293b;color:#93c5fd}
.wx-card-body .chip{display:inline-block;margin:2px 3px 2px 0;padding:2px 8px;border-radius:99px;font-size:11.5px;background:rgba(167,139,250,.14);border:1px solid rgba(167,139,250,.45);color:#ede9fe}
.wx-card-body .chip[data-tech]{cursor:pointer}
.wx-card-body .cargo{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px}
.wx-card-body a{color:#7dd3fc;cursor:pointer;text-decoration:underline dotted}
.wx-card-body .ev-ref{font-family:ui-monospace,monospace;font-size:11.5px;color:#94a3b8}
.wx-ask-host{position:absolute;top:${CARD_INSET}px;right:${CARD_INSET}px;width:${ASK_WIDTH}px;max-width:calc(100% - ${CARD_INSET * 2}px);z-index:4}
.wx-ask{padding:10px 12px}
.wx-ask-input{width:100%;box-sizing:border-box;padding:6px 10px;border-radius:8px;border:1px solid rgba(148,163,184,.35);background:rgba(15,23,42,.9);color:#e2e8f0;font:inherit}
.wx-ask-status,.wx-ask-none{margin:6px 0 0;font-size:12px;color:#fbbf24}
.wx-ask-none{color:#94a3b8}
.wx-ask-results{list-style:none;margin:6px 0 0;padding:0}
.wx-ask-pick{display:block;width:100%;text-align:left;margin:4px 0;padding:6px 8px;border-radius:8px;border:1px solid rgba(148,163,184,.18);background:rgba(15,23,42,.6);color:inherit;font:inherit;cursor:pointer}
.wx-ask-head{display:flex;gap:8px;align-items:baseline;justify-content:space-between}
.wx-ask-kind{flex:none;font-size:11px;color:#7dd3fc}
.wx-ask-first{display:block;font-size:12px;color:#94a3b8}
.wx-ask-caption{margin:6px 0 0;font-size:11px;color:#64748b}
.wx-toolbar{position:absolute;left:${CARD_INSET}px;right:${CARD_INSET}px;bottom:${CARD_INSET}px;display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center;padding:6px 10px;z-index:2}
.wx-toolbar label{display:inline-flex;gap:4px;align-items:center;font-size:12px}
.wx-toolbar button,.wx-toolbar select{padding:2px 8px;border-radius:6px;border:1px solid rgba(125,211,252,.4);background:transparent;color:#7dd3fc;font:inherit;font-size:12px;cursor:pointer}
.wx-toolbar select option{background:#0b1220;color:#e2e8f0}
.wx-legend{position:absolute;right:${CARD_INSET}px;bottom:72px;width:220px;max-height:calc(100% - 150px);overflow:auto;box-sizing:border-box;padding:8px 12px;font-size:12px;z-index:2}
.wx-legend-toggle{display:flex;width:100%;justify-content:space-between;background:none;border:0;padding:0;color:inherit;font:inherit;font-weight:600;cursor:pointer}
.wx-legend b{display:block;margin:8px 0 4px}
.wx-legend .row{display:flex;gap:8px;align-items:center;margin:2px 0;font-size:11.5px;overflow-wrap:anywhere}
.wx-legend .sw{width:20px;height:10px;border-radius:3px;flex:none;box-sizing:border-box}
.wx-legend .muted{color:#94a3b8;margin:0 0 4px}
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
}

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
  const made = make('a', 'wx-made', 'Made with Termpolis')
  made.href = MADE_WITH_URL
  made.target = '_blank'
  made.rel = 'noopener noreferrer'
  header.append(make('span', 'wx-title', headerText(meta)), made)

  const stage = make('div', 'wx-stage')
  const viewHost = make('div', 'wx-view')
  const map2d = make('div', 'wx-map2d')
  map2d.innerHTML = renderFallback(doc, meta.project)
  map2d.hidden = true
  const card = make('aside', 'wx-card wx-panel')
  card.setAttribute('aria-label', 'Lumopolis details')
  card.hidden = true
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
  let processes = false
  let legendOpen = (parent.clientWidth || window.innerWidth) >= WIDE_PX

  const layout = (): void => {
    if (!viewer) return
    viewer.setRightReserve(stage.clientWidth >= WIDE_PX ? ASK_WIDTH + CARD_INSET * 2 : 0)
    viewer.setBottomReserve(TOOLBAR_RESERVE)
    viewer.setCardReserve(card.hidden ? 0 : card.offsetLeft + card.offsetWidth + CARD_INSET, card.hidden ? 0 : card.offsetTop + card.offsetHeight + CARD_INSET)
  }
  const showCard = (html: string | null): void => {
    card.hidden = html === null || html === ''
    cardBody.innerHTML = card.hidden ? '' : (html as string)
    cardBody.scrollTop = 0
    layout()
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
    closeCard()
  })

  const setFlat = (on: boolean): void => {
    flat = on
    map2d.hidden = !on
    viewHost.hidden = on
    viewer?.setPaused(on)
    showCard(null)
  }

  const attach = (v: WorldViewer | null): void => {
    viewer = v
    toolbar.textContent = ''
    if (v) {
      const proposal = meta.proposalId !== undefined && doc.layers.plan.some((p) => p.id === meta.proposalId) ? meta.proposalId : null
      v.setLayers({ proposal })
      toolbar.append(
        select('Theme', 'theme', THEME_NAMES, 'neon', (t) => v.setTheme(t as ThemeName)),
        select('Names', 'labels', [['jobs', 'What it does'], ['tech', 'Technology']], 'jobs', (l) => v.setLayers({ labels: l as 'jobs' | 'tech' })),
        checkbox('Processes', 'processes', false, (on) => { processes = on; v.setLayers({ processes: on }); drawLegend() }),
        checkbox('All line labels', 'allLineLabels', false, (on) => v.setLayers({ allLineLabels: on })),
        checkbox('Planned parts', 'planned', true, (on) => v.setLayers({ planned: on })),
      )
      // Only a proposal export has a proposal to pick; it opens with that proposal shown.
      if (proposal !== null) {
        const options: Array<[string, string]> = [['', 'Built world only'], ...doc.layers.plan.map((p): [string, string] => [p.id, p.title])]
        toolbar.appendChild(select('Proposal', 'proposal', options, proposal, (id) => v.setLayers({ proposal: id === '' ? null : id, planned: true })))
      }
    }
    for (const t of doc.tours) toolbar.appendChild(button(t.title, 'tour', () => playTour(t)))
    if (v) {
      const toggle = button('2D map', 'map2d', () => {
        setFlat(!flat)
        toggle.textContent = flat ? '3D city' : '2D map'
        toggle.setAttribute('aria-pressed', String(flat))
      })
      toggle.setAttribute('aria-pressed', 'false')
      toolbar.appendChild(toggle)
    }
    toolbar.appendChild(button('Reset view', 'reset', () => { showCard(null); viewer?.resetView() }))
    setFlat(v === null)
    drawLegend()
    layout()
  }
  window.addEventListener('resize', layout)

  const pick = (id: string, kind: AskKind): void => {
    if (kind === 'term') { openTech(id.slice('tech:'.length)); return }
    if (kind !== 'tour') { openPart(id); return }
    const tour = doc.tours.find((t) => t.id === id)
    if (tour) playTour(tour)
  }

  return { askHost, viewHost, showCard, attach, pick }
}
