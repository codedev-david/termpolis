// threeRenderer: input. WASD/QE flying, the wheel and the orbit limits (with the device-pixel-ratio
// below 1 regression), a drag handing the camera to the hand, and resizing. OrbitControls is real; it
// listens on the canvas, so the events are dispatched there as a browser would.
import { describe, expect, it, vi } from 'vitest'
import { createThreeRenderer, SETTLE_FRAMES, type ThreeRenderer } from '../../../src/renderer/src/world/engine/threeRenderer'
import type { SceneModel } from '../../../src/renderer/src/world/engine/sceneModel'
import {
  bldg, boxCanvas, cameraOf, DEFAULT_OPTS, district, emptyText, gpu, rendererOf, resizeHost, smallCity, smallText, withHarness,
} from './threeHarness'

vi.mock('three', async (orig) => ({ ...(await orig<typeof import('three')>()), WebGLRenderer: (await import('./threeHarness')).FakeWebGLRenderer }))
vi.mock('three/examples/jsm/postprocessing/EffectComposer.js', async () => ({ EffectComposer: (await import('./threeHarness')).FakeEffectComposer }))
vi.mock('three/examples/jsm/postprocessing/RenderPass.js', async () => ({ RenderPass: (await import('./threeHarness')).FakeRenderPass }))
vi.mock('three/examples/jsm/postprocessing/UnrealBloomPass.js', async () => ({ UnrealBloomPass: (await import('./threeHarness')).FakeUnrealBloomPass }))
vi.mock('three/examples/jsm/postprocessing/OutputPass.js', async () => ({ OutputPass: (await import('./threeHarness')).FakeOutputPass }))

const h = withHarness()

const distOf = (r: ThreeRenderer): number => {
  const { pos, target } = r.getCamera()
  return Math.hypot(pos[0] - target[0], pos[1] - target[1], pos[2] - target[2])
}
const key = (type: 'keydown' | 'keyup', k: string): void => { h.host.dispatchEvent(new KeyboardEvent(type, { key: k, bubbles: true })) }
const wheel = (r: ThreeRenderer, deltaY: number): WheelEvent => {
  const e = new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true, clientX: 400, clientY: 300 })
  r.canvas.dispatchEvent(e)
  return e
}
/** A pointer press and release on the canvas: OrbitControls' drag start and end. */
const press = (r: ThreeRenderer, type: 'pointerdown' | 'pointerup'): void => {
  r.canvas.dispatchEvent(new PointerEvent(type, { pointerId: 1, button: 0, pointerType: 'mouse', clientX: 400, clientY: 300, bubbles: true }))
}
const readyCanvas = (r: ThreeRenderer): void => {
  boxCanvas(r.canvas, 800, 600)
  r.canvas.setPointerCapture = vi.fn()
  r.canvas.releasePointerCapture = vi.fn()
  Object.defineProperty(r.canvas, 'clientWidth', { configurable: true, value: 800 })
  Object.defineProperty(r.canvas, 'clientHeight', { configurable: true, value: 600 })
}

describe('threeRenderer keys', () => {
  it('W/S move along the ground the camera faces, A/D across it, E up and Q down; Shift is faster; keyup and blur stop', async () => {
    const r = createThreeRenderer(h.host, { quality: 'high', reducedMotion: true })
    await r.overview(true)
    h.frames.step(16)
    const at = (): { pos: number[]; target: number[] } => r.getCamera()
    const start = at()
    // ground-plane forward: from the camera toward its target, flattened
    const fx = start.target[0] - start.pos[0]
    const fz = start.target[2] - start.pos[2]
    const fl = Math.hypot(fx, fz)
    key('keydown', 'w')
    h.frames.step(20)
    const w1 = at()
    const step = 28 * 0.02
    expect(w1.pos[0] - start.pos[0]).toBeCloseTo((fx / fl) * step, 4)
    expect(w1.pos[2] - start.pos[2]).toBeCloseTo((fz / fl) * step, 4)
    expect(w1.pos[1]).toBeCloseTo(start.pos[1], 6)
    expect(w1.target[0] - start.target[0]).toBeCloseTo((fx / fl) * step, 4) // the target goes with it
    key('keyup', 'w')
    h.frames.step(20)
    expect(at().pos).toEqual(w1.pos)
    // E flies up, Q down
    key('keydown', 'E')
    h.frames.step(20)
    expect(at().pos[1] - w1.pos[1]).toBeCloseTo(step, 4)
    key('keyup', 'E')
    const e1 = at()
    key('keydown', 'q')
    h.frames.step(20)
    expect(at().pos[1] - e1.pos[1]).toBeCloseTo(-step, 4)
    key('keyup', 'q')
    // S back, D across (right of forward), A the other way; Shift runs at 60
    const s0 = at()
    key('keydown', 's')
    key('keydown', 'Shift')
    h.frames.step(20)
    expect(at().pos[0] - s0.pos[0]).toBeCloseTo((-fx / fl) * 60 * 0.02, 4)
    key('keyup', 's')
    key('keyup', 'Shift')
    const d0 = at()
    key('keydown', 'd')
    h.frames.step(20)
    const rx = -fz / fl
    const rz = fx / fl
    expect(at().pos[0] - d0.pos[0]).toBeCloseTo(rx * step, 4)
    expect(at().pos[2] - d0.pos[2]).toBeCloseTo(rz * step, 4)
    key('keyup', 'd')
    const a0 = at()
    key('keydown', 'a')
    h.frames.step(20)
    expect(at().pos[0] - a0.pos[0]).toBeCloseTo(-rx * step, 4)
    // a blur (focus leaves the view) lets go of every key
    h.host.dispatchEvent(new FocusEvent('blur'))
    const b0 = at()
    h.frames.step(20)
    expect(at().pos).toEqual(b0.pos)
    // another key is remembered but moves nothing
    key('keydown', 'Enter')
    h.frames.step(20)
    expect(at().pos).toEqual(b0.pos)
    r.dispose()
  })

  it('a flying key takes the camera off the overview: a resize then leaves it where it is', async () => {
    const r = createThreeRenderer(h.host, { quality: 'low', reducedMotion: true })
    r.draw(smallCity(), smallText(), false)
    await r.overview(true)
    key('keydown', 'w')
    h.frames.step(20)
    key('keyup', 'w')
    const moved = r.getCamera()
    resizeHost(h.host, 1000, 700)
    window.dispatchEvent(new Event('resize'))
    expect(r.getCamera()).toEqual(moved)
    r.dispose()
  })
})

describe('threeRenderer wheel and orbit limits', () => {
  it('at a ratio of 1, OrbitControls zooms a notch to 0.95 of the distance, and out by 1/0.95', async () => {
    vi.stubGlobal('devicePixelRatio', 1)
    const r = createThreeRenderer(h.host, { quality: 'high', reducedMotion: true })
    readyCanvas(r)
    await r.overview(true)
    const d0 = distOf(r)
    const e = wheel(r, -100)
    expect(e.defaultPrevented).toBe(true)
    expect(distOf(r)).toBeCloseTo(d0 * 0.95, 4)
    wheel(r, 100)
    expect(distOf(r)).toBeCloseTo(d0, 4)
    r.dispose()
  })

  it('below a ratio of 1 a notch moves the camera the same 0.95, not to a distance limit (the zoomed-out page bug)', async () => {
    vi.stubGlobal('devicePixelRatio', 0.9)
    const r = createThreeRenderer(h.host, { quality: 'high', reducedMotion: true })
    readyCanvas(r)
    await r.overview(true)
    const d0 = distOf(r)
    const e = wheel(r, -100)
    expect(e.defaultPrevented).toBe(true)
    expect(distOf(r)).toBeCloseTo(d0 * 0.95, 4)
    expect(distOf(r)).toBeGreaterThan(6)
    wheel(r, 100)
    expect(distOf(r)).toBeCloseTo(d0, 4)
    wheel(r, 0) // no step: nothing moves
    expect(distOf(r)).toBeCloseTo(d0, 4)
    // a half notch: half the step
    wheel(r, -50)
    expect(distOf(r)).toBeCloseTo(d0 * Math.pow(0.95, 0.5), 4)
    // many notches: held at the limits, 6 near and 420 far
    for (let i = 0; i < 200; i++) wheel(r, -100)
    expect(distOf(r)).toBeCloseTo(6, 6)
    for (let i = 0; i < 200; i++) wheel(r, 100)
    expect(distOf(r)).toBeCloseTo(420, 6)
    // the wheel took the camera off the overview: the rig counts it as the hand's
    expect(r.motionState().flight.active).toBe(false)
    r.dispose()
  })

  it.each([
    [2, -100, 0.5],
    [2.5, -75, 75 / 200], // OrbitControls takes the whole ratio (2), and a trackpad delta stays proportional
    [3, 60, -60 / 300]
  ])('above a ratio of 1 (%s) the fix stands aside and OrbitControls scales the notch by the whole ratio', async (dpr, delta, power) => {
    vi.stubGlobal('devicePixelRatio', dpr)
    const r = createThreeRenderer(h.host, { quality: 'high', reducedMotion: true })
    readyCanvas(r)
    await r.overview(true)
    const d0 = distOf(r)
    const e = wheel(r, delta)
    expect(e.defaultPrevented).toBe(true)
    expect(distOf(r)).toBeCloseTo(d0 * Math.pow(0.95, power), 4)
    r.dispose()
  })

  it('a wheel during a drag does nothing, as OrbitControls has it, at any ratio', async () => {
    vi.stubGlobal('devicePixelRatio', 0.5)
    const r = createThreeRenderer(h.host, { quality: 'high', reducedMotion: true })
    readyCanvas(r)
    await r.overview(true)
    const d0 = distOf(r)
    press(r, 'pointerdown')
    wheel(r, -100)
    expect(distOf(r)).toBeCloseTo(d0, 6)
    press(r, 'pointerup')
    wheel(r, -100)
    expect(distOf(r)).toBeCloseTo(d0 * 0.95, 4)
    r.dispose()
  })

  it('a big city lets the camera back off to 1.6 times its overview distance; it never goes under the ground', async () => {
    vi.stubGlobal('devicePixelRatio', 0.75)
    const r = createThreeRenderer(h.host, { quality: 'low', reducedMotion: true })
    readyCanvas(r)
    const wide: SceneModel = {
      districts: [district('w', [-400, 0, 0], 60), district('e', [400, 0, 0], 60)],
      buildings: [bldg('w1', [-400, 0, 0]), bldg('e1', [400, 0, 0])],
      conduits: [],
      orbs: [],
    }
    r.draw(wide, emptyText(), false)
    await r.overview(true)
    const over = distOf(r)
    expect(over * 1.6).toBeGreaterThan(420)
    for (let i = 0; i < 100; i++) wheel(r, 100)
    expect(distOf(r)).toBeCloseTo(over * 1.6, 3)
    // a pose under the ground is lifted to the polar limit (PI * 0.495 from straight up)
    await r.flyTo({ pos: [0, -50, 30], target: [0, 0, 0] }, true)
    const { pos, target } = r.getCamera()
    const d = Math.hypot(pos[0] - target[0], pos[1] - target[1], pos[2] - target[2])
    expect(Math.acos((pos[1] - target[1]) / d)).toBeCloseTo(Math.PI * 0.495, 5)
    // a small city keeps the 420 floor
    r.draw(smallCity(), smallText(), false)
    await r.overview(true)
    for (let i = 0; i < 100; i++) wheel(r, 100)
    expect(distOf(r)).toBeCloseTo(420, 3)
    r.dispose()
  })

  it('a drag hands the camera to the hand: the turning stops and a flight under way ends where it is', async () => {
    const r = createThreeRenderer(h.host, DEFAULT_OPTS)
    readyCanvas(r)
    r.draw(smallCity(), smallText(), false)
    void r.flyTo({ pos: [50, 50, 50], target: [0, 0, 0] }, false)
    h.frames.run(3, 20)
    expect(r.motionState().flight.active).toBe(true)
    press(r, 'pointerdown')
    r.canvas.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, pointerType: 'mouse', clientX: 460, clientY: 320, bubbles: true }))
    press(r, 'pointerup')
    h.frames.step(20)
    expect(r.motionState().flight.active).toBe(false)
    // the drag's glide runs out, and the auto-turn is off: then the camera holds still frame to frame
    h.frames.run(400, 20)
    const still = r.getCamera()
    h.frames.run(5, 20)
    const after = r.getCamera()
    for (let i = 0; i < 3; i++) expect(after.pos[i]).toBeCloseTo(still.pos[i], 3)
    r.dispose()
  })

  it('a held pointer that stays put, or one that moves while no hand is on the controls, leaves a flight under way', () => {
    const r = createThreeRenderer(h.host, DEFAULT_OPTS)
    readyCanvas(r)
    r.draw(smallCity(), smallText(), false)
    void r.flyTo({ pos: [50, 50, 50], target: [0, 0, 0] }, false)
    h.frames.run(3, 20)
    // a move with no button down: OrbitControls has no hand on it
    r.canvas.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, pointerType: 'mouse', clientX: 460, clientY: 320, bubbles: true }))
    // a press whose pointer moves to where it already is (a plain click)
    press(r, 'pointerdown')
    r.canvas.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, pointerType: 'mouse', clientX: 400, clientY: 300, bubbles: true }))
    press(r, 'pointerup')
    h.frames.step(20)
    expect(r.motionState().flight.active).toBe(true)
    r.dispose()
  })

  it('a pointer move with no time since the controls last updated still hands the camera over and wakes the loop', () => {
    // timed damping applies none of such a move until the next update, after the hand let go here
    const r = createThreeRenderer(h.host, DEFAULT_OPTS)
    readyCanvas(r)
    r.draw(smallCity(), smallText(), false)
    void r.flyTo({ pos: [50, 50, 50], target: [0, 0, 0] }, false)
    h.frames.run(3, 20)
    const before = r.getCamera()
    press(r, 'pointerdown')
    r.canvas.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, pointerType: 'mouse', clientX: 460, clientY: 320, bubbles: true }))
    expect(r.getCamera()).toEqual(before) // nothing of the move applied yet
    expect(r.motionState().flight.active).toBe(false)
    press(r, 'pointerup')
    h.frames.step(20)
    expect(r.getCamera()).not.toEqual(before) // the next frame applies it
    r.dispose()
  })
})

describe('threeRenderer resize', () => {
  function withObserver(): { fire: () => void; observed: Element[]; disconnected: () => number } {
    let cb: () => void = () => {}
    const observed: Element[] = []
    let gone = 0
    class FakeResizeObserver {
      constructor(f: () => void) { cb = f }
      observe(el: Element): void { observed.push(el) }
      disconnect(): void { gone++ }
    }
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    return { fire: () => cb(), observed, disconnected: () => gone }
  }

  it('updates the renderer, the composer, the label layer and the camera aspect, and refits the city', async () => {
    const ro = withObserver()
    const r = createThreeRenderer(h.host, DEFAULT_OPTS)
    expect(ro.observed).toEqual([h.host])
    r.draw(smallCity(), smallText(), false)
    await r.overview(true)
    const before = r.getCamera()
    resizeHost(h.host, 1200, 400)
    ro.fire()
    expect(rendererOf().sizes[rendererOf().sizes.length - 1]).toEqual([1200, 400])
    expect(gpu.composers[0].sizes[gpu.composers[0].sizes.length - 1]).toEqual([1200, 400])
    const labels = h.host.querySelector('.lw-labels') as HTMLElement
    expect(labels.style.width).toBe('1200px')
    expect(labels.style.height).toBe('400px')
    expect(cameraOf().aspect).toBeCloseTo(3)
    // at the overview, the camera moves to the new shape's overview
    expect(r.getCamera()).not.toEqual(before)
    r.dispose()
    expect(ro.disconnected()).toBeGreaterThanOrEqual(1)
  })

  it("keeps the drawing buffer inside the GPU's largest one: a lower pixel ratio on a 4K view, the screen's back when it shrinks", () => {
    const ro = withObserver()
    vi.stubGlobal('devicePixelRatio', 2)
    gpu.limits = { renderbuffer: 4096, texture: 16384, viewport: [16384, 2048] } // the viewport's 2048 down is the tighter limit there
    resizeHost(h.host, 3840, 2160)
    const r = createThreeRenderer(h.host, DEFAULT_OPTS)
    // High's 4K budget gives a ratio of 1: 3840 fits 4096 across; 2160 is past 2048 down: 2048 / 2160.
    expect(rendererOf().pixelRatios).toEqual([2048 / 2160])
    resizeHost(h.host, 5120, 1440)
    ro.fire() // the budget's ratio (about 1.06) takes 5120 past 4096 across: 4096 / 5120
    expect(rendererOf().pixelRatios[rendererOf().pixelRatios.length - 1]).toBe(4096 / 5120)
    expect(gpu.composers[0].pixelRatios).toEqual([4096 / 5120])
    expect(rendererOf().sizes[rendererOf().sizes.length - 1]).toEqual([5120, 1440])
    resizeHost(h.host, 800, 600)
    ro.fire() // small again: the screen's full ratio
    expect(rendererOf().pixelRatios[rendererOf().pixelRatios.length - 1]).toBe(2)
    expect(gpu.composers[0].pixelRatios[gpu.composers[0].pixelRatios.length - 1]).toBe(2)
    r.dispose()
  })

  it("draws a 5K view at most a 1080p screen's pixels in software, and the screen's full ratio on a smaller view", () => {
    // At 5120 x 2880 in software one frame inside a district of thousands of parts took the GPU process past
    // Chromium's watchdog, which ended it (exit code 2, twice: the map then stays in 2D for good).
    const ro = withObserver()
    vi.stubGlobal('devicePixelRatio', 1)
    gpu.limits = { renderbuffer: 16384, texture: 16384, viewport: [16384, 16384] }
    gpu.gpuName = 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)'
    resizeHost(h.host, 5120, 2880)
    const r = createThreeRenderer(h.host, DEFAULT_OPTS)
    const last = (): number => rendererOf().pixelRatios[rendererOf().pixelRatios.length - 1]
    expect(last()).toBeCloseTo(0.375) // 5120 x 2880 x 0.375 x 0.375 = 1920 x 1080
    resizeHost(h.host, 1920, 1080)
    ro.fire() // a 1080p view fits: the screen's ratio
    expect(last()).toBe(1)
    resizeHost(h.host, 5120, 2880)
    ro.fire()
    expect(last()).toBeCloseTo(0.375)
    expect(gpu.composers[0].pixelRatios[gpu.composers[0].pixelRatios.length - 1]).toBeCloseTo(0.375)
    // Back on a GPU (a driver came back): High's 4K budget at 5K, 5120 x 2880 x 0.75 x 0.75 = 3840 x 2160.
    r.canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }))
    gpu.gpuName = 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)'
    r.canvas.dispatchEvent(new Event('webglcontextrestored'))
    expect(last()).toBe(0.75)
    r.dispose()
  })

  it("draws the low quality tier at a 1080p buffer at 4K in software (as on a GPU), and at 5K", () => {
    const ro = withObserver()
    vi.stubGlobal('devicePixelRatio', 1)
    gpu.limits = { renderbuffer: 16384, texture: 16384, viewport: [16384, 16384] }
    gpu.gpuName = 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)'
    resizeHost(h.host, 3840, 2160)
    const r = createThreeRenderer(h.host, { quality: 'low', reducedMotion: false })
    expect(rendererOf().pixelRatios[rendererOf().pixelRatios.length - 1]).toBe(0.5)
    resizeHost(h.host, 5120, 2880)
    ro.fire()
    expect(rendererOf().pixelRatios[rendererOf().pixelRatios.length - 1]).toBeCloseTo(0.375)
    r.dispose()
  })

  it('never takes the drawing buffer past the cap between its calls: a ratio coming down is set before the size, one going up after (M3)', () => {
    const ro = withObserver()
    vi.stubGlobal('devicePixelRatio', 2)
    gpu.limits = { renderbuffer: 8192, texture: 16384, viewport: [16384, 4096] }
    resizeHost(h.host, 3840, 2160)
    const r = createThreeRenderer(h.host, DEFAULT_OPTS)
    const over = (bufs: Array<[number, number]>): Array<[number, number]> => bufs.filter(([x, y]) => x > 8192 + 1e-6 || y > 4096 + 1e-6)
    const steps: Array<[number, number]> = [[5120, 1440], [800, 600], [7680, 4320], [800, 600], [7680, 4320], [7000, 4320], [1000, 700]]
    for (const [w, hh] of steps) {
      resizeHost(h.host, w, hh)
      ro.fire()
      expect(rendererOf().sizes[rendererOf().sizes.length - 1]).toEqual([w, hh])
      expect(gpu.composers[0].sizes[gpu.composers[0].sizes.length - 1]).toEqual([w, hh])
    }
    expect(over(rendererOf().buffers)).toEqual([])
    expect(over(gpu.composers[0].buffers)).toEqual([])
    // each ends at the full ratio the last size allows
    expect(rendererOf().getPixelRatio()).toBe(2)
    expect(gpu.composers[0].pixelRatios[gpu.composers[0].pixelRatios.length - 1]).toBe(2)
    r.dispose()
  })

  it("fits the buffer again when the screen's pixel ratio changes with no change of size, which no ResizeObserver reports", () => {
    const queries: Array<{ media: string; on: Array<() => void>; off: Array<() => void> }> = []
    vi.stubGlobal('matchMedia', (media: string) => {
      const q = { media, on: [] as Array<() => void>, off: [] as Array<() => void> }
      queries.push(q)
      return {
        media,
        matches: true,
        addEventListener: (_: string, f: () => void) => { q.on.push(f) },
        removeEventListener: (_: string, f: () => void) => { q.off.push(f) },
      }
    })
    vi.stubGlobal('devicePixelRatio', 1)
    gpu.limits = { renderbuffer: 4096, texture: 16384, viewport: [16384, 16384] }
    resizeHost(h.host, 3000, 1000)
    const r = createThreeRenderer(h.host, DEFAULT_OPTS)
    expect(queries.map((q) => q.media)).toEqual(['(resolution: 1dppx)'])
    expect(rendererOf().pixelRatios).toEqual([1])
    const sized = rendererOf().sizes.length
    h.frames.run(SETTLE_FRAMES + 5)
    vi.stubGlobal('devicePixelRatio', 2) // dragged onto a 2x display
    queries[0].on[0]()
    // 3000 x 2 is past the 4096 cap: 4096 / 3000, the size the same
    expect(rendererOf().getPixelRatio()).toBe(4096 / 3000)
    expect(gpu.composers[0].pixelRatios).toEqual([4096 / 3000])
    expect(rendererOf().sizes.slice(sized)).toEqual([[3000, 1000]])
    expect(h.frames.pending()).toBe(1) // drawn again
    // the old query is let go; one for the new ratio listens
    expect(queries[0].off).toEqual(queries[0].on)
    expect(queries.map((q) => q.media)).toEqual(['(resolution: 1dppx)', '(resolution: 2dppx)'])
    r.dispose()
    expect(queries[1].off).toEqual(queries[1].on)
  })

  it('a pixel ratio query that throws, or answers without listeners, leaves the buffer to the next resize', () => {
    vi.stubGlobal('matchMedia', () => { throw new Error('no media queries') })
    const r = createThreeRenderer(h.host, DEFAULT_OPTS)
    r.dispose()
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
    const r2 = createThreeRenderer(h.host, DEFAULT_OPTS)
    r2.dispose()
    expect(gpu.renderers).toHaveLength(2)
  })

  it('keeps the drawing buffer inside the largest texture too, where that is the tightest limit (N1)', () => {
    vi.stubGlobal('devicePixelRatio', 2)
    gpu.limits = { renderbuffer: 16384, texture: 2048, viewport: [16384, 16384] }
    resizeHost(h.host, 3840, 2160)
    const r = createThreeRenderer(h.host, DEFAULT_OPTS)
    // High's 4K budget gives a ratio of 1; 3840 is past the 2048 texture across: 2048 / 3840 (2160 down then fits).
    expect(rendererOf().pixelRatios).toEqual([2048 / 3840])
    r.dispose()
  })

  it("a context that answers no buffer limits (lost, or a driver that leaves them out) holds the screen's ratio", () => {
    vi.stubGlobal('devicePixelRatio', 2)
    gpu.limits = { renderbuffer: null, texture: null, viewport: null }
    resizeHost(h.host, 1920, 1080) // 3840 x 2160 at 2x: inside High's budget
    const r = createThreeRenderer(h.host, DEFAULT_OPTS)
    expect(rendererOf().pixelRatios).toEqual([2])
    r.dispose()
    gpu.limits = { renderbuffer: 0, texture: 0, viewport: [0, 0] } // zeros are no limits either
    const r2 = createThreeRenderer(h.host, DEFAULT_OPTS)
    expect(gpu.renderers[1].pixelRatios).toEqual([2])
    r2.dispose()
  })

  it('without a world only the view changes size; a zero-sized host counts as one pixel', () => {
    const ro = withObserver()
    const r = createThreeRenderer(h.host, { quality: 'flat', reducedMotion: false })
    resizeHost(h.host, 0, 0)
    ro.fire()
    expect(rendererOf().sizes[rendererOf().sizes.length - 1]).toEqual([1, 1])
    expect(gpu.composers).toHaveLength(0)
    r.dispose()
  })

  it('a renderer made without ResizeObserver (jsdom) still builds and disposes', () => {
    expect(typeof ResizeObserver).toBe('undefined')
    const r = createThreeRenderer(h.host, DEFAULT_OPTS)
    r.dispose()
  })
})

describe('threeRenderer cursor', () => {
  it('setCursor shows a pointer over something clickable, and the default elsewhere', () => {
    const r = createThreeRenderer(h.host, DEFAULT_OPTS)
    r.setCursor(true)
    expect(r.canvas.style.cursor).toBe('pointer')
    r.setCursor(false)
    expect(r.canvas.style.cursor).toBe('default')
    r.dispose()
  })
})
