// Lumopolis drawing layer: every Three.js call lives here. It draws a SceneModel (sceneModel.ts)
// plus the label strings the viewer hands it, and knows nothing about WorldDocs. Ported from the
// brainstorm prototype (world-relationships.html): bloom, fog, starfield and dust, CSS2D labels,
// OrbitControls plus WASD/QE, double-click explode, flow pulses, fat invisible picking tubes and
// focus dimming. Excluded from the coverage gate (WebGL cannot run under jsdom); e2e covers it.
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js'
import { createChangeAnimator } from './changeAnimation'
import { focusOpacity } from './interaction'
import { busyness, clamp, declutter, edgeLabelSize, fitDistance, fitView, fogDensity, rightInset, type LabelBox, type V3 } from './viewMath'
import type { SceneBuilding, SceneConduit, SceneDistrict, SceneModel, SceneOrb, Vec3 } from './sceneModel'
import type { Theme, ThemeName } from './themes'

/** Label strings and presentation lookups. The viewer derives these from the doc; the renderer only prints them. */
export interface SceneText {
  /** Building and orb captions, already chosen by the viewer (job name or technology, plus any tag). */
  labels: Record<string, string>
  /** Floor captions per building, bottom floor first. */
  floors: Record<string, string[]>
  /** District subtitles. The district name comes from the scene model. */
  districts: Record<string, string>
  /** Edge captions. */
  edges: Record<string, string>
  /** Process shells: caption and colour per process id. */
  processes: Record<string, { label: string; color: string }>
  /** Packet shape per cargo id. */
  cargoShapes: Record<string, 'cube' | 'sphere' | 'octa' | 'tetra'>
}

export type RenderPick = { kind: 'node'; id: string } | { kind: 'edge'; id: string }
/**
 * What to light. `hover`: the focus of a hovered building (it shows fewer line labels). `passive`:
 * lines whose labels let a click through to the building under them (a busy building's hover labels
 * gather over it); the others stay clickable.
 */
export interface RenderFocus { ids: Set<string>; edgeIds: Set<string>; hover?: boolean; passive?: Set<string> }

export interface RendererOptions {
  quality: 'high' | 'low'
  reducedMotion: boolean
  /** An edge's floating label was clicked. */
  onEdgeLabel?: (edgeId: string) => void
  /**
   * Pixels on the right of the view that a panel covers (the legend): the overview and close-ups
   * frame the city in the rest, and the picture's centre moves to the middle of the rest.
   */
  rightReserve?: number
}

export interface ThreeRenderer {
  readonly canvas: HTMLCanvasElement
  draw(model: SceneModel, text: SceneText, allEdgeLabels: boolean): void
  setTheme(name: ThemeName, theme: Theme): void
  setFocus(focus: RenderFocus | null): void
  setSelected(id: string | null): void
  setExploded(id: string | null): void
  /**
   * Flies to frame the given node and edge ids. Resolves when the flight lands. With `around`, a
   * single building is framed with those parts (its neighbours) in view as well.
   */
  frame(ids: string[], instant: boolean, around?: string[]): Promise<void>
  overview(instant: boolean): Promise<void>
  /** Runs a bright pulse along each edge in turn. Resolves when the last one arrives. */
  pulse(edgeIds: string[], instant: boolean): Promise<void>
  stopPulses(): void
  pick(clientX: number, clientY: number): RenderPick | null
  setCursor(pointer: boolean): void
  /** The building or external under the pointer (null: none). Its name shows at any distance. */
  setHovered(id: string | null): void
  /** Node and edge ids whose anchor is inside the camera frustum. */
  visibleIds(): string[]
  /**
   * A point on screen, in client pixels, where a click picks the node: its top floor's centre (an
   * orb's centre) when nothing stands in front of it, else the first of its other floors' centres
   * and roof corners that pick() gives to this node. Null when it is not drawn, or no such point is
   * in view (hidden behind other buildings or a conduit's pick tube).
   */
  screenPoint(id: string): { x: number; y: number } | null
  /** How many process shells and conduits the last draw put up, and how many changes are still animating. */
  drawnCounts(): { processShells: number; conduits: number; changing: number }
  /** Takes these buildings out of the current scene to fade out (call before draw() clears it). */
  keepGhosts(ids: string[]): void
  /** After a draw: these buildings rise from the ground, these flash their glow. */
  animateChanges(c: { rise: string[]; pulse: string[] }): void
  /** Ends every rise, pulse and fade at once and frees the faded parts. */
  stopChanges(): void
  /**
   * Stops (true) or restarts (false) the render loop. Something covering the whole view (the World
   * home, the loading screen) pauses it, so a hidden scene costs no frames. While paused nothing
   * moves: a camera flight or a pulse waits and goes on after the restart.
   */
  setPaused(paused: boolean): void
  dispose(): void
}

// Rendering constants per theme that the plain theme data does not carry (prototype values).
interface Extras {
  fill: number; fillOpacity: number; fillGlow: number; platformOpacity: number; ghost: number
  seal: number; amber: number; grid: number; gridOpacity: number; bloom: number; fogTint: number
}
const EXTRAS: Record<ThemeName, Extras> = {
  neon: { fill: 0x0b1220, fillOpacity: 0.88, fillGlow: 0.16, platformOpacity: 0.92, ghost: 0x93c5fd, seal: 0x4ade80, amber: 0xfbbf24, grid: 0x1e3a5f, gridOpacity: 0.35, bloom: 1.05, fogTint: 0xcbd5e1 },
  blueprint: { fill: 0x0b2a4a, fillOpacity: 0.22, fillGlow: 0.06, platformOpacity: 0.45, ghost: 0xbfdbfe, seal: 0x99f6e4, amber: 0xfde68a, grid: 0x60a5fa, gridOpacity: 0.35, bloom: 0.75, fogTint: 0xe0f2fe },
  glass: { fill: 0xcbd5e1, fillOpacity: 0.32, fillGlow: 0.28, platformOpacity: 0.8, ghost: 0xbfdbfe, seal: 0x6ee7b7, amber: 0xfcd34d, grid: 0x374151, gridOpacity: 0.4, bloom: 0.5, fogTint: 0xf1f5f9 },
}

const STYLE_ID = 'lumopolis-world-style'
const CSS = `
.lw-labels{position:absolute;top:0;left:0;pointer-events:none}
.lw-district{font:700 15px system-ui,sans-serif;letter-spacing:2px;text-transform:uppercase;text-shadow:0 0 12px currentColor;white-space:nowrap;text-align:center}
.lw-district span{display:block;font-size:11px;letter-spacing:1px;font-weight:500;opacity:.75;text-shadow:none}
.lw-bldg{font:12px system-ui,sans-serif;color:#e2e8f0;padding:2px 8px;border-radius:6px;background:rgba(3,7,18,.65);border:1px solid rgba(148,163,184,.25);white-space:nowrap}
.lw-floor{font:11px system-ui,sans-serif;color:#e2e8f0;padding:1px 6px;border-radius:4px;background:rgba(3,7,18,.82);border-left:2px solid #38bdf8;white-space:nowrap;opacity:0}
.lw-edge{font:11px system-ui,sans-serif;padding:2px 7px;border-radius:99px;background:rgba(3,7,18,.85);border:1px solid;white-space:nowrap;pointer-events:auto;cursor:pointer}
.lw-edge:hover{background:rgba(30,41,59,.95)}
.lw-proc{font:10.5px system-ui,sans-serif;padding:1px 7px;border-radius:4px;background:rgba(3,7,18,.8);border:1px dashed;white-space:nowrap}
`

const FLOOR_W = 5
const ORB_R = 2.2
/** How far behind an edge pick tube (radius 0.8) a node hit may lie and still win the pick. */
const PICK_NODE_EPS = 1
/**
 * In front of a building, a line takes the click only where the ray passes within LINE_REACH times
 * its drawn radius of it (at least MIN_LINE_REACH world units): its fat pick tube is there to make a
 * thin line clickable over open ground, not to cover the building behind it.
 */
const LINE_REACH = 2
const MIN_LINE_REACH = 0.5
const OVERVIEW_DIR = new THREE.Vector3(0.24, 0.72, 1).normalize()
/**
 * How far the camera stands from the city at the overview of a prototype-sized world (about ten
 * buildings). A bigger world puts the camera further out; the line widths, packet sizes and zoom
 * limit scale from this so a big repository reads like the prototype.
 */
const PROTO_OVERVIEW = 120
/** Room round the city at the overview: the whole city fills the picture with a tenth to spare. */
const OVERVIEW_MARGIN = 1.1
/** Half the width of a district's name on screen ("6 PARTS · 14 FILES"), kept in the overview. */
const DISTRICT_NAME_HALF_PX = 64
/** Room round a clicked building and its neighbours. */
const CLOSE_UP_MARGIN = 1.2
/** The closest a click flies to a building: the prototype's framing distance (28 out, half that up). */
const CLOSE_UP_MIN = 28 * Math.hypot(1, 0.5)
/**
 * Line and packet sizes grow with the world (scale) up to this, so a big city's lines stay lines:
 * past it, dozens of fat tubes meeting at one building bloom into a white or pink glare.
 */
const MAX_LINE_SCALE = 1.5
/** The faintest a line gets in a very busy city, and the least of the theme's glow it keeps. */
const MIN_TUBE_OPACITY = 0.07
const MIN_BLOOM = 0.5
/** The most line labels a hovered building shows at once, and a selection; none overlaps another. */
const HOVER_EDGE_LABELS = 6
const FOCUS_EDGE_LABELS = 10

type LabelKind = 'district' | 'bldg' | 'floor' | 'proc'
/** dim: the focus dimming (1 or 0.2); lit: its part is hovered or selected, so the label shows at any distance. */
interface LabelRec { o: CSS2DObject; kind: LabelKind; dim: number; lit: boolean }
interface NodeRec {
  id: string; group: THREE.Group; floors: THREE.Group[]; floorLabels: (LabelRec | null)[]
  mats: THREE.Material[]; labels: LabelRec[]; height: number; anchor: THREE.Vector3; orb: boolean
  exploded: boolean
  flow?: { line: THREE.Line; y0: number; y1: number; dots: THREE.Mesh[] }
}
interface Packet { s: THREE.Mesh; t: number; sp: number }
interface EdgeRec {
  id: string; curve: THREE.QuadraticBezierCurve3; tubeMats: THREE.Material[]; packetMats: THREE.Material[]
  packets: Packet[]; pick: THREE.Mesh; label: CSS2DObject; focus: boolean
  /** The label's length in characters, for its size on screen (declutter). */
  chars: number
  /** Points along the drawn line, and how near a ray must pass to touch it (pick). */
  path: THREE.Vector3[]; reach: number
}

const hex = (c: number | string): string => '#' + new THREE.Color(c).getHexString()
const posKey = (p: Vec3): string => `${p[0]},${p[1]},${p[2]}`
const vec = (p: Vec3): THREE.Vector3 => new THREE.Vector3(p[0], p[1], p[2])

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return
  const el = document.createElement('style')
  el.id = STYLE_ID
  el.textContent = CSS
  document.head.appendChild(el)
}

function trackBase<M extends THREE.Material>(m: M): M {
  m.userData.base = m.opacity
  m.userData.f = 1
  return m
}

/**
 * Builds the renderer into `host`. If any step throws after the canvas is in the page, everything
 * made so far (WebGL context, canvas, label layer, host listeners, resize observer) is freed and
 * removed before the error is rethrown, so the caller can fall back to the 2D list on a clean host.
 */
export function createThreeRenderer(host: HTMLElement, opts: RendererOptions): ThreeRenderer {
  const undo: Array<() => void> = []
  try {
    return buildThreeRenderer(host, opts, undo)
  } catch (err) {
    for (const f of undo.reverse()) {
      try { f() } catch { /* keep freeing the rest */ }
    }
    throw err
  }
}

function buildThreeRenderer(host: HTMLElement, opts: RendererOptions, undo: Array<() => void>): ThreeRenderer {
  ensureStyle()
  const high = opts.quality === 'high'
  const reduced = opts.reducedMotion
  const size = (): [number, number] => [Math.max(1, host.clientWidth), Math.max(1, host.clientHeight)]
  let [width, height] = size()

  const renderer = new THREE.WebGLRenderer({ antialias: high })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2) * (high ? 1 : 0.5))
  renderer.setSize(width, height)
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.domElement.style.display = 'block'
  undo.push(() => { renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove() })
  host.appendChild(renderer.domElement)
  const labelRenderer = new CSS2DRenderer()
  labelRenderer.setSize(width, height)
  labelRenderer.domElement.className = 'lw-labels'
  undo.push(() => { labelRenderer.domElement.remove() })
  host.appendChild(labelRenderer.domElement)

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(55, width / height, 0.1, 3000)
  /** The strip on the right the legend covers (rightInset), out of the fit and the picture's centre. */
  let inset = 0
  /**
   * The camera sees a picture `inset` wider than the view, whose left `inset` pixels are cut off:
   * the centre of what shows moves to the middle of the part the legend leaves free.
   */
  function applyView(): void {
    inset = rightInset(width, opts.rightReserve ?? 0)
    camera.aspect = (width + inset) / height
    if (inset > 0) camera.setViewOffset(width + inset, height, inset, 0, width, height)
    else camera.clearViewOffset()
    camera.updateProjectionMatrix()
  }
  /** The width-to-height of the part of the view the legend leaves free: what a fit fills. */
  const fitAspect = (): number => (width - inset) / height
  applyView()
  const overviewPos = new THREE.Vector3(40, 120, 165)
  const overviewTarget = new THREE.Vector3(10, 0, 4)
  camera.position.copy(overviewPos)
  const controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true
  controls.target.copy(overviewTarget)
  controls.maxPolarAngle = Math.PI * 0.495
  controls.minDistance = 6
  controls.maxDistance = 420
  controls.autoRotate = !reduced
  controls.autoRotateSpeed = 0.3
  const onControlStart = (): void => { controls.autoRotate = false; atOverview = false; endTween() }
  controls.addEventListener('start', onControlStart)

  let composer: EffectComposer | null = null
  let renderPass: RenderPass | null = null
  let bloom: UnrealBloomPass | null = null
  let outputPass: OutputPass | null = null
  if (high) {
    composer = new EffectComposer(renderer)
    renderPass = new RenderPass(scene, camera)
    composer.addPass(renderPass)
    bloom = new UnrealBloomPass(new THREE.Vector2(width, height), 1.0, 0.55, 0.12)
    composer.addPass(bloom)
    outputPass = new OutputPass()
    composer.addPass(outputPass)
  }
  scene.add(new THREE.AmbientLight(0xffffff, 0.35))
  const sun = new THREE.DirectionalLight(0xffffff, 0.8)
  sun.position.set(40, 80, 30)
  scene.add(sun)

  // Starfield: a far shell of points, outside the fog.
  const starGeo = new THREE.BufferGeometry()
  {
    const n = 3500
    const p = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) {
      const r = 500 + Math.random() * 900
      const th = Math.random() * Math.PI * 2
      const ph = Math.acos(Math.random() * 2 - 1)
      p[i * 3] = r * Math.sin(ph) * Math.cos(th)
      p[i * 3 + 1] = Math.abs(r * Math.cos(ph)) * 0.8 + 20
      p[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th)
    }
    starGeo.setAttribute('position', new THREE.BufferAttribute(p, 3))
  }
  // A soft round dot: without a map a point is drawn as a square. Stars keep the prototype size
  // (1.6), so they read as pinpricks behind the city rather than bloomed blobs.
  const dotTex = (() => {
    const c = document.createElement('canvas')
    c.width = c.height = 64
    const x = c.getContext('2d')
    if (x) {
      const g = x.createRadialGradient(32, 32, 0, 32, 32, 32)
      g.addColorStop(0, 'rgba(255,255,255,1)')
      g.addColorStop(0.35, 'rgba(255,255,255,.75)')
      g.addColorStop(1, 'rgba(255,255,255,0)')
      x.fillStyle = g
      x.fillRect(0, 0, 64, 64)
    }
    return new THREE.CanvasTexture(c)
  })()
  const starMat = new THREE.PointsMaterial({
    color: 0xcbd5e1, size: 1.6, sizeAttenuation: true, fog: false, map: dotTex, transparent: true, alphaTest: 0.02, depthWrite: false,
  })
  scene.add(new THREE.Points(starGeo, starMat))

  // Dust drifting upward through the city (high quality only).
  let dustGeo: THREE.BufferGeometry | null = null
  let dustMat: THREE.PointsMaterial | null = null
  if (high) {
    const n = 600
    const p = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) {
      p[i * 3] = (Math.random() - 0.5) * 200
      p[i * 3 + 1] = Math.random() * 60 - 2
      p[i * 3 + 2] = (Math.random() - 0.5) * 200
    }
    dustGeo = new THREE.BufferGeometry()
    dustGeo.setAttribute('position', new THREE.BufferAttribute(p, 3))
    dustMat = new THREE.PointsMaterial({ color: 0x7dd3fc, size: 0.6, map: dotTex, transparent: true, opacity: 0.5, alphaTest: 0.02, depthWrite: false })
    scene.add(new THREE.Points(dustGeo, dustMat))
  }

  const fogTex = (() => {
    const c = document.createElement('canvas')
    c.width = c.height = 128
    const x = c.getContext('2d')
    if (x) {
      const g = x.createRadialGradient(64, 64, 0, 64, 64, 64)
      g.addColorStop(0, 'rgba(255,255,255,.9)')
      g.addColorStop(0.5, 'rgba(255,255,255,.25)')
      g.addColorStop(1, 'rgba(255,255,255,0)')
      x.fillStyle = g
      x.fillRect(0, 0, 128, 128)
    }
    return new THREE.CanvasTexture(c)
  })()
  const GEO = {
    cube: new THREE.BoxGeometry(0.9, 0.9, 0.9),
    octa: new THREE.OctahedronGeometry(0.7),
    tetra: new THREE.TetrahedronGeometry(0.8),
    sphere: new THREE.SphereGeometry(0.6, 12, 8),
  }
  const shared = new Set<THREE.BufferGeometry>(Object.values(GEO))

  // ---------------- state ----------------
  const world = new THREE.Group()
  scene.add(world)
  // Removed buildings fade out here, outside `world`, so clearWorld() never frees them mid-fade.
  const changeLayer = new THREE.Group()
  scene.add(changeLayer)
  const changes = createChangeAnimator(changeLayer, shared)
  let themeName: ThemeName = 'neon'
  let theme: Theme = { background: '#03050a', district: '#0a0f1c', conduit: '#60a5fa', glow: '#22d3ee', text: '#e2e8f0', fogDensity: 0.006 }
  let extras = EXTRAS.neon
  scene.background = new THREE.Color(theme.background)
  const fog = new THREE.FogExp2(theme.background, theme.fogDensity)
  scene.fog = fog
  let fogTarget = theme.fogDensity
  let grid: THREE.GridHelper | null = null
  /** Camera distance at the overview of the drawn world, and the world's scale against the prototype. */
  let overviewDist = PROTO_OVERVIEW
  let scale = 1

  let nodes = new Map<string, NodeRec>()
  /** The labels of the hovered building or external. */
  let hoverLabels: LabelRec[] = []
  let edges = new Map<string, EdgeRec>()
  let pickables: THREE.Object3D[] = []
  let labels: LabelRec[] = []
  let ghostMats: THREE.Material[] = []
  let seals: THREE.Mesh[] = []
  let fogSprites: THREE.Sprite[] = []
  let pulseBalls: THREE.Mesh[] = []
  let selRing: THREE.Mesh | null = null
  let lastModel: SceneModel | null = null
  let lastText: SceneText | null = null
  let allLabels = false
  let focus: RenderFocus | null = null
  let selectedId: string | null = null
  let explodedId: string | null = null
  let shellCount = 0
  /** The fog density: the theme's, thinned for a big world (FOG_REACH), thicker while a building is open. */
  const fogFor = (): number => fogDensity(theme.fogDensity, overviewDist, explodedId !== null)
  /** The resting opacity of a line, lower in a busy city (more than BUSY_LINES lines). */
  let tubeOpacity = 0.38
  /** busyness() of the drawn city: 1 for a small one, lower as its lines grow past BUSY_LINES. */
  let busy = 1

  function addLabel(parent: THREE.Object3D, kind: LabelKind, pos: [number, number, number], build: (el: HTMLDivElement) => void): LabelRec {
    const el = document.createElement('div')
    el.className = 'lw-' + kind
    build(el)
    const o = new CSS2DObject(el)
    o.position.set(pos[0], pos[1], pos[2])
    parent.add(o)
    const rec: LabelRec = { o, kind, dim: 1, lit: false }
    labels.push(rec)
    return rec
  }

  function clearWorld(): void {
    world.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (mesh.geometry && !shared.has(mesh.geometry)) mesh.geometry.dispose()
      if (mesh.material) ([] as THREE.Material[]).concat(mesh.material).forEach((m) => m.dispose())
      if (o instanceof CSS2DObject) o.element.remove()
    })
    world.clear()
    hoverLabels = []
    nodes = new Map(); edges = new Map(); pickables = []; labels = []; ghostMats = []; seals = []; fogSprites = []; pulseBalls = []
    shellCount = 0
    selRing = null
  }

  /** A building takes the hue of the district platform it stands on (nearest district containing it). */
  function hueAt(model: SceneModel, p: Vec3): number | null {
    let best: SceneDistrict | null = null
    let bestD = Infinity
    for (const d of model.districts) {
      const dist = Math.hypot(p[0] - d.pos[0], p[2] - d.pos[2])
      if (dist <= d.radius && dist < bestD) { best = d; bestD = dist }
    }
    return best ? best.hue : null
  }
  const hueColor = (hue: number | null): THREE.Color =>
    hue === null ? new THREE.Color(theme.glow) : new THREE.Color().setHSL(hue / 360, 0.75, 0.62)

  function buildDistrict(d: SceneDistrict, text: SceneText): void {
    const g = new THREE.Group()
    g.position.set(d.pos[0], d.pos[1], d.pos[2])
    world.add(g)
    const col = hueColor(d.hue)
    const pg = new THREE.CylinderGeometry(d.radius, d.radius * 1.05, 1.2, 6)
    const plat = new THREE.Mesh(pg, new THREE.MeshStandardMaterial({
      color: new THREE.Color(theme.district), metalness: 0.7, roughness: 0.35, transparent: true, opacity: extras.platformOpacity,
    }))
    plat.position.y = -0.6
    g.add(plat)
    const rim = new THREE.LineSegments(new THREE.EdgesGeometry(pg), new THREE.LineBasicMaterial({ color: col }))
    rim.position.y = -0.6
    g.add(rim)
    // Light pooling: the district's lamp, as in the prototype, reaching the whole of a big platform.
    const light = new THREE.PointLight(col, 40, Math.max(40, d.radius * 2.4))
    light.position.set(0, 8, 0)
    g.add(light)
    addLabel(g, 'district', [0, 0.4, d.radius + 2], (el) => {
      el.style.color = hex(col.getHex())
      el.textContent = d.label
      const sub = document.createElement('span')
      sub.textContent = text.districts[d.id] ?? ''
      el.appendChild(sub)
    })
  }

  /**
   * A drifting haze round a part we are guessing about. An unknown external gets the prototype's
   * thick cloud; a building whose claims are mostly inferred gets a light veil that keeps it legible
   * (several thick clouds side by side bloom into a white wall).
   */
  function fogCloud(n: NodeRec, h: number, thick: boolean): void {
    const count = thick ? 6 : 3
    const color = new THREE.Color(extras.fogTint).multiplyScalar(thick ? 0.8 : 0.6)
    for (let i = 0; i < count; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: fogTex, color, transparent: true, opacity: thick ? 0.2 : 0.1, depthWrite: false }))
      const a = (i / count) * Math.PI * 2
      const r = thick ? 4 : 5
      s.position.set(Math.cos(a) * r, h * 0.5 + Math.random() * 3, Math.sin(a) * r)
      s.scale.setScalar((thick ? 7 : 5) + Math.random() * (thick ? 4 : 2))
      s.userData = { a, r, y: s.position.y, sp: 0.1 + Math.random() * 0.15 }
      n.group.add(s)
      fogSprites.push(s)
    }
  }

  function processShell(n: NodeRec, procId: string, text: SceneText, orb: boolean): void {
    const pc = text.processes[procId]
    const color = pc ? pc.color : theme.text
    const shellR = orb ? 3.6 : Math.max(4.4, n.height * 0.62)
    const geo = orb ? new THREE.SphereGeometry(shellR, 24, 14) : new THREE.SphereGeometry(shellR, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2)
    const shell = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, wireframe: true, transparent: true, opacity: 0.22 }))
    if (orb) shell.position.y = ORB_R
    n.group.add(shell)
    shellCount++
    addLabel(n.group, 'proc', [0, (orb ? ORB_R + shellR : shellR) + 0.6, 0], (el) => {
      el.textContent = '⬡ ' + (pc ? pc.label : procId)
      el.style.color = color
      el.style.borderColor = color
    })
  }

  function buildBuilding(b: SceneBuilding, col: THREE.Color, text: SceneText): void {
    const g = new THREE.Group()
    g.position.set(b.pos[0], b.pos[1], b.pos[2])
    world.add(g)
    const fh = b.height / b.floors
    const n: NodeRec = {
      id: b.id, group: g, floors: [], floorLabels: [], mats: [], labels: [], height: b.height,
      anchor: new THREE.Vector3(b.pos[0], b.pos[1] + b.height, b.pos[2]), orb: false, exploded: false,
    }
    const ghost = b.look === 'wire'
    // A guessed-at building keeps its district's hue, washed toward the fog tint: still a building
    // of that district, only less certain.
    const lineColor = b.look === 'amber' ? extras.amber : ghost ? extras.ghost : b.look === 'fog' ? col.clone().lerp(new THREE.Color(extras.fogTint), 0.4) : col
    const captions = text.floors[b.id] ?? []
    for (let k = 0; k < b.floors; k++) {
      const geo = new THREE.BoxGeometry(FLOOR_W, fh * 0.85, FLOOR_W)
      const mat = trackBase(new THREE.MeshStandardMaterial({
        color: extras.fill, emissive: col, emissiveIntensity: ghost ? 0.05 : extras.fillGlow, metalness: 0.5, roughness: 0.3,
        transparent: true, opacity: ghost ? 0.07 : b.look === 'fog' ? extras.fillOpacity * 0.6 : extras.fillOpacity, depthWrite: !ghost,
      }))
      n.mats.push(mat)
      const mesh = new THREE.Mesh(geo, mat)
      mesh.userData.nodeId = b.id
      pickables.push(mesh)
      const fl = new THREE.Group()
      fl.add(mesh)
      const em = trackBase(new THREE.LineBasicMaterial({ color: lineColor, transparent: true, opacity: ghost ? 0.6 : 1 }))
      n.mats.push(em)
      if (ghost) ghostMats.push(em)
      fl.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo), em))
      const baseY = fh * k + fh / 2
      fl.position.y = baseY
      fl.userData = { baseY, explodedY: fh * k * 2.4 + fh / 2 + 0.8 }
      const caption = captions[k]
      n.floorLabels.push(caption === undefined ? null : addLabel(fl, 'floor', [FLOOR_W * 0.5 + 0.4, 0, FLOOR_W * 0.5 + 0.4], (el) => {
        el.textContent = caption
        el.style.borderLeftColor = hex(col.getHex())
      }))
      g.add(fl)
      n.floors.push(fl)
    }
    if (b.floors > 1) { // flow column shown when the building is opened: work moving up through its floors
      const top = fh * (b.floors - 1) * 2.4 + fh / 2 + 0.8
      const x = -FLOOR_W * 0.5 - 0.7
      const z = FLOOR_W * 0.5 + 0.7
      const cm = trackBase(new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0.7 }))
      n.mats.push(cm)
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(x, fh / 2 + 0.8, z), new THREE.Vector3(x, top, z)]), cm)
      line.visible = false
      g.add(line)
      n.flow = { line, y0: fh / 2 + 0.8, y1: top, dots: [] }
      for (let i = 0; i < 4; i++) {
        const d = new THREE.Mesh(GEO.sphere, new THREE.MeshBasicMaterial({ color: col }))
        d.scale.setScalar(0.45)
        d.position.set(x, 0, z)
        d.visible = false
        d.userData.t = i / 4
        g.add(d)
        n.flow.dots.push(d)
      }
    }
    if (b.ring) {
      const ringMat = trackBase(new THREE.MeshBasicMaterial({ color: extras.seal, transparent: true }))
      n.mats.push(ringMat)
      const ring = new THREE.Mesh(new THREE.TorusGeometry(1.1, 0.1, 8, 40), ringMat)
      ring.rotation.x = Math.PI / 2
      ring.position.y = b.height + 1.4
      g.add(ring)
      seals.push(ring)
    }
    if (b.look === 'fog') fogCloud(n, b.height, false)
    if (b.processShell !== undefined) processShell(n, b.processShell, text, false)
    const label = addLabel(g, 'bldg', [0, b.height + 3, 0], (el) => { el.textContent = text.labels[b.id] ?? b.id })
    n.labels.push(label)
    nodes.set(b.id, n)
  }

  function buildOrb(o: SceneOrb, text: SceneText): void {
    const g = new THREE.Group()
    g.position.set(o.pos[0], o.pos[1], o.pos[2])
    world.add(g)
    const col = new THREE.Color(o.fog ? extras.fogTint : theme.glow)
    const n: NodeRec = {
      id: o.id, group: g, floors: [], floorLabels: [], mats: [], labels: [], height: ORB_R * 2,
      anchor: new THREE.Vector3(o.pos[0], o.pos[1] + ORB_R * 2, o.pos[2]), orb: true, exploded: false,
    }
    const mat = trackBase(new THREE.MeshStandardMaterial({
      color: col.clone().multiplyScalar(0.35), emissive: col, emissiveIntensity: 0.12, metalness: 0.5, roughness: 0.3, transparent: true, opacity: 0.75,
    }))
    n.mats.push(mat)
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(ORB_R, 32, 16), mat)
    mesh.position.y = ORB_R
    mesh.userData.nodeId = o.id
    pickables.push(mesh)
    g.add(mesh)
    if (o.fog) fogCloud(n, ORB_R * 2, true)
    n.labels.push(addLabel(g, 'bldg', [0, ORB_R * 2 + 3, 0], (el) => { el.textContent = text.labels[o.id] ?? o.id }))
    nodes.set(o.id, n)
  }

  function buildConduit(c: SceneConduit, heightAt: Map<string, number>, text: SceneText): void {
    const hf = heightAt.get(posKey(c.from)) ?? 0
    const ht = heightAt.get(posKey(c.to)) ?? 0
    const a = vec(c.from).setY(c.from[1] + hf)
    const b = vec(c.to).setY(c.to[1] + ht)
    const ctrl = vec(c.ctrl).setY(c.ctrl[1] + (hf + ht) / 2)
    const curve = new THREE.QuadraticBezierCurve3(a, ctrl, b)
    const col = new THREE.Color(c.color)
    const rec: EdgeRec = { id: c.id, curve, tubeMats: [], packetMats: [], packets: [], pick: null as unknown as THREE.Mesh, label: null as unknown as CSS2DObject, focus: false, chars: 0, path: curve.getPoints(48), reach: 0 }
    if (!c.dashed) {
      const m = trackBase(new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: tubeOpacity }))
      rec.tubeMats.push(m)
      world.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 64, c.width * 0.55 * Math.min(scale, MAX_LINE_SCALE), 6), m))
      rec.reach = c.width * 0.55 * Math.min(scale, MAX_LINE_SCALE)
    } else {
      const m = trackBase(new THREE.LineDashedMaterial({ color: extras.ghost, dashSize: 1, gapSize: 0.7, transparent: true, opacity: 0.85 }))
      rec.tubeMats.push(m)
      ghostMats.push(m)
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(curve.getPoints(90)), m)
      line.computeLineDistances()
      world.add(line)
    }
    // Fat invisible tube: a thin line is impossible to click. It does not hide a building behind it
    // (pick): there, only the drawn line itself takes the click.
    rec.reach = Math.max(rec.reach * LINE_REACH, MIN_LINE_REACH)
    const pick = new THREE.Mesh(new THREE.TubeGeometry(curve, 24, 0.8 * scale, 5), new THREE.MeshBasicMaterial({ visible: false }))
    pick.userData.edgeId = c.id
    world.add(pick)
    pickables.push(pick)
    rec.pick = pick
    const shape = text.cargoShapes[c.cargo] ?? 'sphere'
    const count = c.dashed ? 2 : 3
    for (let i = 0; i < count; i++) {
      const m = trackBase(new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: c.dashed ? 0.6 : Math.min(1, tubeOpacity * 2.4) }))
      rec.packetMats.push(m)
      const s = new THREE.Mesh(GEO[shape], m)
      s.scale.setScalar(0.7 * Math.min(scale, MAX_LINE_SCALE))
      const t = reduced ? (i + 0.5) / count : Math.random()
      s.position.copy(curve.getPoint(t))
      world.add(s)
      rec.packets.push({ s, t, sp: (c.dashed ? 0.06 : 0.11) * (0.75 + Math.random() * 0.5) })
    }
    const lp = curve.getPoint(0.5)
    lp.y += 0.8
    const el = document.createElement('div')
    el.className = 'lw-edge'
    const words = text.edges[c.id] ?? c.id
    el.textContent = words
    const lc = hex(c.dashed ? extras.ghost : col.getHex())
    el.style.borderColor = lc
    el.style.color = lc
    el.addEventListener('click', (ev) => { ev.stopPropagation(); opts.onEdgeLabel?.(c.id) })
    const lo = new CSS2DObject(el)
    lo.position.copy(lp)
    // Shown only for the lit lines (animate). Hidden through the object, never the element's
    // display: CSS2DRenderer rewrites style.display on every render, so a display set by hand is lost.
    lo.visible = false
    world.add(lo)
    rec.label = lo
    rec.chars = words.length
    edges.set(c.id, rec)
  }

  /**
   * The overview frames the whole city: every platform's rim, every building to the top of its name
   * and every external, fitted with OVERVIEW_MARGIN to spare into the part of the picture the legend
   * leaves free, seen from OVERVIEW_DIR. Done again when the view is resized.
   */
  function fitOverview(model: SceneModel): void {
    if (model.buildings.length === 0 && model.orbs.length === 0) return
    const pts: V3[] = []
    const h = FLOOR_W / 2
    for (const b of model.buildings) {
      const [x, y, z] = b.pos
      for (const [dx, dz] of [[h, h], [-h, h], [h, -h], [-h, -h]]) pts.push([x + dx, y, z + dz], [x + dx, y + b.height + 4, z + dz])
    }
    for (const o of model.orbs) pts.push([o.pos[0] - ORB_R, o.pos[1], o.pos[2] - ORB_R], [o.pos[0] + ORB_R, o.pos[1] + ORB_R * 2 + 4, o.pos[2] + ORB_R])
    for (const d of model.districts) {
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2
        pts.push([d.pos[0] + Math.cos(a) * d.radius, d.pos[1], d.pos[2] + Math.sin(a) * d.radius])
      }
      pts.push([d.pos[0], d.pos[1] - 2, d.pos[2] + d.radius + 4]) // the district's name below its rim
    }
    const dir: V3 = [OVERVIEW_DIR.x, OVERVIEW_DIR.y, OVERVIEW_DIR.z]
    let fit = fitView(pts, dir, camera.fov, fitAspect(), OVERVIEW_MARGIN, 40)
    // A district's name is DISTRICT_NAME_HALF_PX wide on each side of its point, whatever the
    // distance: at the fitted distance that is so many world units, so the fit is done again with
    // the name's ends in it (twice: the wider fit makes the name a little wider in the world).
    const side = new THREE.Vector3(OVERVIEW_DIR.z, 0, -OVERVIEW_DIR.x).normalize()
    for (let pass = 0; pass < 2 && model.districts.length > 0; pass++) {
      const half = (DISTRICT_NAME_HALF_PX * 2 * fit.dist * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) / height
      const named = [...pts]
      for (const d of model.districts) {
        for (const k of [-1, 1]) named.push([d.pos[0] + side.x * half * k, d.pos[1] - 2, d.pos[2] + d.radius + 4 + side.z * half * k])
      }
      fit = fitView(named, dir, camera.fov, fitAspect(), OVERVIEW_MARGIN, 40)
    }
    overviewDist = fit.dist
    overviewTarget.set(fit.target[0], fit.target[1], fit.target[2])
    overviewPos.copy(overviewTarget).addScaledVector(OVERVIEW_DIR, overviewDist)
    // Room to step back from the overview of even a very big world.
    controls.maxDistance = Math.max(420, overviewDist * 1.6)
  }

  function draw(model: SceneModel, text: SceneText, allEdgeLabels: boolean): void {
    lastModel = model
    lastText = text
    allLabels = allEdgeLabels
    changes.settle() // the objects rising or pulsing are about to be freed
    clearWorld()
    fitOverview(model) // first: the world's scale sizes the lines, packets and fog below
    scale = Math.max(1, Math.sqrt(overviewDist / PROTO_OVERVIEW))
    busy = busyness(model.conduits.length)
    tubeOpacity = clamp(0.38 * busy, MIN_TUBE_OPACITY, 0.38)
    scene.background = new THREE.Color(theme.background)
    fog.color.set(theme.background)
    if (bloom) bloom.strength = extras.bloom * Math.max(MIN_BLOOM, busy) // a busy city glows less
    if (grid) { scene.remove(grid); grid.geometry.dispose(); ([] as THREE.Material[]).concat(grid.material).forEach((m) => m.dispose()) }
    const gridSize = Math.max(700, Math.ceil((overviewDist * 4) / 100) * 100)
    grid = new THREE.GridHelper(gridSize, gridSize / 5, extras.grid, extras.grid)
    grid.position.y = -1.3
    const gm = grid.material as THREE.Material
    gm.transparent = true
    gm.opacity = extras.gridOpacity
    scene.add(grid)

    for (const d of model.districts) buildDistrict(d, text)
    for (const b of model.buildings) buildBuilding(b, hueColor(hueAt(model, b.pos)), text)
    for (const o of model.orbs) buildOrb(o, text)
    const heightAt = new Map<string, number>()
    for (const b of model.buildings) heightAt.set(posKey(b.pos), b.height)
    for (const o of model.orbs) heightAt.set(posKey(o.pos), ORB_R * 2)
    for (const c of model.conduits) buildConduit(c, heightAt, text)

    for (let k = 0; k < 10; k++) {
      const s = new THREE.Mesh(new THREE.SphereGeometry(0.75 * scale * (1 - k / 12), 16, 12), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 1 - k / 10 }))
      s.visible = false
      world.add(s)
      pulseBalls.push(s)
    }
    // The selection: a bright ring in the theme's glow colour, which the bloom picks up.
    selRing = new THREE.Mesh(new THREE.TorusGeometry(4.8, 0.2, 10, 64), new THREE.MeshBasicMaterial({ color: new THREE.Color(theme.glow).multiplyScalar(1.6) }))
    selRing.rotation.x = Math.PI / 2
    selRing.visible = false
    world.add(selRing)
    if (explodedId !== null && (nodes.get(explodedId)?.orb ?? true)) explodedId = null
    for (const n of nodes.values()) n.exploded = n.id === explodedId && !n.orb
    // After the open building is settled: a building gone from the new world no longer thickens it.
    fogTarget = fogFor()
    fog.density = fogTarget
    applyFocus()
    placeRing()
  }

  function applyFocus(): void {
    const f = focus
    for (const n of nodes.values()) {
      const on = !f || f.ids.has(n.id)
      const k = on ? 1 : 0.12
      for (const m of n.mats) {
        m.userData.f = k
        if (!ghostMats.includes(m)) m.opacity = m.userData.base * k
      }
      for (const l of n.labels) { l.dim = on ? 1 : 0.2; l.lit = !!f && on }
    }
    for (const e of edges.values()) {
      const on = !f || f.edgeIds.has(e.id)
      e.focus = !!f && on
      // A hovered building's labels gather over it: they must not catch the click meant for it.
      e.label.element.style.pointerEvents = e.focus && f?.passive?.has(e.id) ? 'none' : ''
      for (const m of e.tubeMats) {
        const base = m.userData.base as number
        const o = f ? focusOpacity(base, on) : base
        m.userData.f = base > 0 ? o / base : 1
        if (!ghostMats.includes(m)) m.opacity = o
      }
      for (const m of e.packetMats) {
        const base = m.userData.base as number
        m.opacity = f ? (on ? Math.min(1, base * 1.9) : base * 0.06) : base
      }
    }
  }

  function placeRing(): void {
    if (!selRing) return
    const n = selectedId === null ? undefined : nodes.get(selectedId)
    selRing.visible = !!n
    if (n) {
      selRing.position.copy(n.group.position)
      selRing.position.y += n.orb ? -0.2 : 0.15
    }
  }

  // ---------------- camera ----------------
  interface Tween { p0: THREE.Vector3; p1: THREE.Vector3; t0: THREE.Vector3; t1: THREE.Vector3; start: number; dur: number; done: () => void }
  let tween: Tween | null = null
  function endTween(): void {
    const t = tween
    tween = null
    t?.done()
  }
  /** The camera is at (or flying to) the overview, so a resize fits it again. */
  let atOverview = false
  function flyTo(pos: THREE.Vector3, target: THREE.Vector3, instant: boolean, dur = 1.5): Promise<void> {
    controls.autoRotate = false
    atOverview = false
    endTween()
    if (instant || reduced) {
      camera.position.copy(pos)
      controls.target.copy(target)
      controls.update()
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      tween = { p0: camera.position.clone(), p1: pos.clone(), t0: controls.target.clone(), t1: target.clone(), start: performance.now(), dur: dur * 1000, done: resolve }
    })
  }
  function frameAt(target: THREE.Vector3, dist: number, instant: boolean): Promise<void> {
    const dir = camera.position.clone().sub(controls.target).setY(0).normalize()
    if (!dir.lengthSq()) dir.set(0, 0, 1)
    const pos = target.clone().addScaledVector(dir, dist)
    pos.y = target.y + dist * 0.5
    return flyTo(pos, target, instant)
  }
  function nodeTarget(n: NodeRec): THREE.Vector3 {
    const t = n.anchor.clone()
    t.y -= n.height * 0.45
    return t
  }

  function frame(ids: string[], instant: boolean, around?: string[]): Promise<void> {
    const pts: THREE.Vector3[] = []
    let single: NodeRec | EdgeRec | null = null
    for (const id of ids) {
      const n = nodes.get(id)
      const e = edges.get(id)
      if (n) { pts.push(nodeTarget(n)); single = n } else if (e) { pts.push(e.curve.getPoint(0.5)); single = e }
    }
    if (pts.length === 0) return Promise.resolve()
    if (pts.length === 1 && single) {
      if ('curve' in single) {
        const span = single.curve.v0.distanceTo(single.curve.v2)
        return frameAt(pts[0], Math.max(26, span * 0.75), instant)
      }
      if (single.exploded) return frameAt(pts[0], 22 + single.floors.length * 2.5, instant)
      return frameWith(single, pts[0], around ?? [], instant)
    }
    const c = pts.reduce((s, p) => s.add(p), new THREE.Vector3()).divideScalar(pts.length)
    const spread = Math.max(...pts.map((p) => p.distanceTo(c)))
    return frameAt(c, Math.max(30, spread * 2.2), instant)
  }

  /**
   * One building with its neighbours in view: looking at the building from the current side, as
   * close as the neighbours allow (never closer than the prototype's framing, never further than
   * most of the overview: a neighbour across a big city stays lit by the focus, if out of the picture).
   */
  function frameWith(n: NodeRec, target: THREE.Vector3, around: string[], instant: boolean): Promise<void> {
    const h = camera.position.clone().sub(controls.target).setY(0).normalize()
    if (!h.lengthSq()) h.set(0, 0, 1)
    const dir = new THREE.Vector3(h.x, 0.5, h.z).normalize()
    const pts: V3[] = []
    for (const id of [n.id, ...around]) {
      const m = nodes.get(id)
      if (!m) continue
      const base = m.group.position
      pts.push([base.x, base.y, base.z], [m.anchor.x, m.anchor.y + 3, m.anchor.z])
    }
    const t: V3 = [target.x, target.y, target.z]
    const fit = fitDistance(pts, t, [dir.x, dir.y, dir.z], camera.fov, fitAspect(), CLOSE_UP_MARGIN, CLOSE_UP_MIN)
    const dist = clamp(fit, CLOSE_UP_MIN, overviewDist * 0.7)
    return flyTo(target.clone().addScaledVector(dir, dist), target, instant)
  }

  // ---------------- pulses ----------------
  interface PulseAnim { curve: THREE.QuadraticBezierCurve3; t: number; color: THREE.Color; done: () => void }
  let pulseAnim: PulseAnim | null = null
  let pulseToken = 0
  function stopPulses(): void {
    pulseToken++
    const p = pulseAnim
    pulseAnim = null
    for (const s of pulseBalls) s.visible = false
    p?.done()
  }
  async function pulse(edgeIds: string[], instant: boolean): Promise<void> {
    stopPulses()
    if (instant || reduced) return
    const mine = pulseToken
    for (const id of edgeIds) {
      if (mine !== pulseToken) return
      const e = edges.get(id)
      if (!e) continue
      const color = (e.packetMats[0] as THREE.MeshBasicMaterial | undefined)?.color.clone() ?? new THREE.Color(0xffffff)
      await new Promise<void>((resolve) => { pulseAnim = { curve: e.curve, t: 0, color, done: resolve } })
    }
  }

  // ---------------- picking ----------------
  const ray = new THREE.Raycaster()
  const mouse = new THREE.Vector2()
  function pick(clientX: number, clientY: number): RenderPick | null {
    const r = renderer.domElement.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) return null
    mouse.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1)
    scene.updateMatrixWorld()
    camera.updateMatrixWorld()
    ray.setFromCamera(mouse, camera)
    // Hits come nearest first. The nearest one wins, except that a node just behind an edge's
    // fat pick tube (within PICK_NODE_EPS) still wins: a conduit runs into the building it ends
    // at, and its tube must not swallow clicks on that building's face.
    const hits = ray.intersectObjects(pickables, false)
    const node = hits.find((h) => typeof h.object.userData.nodeId === 'string')
    // In front of a building, only a line the ray really touches counts (LINE_REACH).
    const edge = hits.find((h) => {
      if (typeof h.object.userData.edgeId !== 'string') return false
      if (!node || node.distance <= h.distance) return true
      const rec = edges.get(h.object.userData.edgeId as string)
      return !rec || touches(rec)
    })
    if (node && (!edge || node.distance <= edge.distance + PICK_NODE_EPS)) return { kind: 'node', id: node.object.userData.nodeId as string }
    return edge ? { kind: 'edge', id: edge.object.userData.edgeId as string } : null
  }

  /** Whether the pick ray passes within the line's reach of any segment of its drawn path (world space). */
  const segA = new THREE.Vector3()
  const segB = new THREE.Vector3()
  function touches(rec: EdgeRec): boolean {
    const r2 = rec.reach * rec.reach
    for (let i = 1; i < rec.path.length; i++) {
      segA.copy(rec.path[i - 1]).applyMatrix4(world.matrixWorld)
      segB.copy(rec.path[i]).applyMatrix4(world.matrixWorld)
      if (ray.ray.distanceSqToSegment(segA, segB) <= r2) return true
    }
    return false
  }

  function screenPoint(id: string): { x: number; y: number } | null {
    const n = nodes.get(id)
    const r = renderer.domElement.getBoundingClientRect()
    if (!n || r.width === 0 || r.height === 0) return null
    scene.updateMatrixWorld()
    camera.updateMatrixWorld()
    // In world space: the top floor first, then the floors below, then the roof's corners pulled a
    // little inward. An orb: its centre, then its upper half.
    const points: THREE.Vector3[] = []
    const top = n.floors[n.floors.length - 1]
    if (!top) for (const y of [ORB_R, ORB_R * 1.6]) points.push(n.group.localToWorld(new THREE.Vector3(0, y, 0)))
    for (let k = n.floors.length - 1; k >= 0; k--) points.push(n.floors[k].localToWorld(new THREE.Vector3()))
    if (top) {
      const c = FLOOR_W * 0.35
      for (const [dx, dz] of [[c, c], [-c, c], [c, -c], [-c, -c]]) points.push(top.localToWorld(new THREE.Vector3(dx, 0, dz)))
    }
    for (const p of points) {
      p.project(camera)
      if (Math.abs(p.x) > 1 || Math.abs(p.y) > 1 || Math.abs(p.z) > 1) continue
      const pt = { x: r.left + ((p.x + 1) / 2) * r.width, y: r.top + ((1 - p.y) / 2) * r.height }
      const hit = pick(pt.x, pt.y)
      if (hit && hit.kind === 'node' && hit.id === id) return pt
    }
    return null
  }

  function visibleIds(): string[] {
    camera.updateMatrixWorld()
    const m = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
    const frustum = new THREE.Frustum().setFromProjectionMatrix(m)
    const out: string[] = []
    for (const n of nodes.values()) if (frustum.containsPoint(nodeTarget(n))) out.push(n.id)
    for (const e of edges.values()) if (frustum.containsPoint(e.curve.getPoint(0.5))) out.push(e.id)
    return out
  }

  // ---------------- keys (WASD/QE; only while the view has focus) ----------------
  const keys: Record<string, boolean> = {}
  const onKeyDown = (e: KeyboardEvent): void => {
    const k = e.key.toLowerCase()
    keys[k] = true
    if ('wasdqe'.includes(k) && k.length === 1) { controls.autoRotate = false; atOverview = false; endTween() }
  }
  const onKeyUp = (e: KeyboardEvent): void => { keys[e.key.toLowerCase()] = false }
  const onBlur = (): void => { for (const k of Object.keys(keys)) keys[k] = false }
  host.addEventListener('keydown', onKeyDown)
  host.addEventListener('keyup', onKeyUp)
  host.addEventListener('blur', onBlur, true)
  undo.push(() => {
    host.removeEventListener('keydown', onKeyDown)
    host.removeEventListener('keyup', onKeyUp)
    host.removeEventListener('blur', onBlur, true)
  })

  // ---------------- resize ----------------
  const resize = (): void => {
    ;[width, height] = size()
    applyView()
    renderer.setSize(width, height)
    composer?.setSize(width, height)
    labelRenderer.setSize(width, height)
    // The city is fitted again to the new shape; a camera at the overview moves to the new one.
    if (!lastModel) return
    fitOverview(lastModel)
    fogTarget = fogFor()
    if (!atOverview) return
    if (tween) { tween.p1.copy(overviewPos); tween.t1.copy(overviewTarget); return }
    camera.position.copy(overviewPos)
    controls.target.copy(overviewTarget)
    controls.update()
  }
  const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize)
  ro?.observe(host)
  undo.push(() => { ro?.disconnect() })

  /**
   * The focus-lit lines whose labels show: nearest the camera first, each clear of the ones already
   * shown, at most HOVER_EDGE_LABELS for a hover (FOCUS_EDGE_LABELS for a selection). A label off the
   * picture is not shown.
   */
  const labelAt = new THREE.Vector3()
  function focusLabels(): Set<string> {
    const lit: { box: LabelBox; d: number }[] = []
    for (const e of edges.values()) {
      if (!e.focus) continue
      e.label.getWorldPosition(labelAt)
      const d = labelAt.distanceTo(camera.position)
      labelAt.project(camera)
      if (Math.abs(labelAt.x) > 1 || Math.abs(labelAt.y) > 1 || labelAt.z > 1) continue
      const { w, h } = edgeLabelSize(e.chars)
      lit.push({ box: { id: e.id, x: ((labelAt.x + 1) / 2) * width, y: ((1 - labelAt.y) / 2) * height, w, h }, d })
    }
    lit.sort((a, b) => a.d - b.d)
    return declutter(lit.map((l) => l.box), focus?.hover ? HOVER_EDGE_LABELS : FOCUS_EDGE_LABELS)
  }

  // ---------------- loop ----------------
  const clock = new THREE.Clock()
  const fwd = new THREE.Vector3()
  const right = new THREE.Vector3()
  const up = new THREE.Vector3(0, 1, 0)
  const wp = new THREE.Vector3()
  const mv = new THREE.Vector3()
  let raf = 0
  let disposed = false
  let paused = false
  function animate(): void {
    if (disposed || paused) return
    raf = requestAnimationFrame(animate)
    const dt = Math.min(clock.getDelta(), 0.05)
    changes.tick(performance.now()) // wall-clock time: a slow frame rate never stretches a change
    const t = clock.elapsedTime
    const sp = (keys.shift ? 60 : 28) * dt
    camera.getWorldDirection(fwd)
    fwd.y = 0
    fwd.normalize()
    right.crossVectors(fwd, up).normalize()
    mv.set(0, 0, 0)
    if (keys.w) mv.add(fwd)
    if (keys.s) mv.sub(fwd)
    if (keys.d) mv.add(right)
    if (keys.a) mv.sub(right)
    if (keys.e) mv.y += 1
    if (keys.q) mv.y -= 1
    if (mv.lengthSq()) { mv.normalize().multiplyScalar(sp); camera.position.add(mv); controls.target.add(mv) }
    if (tween) {
      const k = Math.min(1, (performance.now() - tween.start) / tween.dur)
      const ez = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2
      camera.position.lerpVectors(tween.p0, tween.p1, ez)
      controls.target.lerpVectors(tween.t0, tween.t1, ez)
      if (k >= 1) endTween()
    }
    for (const n of nodes.values()) {
      n.floors.forEach((fl, k) => {
        const d = n.exploded ? fl.userData.explodedY : fl.userData.baseY
        fl.position.y += (d - fl.position.y) * Math.min(1, dt * 5)
        const tr = n.exploded ? (k % 2 ? 0.12 : -0.12) : 0
        fl.rotation.y += (tr - fl.rotation.y) * Math.min(1, dt * 4)
        const fLabel = n.floorLabels[k]
        if (fLabel) fLabel.o.element.style.opacity = n.exploded ? '1' : '0'
      })
      if (n.flow) {
        const on = n.exploded
        n.flow.line.visible = on
        for (const d of n.flow.dots) {
          d.visible = on
          if (on) {
            d.userData.t = (d.userData.t + dt * 0.35) % 1
            d.position.y = n.flow.y0 + (n.flow.y1 - n.flow.y0) * d.userData.t
          }
        }
      }
    }
    for (const s of seals) s.rotation.z += dt * 0.8
    if (!reduced) {
      for (const e of edges.values()) {
        for (const p of e.packets) {
          p.t = (p.t + p.sp * dt) % 1
          p.s.position.copy(e.curve.getPoint(p.t))
          p.s.rotation.x += dt
          p.s.rotation.y += dt * 1.3
        }
      }
    }
    for (const s of fogSprites) {
      const u = s.userData
      u.a += u.sp * dt
      s.position.x = Math.cos(u.a) * u.r
      s.position.z = Math.sin(u.a) * u.r
      s.position.y = u.y + Math.sin(t + u.a) * 0.6
    }
    const gp = 0.55 + 0.45 * Math.sin(t * 2.2)
    for (const m of ghostMats) m.opacity = Math.min(1, m.userData.base * gp * (m.userData.f ?? 1))
    if (selRing && selRing.visible) selRing.rotation.z += dt * 0.5
    if (pulseAnim) {
      const pa = pulseAnim
      pa.t = Math.min(1.25, pa.t + dt * 0.65)
      pulseBalls.forEach((s, k) => {
        const tt = pa.t - k * 0.025
        s.visible = tt >= 0 && tt <= 1
        if (s.visible) {
          s.position.copy(pa.curve.getPoint(tt))
          ;(s.material as THREE.MeshBasicMaterial).color.copy(pa.color)
        }
      })
      if (pa.t >= 1.25) {
        for (const s of pulseBalls) s.visible = false
        pulseAnim = null
        pa.done()
      }
    }
    fog.density += (fogTarget - fog.density) * Math.min(1, dt * 2)
    if (dustGeo && !reduced) {
      const dp = dustGeo.attributes.position.array as Float32Array
      for (let i = 1; i < dp.length; i += 3) { dp[i] += dt * 1.1; if (dp[i] > 58) dp[i] = -2 }
      dustGeo.attributes.position.needsUpdate = true
    }
    // Semantic zoom: district names read from the overview of any size of world (their fade starts
    // past it), building names come in at middle distance as in the prototype, and the names of
    // the hovered or selected part and its neighbours show at any distance.
    const districtFade = Math.max(170, overviewDist * 1.15)
    for (const l of labels) {
      if (l.kind === 'floor' || l.kind === 'proc') continue
      let o = 1
      if (!l.lit && !hoverLabels.includes(l)) {
        l.o.getWorldPosition(wp)
        const d = wp.distanceTo(camera.position)
        o = Math.max(0, Math.min(1, l.kind === 'district' ? 1.9 - d / districtFade : 1.7 - d / 105)) * l.dim
      }
      l.o.element.style.opacity = String(o)
    }
    const shownFocus = allLabels ? null : focusLabels()
    for (const e of edges.values()) {
      const on = allLabels || (e.focus && (shownFocus as Set<string>).has(e.id))
      e.label.visible = on
      if (on) {
        e.label.getWorldPosition(wp)
        e.label.element.style.opacity = String(Math.max(0.35, Math.min(1, 1.8 - wp.distanceTo(camera.position) / 110)))
      }
    }
    controls.update()
    if (composer) composer.render()
    else renderer.render(scene, camera)
    labelRenderer.render(scene, camera)
  }
  raf = requestAnimationFrame(animate)

  return {
    canvas: renderer.domElement,
    draw,
    setTheme(name, th) {
      themeName = name
      theme = th
      extras = EXTRAS[themeName]
      fogTarget = fogFor()
      fog.density = fogTarget
      if (lastModel && lastText) draw(lastModel, lastText, allLabels)
      else { scene.background = new THREE.Color(th.background); fog.color.set(th.background) }
    },
    setFocus(f) { focus = f; applyFocus() },
    setSelected(id) { selectedId = id; placeRing() },
    setExploded(id) {
      // Only a building opens: an orb (external) has no floors, so it never thickens the fog.
      const n = id === null ? undefined : nodes.get(id)
      explodedId = n && !n.orb ? n.id : null
      for (const n of nodes.values()) n.exploded = n.id === explodedId && !n.orb
      fogTarget = fogFor()
    },
    frame,
    overview(instant) {
      const flight = flyTo(overviewPos, overviewTarget, instant, 1.8)
      atOverview = true
      return flight
    },
    pulse,
    stopPulses,
    pick,
    setCursor(pointer) { renderer.domElement.style.cursor = pointer ? 'pointer' : 'default' },
    setHovered(id) { hoverLabels = id === null ? [] : nodes.get(id)?.labels ?? [] },
    visibleIds,
    screenPoint,
    drawnCounts: () => ({ processShells: shellCount, conduits: edges.size, changing: changes.active() }),
    keepGhosts(ids) {
      const groups: THREE.Object3D[] = []
      for (const id of ids) {
        const n = nodes.get(id)
        if (n) groups.push(n.group)
      }
      changes.keep(groups, performance.now())
    },
    animateChanges({ rise, pulse }) {
      const groups: THREE.Object3D[] = []
      const mats: THREE.Material[] = []
      for (const id of rise) {
        const n = nodes.get(id)
        if (n) groups.push(n.group)
      }
      for (const id of pulse) mats.push(...(nodes.get(id)?.mats ?? []))
      changes.start(groups, mats, performance.now())
    },
    stopChanges: () => changes.stop(),
    setPaused(p) {
      if (disposed || p === paused) return
      paused = p
      if (p) { cancelAnimationFrame(raf); return }
      clock.getDelta() // the pause is not a frame: nothing jumps on the first frame back
      raf = requestAnimationFrame(animate)
    },
    dispose() {
      if (disposed) return
      disposed = true
      changes.stop()
      cancelAnimationFrame(raf)
      ro?.disconnect()
      host.removeEventListener('keydown', onKeyDown)
      host.removeEventListener('keyup', onKeyUp)
      host.removeEventListener('blur', onBlur, true)
      controls.removeEventListener('start', onControlStart)
      controls.dispose()
      endTween()
      stopPulses()
      clearWorld()
      if (grid) { grid.geometry.dispose(); ([] as THREE.Material[]).concat(grid.material).forEach((m) => m.dispose()) }
      starGeo.dispose(); starMat.dispose()
      dustGeo?.dispose(); dustMat?.dispose()
      fogTex.dispose()
      dotTex.dispose()
      for (const g of shared) g.dispose()
      bloom?.dispose()
      outputPass?.dispose()
      renderPass?.dispose()
      composer?.dispose()
      renderer.dispose()
      renderer.forceContextLoss()
      renderer.domElement.remove()
      labelRenderer.domElement.remove()
    },
  }
}
