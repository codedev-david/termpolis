// threeRenderer: the CSS2D labels. They are made and removed with their objects and carry their
// text; which ones show (layLabels): the selected part's floors, the ranked building names within
// their budget (sticky past it), district names kept inside the view, every line's with "all line
// labels" on (always shown, even overlapping); sizes measured from the page; a line label's click.
import { describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { createThreeRenderer, type ThreeRenderer } from '../../../src/renderer/src/world/engine/threeRenderer'
import type { SceneModel, SceneText } from '../../../src/renderer/src/world/engine/sceneModel'
import { turnGround } from '../../../src/renderer/src/world/engine/viewMath'
import {
  atRatio, bldg, boxCanvas, conduit, DEFAULT_OPTS, district, emptyText, labelsOf, makeHost, sceneOf, smallCity, smallText,
  withHarness, worldOf,
} from './threeHarness'

vi.mock('three', async (orig) => ({ ...(await orig<typeof import('three')>()), WebGLRenderer: (await import('./threeHarness')).FakeWebGLRenderer }))
vi.mock('three/examples/jsm/postprocessing/EffectComposer.js', async () => ({ EffectComposer: (await import('./threeHarness')).FakeEffectComposer }))
vi.mock('three/examples/jsm/postprocessing/RenderPass.js', async () => ({ RenderPass: (await import('./threeHarness')).FakeRenderPass }))
vi.mock('three/examples/jsm/postprocessing/UnrealBloomPass.js', async () => ({ UnrealBloomPass: (await import('./threeHarness')).FakeUnrealBloomPass }))
vi.mock('three/examples/jsm/postprocessing/OutputPass.js', async () => ({ OutputPass: (await import('./threeHarness')).FakeOutputPass }))

const h = withHarness()

type V = [number, number, number]

function drawn(model: SceneModel = smallCity(), text: SceneText = smallText(), all = false, host: HTMLElement = h.host): ThreeRenderer {
  const r = createThreeRenderer(host, DEFAULT_OPTS)
  boxCanvas(r.canvas, 800, 600)
  r.draw(model, text, all)
  h.frames.step()
  return r
}
const world = (): THREE.Group => worldOf(sceneOf())
const shown = (kind: string): string[] => labelsOf(world(), kind).filter((l) => l.visible).map((l) => l.element.textContent ?? '')
const layer = (host: HTMLElement = h.host): HTMLElement => host.querySelector('.lw-labels') as HTMLElement
const inLayer = (text: string): boolean => [...layer().querySelectorAll('div')].some((el) => el.textContent === text)

describe('threeRenderer labels', () => {
  it('each part gets its label with its text, in the label layer; a redraw removes the labels of the parts it drops', () => {
    const text = smallText({ processes: { p1: { label: 'worker', color: '#f472b6' } } })
    const model = smallCity()
    model.buildings[0] = { ...model.buildings[0], processShell: 'p1' }
    model.buildings[1] = { ...model.buildings[1], processShell: 'gone' } // a process the text does not name
    const r = drawn(model, text, true)
    expect(labelsOf(world(), 'bldg').map((l) => l.element.textContent).sort()).toEqual(['Alpha', 'Beta', 'External', 'Gamma'])
    expect(labelsOf(world(), 'edge').map((l) => l.element.textContent)).toEqual(['calls', 'reads'])
    const procs = labelsOf(world(), 'proc').map((l) => l.element)
    expect(procs.map((el) => el.textContent)).toEqual(['⬡ worker', '⬡ gone'])
    expect(procs[0].style.color).toBe('rgb(244, 114, 182)')
    expect(procs[1].style.color).not.toBe(procs[0].style.color) // the theme's text colour
    expect(['calls', 'reads'].map(inLayer)).toEqual([true, true]) // shown (every line labelled): in the page
    const dropped = ['Beta', 'b0', 'b1', 'reads', '⬡ gone'].map((t) => [...labelsOf(world(), 'bldg'), ...labelsOf(world(), 'floor'), ...labelsOf(world(), 'edge'), ...labelsOf(world(), 'proc')].find((l) => l.element.textContent === t))
    expect(dropped.every((l) => l !== undefined)).toBe(true)

    const less = smallCity()
    less.buildings = less.buildings.filter((b) => b.id !== 'b')
    less.conduits = less.conduits.filter((c) => c.id === 'e1').map((c) => ({ ...c, to: [6, 6, 30] as V }))
    r.draw(less, text, true)
    h.frames.step()
    expect(labelsOf(world(), 'bldg').map((l) => l.element.textContent).sort()).toEqual(['Alpha', 'External', 'Gamma'])
    expect(labelsOf(world(), 'floor').map((l) => l.element.textContent)).toEqual(['a0', 'a1', 'a2'])
    expect(labelsOf(world(), 'edge').map((l) => l.element.textContent)).toEqual(['calls'])
    expect(dropped.map((l) => l?.element.isConnected)).toEqual([false, false, false, false, false])
    expect(inLayer('calls')).toBe(true)
    r.dispose()
  })

  it('a line label click reports the line and goes no further', () => {
    const onEdgeLabel = vi.fn()
    const outside = vi.fn()
    h.host.addEventListener('click', outside)
    const r = createThreeRenderer(h.host, { ...DEFAULT_OPTS, onEdgeLabel })
    r.draw(smallCity(), smallText(), true)
    h.frames.step()
    const label = labelsOf(world(), 'edge').find((l) => l.element.textContent === 'reads') as { element: HTMLElement }
    label.element.click()
    expect(onEdgeLabel).toHaveBeenCalledWith('e2')
    expect(outside).not.toHaveBeenCalled()
    r.dispose()
    // with no handler a click is still swallowed
    const r2 = createThreeRenderer(h.host, DEFAULT_OPTS)
    r2.draw(smallCity(), smallText(), true)
    ;(labelsOf(world(), 'edge')[0] as { element: HTMLElement }).element.click()
    expect(outside).not.toHaveBeenCalled()
    r2.dispose()
  })

  /** Twelve lines on one arch between p and q (their labels on one point), and m from q to s. */
  const LINES = Array.from({ length: 12 }, (_, i) => `l${i}`)
  function stacked(): SceneModel {
    return {
      districts: [district('d1', [0, 0, 0], 30)],
      buildings: [bldg('p', [-12, 0, 0]), bldg('q', [12, 0, 0]), bldg('s', [0, 0, 20])],
      conduits: [...LINES.map((id) => conduit(id, [-12, 9, 0], [12, 9, 0])), conduit('m', [12, 9, 0], [0, 9, 20])],
      orbs: [],
    }
  }
  const lineText = (): SceneText => emptyText({ labels: { p: 'P', q: 'Q', s: 'S' }, edges: { ...Object.fromEntries(LINES.map((id) => [id, id.toUpperCase()])), m: 'M' } })
  const ALL = [...LINES.map((id) => id.toUpperCase()), 'M'].sort()

  it('with all line labels on, every line label shows, overlapping where every place is taken, and the lit ones too', () => {
    // labels as big as the view: past the eleven places one can step to, none is clear
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(780)
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(580)
    const r = drawn(stacked(), lineText(), true)
    expect(shown('edge').sort()).toEqual(ALL)
    r.setFocus({ ids: new Set(['p']), edgeIds: new Set(LINES) }) // the twelve lit, m not
    h.frames.step()
    expect(shown('edge').sort()).toEqual(ALL)
    r.dispose()
    // off: the unlit lines' labels hide, and of the lit ones at most FOCUS_EDGE_LABELS (10) show
    const r2 = drawn(stacked(), lineText(), false)
    expect(shown('edge')).toEqual([])
    r2.setFocus({ ids: new Set(), edgeIds: new Set(LINES) })
    h.frames.step()
    expect(shown('edge').length).toBeGreaterThan(0)
    expect(shown('edge').length).toBeLessThanOrEqual(10)
    expect(shown('edge')).not.toContain('M')
    r2.dispose()
  })

  it('label sizes come from the page: names measured wide crowd each other out where narrow ones all fit', () => {
    // nine names in a row, a few units apart
    const model: SceneModel = {
      districts: [district('d1', [0, 0, 0], 30)],
      buildings: Array.from({ length: 9 }, (_, i) => bldg(`n${i}`, [i * 4 - 16, 0, 0])),
      conduits: [],
      orbs: [],
    }
    const text = emptyText({ labels: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`n${i}`, `Name${i}`])), importance: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`n${i}`, 1])) })
    const close = (x: ThreeRenderer): void => { void x.flyTo({ pos: [0, 15, 30], target: [0, 8, 0] }, true); h.frames.run(2) }
    const r = drawn(model, text)
    close(r)
    const small = shown('bldg').length
    r.dispose()
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(300)
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(120)
    const r2 = drawn(model, text)
    close(r2)
    const big = shown('bldg').length
    expect(small).toBeGreaterThanOrEqual(5)
    expect(big).toBeGreaterThan(0)
    expect(big).toBeLessThanOrEqual(3) // 800 pixels hold at most three 300-pixel names side by side
    r2.dispose()
  })

  it('the open building shows its floor captions; one without captions shows none', () => {
    const r = drawn()
    const look = (pos: V, target: V): void => { void r.flyTo({ pos, target }, true); h.frames.step() }
    look([60, 8, 10], [60, 2, 0]) // close to c: the floors tier
    expect(r.drawnCounts().tier).toBe('floors')
    r.setSelected('c')
    h.frames.step()
    expect(shown('floor')).toEqual([])
    r.setExploded('c')
    h.frames.step()
    expect(shown('floor')).toEqual([])
    r.setExploded(null)
    r.setSelected('a')
    look([-6, 14, 12], [-6, 5, 0])
    expect(shown('floor').sort()).toEqual(['a0', 'a1', 'a2'])
    r.dispose()
  })

  it('a building name on show keeps its place a little past the name budget', () => {
    const n = 20
    const model: SceneModel = {
      districts: [district('d1', [0, 0, 0], 70)],
      buildings: Array.from({ length: n }, (_, i) => bldg(`n${i}`, [(i % 5) * 28 - 56, 0, Math.floor(i / 5) * 28 - 42])),
      conduits: [],
      orbs: [],
    }
    const text = emptyText({
      labels: Object.fromEntries(Array.from({ length: n }, (_, i) => [`n${i}`, `N${i}`])),
      importance: Object.fromEntries(Array.from({ length: n }, (_, i) => [`n${i}`, n - i])),
    })
    // nameBudget(20, 0.74) = 9; nameBudget(20, 0.65) = 12
    const r = drawn(model, text)
    atRatio(r, h.frames, 0.74) // from the overview (4 names on show)
    const direct = shown('bldg').length
    atRatio(r, h.frames, 0.65)
    const nearer = shown('bldg').length
    atRatio(r, h.frames, 0.74) // back out: the names shown at 0.65 stay a little past the budget
    const back = shown('bldg').length
    expect(direct).toBeLessThanOrEqual(9)
    expect(nearer).toBeGreaterThan(direct)
    expect(back).toBeGreaterThan(direct)
    r.dispose()
  })

  it('district names are kept inside a small view; those with no room left drop out', () => {
    const tiny = makeHost(140, 90)
    const model: SceneModel = {
      districts: Array.from({ length: 6 }, (_, i) => district(`d${i}`, [i * 50, 0, 0], 20)),
      buildings: Array.from({ length: 6 }, (_, i) => bldg(`b${i}`, [i * 50, 0, 0])),
      conduits: [],
      orbs: [],
    }
    const r = drawn(model, emptyText(), false, tiny)
    h.frames.step()
    const names = labelsOf(world(), 'district')
    expect(names).toHaveLength(6)
    const on = names.filter((l) => l.visible)
    expect(on.length).toBeGreaterThan(0)
    expect(on.length).toBeLessThan(6)
    r.dispose()
    tiny.remove()
  })

  it('a tall view looks from the portrait side, and a city wider than deep turns a quarter: district names move to the camera side', () => {
    const tall = makeHost(300, 800)
    const wide: SceneModel = {
      districts: [district('d1', [0, 0, 0], 20), district('d2', [150, 0, 0], 20)],
      buildings: [bldg('a', [0, 0, 0]), bldg('b', [150, 0, 0])],
      conduits: [],
      orbs: [],
    }
    const r = drawn(wide, emptyText(), false, tall)
    const names = labelsOf(world(), 'district')
    const [x, z] = turnGround(0, 22, true)
    expect(names[0].position.toArray()).toEqual([x, 0.4, z])
    r.dispose()
    tall.remove()
    // landscape: the names sit on the +z side, unturned
    const r2 = drawn(wide)
    expect(labelsOf(world(), 'district')[0].position.toArray()).toEqual([0, 0.4, 22])
    r2.dispose()
  })
})
