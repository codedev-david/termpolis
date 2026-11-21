// The exported page's controls around the city: the header, the read-only control set (no bookmarks, no
// annotate, Build it or Re-layout), the proposal picker, the legend, the card panel and how clicks, Esc,
// tours and Ask picks reach the viewer (3D) or the card panel (2D).
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorldViewer } from '../../../src/renderer/src/world/engine'
import type { WorldDoc } from '../../../src/shared/world/types'
import type { PageMeta } from '../../../src/shared/world/exportMeta'
import { REMOVALS_ID } from '../../../src/shared/world/designPatch'
import { buildPage, headerText, legendHtml, MADE_WITH_URL } from '../../../src/world-export/controls'
import { edge, minimal, rich } from '../world/helpers'

const META: PageMeta = { project: 'Termpolis', exportedOn: '2026-11-21', head7: 'abc1234', dirty: false }

function fakeViewer() {
  return {
    load: vi.fn(), setLayers: vi.fn(), setTheme: vi.fn(), setRightReserve: vi.fn(), setBottomReserve: vi.fn(), setCardReserve: vi.fn(),
    apply: vi.fn(async () => undefined), play: vi.fn(async () => undefined), resetView: vi.fn(), setPaused: vi.fn(), dispose: vi.fn(),
  }
}
type Fake = ReturnType<typeof fakeViewer>

function setup(opts: { doc?: WorldDoc; meta?: Partial<PageMeta>; viewer?: boolean } = {}) {
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  const doc = opts.doc ?? rich()
  const page = buildPage(parent, doc, { ...META, ...opts.meta })
  const viewer = opts.viewer === false ? null : fakeViewer()
  page.attach(viewer as unknown as WorldViewer | null)
  const q = <T extends Element = HTMLElement>(sel: string): T => parent.querySelector(sel) as T
  const control = (name: string): HTMLElement => q(`[data-control="${name}"]`)
  const card = (): HTMLElement => q('.wx-card')
  const body = (): HTMLElement => q('.wx-card-body')
  return { parent, page, doc, viewer: viewer as Fake, q, control, card, body }
}

const change = (el: HTMLInputElement | HTMLSelectElement, value: string | boolean): void => {
  if (typeof value === 'boolean') (el as HTMLInputElement).checked = value
  else el.value = value
  el.dispatchEvent(new Event('change'))
}

/** A click that also works on the map's SVG shapes (jsdom gives SVG elements no click()). */
const tap = (el: Element): void => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })) }

afterEach(() => {
  document.body.innerHTML = ''
  document.head.innerHTML = ''
  vi.restoreAllMocks()
})

describe('headerText', () => {
  it('names the project, the export date and the commit, and says when the tree had uncommitted changes', () => {
    expect(headerText({ ...META, dirty: true })).toBe('Termpolis, exported from Termpolis on 2026-11-21 · commit abc1234 (uncommitted changes)')
    expect(headerText(META)).toBe('Termpolis, exported from Termpolis on 2026-11-21 · commit abc1234')
  })

  it('leaves the commit part out, dirty flag included, when the world has no commit (a design, a folder without git)', () => {
    expect(headerText({ ...META, head7: '' })).toBe('Termpolis, exported from Termpolis on 2026-11-21')
    expect(headerText({ ...META, head7: '', dirty: true })).toBe('Termpolis, exported from Termpolis on 2026-11-21')
  })
})

describe('buildPage: header and control set', () => {
  it('shows the header and a Made with Lumopolis in Termpolis link to termpolis.com', () => {
    const { q } = setup({ meta: { dirty: true } })
    expect(q('.wx-title').textContent).toBe('Termpolis, exported from Termpolis on 2026-11-21 · commit abc1234 (uncommitted changes)')
    const made = q<HTMLAnchorElement>('.wx-made')
    expect(made.textContent).toBe('Made with Lumopolis in Termpolis')
    expect(made.getAttribute('href')).toBe('https://termpolis.com')
    expect(MADE_WITH_URL).toBe('https://termpolis.com')
    expect(made.rel).toBe('noopener noreferrer')
    expect(document.head.querySelector('style')!.textContent).toContain('.wx-page')
  })

  it('keeps a hidden panel out of sight although the stylesheet gives it a display (the empty card at start)', () => {
    // A real browser lets ".wx-card{display:flex}" beat the hidden attribute (author rules win over the browser's
    // own [hidden] rule); jsdom does not, so its computed style cannot show this. The page's own rule must.
    const { card } = setup()
    expect(card().hidden).toBe(true)
    const sheet = (document.head.querySelector('style') as HTMLStyleElement).sheet as CSSStyleSheet
    const rules = Array.from(sheet.cssRules) as CSSStyleRule[]
    const hiding = rules.filter((r) => r.selectorText === '.wx-page [hidden]')
    expect(hiding.map((r) => [r.style.getPropertyValue('display'), r.style.getPropertyPriority('display')])).toEqual([['none', 'important']])
  })

  it('has no bookmarks, annotate, Build it or Re-layout control', () => {
    const { parent } = setup({ meta: { proposalId: 'p1' } })
    const words = Array.from(parent.querySelectorAll('button, select, label, a'), (e) => e.textContent!.toLowerCase()).join(' | ')
    for (const word of ['bookmark', 'annotate', 'build it', 're-layout', 'relayout', 'edit', 'confirm']) expect(words).not.toContain(word)
    expect(parent.querySelector('[data-control*="bookmark"], [data-control*="annotate"], [data-control*="build"], [data-control*="layout"]')).toBeNull()
  })

  it('has no proposal picker without a proposal', () => {
    const { control, viewer } = setup()
    expect(control('proposal')).toBeNull()
    expect(viewer.setLayers).toHaveBeenCalledWith({ proposal: null })
  })

  it('has no proposal picker when the meta names a proposal the world does not have', () => {
    const { control } = setup({ meta: { proposalId: 'gone' } })
    expect(control('proposal')).toBeNull()
  })

  it('starts the proposal picker on meta.proposalId and switches the proposal layer', () => {
    const { control, viewer } = setup({ meta: { proposalId: 'p1' } })
    const picker = control('proposal') as HTMLSelectElement
    expect(picker.value).toBe('p1')
    expect(Array.from(picker.options, (o) => o.textContent)).toEqual(['Built world only', 'Plan'])
    expect(viewer.setLayers).toHaveBeenCalledWith({ proposal: 'p1' })
    change(picker, '')
    expect(viewer.setLayers).toHaveBeenLastCalledWith({ proposal: null, planned: true })
    change(picker, 'p1')
    expect(viewer.setLayers).toHaveBeenLastCalledWith({ proposal: 'p1', planned: true })
  })

  it('ticks "Planned parts" again when a proposal is picked, since the proposal shows them', () => {
    const { control, q, viewer } = setup({ meta: { proposalId: 'p1' } })
    const planned = q<HTMLInputElement>('[data-layer="planned"]')
    change(planned, false)
    expect(viewer.setLayers).toHaveBeenLastCalledWith({ planned: false })
    change(control('proposal') as HTMLSelectElement, '')
    expect(planned.checked).toBe(true)
  })

  it('sets the theme, the names and the layers', () => {
    const { control, q, viewer } = setup()
    change(control('theme') as HTMLSelectElement, 'glass')
    expect(viewer.setTheme).toHaveBeenCalledWith('glass')
    change(control('labels') as HTMLSelectElement, 'tech')
    expect(viewer.setLayers).toHaveBeenCalledWith({ labels: 'tech' })
    change(q<HTMLInputElement>('[data-layer="allLineLabels"]'), true)
    expect(viewer.setLayers).toHaveBeenCalledWith({ allLineLabels: true })
    change(q<HTMLInputElement>('[data-layer="planned"]'), false)
    expect(viewer.setLayers).toHaveBeenCalledWith({ planned: false })
    change(q<HTMLInputElement>('[data-layer="processes"]'), true)
    expect(viewer.setLayers).toHaveBeenCalledWith({ processes: true })
    expect(q('.wx-legend').textContent).toContain('What runs where')
  })

  it('reserves the toolbar and, on a wide page, the Ask strip and the open card', () => {
    const { q, page, viewer } = setup()
    expect(viewer.setRightReserve).toHaveBeenLastCalledWith(0)
    expect(viewer.setBottomReserve).toHaveBeenLastCalledWith(56)
    expect(viewer.setCardReserve).toHaveBeenLastCalledWith(0, 0)
    Object.defineProperty(q('.wx-stage'), 'clientWidth', { value: 1200 })
    window.dispatchEvent(new Event('resize'))
    expect(viewer.setRightReserve).toHaveBeenLastCalledWith(344)
    const card = q('.wx-card')
    Object.defineProperty(card, 'offsetLeft', { value: 12 })
    Object.defineProperty(card, 'offsetWidth', { value: 340 })
    Object.defineProperty(card, 'offsetTop', { value: 12 })
    Object.defineProperty(card, 'offsetHeight', { value: 200 })
    page.showCard('<h3>Hi</h3>')
    expect(viewer.setCardReserve).toHaveBeenLastCalledWith(364, 224)
  })
})

/** A design world (projectKey "design:"), with p1 and, if asked, the Removals proposal the design chat keeps. */
function designDoc(removals: boolean): WorldDoc {
  const doc = rich()
  doc.projectKey = 'design:7f3a'
  if (removals) doc.layers.plan.push({ id: REMOVALS_ID, title: 'Removals', summary: [], buildings: [], edges: [], removes: ['b2'] })
  return doc
}

describe('buildPage: a design world shows its plan', () => {
  it('opens the picker on Removals, so the parts the design removes are drawn as removed', () => {
    const { control, viewer } = setup({ doc: designDoc(true) })
    const picker = control('proposal') as HTMLSelectElement
    expect(picker.value).toBe(REMOVALS_ID)
    expect(Array.from(picker.options, (o) => o.textContent)).toEqual(['No proposal', 'Plan', 'Removals'])
    expect(viewer.setLayers).toHaveBeenCalledWith({ proposal: REMOVALS_ID })
    change(picker, 'p1')
    expect(viewer.setLayers).toHaveBeenLastCalledWith({ proposal: 'p1', planned: true })
    change(picker, '')
    expect(viewer.setLayers).toHaveBeenLastCalledWith({ proposal: null, planned: true })
  })

  it('without removals, offers the plan and starts on no proposal', () => {
    const { control, viewer } = setup({ doc: designDoc(false) })
    const picker = control('proposal') as HTMLSelectElement
    expect(picker.value).toBe('')
    expect(Array.from(picker.options, (o) => o.textContent)).toEqual(['No proposal', 'Plan'])
    expect(viewer.setLayers).toHaveBeenCalledWith({ proposal: null })
  })

  it('a proposal the meta names wins over Removals', () => {
    const { control, viewer } = setup({ doc: designDoc(true), meta: { proposalId: 'p1' } })
    expect((control('proposal') as HTMLSelectElement).value).toBe('p1')
    expect(viewer.setLayers).toHaveBeenCalledWith({ proposal: 'p1' })
  })

  it('has no picker when the design has no plan', () => {
    const doc = designDoc(false)
    doc.layers.plan = []
    const { control, viewer } = setup({ doc })
    expect(control('proposal')).toBeNull()
    expect(viewer.setLayers).toHaveBeenCalledWith({ proposal: null })
  })
})

describe('buildPage: legend', () => {
  it('opens on a wide page and toggles closed and open', () => {
    const { q } = setup()
    const toggle = (): HTMLButtonElement => q('.wx-legend-toggle')
    expect(toggle().getAttribute('aria-expanded')).toBe('true')
    expect(q('.wx-legend').textContent).toContain('Green ring: tests pass')
    toggle().click()
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
    expect(q('.wx-legend-body')).toBeNull()
    toggle().click()
    expect(q('.wx-legend-body')).not.toBeNull()
  })

  it('starts closed on a narrow page', () => {
    const parent = document.createElement('div')
    Object.defineProperty(parent, 'clientWidth', { value: 400 })
    document.body.appendChild(parent)
    buildPage(parent, rich(), META).attach(null)
    expect(parent.querySelector('.wx-legend-toggle')!.getAttribute('aria-expanded')).toBe('false')
  })
})

describe('legendHtml', () => {
  it('lists the busiest cargo first, at most ten, and counts the rest', () => {
    const doc = minimal()
    doc.edges = []
    for (let i = 0; i < 12; i++) {
      doc.cargo[`c${i}`] = { shape: 'sphere', color: '#ff0000', label: `Cargo ${i}` }
      for (let n = 0; n <= i; n++) doc.edges.push(edge(`e${i}-${n}`, 'b1', 'b2', { cargo: `c${i}` }))
    }
    const host = document.createElement('div')
    host.innerHTML = legendHtml(doc, false)
    const rows = Array.from(host.querySelectorAll('[data-cargo]'), (r) => r.textContent)
    expect(rows).toEqual(['Cargo 11', 'Cargo 10', 'Cargo 9', 'Cargo 8', 'Cargo 7', 'Cargo 6', 'Cargo 5', 'Cargo 4', 'Cargo 3', 'Cargo 2'])
    expect(host.textContent).toContain('+2 more on fewer lines')
    expect(host.textContent).not.toContain('What runs where')
  })

  it('draws an unknown shape as a cube, an unsafe colour as grey, and skips cargo no line carries', () => {
    const doc = minimal()
    doc.cargo.memory = { shape: 'blob' as 'cube', color: 'red;background:url(x)', label: 'Memory' }
    doc.cargo.idle = { shape: 'cube', color: '#00ff00', label: 'Idle' }
    doc.cargo.other = { shape: 'tetra', color: '#0000ff', label: 'Other' }
    doc.edges.push(edge('e9', 'b2', 'b1', { cargo: 'other' }))
    const html = legendHtml(doc, true)
    // Equally busy cargo keep the world's order.
    expect(html.indexOf('Memory')).toBeLessThan(html.indexOf('Other'))
    expect(html).toContain('<rect')
    expect(html).toContain('fill="#94a3b8"')
    expect(html).not.toContain('url(x)')
    expect(html).not.toContain('Idle')
    expect(html).not.toContain('more on fewer lines')
  })

  it('names the programs that run buildings when processes are on, and hides the section when none do', () => {
    const doc = minimal()
    expect(legendHtml(doc, true)).toContain('What runs where')
    doc.buildings = []
    doc.edges = []
    const html = legendHtml(doc, true)
    expect(html).not.toContain('What runs where')
    expect(html).not.toContain('What&#39;s moving')
  })
})

describe('buildPage: cards and clicks in 3D', () => {
  it('shows and closes the card; the close button flies back to the overview', () => {
    const { page, card, body, q, viewer } = setup()
    page.showCard('<h3>Store</h3>')
    expect(card().hidden).toBe(false)
    expect(body().innerHTML).toBe('<h3>Store</h3>')
    q<HTMLButtonElement>('.wx-card-close').click()
    expect(card().hidden).toBe(true)
    expect(body().innerHTML).toBe('')
    expect(viewer.resetView).toHaveBeenCalledTimes(1)
    page.showCard('')
    expect(card().hidden).toBe(true)
  })

  it('routes card links: a term chip opens its read-only term card, a part link its card', () => {
    const { page, body, viewer, doc } = setup()
    page.showCard('<span class="chip" data-tech="ipc">ipc</span><a class="link-node" data-node="b2">B2</a><a class="link-edge" data-edge="e1">E1</a><p class="plain">text</p>')
    body().querySelector<HTMLElement>('[data-tech]')!.click()
    expect(viewer.apply).toHaveBeenCalledWith({ type: 'openCard', id: 'tech:ipc' })
    expect(viewer.apply).toHaveBeenCalledWith({ type: 'highlight', ids: expect.arrayContaining(doc.buildings.filter((b) => b.stack.includes('ipc')).map((b) => b.id)) })
    body().querySelector<HTMLElement>('[data-node]')!.click()
    expect(viewer.apply).toHaveBeenCalledWith({ type: 'openCard', id: 'b2' })
    body().querySelector<HTMLElement>('[data-edge]')!.click()
    expect(viewer.apply).toHaveBeenCalledWith({ type: 'openCard', id: 'e1' })
    viewer.apply.mockClear()
    body().querySelector<HTMLElement>('.plain')!.click()
    expect(viewer.apply).not.toHaveBeenCalled()
  })

  it('closes the card on Esc outside the 3D view, but leaves Esc inside it to the viewer', () => {
    const { page, card, page: { viewHost }, viewer } = setup()
    page.showCard('<h3>Store</h3>')
    const inside = document.createElement('canvas')
    viewHost.appendChild(inside)
    inside.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(card().hidden).toBe(false)
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(card().hidden).toBe(false)
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(card().hidden).toBe(true)
    expect(viewer.resetView).toHaveBeenCalled()
  })

  it('plays a tour in the city and resets the view', () => {
    const { control, viewer, card, page, doc } = setup()
    control('tour').click()
    expect(viewer.play).toHaveBeenCalledWith([{ type: 'tour', steps: doc.tours[0].steps }])
    page.showCard('<h3>x</h3>')
    control('reset').click()
    expect(card().hidden).toBe(true)
    expect(viewer.resetView).toHaveBeenCalled()
  })

  it('opens what an Ask result names: a part, a term or a tour', () => {
    const { page, viewer, doc } = setup()
    page.pick('b1', 'building')
    expect(viewer.apply).toHaveBeenCalledWith({ type: 'openCard', id: 'b1' })
    page.pick('tech:sqlite', 'term')
    expect(viewer.apply).toHaveBeenCalledWith({ type: 'openCard', id: 'tech:sqlite' })
    page.pick('t1', 'tour')
    expect(viewer.play).toHaveBeenCalledWith([{ type: 'tour', steps: doc.tours[0].steps }])
    viewer.play.mockClear()
    page.pick('no-such-tour', 'tour')
    expect(viewer.play).not.toHaveBeenCalled()
  })
})

describe('buildPage: the 2D map', () => {
  it('switches to the 2D map and back, pausing the city', () => {
    const { control, q, viewer, page } = setup()
    const toggle = control('map2d')
    expect(q('.wx-map2d').hidden).toBe(true)
    page.showCard('<h3>x</h3>')
    toggle.click()
    expect(q('.wx-map2d').hidden).toBe(false)
    expect(page.viewHost.hidden).toBe(true)
    expect(viewer.setPaused).toHaveBeenLastCalledWith(true)
    expect(toggle.textContent).toBe('3D city')
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    expect(q('.wx-card').hidden).toBe(true)
    toggle.click()
    expect(q('.wx-map2d').hidden).toBe(true)
    expect(viewer.setPaused).toHaveBeenLastCalledWith(false)
    expect(toggle.textContent).toBe('2D map')
  })

  it('opens read-only cards from map clicks; a district closes the card', () => {
    const { control, q, body, card, doc } = setup()
    control('map2d').click()
    q('.wx-map2d').click()
    expect(card().hidden).toBe(true)
    tap(q('.wx-map2d [data-kind="building"][data-id="b1"]'))
    expect(card().hidden).toBe(false)
    expect(body().querySelector('h3')!.textContent).toBe(doc.buildings[0].name)
    expect(body().innerHTML).not.toMatch(/Confirm|data-edit/)
    tap(q('.wx-map2d [data-kind="edge"][data-id="e1"]'))
    expect(body().textContent).toContain('What travels')
    tap(q('.wx-map2d [data-kind="district"]'))
    expect(card().hidden).toBe(true)
  })

  it('shows the 2D map only, with tours as cards, when there is no viewer', () => {
    const { control, q, body, page, card, doc } = setup({ viewer: false })
    expect(q('.wx-map2d').hidden).toBe(false)
    expect(control('map2d')).toBeNull()
    expect(control('theme')).toBeNull()
    control('tour').click()
    expect(body().querySelector('h3')!.textContent).toBe(doc.tours[0].title)
    expect(body().querySelector('li')!.textContent).toBe(doc.tours[0].steps[0].caption)
    page.pick('tech:ipc', 'term')
    expect(body().textContent).toContain('ipc')
    body().querySelector<HTMLElement>('[data-node], [data-tech]')?.click()
    page.pick('x1', 'external')
    expect(card().hidden).toBe(false)
    page.pick('nothing', 'building')
    expect(card().hidden).toBe(true)
    page.showCard('<h3>x</h3>')
    control('reset').click()
    expect(card().hidden).toBe(true)
    page.showCard('<h3>x</h3>')
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(card().hidden).toBe(true)
  })
})
