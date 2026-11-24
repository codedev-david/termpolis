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
  atRatio, bldg, boxCanvas, cameraOf, conduit, DEFAULT_OPTS, district, emptyText, labelsOf, makeHost, rendererOf, resizeHost, sceneOf, smallCity, smallText,
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
    // twelve labels on one point: past the eleven places one can step to, none is clear (each still whole in the view)
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(60)
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(18)
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

  it('from far away a planned part on no district shows its name, and a part in a district does not (round 5 M5)', () => {
    const planned = (id: string, pos: V): ReturnType<typeof bldg> => bldg(id, pos, { floors: 2, height: 6, look: 'wire' })
    const model: SceneModel = {
      districts: [district('d1', [0, 0, 0], 12)],
      buildings: [bldg('a', [0, 0, 0]), planned('w1', [40, 0, 0]), planned('w2', [-40, 0, 0])],
      conduits: [],
      orbs: [],
    }
    const r = drawn(model, emptyText({ labels: { a: 'Built', w1: 'Planned one', w2: 'Planned two' }, importance: { a: 9, w1: 1, w2: 1 } }))
    expect(r.drawnCounts().tier).toBe('districts')
    expect(shown('bldg').sort()).toEqual(['Planned one', 'Planned two'])
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

  it('a name measured before its first projection is not left in the label layer, piled at its corner; projected, it is placed', () => {
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(80)
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(18)
    const r = createThreeRenderer(h.host, DEFAULT_OPTS)
    boxCanvas(r.canvas, 800, 600)
    r.draw(smallCity(), smallText(), false) // its layout measures the district names (their half widths)
    const names = labelsOf(world(), 'district')
    expect(names.length).toBeGreaterThan(0)
    expect(layer().querySelectorAll('.lw-district')).toHaveLength(0) // no frame yet: no name has a place
    h.frames.step() // the overview
    const on = names.filter((l) => l.visible)
    expect(on.length).toBeGreaterThan(0)
    for (const l of on) {
      expect(l.element.parentNode).toBe(layer())
      expect(l.element.style.transform).toMatch(/translate\(-?[\d.]+px,-?[\d.]+px\)$/)
    }
    // Only the names shown are in the layer: one measured and left off is not there at all.
    expect(layer().querySelectorAll('.lw-district')).toHaveLength(on.length)
    r.dispose()
  })

  /** Sizes from the page: a district name `name` x 18, its subtitle making it `sub` x 36 while it shows; other labels 40 x 18. */
  function sized(sub: number, name = 40): void {
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
      const span = this.classList.contains('lw-district') ? this.querySelector('span') : null
      return span ? (span.style.display === 'none' ? name : sub) : 40
    })
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      const span = this.classList.contains('lw-district') ? this.querySelector('span') : null
      return span && span.style.display !== 'none' ? 36 : 18
    })
  }
  const subtitle = (l: { element: HTMLElement }): HTMLElement => l.element.querySelector('span') as HTMLElement
  /** The districts' slabs (the districts tier), which their names keep off. */
  const slabsOf = (): THREE.InstancedMesh[] => {
    const out: THREE.InstancedMesh[] = []
    sceneOf().traverse((o) => { if ((o as THREE.InstancedMesh).isInstancedMesh && o.userData.slabIds) out.push(o as THREE.InstancedMesh) })
    return out
  }
  const hideSlabs = (): void => { for (const im of slabsOf()) im.visible = false }
  const twoDistricts = (): SceneModel => ({
    districts: [district('d1', [-60, 0, 0], 12), district('d2', [60, 0, 0], 12)],
    buildings: [bldg('a', [-60, 0, 0]), bldg('b', [60, 0, 0])],
    conduits: [],
    orbs: [],
  })
  const withSubtitles = emptyText({ districts: { d1: 'Electron app tests that drive the chooser', d2: 'Build, packaging and verification helpers' } })

  it('neighbouring district names always both show; a subtitle shows only where it overlaps no name or subtitle, the earlier first (film bug 7)', () => {
    // Two names 20 wide, about 63 pixels apart, in a view too short for either to step a row up or
    // down. Before, the second name dropped out (or, kept, drew under the first one's subtitle).
    const short = makeHost(800, 110)
    const subtitles = (sub: number): string[] => {
      sized(sub, 20)
      const r = drawn(twoDistricts(), withSubtitles, false, short)
      // The slabs put away: in a view this short each name and subtitle would lie on its own slab, which keeps the
      // subtitles off (its own test, the districts tier); here only the names' rule against each other is looked at.
      hideSlabs()
      h.frames.step()
      const names = labelsOf(world(), 'district')
      expect(names.map((l) => l.visible)).toEqual([true, true])
      const out = names.map((l) => subtitle(l).style.display)
      h.frames.step() // and it stays so, frame after frame
      expect(labelsOf(world(), 'district').map((l) => subtitle(l).style.display)).toEqual(out)
      r.dispose()
      return out
    }
    // A district's label also keeps a word's room across (1.5em of its 15px name) from one on its row.
    expect(subtitles(700)).toEqual(['none', 'none']) // either subtitle would cover the other name
    expect(subtitles(70)).toEqual(['none', 'none']) // the first would come within a word of the second name
    expect(subtitles(40)).toEqual(['', 'none']) // the first fits beside the second name; then the second meets it
    expect(subtitles(30)).toEqual(['', '']) // both fit, a word apart
    short.remove()
  })

  it('a district name with no subtitle has no compact form, and a hidden subtitle is measured whole again', () => {
    sized(700)
    const r = drawn(twoDistricts(), emptyText({ districts: { d1: 'Electron app tests that drive the chooser' } }))
    h.frames.step()
    const names = labelsOf(world(), 'district')
    expect(names.map((l) => subtitle(l).textContent)).toEqual(['Electron app tests that drive the chooser', ''])
    expect(names[0].visible).toBe(true)
    r.dispose()
  })

  it("a district's name keeps off a building that stands over its point, where it has a place to (F2)", () => {
    sized(80, 80)
    // A tall building at the district's front edge, right where its name sits on the ground.
    const model: SceneModel = { districts: [district('d', [0, 0, 0], 12)], buildings: [bldg('front', [0, 0, 13], { height: 30 })], conduits: [], orbs: [] }
    const r = drawn(model, emptyText())
    h.frames.run(3)
    const name = labelsOf(world(), 'district')[0]
    expect(name.visible).toBe(true)
    const cam = cameraOf()
    cam.updateMatrixWorld()
    const px = (v: THREE.Vector3): [number, number] => { const p = v.clone().project(cam); return [((p.x + 1) / 2) * 800, ((1 - p.y) / 2) * 600] }
    const [cx, cy] = px(name.getWorldPosition(new THREE.Vector3()))
    const x = cx + (parseFloat(name.element.style.marginLeft) || 0)
    const y = cy + (parseFloat(name.element.style.marginTop) || 0)
    const corners = Array.from({ length: 8 }, (_, k) => px(new THREE.Vector3(k & 1 ? 2.5 : -2.5, k & 2 ? 30 : 0, 13 + (k & 4 ? 2.5 : -2.5))))
    const [l, t, rt, b] = [Math.min(...corners.map((c) => c[0])), Math.min(...corners.map((c) => c[1])), Math.max(...corners.map((c) => c[0])), Math.max(...corners.map((c) => c[1]))]
    // On its own point the name would lie on the building's box; it was moved clear of it.
    expect(cx + 40 > l && cx - 40 < rt && cy + 9 > t && cy - 9 < b).toBe(true)
    expect(x + 40 <= l || x - 40 >= rt || y + 9 <= t || y - 9 >= b).toBe(true)
    r.dispose()
  })

  it("from far away a district's name keeps off its own slab, where it has a place to (F2, the districts tier)", () => {
    sized(80, 80)
    // Tall buildings inside the district: from far away one slab stands for them, as tall as they are on average.
    const model: SceneModel = {
      districts: [district('d', [0, 0, 0], 12)],
      buildings: [bldg('p', [-4, 0, 3], { height: 40 }), bldg('q', [4, 0, 3], { height: 40 }), bldg('s', [0, 0, -4], { height: 40 })],
      conduits: [],
      orbs: [],
    }
    const r = drawn(model, emptyText())
    h.frames.run(3)
    expect(r.drawnCounts().tier).toBe('districts')
    const name = labelsOf(world(), 'district')[0]
    expect(name.visible).toBe(true)
    const cam = cameraOf()
    cam.updateMatrixWorld()
    const px = (v: THREE.Vector3): [number, number] => { const p = v.clone().project(cam); return [((p.x + 1) / 2) * 800, ((1 - p.y) / 2) * 600] }
    const slab = slabsOf()[0]
    expect(slab.visible).toBe(true)
    const m = new THREE.Matrix4()
    slab.getMatrixAt(0, m)
    slab.updateWorldMatrix(true, false)
    const corners = Array.from({ length: 8 }, (_, k) => px(new THREE.Vector3(k & 1 ? 1 : -1, k & 2 ? 1 : 0, k & 4 ? 1 : -1).applyMatrix4(m).applyMatrix4(slab.matrixWorld)))
    const [l, t, rt, b] = [Math.min(...corners.map((c) => c[0])), Math.min(...corners.map((c) => c[1])), Math.max(...corners.map((c) => c[0])), Math.max(...corners.map((c) => c[1]))]
    const [cx, cy] = px(name.getWorldPosition(new THREE.Vector3()))
    const x = cx + (parseFloat(name.element.style.marginLeft) || 0)
    const y = cy + (parseFloat(name.element.style.marginTop) || 0)
    // On its own point the name would lie on the slab; it was moved clear of it.
    expect(cx + 40 > l && cx - 40 < rt && cy + 9 > t && cy - 9 < b).toBe(true)
    expect(x + 40 <= l || x - 40 >= rt || y + 9 <= t || y - 9 >= b).toBe(true)
    r.dispose()
  })

  it('a district name with no place off its slab shows compact, over a dark halo; one that found a place keeps its subtitle and no halo (N1)', () => {
    const tall = (): SceneModel => ({
      districts: [district('d', [0, 0, 0], 12)],
      buildings: [bldg('p', [-4, 0, 3], { height: 40 }), bldg('q', [4, 0, 3], { height: 40 }), bldg('s', [0, 0, -4], { height: 40 })],
      conduits: [],
      orbs: [],
    })
    const text = emptyText({ districts: { d: '3 parts · 12 files' } })
    // A small view the slab fills: every place the name could step to lies on it or outside the view.
    sized(80, 80)
    const small = makeHost(120, 70)
    let r = drawn(tall(), text, false, small)
    h.frames.run(3)
    expect(r.drawnCounts().tier).toBe('districts')
    let name = labelsOf(world(), 'district')[0]
    expect(name.visible).toBe(true)
    expect(subtitle(name).style.display).toBe('none')
    expect(name.element.classList.contains('lw-on-solid')).toBe(true)
    r.dispose()
    small.remove()
    // A roomy view: the name steps off its slab, grows whole, and has no halo.
    sized(80, 80)
    r = drawn(tall(), text)
    h.frames.run(3)
    name = labelsOf(world(), 'district')[0]
    expect(name.visible).toBe(true)
    expect(subtitle(name).style.display).toBe('')
    expect(name.element.classList.contains('lw-on-solid')).toBe(false)
    r.dispose()
  })

  it('the boxes names keep off are built again only when the camera or the world changes, not on an idle frame (M4)', () => {
    sized(80, 80)
    const model: SceneModel = {
      districts: [district('d', [0, 0, 0], 12), district('e', [40, 0, 0], 12)],
      buildings: [bldg('p', [-4, 0, 3], { height: 40 }), bldg('q', [40, 0, 3], { height: 40 })],
      conduits: [],
      orbs: [],
    }
    // Reduced motion: no idle turn, so once the opening move settles the camera is at rest (the idle turn moves it,
    // and the boxes with it, every frame).
    const r = createThreeRenderer(h.host, { ...DEFAULT_OPTS, reducedMotion: true })
    boxCanvas(r.canvas, 800, 600)
    r.draw(model, emptyText(), false)
    h.frames.run(400)
    expect(r.drawnCounts().tier).toBe('districts')
    const built = vi.spyOn(THREE.InstancedMesh.prototype, 'getMatrixAt')
    h.frames.run(3)
    expect(built).not.toHaveBeenCalled()
    // The camera moves: built again, once for the new view, then idle again. (A hand on the controls wakes the
    // loop as it moves the camera; here a hover does.)
    cameraOf().position.x += 3
    r.setHovered(null)
    h.frames.step()
    expect(built).toHaveBeenCalled()
    built.mockClear()
    h.frames.run(400)
    built.mockClear()
    h.frames.step()
    expect(built).not.toHaveBeenCalled()
    // A new world: built again.
    built.mockClear()
    r.draw(model, emptyText(), false)
    h.frames.step()
    expect(built).toHaveBeenCalled()
    r.dispose()
  })

  it("after an edit, with the camera still, a district's name keeps off the box the risen building ends at (m1)", () => {
    sized(80, 80)
    const model: SceneModel = { districts: [district('d', [0, 0, 0], 12), district('e', [-40, 0, 0], 8)], buildings: [bldg('front', [0, 0, 28], { height: 60 }), bldg('far', [-40, 0, 0])], conduits: [], orbs: [] }
    // Reduced motion: no idle turn, so the camera is at rest and the boxes are not rebuilt for it.
    const r = createThreeRenderer(h.host, { ...DEFAULT_OPTS, reducedMotion: true })
    boxCanvas(r.canvas, 800, 600)
    r.draw(model, emptyText(), false)
    h.frames.run(400)
    // The edit: the world drawn again (the same fit, so the camera stays where it is) with the building new in it. It
    // starts flat, its box below the name's point, and rises over 900 ms in front of it.
    r.draw(model, emptyText(), false)
    r.setFocus({ ids: new Set(['far']), edgeIds: new Set() }) // the buildings tier (the building stands, not its slab), its own name dimmed out
    r.animateChanges({ rise: ['front'], pulse: [] })
    h.frames.step()
    h.frames.run(80, 20)
    const name = labelsOf(world(), 'district')[0] // district d, drawn first
    // Whether the name, where it was placed, keeps off the risen building's box (its own point lies on that box).
    const clear = (): boolean => {
      expect(name.visible).toBe(true)
      const cam = cameraOf()
      cam.updateMatrixWorld()
      const px = (v: THREE.Vector3): [number, number] => { const p = v.clone().project(cam); return [((p.x + 1) / 2) * 800, ((1 - p.y) / 2) * 600] }
      const [cx, cy] = px(name.getWorldPosition(new THREE.Vector3()))
      const x = cx + (parseFloat(name.element.style.marginLeft) || 0)
      const y = cy + (parseFloat(name.element.style.marginTop) || 0)
      const corners = Array.from({ length: 8 }, (_, k) => px(new THREE.Vector3(k & 1 ? 2.5 : -2.5, k & 2 ? 60 : 0, 28 + (k & 4 ? 2.5 : -2.5))))
      const [l, t, rt, b] = [Math.min(...corners.map((c) => c[0])), Math.min(...corners.map((c) => c[1])), Math.max(...corners.map((c) => c[0])), Math.max(...corners.map((c) => c[1]))]
      expect(cx + 40 > l && cx - 40 < rt && cy + 9 > t && cy - 9 < b).toBe(true)
      return x + 40 <= l || x - 40 >= rt || y + 9 <= t || y - 9 >= b
    }
    expect(clear()).toBe(true)
    r.dispose()
  })

  it('the stylesheet draws a district name left on a building over a dark halo, so it reads over the geometry', () => {
    const r = drawn()
    const css = (document.getElementById('lumopolis-world-style') as HTMLStyleElement).textContent ?? ''
    expect(css).toMatch(/\.lw-district\.lw-on-solid\{text-shadow:0 0 [^}]*rgba\(0,0,0,/)
    r.dispose()
  })

  it('district names stay left of the legend', () => {
    sized(300)
    // The district on the right of the city, so its wide name would run under the legend.
    const one: SceneModel = { districts: [district('d0', [-60, 0, 0], 12), district('d1', [60, 0, 0], 12)], buildings: [bldg('z', [-60, 0, 0]), bldg('a', [60, 0, 0])], conduits: [], orbs: [] }
    const r = createThreeRenderer(h.host, { ...DEFAULT_OPTS, rightReserve: 244 })
    boxCanvas(r.canvas, 800, 600)
    r.draw(one, emptyText({ districts: { d1: 'A subtitle' } }), false)
    h.frames.run(3)
    const name = labelsOf(world(), 'district')[1]
    const at = name.getWorldPosition(new THREE.Vector3()).project(cameraOf())
    const x = ((at.x + 1) / 2) * 800 + (parseFloat(name.element.style.marginLeft) || 0)
    expect(name.visible).toBe(true)
    expect(x + 150).toBeLessThanOrEqual(800 - 244 - 4 + 0.5)
    r.dispose()
  })

  /** A panel over the view: an element whose box is `box` (left, top, right, bottom) from the page's corner. */
  const panelAt = (box: [number, number, number, number]): HTMLElement => {
    const el = document.createElement('section')
    el.getBoundingClientRect = () => ({ left: box[0], top: box[1], right: box[2], bottom: box[3], width: box[2] - box[0], height: box[3] - box[1], x: box[0], y: box[1], toJSON: () => ({}) }) as DOMRect
    return el
  }

  it('no label is drawn under a panel; a hidden panel hides none, and the boxes are measured again as they change', () => {
    sized(300)
    const r = drawn(twoDistricts(), withSubtitles)
    h.frames.step()
    expect(labelsOf(world(), 'district').map((l) => l.visible)).toEqual([true, true])
    // A panel over the whole view: no name has room.
    const cover = panelAt([0, 0, 800, 600])
    r.setPanels([cover])
    h.frames.step()
    expect(labelsOf(world(), 'district').map((l) => l.visible)).toEqual([false, false])
    // Measured once, not every frame, until the view changes size.
    cover.getBoundingClientRect = () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
    h.frames.step()
    expect(labelsOf(world(), 'district').map((l) => l.visible)).toEqual([false, false])
    // Measured again (here: by handing the panels over again), it is hidden: it hides nothing.
    r.setPanels([cover])
    h.frames.step()
    expect(labelsOf(world(), 'district').map((l) => l.visible)).toEqual([true, true])
    r.setPanels([])
    h.frames.step()
    expect(labelsOf(world(), 'district').map((l) => l.visible)).toEqual([true, true])
    r.dispose()
  })

  it('watches the panels for size changes beside the view, measures them again on a resize, and stops watching old ones', () => {
    let fire: (changed?: Array<{ target: Element }>) => void = () => undefined
    const watched = new Set<Element>()
    let off = 0
    vi.stubGlobal('ResizeObserver', class {
      constructor(cb: (changed?: Array<{ target: Element }>) => void) { fire = cb }
      observe(el: Element): void { watched.add(el) }
      unobserve(el: Element): void { watched.delete(el) }
      disconnect(): void { off++; watched.clear() }
    })
    sized(300)
    const r = drawn(twoDistricts(), withSubtitles)
    const legend = panelAt([0, 0, 0, 0])
    r.setPanels([legend])
    expect([...watched]).toEqual([h.host, legend])
    h.frames.step()
    expect(labelsOf(world(), 'district').map((l) => l.visible)).toEqual([true, true])
    // The legend opens over the view: its box is measured again, and the view keeps its size.
    legend.getBoundingClientRect = panelAt([0, 0, 800, 600]).getBoundingClientRect
    resizeHost(h.host, 820, 600)
    const sizes = rendererOf().sizes.length
    fire([{ target: legend }])
    expect(rendererOf().sizes).toHaveLength(sizes)
    h.frames.step()
    expect(labelsOf(world(), 'district').map((l) => l.visible)).toEqual([false, false])
    // It closes, and the view changes size: measured again with the view.
    legend.getBoundingClientRect = panelAt([0, 0, 0, 0]).getBoundingClientRect
    boxCanvas(r.canvas, 820, 600)
    fire([{ target: h.host }])
    expect(rendererOf().sizes[rendererOf().sizes.length - 1]).toEqual([820, 600])
    h.frames.run(3)
    expect(labelsOf(world(), 'district').map((l) => l.visible)).toEqual([true, true])
    // A new set of panels: the old ones are no longer watched, the view still is.
    const card = panelAt([0, 0, 0, 0])
    r.setPanels([card])
    expect([...watched]).toEqual([h.host, card])
    r.dispose()
    expect(off).toBe(1)
  })

  it("the hovered or selected part's name, partly off the picture, is moved in to the edge, never dropped; off screen it goes", () => {
    const model: SceneModel = { districts: [district('d1', [0, 0, 0], 60)], buildings: [bldg('l', [-40, 0, 0]), bldg('m', [0, 0, 0])], conduits: [], orbs: [] }
    const text = emptyText({ labels: { l: 'Left', m: 'Mid' } })
    const nameOf = (t: string): THREE.Object3D & { element: HTMLElement } => labelsOf(world(), 'bldg').find((l) => l.element.textContent === t) as THREE.Object3D & { element: HTMLElement }
    const r0 = drawn(model, text)
    const at = nameOf('Left').getWorldPosition(new THREE.Vector3()).project(cameraOf())
    const x = ((at.x + 1) / 2) * 800
    const y = ((1 - at.y) / 2) * 600
    r0.dispose()
    expect(x).toBeGreaterThan(0)
    expect(x).toBeLessThan(400)
    // A name wider than twice its distance from the left edge: half of it would be off the picture.
    const w = Math.ceil(2 * x + 100)
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(w)
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(18)
    const r = drawn(model, text)
    r.setSelected('l')
    h.frames.step()
    const name = nameOf('Left')
    expect(name.visible).toBe(true)
    // Moved right so its left edge sits the view's inset (4 px) in.
    expect(parseFloat(name.element.style.marginLeft)).toBeCloseTo(4 + w / 2 - x, 0)
    // A strip of panel over its place: it steps a row aside rather than vanish.
    r.setPanels([panelAt([0, y - 12, 800, y + 12])])
    h.frames.step()
    expect(name.visible).toBe(true)
    expect(Math.abs(parseFloat(name.element.style.marginTop))).toBeGreaterThanOrEqual(21)
    // Its part off the picture: it goes.
    void r.flyTo({ pos: [400, 30, 0], target: [400, 0, 0] }, true)
    h.frames.run(3)
    expect(name.visible).toBe(false)
    r.dispose()
  })

  it('the same panels handed over again are measured again (a panel moved without resizing), and not watched twice', () => {
    const watched: Element[] = []
    const unwatched: Element[] = []
    vi.stubGlobal('ResizeObserver', class {
      observe(el: Element): void { watched.push(el) }
      unobserve(el: Element): void { unwatched.push(el) }
      disconnect(): void { /* nothing */ }
    })
    sized(300)
    const r = drawn(twoDistricts(), withSubtitles)
    // The card sits off to the side: both names have room.
    const card = panelAt([0, 0, 0, 0])
    r.setPanels([card])
    h.frames.step()
    expect(labelsOf(world(), 'district').map((l) => l.visible)).toEqual([true, true])
    const seen = watched.length
    // Its content changes and it moves over the whole view at the same size: no ResizeObserver fires.
    card.getBoundingClientRect = panelAt([0, 0, 800, 600]).getBoundingClientRect
    h.frames.step()
    expect(labelsOf(world(), 'district').map((l) => l.visible)).toEqual([true, true]) // still the old box
    // The stage renders and hands the same panels over: measured again, not watched again.
    r.setPanels([card])
    h.frames.step()
    expect(labelsOf(world(), 'district').map((l) => l.visible)).toEqual([false, false])
    expect(watched).toHaveLength(seen)
    expect(unwatched).toEqual([])
    r.dispose()
  })

  it('draws the labels at the scale it is given, and measures them again at it', () => {
    const r = drawn()
    expect(layer().style.getPropertyValue('--lw-s')).toBe('')
    r.setLabelScale(1.5)
    expect(layer().style.getPropertyValue('--lw-s')).toBe('1.5')
    // Unmeasured, a line label is reckoned at the scale too; a nonsense or unchanged scale is ignored.
    r.setLabelScale(0)
    r.setLabelScale(Number.NaN)
    r.setLabelScale(1.5)
    expect(layer().style.getPropertyValue('--lw-s')).toBe('1.5')
    const width = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(40)
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(18)
    r.setLabelScale(2)
    h.frames.step()
    expect(width).toHaveBeenCalled() // every label measured again
    expect(layer().style.getPropertyValue('--lw-s')).toBe('2')
    r.dispose()
  })

  it('the stylesheet stacks the labels under the panels and sizes their type from the scale, at least 12 px', () => {
    const r = drawn()
    const css = (document.getElementById('lumopolis-world-style') as HTMLStyleElement).textContent ?? ''
    expect(css).toMatch(/\.lw-labels\{[^}]*z-index:0/)
    for (const cls of ['lw-bldg', 'lw-floor', 'lw-edge', 'lw-proc']) expect(css.includes(`.${cls}{font:calc(12px * var(--lw-s))`), cls).toBe(true)
    expect(css).toMatch(/\.lw-district\{font:700 calc\(15px \* var\(--lw-s\)\)/)
    r.dispose()
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
