// threeRenderer: frames on demand, a lost WebGL context, and reduced motion switched while the view is open.
// An idle city draws no frame; every change wakes the loop, which draws while anything moves and a few frames more
// (SETTLE_FRAMES), then sleeps. The frame stepper drives performance.now, which THREE.Clock, the camera rig and the
// change animator read.
import { describe, expect, it, vi } from 'vitest'
import { BUFFER_SETTLE_MS, createThreeRenderer, DROPPED_FRAME_MS, sameLayout, sameRects, SETTLE_FRAMES, type ThreeRenderer } from '../../../src/renderer/src/world/engine/threeRenderer'
import { SOFTWARE_FENCE_MAX_MS, SOFTWARE_LOOP_MAX_MS, SOFTWARE_LOOP_MS, softwareLoopGap } from '../../../src/renderer/src/world/engine/viewMath'
import { RISE_MS } from '../../../src/renderer/src/world/engine/changeAnimation'
import type { SceneModel } from '../../../src/renderer/src/world/engine/sceneModel'
import { bldg, boxCanvas, DEFAULT_OPTS, district, gpu, makeHost, rendererOf, resizeHost, smallCity, smallText, withHarness, type Frames } from './threeHarness'

vi.mock('three', async (orig) => ({ ...(await orig<typeof import('three')>()), WebGLRenderer: (await import('./threeHarness')).FakeWebGLRenderer }))
vi.mock('three/examples/jsm/postprocessing/EffectComposer.js', async () => ({ EffectComposer: (await import('./threeHarness')).FakeEffectComposer }))
vi.mock('three/examples/jsm/postprocessing/RenderPass.js', async () => ({ RenderPass: (await import('./threeHarness')).FakeRenderPass }))
vi.mock('three/examples/jsm/postprocessing/UnrealBloomPass.js', async () => ({ UnrealBloomPass: (await import('./threeHarness')).FakeUnrealBloomPass }))
vi.mock('three/examples/jsm/postprocessing/OutputPass.js', async () => ({ OutputPass: (await import('./threeHarness')).FakeOutputPass }))

const h = withHarness()

const REDUCED = { ...DEFAULT_OPTS, reducedMotion: true }
/** A city with no lines, rings, fog, wireframes or fading parts: nothing in it loops, whatever the motion setting. */
const still = (): SceneModel => ({ districts: [district('d', [0, 0, 0], 20)], buildings: [bldg('p', [-4, 0, 0]), bldg('q', [6, 0, 4])], conduits: [], orbs: [] })
const frames = (r: ThreeRenderer): number => r.drawnCounts().frames

/** Runs frames until the loop sleeps (no frame asked for), at most `max`; returns how many ran. */
function settle(f: Frames, max = 2000): number {
  let n = 0
  while (f.pending() > 0 && n < max) { f.step(); n++ }
  return n
}

/** A renderer drawn with `model` and run until it sleeps. */
function idle(opts = REDUCED, model: SceneModel = smallCity()): ThreeRenderer {
  const r = createThreeRenderer(h.host, opts)
  boxCanvas(r.canvas, 800, 600)
  r.draw(model, smallText(), false)
  settle(h.frames)
  return r
}

describe('threeRenderer frames on demand', () => {
  it('an idle scene draws no frames: the loop sleeps once nothing moves, and asks for none while idle', () => {
    const r = idle()
    expect(h.frames.pending()).toBe(0)
    const n = frames(r)
    const renders = rendererOf().renders.length
    h.frames.run(300) // five seconds of idle
    expect(frames(r)).toBe(n)
    expect(rendererOf().renders.length).toBe(renders)
    r.dispose()
  })

  it('a hover wakes it: the hover is drawn on the next frame, then a few settling frames, then it sleeps again', () => {
    const r = idle()
    const n = frames(r)
    r.setHovered('a')
    expect(h.frames.pending()).toBe(1)
    h.frames.step()
    expect(frames(r)).toBe(n + 1)
    const ran = settle(h.frames)
    expect(ran).toBeGreaterThanOrEqual(SETTLE_FRAMES - 1)
    expect(ran).toBeLessThan(60)
    r.dispose()
  })

  it('without reduced motion the looping motions draw every frame; a city with nothing looping still sleeps', () => {
    const moving = idle(DEFAULT_OPTS) // the opening turn and the dust never stop
    expect(h.frames.pending()).toBe(1)
    const n = frames(moving)
    h.frames.run(30)
    expect(frames(moving)).toBe(n + 30)
    moving.dispose()
    // Flat draws no dust; this city has no lines, rings, fog or pulses; the turn is ended by a flight.
    h.host.remove()
    h.host = makeHost(800, 600)
    const calm = idle({ quality: 'flat', reducedMotion: false }, still())
    void calm.overview(true)
    expect(settle(h.frames)).toBeLessThan(2000)
    const m = frames(calm)
    h.frames.run(100)
    expect(frames(calm)).toBe(m)
    calm.dispose()
  })

  it('every change wakes the loop', () => {
    const r = idle()
    const panel = document.createElement('div')
    const wakes: Array<[string, () => unknown]> = [
      ['draw', () => r.draw(smallCity(), smallText(), false)],
      ['setRightReserve', () => r.setRightReserve(120)],
      ['setBottomReserve', () => r.setBottomReserve(40)],
      ['setCardReserve', () => r.setCardReserve(200, 100)],
      ['setPanels', () => r.setPanels([panel])],
      ['setLabelScale', () => r.setLabelScale(1.5)],
      ['setTheme', () => r.setTheme('glass', { background: '#ffffff', district: '#eeeeee', conduit: '#0000ff', glow: '#00ffff', text: '#000000', fogDensity: 0.004 })],
      ['setFocus', () => r.setFocus({ ids: new Set(['a']), edgeIds: new Set() })],
      ['setSelected', () => r.setSelected('a')],
      ['setExploded', () => r.setExploded('a')],
      ['frame', () => r.frame(['b'], true)],
      ['overview', () => r.overview(true)],
      ['flyTo', () => r.flyTo({ pos: [10, 50, 60], target: [0, 0, 0] }, true)],
      ['setHovered', () => r.setHovered('b')],
      ['keepGhosts', () => r.keepGhosts(['c'])],
      ['animateChanges', () => r.animateChanges({ rise: ['a'], pulse: ['b'] })],
      ['stopChanges', () => r.stopChanges()],
      ['stopPulses', () => r.stopPulses()],
      ['requestFrame', () => r.requestFrame()],
    ]
    for (const [name, act] of wakes) {
      settle(h.frames)
      const n = frames(r)
      void act()
      h.frames.step()
      expect(frames(r), name).toBe(n + 1)
    }
    r.dispose()
  })

  it('the same panels handed over again draw a frame only when one of them moved', () => {
    // The pane hands its panels over after every render and every change of its DOM (a world compiling, a card's
    // text updating): many times a second. Each used to wake the loop, and drawn in software each wake is a whole
    // draw of the city.
    const r = idle()
    let box = [600, 0, 800, 200]
    const panel = document.createElement('section')
    panel.getBoundingClientRect = () => ({ left: box[0], top: box[1], right: box[2], bottom: box[3], width: box[2] - box[0], height: box[3] - box[1], x: box[0], y: box[1], toJSON: () => ({}) }) as DOMRect
    r.setPanels([panel])
    // Handed over again before a frame measured the new set: it is drawn.
    r.setPanels([panel])
    expect(h.frames.pending()).toBe(1)
    settle(h.frames)
    const n = frames(r)
    for (let i = 0; i < 50; i++) r.setPanels([panel])
    expect(h.frames.pending()).toBe(0)
    h.frames.run(60)
    expect(frames(r)).toBe(n)
    // The panel moved at the same size (no ResizeObserver hears it): the next hand-over draws, on the next frame.
    box = [600, 300, 800, 500]
    r.setPanels([panel])
    expect(h.frames.pending()).toBe(1)
    h.frames.step()
    expect(frames(r)).toBe(n + 1)
    settle(h.frames)
    // Hidden (no box) is a change too; shown again where it was, another.
    box = [0, 0, 0, 0]
    r.setPanels([panel])
    expect(h.frames.pending()).toBe(1)
    settle(h.frames)
    box = [600, 300, 800, 500]
    r.setPanels([panel])
    expect(h.frames.pending()).toBe(1)
    settle(h.frames)
    r.dispose()
  })

  it('sameRects: the same boxes in the same order', () => {
    expect(sameRects([], [])).toBe(true)
    expect(sameRects([[0, 0, 1, 1]], [[0, 0, 1, 1]])).toBe(true)
    expect(sameRects([[0, 0, 1, 1]], [])).toBe(false)
    expect(sameRects([[0, 0, 1, 1]], [[0, 0, 1, 2]])).toBe(false)
    expect(sameRects([[0, 0, 1, 1], [2, 2, 3, 3]], [[2, 2, 3, 3], [0, 0, 1, 1]])).toBe(false)
  })

  it('a pulse draws until it arrives, and a theme with no world drawn yet wakes the loop too', async () => {
    // A pulse is skipped under reduced motion: this one runs with motion, on a city whose looping motions are
    // switched off, and the loop sleeps only once the pulse has arrived.
    const r = idle(DEFAULT_OPTS)
    r.setReducedMotion(true)
    settle(h.frames)
    let arrived = false
    // Under reduced motion it resolves at once; with motion back on (the looping motions too) it runs its course.
    await r.pulse(['e1'], false)
    r.setReducedMotion(false)
    const done = r.pulse(['e1'], false).then(() => { arrived = true })
    h.frames.run(60) // 0.96 s: under way (a leg is 1.25 / 0.65 s)
    await Promise.resolve()
    expect(arrived).toBe(false)
    h.frames.run(70)
    await done
    expect(arrived).toBe(true)
    r.dispose()
    h.host.remove()
    h.host = makeHost(800, 600)
    const empty = createThreeRenderer(h.host, REDUCED)
    settle(h.frames)
    const n = frames(empty)
    empty.setTheme('blueprint', { background: '#001122', district: '#002244', conduit: '#3366ff', glow: '#66ccff', text: '#ffffff', fogDensity: 0.005 })
    h.frames.step()
    expect(frames(empty)).toBe(n + 1)
    empty.dispose()
  })

  it('a hand on the controls, a movement key and a resize wake it; a key held keeps it drawing until let go', () => {
    let observed: ((entries?: Array<{ target: Element }>) => void) | null = null
    vi.stubGlobal('ResizeObserver', class {
      constructor(cb: (entries?: Array<{ target: Element }>) => void) { observed = cb }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    })
    const r = idle()
    const canvas = r.canvas
    // OrbitControls: a press, a move and a release on the canvas fire its start, change and end.
    // OrbitControls turns by the drag over the canvas's box: jsdom lays out nothing, so it is given one.
    Object.defineProperty(canvas, 'clientWidth', { configurable: true, value: 800 })
    Object.defineProperty(canvas, 'clientHeight', { configurable: true, value: 600 })
    canvas.setPointerCapture = (): void => {}
    canvas.releasePointerCapture = (): void => {}
    let n = frames(r)
    canvas.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, button: 0, clientX: 100, clientY: 100, pointerType: 'mouse', bubbles: true }))
    h.frames.step()
    expect(frames(r)).toBe(n + 1)
    canvas.ownerDocument.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 160, clientY: 120, pointerType: 'mouse', bubbles: true }))
    canvas.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 160, clientY: 120, pointerType: 'mouse', bubbles: true }))
    canvas.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, button: 0, clientX: 160, clientY: 120, pointerType: 'mouse', bubbles: true }))
    expect(h.frames.pending()).toBe(1)
    settle(h.frames)
    // A movement key: the camera moves every frame it is held.
    n = frames(r)
    h.host.dispatchEvent(new KeyboardEvent('keydown', { key: 'w' }))
    h.frames.run(40)
    expect(frames(r)).toBe(n + 40)
    expect(h.frames.pending()).toBe(1)
    h.host.dispatchEvent(new KeyboardEvent('keyup', { key: 'w' }))
    expect(settle(h.frames)).toBeLessThan(60)
    // Another key (not a movement key) wakes nothing.
    h.host.dispatchEvent(new KeyboardEvent('keydown', { key: 'x' }))
    expect(h.frames.pending()).toBe(0)
    // The view resized: drawn again at the new size.
    resizeHost(h.host, 640, 480)
    ;(observed as unknown as (entries?: Array<{ target: Element }>) => void)([{ target: h.host }])
    expect(h.frames.pending()).toBe(1)
    settle(h.frames)
    r.dispose()
  })

  it('a pane with no size (hidden) draws nothing until it shows again', () => {
    let observed: ((entries?: Array<{ target: Element }>) => void) | null = null
    vi.stubGlobal('ResizeObserver', class {
      constructor(cb: (entries?: Array<{ target: Element }>) => void) { observed = cb }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    })
    const r = idle(DEFAULT_OPTS) // the looping motions: it would draw every frame
    resizeHost(h.host, 0, 0)
    const n = frames(r)
    h.frames.run(20)
    expect(frames(r)).toBe(n)
    expect(h.frames.pending()).toBe(0)
    resizeHost(h.host, 800, 0)
    r.setHovered(null)
    h.frames.step()
    expect(frames(r)).toBe(n) // still no height
    resizeHost(h.host, 800, 600)
    ;(observed as unknown as (entries?: Array<{ target: Element }>) => void)([{ target: h.host }])
    h.frames.step()
    expect(frames(r)).toBe(n + 1)
    r.dispose()
  })

  it('the fog eases to its new density, is put on it once the rest cannot be seen, and the loop then sleeps', () => {
    const r = idle()
    r.setExploded('a') // an open building thickens the fog
    const ran = settle(h.frames)
    expect(ran).toBeGreaterThan(SETTLE_FRAMES)
    expect(h.frames.pending()).toBe(0)
    r.dispose()
  })

  it('a frame that throws keeps the loop going, as it always did', () => {
    const r = idle()
    const fake = rendererOf()
    const render = fake.render.bind(fake)
    let fail = true
    // Flat draws through the renderer, High and Low through the composer, whose render pass calls it: either way.
    fake.render = (scene, camera): void => { if (fail) { fail = false; throw new Error('gpu hiccup') } render(scene, camera) }
    r.setHovered('a')
    expect(() => h.frames.step()).toThrow('gpu hiccup')
    expect(h.frames.pending()).toBe(1)
    settle(h.frames)
    r.dispose()
  })

  it('paused, it asks for no frame and a change waits; unpaused, the change is drawn', () => {
    const r = idle()
    r.setPaused(true)
    r.setPaused(true) // the same again: nothing
    r.setHovered('a')
    expect(h.frames.pending()).toBe(0)
    const n = frames(r)
    r.setPaused(false)
    r.setPaused(false)
    h.frames.step()
    expect(frames(r)).toBe(n + 1)
    r.dispose()
    r.setPaused(false) // after dispose: nothing
    r.setHovered('b')
    expect(h.frames.pending()).toBe(0)
  })

  it('counts the changes as of now, so a change whose time is up is done even when no frame has come', () => {
    const r = idle()
    r.animateChanges({ rise: ['a', 'b'], pulse: [] })
    expect(r.drawnCounts().changing).toBe(2)
    h.frames.advance(RISE_MS + 1) // no frame runs: the frames are starved
    expect(r.drawnCounts().changing).toBe(0)
    // The next frame draws the risen buildings and refills their batches.
    settle(h.frames)
    expect(h.frames.pending()).toBe(0)
    r.dispose()
  })
})

const SWIFTSHADER = 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)'
const GEFORCE = 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)'

// Drawn in software (SwiftShader where the GPU is blocklisted or missing, a VM, a remote desktop, the CI runners), a
// city whose looping motions are drawn at the screen's rate takes every core the machine has for as long as it is
// open: an Ask's hidden agent then took seconds to start (world-ask 6b ran out of its 30 s). The looping motions alone
// are drawn every SOFTWARE_LOOP_MS there; a change, and every motion that ends, is still drawn on the next frame.
describe('threeRenderer drawn in software', () => {
  /** Frames drawn over `ms` of 16 ms frames. */
  const drawnOver = (r: ThreeRenderer, ms: number): number => {
    const n = frames(r)
    h.frames.run(Math.round(ms / 16))
    return frames(r) - n
  }

  it('the first frame comes a frame late in software (the page paints first) and at once on a GPU', () => {
    gpu.gpuName = GEFORCE
    const g = createThreeRenderer(h.host, REDUCED)
    boxCanvas(g.canvas, 800, 600)
    h.frames.step()
    expect(frames(g)).toBe(1)
    g.dispose()
    gpu.gpuName = SWIFTSHADER
    const r = createThreeRenderer(h.host, REDUCED)
    boxCanvas(r.canvas, 800, 600)
    r.draw(smallCity(), smallText(), false) // a world drawn before the first frame waits with it
    expect(h.frames.pending()).toBe(1)
    h.frames.step() // the page's frame: nothing drawn, the next asked for
    expect(frames(r)).toBe(0)
    expect(rendererOf().renders.length).toBe(0)
    expect(h.frames.pending()).toBe(1)
    h.frames.step()
    expect(frames(r)).toBe(1)
    r.dispose()
  })

  it('a renderer disposed before its first software frame never draws; paused or lost meanwhile, it draws once let go', () => {
    gpu.gpuName = SWIFTSHADER
    const d = createThreeRenderer(h.host, REDUCED)
    boxCanvas(d.canvas, 800, 600)
    d.dispose()
    expect(h.frames.pending()).toBe(0)
    h.frames.run(3)
    expect(frames(d)).toBe(0)
    const p = createThreeRenderer(h.host, REDUCED)
    boxCanvas(p.canvas, 800, 600)
    p.setPaused(true)
    h.frames.run(3)
    expect(frames(p)).toBe(0)
    expect(h.frames.pending()).toBe(0)
    p.setPaused(false)
    h.frames.step()
    expect(frames(p)).toBe(1)
    p.dispose()
    const l = createThreeRenderer(h.host, REDUCED)
    boxCanvas(l.canvas, 800, 600)
    l.canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }))
    h.frames.run(3)
    expect(frames(l)).toBe(0)
    expect(h.frames.pending()).toBe(0)
    l.canvas.dispatchEvent(new Event('webglcontextrestored'))
    h.frames.step()
    expect(frames(l)).toBe(1)
    l.dispose()
  })

  it('draws the looping motions alone every SOFTWARE_LOOP_MS, at their own speed, and never sleeps', () => {
    gpu.gpuName = SWIFTSHADER
    const r = idle(DEFAULT_OPTS) // the opening turn, the dust, the rings, the packets: they never stop
    const before = r.motionState().ringAngle
    const drawn = drawnOver(r, 1600) // 100 frames of the screen's
    // The first frame at least SOFTWARE_LOOP_MS after the last: 112 ms apart in 16 ms frames.
    expect(drawn).toBeGreaterThanOrEqual(Math.floor(1600 / (SOFTWARE_LOOP_MS + 16)))
    expect(drawn).toBeLessThanOrEqual(1600 / SOFTWARE_LOOP_MS + 1)
    expect(h.frames.pending()).toBe(1)
    // Each frame drawn takes the time since the last one: the ring turns as far as it does at 60 frames a second.
    const after = r.motionState().ringAngle
    expect(before).not.toBe(0)
    expect(after - before).toBeCloseTo(1.6 * 0.8, 1)
    r.dispose()
  })

  it('a GPU, or a name it cannot tell, still draws the looping motions every frame', () => {
    for (const name of [GEFORCE, null]) {
      gpu.gpuName = name
      const r = idle(DEFAULT_OPTS)
      expect(drawnOver(r, 480), String(name)).toBe(30)
      r.dispose()
    }
  })

  it("a change is drawn on the next frame, not held back to the loop's pace", () => {
    gpu.gpuName = SWIFTSHADER
    const r = idle(DEFAULT_OPTS)
    h.frames.run(3) // just after a looping frame: the next one is SOFTWARE_LOOP_MS away
    const n = frames(r)
    r.setHovered('a')
    h.frames.step()
    expect(frames(r)).toBe(n + 1)
    // Then the loop's pace again.
    expect(drawnOver(r, 48)).toBe(0)
    r.dispose()
  })

  it('a motion that ends (a flight) is drawn every frame until it lands, then the looping motions alone again', async () => {
    gpu.gpuName = SWIFTSHADER
    const r = idle(DEFAULT_OPTS)
    let landed = false
    void r.flyTo({ pos: [10, 50, 60], target: [0, 0, 0] }).then(() => { landed = true })
    expect(drawnOver(r, 160)).toBe(10)
    let n = 0
    while (!landed && n++ < 600) { h.frames.step(); await Promise.resolve() }
    expect(landed).toBe(true)
    h.frames.run(20) // the settling frames
    expect(drawnOver(r, 1600)).toBeLessThanOrEqual(1600 / SOFTWARE_LOOP_MS + 1)
    r.dispose()
  })

  it("the opening turn alone loops (at the loop's pace in software); ended, a calm city sleeps", () => {
    // Flat draws no dust, and this city has no lines, rings, fog or pulses: only the turn moves.
    for (const [name, every] of [[SWIFTSHADER, false], [GEFORCE, true]] as const) {
      gpu.gpuName = name
      const r = idle({ quality: 'flat', reducedMotion: false }, still())
      const turn = drawnOver(r, 1600)
      if (every) expect(turn).toBe(100)
      else expect(turn).toBeLessThanOrEqual(1600 / SOFTWARE_LOOP_MS + 1)
      void r.overview(true) // a flight ends the turn
      expect(settle(h.frames)).toBeLessThan(60)
      expect(drawnOver(r, 1600)).toBe(0)
      r.dispose()
      h.host.remove()
      h.host = makeHost(800, 600)
    }
  })

  it("the opening turn keeps its speed at the loop's pace: the frame's time, not a fixed step per frame", () => {
    const azimuth = (r: ThreeRenderer): number => { const c = r.getCamera(); return Math.atan2(c.pos[0] - c.target[0], c.pos[2] - c.target[2]) }
    for (const name of [SWIFTSHADER, GEFORCE]) {
      gpu.gpuName = name
      const r = idle({ quality: 'low', reducedMotion: false }, still())
      const a0 = azimuth(r)
      drawnOver(r, 1600)
      // OrbitControls' autoRotateSpeed 0.3 is 0.3 turns a minute: 2π/60·0.3 rad/s, over 1.6 s.
      expect(Math.abs(azimuth(r) - a0), name).toBeCloseTo(1.6 * 2 * Math.PI / 60 * 0.3, 2)
      r.dispose()
      h.host.remove()
      h.host = makeHost(800, 600)
    }
  })

  it("an open building's flow dots loop at the loop's pace in software; a hand, a key, a hover and a flight are drawn every frame", async () => {
    // Flat draws no dust and this city has no lines, rings, fog or pulses: once the turn ends, only the dots loop.
    for (const [name, every] of [[SWIFTSHADER, false], [GEFORCE, true]] as const) {
      gpu.gpuName = name
      const r = idle({ quality: 'flat', reducedMotion: false }, still())
      void r.overview(true)
      settle(h.frames)
      r.setExploded('p')
      h.frames.run(300) // the floors spread: an ease, drawn every frame until it settles
      const flow = drawnOver(r, 1600)
      if (every) expect(flow, name).toBe(100)
      else expect(flow, name).toBeLessThanOrEqual(1600 / SOFTWARE_LOOP_MS + 1)
      expect(h.frames.pending()).toBe(1) // the dots never stop while it is open
      expect(r.motionState().exploded).toBe('p')
      r.dispose()
      h.host.remove()
      h.host = makeHost(800, 600)
    }
    gpu.gpuName = SWIFTSHADER
    const r = idle({ quality: 'flat', reducedMotion: false }, still())
    void r.overview(true)
    settle(h.frames)
    r.setExploded('p')
    h.frames.run(300)
    // A held movement key: every frame.
    h.host.dispatchEvent(new KeyboardEvent('keydown', { key: 'w' }))
    expect(drawnOver(r, 640)).toBe(40)
    h.host.dispatchEvent(new KeyboardEvent('keyup', { key: 'w' }))
    h.frames.run(60) // the step and the settling frames
    // A drag on the canvas (OrbitControls' start and change): drawn on the next frame, each time.
    const canvas = r.canvas
    Object.defineProperty(canvas, 'clientWidth', { configurable: true, value: 800 })
    Object.defineProperty(canvas, 'clientHeight', { configurable: true, value: 600 })
    canvas.setPointerCapture = (): void => {}
    canvas.releasePointerCapture = (): void => {}
    h.frames.run(3) // just after a looping frame
    let n = frames(r)
    canvas.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, button: 0, clientX: 100, clientY: 100, pointerType: 'mouse', bubbles: true }))
    h.frames.step()
    expect(frames(r)).toBe(n + 1)
    for (let x = 110; x <= 150; x += 10) {
      n = frames(r)
      canvas.ownerDocument.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: x, clientY: 110, pointerType: 'mouse', bubbles: true }))
      canvas.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: x, clientY: 110, pointerType: 'mouse', bubbles: true }))
      h.frames.step()
      expect(frames(r), `move to ${x}`).toBe(n + 1)
    }
    canvas.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, button: 0, clientX: 150, clientY: 110, pointerType: 'mouse', bubbles: true }))
    h.frames.run(120) // the glide after the hand lets go (damping) ends
    // A hover: the next frame.
    h.frames.run(3)
    n = frames(r)
    r.setHovered('q')
    h.frames.step()
    expect(frames(r)).toBe(n + 1)
    // A flight (the camera's tween): every frame until it lands.
    let landed = false
    void r.flyTo({ pos: [10, 50, 60], target: [0, 0, 0] }).then(() => { landed = true })
    expect(drawnOver(r, 160)).toBe(10)
    let k = 0
    while (!landed && k++ < 600) { h.frames.step(); await Promise.resolve() }
    expect(landed).toBe(true)
    h.frames.run(20)
    // Landed, with the building still open: the loop's pace again.
    expect(drawnOver(r, 1600)).toBeLessThanOrEqual(1600 / SOFTWARE_LOOP_MS + 1)
    r.dispose()
  })

  it('the glide after a drag takes the same wall time at any frame rate, so a slow screen draws fewer frames of it', () => {
    /** A drag across the canvas and its glide at `ms` a frame: the frames the glide drew, how long it took, how far it turned. */
    const glide = (ms: number): { drawn: number; ms: number; turned: number } => {
      const r = idle(REDUCED, still())
      const canvas = r.canvas
      Object.defineProperty(canvas, 'clientWidth', { configurable: true, value: 800 })
      Object.defineProperty(canvas, 'clientHeight', { configurable: true, value: 600 })
      canvas.setPointerCapture = (): void => {}
      canvas.releasePointerCapture = (): void => {}
      const az = (): number => { const c = r.getCamera(); return Math.atan2(c.pos[0] - c.target[0], c.pos[2] - c.target[2]) }
      const a0 = az()
      canvas.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, button: 0, clientX: 100, clientY: 100, pointerType: 'mouse', bubbles: true }))
      for (let x = 110; x <= 150; x += 10) {
        canvas.ownerDocument.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: x, clientY: 100, pointerType: 'mouse', bubbles: true }))
        canvas.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: x, clientY: 100, pointerType: 'mouse', bubbles: true }))
      }
      canvas.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, button: 0, clientX: 150, clientY: 100, pointerType: 'mouse', bubbles: true }))
      const n = frames(r)
      const t0 = h.frames.now
      for (let k = 0; k < 5000 && h.frames.pending() > 0; k++) h.frames.step(ms)
      const out = { drawn: frames(r) - n - SETTLE_FRAMES, ms: h.frames.now - t0 - SETTLE_FRAMES * ms, turned: az() - a0 }
      r.dispose()
      h.host.remove()
      h.host = makeHost(800, 600)
      return out
    }
    const fast = glide(1000 / 60)
    const slow = glide(200) // about the rate of a city drawn in software
    expect(fast.drawn).toBeGreaterThan(60)
    expect(slow.ms).toBeGreaterThan(fast.ms * 0.6)
    expect(slow.ms).toBeLessThan(fast.ms * 1.4)
    expect(slow.drawn).toBeLessThan(fast.drawn / 8)
    expect(slow.turned).toBeCloseTo(fast.turned, 2) // the same glide, drawn in fewer frames
    expect(Math.abs(fast.turned)).toBeGreaterThan(0.01)
  })

  it('the glide after a drag on a 15 fps screen takes the same wall time as at 60 fps (within 5%): input events between frames spend none of it', () => {
    /**
     * A drag of 240 ms with a pointer move every 4 ms (the events OrbitControls answers with an update of its own),
     * on a screen drawing a frame every `ms`, then its glide: how far the camera turned after the hand let go, how
     * long that took, and how far it turned in all.
     */
    const dragGlide = (ms: number): { glide: number; ms: number; turned: number } => {
      const r = idle(REDUCED, still())
      const canvas = r.canvas
      Object.defineProperty(canvas, 'clientWidth', { configurable: true, value: 800 })
      Object.defineProperty(canvas, 'clientHeight', { configurable: true, value: 600 })
      canvas.setPointerCapture = (): void => {}
      canvas.releasePointerCapture = (): void => {}
      const az = (): number => { const c = r.getCamera(); return Math.atan2(c.pos[0] - c.target[0], c.pos[2] - c.target[2]) }
      const a0 = az()
      canvas.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, button: 0, clientX: 100, clientY: 100, pointerType: 'mouse', bubbles: true }))
      let sinceFrame = 0
      for (let k = 1; k <= 60; k++) {
        h.frames.advance(4)
        sinceFrame += 4
        const x = 100 + k * 3
        canvas.ownerDocument.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: x, clientY: 100, pointerType: 'mouse', bubbles: true }))
        canvas.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: x, clientY: 100, pointerType: 'mouse', bubbles: true }))
        if (sinceFrame >= ms) { h.frames.step(0); sinceFrame = 0 } // the screen's next frame
      }
      canvas.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, button: 0, clientX: 280, clientY: 100, pointerType: 'mouse', bubbles: true }))
      const aUp = az()
      const t0 = h.frames.now
      let last = t0
      let prev = aUp
      for (let k = 0; k < 5000 && h.frames.pending() > 0; k++) {
        h.frames.step(ms)
        const a = az()
        if ((Math.abs(a - prev) / ms) * 1000 > 0.01) last = h.frames.now // the last frame still turning faster than 0.01 rad/s
        prev = a
      }
      const out = { glide: az() - aUp, ms: last - t0, turned: az() - a0 }
      r.dispose()
      h.host.remove()
      h.host = makeHost(800, 600)
      return out
    }
    const fast = dragGlide(1000 / 60)
    const slow = dragGlide(1000 / 15)
    expect(Math.abs(fast.glide)).toBeGreaterThan(0.05)
    // The hand's moves leave the same glide at any frame rate (to the controls' stopping threshold; a share fixed per
    // frame left a 15 fps glide a third of the 60 fps one), and it lasts as long, to within 5%.
    expect(Math.abs(slow.glide - fast.glide)).toBeLessThan(Math.abs(fast.glide) * 1e-3)
    expect(Math.abs(slow.ms - fast.ms)).toBeLessThanOrEqual(fast.ms * 0.05)
    expect(Math.abs(slow.turned - fast.turned)).toBeLessThan(Math.abs(fast.turned) * 1e-3)
  })

  /** Runs screen frames until the next one drawn. */
  const toNextFrame = (r: ThreeRenderer): void => {
    const n = frames(r)
    for (let k = 0; k < 200 && frames(r) === n; k++) h.frames.step()
  }

  // world-visual 3 on the Windows runners: the Termpolis repository's own city took the GPU process 150 to 200 ms a
  // frame, so even 100 ms apart its looping motions held three of the four cores, the map's compile was starved past
  // 240 s and every call into the page waited seconds. With fences the next looping frame waits for the last to be
  // finished, then four times what it took (softwareLoopGap).
  it('with fences, waits for the GPU to finish a looping frame, then softwareLoopGap of what it took', () => {
    gpu.gpuName = SWIFTSHADER
    gpu.fences.on = true
    for (const [after, ms] of [[0, 1600], [60, 3200], [150, 4800]] as const) {
      gpu.fences.signalAfter = after
      const r = idle(DEFAULT_OPTS)
      drawnOver(r, 1000) // a looping frame's fence has been read: the pace is its cost's
      toNextFrame(r)
      const before = r.motionState().ringAngle
      const from = performance.now()
      const drawn = drawnOver(r, ms)
      toNextFrame(r)
      const span = (performance.now() - from) / 1000
      // The fence is read once a screen frame (16 ms): its cost is `after` to a frame more, and the frame drawn on
      // the first screen frame at least softwareLoopGap later.
      const most = softwareLoopGap(after)
      const least = softwareLoopGap(after + 16) + 16
      expect(drawn, `signalled after ${after} ms`).toBeLessThanOrEqual(ms / most + 1)
      expect(drawn, `signalled after ${after} ms`).toBeGreaterThanOrEqual(Math.floor(ms / least))
      // The motions keep their speed however far apart the frames are drawn.
      // (Frames 500 ms apart take their whole step: MAX_FRAME_DT would cut it to 250 ms and halve the speed.)
      expect(r.motionState().ringAngle - before).toBeCloseTo(span * 0.8, 2)
      // One fence a frame, each after the frame's commands, and only the last one kept.
      expect(gpu.fences.made.length).toBeGreaterThan(drawn)
      expect(gpu.fences.made.every((f) => f.condition === 0x9117 && f.flags === 0)).toBe(true)
      expect(gpu.fences.live.size).toBeLessThanOrEqual(1) // a signalled one is deleted once read
      toNextFrame(r) // just drawn: its fence is still there
      expect(gpu.fences.live.size).toBe(1)
      r.dispose()
      expect(gpu.fences.live.size).toBe(0) // dispose deletes it
      h.host.remove()
      h.host = makeHost(800, 600)
    }
  })

  /** Runs screen frames (16 ms) until the next one drawn, at most `max`; returns when it was drawn (performance.now). */
  const drawnNext = (r: ThreeRenderer, max = 1000): number => {
    const n = frames(r)
    for (let k = 0; k < max && frames(r) === n; k++) h.frames.step()
    expect(frames(r)).toBe(n + 1)
    return performance.now()
  }

  // world-responsive on the Linux runners: a change was drawn on the next frame whatever the GPU process was still
  // doing, and a looping frame whose fence had not come was drawn SOFTWARE_LOOP_MAX_MS after the last, so frames
  // queued in the GPU process, a draw call blocked the page for up to 18 s and Chromium's GPU watchdog ended it.
  it('a fence that never signals holds every frame back SOFTWARE_FENCE_MAX_MS, a change and the looping motions alike', () => {
    gpu.gpuName = SWIFTSHADER
    gpu.fences.on = true
    gpu.fences.signalAfter = null
    const r = idle(DEFAULT_OPTS)
    let at = drawnNext(r)
    for (let k = 0; k < 3; k++) {
      const next = drawnNext(r)
      expect(next - at).toBeGreaterThanOrEqual(SOFTWARE_FENCE_MAX_MS)
      expect(next - at).toBeLessThan(SOFTWARE_FENCE_MAX_MS + 16)
      at = next
    }
    // A change just after a frame waits for that frame's fence too, and is never given up on.
    r.setHovered('a')
    expect(drawnOver(r, SOFTWARE_FENCE_MAX_MS - 32)).toBe(0)
    expect(h.frames.pending()).toBe(1)
    expect(drawnNext(r) - at).toBeLessThan(SOFTWARE_FENCE_MAX_MS + 16)
    expect(gpu.fences.live.size).toBe(1) // the ones given up on are deleted
    r.dispose()
    expect(gpu.fences.live.size).toBe(0)
  })

  it('a change waits for the GPU to finish the last frame, and is drawn on the first screen frame after', async () => {
    gpu.gpuName = SWIFTSHADER
    gpu.fences.on = true
    gpu.fences.signalAfter = 300 // a city that takes the GPU process 300 ms a frame
    const r = idle(REDUCED, still())
    expect(h.frames.pending()).toBe(0) // nothing loops: it sleeps, the last frame's fence kept
    h.frames.advance(1000)
    // Long since finished: the change is drawn at once.
    r.setHovered('p')
    h.frames.step()
    const at = performance.now()
    expect(drawnOver(r, 0)).toBe(0)
    // The next change, a frame later: held until that frame's fence signals.
    r.setHovered('q')
    expect(drawnOver(r, 300 - 32)).toBe(0)
    const next = drawnNext(r)
    expect(next - at).toBeGreaterThanOrEqual(300)
    expect(next - at).toBeLessThan(300 + 16)
    // A flight (moving every frame) is drawn one frame in flight at a time: one frame each 300 ms, not 60 a second.
    let landed = false
    void r.flyTo({ pos: [10, 50, 60], target: [0, 0, 0] }).then(() => { landed = true })
    const drawn = drawnOver(r, 1600)
    expect(drawn).toBeLessThanOrEqual(1600 / 300 + 1)
    expect(drawn).toBeGreaterThanOrEqual(Math.floor(1600 / (300 + 16)))
    expect(gpu.fences.live.size).toBeLessThanOrEqual(1)
    for (let k = 0; !landed && k < 600; k++) { h.frames.step(); await Promise.resolve() }
    expect(landed).toBe(true) // it still lands, in fewer frames
    r.dispose()
  })

  it('a GPU puts in no fence; a lost context drops its fence, and one back without fences keeps SOFTWARE_LOOP_MS', () => {
    gpu.fences.on = true
    gpu.gpuName = GEFORCE
    const g = idle(DEFAULT_OPTS)
    expect(drawnOver(g, 480)).toBe(30)
    expect(gpu.fences.made).toEqual([])
    g.dispose()
    h.host.remove()
    h.host = makeHost(800, 600)
    gpu.gpuName = SWIFTSHADER
    gpu.fences.signalAfter = 150
    const r = idle(DEFAULT_OPTS)
    drawnOver(r, 1000)
    expect(drawnOver(r, 3200)).toBeLessThanOrEqual(3200 / SOFTWARE_LOOP_MAX_MS + 1)
    toNextFrame(r)
    const kept = [...gpu.fences.live]
    expect(kept.length).toBe(1)
    // Lost: the fence went with its context (not deleted into the new one).
    r.canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }))
    gpu.fences.on = false // back as WebGL 1
    const made = gpu.fences.made.length
    r.canvas.dispatchEvent(new Event('webglcontextrestored'))
    expect([...gpu.fences.live]).toEqual(kept)
    h.frames.run(20)
    const drawn = drawnOver(r, 1600)
    expect(drawn).toBeGreaterThanOrEqual(Math.floor(1600 / (SOFTWARE_LOOP_MS + 16)))
    expect(drawn).toBeLessThanOrEqual(1600 / SOFTWARE_LOOP_MS + 1)
    expect(gpu.fences.made.length).toBe(made) // none put in without fences
    r.dispose()
  })

  it('reads the name as RENDERER where the unmasked one is not given, and again when a lost context comes back', () => {
    gpu.gpuName = SWIFTSHADER
    gpu.debugInfo = false
    const r = idle(DEFAULT_OPTS)
    expect(r.drawnCounts().software).toBe(true) // the host draws its panels over the map opaque (WorldView)
    expect(drawnOver(r, 1600)).toBeLessThanOrEqual(1600 / SOFTWARE_LOOP_MS + 1)
    // Back on a GPU (a driver came back): every frame again.
    r.canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }))
    gpu.gpuName = GEFORCE
    r.canvas.dispatchEvent(new Event('webglcontextrestored'))
    expect(r.drawnCounts().software).toBe(false)
    h.frames.run(5)
    expect(drawnOver(r, 480)).toBe(30)
    r.dispose()
  })
})

describe('threeRenderer lost WebGL context', () => {
  const lose = (c: HTMLCanvasElement): Event => {
    const e = new Event('webglcontextlost', { cancelable: true })
    c.dispatchEvent(e)
    return e
  }

  it('on a loss: asks for the context back, draws nothing, and ends every motion; on the restore: builds the world again', async () => {
    const onContextLost = vi.fn()
    const onContextRestored = vi.fn()
    const r = createThreeRenderer(h.host, { ...DEFAULT_OPTS, onContextLost, onContextRestored })
    boxCanvas(r.canvas, 800, 600)
    r.draw(smallCity(), smallText(), false)
    h.frames.run(5)
    const flight = r.frame(['c'], false)
    const pulse = r.pulse(['e1'], false)
    r.animateChanges({ rise: ['a'], pulse: [] })
    h.frames.step()
    const e = lose(r.canvas)
    expect(e.defaultPrevented).toBe(true)
    expect(onContextLost).toHaveBeenCalledTimes(1)
    await flight // landed at once
    await pulse
    expect(r.motionState().flight.active).toBe(false)
    expect(r.drawnCounts().changing).toBe(0)
    expect(h.frames.pending()).toBe(0)
    const n = frames(r)
    r.setHovered('a') // a change while lost waits
    h.frames.run(10)
    expect(frames(r)).toBe(n)
    const draws = vi.spyOn(r, 'draw')
    r.canvas.dispatchEvent(new Event('webglcontextrestored'))
    expect(onContextRestored).toHaveBeenCalledTimes(1)
    expect(draws).not.toHaveBeenCalled() // built inside, as a theme change builds it (not through the returned object)
    expect(r.drawnCounts().conduits).toBe(2)
    h.frames.step()
    expect(frames(r)).toBe(n + 1)
    r.dispose()
  })

  it("a restore reads the GPU's buffer limits again and fits the buffer to them, a tighter cap first lowering the ratio (M5)", () => {
    vi.stubGlobal('devicePixelRatio', 2)
    resizeHost(h.host, 1920, 1080)
    const r = createThreeRenderer(h.host, DEFAULT_OPTS)
    expect(rendererOf().pixelRatios).toEqual([2]) // 3840 x 2160 fits the 16384 cap (and High's 4K budget)
    lose(r.canvas)
    gpu.limits = { renderbuffer: 2048, texture: 16384, viewport: [16384, 16384] } // back on a smaller GPU
    const from = rendererOf().buffers.length
    r.canvas.dispatchEvent(new Event('webglcontextrestored'))
    expect(rendererOf().getPixelRatio()).toBe(2048 / 1920)
    expect(gpu.composers[0].pixelRatios).toEqual([2048 / 1920])
    expect(rendererOf().sizes[rendererOf().sizes.length - 1]).toEqual([1920, 1080])
    expect(rendererOf().buffers.slice(from).filter(([x, y]) => x > 2048 + 1e-6 || y > 2048 + 1e-6)).toEqual([])
    lose(r.canvas)
    gpu.limits = { renderbuffer: 16384, texture: 16384, viewport: [16384, 16384] } // and on the big one again: the full ratio
    r.canvas.dispatchEvent(new Event('webglcontextrestored'))
    expect(rendererOf().getPixelRatio()).toBe(2)
    r.dispose()
  })

  it('a frame between the loss and its webglcontextlost event draws nothing and asks for no other; the event and the restore follow as ever', () => {
    const onContextLost = vi.fn()
    const r = createThreeRenderer(h.host, { ...DEFAULT_OPTS, onContextLost })
    boxCanvas(r.canvas, 800, 600)
    r.draw(smallCity(), smallText(), false)
    h.frames.run(5)
    r.setHovered('a') // a frame is asked for
    expect(h.frames.pending()).toBe(1)
    const n = frames(r)
    const renders = rendererOf().renders.length
    gpu.contextLost = true // loseContext(): the context is gone, its event not yet come
    h.frames.step()
    expect(frames(r)).toBe(n)
    expect(rendererOf().renders.length).toBe(renders)
    expect(h.frames.pending()).toBe(0)
    expect(lose(r.canvas).defaultPrevented).toBe(true)
    expect(onContextLost).toHaveBeenCalledTimes(1)
    gpu.contextLost = false
    r.canvas.dispatchEvent(new Event('webglcontextrestored'))
    h.frames.step()
    expect(frames(r)).toBe(n + 1)
    r.dispose()
  })

  it('a loss and restore before any world is drawn, and with no callbacks, still pauses and resumes the loop', () => {
    const r = createThreeRenderer(h.host, REDUCED)
    lose(r.canvas)
    h.frames.run(3)
    expect(h.frames.pending()).toBe(0)
    r.canvas.dispatchEvent(new Event('webglcontextrestored'))
    expect(h.frames.pending()).toBe(1)
    expect(r.drawnCounts().conduits).toBe(0)
    r.dispose()
  })

  it('a renderer disposed hears no context event (its listeners are gone before the context is forced lost)', () => {
    const onContextLost = vi.fn()
    const r = createThreeRenderer(h.host, { ...REDUCED, onContextLost })
    const canvas = r.canvas
    r.dispose()
    lose(canvas)
    canvas.dispatchEvent(new Event('webglcontextrestored'))
    expect(onContextLost).not.toHaveBeenCalled()
    expect(h.frames.pending()).toBe(0)
  })
})

describe('threeRenderer: a 4K canvas is never blank (look spec 5.3)', () => {
  function withObserver(): { fire: () => void } {
    let cb: () => void = () => {}
    vi.stubGlobal('ResizeObserver', class { constructor(f: () => void) { cb = f } observe(): void {} disconnect(): void {} })
    return { fire: () => cb() }
  }
  const last = (xs: number[]): number => xs[xs.length - 1]

  it('a shrunk drawing buffer steps the pixel ratio down until it fits, at most four times', () => {
    const ro = withObserver()
    vi.stubGlobal('devicePixelRatio', 2)
    resizeHost(h.host, 3840, 2160)
    // The browser gives at most half the pixels asked for: 3840 x 2160 is shrunk, and so is 2880 x 1620 (0.75);
    // 2160 x 1215 (0.75 x 0.75) fits.
    gpu.allocMax = (3840 * 2160) / 2
    const onBufferShrunk = vi.fn()
    const r = createThreeRenderer(h.host, { ...DEFAULT_OPTS, onBufferShrunk })
    expect(rendererOf().pixelRatios).toEqual([1, 0.75, 0.5625]) // High's 4K budget at 2x is a ratio of 1, then two steps
    expect(last(gpu.composers[0].pixelRatios)).toBe(0.5625)
    expect(onBufferShrunk).not.toHaveBeenCalled()
    const gl = rendererOf().getContext()
    expect([gl.drawingBufferWidth, gl.drawingBufferHeight]).toEqual([r.canvas.width, r.canvas.height])
    // Nothing fits now. The fit asks first for the pixels the browser gave the last shrunk buffer (half of 4K at 2x: a
    // ratio of about 0.707), then four more steps, then it gives up and says so, once for this fit.
    gpu.allocMax = 1000
    const from = rendererOf().pixelRatios.length
    ro.fire()
    const asked = rendererOf().pixelRatios.slice(from)
    expect(asked).toHaveLength(5)
    expect(asked[0]).toBeCloseTo(Math.SQRT1_2, 3)
    asked.slice(1).forEach((x, i) => expect(x).toBeCloseTo(asked[0] * 0.75 ** (i + 1), 9))
    expect(onBufferShrunk).toHaveBeenCalledTimes(1)
    // A frame does not test the buffer again: only a fit does.
    h.frames.run(10)
    expect(rendererOf().pixelRatios.length).toBe(from + 5)
    expect(onBufferShrunk).toHaveBeenCalledTimes(1)
    // The steps hold for later fits; a context that comes back starts from the full ratio again.
    gpu.allocMax = null
    r.canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }))
    r.canvas.dispatchEvent(new Event('webglcontextrestored'))
    expect(rendererOf().getPixelRatio()).toBe(1)
    // A lost context is never tested: a lost one answers no buffer worth reading.
    gpu.allocMax = 1000
    gpu.contextLost = true
    const fits = rendererOf().sizes.length
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      resizeHost(h.host, 1920, 1080) // a size the buffer does not have (the same size again is not fitted)
      ro.fire()
      vi.advanceTimersByTime(BUFFER_SETTLE_MS) // the view has drawn: its buffer is fitted once the size holds
    } finally {
      vi.useRealTimers()
    }
    expect(rendererOf().sizes.length).toBe(fits + 1) // the fit was made, and not tested
    expect(rendererOf().sizes[rendererOf().sizes.length - 1]).toEqual([1920, 1080])
    expect(rendererOf().getPixelRatio()).toBe(2) // the whole ratio at 1080p: a tested fit would have stepped it down
    expect(onBufferShrunk).toHaveBeenCalledTimes(1)
    gpu.contextLost = false
    r.dispose()
  })

  it('a shrunk buffer gets its sharpness back: a later fit asks for what the browser gave, and the whole ratio once that fits', () => {
    const ro = withObserver()
    vi.stubGlobal('devicePixelRatio', 2)
    resizeHost(h.host, 3840, 2160)
    gpu.allocMax = (3840 * 2160) / 2
    const r = createThreeRenderer(h.host, DEFAULT_OPTS)
    expect(rendererOf().pixelRatios).toEqual([1, 0.75, 0.5625])
    const whole = (): void => {
      const gl = rendererOf().getContext()
      expect([gl.drawingBufferWidth, gl.drawingBufferHeight]).toEqual([r.canvas.width, r.canvas.height])
    }
    // A smaller view: the whole ratio (2) fits in the pixels the browser gave, so the map is drawn at it again.
    resizeHost(h.host, 1280, 720)
    ro.fire()
    expect(last(rendererOf().pixelRatios)).toBe(2)
    whole()
    // Back to 4K: the most the browser gives is asked for at once (about 0.707, sharper than the 0.5625 the steps
    // reached), and it fits with no step down.
    resizeHost(h.host, 3840, 2160)
    const from = rendererOf().pixelRatios.length
    ro.fire()
    const ratio = last(rendererOf().pixelRatios)
    expect(ratio).toBeCloseTo(Math.SQRT1_2, 3)
    expect(rendererOf().pixelRatios.slice(from).every((x) => x >= ratio)).toBe(true)
    whole()
    r.dispose()
  })

  it('a renderer with no onBufferShrunk gives up quietly; the frames it presents are counted', () => {
    gpu.allocMax = 10
    const r = createThreeRenderer(h.host, REDUCED)
    expect(rendererOf().pixelRatios).toHaveLength(5)
    expect(r.drawnCounts().presented).toBe(0)
    boxCanvas(r.canvas, 800, 600)
    r.draw(smallCity(), smallText(), false)
    settle(h.frames)
    expect(r.drawnCounts().presented).toBe(frames(r))
    expect(r.drawnCounts().contextLost).toBe(false)
    gpu.contextLost = true
    expect(r.drawnCounts().contextLost).toBe(true)
    gpu.contextLost = false
    r.dispose()
  })

  it('a frame that throws is not counted as presented', () => {
    const r = idle()
    const n = r.drawnCounts().presented
    vi.spyOn(gpu.composers[0], 'render').mockImplementation(() => { throw new Error('GPU process gone') })
    r.setHovered('a')
    expect(() => h.frames.step()).toThrow('GPU process gone')
    expect(frames(r)).toBeGreaterThan(n)
    expect(r.drawnCounts().presented).toBe(n)
    r.dispose()
  })

  it('the canvas host takes the theme background on setTheme', () => {
    const r = createThreeRenderer(h.host, REDUCED)
    expect(r.canvas.style.background).toBe('var(--world-bg)')
    r.setTheme('blueprint', { background: '#061a33', district: '#002244', conduit: '#3366ff', glow: '#66ccff', text: '#ffffff', fogDensity: 0.005 })
    expect(h.host.style.getPropertyValue('--world-bg')).toBe('#061a33')
    r.draw(smallCity(), smallText(), false)
    r.setTheme('glass', { background: '#111827', district: '#eeeeee', conduit: '#0000ff', glow: '#00ffff', text: '#000000', fogDensity: 0.004 })
    expect(h.host.style.getPropertyValue('--world-bg')).toBe('#111827')
    r.dispose()
  })
})

describe('threeRenderer reduced motion switched while open', () => {
  it('switched on: a flight lands, a pulse and a change end, the turn stops, and the loop then sleeps', async () => {
    const r = createThreeRenderer(h.host, DEFAULT_OPTS)
    boxCanvas(r.canvas, 800, 600)
    r.draw(smallCity(), smallText(), false)
    h.frames.run(5)
    const flight = r.frame(['c'], false)
    const pulse = r.pulse(['e1'], false)
    r.animateChanges({ rise: ['a'], pulse: ['b'] })
    r.setRightReserve(200) // the picture eases to the new free area
    h.frames.step()
    expect(r.motionState().flight.active).toBe(true)
    r.setReducedMotion(true)
    await flight
    await pulse
    expect(r.motionState().flight.active).toBe(false)
    expect(r.drawnCounts().changing).toBe(0)
    const ring = r.motionState().ringAngle
    settle(h.frames)
    expect(h.frames.pending()).toBe(0)
    expect(r.motionState().ringAngle).toBe(ring) // stands still
    // The next flight lands at once.
    void r.overview(false)
    expect(r.motionState().flight.active).toBe(false)
    r.setReducedMotion(true) // the same again: nothing
    expect(h.frames.pending()).toBe(1)
    r.dispose()
  })

  it('switched off: the looping motions move again, and the opening turn comes back only if nothing ended it', () => {
    const r = idle(REDUCED)
    const ring = r.motionState().ringAngle
    r.setReducedMotion(false)
    h.frames.run(20)
    expect(r.motionState().ringAngle).not.toBe(ring)
    expect(h.frames.pending()).toBe(1)
    const cam = r.getCamera().pos
    h.frames.run(20)
    expect(r.getCamera().pos).not.toEqual(cam) // the turn is back
    r.setReducedMotion(true)
    void r.overview(true) // a flight ends the turn for good
    r.setReducedMotion(false)
    const at = r.getCamera().pos
    h.frames.run(20)
    expect(r.getCamera().pos).toEqual(at)
    r.dispose()
    r.setReducedMotion(true) // after dispose: nothing
    expect(h.frames.pending()).toBe(0)
  })
})

describe('threeRenderer: nothing waits on a frame that will not come (U5, U6)', () => {
  it('stopFlight ends a flight under way where the camera is, and its promise settles; with none it does nothing', async () => {
    const r = createThreeRenderer(h.host, DEFAULT_OPTS)
    boxCanvas(r.canvas, 800, 600)
    r.draw(smallCity(), smallText(), false)
    h.frames.run(5)
    r.stopFlight() // none under way
    let landed = false
    const flight = r.frame(['c'], false).then(() => { landed = true })
    h.frames.step(3)
    const mid = r.getCamera()
    expect(r.motionState().flight.active).toBe(true)
    r.stopFlight()
    await flight
    expect(landed).toBe(true)
    expect(r.motionState().flight.active).toBe(false)
    h.frames.step(3)
    expect(r.getCamera()).toEqual(mid) // stopped where it was, not put at the end
    r.dispose()
    expect(() => r.stopFlight()).not.toThrow()
  })

  it('paused, a flight under way lands and a pulse ends; flights and pulses asked for while paused settle at once', async () => {
    const r = createThreeRenderer(h.host, DEFAULT_OPTS)
    boxCanvas(r.canvas, 800, 600)
    r.draw(smallCity(), smallText(), false)
    h.frames.run(5)
    const flight = r.frame(['c'], false)
    const pulse = r.pulse(['e1'], false)
    h.frames.step(2)
    r.setPaused(true)
    await flight
    await pulse
    expect(r.motionState().flight.active).toBe(false)
    const end = r.getCamera()
    await r.overview(false) // no frame will move it: put there at once
    expect(r.getCamera()).not.toEqual(end)
    await r.pulse(['e1'], false)
    expect(h.frames.pending()).toBe(0)
    r.setPaused(false)
    const again = r.frame(['c'], false)
    h.frames.step()
    expect(r.motionState().flight.active).toBe(true) // unpaused, flights move again
    r.stopFlight()
    await again
    r.dispose()
  })

  it('a flight asked for while the context is lost lands at once', async () => {
    const r = createThreeRenderer(h.host, DEFAULT_OPTS)
    boxCanvas(r.canvas, 800, 600)
    r.draw(smallCity(), smallText(), false)
    h.frames.run(5)
    r.canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }))
    await r.frame(['c'], false)
    await r.pulse(['e1'], false)
    expect(r.motionState().flight.active).toBe(false)
    r.dispose()
  })
})

// The frame-time sampler fed by the loop (look spec 6.1, plan Task 1): each drawn frame's gap, counted only when the
// frame before it was drawn back to back with it.
describe('threeRenderer frame times (look spec 6.1)', () => {
  const perf = (r: ThreeRenderer) => r.drawnCounts().perf
  /** Stubs the ResizeObserver; returns a call that reports the host resized. */
  const observeResizes = (): (() => void) => {
    let observed: ((entries?: Array<{ target: Element }>) => void) | null = null
    vi.stubGlobal('ResizeObserver', class {
      constructor(cb: (entries?: Array<{ target: Element }>) => void) { observed = cb }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    })
    return () => { (observed as unknown as (entries?: Array<{ target: Element }>) => void)([{ target: h.host }]) }
  }

  it('a staged first-frame slowdown (test only) makes the first frame take that many times as long, read when it is drawn', () => {
    gpu.gpuName = GEFORCE
    let by = 1
    const r = createThreeRenderer(h.host, { ...DEFAULT_OPTS, firstFrameSlowdown: () => by })
    boxCanvas(r.canvas, 800, 600)
    r.draw(smallCity(), smallText(), false)
    by = 2 // read at the frame, not at build
    // The wait reads the clock until it has passed: here each read moves the manual clock on a millisecond.
    const now = vi.mocked(performance.now)
    let reads = 0
    now.mockImplementation(() => { reads++; h.frames.advance(1); return h.frames.now })
    const before = h.frames.now
    h.frames.step(20)
    // The frame waited out the 20 ms it took once more, on the clock: twice as long.
    const first = perf(r).firstFrameMs as number
    expect(first).toBeGreaterThanOrEqual(40)
    expect(first).toBeLessThan(40 + 30) // the frame's own clock reads, and no more than that
    expect(h.frames.now - before).toBeGreaterThanOrEqual(40)
    expect(reads).toBeGreaterThan(10)
    // Only the first frame: the next ones are not held. The clock still moves on each read, so a frame held by mistake
    // ends (its wait reads the clock past its end) and fails here, not by hanging the worker on a stopped clock: each
    // frame takes its 16 ms and its own few reads, where one more hold would add at least the first frame's time.
    for (let i = 0; i < 5; i++) {
      const at = h.frames.now
      h.frames.step(16)
      expect(h.frames.now - at, `frame ${i + 2} was held`).toBeLessThan(16 + 20)
    }
    expect(perf(r).firstFrameMs).toBe(first)
    now.mockImplementation(() => h.frames.now)
    r.dispose()
    // 1 or no number: the first frame is timed as it is.
    for (const slow of [() => 1, () => NaN]) {
      const q = createThreeRenderer(h.host, { ...DEFAULT_OPTS, firstFrameSlowdown: slow })
      boxCanvas(q.canvas, 800, 600)
      q.draw(smallCity(), smallText(), false)
      h.frames.step(20)
      expect(perf(q).firstFrameMs).toBe(20)
      q.dispose()
    }
  })

  it('feeds each drawn frame: p50/p95 of the gaps, a frame over DROPPED_FRAME_MS is a drop, and the first frame is timed', () => {
    gpu.gpuName = GEFORCE
    const r = createThreeRenderer(h.host, DEFAULT_OPTS) // the looping motions never stop: a frame every 16 ms
    boxCanvas(r.canvas, 800, 600)
    expect(perf(r)).toEqual({ tier: 'high', frames: 0, p50: 0, p95: 0, p99: 0, worst: 0, drops: 0, firstFrameMs: null, resizeWorstMs: 0 })
    h.frames.step() // a frame before any city: no first frame yet
    expect(perf(r).firstFrameMs).toBeNull()
    r.draw(smallCity(), smallText(), false)
    h.frames.step(20)
    expect(perf(r).firstFrameMs).toBe(20)
    h.frames.run(3) // the five frames after the view opened (a new buffer) are not counted, these two included
    expect(perf(r).frames).toBe(0)
    h.frames.run(100)
    expect(perf(r)).toMatchObject({ tier: 'high', frames: 100, p50: 16, p95: 16, worst: 16, drops: 0, firstFrameMs: 20 })
    h.frames.step(DROPPED_FRAME_MS) // at the line: not a drop
    h.frames.step(40)
    expect(perf(r)).toMatchObject({ frames: 102, worst: 40, drops: 1 })
    // The ring holds the last 600 gaps.
    h.frames.run(700)
    expect(perf(r)).toMatchObject({ frames: 600, p50: 16, p99: 16, worst: 16, drops: 1, firstFrameMs: 20 })
    r.dispose()
  })

  it('an idle sleep is never a slow frame: the gap of the frame that wakes it, and the five after, are not counted', () => {
    gpu.gpuName = GEFORCE
    const r = idle()
    const n = perf(r).frames
    h.frames.advance(2000)
    r.setHovered('a')
    const ran = settle(h.frames)
    // The frame that wakes it is the first of the five not counted.
    expect(ran).toBeGreaterThan(5)
    expect(perf(r).frames).toBe(n + ran - 5)
    expect(perf(r).worst).toBeLessThan(2000)
    expect(perf(r).drops).toBe(0)
    r.dispose()
  })

  it("a resize breaks the chain, and its own cost is kept, the longest (not the wait for the next frame)", () => {
    gpu.gpuName = GEFORCE
    const resized = observeResizes()
    // Each read of the host's width during a resize takes `cost` ms of the clock: the resize's own work.
    let cost = 0
    Object.defineProperty(h.host, 'clientWidth', { configurable: true, get: () => { h.frames.advance(cost); return (h.host as unknown as { _w: number })._w } })
    const timedResize = (ms: number): number => { cost = ms; const t0 = h.frames.now; resized(); cost = 0; return h.frames.now - t0 }
    const r = createThreeRenderer(h.host, DEFAULT_OPTS)
    boxCanvas(r.canvas, 800, 600)
    expect(timedResize(50)).toBeGreaterThan(0) // the observer's first call, as the view opens: not a resize to time
    r.draw(smallCity(), smallText(), false)
    h.frames.run(20)
    expect(perf(r).resizeWorstMs).toBe(0)
    const n = perf(r).frames
    resizeHost(h.host, 640, 480)
    const took = timedResize(7)
    expect(took).toBeGreaterThan(0)
    expect(perf(r).resizeWorstMs).toBe(took)
    h.frames.step(90) // the frame at the new size: a slow one, but not counted, and not the resize's cost
    h.frames.run(4) // and the four after it: five not counted
    expect(perf(r).resizeWorstMs).toBe(took)
    expect(perf(r).frames).toBe(n)
    expect(perf(r).worst).toBe(16)
    h.frames.step()
    expect(perf(r).frames).toBe(n + 1)
    resizeHost(h.host, 700, 500)
    expect(timedResize(1)).toBeLessThan(took)
    h.frames.step(30)
    expect(perf(r).resizeWorstMs).toBe(took)
    r.perfBegin() // a frame-time window keeps its own resizes: the longest since it began
    expect(perf(r).resizeWorstMs).toBe(0)
    resizeHost(h.host, 720, 500)
    const inWindow = timedResize(2)
    expect(perf(r).resizeWorstMs).toBe(inWindow)
    r.dispose()
  })

  /** A renderer that has drawn a still city in an 800 x 600 view (its loop sleeps), under fake timeouts (undone by `done`). */
  const drawnView = (): { r: ThreeRenderer; resized: () => void; fits: () => number; done: () => void } => {
    gpu.gpuName = GEFORCE
    const resized = observeResizes()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const r = createThreeRenderer(h.host, REDUCED)
    boxCanvas(r.canvas, 800, 600)
    resized() // the observer's first call, as the view opens
    r.draw(still(), smallText(), false)
    settle(h.frames)
    expect(r.drawnCounts().presented).toBeGreaterThan(0)
    return { r, resized, fits: () => rendererOf().sizes.length, done: () => { r.dispose(); vi.useRealTimers() } }
  }
  const lastSize = (xs: Array<[number, number]>): [number, number] => xs[xs.length - 1]

  it('a resize once the view has drawn stretches the buffer it has, and fits it once the size holds (a divider dragged resizes every frame)', () => {
    const v = drawnView()
    try {
      const before = v.fits()
      const composed = gpu.composers[0].sizes.length
      // Thirty resizes 10 ms apart, as a dragged divider gives: the canvas is stretched to each, no buffer is fitted.
      for (let k = 1; k <= 30; k++) {
        resizeHost(h.host, 800 - k * 10, 600)
        v.resized()
        expect([v.r.canvas.style.width, v.r.canvas.style.height]).toEqual([`${800 - k * 10}px`, '600px'])
        vi.advanceTimersByTime(10)
      }
      expect(v.fits()).toBe(before)
      expect(gpu.composers[0].sizes).toHaveLength(composed)
      // The size holds: the buffer is fitted to it once, the composer's with it, and a frame is drawn at it.
      settle(h.frames)
      expect(h.frames.pending()).toBe(0) // the loop sleeps: only the fit wakes it
      vi.advanceTimersByTime(BUFFER_SETTLE_MS - 11)
      expect(v.fits()).toBe(before)
      vi.advanceTimersByTime(1)
      expect(v.fits()).toBe(before + 1)
      expect(lastSize(rendererOf().sizes)).toEqual([500, 600])
      expect(lastSize(gpu.composers[0].sizes)).toEqual([500, 600])
      expect(h.frames.pending()).toBe(1)
      vi.advanceTimersByTime(BUFFER_SETTLE_MS * 4)
      expect(v.fits()).toBe(before + 1)
    } finally {
      v.done()
    }
  })

  it('a pane hidden (a 1 by 1 view) or shown again has its buffer fitted at once: there is no picture to stretch', () => {
    const v = drawnView()
    try {
      const before = v.fits()
      resizeHost(h.host, 0, 0) // hidden: the view is 1 by 1
      v.resized()
      expect(v.fits()).toBe(before + 1)
      expect(lastSize(rendererOf().sizes)).toEqual([1, 1])
      resizeHost(h.host, 640, 480) // shown again: from 1 by 1
      v.resized()
      expect(v.fits()).toBe(before + 2)
      expect(lastSize(rendererOf().sizes)).toEqual([640, 480])
      resizeHost(h.host, 640, 0) // a view 1 high
      v.resized()
      expect(lastSize(rendererOf().sizes)).toEqual([640, 1])
      vi.advanceTimersByTime(BUFFER_SETTLE_MS)
      expect(v.fits()).toBe(before + 3)
    } finally {
      v.done()
    }
  })

  it('a buffer waiting to be fitted is let go by a new pixel ratio, which fits it at once, and by dispose', () => {
    const queries: Array<() => void> = []
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: (_: string, f: () => void) => { queries.push(f) }, removeEventListener: () => {} }))
    const v = drawnView()
    try {
      const before = v.fits()
      resizeHost(h.host, 700, 600)
      v.resized()
      expect(v.fits()).toBe(before)
      queries[queries.length - 1]() // the window moved to another display
      expect(v.fits()).toBe(before + 1)
      expect(lastSize(rendererOf().sizes)).toEqual([700, 600])
      vi.advanceTimersByTime(BUFFER_SETTLE_MS)
      expect(v.fits()).toBe(before + 1)
      resizeHost(h.host, 650, 600)
      v.resized()
      v.r.dispose()
      const gone = v.fits()
      vi.advanceTimersByTime(BUFFER_SETTLE_MS * 2)
      expect(v.fits()).toBe(gone) // no fit comes after dispose
    } finally {
      vi.useRealTimers()
    }
  })

  it('a settle after a new pixel ratio already fitted the buffer to the size fits it only for a size or ratio it does not have: the observer reporting the same size again fits nothing more (each fit clears the buffer)', () => {
    const queries: Array<() => void> = []
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: (_: string, f: () => void) => { queries.push(f) }, removeEventListener: () => {} }))
    const v = drawnView()
    try {
      const before = v.fits()
      resizeHost(h.host, 440, 600)
      v.resized()
      queries[queries.length - 1]() // the window moved to another display: the buffer fitted to 440x600 at once
      expect(v.fits()).toBe(before + 1)
      v.resized() // the observer reports the same size again
      vi.advanceTimersByTime(BUFFER_SETTLE_MS)
      expect(v.fits()).toBe(before + 1) // the buffer has the size and ratio: not fitted (cleared) again
      // A size it does not have is fitted once the size holds, as before.
      resizeHost(h.host, 420, 600)
      v.resized()
      vi.advanceTimersByTime(BUFFER_SETTLE_MS)
      expect(v.fits()).toBe(before + 2)
      expect(lastSize(rendererOf().sizes)).toEqual([420, 600])
      resizeHost(h.host, 420, 580) // a height alone it does not have
      v.resized()
      vi.advanceTimersByTime(BUFFER_SETTLE_MS)
      expect(v.fits()).toBe(before + 3)
      expect(lastSize(rendererOf().sizes)).toEqual([420, 580])
      // The same size at a ratio it does not have (the screen's ratio changed, its media query not yet told): fitted.
      const ratio = rendererOf().getPixelRatio()
      vi.stubGlobal('devicePixelRatio', 2)
      v.resized()
      vi.advanceTimersByTime(BUFFER_SETTLE_MS)
      expect(v.fits()).toBe(before + 4)
      expect(rendererOf().getPixelRatio()).not.toBe(ratio)
    } finally {
      v.done()
      vi.unstubAllGlobals()
    }
  })

  it('drawnCounts gives the last frame triangles with its draw calls (the perf soak records both)', () => {
    gpu.gpuName = GEFORCE
    const r = createThreeRenderer(h.host, DEFAULT_OPTS)
    boxCanvas(r.canvas, 800, 600)
    expect(r.drawnCounts().triangles).toBe(0)
    r.draw(smallCity(), smallText(), false)
    rendererOf().info.render.triangles = 1234
    h.frames.step()
    expect(r.drawnCounts().triangles).toBe(1234)
    r.dispose()
  })

  it('perfBegin/perfEnd: the counted frames between them; perfEnd with none begun has no frames', () => {
    gpu.gpuName = GEFORCE
    const r = createThreeRenderer(h.host, DEFAULT_OPTS)
    boxCanvas(r.canvas, 800, 600)
    r.draw(smallCity(), smallText(), false)
    h.frames.run(20)
    expect(r.perfEnd()).toEqual({ frames: 0, p50: 0, p95: 0, p99: 0, worst: 0 })
    r.perfBegin()
    h.frames.run(9)
    h.frames.step(30)
    expect(r.perfEnd()).toEqual({ frames: 10, p50: 16, p95: 30, p99: 30, worst: 30 })
    // perf() is drawnCounts().perf, read alone.
    expect(r.perf()).toEqual(r.drawnCounts().perf)
    expect(r.perf().tier).toBe('high')
    expect(r.perf().frames).toBeGreaterThan(0)
    h.frames.run(5)
    expect(r.perfEnd().frames).toBe(0)
    r.dispose()
  })

  it('in software, a frame held back to the loop pace is not counted; a wait for the GPU is part of the next frame', () => {
    gpu.gpuName = SWIFTSHADER
    const r = idle(DEFAULT_OPTS) // the looping motions alone: drawn every SOFTWARE_LOOP_MS
    const n = perf(r).frames
    const drawn = frames(r)
    h.frames.run(100)
    expect(frames(r)).toBeGreaterThan(drawn)
    expect(perf(r).frames).toBe(n)
    expect(perf(r).worst).toBeLessThan(SOFTWARE_LOOP_MS)
    r.dispose()
  })
})

describe('sameLayout', () => {
  it('is true only for the same labels, each nudged the same', () => {
    const a = new Map<string, readonly [number, number]>([['x', [0, 0]], ['y', [0, 4]]])
    expect(sameLayout(a, new Map(a))).toBe(true)
    expect(sameLayout(a, new Map([['x', [0, 0]]]))).toBe(false)
    expect(sameLayout(a, new Map([['x', [0, 0]], ['z', [0, 4]]]))).toBe(false)
    expect(sameLayout(a, new Map([['x', [0, 0]], ['y', [1, 4]]]))).toBe(false)
    expect(sameLayout(a, new Map([['x', [0, 0]], ['y', [0, 5]]]))).toBe(false)
  })
})
