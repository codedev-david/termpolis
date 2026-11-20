// createWorldViewer in jsdom. jsdom has no WebGL, so hasWebGL() is false and the viewer runs its
// 2D list path: these tests pin the ruling-level logic there (select kinds from list clicks,
// apply/play/cancel, Esc, resetView, layers/theme, dispose). The WebGL wiring is checked against a
// stand-in renderer (the real one needs a GPU and is covered by e2e/world-engine.spec.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RenderPick, ThreeRenderer } from '../../../src/renderer/src/world/engine/threeRenderer'
import type { WorldDoc } from '../../../src/shared/world/types'
import { createWorldViewer, hasWebGL, type WorldSelection } from '../../../src/renderer/src/world/engine/createWorldViewer'
import { ACTION_GAP_MS } from '../../../src/renderer/src/world/engine/actionQueue'
import { DEFAULT_LAYERS } from '../../../src/renderer/src/world/engine/sceneModel'
import { building, minimal, rich } from './helpers'

const { createThreeRenderer } = vi.hoisted(() => ({ createThreeRenderer: vi.fn() }))
vi.mock('../../../src/renderer/src/world/engine/threeRenderer', () => ({ createThreeRenderer }))

type Card = string | null

function setup(opts: { reducedMotion?: boolean; doc?: WorldDoc } = {}) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const cards: Card[] = []
  const fromClicks: boolean[] = []
  const sels: (WorldSelection | null)[] = []
  const viewer = createWorldViewer(host, {
    ...(opts.reducedMotion === undefined ? {} : { reducedMotion: opts.reducedMotion }),
    renderCard: (html, fromClick) => { cards.push(html); fromClicks.push(fromClick === true) },
  })
  viewer.on('select', (s) => { sels.push(s) })
  viewer.load(opts.doc ?? rich())
  const item = (kind: string, id: string): HTMLElement => {
    const el = host.querySelector<HTMLElement>(`li[data-kind="${kind}"][data-id="${id}"]`)
    if (!el) throw new Error(`no ${kind} ${id} in the list`)
    return el
  }
  const esc = (): void => { host.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) }
  return { host, viewer, cards, fromClicks, sels, item, esc, lastCard: (): Card | undefined => cards[cards.length - 1] }
}

let getContext: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  // jsdom does not implement getContext (it logs "Not implemented"); null is what it means.
  getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  createThreeRenderer.mockReset()
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('hasWebGL', () => {
  it('is false without a context, true (and the probe context released) with one, false on a throw', () => {
    expect(hasWebGL()).toBe(false)
    const loseContext = vi.fn()
    getContext.mockReturnValue({ getExtension: () => ({ loseContext }) } as never)
    expect(hasWebGL()).toBe(true)
    expect(loseContext).toHaveBeenCalled()
    getContext.mockImplementation(() => { throw new Error('blocked') })
    expect(hasWebGL()).toBe(false)
  })
})

describe('2D fallback: selection from list clicks', () => {
  it('draws the list, never the renderer, and makes the host focusable', () => {
    const { host } = setup()
    expect(createThreeRenderer).not.toHaveBeenCalled()
    expect(host.querySelector('section.world-fallback')).not.toBeNull()
    expect(host.tabIndex).toBe(0)
    expect(host.style.position).toBe('relative')
  })

  it('fires select with the right kind and id for buildings, externals, edges and districts', () => {
    const { viewer, sels, cards, item } = setup()
    item('building', 'b1').click()
    expect(sels.pop()).toEqual({ kind: 'building', id: 'b1' })
    expect(cards.pop()).toContain('Desktop app')
    expect(viewer.getSelection()).toEqual(['b1'])

    item('building', 'x1').click()
    expect(sels.pop()).toEqual({ kind: 'building', id: 'x1' })
    expect(cards.pop()).toContain('Claude Code')

    item('edge', 'e1').click()
    expect(sels.pop()).toEqual({ kind: 'edge', id: 'e1' })
    expect(cards.pop()).toContain('Memory calls')

    // The district's heading is inside its item (and outside any building item).
    item('district', 'd1').querySelector('h3')?.click()
    expect(sels.pop()).toEqual({ kind: 'district', id: 'd1' })
    expect(cards.pop()).toBeNull() // a district has no card
  })

  it('a click outside any item does nothing', () => {
    const { host, sels, cards } = setup()
    host.querySelector<HTMLElement>('section.world-fallback > h2')?.click()
    expect(sels).toEqual([])
    expect(cards).toEqual([])
  })

  it('uses the tagged kind when one id names two things', () => {
    const doc = minimal()
    doc.districts[0].id = 'b1' // a district sharing a building's id
    for (const b of doc.buildings) b.districtId = 'b1'
    const { sels, item } = setup({ doc })
    item('district', 'b1').querySelector('h3')?.click()
    expect(sels.pop()).toEqual({ kind: 'district', id: 'b1' })
    item('building', 'b1').click()
    expect(sels.pop()).toEqual({ kind: 'building', id: 'b1' })
  })

  it('falls back to the id lookup when the tag is unknown or stale, and ignores unknown ids', () => {
    const { sels, item, host } = setup()
    const li = item('building', 'b1')
    li.setAttribute('data-kind', 'nonsense')
    li.click()
    expect(sels.pop()).toEqual({ kind: 'building', id: 'b1' })
    li.setAttribute('data-kind', 'edge') // tagged edge, but b1 is no edge
    li.click()
    expect(sels.pop()).toEqual({ kind: 'building', id: 'b1' })
    li.setAttribute('data-id', 'nobody')
    li.click()
    expect(sels).toEqual([])
    const stray = document.createElement('div')
    stray.setAttribute('data-id', 'b1')
    document.body.appendChild(stray)
    stray.click() // outside the viewer
    expect(sels).toEqual([])
    expect(host.contains(stray)).toBe(false)
  })

  it('stops calling a select listener once unsubscribed', () => {
    const { viewer, item } = setup()
    const cb = vi.fn()
    const off = viewer.on('select', cb)
    item('building', 'b1').click()
    off()
    item('building', 'b2').click()
    expect(cb).toHaveBeenCalledTimes(1)
    const offHover = viewer.on('hover', vi.fn())
    expect(() => offHover()).not.toThrow()
  })
})

describe('2D fallback: apply()', () => {
  it('openCard selects and renders the card; tech ids get the glossary card', async () => {
    const { viewer, sels, lastCard } = setup({ reducedMotion: true })
    await viewer.apply({ type: 'openCard', id: 'b2' })
    expect(sels.pop()).toEqual({ kind: 'building', id: 'b2' })
    expect(lastCard()).toContain('Memory host')
    await viewer.apply({ type: 'openCard', id: 'sqlite' })
    expect(sels.pop()).toEqual({ kind: 'tech', id: 'sqlite' })
    expect(lastCard()).toContain('A small database stored in a single file.')
    await viewer.apply({ type: 'openCard', id: 'nobody' })
    expect(sels).toEqual([])
    expect(viewer.getSelection()).toEqual(['sqlite'])
  })

  it('openCard "tech:<term>" opens that glossary card even when a part shares the name', async () => {
    const { viewer, sels, lastCard } = setup({ reducedMotion: true })
    await viewer.apply({ type: 'openCard', id: 'tech:sqlite' })
    expect(sels.pop()).toEqual({ kind: 'tech', id: 'sqlite' })
    expect(lastCard()).toContain('A small database stored in a single file.')
  })

  it('openCard on a district id selects the district (answers may name districts) and opens no card', async () => {
    const { viewer, sels, cards } = setup({ reducedMotion: true })
    await viewer.apply({ type: 'openCard', id: 'd1' })
    expect(sels.pop()).toEqual({ kind: 'district', id: 'd1' })
    expect(cards.pop()).toBeNull()
    expect(viewer.getSelection()).toEqual(['d1'])
  })

  it('focus, highlight and flow leave the selection and card alone (nothing to light in 2D)', async () => {
    const { viewer, sels, cards } = setup({ reducedMotion: true })
    await viewer.apply({ type: 'openCard', id: 'b1' })
    const before = { sels: sels.length, cards: cards.length }
    await viewer.apply({ type: 'focus', ids: ['b2'] })
    await viewer.apply({ type: 'highlight', ids: ['b2', 'e1'] })
    await viewer.apply({ type: 'flow', edgeIds: ['e1'] })
    expect({ sels: sels.length, cards: cards.length }).toEqual(before)
    expect(viewer.getSelection()).toEqual(['b1'])
  })

  it('tour shows each caption escaped and clears a selection first', async () => {
    const { viewer, sels, lastCard } = setup({ reducedMotion: true })
    await viewer.apply({ type: 'openCard', id: 'b1' })
    sels.length = 0
    await viewer.apply({ type: 'tour', steps: [{ ids: ['b1'], caption: 'one' }, { ids: ['b2'], caption: '<b>two</b>' }] })
    expect(sels).toEqual([null])
    expect(lastCard()).toBe('<p class="tour-caption">&lt;b&gt;two&lt;/b&gt;</p>')
    expect(viewer.getSelection()).toEqual([])
  })

  it('draftProposal redraws with the proposal; an unknown proposal is ignored', async () => {
    const { viewer, host } = setup({ reducedMotion: true })
    const marker = host.querySelector('section.world-fallback')
    await viewer.apply({ type: 'draftProposal', proposalId: 'nope' })
    expect(host.querySelector('section.world-fallback')).toBe(marker)
    await viewer.apply({ type: 'draftProposal', proposalId: 'p1' })
    expect(host.querySelector('section.world-fallback')).not.toBe(marker)
    // A building only the proposal adds can now be selected.
    await viewer.apply({ type: 'openCard', id: 'pb1' })
    expect(viewer.getSelection()).toEqual(['pb1'])
  })

  it('reset clears the selection (card null, select null) and the revealed proposal', async () => {
    const { viewer, sels, host, lastCard } = setup({ reducedMotion: true })
    await viewer.apply({ type: 'draftProposal', proposalId: 'p1' })
    await viewer.apply({ type: 'openCard', id: 'b1' })
    const drawn = host.querySelector('section.world-fallback')
    await viewer.apply({ type: 'reset' })
    expect(lastCard()).toBeNull()
    expect(sels.pop()).toBeNull()
    expect(host.querySelector('section.world-fallback')).not.toBe(drawn) // redrawn without p1
    await viewer.apply({ type: 'reset' }) // nothing revealed or selected: no event, no redraw
    expect(sels.filter((s) => s === null)).toEqual([])
  })

  it('does nothing before a world is loaded', async () => {
    const host = document.createElement('div')
    const renderCard = vi.fn()
    const viewer = createWorldViewer(host, { reducedMotion: true, renderCard })
    await viewer.apply({ type: 'openCard', id: 'b1' })
    expect(renderCard).not.toHaveBeenCalled()
    expect(viewer.getSelection()).toEqual([])
    expect(viewer.cameraRegion()).toEqual([])
  })
})

describe('2D fallback: play and cancelActions', () => {
  it('plays actions in order with the gap between them', async () => {
    vi.useFakeTimers()
    const { viewer, sels } = setup({ reducedMotion: false })
    const done = viewer.play([{ type: 'openCard', id: 'b1' }, { type: 'openCard', id: 'e1' }])
    await vi.advanceTimersByTimeAsync(0)
    expect(sels).toEqual([{ kind: 'building', id: 'b1' }])
    await vi.advanceTimersByTimeAsync(ACTION_GAP_MS)
    await done
    expect(sels).toEqual([{ kind: 'building', id: 'b1' }, { kind: 'edge', id: 'e1' }])
  })

  it('cancelActions drops the actions not yet run', async () => {
    vi.useFakeTimers()
    const { viewer, sels } = setup({ reducedMotion: false })
    const done = viewer.play([{ type: 'openCard', id: 'b1' }, { type: 'openCard', id: 'e1' }])
    await vi.advanceTimersByTimeAsync(0)
    viewer.cancelActions()
    await vi.advanceTimersByTimeAsync(ACTION_GAP_MS * 3)
    await done
    expect(sels).toEqual([{ kind: 'building', id: 'b1' }])
  })

  it('cancelActions stops a running tour between steps', async () => {
    vi.useFakeTimers()
    const { viewer, cards } = setup({ reducedMotion: false })
    const done = viewer.apply({ type: 'tour', steps: [{ ids: ['b1'], caption: 'one' }, { ids: ['b2'], caption: 'two' }] })
    await vi.advanceTimersByTimeAsync(0)
    expect(cards[cards.length - 1]).toContain('one')
    viewer.cancelActions()
    await vi.advanceTimersByTimeAsync(ACTION_GAP_MS * 10)
    await done
    expect(cards.some((c) => c?.includes('two'))).toBe(false)
  })

  it('takes reduced motion from matchMedia when the option is not given (no gaps)', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('reduce') }))
    const { viewer, sels } = setup()
    await viewer.play([{ type: 'openCard', id: 'b1' }, { type: 'openCard', id: 'e1' }])
    expect(sels).toEqual([{ kind: 'building', id: 'b1' }, { kind: 'edge', id: 'e1' }])
  })

  it('treats a throwing matchMedia as no preference', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('matchMedia', () => { throw new Error('no') })
    const { viewer, sels } = setup()
    const done = viewer.play([{ type: 'openCard', id: 'b1' }, { type: 'openCard', id: 'e1' }])
    await vi.advanceTimersByTimeAsync(0)
    expect(sels).toHaveLength(1) // waiting out the gap
    await vi.advanceTimersByTimeAsync(ACTION_GAP_MS)
    await done
    expect(sels).toHaveLength(2)
  })
})

describe('2D fallback: Esc, resetView, layers, theme', () => {
  it('Esc clears the card and fires select(null); other keys do nothing', () => {
    const { item, sels, esc, host, lastCard, viewer } = setup()
    item('building', 'b1').click()
    host.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(viewer.getSelection()).toEqual(['b1'])
    esc()
    expect(lastCard()).toBeNull()
    expect(sels.pop()).toBeNull()
    expect(viewer.getSelection()).toEqual([])
    esc() // nothing selected: card cleared again, no second select event
    expect(lastCard()).toBeNull()
    expect(sels.filter((s) => s === null)).toEqual([])
  })

  it('Esc cancels a playing sequence', async () => {
    vi.useFakeTimers()
    const { viewer, sels, esc } = setup({ reducedMotion: false })
    const done = viewer.play([{ type: 'openCard', id: 'b1' }, { type: 'openCard', id: 'e1' }])
    await vi.advanceTimersByTimeAsync(0)
    esc()
    await vi.advanceTimersByTimeAsync(ACTION_GAP_MS * 3)
    await done
    expect(sels).toEqual([{ kind: 'building', id: 'b1' }, null])
  })

  it('resetView clears the selection like Esc', () => {
    const { item, sels, viewer, lastCard } = setup()
    item('edge', 'e1').click()
    viewer.resetView()
    expect(lastCard()).toBeNull()
    expect(sels.pop()).toBeNull()
    expect(viewer.getSelection()).toEqual([])
  })

  it('setLayers re-renders the list; setTheme accepts every theme and ignores unknown ones', () => {
    const { viewer, host } = setup()
    const drawn = host.querySelector('section.world-fallback')
    viewer.setLayers({ labels: 'tech' })
    expect(host.querySelector('section.world-fallback')).not.toBe(drawn)
    expect(host.querySelector('[data-kind="building"][data-id="b1"]')).not.toBeNull()
    for (const t of ['neon', 'blueprint', 'glass'] as const) expect(() => viewer.setTheme(t)).not.toThrow()
    expect(() => viewer.setTheme('nope' as never)).not.toThrow()
  })

  it('load replaces the world, clears the selection and redraws', () => {
    const { viewer, item, sels, lastCard, host } = setup()
    item('building', 'b1').click()
    const doc = minimal()
    doc.projectKey = 'second'
    viewer.load(doc)
    expect(sels.pop()).toBeNull()
    expect(lastCard()).toBeNull()
    expect(host.querySelector('h2')?.textContent).toBe('This project')
    expect(host.innerHTML).not.toContain('second') // the hashed key is never shown
    viewer.load(doc) // nothing selected now: no event
    expect(sels.filter((s) => s === null)).toEqual([])
  })

  it('cameraRegion lists every building, external and edge in 2D', () => {
    const { viewer } = setup({ doc: minimal() })
    expect(viewer.cameraRegion()).toEqual(['b1', 'b2', 'x1', 'e1'])
  })

  it('has no screen points and draws no shells or conduits in 2D, but reports the layers', () => {
    const { viewer } = setup({ doc: minimal() })
    viewer.setLayers({ processes: true })
    expect(viewer.screenPoint('b1')).toBeNull()
    expect(viewer.linePoints('e1')).toEqual([])
    expect(viewer.pickAt(1, 2)).toBeNull()
    expect(viewer.drawn()).toEqual({ layers: { ...DEFAULT_LAYERS, processes: true }, processShells: 0, conduits: 0, changing: 0, tier: 'districts', drawCalls: 0, buildings: 0, districts: 0, slabs: 0, slabLooks: [], wireframes: [], shownWireframes: [], outlined: [], fading: [], hot: [], fogged: [], highlighted: [], visual: { ringAngle: 0, fogDrift: 0, wirePulse: 0, selectionRingAngle: 0, bloom: false, stars: 0, dust: 0, platformSides: {}, platformLights: 0, floorOrder: {}, orbs: [], exploded: null, explodeGap: 0, flight: { active: false, t: 0, eased: 0 }, lineLabels: 0 } })
  })

  it('keeps an existing tabindex and positioning', () => {
    const host = document.createElement('div')
    host.tabIndex = 3
    host.style.position = 'absolute'
    document.body.appendChild(host)
    createWorldViewer(host, { reducedMotion: true })
    expect(host.tabIndex).toBe(3)
    expect(host.style.position).toBe('absolute')
  })
})

describe('2D fallback: tagged items the list did not draw', () => {
  it('takes the tag only when it names that kind, else the kind the id names, and nothing before a world', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const sels: (WorldSelection | null)[] = []
    const viewer = createWorldViewer(host, { reducedMotion: true })
    viewer.on('select', (s) => { sels.push(s) })
    const tagged = (kind: string, id: string): HTMLElement => {
      const el = document.createElement('span')
      el.setAttribute('data-kind', kind)
      el.setAttribute('data-id', id)
      host.appendChild(el)
      return el
    }
    tagged('building', 'b1').click() // no world yet
    expect(sels).toEqual([])
    viewer.load(rich())
    tagged('building', 'pb1').click() // a planned building
    expect(sels.pop()).toEqual({ kind: 'building', id: 'pb1' })
    tagged('district', 'b1').click() // not a district: the kind its id names
    expect(sels.pop()).toEqual({ kind: 'building', id: 'b1' })
    tagged('tech', 'electron').click()
    expect(sels.pop()).toEqual({ kind: 'tech', id: 'electron' })
    tagged('tech', 'd1').click()
    expect(sels.pop()).toEqual({ kind: 'district', id: 'd1' })
  })
})

describe('2D fallback: dispose', () => {
  it('removes listeners, empties the list, and ignores later loads, layers and themes', async () => {
    const { viewer, item, sels, cards, host, esc } = setup({ reducedMotion: true })
    const li = item('building', 'b1')
    viewer.dispose()
    expect(host.innerHTML).toBe('')
    host.appendChild(li)
    li.click()
    esc()
    expect(sels).toEqual([])
    expect(cards).toEqual([])
    viewer.load(rich())
    viewer.setLayers({ labels: 'tech' })
    viewer.setPaused(true) // no renderer in 2D: nothing to pause, and no throw
    viewer.setTheme('glass')
    await viewer.apply({ type: 'openCard', id: 'b1' })
    expect(host.querySelector('section.world-fallback')).toBeNull()
    expect(viewer.getSelection()).toEqual([])
    expect(() => viewer.dispose()).not.toThrow() // twice is fine
  })

  it('leaves host content that is not its own list', () => {
    const host = document.createElement('div')
    const viewer = createWorldViewer(host, { reducedMotion: true })
    host.innerHTML = '<p>host owned</p>'
    viewer.dispose()
    expect(host.innerHTML).toBe('<p>host owned</p>')
  })
})

// ---------------------------------------------------------------------------------------------
// WebGL wiring, against a stand-in renderer.

/** What the stand-in reports as its motions and drawn result. */
const MOTION = {
  ringAngle: 1, fogDrift: 2, wirePulse: 3, selectionRingAngle: 4, bloom: true, stars: 3500, dust: 600, platformSides: { d1: 6 }, platformLights: 1,
  floorOrder: { b1: ['ui', 'logic'] }, orbs: ['x-api'], exploded: 'b1', explodeGap: 2.5, flight: { active: true, t: 0.5, eased: 0.5 }, lineLabels: 3,
}

function fakeRenderer(host: HTMLElement) {
  const canvas = document.createElement('canvas')
  host.appendChild(canvas)
  let hit: RenderPick | null = null
  const r = {
    canvas,
    draw: vi.fn(), setTheme: vi.fn(), setRightReserve: vi.fn(), setBottomReserve: vi.fn(), setCardReserve: vi.fn(), setFocus: vi.fn(), setSelected: vi.fn(), setExploded: vi.fn(),
    getCamera: vi.fn(() => ({ pos: [1, 2, 3] as [number, number, number], target: [4, 5, 6] as [number, number, number] })), flyTo: vi.fn(async () => undefined),
    frame: vi.fn(async () => undefined), overview: vi.fn(async () => undefined), pulse: vi.fn(async () => undefined),
    stopPulses: vi.fn(), pick: vi.fn(() => hit), setCursor: vi.fn(), setHovered: vi.fn(), visibleIds: vi.fn(() => ['b1']), isShown: vi.fn((id: string) => id !== 'b1'),
    screenPoint: vi.fn((id: string) => (id === 'b1' ? { x: 5, y: 6 } : null)),
    linePoints: vi.fn((id: string) => (id === 'e1' ? [{ x: 7, y: 8 }] : [])),
    drawnCounts: vi.fn(() => ({ processShells: 2, conduits: 3, changing: 1, tier: 'floors' as const, drawCalls: 42, buildings: 4, districts: 2, slabs: 0, slabLooks: [] })),
    motionState: vi.fn(() => ({ ...MOTION })),
    keepGhosts: vi.fn(), animateChanges: vi.fn(), stopChanges: vi.fn(), setPaused: vi.fn(),
    dispose: vi.fn(() => { canvas.remove() }),
  } satisfies ThreeRenderer
  return { r, aim: (h: RenderPick | null): void => { hit = h } }
}

function withWebGL(): void {
  getContext.mockReturnValue({ getExtension: () => null } as never)
}

describe('WebGL path (stand-in renderer)', () => {
  function setup3d() {
    withWebGL()
    let fake: ReturnType<typeof fakeRenderer> | null = null
    createThreeRenderer.mockImplementation((host: HTMLElement) => { fake = fakeRenderer(host); return fake.r })
    const s = setup({ reducedMotion: true })
    if (!fake) throw new Error('renderer not created')
    const f = fake as ReturnType<typeof fakeRenderer>
    const at = (type: string, x = 10, y = 10): void => { f.r.canvas.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, bubbles: true })) }
    return { ...s, ...f, at }
  }

  it('draws through the renderer and selects what a click picks; an empty click deselects', () => {
    const { r, aim, at, sels, lastCard, host } = setup3d()
    expect(r.draw).toHaveBeenCalled()
    expect(host.querySelector('section.world-fallback')).toBeNull()
    aim({ kind: 'node', id: 'b1' })
    at('pointerdown'); at('click')
    expect(sels.pop()).toEqual({ kind: 'building', id: 'b1' })
    expect(r.setSelected).toHaveBeenLastCalledWith('b1')
    // Framed with its neighbours in view: b2 (by e1) and b4 (by e2), never itself.
    const around = r.frame.mock.calls[r.frame.mock.calls.length - 1] as unknown as [string[], boolean, string[]]
    expect(around.slice(0, 2)).toEqual([['b1'], true])
    expect([...around[2]].sort()).toEqual(['b2', 'b4'])
    aim({ kind: 'edge', id: 'e1' })
    at('click')
    expect(sels.pop()).toEqual({ kind: 'edge', id: 'e1' })
    expect(r.setSelected).toHaveBeenLastCalledWith('e1') // a selected line keeps the buildings up from far away
    expect(r.frame).toHaveBeenLastCalledWith(['e1'], true) // a line is framed on its own
    // From far away a click on a district's slab focuses the district.
    aim({ kind: 'district', id: 'd1' })
    at('click')
    expect(sels.pop()).toEqual({ kind: 'district', id: 'd1' })
    aim(null)
    at('click')
    expect(sels.pop()).toBeNull()
    expect(lastCard()).toBeNull()
  })

  it('a double-click on the 3D view, or on a name drawn over it, never selects page text; a first press and the 2D list keep the default (film bug 5)', () => {
    const { r, host, viewer } = setup3d()
    const press = (target: EventTarget, detail: number): boolean =>
      target.dispatchEvent(new MouseEvent('mousedown', { detail, bubbles: true, cancelable: true }))
    expect(press(r.canvas, 1)).toBe(true) // a first press: focus and dragging work as ever
    expect(press(r.canvas, 2)).toBe(false) // the second press of a double-click selects no words
    const label = document.createElement('div')
    host.appendChild(label)
    expect(press(label, 3)).toBe(false)
    viewer.dispose()
    expect(press(r.canvas, 2)).toBe(true)
    // The 2D list is text: a double-click there may select a word.
    getContext.mockReturnValue(null)
    const flatHost = document.createElement('div')
    document.body.appendChild(flatHost)
    const flat = createWorldViewer(flatHost)
    flat.load(rich())
    expect(press(flatHost.querySelector('section.world-fallback') as Element, 2)).toBe(true)
  })

  it('a card opened by a click or double-click on the map says so; one opened any other way does not (fix wave M1)', () => {
    const { aim, at, fromClicks, viewer } = setup3d()
    aim({ kind: 'node', id: 'b1' })
    at('pointerdown'); at('click')
    expect(fromClicks.pop()).toBe(true)
    at('dblclick')
    expect(fromClicks.pop()).toBe(true)
    void viewer.apply({ type: 'openCard', id: 'b2' }) // an answer's step
    expect(fromClicks.pop()).toBe(false)
    aim(null)
    at('click', 300, 300)
    expect(fromClicks.pop()).toBe(false) // the card closes: nothing to let clicks through
  })

  it("a big building's card names the double-click only in the 3D city, where a double-click opens its floors", async () => {
    const big = (): WorldDoc => {
      const d = rich()
      const floors = [{ name: 'a', tech: [], members: [] }, { name: 'b', tech: [], members: [] }]
      const members = Array.from({ length: 40 }, (_, i) => `src/big/f${i}.ts`)
      d.buildings.push(building('big', { members, floors, growth: { start: 'folder', seed: 'src/big', merged: 0, mergedFiles: 0, folded: 0, cap: 60 } }))
      return d
    }
    const { viewer, lastCard } = setup3d()
    viewer.load(big())
    await viewer.apply({ type: 'openCard', id: 'big' })
    expect(lastCard()).toContain('40 files. It started as the src/big folder. Double-click it to see its floors.')
    getContext.mockReturnValue(null)
    const flat = setup({ reducedMotion: true, doc: big() })
    await flat.viewer.apply({ type: 'openCard', id: 'big' })
    expect(flat.lastCard()).toContain('40 files. It started as the src/big folder.')
    expect(flat.lastCard()).not.toContain('Double-click')
  })

  it('ignores a click that ends a drag', () => {
    const { aim, at, sels } = setup3d()
    aim({ kind: 'node', id: 'b1' })
    at('pointerdown', 10, 10)
    at('click', 40, 10)
    expect(sels).toEqual([])
  })

  it('picks a click at its pointerup point: Chromium cuts a click to whole pixels, and a building edge sits in between', () => {
    const { r, aim, at, sels } = setup3d()
    aim({ kind: 'node', id: 'b1' })
    // The e2e jitter's -2,0 click: pressed at 1111.4, the click arrives as 1111, where routes ends.
    at('pointerdown', 1111.4, 341.3); at('pointerup', 1111.4, 341.3); at('click', 1111, 341)
    expect(r.pick).toHaveBeenLastCalledWith(1111.4, 341.3)
    expect(sels.pop()).toEqual({ kind: 'building', id: 'b1' })
    at('dblclick', 1111, 341)
    expect(r.pick).toHaveBeenLastCalledWith(1111.4, 341.3)
    // A pointerup under another pixel is not this click's (a click raised without a pointer):
    // the click's own point is used.
    at('click', 20, 341)
    expect(r.pick).toHaveBeenLastCalledWith(20, 341)
    at('click', 1111, 30)
    expect(r.pick).toHaveBeenLastCalledWith(1111, 30)
  })

  it('double-click opens a building but never an external orb', () => {
    const { r, aim, at, sels } = setup3d()
    aim({ kind: 'node', id: 'x1' })
    at('dblclick')
    expect(r.setExploded).not.toHaveBeenCalledWith('x1')
    expect(sels.pop()).toEqual({ kind: 'building', id: 'x1' })
    aim({ kind: 'node', id: 'b1' })
    at('dblclick')
    expect(r.setExploded).toHaveBeenLastCalledWith('b1')
    at('dblclick')
    expect(r.setExploded).toHaveBeenLastCalledWith(null)
    aim({ kind: 'edge', id: 'e1' })
    r.setExploded.mockClear()
    at('dblclick')
    expect(r.setExploded).not.toHaveBeenCalled()
  })

  it('the first double-click on a building not yet selected opens it, though the camera flies off under the pointer (film bug 6)', () => {
    const { r, aim, at, sels, viewer } = setup3d()
    const click = (type: string, detail: number, x = 10, y = 10): void => { r.canvas.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, detail, bubbles: true })) }
    aim({ kind: 'node', id: 'b1' })
    at('pointerdown'); at('pointerup'); click('click', 1)
    expect(sels.pop()).toEqual({ kind: 'building', id: 'b1' })
    // The camera now flies to b1: under the pointer there is bare ground by the second click.
    aim(null)
    at('pointerdown'); at('pointerup'); click('click', 2)
    expect(sels).toEqual([]) // the second click of the pair does not deselect
    click('dblclick', 2)
    expect(r.setExploded).toHaveBeenLastCalledWith('b1')
    expect(viewer.getSelection()).toEqual(['b1'])
    // A double-click away from the last click picks what is under it now.
    aim({ kind: 'node', id: 'b2' })
    click('dblclick', 2, 200, 200)
    expect(r.setExploded).toHaveBeenLastCalledWith('b2')
    // A second click far from the first is a click of its own.
    aim(null)
    click('click', 2, 400, 400)
    expect(sels.pop()).toBeNull()
  })

  it('a newer world of the same project keeps the open building, the selection, its card and the camera (film bug 6)', () => {
    const { r, aim, at, sels, viewer, lastCard } = setup3d()
    aim({ kind: 'node', id: 'b1' })
    at('dblclick')
    expect(r.setExploded).toHaveBeenLastCalledWith('b1')
    sels.length = 0
    r.overview.mockClear()
    const next = rich()
    next.generatedAt += 1
    next.buildings[0].name = 'Desktop app, labelled'
    viewer.load(next, { animateFrom: rich() })
    expect(r.setExploded).toHaveBeenLastCalledWith('b1')
    expect(r.setSelected).toHaveBeenLastCalledWith('b1')
    expect(viewer.getSelection()).toEqual(['b1'])
    expect(sels).toEqual([])
    expect(lastCard()).toContain('Desktop app, labelled')
    expect(r.overview).not.toHaveBeenCalled()
    const lit = r.setFocus.mock.calls[r.setFocus.mock.calls.length - 1][0] as { ids: Set<string> }
    expect(lit.ids.has('b2')).toBe(true)
    // The open building and the selection can differ: each is kept on its own.
    aim({ kind: 'edge', id: 'e1' })
    at('click')
    viewer.load(rich())
    expect(r.setExploded).toHaveBeenLastCalledWith('b1')
    expect(viewer.getSelection()).toEqual(['e1'])
  })

  /** The same world after a Re-layout: every part at a new spot, in the layout's next round. */
  const relaidOut = (round = 1): WorldDoc => {
    const d = rich()
    d.generatedAt += 1
    for (const [id, [x, y, z]] of Object.entries(d.layout.positions)) d.layout.positions[id] = [x + 40, y, z - 40]
    d.layout.round = round
    return d
  }

  it('a watched change that re-places parts in a shrunken district is no Re-layout: the camera and the open building stay (round 2 N4)', () => {
    const { r, aim, at, viewer } = setup3d()
    aim({ kind: 'node', id: 'b1' })
    at('dblclick')
    r.overview.mockClear()
    r.frame.mockClear()
    r.setExploded.mockClear()
    const shifted = rich()
    shifted.generatedAt += 1
    for (const [id, [x, y, z]] of Object.entries(shifted.layout.positions)) shifted.layout.positions[id] = [x - 3, y, z + 3]
    viewer.load(shifted, { animateFrom: rich() })
    expect(r.setExploded).not.toHaveBeenCalledWith(null)
    expect(r.overview).not.toHaveBeenCalled()
    expect(r.frame).not.toHaveBeenCalled()
    // A second Re-layout is a new round too, and a world that keeps its round keeps the camera.
    viewer.load(relaidOut(1))
    expect(r.frame).toHaveBeenCalledTimes(1)
    viewer.load(relaidOut(1))
    expect(r.frame).toHaveBeenCalledTimes(1)
    viewer.load(relaidOut(2))
    expect(r.frame).toHaveBeenCalledTimes(2)
    // A world that lost its round (a compile with no stored world, say) is not known to be a Re-layout: the view stays.
    const unknown = relaidOut(2)
    delete unknown.layout.round
    viewer.load(unknown)
    expect(r.frame).toHaveBeenCalledTimes(2)
  })

  it('a re-layout of the same project closes the open building and flies to the kept selection at its new spot (fix wave I3)', () => {
    const { r, aim, at, sels, viewer, lastCard } = setup3d()
    aim({ kind: 'node', id: 'b1' })
    at('dblclick')
    expect(r.setExploded).toHaveBeenLastCalledWith('b1')
    sels.length = 0
    r.overview.mockClear()
    r.frame.mockClear()
    viewer.load(relaidOut())
    expect(r.setExploded).toHaveBeenLastCalledWith(null)
    expect(viewer.getSelection()).toEqual(['b1'])
    expect(sels).toEqual([])
    expect(lastCard()).not.toBeNull()
    expect(r.frame).toHaveBeenCalledTimes(1)
    expect(r.frame.mock.calls[0][0]).toContain('b1')
    expect(r.overview).not.toHaveBeenCalled()
  })

  it('a re-layout with nothing selected refits the overview; a part that stays put keeps the camera (fix wave I3)', () => {
    const { r, viewer } = setup3d()
    r.overview.mockClear()
    r.frame.mockClear()
    // A newer world with one new part, the rest where they were: the camera stays.
    const grown = rich()
    grown.layout.positions.fresh = [90, 0, 90]
    viewer.load(grown)
    expect(r.overview).not.toHaveBeenCalled()
    viewer.load(relaidOut())
    expect(r.overview).toHaveBeenCalledTimes(1)
    expect(r.frame).not.toHaveBeenCalled()
  })

  it('a newer world of the same project that drops the open building closes it and clears the selection, keeping the camera', () => {
    const { r, aim, at, sels, viewer, lastCard } = setup3d()
    aim({ kind: 'node', id: 'b1' })
    at('dblclick')
    sels.length = 0
    r.overview.mockClear()
    const next = rich()
    next.buildings = next.buildings.filter((b) => b.id !== 'b1')
    next.edges = next.edges.filter((e) => e.from !== 'b1' && e.to !== 'b1')
    viewer.load(next)
    expect(r.setExploded).toHaveBeenLastCalledWith(null)
    expect(viewer.getSelection()).toEqual([])
    expect(sels).toEqual([null])
    expect(lastCard()).toBeNull()
    expect(r.overview).not.toHaveBeenCalled()
  })

  it('an external stays selected across a newer world, and another project starts afresh', () => {
    const { r, aim, at, sels, viewer } = setup3d()
    aim({ kind: 'node', id: 'x1' })
    at('click')
    viewer.load(rich())
    expect(viewer.getSelection()).toEqual(['x1'])
    aim({ kind: 'node', id: 'b1' })
    at('dblclick')
    sels.length = 0
    r.overview.mockClear()
    viewer.load({ ...rich(), projectKey: 'another' })
    expect(r.setExploded).toHaveBeenLastCalledWith(null)
    expect(viewer.getSelection()).toEqual([])
    expect(sels).toEqual([null])
    expect(r.overview).toHaveBeenCalledWith(true)
  })

  it('Esc and resetView fly to the overview and close any open building', () => {
    const { r, aim, at, esc, viewer } = setup3d()
    aim({ kind: 'node', id: 'b1' })
    at('dblclick')
    r.overview.mockClear()
    esc()
    expect(r.setExploded).toHaveBeenLastCalledWith(null)
    expect(r.overview).toHaveBeenCalledWith(true)
    expect(r.stopPulses).toHaveBeenCalled()
    viewer.resetView()
    expect(r.overview).toHaveBeenCalledTimes(2)
  })

  it('hover emits the picked id once per change, and null on leave', () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.push(cb); return frames.length })
    const { aim, at, viewer, r } = setup3d()
    const hovers: (string | null)[] = []
    viewer.on('hover', (id) => { hovers.push(id) })
    const flush = (): void => { for (const f of frames.splice(0)) f(0) }
    aim({ kind: 'node', id: 'b1' })
    at('pointermove'); at('pointermove') // throttled to one frame
    expect(frames).toHaveLength(1)
    flush()
    at('pointermove'); flush()
    expect(hovers).toEqual(['b1'])
    expect(r.setCursor).toHaveBeenLastCalledWith(true)
    expect(r.setHovered).toHaveBeenLastCalledWith('b1') // its name shows at any distance
    aim({ kind: 'edge', id: 'e1' })
    at('pointermove'); flush()
    expect(r.setHovered).toHaveBeenLastCalledWith(null) // a line has no name label to light
    at('pointerleave')
    at('pointerleave')
    expect(hovers).toEqual(['b1', 'e1', null])
    expect(r.setHovered).toHaveBeenLastCalledWith(null)
  })

  it('hovering a district slab (from far away) lights the connections of all its buildings', () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.push(cb); return frames.length })
    const { aim, at, r, viewer } = setup3d()
    const hovers: (string | null)[] = []
    viewer.on('hover', (id) => { hovers.push(id) })
    const flush = (): void => { for (const f of frames.splice(0)) f(0) }
    const lastFocus = () => r.setFocus.mock.calls[r.setFocus.mock.calls.length - 1][0] as { ids: Set<string>; edgeIds: Set<string>; hover?: boolean } | null
    aim({ kind: 'district', id: 'd1' })
    at('pointermove'); flush()
    expect(hovers).toEqual(['d1'])
    expect(r.setCursor).toHaveBeenLastCalledWith(true)
    expect(r.setHovered).toHaveBeenLastCalledWith(null) // no building name: the slab is the district
    expect(lastFocus()).toMatchObject({ hover: true })
    expect([...(lastFocus()?.ids ?? [])]).toEqual(expect.arrayContaining(['b1', 'b2', 'b3', 'b4']))
    aim({ kind: 'district', id: 'd9' }) // a district without buildings lights nothing
    at('pointermove'); flush()
    expect(lastFocus()).toBeNull()
    aim({ kind: 'district', id: 'd1' })
    at('pointermove'); flush()
    at('pointerleave')
    expect(lastFocus()).toBeNull()
  })

  it('hovering a building lights its connections and dims the rest; leaving restores the selection', () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.push(cb); return frames.length })
    const { aim, at, r } = setup3d()
    const flush = (): void => { for (const f of frames.splice(0)) f(0) }
    const lastFocus = () => r.setFocus.mock.calls[r.setFocus.mock.calls.length - 1][0] as { ids: Set<string>; edgeIds: Set<string>; hover?: boolean; passive?: Set<string> } | null
    aim({ kind: 'edge', id: 'e3' }) // the selection: line b3 to x1
    at('pointerdown'); at('click')
    aim({ kind: 'node', id: 'b1' })
    at('pointermove'); flush()
    expect([...(lastFocus()?.ids ?? [])].sort()).toEqual(['b1', 'b2', 'b4'])
    expect([...(lastFocus()?.edgeIds ?? [])].sort()).toEqual(['e1', 'e2']) // their labels show (renderer: focus shows edge labels)
    expect(lastFocus()).toMatchObject({ hover: true })
    expect([...(lastFocus()?.passive ?? [])].sort()).toEqual(['e1', 'e2']) // and let a click through to the building under them
    aim({ kind: 'edge', id: 'e1' })
    at('pointermove'); flush()
    expect([...(lastFocus()?.edgeIds ?? [])]).toEqual(['e3']) // a hovered line lights nothing: back to the selection
    expect(lastFocus()).not.toHaveProperty('hover') // the selection's labels stay clickable
    aim({ kind: 'node', id: 'b1' })
    at('pointermove'); flush()
    at('pointerleave')
    expect([...(lastFocus()?.edgeIds ?? [])]).toEqual(['e3'])
    aim({ kind: 'node', id: 'b2' })
    at('pointerdown'); at('click')
    aim(null)
    at('pointermove'); flush()
    expect(r.setCursor).toHaveBeenLastCalledWith(false)
    expect([...(lastFocus()?.ids ?? [])].sort()).toEqual(['b1', 'b2'])
    // Hovering b1 while b2 is selected: their shared line e1 is the selection's own and stays clickable.
    aim({ kind: 'node', id: 'b1' })
    at('pointermove'); flush()
    expect([...(lastFocus()?.passive ?? [])]).toEqual(['e2'])
  })

  it('a hover over a selection keeps its tier hold, and Esc with the pointer still on a building lets it go', () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.push(cb); return frames.length })
    const { aim, at, r, viewer } = setup3d()
    const flush = (): void => { for (const f of frames.splice(0)) f(0) }
    const lastFocus = () => r.setFocus.mock.calls[r.setFocus.mock.calls.length - 1][0] as { hover?: boolean; held?: boolean } | null
    aim({ kind: 'node', id: 'b1' })
    at('pointermove'); flush()
    expect(lastFocus()).toMatchObject({ hover: true, held: false }) // a hover alone holds nothing
    at('pointerdown'); at('click')
    expect(lastFocus()).toMatchObject({ hover: true, held: true }) // over the selection's focus
    viewer.resetView() // Esc, the pointer still on b1
    expect(lastFocus()).toMatchObject({ hover: true, held: false })
  })

  it('keeps the hover while the pointer is on a lit connection label, and ends it when the pointer leaves the label', () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.push(cb); return frames.length })
    const { aim, at, r, host } = setup3d()
    const label = document.createElement('div')
    label.className = 'lw-edge'
    const inner = document.createElement('span')
    label.appendChild(inner)
    host.appendChild(label)
    const outside = document.createElement('div')
    document.body.appendChild(outside)
    const leave = (el: Element, to: Element | null): void => { el.dispatchEvent(new MouseEvent('pointerleave', { relatedTarget: to })) }
    aim({ kind: 'node', id: 'b1' })
    at('pointermove'); for (const f of frames.splice(0)) f(0)
    r.setHovered.mockClear()
    leave(r.canvas, inner) // onto a label (its child): still hovering b1
    expect(r.setHovered).not.toHaveBeenCalled()
    leave(label, r.canvas) // back to the canvas: pointermove decides, nothing is dropped
    expect(r.setHovered).not.toHaveBeenCalled()
    leave(r.canvas, label)
    leave(label, outside) // off the label to elsewhere: the hover ends
    expect(r.setHovered).toHaveBeenLastCalledWith(null)
    r.setHovered.mockClear()
    leave(r.canvas, label) // nothing hovered: a label is just elsewhere, and nothing is listened for
    leave(label, outside)
    expect(r.setHovered).not.toHaveBeenCalled()
    aim({ kind: 'node', id: 'b2' })
    at('pointermove'); for (const f of frames.splice(0)) f(0)
    r.setHovered.mockClear()
    leave(r.canvas, outside.appendChild(Object.assign(document.createElement('div'), { className: 'lw-edge' }))) // a label not in this map
    expect(r.setHovered).toHaveBeenLastCalledWith(null)
    outside.remove()
  })

  it('keeps the hovered building lit across a redraw, and forgets it when a new world drops it', () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.push(cb); return frames.length })
    const { aim, at, r, viewer } = setup3d()
    aim({ kind: 'node', id: 'b1' })
    at('pointermove'); for (const f of frames.splice(0)) f(0)
    r.setHovered.mockClear()
    viewer.setLayers({ allLineLabels: true })
    expect(r.setHovered).toHaveBeenLastCalledWith('b1')
    const lit = r.setFocus.mock.calls[r.setFocus.mock.calls.length - 1][0] as { ids: Set<string> }
    expect(lit.ids.has('b2')).toBe(true)
    const next = minimal()
    next.buildings = next.buildings.filter((b) => b.id !== 'b1')
    next.edges = []
    viewer.load(next)
    expect(r.setHovered).toHaveBeenLastCalledWith(null)
    expect(r.setFocus).toHaveBeenLastCalledWith(null)
  })

  it('subtitles a district with its role, or with its parts and files when the model wrote none', () => {
    const { r, viewer } = setup3d()
    const districts = (): Record<string, string> => (r.draw.mock.calls[r.draw.mock.calls.length - 1][1] as { districts: Record<string, string> }).districts
    expect(districts().d1).toBe('The app and its memory')
    const doc = rich()
    doc.districts[0].subtitle = ' '
    doc.districts[1].subtitle = ''
    doc.buildings.push(building('b5', { districtId: 'd2', members: ['a.ts'] }))
    viewer.load(doc)
    expect(districts().d1).toBe('4 parts · 2 files')
    expect(districts().d2).toBe('1 part · 1 file')
  })

  it('setPaused stops and restarts the renderer, and does nothing after dispose', () => {
    const { r, viewer } = setup3d()
    viewer.setPaused(true)
    expect(r.setPaused).toHaveBeenLastCalledWith(true)
    viewer.setPaused(false)
    expect(r.setPaused).toHaveBeenLastCalledWith(false)
    viewer.dispose()
    r.setPaused.mockClear()
    viewer.setPaused(true)
    expect(r.setPaused).not.toHaveBeenCalled()
  })

  it('apply drives the renderer: focus frames, highlight lights, flow pulses, draftProposal redraws', async () => {
    const { r, viewer } = setup3d()
    await viewer.apply({ type: 'focus', ids: ['b1'] })
    expect(r.frame).toHaveBeenLastCalledWith(['b1'], true)
    r.frame.mockClear()
    await viewer.apply({ type: 'highlight', ids: ['b1', 'b2'] })
    expect(r.frame).not.toHaveBeenCalled()
    const lit = r.setFocus.mock.calls[r.setFocus.mock.calls.length - 1][0] as { ids: Set<string>; edgeIds: Set<string> }
    expect([...lit.ids].sort()).toEqual(['b1', 'b2'])
    expect([...lit.edgeIds]).toEqual(['e1']) // the edge joining two named nodes
    await viewer.apply({ type: 'flow', edgeIds: ['e1'] })
    expect(r.pulse).toHaveBeenLastCalledWith(['e1'], true)
    const draws = r.draw.mock.calls.length
    await viewer.apply({ type: 'draftProposal', proposalId: 'p1' })
    expect(r.draw.mock.calls.length).toBe(draws + 1)
    await viewer.apply({ type: 'tour', steps: [{ ids: ['b1'], caption: 'c' }] })
    expect(r.frame).toHaveBeenLastCalledWith(['b1'], true)
    await viewer.apply({ type: 'reset' })
    expect(r.overview).toHaveBeenLastCalledWith(true)
    expect(viewer.cameraRegion()).toEqual(['b1'])
  })

  it('drawn reports what a highlight lit, and nothing once the focus is gone', async () => {
    const { viewer } = setup3d()
    await viewer.apply({ type: 'highlight', ids: ['b1', 'b2'] })
    expect([...viewer.drawn().highlighted].sort()).toEqual(['b1', 'b2', 'e1'])
    await viewer.apply({ type: 'reset' })
    expect(viewer.drawn().highlighted).toEqual([])
  })

  it('screenPoint, linePoints, pickAt and drawn come from the renderer', () => {
    const { viewer, r, aim } = setup3d()
    expect(viewer.screenPoint('b1')).toEqual({ x: 5, y: 6 })
    expect(viewer.screenPoint('nope')).toBeNull()
    expect(viewer.linePoints('e1')).toEqual([{ x: 7, y: 8 }])
    expect(viewer.linePoints('nope')).toEqual([])
    aim({ kind: 'edge', id: 'e1' })
    expect(viewer.pickAt(3, 4)).toEqual({ kind: 'edge', id: 'e1' })
    expect(r.pick).toHaveBeenLastCalledWith(3, 4)
    expect(viewer.drawn()).toEqual({ layers: DEFAULT_LAYERS, processShells: 2, conduits: 3, changing: 1, tier: 'floors', drawCalls: 42, buildings: 4, districts: 2, slabs: 0, slabLooks: [], wireframes: ['b4'], shownWireframes: ['b4'], outlined: [], fading: [], hot: [], fogged: [], highlighted: [], visual: MOTION })
  })

  it('viewer.apply(fog) fogs the ids until the next reset; a highlight keeps the fog; resetView, load and an empty fog lift it', async () => {
    const { viewer, r } = setup3d()
    await viewer.apply({ type: 'fog', ids: ['b1'] })
    expect(viewer.drawn().fogged).toEqual(['b1'])
    expect((r.draw.mock.calls.at(-1)![0] as { buildings: { id: string; look: string }[] }).buildings.find((b) => b.id === 'b1')!.look).toBe('fog')
    await viewer.apply({ type: 'highlight', ids: ['b1'] })
    expect(viewer.drawn().fogged).toEqual(['b1'])
    await viewer.apply({ type: 'reset' })
    expect(viewer.drawn().fogged).toEqual([])
    await viewer.apply({ type: 'fog', ids: ['b1', 'b2'] })
    viewer.resetView()
    expect(viewer.drawn().fogged).toEqual([])
    viewer.resetView()
    await viewer.apply({ type: 'fog', ids: ['b1'] })
    await viewer.apply({ type: 'fog', ids: [] })
    expect(viewer.drawn().fogged).toEqual([])
    await viewer.apply({ type: 'fog', ids: ['b1'] })
    viewer.load(rich())
    expect(viewer.drawn().fogged).toEqual([])
  })

  it('drawn lists the buildings drawn as wireframes (planned, not built), and hides them with the planned layer off', () => {
    const { viewer } = setup3d()
    const d = rich()
    viewer.load({ ...d, buildings: d.buildings.map((b, i) => (i === 0 ? { ...b, status: 'proposed' as const } : b)) })
    expect(viewer.drawn().wireframes).toEqual(['b1', 'b4'])
    // The renderer shows b4 and not b1 (setup3d's isShown): only b4 is on screen (round 3 A)
    expect(viewer.drawn().shownWireframes).toEqual(['b4'])
    viewer.setLayers({ planned: false })
    expect(viewer.drawn().wireframes).toEqual([])
  })

  it('setTheme hands the palette to the renderer; setLayers redraws', () => {
    const { r, viewer } = setup3d()
    viewer.setTheme('glass')
    expect(r.setTheme).toHaveBeenLastCalledWith('glass', expect.objectContaining({ background: expect.any(String) }))
    const draws = r.draw.mock.calls.length
    viewer.setLayers({ allLineLabels: true })
    expect(r.draw.mock.calls.length).toBe(draws + 1)
    expect(r.draw.mock.calls[draws][2]).toBe(true)
  })

  it('dispose frees the renderer and unhooks the canvas', () => {
    const { r, aim, at, viewer, sels } = setup3d()
    const canvas = r.canvas
    viewer.dispose()
    expect(r.dispose).toHaveBeenCalled()
    aim({ kind: 'node', id: 'b1' })
    at('click')
    canvas.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(r.pick).not.toHaveBeenCalled()
    expect(sels).toEqual([])
  })

  it('a click on a line label opens that line; before a world is loaded it opens nothing', () => {
    withWebGL()
    let fake: ReturnType<typeof fakeRenderer> | null = null
    createThreeRenderer.mockImplementation((h: HTMLElement) => { fake = fakeRenderer(h); return fake.r })
    const host = document.createElement('div')
    document.body.appendChild(host)
    const viewer = createWorldViewer(host) // no renderCard: the card is simply not shown
    const sels: (WorldSelection | null)[] = []
    viewer.on('select', (s) => { sels.push(s) })
    const onEdgeLabel = (createThreeRenderer.mock.calls[0][1] as { onEdgeLabel: (id: string) => void }).onEdgeLabel
    onEdgeLabel('e1')
    expect(sels).toEqual([])
    viewer.load(rich())
    onEdgeLabel('e1')
    expect(sels.pop()).toEqual({ kind: 'edge', id: 'e1' })
    expect((fake as ReturnType<typeof fakeRenderer> | null)?.r.frame).toHaveBeenLastCalledWith(['e1'], expect.any(Boolean))
  })

  it('passes a changed legend strip on to the renderer, and not after dispose', () => {
    withWebGL()
    let fake: ReturnType<typeof fakeRenderer> | null = null
    createThreeRenderer.mockImplementation((h: HTMLElement) => { fake = fakeRenderer(h); return fake.r })
    const host = document.createElement('div')
    document.body.appendChild(host)
    const v = createWorldViewer(host, { rightReserve: 244 })
    const r = (fake as unknown as ReturnType<typeof fakeRenderer>).r
    v.setRightReserve(108)
    expect(r.setRightReserve).toHaveBeenCalledWith(108)
    v.dispose()
    v.setRightReserve(244)
    expect(r.setRightReserve).toHaveBeenCalledTimes(1)
  })

  it('cameraState reads the renderer camera and setCamera flies it there, instantly under reduced motion, and neither does anything in 2D or after dispose', async () => {
    withWebGL()
    let fake: ReturnType<typeof fakeRenderer> | null = null
    createThreeRenderer.mockImplementation((h: HTMLElement) => { fake = fakeRenderer(h); return fake.r })
    const host = document.createElement('div')
    document.body.appendChild(host)
    const v = createWorldViewer(host, { reducedMotion: false })
    const r = (fake as unknown as ReturnType<typeof fakeRenderer>).r
    expect(v.cameraState()).toEqual({ pos: [1, 2, 3], target: [4, 5, 6] })
    const s = { pos: [7, 8, 9] as [number, number, number], target: [1, 1, 1] as [number, number, number] }
    await v.setCamera(s, false)
    expect(r.flyTo).toHaveBeenLastCalledWith(s, false)
    await v.setCamera(s, true)
    expect(r.flyTo).toHaveBeenLastCalledWith(s, true)
    const host2 = document.createElement('div')
    document.body.appendChild(host2)
    const calm = createWorldViewer(host2, { reducedMotion: true })
    await calm.setCamera(s, false)
    expect(r.flyTo).toHaveBeenLastCalledWith(s, true)
    v.dispose()
    const flights = r.flyTo.mock.calls.length
    await v.setCamera(s, false)
    expect(r.flyTo).toHaveBeenCalledTimes(flights)
    createThreeRenderer.mockReset()
    getContext.mockReturnValue(null)
    const flat = createWorldViewer(document.createElement('div'))
    expect(flat.cameraState()).toBeNull()
    await expect(flat.setCamera(s, false)).resolves.toBeUndefined()
  })

  it('the 2D map is headed by the title it was given, never the project key', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const doc = rich()
    const named = createWorldViewer(host, { title: 'termpolis' })
    named.load(doc)
    expect(host.querySelector('h2')?.textContent).toBe('termpolis')
    expect(host.innerHTML).not.toContain(doc.projectKey)
    const host2 = document.createElement('div')
    document.body.appendChild(host2)
    const plain = createWorldViewer(host2)
    plain.load(doc)
    expect(host2.querySelector('h2')?.textContent).toBe('This project')
    expect(host2.querySelector('svg[role="img"] rect[data-kind="building"]')).not.toBeNull()
  })

  it('has no renderer to tell about the legend without WebGL', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    expect(() => createWorldViewer(host).setRightReserve(108)).not.toThrow()
  })

  it('passes the legend strip to the renderer only when given one', () => {
    withWebGL()
    createThreeRenderer.mockImplementation((h: HTMLElement) => fakeRenderer(h).r)
    const host = document.createElement('div')
    document.body.appendChild(host)
    createWorldViewer(host, { rightReserve: 244 })
    createWorldViewer(host)
    expect(createThreeRenderer.mock.calls[0][1]).toMatchObject({ rightReserve: 244 })
    expect(createThreeRenderer.mock.calls[1][1]).not.toHaveProperty('rightReserve')
  })

  it('passes the ask bar strip on to the renderer, at creation and when it changes, and not after dispose', () => {
    withWebGL()
    let fake: ReturnType<typeof fakeRenderer> | null = null
    createThreeRenderer.mockImplementation((h: HTMLElement) => { fake = fakeRenderer(h); return fake.r })
    const host = document.createElement('div')
    document.body.appendChild(host)
    const v = createWorldViewer(host, { bottomReserve: 150 })
    const r = (fake as unknown as ReturnType<typeof fakeRenderer>).r
    expect(createThreeRenderer.mock.calls[0][1]).toMatchObject({ bottomReserve: 150 })
    createWorldViewer(host)
    expect(createThreeRenderer.mock.calls[1][1]).not.toHaveProperty('bottomReserve')
    v.setBottomReserve(170)
    expect(r.setBottomReserve).toHaveBeenCalledWith(170)
    v.dispose()
    v.setBottomReserve(90)
    expect(r.setBottomReserve).toHaveBeenCalledTimes(1)
    expect(() => createWorldViewer(document.createElement('div')).setBottomReserve(1)).not.toThrow()
  })

  it('the change toast follows the ask bar and the legend strips, in 3D and in 2D (film bug 9)', () => {
    withWebGL()
    createThreeRenderer.mockImplementation((h: HTMLElement) => fakeRenderer(h).r)
    const host = document.createElement('div')
    document.body.appendChild(host)
    const v = createWorldViewer(host, { bottomReserve: 72, rightReserve: 244 })
    v.load(rich())
    v.load({ ...rich(), buildings: rich().buildings.slice(1) }, { animateFrom: rich() })
    const el = host.querySelector('.lw-toast') as HTMLElement
    expect(el.style.bottom).toBe('72px')
    expect(el.style.left).toBe('calc(50% - 122px)')
    v.setBottomReserve(150)
    v.setRightReserve(108)
    expect(el.style.bottom).toBe('150px')
    expect(el.style.left).toBe('calc(50% - 54px)')
    createThreeRenderer.mockReset()
    getContext.mockReturnValue(null)
    const flatHost = document.createElement('div')
    document.body.appendChild(flatHost)
    const flat = createWorldViewer(flatHost)
    flat.load(rich())
    flat.setBottomReserve(90)
    flat.setRightReserve(40)
    flat.load({ ...rich(), buildings: rich().buildings.slice(1) }, { animateFrom: rich() })
    const flatEl = flatHost.querySelector('.lw-toast') as HTMLElement
    expect(flatEl.style.bottom).toBe('90px')
    expect(flatEl.style.left).toBe('calc(50% - 20px)')
  })

  it('passes the open card box on to the renderer, and not after dispose', () => {
    withWebGL()
    let fake: ReturnType<typeof fakeRenderer> | null = null
    createThreeRenderer.mockImplementation((h: HTMLElement) => { fake = fakeRenderer(h); return fake.r })
    const host = document.createElement('div')
    document.body.appendChild(host)
    const v = createWorldViewer(host)
    const r = (fake as unknown as ReturnType<typeof fakeRenderer>).r
    v.setCardReserve(352, 248)
    expect(r.setCardReserve).toHaveBeenCalledWith(352, 248)
    v.setCardReserve(0, 0)
    expect(r.setCardReserve).toHaveBeenLastCalledWith(0, 0)
    v.dispose()
    v.setCardReserve(352, 248)
    expect(r.setCardReserve).toHaveBeenCalledTimes(2)
    expect(() => createWorldViewer(document.createElement('div')).setCardReserve(1, 1)).not.toThrow()
  })

  it('a redraw keeps the open building or line lit and selected, and draws nothing before a world is loaded', () => {
    withWebGL()
    let fake: ReturnType<typeof fakeRenderer> | null = null
    createThreeRenderer.mockImplementation((h: HTMLElement) => { fake = fakeRenderer(h); return fake.r })
    const host = document.createElement('div')
    document.body.appendChild(host)
    const viewer = createWorldViewer(host, { reducedMotion: true })
    const f = fake as unknown as ReturnType<typeof fakeRenderer>
    viewer.setLayers({ allLineLabels: true })
    expect(f.r.draw).not.toHaveBeenCalled()
    viewer.load(rich())
    const at = (type: string): void => { f.r.canvas.dispatchEvent(new MouseEvent(type, { clientX: 1, clientY: 1, bubbles: true })) }
    f.aim({ kind: 'node', id: 'b1' })
    at('pointerdown'); at('click')
    f.r.setSelected.mockClear()
    viewer.setLayers({ allLineLabels: false })
    expect(f.r.setSelected).toHaveBeenLastCalledWith('b1')
    f.aim({ kind: 'edge', id: 'e1' })
    at('click')
    f.r.setSelected.mockClear()
    viewer.setLayers({ allLineLabels: true })
    expect(f.r.setSelected).toHaveBeenLastCalledWith('e1')
    const lit = f.r.setFocus.mock.calls[f.r.setFocus.mock.calls.length - 1][0] as { edgeIds: Set<string> }
    expect([...lit.edgeIds]).toContain('e1')
  })

  it('a hover before a world is loaded lights nothing, and a redraw with a district selected selects no building or line', () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.push(cb); return frames.length })
    withWebGL()
    let fake: ReturnType<typeof fakeRenderer> | null = null
    createThreeRenderer.mockImplementation((h: HTMLElement) => { fake = fakeRenderer(h); return fake.r })
    const host = document.createElement('div')
    document.body.appendChild(host)
    const viewer = createWorldViewer(host, { reducedMotion: true })
    const f = fake as unknown as ReturnType<typeof fakeRenderer>
    const at = (type: string): void => { f.r.canvas.dispatchEvent(new MouseEvent(type, { clientX: 3, clientY: 3, bubbles: true })) }
    f.aim({ kind: 'node', id: 'b1' })
    at('pointermove')
    frames.splice(0).forEach((cb) => cb(0))
    expect(f.r.setHovered).toHaveBeenLastCalledWith('b1')
    expect(f.r.setFocus).toHaveBeenLastCalledWith(null) // no world: the hover lights nothing
    at('pointerleave')
    viewer.load(rich())
    f.aim({ kind: 'district', id: 'd1' })
    at('pointerdown'); at('click')
    f.r.setSelected.mockClear()
    viewer.setLayers({ allLineLabels: true })
    expect(f.r.setSelected).toHaveBeenLastCalledWith(null)
    viewer.dispose()
    vi.unstubAllGlobals()
  })

  it('drawn lists the outlined, fading and hot buildings of the drawn model', () => {
    const { viewer } = setup3d()
    const d = rich()
    d.layout.positions.pm = [30, 0, 30]
    d.layers.plan.push({
      id: 'design:p', title: 'Linked design', summary: [],
      buildings: [building('pm', { status: 'proposed', districtId: 'd1' })], edges: [],
      reconcile: { matched: { auth: 'b1' }, missing: ['mailer'], extra: [], changed: ['b1'], planAt: 1 },
      removes: ['b2']
    })
    d.layers.live = { b4: { latencyMs: 400 } }
    viewer.load(d)
    expect(viewer.drawn()).toMatchObject({ outlined: [], fading: [], hot: ['b4'] })
    viewer.setLayers({ proposal: 'design:p' })
    expect(viewer.drawn()).toMatchObject({ outlined: ['b1'], fading: ['b2'], hot: ['b4'] })
  })

  it('names buildings by their technology with the tech layer, and a planned part or line never overrides a built one', () => {
    const { r, viewer } = setup3d()
    const d = rich()
    d.layers.plan[0].buildings.push(building('b1', { name: 'Planned b1', techLabel: 'Planned tech' }))
    d.layers.plan[0].edges.push({ ...d.edges[0], label: 'planned e1' })
    viewer.load(d)
    viewer.setLayers({ labels: 'tech' })
    const text = r.draw.mock.calls[r.draw.mock.calls.length - 1][1] as { labels: Record<string, string>; edges: Record<string, string> }
    expect(text.labels.b1).toBe('Electron + React')
    expect(text.edges.e1).toBe(d.edges[0].label)
  })

  it('counts the built lines at each part, once for a line to itself, for the semantic zoom', () => {
    const { r, viewer } = setup3d()
    const d = rich()
    d.edges.push({ ...d.edges[0], id: 'self', from: 'b2', to: 'b2' })
    viewer.load(d)
    const text = r.draw.mock.calls[r.draw.mock.calls.length - 1][1] as { importance: Record<string, number> }
    const want: Record<string, number> = {}
    for (const e of d.edges) for (const end of new Set([e.from, e.to])) want[end] = (want[end] ?? 0) + 1
    expect(text.importance).toEqual(want)
    expect(text.importance.b2).toBe(d.edges.filter((e) => e.from === 'b2' || e.to === 'b2').length)
    expect(text.importance.pb1).toBeUndefined()
  })

  it('shows a code-written line label as a short summary, and caps a long one', () => {
    const { r, viewer } = setup3d()
    const d = rich()
    d.edges[0].label = 'env TERMPOLIS_TEST_AGENTS, env TERMPOLIS_TEST_TIMING, env TERMPOLIS_E2E, ipc pty:data'
    d.edges[1].label = 'Sends every keystroke and resize event to the shell host'
    viewer.load(d)
    const text = r.draw.mock.calls[r.draw.mock.calls.length - 1][1] as { edges: Record<string, string> }
    expect(text.edges.e1).toBe('reads 3 settings +1 more')
    expect(text.edges.e2).toBe('Sends every keystroke and…')
  })

  it('a highlighted planned line not on show lights the line alone, not its ends', async () => {
    const { r, viewer } = setup3d()
    await viewer.apply({ type: 'highlight', ids: ['pe1'] })
    const lit = r.setFocus.mock.calls[r.setFocus.mock.calls.length - 1][0] as { ids: Set<string>; edgeIds: Set<string> }
    expect([...lit.edgeIds]).toEqual(['pe1'])
    expect([...lit.ids]).toEqual([])
  })

  it('ignores canvas events and a pending hover frame that arrive after dispose, and a label left after dispose', () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.push(cb); return frames.length })
    const cancel = vi.fn()
    vi.stubGlobal('cancelAnimationFrame', cancel)
    const { r, aim, at, host, viewer } = setup3d()
    aim({ kind: 'node', id: 'b1' })
    at('pointermove'); for (const f of frames.splice(0)) f(0)
    const label = document.createElement('div')
    label.className = 'lw-edge'
    host.appendChild(label)
    r.canvas.dispatchEvent(new MouseEvent('pointerleave', { relatedTarget: label })) // onto a lit label: still hovering
    at('pointermove') // a frame is pending at dispose
    r.canvas.removeEventListener = (): void => undefined // as if these events were already queued
    viewer.dispose()
    expect(cancel).toHaveBeenCalled()
    r.pick.mockClear()
    for (const f of frames.splice(0)) f(0)
    at('click'); at('dblclick')
    label.dispatchEvent(new MouseEvent('pointerleave', { relatedTarget: document.body }))
    expect(r.pick).not.toHaveBeenCalled()
  })

  it('falls back to the 2D list on a clean host when the renderer throws after adding its canvas', () => {
    withWebGL()
    createThreeRenderer.mockImplementation((host: HTMLElement) => {
      host.appendChild(document.createElement('canvas'))
      throw new Error('no context')
    })
    const { host, item, sels } = setup()
    expect(host.querySelector('canvas')).toBeNull()
    item('building', 'b1').click()
    expect(sels.pop()).toEqual({ kind: 'building', id: 'b1' })
  })

  it('keeps what the host held before when the renderer throws', () => {
    withWebGL()
    createThreeRenderer.mockImplementation((h: HTMLElement) => {
      h.appendChild(document.createElement('canvas'))
      throw new Error('no context')
    })
    const host = document.createElement('div')
    const mine = host.appendChild(document.createElement('p'))
    document.body.appendChild(host)
    createWorldViewer(host)
    expect(host.contains(mine)).toBe(true)
    expect(host.querySelector('canvas')).toBeNull()
  })

  it('disposes a renderer that throws after it was made (theme) and falls back', () => {
    withWebGL()
    let fake: ReturnType<typeof fakeRenderer> | null = null
    createThreeRenderer.mockImplementation((host: HTMLElement) => {
      fake = fakeRenderer(host)
      fake.r.setTheme.mockImplementation(() => { throw new Error('bad palette') })
      return fake.r
    })
    const { host } = setup()
    expect((fake as ReturnType<typeof fakeRenderer> | null)?.r.dispose).toHaveBeenCalled()
    expect(host.querySelector('canvas')).toBeNull()
    expect(host.querySelector('section.world-fallback')).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------------------------
// Watch it grow: load(doc, { animateFrom }) plays rise / pulse / fade and shows a toast.

describe('load with animateFrom', () => {
  /** rich() grown by two buildings, one changed (b2's status) and one removed (b4). */
  function grown(): { before: WorldDoc; after: WorldDoc } {
    const before = rich()
    const after = rich()
    after.generatedAt = before.generatedAt + 1
    after.buildings = after.buildings.filter((b) => b.id !== 'b4')
    after.buildings.find((b) => b.id === 'b2')!.status = 'gap'
    after.buildings.push(building('n1'), building('n2'))
    return { before, after }
  }
  const toast = (host: HTMLElement): HTMLElement | null => host.querySelector('.lw-toast')
  /** The toast the viewer shows: visible ones only. */
  const toastText = (host: HTMLElement): string | null => {
    const el = toast(host)
    return el && !el.hidden ? el.textContent : null
  }

  it('keeps removed parts before the redraw, then rises the new ones and pulses the changed ones', () => {
    const { before, after } = grown()
    const { r, viewer, host } = setup3dFrom(false, before)
    r.draw.mockClear()
    viewer.load(after, { animateFrom: before })
    expect(r.stopChanges).toHaveBeenCalled()
    expect(r.keepGhosts).toHaveBeenCalledWith(['b4'])
    expect(r.animateChanges).toHaveBeenCalledWith({ rise: ['n1', 'n2'], pulse: ['b2'] })
    const order = (f: { mock: { invocationCallOrder: number[] } }): number => f.mock.invocationCallOrder[0]
    expect(order(r.stopChanges)).toBeLessThan(order(r.keepGhosts))
    expect(order(r.keepGhosts)).toBeLessThan(order(r.draw))
    expect(order(r.draw)).toBeLessThan(order(r.animateChanges))
    expect(toastText(host)).toBe('+2 parts, 1 changed, 1 removed')
    expect(toast(host)?.getAttribute('aria-live')).toBe('polite')
  })

  it('rises at most 20 parts; the rest simply appear', () => {
    const before = minimal()
    const after = minimal()
    for (let i = 0; i < 25; i++) after.buildings.push(building(`n${i}`))
    const { r, viewer, host } = setup3dFrom(false, before)
    viewer.load(after, { animateFrom: before })
    const rise = (r.animateChanges.mock.calls[0][0] as { rise: string[] }).rise
    expect(rise).toHaveLength(20)
    expect(toastText(host)).toBe('+25 parts')
  })

  it('with reduced motion nothing animates, but the toast still shows', () => {
    const { before, after } = grown()
    const { r, viewer, host } = setup3dFrom(true, before)
    viewer.load(after, { animateFrom: before })
    expect(r.keepGhosts).not.toHaveBeenCalled()
    expect(r.animateChanges).not.toHaveBeenCalled()
    expect(r.stopChanges).toHaveBeenCalled() // anything still running from before ends
    expect(toastText(host)).toBe('+2 parts, 1 changed, 1 removed')
  })

  it('a load with no animateFrom (or an unchanged world) plays nothing and clears the toast', () => {
    const { before, after } = grown()
    const { r, viewer, host } = setup3dFrom(false, before)
    viewer.load(after, { animateFrom: before })
    expect(toastText(host)).not.toBeNull()
    r.animateChanges.mockClear()
    viewer.load(after)
    expect(r.animateChanges).not.toHaveBeenCalled()
    expect(toastText(host)).toBeNull()
    viewer.load(after, { animateFrom: after })
    expect(r.keepGhosts).toHaveBeenLastCalledWith([])
    expect(toastText(host)).toBeNull()
  })

  it('the toast takes the current theme and goes after about 3 s', () => {
    vi.useFakeTimers()
    const { before, after } = grown()
    const { viewer, host } = setup3dFrom(true, before)
    viewer.setTheme('blueprint')
    viewer.load(after, { animateFrom: before })
    expect(toast(host)?.style.color).toBe('rgb(240, 249, 255)') // blueprint text #f0f9ff
    vi.advanceTimersByTime(3000)
    expect(toastText(host)).toBeNull()
  })

  it('in 2D the toast shows over the list', () => {
    const { before, after } = grown()
    const { viewer, host } = setup({ reducedMotion: false, doc: before })
    viewer.load(after, { animateFrom: before })
    expect(host.querySelector('section.world-fallback')).not.toBeNull()
    expect(toastText(host)).toBe('+2 parts, 1 changed, 1 removed')
  })

  it('dispose takes the toast away and leaves no timer', () => {
    vi.useFakeTimers()
    const { before, after } = grown()
    const { viewer, host } = setup3dFrom(true, before)
    viewer.load(after, { animateFrom: before })
    viewer.dispose()
    expect(toast(host)).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  function setup3dFrom(reducedMotion: boolean, doc: WorldDoc) {
    withWebGL()
    let fake: ReturnType<typeof fakeRenderer> | null = null
    createThreeRenderer.mockImplementation((host: HTMLElement) => { fake = fakeRenderer(host); return fake.r })
    const s = setup({ reducedMotion, doc })
    return { ...s, ...(fake as unknown as ReturnType<typeof fakeRenderer>) }
  }
})
