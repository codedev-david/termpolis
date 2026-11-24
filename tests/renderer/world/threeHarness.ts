// The GPU boundary for threeRenderer's unit tests, and a frame stepper. Only what needs a real WebGL
// context is faked here: WebGLRenderer and the EffectComposer passes (they allocate GPU render
// targets). Everything else the renderer uses is real three.js: the scene graph, geometries,
// materials, InstancedMesh, Raycaster, CSS2DRenderer and OrbitControls.
//
// Each test file wires the fakes in with the same five vi.mock calls (see threeRenderer.scene.test.ts);
// vi.mock is hoisted per file, so it cannot live here. This module imports nothing from 'three' at run
// time: it is loaded from inside the mock factory of 'three' itself.
import { afterEach, beforeEach, vi } from 'vitest'
import type * as THREE from 'three'
import type { RendererOptions, SceneText, ThreeRenderer } from '../../../src/renderer/src/world/engine/threeRenderer'
import type { SceneBuilding, SceneConduit, SceneDistrict, SceneModel, SceneOrb, Vec3 } from '../../../src/renderer/src/world/engine/sceneModel'

/** Counts what a real renderer would issue a draw call for: every visible mesh, line, point cloud and sprite. */
export function drawables(scene: THREE.Object3D): number {
  let n = 0
  scene.traverseVisible((o) => {
    const d = o as unknown as { isMesh?: boolean; isLine?: boolean; isPoints?: boolean; isSprite?: boolean }
    if (d.isMesh || d.isLine || d.isPoints || d.isSprite) n++
  })
  return n
}

/** What the fakes saw, and the failures a test asks them to throw. */
export const gpu = {
  renderers: [] as FakeWebGLRenderer[],
  composers: [] as FakeEffectComposer[],
  renderPasses: [] as FakeRenderPass[],
  bloomPasses: [] as FakeUnrealBloomPass[],
  outputPasses: [] as FakeOutputPass[],
  /** Thrown by the next WebGLRenderer constructor (no WebGL). */
  failRenderer: null as Error | null,
  /** Thrown by the next EffectComposer constructor (a failure after the renderer is up). */
  failComposer: null as Error | null,
  /** Thrown by WebGLRenderer.dispose (an undo step that fails). */
  failDispose: null as Error | null,
  /** What the renderer's context answers for MAX_RENDERBUFFER_SIZE, MAX_TEXTURE_SIZE and MAX_VIEWPORT_DIMS (a lost context: null). */
  limits: { renderbuffer: 16384 as unknown, texture: 16384 as unknown, viewport: [16384, 16384] as unknown },
  /** The GPU's name the context answers (null: none), and whether it gives it through WEBGL_debug_renderer_info (the
   *  unmasked name) or only as RENDERER. */
  gpuName: null as unknown,
  debugInfo: true,
  /**
   * The context's WebGL 2 fences: whether it has them (off: WebGL 1, no fenceSync), how long after it is put in a fence
   * signals (performance.now ms; null: never), the fences put in, and the ones still not deleted.
   */
  fences: { on: false, signalAfter: 0 as number | null, made: [] as FakeSync[], live: new Set<FakeSync>() },
  reset(): void {
    gpu.renderers.length = 0
    gpu.composers.length = 0
    gpu.renderPasses.length = 0
    gpu.bloomPasses.length = 0
    gpu.outputPasses.length = 0
    gpu.failRenderer = gpu.failComposer = gpu.failDispose = null
    gpu.limits = { renderbuffer: 16384, texture: 16384, viewport: [16384, 16384] }
    gpu.gpuName = null
    gpu.debugInfo = true
    gpu.fences = { on: false, signalAfter: 0, made: [], live: new Set() }
  },
}

/** A fake WebGLSync: when it was put in (performance.now) and what with. */
export interface FakeSync { at: number; condition: number; flags: number }
const SYNC_STATUS = 0x9112
const SIGNALED = 0x9119
const UNSIGNALED = 0x9118
const SYNC_GPU_COMMANDS_COMPLETE = 0x9117
/** The fence calls of a context with fences (gpu.fences.on). */
const fenceCalls = (): Record<string, unknown> => ({
  SYNC_STATUS, SIGNALED, UNSIGNALED, SYNC_GPU_COMMANDS_COMPLETE,
  fenceSync: (condition: number, flags: number): FakeSync => {
    const f = { at: performance.now(), condition, flags }
    gpu.fences.made.push(f)
    gpu.fences.live.add(f)
    return f
  },
  getSyncParameter: (f: FakeSync, p: number): number | null => {
    if (p !== SYNC_STATUS) return null
    const after = gpu.fences.signalAfter
    return after !== null && performance.now() - f.at >= after ? SIGNALED : UNSIGNALED
  },
  deleteSync: (f: FakeSync): void => { gpu.fences.live.delete(f) },
})

export class FakeWebGLRenderer {
  readonly args: unknown[]
  readonly domElement: HTMLCanvasElement = document.createElement('canvas')
  readonly capabilities = { isWebGL2: true, maxTextures: 16, maxSamples: 4 }
  readonly info = {
    autoReset: true,
    render: { calls: 0, triangles: 0, points: 0, lines: 0, frame: 0 },
    memory: { geometries: 0, textures: 0 },
    reset: vi.fn((): void => { this.info.render.calls = 0 }),
  }
  toneMapping = 0
  toneMappingExposure = 1
  readonly sizes: Array<[number, number]> = []
  readonly pixelRatios: number[] = []
  /** The drawing buffer [across, down] after each setSize or setPixelRatio (each of which sizes it, as in three.js). */
  readonly buffers: Array<[number, number]> = []
  private ratio = 1
  private size: [number, number] = [300, 150]
  readonly clearColors: unknown[] = []
  readonly renders: Array<{ scene: THREE.Object3D; camera: THREE.Camera; calls: number }> = []
  transparentSort: ((a: unknown, b: unknown) => number) | null = null
  disposed = 0
  contextLost = 0
  constructor(...args: unknown[]) {
    if (gpu.failRenderer) { const e = gpu.failRenderer; gpu.failRenderer = null; throw e }
    this.args = args
    gpu.renderers.push(this)
  }
  setSize(w: number, h: number): void {
    this.sizes.push([w, h])
    this.size = [w, h]
    this.buffers.push([w * this.ratio, h * this.ratio])
    this.domElement.width = w
    this.domElement.height = h
    this.domElement.style.width = `${w}px`
    this.domElement.style.height = `${h}px`
  }
  setPixelRatio(r: number): void {
    this.pixelRatios.push(r)
    this.ratio = r
    this.buffers.push([this.size[0] * r, this.size[1] * r])
  }
  getPixelRatio(): number { return this.ratio }
  setClearColor(c: unknown): void { this.clearColors.push(c) }
  setTransparentSort(f: (a: unknown, b: unknown) => number): void { this.transparentSort = f }
  render(scene: THREE.Object3D, camera: THREE.Camera): void {
    const calls = drawables(scene)
    this.info.render.calls += calls
    this.renders.push({ scene, camera, calls })
  }
  dispose(): void {
    this.disposed++
    if (gpu.failDispose) throw gpu.failDispose
  }
  forceContextLoss(): void { this.contextLost++ }
  /** A context answering the buffer limits (gpu.limits), the GPU's name (gpu.gpuName) and, with gpu.fences.on, fences. */
  getContext(): { MAX_RENDERBUFFER_SIZE: number; MAX_TEXTURE_SIZE: number; MAX_VIEWPORT_DIMS: number; RENDERER: number; getParameter(p: number): unknown; getExtension(name: string): unknown } {
    // The unmasked name (0x9246) only through the extension; RENDERER (0x1f01) names it too when there is none.
    const answers: Record<number, unknown> = { 0x84e8: gpu.limits.renderbuffer, 0x0d33: gpu.limits.texture, 0x0d3a: gpu.limits.viewport, [gpu.debugInfo ? 0x9246 : 0x1f01]: gpu.gpuName }
    return {
      MAX_RENDERBUFFER_SIZE: 0x84e8, MAX_TEXTURE_SIZE: 0x0d33, MAX_VIEWPORT_DIMS: 0x0d3a, RENDERER: 0x1f01,
      getParameter: (p) => (p in answers ? answers[p] : null),
      getExtension: (name) => (name === 'WEBGL_debug_renderer_info' && gpu.debugInfo ? { UNMASKED_RENDERER_WEBGL: 0x9246 } : null),
      ...(gpu.fences.on ? fenceCalls() : {}),
    }
  }
}

interface Pass { dispose(): void }

export class FakeEffectComposer {
  readonly renderer: FakeWebGLRenderer
  readonly passes: Pass[] = []
  readonly sizes: Array<[number, number]> = []
  renders = 0
  disposed = 0
  constructor(renderer: FakeWebGLRenderer) {
    if (gpu.failComposer) { const e = gpu.failComposer; gpu.failComposer = null; throw e }
    this.renderer = renderer
    this.ratio = renderer.getPixelRatio()
    this.size = renderer.sizes.length ? renderer.sizes[renderer.sizes.length - 1] : [0, 0]
    gpu.composers.push(this)
  }
  readonly pixelRatios: number[] = []
  /** Its buffers [across, down] after each setSize or setPixelRatio; it starts at the renderer's size and ratio. */
  readonly buffers: Array<[number, number]> = []
  private ratio = 1
  private size: [number, number] = [0, 0]
  addPass(p: Pass): void { this.passes.push(p) }
  setSize(w: number, h: number): void {
    this.sizes.push([w, h])
    this.size = [w, h]
    this.buffers.push([w * this.ratio, h * this.ratio])
  }
  setPixelRatio(r: number): void {
    this.pixelRatios.push(r)
    this.ratio = r
    this.buffers.push([this.size[0] * r, this.size[1] * r])
  }
  /** As the real one: the render pass draws the scene (the bloom and output passes add full-screen quads). */
  render(): void {
    this.renders++
    for (const p of this.passes) if (p instanceof FakeRenderPass) this.renderer.render(p.scene, p.camera)
  }
  dispose(): void { this.disposed++ }
}

export class FakeRenderPass {
  enabled = true
  disposed = 0
  constructor(readonly scene: THREE.Object3D, readonly camera: THREE.Camera) { gpu.renderPasses.push(this) }
  dispose(): void { this.disposed++ }
}

export class FakeUnrealBloomPass {
  enabled = true
  disposed = 0
  constructor(readonly resolution: THREE.Vector2, public strength: number, public radius: number, public threshold: number) {
    gpu.bloomPasses.push(this)
  }
  dispose(): void { this.disposed++ }
}

export class FakeOutputPass {
  enabled = true
  disposed = 0
  constructor() { gpu.outputPasses.push(this) }
  dispose(): void { this.disposed++ }
}

/**
 * A manual frame loop: requestAnimationFrame queues, step() moves the clock (performance.now, which
 * THREE.Clock, the camera rig and the change animator all read) and runs the queued frames.
 */
export interface Frames {
  readonly now: number
  /** Moves the clock without running a frame. */
  advance(ms: number): void
  /** Moves the clock `ms` and runs the frames queued until now. */
  step(ms?: number): void
  /** `n` frames of `ms` each. */
  run(n: number, ms?: number): void
  pending(): number
}

export function installFrames(start = 1000): Frames {
  let now = start
  let id = 0
  const queue = new Map<number, FrameRequestCallback>()
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number => { queue.set(++id, cb); return id })
  vi.stubGlobal('cancelAnimationFrame', (i: number): void => { queue.delete(i) })
  const frames: Frames = {
    get now() { return now },
    advance(ms) { now += ms },
    // As a browser runs them: the callbacks queued before this frame, each only if it is still queued
    // (one cancelled by an earlier callback of the same frame never runs).
    step(ms = 16) {
      now += ms
      for (const i of [...queue.keys()]) {
        const cb = queue.get(i)
        if (!cb) continue
        queue.delete(i)
        cb(now)
      }
    },
    run(n, ms = 16) { for (let i = 0; i < n; i++) frames.step(ms) },
    pending: () => queue.size,
  }
  return frames
}

/** A host of the given size, its canvas reporting the same box (jsdom lays nothing out). */
export function makeHost(w = 800, h = 600): HTMLDivElement {
  const host = document.createElement('div')
  Object.defineProperty(host, 'clientWidth', { configurable: true, get: () => (host as unknown as { _w: number })._w })
  Object.defineProperty(host, 'clientHeight', { configurable: true, get: () => (host as unknown as { _h: number })._h })
  resizeHost(host, w, h)
  document.body.appendChild(host)
  return host
}

export function resizeHost(host: HTMLElement, w: number, h: number): void {
  const x = host as unknown as { _w: number; _h: number }
  x._w = w
  x._h = h
}

/** Gives the renderer's canvas a box: jsdom's is all zeros. */
export function boxCanvas(canvas: HTMLCanvasElement, w: number, h: number, left = 0, top = 0): void {
  canvas.getBoundingClientRect = () => ({ left, top, width: w, height: h, right: left + w, bottom: top + h, x: left, y: top, toJSON: () => ({}) }) as DOMRect
}

export const DEFAULT_OPTS: RendererOptions = { quality: 'high', reducedMotion: false }

export function emptyText(over: Partial<SceneText> = {}): SceneText {
  return { labels: {}, floors: {}, districts: {}, edges: {}, processes: {}, cargoShapes: {}, importance: {}, ...over }
}

export const district = (id: string, pos: Vec3, radius = 20, over: Partial<SceneDistrict> = {}): SceneDistrict =>
  ({ id, pos, radius, hue: 200, label: id.toUpperCase(), ...over })

export const bldg = (id: string, pos: Vec3, over: Partial<SceneBuilding> = {}): SceneBuilding =>
  ({ id, pos, floors: 3, height: 9, look: 'solid', ring: false, outline: false, heat: 0, ...over })

export const conduit = (id: string, from: Vec3, to: Vec3, over: Partial<SceneConduit> = {}): SceneConduit => ({
  id, from, to, ctrl: [(from[0] + to[0]) / 2, Math.max(from[1], to[1]) + 8, (from[2] + to[2]) / 2],
  dashed: false, width: 0.3, color: '#60a5fa', cargo: 'memory', ...over,
})

export const orb = (id: string, pos: Vec3, fog = false): SceneOrb => ({ id, pos, fog })

/**
 * A small city: district d1 holding buildings a (3 floors, ringed) and b (2 floors), district d2 holding
 * c, the external x, a solid line a->b and a dashed line b->x.
 */
export function smallCity(): SceneModel {
  return {
    districts: [district('d1', [0, 0, 0], 20, { hue: 200 }), district('d2', [60, 0, 0], 16, { hue: 40 })],
    buildings: [
      bldg('a', [-6, 0, 0], { floors: 3, height: 9, ring: true }),
      bldg('b', [6, 0, 4], { floors: 2, height: 6 }),
      bldg('c', [60, 0, 0], { floors: 1, height: 4 }),
    ],
    conduits: [
      conduit('e1', [-6, 9, 0], [6, 6, 4]),
      conduit('e2', [6, 6, 4], [30, 2.2, 40], { dashed: true }),
    ],
    orbs: [orb('x', [30, 0, 40])],
  }
}

export function smallText(over: Partial<SceneText> = {}): SceneText {
  return emptyText({
    labels: { a: 'Alpha', b: 'Beta', c: 'Gamma', x: 'External' },
    floors: { a: ['a0', 'a1', 'a2'], b: ['b0', 'b1'] },
    districts: { d1: 'first', d2: 'second' },
    edges: { e1: 'calls', e2: 'reads' },
    importance: { a: 1, b: 2, c: 0, x: 1 },
    ...over,
  })
}

/** The scene the renderer draws, found through the fakes (the render pass at high quality, the last render at low). */
export function sceneOf(): THREE.Scene {
  const pass = gpu.renderPasses[gpu.renderPasses.length - 1]
  if (pass) return pass.scene as THREE.Scene
  const r = gpu.renderers[gpu.renderers.length - 1]
  return r.renders[r.renders.length - 1].scene as THREE.Scene
}

export function rendererOf(): FakeWebGLRenderer { return gpu.renderers[gpu.renderers.length - 1] }

export type { ThreeRenderer }

// ---------------- scene lookups (duck-typed: this module loads no three.js at run time) ----------------
type Obj = THREE.Object3D & { isGroup?: boolean; isCSS2DObject?: boolean; isInstancedMesh?: boolean; element?: HTMLElement }

/** The `world` group: the first group the renderer adds to its scene (the change layer and batch layer come after). */
export const worldOf = (scene: THREE.Object3D): THREE.Group => scene.children.filter((c) => (c as Obj).isGroup)[0] as THREE.Group
export const batchLayerOf = (scene: THREE.Object3D): THREE.Group => scene.children.filter((c) => (c as Obj).isGroup)[2] as THREE.Group

export function withData(root: THREE.Object3D, key: string): THREE.Mesh[] {
  const out: THREE.Mesh[] = []
  root.traverse((o) => { if (o.userData[key] !== undefined) out.push(o as THREE.Mesh) })
  return out
}

/** The floor meshes of building `id`, bottom first. */
export const floorsOf = (root: THREE.Object3D, id: string): THREE.Mesh[] =>
  withData(root, 'nodeId').filter((m) => m.userData.nodeId === id && (m.geometry as THREE.BoxGeometry).parameters?.width === 5)

/** CSS2D label objects of `kind` (bldg, floor, district, edge, proc). */
export function labelsOf(root: THREE.Object3D, kind: string): Array<THREE.Object3D & { element: HTMLElement }> {
  const out: Array<THREE.Object3D & { element: HTMLElement }> = []
  root.traverse((o) => { const x = o as Obj; if (x.isCSS2DObject && x.element?.classList.contains('lw-' + kind)) out.push(x as THREE.Object3D & { element: HTMLElement }) })
  return out
}
export const labelTexts = (root: THREE.Object3D, kind: string): string[] => labelsOf(root, kind).map((o) => o.element.textContent ?? '')

/** The box batches (one InstancedMesh per fill look) and how many boxes they hold in all. */
export function boxBatches(scene: THREE.Object3D): THREE.InstancedMesh[] {
  return batchLayerOf(scene).children.filter((c) => (c as THREE.InstancedMesh).geometry?.attributes.lineColor !== undefined) as THREE.InstancedMesh[]
}
export const batchedBoxes = (scene: THREE.Object3D): number => boxBatches(scene).reduce((n, im) => n + im.count, 0)
export function packetBatches(scene: THREE.Object3D): THREE.InstancedMesh[] {
  return batchLayerOf(scene).children.filter((c) => (c as THREE.InstancedMesh).geometry?.attributes.lineColor === undefined) as THREE.InstancedMesh[]
}

/** Every material and geometry under `root`. */
export function resources(root: THREE.Object3D): { geos: Set<THREE.BufferGeometry>; mats: Set<THREE.Material> } {
  const geos = new Set<THREE.BufferGeometry>()
  const mats = new Set<THREE.Material>()
  root.traverse((o) => {
    const m = o as THREE.Mesh
    if (m.geometry) geos.add(m.geometry)
    if (m.material) for (const x of ([] as THREE.Material[]).concat(m.material)) mats.add(x)
  })
  return { geos, mats }
}

/** Puts the camera at `ratio` of the overview's distance (on the overview's line of sight) and runs a frame: 1 is the overview. */
export function atRatio(r: ThreeRenderer, frames: Frames, ratio: number): void {
  void r.overview(true)
  const { pos, target } = r.getCamera()
  const p: [number, number, number] = [0, 1, 2].map((i) => target[i] + (pos[i] - target[i]) * ratio) as [number, number, number]
  void r.flyTo({ pos: p, target }, true)
  frames.step()
}

/** The camera the renderer draws with (the render pass's at high quality, else the last render's). */
export function cameraOf(): THREE.PerspectiveCamera {
  const pass = gpu.renderPasses[gpu.renderPasses.length - 1]
  if (pass) return pass.camera as THREE.PerspectiveCamera
  const r = gpu.renderers[gpu.renderers.length - 1]
  return r.renders[r.renders.length - 1].camera as THREE.PerspectiveCamera
}

/** A 2D canvas context for the textures the renderer paints (jsdom has none): records the gradient stops and fills. */
export function fake2d(): { stops: Array<[number, string]>; fills: number[][] } {
  const seen = { stops: [] as Array<[number, string]>, fills: [] as number[][] }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => ({
    fillStyle: '',
    createRadialGradient: () => ({ addColorStop: (k: number, c: string) => { seen.stops.push([k, c]) } }),
    fillRect: (...a: number[]) => { seen.fills.push(a) },
  })) as unknown as HTMLCanvasElement['getContext'])
  return seen
}

/** Records every listener added to and removed from `target` (type and capture), to check they pair up. */
export function trackListeners(target: EventTarget): { added: string[]; removed: string[] } {
  const log = { added: [] as string[], removed: [] as string[] }
  const key = (type: string, o?: boolean | AddEventListenerOptions | EventListenerOptions): string =>
    `${type}:${typeof o === 'boolean' ? o : !!o?.capture}`
  const add = target.addEventListener.bind(target)
  const rem = target.removeEventListener.bind(target)
  vi.spyOn(target, 'addEventListener').mockImplementation((t, l, o) => { log.added.push(key(t, o)); add(t, l, o) })
  vi.spyOn(target, 'removeEventListener').mockImplementation((t, l, o) => { log.removed.push(key(t, o)); rem(t, l, o) })
  return log
}

/** The per-test setup every threeRenderer test file shares: fresh fakes, a frame stepper and an 800x600 host. */
export function withHarness(): { frames: Frames; host: HTMLDivElement } {
  const ctx = {} as { frames: Frames; host: HTMLDivElement }
  beforeEach(() => {
    gpu.reset()
    // jsdom has no 2D canvas (and says so on every call): the textures are painted blank, as there.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    ctx.frames = installFrames()
    ctx.host = makeHost(800, 600)
  })
  afterEach(() => {
    ctx.host.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })
  return ctx
}
