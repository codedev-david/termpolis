// threeRenderer: frames on demand, a lost WebGL context, and reduced motion switched while the view is open.
// An idle city draws no frame; every change wakes the loop, which draws while anything moves and a few frames more
// (SETTLE_FRAMES), then sleeps. The frame stepper drives performance.now, which THREE.Clock, the camera rig and the
// change animator read.
import { describe, expect, it, vi } from 'vitest'
import { createThreeRenderer, sameLayout, sameRects, SETTLE_FRAMES, type ThreeRenderer } from '../../../src/renderer/src/world/engine/threeRenderer'
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
    // Low quality has no dust; this city has no lines, rings, fog or pulses; the turn is ended by a flight.
    h.host.remove()
    h.host = makeHost(800, 600)
    const calm = idle({ quality: 'low', reducedMotion: false }, still())
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
    // Low quality draws through the renderer, high through the composer, whose render pass calls it: either way.
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
    // Low quality has no dust, and this city has no lines, rings, fog or pulses: only the turn moves.
    for (const [name, every] of [[SWIFTSHADER, false], [GEFORCE, true]] as const) {
      gpu.gpuName = name
      const r = idle({ quality: 'low', reducedMotion: false }, still())
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
    // Low quality has no dust and this city has no lines, rings, fog or pulses: once the turn ends, only the dots loop.
    for (const [name, every] of [[SWIFTSHADER, false], [GEFORCE, true]] as const) {
      gpu.gpuName = name
      const r = idle({ quality: 'low', reducedMotion: false }, still())
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
    const r = idle({ quality: 'low', reducedMotion: false }, still())
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
    resizeHost(h.host, 3840, 2160)
    const r = createThreeRenderer(h.host, DEFAULT_OPTS)
    expect(rendererOf().pixelRatios).toEqual([2]) // 7680 x 4320 fits the 16384 cap
    lose(r.canvas)
    gpu.limits = { renderbuffer: 4096, texture: 16384, viewport: [16384, 16384] } // back on a smaller GPU
    const from = rendererOf().buffers.length
    r.canvas.dispatchEvent(new Event('webglcontextrestored'))
    expect(rendererOf().getPixelRatio()).toBe(4096 / 3840)
    expect(gpu.composers[0].pixelRatios).toEqual([4096 / 3840])
    expect(rendererOf().sizes[rendererOf().sizes.length - 1]).toEqual([3840, 2160])
    expect(rendererOf().buffers.slice(from).filter(([x, y]) => x > 4096 + 1e-6 || y > 4096 + 1e-6)).toEqual([])
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
