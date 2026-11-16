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
import { minimal, rich } from './helpers'

const { createThreeRenderer } = vi.hoisted(() => ({ createThreeRenderer: vi.fn() }))
vi.mock('../../../src/renderer/src/world/engine/threeRenderer', () => ({ createThreeRenderer }))

type Card = string | null

function setup(opts: { reducedMotion?: boolean; doc?: WorldDoc } = {}) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const cards: Card[] = []
  const sels: (WorldSelection | null)[] = []
  const viewer = createWorldViewer(host, {
    ...(opts.reducedMotion === undefined ? {} : { reducedMotion: opts.reducedMotion }),
    renderCard: (html) => { cards.push(html) },
  })
  viewer.on('select', (s) => { sels.push(s) })
  viewer.load(opts.doc ?? rich())
  const item = (kind: string, id: string): HTMLElement => {
    const el = host.querySelector<HTMLElement>(`[data-kind="${kind}"][data-id="${id}"]`)
    if (!el) throw new Error(`no ${kind} ${id} in the list`)
    return el
  }
  const esc = (): void => { host.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) }
  return { host, viewer, cards, sels, item, esc, lastCard: (): Card | undefined => cards[cards.length - 1] }
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
    expect(host.querySelector('h2')?.textContent).toBe('second')
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
    expect(viewer.drawn()).toEqual({ layers: { ...DEFAULT_LAYERS, processes: true }, processShells: 0, conduits: 0 })
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

function fakeRenderer(host: HTMLElement) {
  const canvas = document.createElement('canvas')
  host.appendChild(canvas)
  let hit: RenderPick | null = null
  const r = {
    canvas,
    draw: vi.fn(), setTheme: vi.fn(), setFocus: vi.fn(), setSelected: vi.fn(), setExploded: vi.fn(),
    frame: vi.fn(async () => undefined), overview: vi.fn(async () => undefined), pulse: vi.fn(async () => undefined),
    stopPulses: vi.fn(), pick: vi.fn(() => hit), setCursor: vi.fn(), visibleIds: vi.fn(() => ['b1']),
    screenPoint: vi.fn((id: string) => (id === 'b1' ? { x: 5, y: 6 } : null)),
    drawnCounts: vi.fn(() => ({ processShells: 2, conduits: 3 })),
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
    expect(r.frame).toHaveBeenLastCalledWith(['b1'], true)
    aim({ kind: 'edge', id: 'e1' })
    at('click')
    expect(sels.pop()).toEqual({ kind: 'edge', id: 'e1' })
    expect(r.setSelected).toHaveBeenLastCalledWith(null)
    aim(null)
    at('click')
    expect(sels.pop()).toBeNull()
    expect(lastCard()).toBeNull()
  })

  it('ignores a click that ends a drag', () => {
    const { aim, at, sels } = setup3d()
    aim({ kind: 'node', id: 'b1' })
    at('pointerdown', 10, 10)
    at('click', 40, 10)
    expect(sels).toEqual([])
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
    at('pointerleave')
    at('pointerleave')
    expect(hovers).toEqual(['b1', null])
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

  it('screenPoint and drawn come from the renderer', () => {
    const { viewer } = setup3d()
    expect(viewer.screenPoint('b1')).toEqual({ x: 5, y: 6 })
    expect(viewer.screenPoint('nope')).toBeNull()
    expect(viewer.drawn()).toEqual({ layers: DEFAULT_LAYERS, processShells: 2, conduits: 3 })
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
