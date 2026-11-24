// threeRenderer: frames on demand, a lost WebGL context, and reduced motion switched while the view is open.
// An idle city draws no frame; every change wakes the loop, which draws while anything moves and a few frames more
// (SETTLE_FRAMES), then sleeps. The frame stepper drives performance.now, which THREE.Clock, the camera rig and the
// change animator read.
import { describe, expect, it, vi } from 'vitest'
import { createThreeRenderer, sameLayout, SETTLE_FRAMES, type ThreeRenderer } from '../../../src/renderer/src/world/engine/threeRenderer'
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
