// Lumopolis drawing layer: every Three.js call lives here. It draws a SceneModel (sceneModel.ts)
// plus the label strings the viewer hands it, and knows nothing about WorldDocs. Ported from the
// brainstorm prototype (world-relationships.html): bloom, fog, starfield and dust, CSS2D labels,
// OrbitControls plus WASD/QE, double-click explode, flow pulses, fat invisible picking tubes and
// focus dimming. Unit-tested with only the GPU boundary faked (WebGLRenderer and the composer's
// passes: tests/renderer/world/threeHarness.ts) under the 100% coverage gate; e2e checks the pixels.
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js'
import { BACKDROP_ORDER, batchable, batchCapacity, batchRank, buildingNamesShown, districtsOf, endHeight, fillKey, floorLabelsShown, focusHolds, groupBatches, heldTier, LINE_ORDER, ownTier, packetKey, PLATFORM_ORDER, partDrawn, poolChanges, slabSeams, slabsFor, tierPick, transparentOrder, writesDepth, type PartKind, type Slab } from './batching'
import { slabLook, slabSignals, type SlabLook, type SlabSignals } from './slabSignals'
import { createCameraRig, type FlightState, type Vec3 as RigVec } from './cameraRig'
import { createChangeAnimator } from './changeAnimation'
import { focusOpacity } from './interaction'
import { zoomTierAt, type ZoomTier, backOffs, busyness, clamp, clampIntoView, districtNameHalf, easeArea, edgeLabelSize, fitDistance, fitView, fogDensity, freeArea, inFreeArea, nameBudget, overviewDir, LABEL_GAP, LABEL_KEEP_GAP, placeLabels, sameArea, toleratedPick, turnAcross, turnGround, viewFrame, type FreeArea, type LabelCandidate, type Nudge, type Rect, type ScreenBox, type V3 } from './viewMath'
import { HEAT_COLOR, heatMix, type SceneBuilding, SceneConduit, SceneDistrict, SceneModel, SceneOrb, Vec3 } from './sceneModel'
import type { Theme, ThemeName } from './themes'
import { screenRect } from './screenRect'

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
  /** How many lines meet at each building or orb: at a distance, only the busiest are named (semantic zoom). */
  importance: Record<string, number>
}

/** What a click or hover picks: a building or external, a line, or (at the districts tier) a district's slab. */
export type RenderPick = { kind: 'node'; id: string } | { kind: 'edge'; id: string } | { kind: 'district'; id: string }
/**
 * What to light. `hover`: the focus of a hovered building (it shows fewer line labels). `passive`:
 * lines whose labels let a click through to the building under them (a busy building's hover labels
 * gather over it); the others stay clickable.
 */
/** `held`: on a hover, whether the focus under it holds the buildings tier (focusHolds). */
export interface RenderFocus { ids: Set<string>; edgeIds: Set<string>; hover?: boolean; passive?: Set<string>; held?: boolean }

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
  /**
   * Pixels at the bottom of the view that a panel covers (the ask bar): kept out of the overview's
   * and the close-ups' fit the same way, and district names stay above it.
   */
  bottomReserve?: number
}

export interface ThreeRenderer {
  readonly canvas: HTMLCanvasElement
  draw(model: SceneModel, text: SceneText, allEdgeLabels: boolean): void
  /**
   * The strip on the right the legend covers has changed (it opened or closed): fit the city to the rest.
   * `from`: the view width from which the strip is kept clear (by default three times the strip).
   */
  setRightReserve(px: number, from?: number): void
  /** The strip at the bottom the ask bar covers has changed (its height): fit the city to the rest. */
  setBottomReserve(px: number): void
  /**
   * The open card's box from the view's top left corner (its width and height, gaps included; 0, 0
   * when no card is open): a focus, a line's close-up or a tour step fits the city around it.
   */
  setCardReserve(w: number, h: number): void
  /**
   * The panels drawn over the view (the legend, the ask bar, the card, the toolbar): no map label is
   * drawn under one, nor cut off at the view's edge. Their boxes are measured again as they change.
   */
  setPanels(els: readonly HTMLElement[]): void
  /** How many times their base size the map's labels are drawn (1, more on a big screen: uiScale). */
  setLabelScale(s: number): void
  setTheme(name: ThemeName, theme: Theme): void
  setFocus(focus: RenderFocus | null): void
  /** The selected building or line (its card is open), or null. */
  setSelected(id: string | null): void
  setExploded(id: string | null): void
  /**
   * Flies to frame the given node and edge ids. Resolves when the flight lands. With `around`, a
   * single building is framed with those parts (its neighbours) in view as well.
   */
  frame(ids: string[], instant: boolean, around?: string[]): Promise<void>
  overview(instant: boolean): Promise<void>
  /** Where the camera stands and what it looks at now (a bookmark saves it). */
  getCamera(): { pos: [number, number, number]; target: [number, number, number] }
  /** Flies the camera to a saved pose (`instant`: lands at once) and leaves it there. */
  flyTo(pose: { pos: [number, number, number]; target: [number, number, number] }, instant: boolean): Promise<void>
  /** Runs a bright pulse along each edge in turn. Resolves when the last one arrives. */
  pulse(edgeIds: string[], instant: boolean): Promise<void>
  stopPulses(): void
  pick(clientX: number, clientY: number): RenderPick | null
  setCursor(pointer: boolean): void
  /** The building or external under the pointer (null: none). Its name shows at any distance. */
  setHovered(id: string | null): void
  /** Node and edge ids whose anchor is inside the camera frustum. */
  visibleIds(): string[]
  /** Whether building or orb `id` shows at the tier drawn: drawn itself, or under its district's slab, which stands for it from far away. */
  isShown(id: string): boolean
  /**
   * A point on screen, in client pixels, where a click picks the node: its top floor's centre (an
   * orb's centre) when nothing stands in front of it, else the first of its other floors' centres
   * and roof corners that pick() gives to this node. Null when it is not drawn, or no such point is
   * in view (hidden behind other buildings or a conduit's pick tube). For a line: a point along it
   * over open ground (no building along the ray) where a click picks the line, or null.
   */
  screenPoint(id: string): { x: number; y: number } | null
  /** Points of line `id` (client pixels) that are on screen with no building in front of them: where it can be seen. */
  linePoints(id: string): Array<{ x: number; y: number }>
  /** How many process shells and conduits the last draw put up, and how many changes are still animating. */
  drawnCounts(): { processShells: number; conduits: number; changing: number; tier: ZoomTier; drawCalls: number; buildings: number; districts: number; slabs: number; slabLooks: SlabSignals[] }
  /** The four looping motions as they stand now (radians, or the pulse's level; all four hold still under reduced
   *  motion), and what the last draw put up: bloom, the star and dust points, the platforms and their lamps, each
   *  building's floor captions bottom to top, the orbs, the opened building and its gap, the camera flight, and how
   *  many line labels show. */
  motionState(): MotionState
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
.lw-labels{position:absolute;top:0;left:0;z-index:0;pointer-events:none;--lw-s:1}
.lw-district{font:700 calc(15px * var(--lw-s)) system-ui,sans-serif;letter-spacing:.13em;text-transform:uppercase;text-shadow:0 0 .8em currentColor;white-space:nowrap;text-align:center}
.lw-district span{display:block;font-size:.8em;letter-spacing:.08em;font-weight:500;opacity:.8;text-shadow:none}
.lw-bldg{font:calc(12px * var(--lw-s)) system-ui,sans-serif;color:#e2e8f0;padding:.17em .67em;border-radius:.5em;background:rgba(3,7,18,.65);border:1px solid rgba(148,163,184,.25);white-space:nowrap}
.lw-floor{font:calc(12px * var(--lw-s)) system-ui,sans-serif;color:#e2e8f0;padding:.08em .5em;border-radius:.33em;background:rgba(3,7,18,.82);border-left:2px solid #38bdf8;white-space:nowrap;opacity:0}
.lw-edge{font:calc(12px * var(--lw-s)) system-ui,sans-serif;padding:.17em .58em;border-radius:99px;background:rgba(3,7,18,.85);border:1px solid;white-space:nowrap;pointer-events:auto;cursor:pointer}
.lw-edge:hover{background:rgba(30,41,59,.95)}
.lw-proc{font:calc(12px * var(--lw-s)) system-ui,sans-serif;padding:.08em .58em;border-radius:.33em;background:rgba(3,7,18,.8);border:1px dashed;white-space:nowrap}
`

const FLOOR_W = 5
/** A changed part's outline shell is this much larger than the building. */
const OUTLINE_SCALE = 1.08
/** A removed part's opacity pulse: between 0.15 and 0.45. */
const FADE_MID = 0.3
const FADE_AMP = 0.15
const ORB_R = 2.2
/** A framing on screen: what it frames, the neighbours kept in view, and the side it looks from. */
interface Framing { ids: string[]; around: string[] | undefined; from: THREE.Vector3 }
const v3 = (v: THREE.Vector3): RigVec => [v.x, v.y, v.z]

/** How far behind an edge pick tube (radius 0.8) a node hit may lie and still win the pick. */
const PICK_NODE_EPS = 1
/** How steeply a line's close-up may look down (height over ground distance), tried in turn until the arch is in sight. */
const LINE_LIFTS = [0.7, 1, 2, 4]
/** How far a line's close-up may step back at each lift (times the fitted distance), tried in turn. */
const LINE_BACKS = [1, 1.4, 1.9]
/** How far clear of every building a line's camera stands, as a share of its distance to the line. */
const LINE_CLEAR = 0.45
/**
 * When no near, clear view of a line shows both its ends, the close-up looks again from more sides
 * (LINE_TURNS degrees off straight across the line), lower as well as higher (LINE_WIDE_LIFTS), and
 * further out (each LINE_BACK_STEP times the last, up to the controls' reach) until both ends show.
 */
const LINE_TURNS = [0, 180, 45, -45, 135, -135]
const LINE_WIDE_LIFTS = [0.45, ...LINE_LIFTS]
const LINE_BACK_STEP = 1.3
/** The most click tests (rays) the wider look may spend on a line's ends: a click stays quick. */
const LINE_RAY_BUDGET = 150
/** How far inside the free part of the view (pixels) a line's end must show: not on a panel's edge. */
const END_INSET_PX = 12
/**
 * How near a line's end (world units; at most a fifth of the line's span) a click on the line still
 * picks the building or orb there: a busy building's lines all rise from its roof, and a click just
 * above the roof is meant for the building.
 */
const LINE_END_SNAP = 2.5
/**
 * In front of a building, a line takes the click only where the ray passes within LINE_REACH times
 * its drawn radius of it (at least MIN_LINE_REACH world units): its fat pick tube is there to make a
 * thin line clickable over open ground, not to cover the building behind it.
 */
const LINE_REACH = 2
const MIN_LINE_REACH = 0.5
/**
 * The camera's vertical field of view (degrees) over the view's own height. With a bottom reserve the
 * camera's picture is taller than the view (stretchFov), at the same scale.
 */
const BASE_FOV = 55
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
/** A district's name keeps this many pixels from the edge of the view. */
const LABEL_VIEW_INSET = 4
/** A district name's type size at scale 1 (.lw-district), and the room across it keeps from a label on its row, in that size. */
const DISTRICT_FONT_PX = 15
const DISTRICT_ROW_GAP_EM = 1.5
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
/** What motionState reports: read from the objects the renderer already drew, never drawn for it. */
export interface MotionState {
  ringAngle: number; fogDrift: number; wirePulse: number; selectionRingAngle: number
  bloom: boolean; stars: number; dust: number
  /** Each district platform's number of sides, and how many district lamps pool light. */
  platformSides: Record<string, number>; platformLights: number
  /** Each building's floor captions, bottom to top. */
  floorOrder: Record<string, string[]>
  orbs: string[]
  /** The opened building, and how far its top floor has lifted off its closed place. */
  exploded: string | null; explodeGap: number
  flight: FlightState
  lineLabels: number
}
/**
 * dim: the focus dimming (1 or 0.2); lit: its part is hovered or selected, so the label shows at any
 * distance. key: its name in the label placement (placeLabels).
 */
interface LabelRec { o: CSS2DObject; kind: LabelKind; dim: number; lit: boolean; key: string }
interface NodeRec {
  id: string; group: THREE.Group; floors: THREE.Group[]; floorLabels: (LabelRec | null)[]
  mats: THREE.Material[]; labels: LabelRec[]; height: number; anchor: THREE.Vector3; orb: boolean
  exploded: boolean
  flow?: { line: THREE.Line; y0: number; y1: number; dots: THREE.Mesh[] }
}
interface Packet { s: THREE.Mesh; t: number; sp: number }
/** A part of a building that may be drawn in a batch: a floor's box and seams, or its block's box and outline. */
interface BatchPart { mesh: THREE.Mesh; line: THREE.LineSegments; node: NodeRec; kind: PartKind; depth: number }
/** A line's course for one set of end heights: on the roofs, or on the district slabs (the districts tier). */
interface EdgeShape { curve: THREE.QuadraticBezierCurve3; path: THREE.Vector3[]; geo: THREE.BufferGeometry; pickGeo: THREE.BufferGeometry; label: THREE.Vector3 }
interface EdgeRec {
  id: string; curve: THREE.QuadraticBezierCurve3; tubeMats: THREE.Material[]; packetMats: THREE.Material[]
  /** The drawn line, and its course on the roofs and on the slabs (applyTier swaps them). */
  drawn: THREE.Mesh | THREE.Line; tall: EdgeShape; low: EdgeShape
  packets: Packet[]; pick: THREE.Mesh; label: CSS2DObject; focus: boolean
  /** The label's length in characters, for its size on screen (declutter). */
  chars: number
  /** Points along the drawn line, and how near a ray must pass to touch it (pick). */
  path: THREE.Vector3[]; reach: number
}

const hex = (c: number | string): string => '#' + new THREE.Color(c).getHexString()
const posKey = (p: Vec3): string => `${p[0]},${p[1]},${p[2]}`
/** A batch's per-instance colour lights the emissive (the glow) instead of tinting the fill (three.js's instanceColor goes to vColor). */
const EMISSIVE_TINT = '#include <emissivemap_fragment>\n#ifdef USE_COLOR\n\ttotalEmissiveRadiance *= vColor;\n#endif'
/** The batched outline's band on each face, in pixels from its edge: full colour at 0, none from EDGE_BAND[1]. */
const EDGE_BAND: readonly [number, number] = [0, 1]
/** How near its rest a moving floor must come before its batch stops being refilled every frame. */
const EASED = 1e-3
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
  m.userData.depth = m.depthWrite
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
  renderer.info.autoReset = false // a frame's draw calls add up across the composer's passes; reset once a frame
  undo.push(() => { renderer.domElement.remove(); renderer.dispose(); renderer.forceContextLoss() }) // off the page first, whatever freeing it does
  host.appendChild(renderer.domElement)
  const labelRenderer = new CSS2DRenderer()
  labelRenderer.setSize(width, height)
  labelRenderer.domElement.className = 'lw-labels'
  undo.push(() => { labelRenderer.domElement.remove() })
  host.appendChild(labelRenderer.domElement)

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(BASE_FOV, width / height, 0.1, 3000)
  /** The reserve rightInset works from: the legend's footprint, which changes as it opens and closes. */
  let reserve = opts.rightReserve ?? 0
  /** From what view width that strip is kept clear: undefined for rightInset's own rule (three times the strip). */
  let reserveFrom: number | undefined
  /** The reserve bottomInset works from: the ask bar's height, which changes as it wraps or answers. */
  let lowReserve = opts.bottomReserve ?? 0
  /** The open card's box from the top left corner, or null: kept out of every fit but the overview's. */
  let cardBox: [number, number] | null = null
  /**
   * What the camera is doing (cameraRig): at the overview, on a framing (kept so it is done again,
   * from the same side, when a panel opens, closes or changes size, or the view is resized), or left
   * where a hand moved it. Its deps are only called once the camera and controls exist.
   */
  const rig = createCameraRig<Framing>({
    home: () => ({ pos: v3(overviewPos), target: v3(overviewTarget) }),
    shot: (f) => {
      const s = shotFor(f.ids, f.around, f.from)
      return s ? { pos: v3(s.pos), target: v3(s.target) } : null
    },
    current: () => ({ pos: v3(camera.position), target: v3(controls.target) }),
    apply: (pose) => {
      camera.position.set(pose.pos[0], pose.pos[1], pose.pos[2])
      controls.target.set(pose.target[0], pose.target[1], pose.target[2])
      controls.update()
    },
    // A drag's glide (OrbitControls damping) is spent at once, where the camera is now.
    halt: () => {
      controls.enableDamping = false
      controls.update()
      controls.enableDamping = true
    },
    onMode: () => applyView(false),
    now: () => performance.now(),
    reduced,
  })
  /**
   * The part of the view the panels leave free (freeArea). The overview is the home view, the one
   * with no card: it fits around the legend and the ask bar only. Every other framing (a building's
   * focus, a line's close-up, a tour step) fits around the open card too.
   */
  const areaFor = (withCard: boolean): FreeArea => freeArea(width, height, reserve, lowReserve, withCard ? cardBox : null, reserveFrom)
  /** The free area the picture is centred on now, and the one it eases toward (no jump when a panel opens or closes). */
  let area: FreeArea = areaFor(false)
  let areaGoal: FreeArea = area
  /** The strip at the bottom out of the picture now: district names stay above it. */
  let below = area.bottom
  /** The strip on the right out of the picture now (the legend's): district names stay left of it. */
  let beside = area.right
  /**
   * The camera sees a larger picture than the view, centred on the middle of the free area, and the
   * parts past the view's edges are cut off (viewFrame). The field of view grows with the picture, so
   * the scale stays that of a BASE_FOV camera over the view.
   */
  function lens(cam: THREE.PerspectiveCamera, a: FreeArea): void {
    const f = viewFrame(width, height, BASE_FOV, a)
    cam.fov = f.fov
    cam.aspect = f.aspect
    if (f.fullW !== width || f.fullH !== height) cam.setViewOffset(f.fullW, f.fullH, f.offX, f.offY, width, height)
    else cam.clearViewOffset()
    cam.updateProjectionMatrix()
  }
  function project(a: FreeArea): void {
    below = a.bottom
    beside = a.right
    lens(camera, a)
  }
  /** The panels, the view's size or the camera's place changed: the picture moves to the new free area (`snap`: at once, else it eases). */
  function applyView(snap = true): void {
    areaGoal = areaFor(rig.withCard())
    if (snap || reduced) area = areaGoal
    project(area)
  }
  /** The width-to-height and the vertical field of what a fit fills, at the camera's scale (`withCard`: around the open card too). */
  const fitAspect = (withCard = true): number => viewFrame(width, height, BASE_FOV, areaFor(withCard)).fitAspect
  const fitFov = (withCard = true): number => viewFrame(width, height, BASE_FOV, areaFor(withCard)).fitFov
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
  // A press only stops the turning; the hand takes the camera over once it really moves it (a plain
  // click leaves the camera, its flight and the picture as they are).
  /** Between the controls' start and end: a hand is on them (a drag), and a wheel then does nothing, as OrbitControls has it. */
  let handHeld = false
  const onControlStart = (): void => { handHeld = true; controls.autoRotate = false; rig.press() }
  const onControlChange = (): void => { rig.move() }
  const onControlEnd = (): void => { handHeld = false; rig.release() }
  controls.addEventListener('start', onControlStart)
  controls.addEventListener('change', onControlChange)
  controls.addEventListener('end', onControlEnd)
  /**
   * The wheel below a device pixel ratio of 1 (a zoomed-out page). OrbitControls divides a wheel step
   * by 100 * (devicePixelRatio | 0), which is 0 there: one notch slams the camera to its nearest or
   * furthest distance. Caught before the controls see it (capture, on the host) and done as they do
   * it at a ratio of 1: a notch of 100 moves the camera 0.95 of the way, within the distance limits.
   */
  const onWheel = (e: WheelEvent): void => {
    if ((window.devicePixelRatio | 0) !== 0 || handHeld) return // the controls are never disabled here
    e.preventDefault()
    e.stopImmediatePropagation()
    if (e.deltaY === 0) return
    const s = Math.pow(0.95, (controls.zoomSpeed * Math.abs(e.deltaY)) / 100)
    controls.dispatchEvent({ type: 'start' })
    const off = camera.position.clone().sub(controls.target)
    const d = clamp(off.length() * (e.deltaY < 0 ? s : 1 / s), controls.minDistance, controls.maxDistance)
    camera.position.copy(controls.target).addScaledVector(off.normalize(), d)
    controls.update()
    controls.dispatchEvent({ type: 'end' })
  }
  host.addEventListener('wheel', onWheel, { capture: true, passive: false })
  undo.push(() => { host.removeEventListener('wheel', onWheel, { capture: true }) })

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
  const stars = new THREE.Points(starGeo, starMat)
  stars.renderOrder = BACKDROP_ORDER // shows through the platforms
  scene.add(stars)

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
    const dust = new THREE.Points(dustGeo, dustMat)
    dust.renderOrder = BACKDROP_ORDER // shows through the platforms
    scene.add(dust)
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
  // A building drawn as one block (the tiers further out), and every batched box: a unit box, scaled.
  const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1)
  const UNIT_EDGES = new THREE.EdgesGeometry(UNIT_BOX)
  // A district's slab: a hexagonal prism standing on y = 0, turned as its platform is.
  const UNIT_HEX = new THREE.CylinderGeometry(1, 1, 1, 6).translate(0, 0.5, 0)
  const UNIT_HEX_EDGES = new THREE.EdgesGeometry(UNIT_HEX)
  const shared = new Set<THREE.BufferGeometry>([...Object.values(GEO), UNIT_BOX, UNIT_EDGES, UNIT_HEX, UNIT_HEX_EDGES])

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
  /** The hovered building or external, and its labels. */
  let hoveredId: string | null = null
  let hoverLabels: LabelRec[] = []
  /** Buildings and orbs, the most lines first (then the tallest): the order their names show in at a distance. */
  let ranked: NodeRec[] = []
  let edges = new Map<string, EdgeRec>()
  let pickables: THREE.Object3D[] = []
  // The pick's tolerance boxes (screenBoxes): see there.
  const boxes: ScreenBox[] = []
  let boxCount = 0
  let boxFrame = -1
  const boxView = new THREE.Matrix4()
  const boxViewNow = new THREE.Matrix4()
  const boxRect = [NaN, NaN, NaN, NaN]
  const corner = new THREE.Vector3()
  let frameNo = 0
  let drawCalls = 0 // the last frame's GL draw calls, every pass
  let tier: ZoomTier = 'districts'
  /** Every building's floors and block, with the batches' bookkeeping (batchFrame). */
  let parts: BatchPart[] = []
  /**
   * The districts drawn from far away (the districts tier): one slab each, in one InstancedMesh per
   * look (slabLook), whose `userData.slabIds` names each instance's district; their outlines; and
   * what each slab shows of its buildings (slabSignals).
   */
  let slabMeshes: THREE.InstancedMesh[] = []
  let slabLines: THREE.LineSegments[] = []
  let slabLooks: SlabSignals[] = []
  /** Each building's district, and each district's slab height (conduit ends at the districts tier). */
  let districtOf = new Map<string, string>()
  let slabHeight = new Map<string, number>()
  /** What a pick may hit at the districts tier: the slabs, the externals and the lines, no building. */
  let farPickables: THREE.Object3D[] = []
  /** The tier the scene is laid out for (applyTier), null when it must be laid out again. */
  let appliedTier: ZoomTier | null = null
  /** The batches must be sorted again (regroup) or only refilled in a new order (refill): batchFrame. */
  let regroup = true
  let refill = true
  let labels: LabelRec[] = []
  let ghostMats: THREE.Material[] = []
  /** Materials of buildings drawn fading: pulsed in animate, emptied with the scene. */
  let fadeMats: THREE.Material[] = []
  let seals: THREE.Mesh[] = []
  let fogSprites: THREE.Sprite[] = []
  let pulseBalls: THREE.Mesh[] = []
  let selRing: THREE.Mesh | null = null
  let lastModel: SceneModel | null = null
  let lastText: SceneText | null = null
  let allLabels = false
  let focus: RenderFocus | null = null
  /** Whether the last focus that was not a hover is on parts: it keeps the buildings drawn (heldTier), through hovers. */
  let focusHeld = false
  let selectedId: string | null = null
  let explodedId: string | null = null
  let shellCount = 0
  /** The fog density: the theme's, thinned for a big world (FOG_REACH), thicker while a building is open. */
  const fogFor = (): number => fogDensity(theme.fogDensity, overviewDist, explodedId !== null)
  /** The resting opacity of a line, lower in a busy city (more than BUSY_LINES lines). */
  let tubeOpacity = 0.38
  /** busyness() of the drawn city: 1 for a small one, lower as its lines grow past BUSY_LINES. */
  let busy = 1

  const districtRecs = new Map<string, LabelRec>()
  /** Each drawn platform's number of sides, and the district lamps (motionState). */
  const platformSides = new Map<string, number>()
  let platformLights = 0
  function addLabel(parent: THREE.Object3D, kind: LabelKind, pos: [number, number, number], build: (el: HTMLDivElement) => void): LabelRec {
    const el = document.createElement('div')
    el.className = 'lw-' + kind
    build(el)
    const o = new CSS2DObject(el)
    o.position.set(pos[0], pos[1], pos[2])
    parent.add(o)
    const rec: LabelRec = { o, kind, dim: 1, lit: false, key: `${kind}:${labels.length}` }
    labels.push(rec)
    return rec
  }

  function clearWorld(): void {
    unbatch(parts)
    parts = []
    regroup = true
    // A line's course not drawn now is in no object: freed here, with the one drawn.
    for (const e of edges.values()) for (const g of [e.tall.geo, e.tall.pickGeo, e.low.geo, e.low.pickGeo]) g.dispose()
    for (const im of slabMeshes) im.dispose()
    slabMeshes = []
    slabLines = []
    slabLooks = []
    farPickables = []
    appliedTier = null
    world.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (mesh.geometry && !shared.has(mesh.geometry)) mesh.geometry.dispose()
      if (mesh.material) ([] as THREE.Material[]).concat(mesh.material).forEach((m) => m.dispose())
      if (o instanceof CSS2DObject) o.element.remove()
    })
    world.clear()
    hoverLabels = []
    nodes = new Map(); edges = new Map(); pickables = []; boxFrame = -1; labels = []; districtRecs.clear(); ghostMats = []; fadeMats = []; seals = []; fogSprites = []; pulseBalls = []
    shellCount = 0
    selRing = null
    platformSides.clear()
    platformLights = 0
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
    plat.renderOrder = PLATFORM_ORDER // under its buildings, dimmed ones too
    g.add(plat)
    platformSides.set(d.id, pg.parameters.radialSegments)
    const rim = new THREE.LineSegments(new THREE.EdgesGeometry(pg), new THREE.LineBasicMaterial({ color: col }))
    rim.position.y = -0.6
    g.add(rim)
    // Light pooling: the district's lamp, as in the prototype, reaching the whole of a big platform.
    const light = new THREE.PointLight(col, 40, Math.max(40, d.radius * 2.4))
    light.position.set(0, 8, 0)
    g.add(light)
    platformLights++
    const [nx, nz] = turnGround(0, d.radius + 2, turned)
    districtRecs.set(d.id, addLabel(g, 'district', [nx, 0.4, nz], (el) => {
      el.style.color = hex(col.getHex())
      el.textContent = d.label
      const sub = document.createElement('span')
      sub.textContent = text.districts[d.id] ?? ''
      el.appendChild(sub)
    }))
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

  /** A building's process shell: a wireframe dome over it, captioned with the process (only buildings carry one). */
  function processShell(n: NodeRec, procId: string, text: SceneText): void {
    const pc = text.processes[procId]
    const color = pc ? pc.color : theme.text
    const shellR = Math.max(4.4, n.height * 0.62)
    const geo = new THREE.SphereGeometry(shellR, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2)
    const shell = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, wireframe: true, transparent: true, opacity: 0.22 }))
    n.group.add(shell)
    shellCount++
    addLabel(n.group, 'proc', [0, shellR + 0.6, 0], (el) => {
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
    const heat = heatMix(b.heat)
    const glowColor = col.clone().lerp(new THREE.Color(HEAT_COLOR), heat.toward) // heat 0: the district colour itself
    const captions = text.floors[b.id] ?? []
    for (let k = 0; k < b.floors; k++) {
      const geo = new THREE.BoxGeometry(FLOOR_W, fh * 0.85, FLOOR_W)
      const mat = trackBase(new THREE.MeshStandardMaterial({
        color: extras.fill, emissive: glowColor, emissiveIntensity: ghost ? 0.05 : extras.fillGlow * heat.glow, metalness: 0.5, roughness: 0.3,
        transparent: true, opacity: ghost ? 0.07 : b.look === 'fog' ? extras.fillOpacity * 0.6 : extras.fillOpacity, depthWrite: writesDepth(!ghost, 1, b.look === 'fading'),
      }))
      n.mats.push(mat)
      const mesh = new THREE.Mesh(geo, mat)
      mesh.userData.nodeId = b.id
      mesh.userData.size = [FLOOR_W, fh * 0.85, FLOOR_W]
      pickables.push(mesh)
      const fl = new THREE.Group()
      fl.add(mesh)
      const em = trackBase(new THREE.LineBasicMaterial({ color: lineColor, transparent: true, opacity: ghost ? 0.6 : 1 }))
      n.mats.push(em)
      if (ghost) ghostMats.push(em)
      const seam = new THREE.LineSegments(new THREE.EdgesGeometry(geo), em)
      fl.add(seam)
      parts.push({ mesh, line: seam, node: n, kind: 'floor', depth: 0 })
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
    if (b.outline) { // the code changed this part since the last reconcile: a proposed-colour shell, 8% larger, around the solid
      const om = trackBase(new THREE.LineBasicMaterial({ color: extras.ghost, transparent: true, opacity: 0.8 }))
      n.mats.push(om)
      ghostMats.push(om)
      const shell = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(FLOOR_W * OUTLINE_SCALE, b.height * OUTLINE_SCALE, FLOOR_W * OUTLINE_SCALE)), om)
      shell.position.y = b.height / 2
      g.add(shell)
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
    if (b.processShell !== undefined) processShell(n, b.processShell, text)
    const label = addLabel(g, 'bldg', [0, b.height + 3, 0], (el) => { el.textContent = text.labels[b.id] ?? b.id })
    n.labels.push(label)
    if (b.look === 'fading') {
      fadeMats.push(...n.mats)
      for (const m of n.mats) m.userData.fading = true // writes no depth (applyFocus)
    }
    // The whole building as one block, for the tiers further out (semantic zoom): one box and one
    // outline, no floor seams. It shares the first floor's materials (every building has a floor:
    // sceneModel), so focus, heat and change pulses reach it with them. The floors stay the pick targets.
    const block = new THREE.Mesh(UNIT_BOX, n.mats[0])
    block.scale.set(FLOOR_W, Math.max(0.01, b.height - fh * 0.15), FLOOR_W)
    block.position.y = b.height / 2
    block.userData.size = [1, 1, 1]
    block.visible = false
    const outline = new THREE.LineSegments(UNIT_EDGES, n.mats[1])
    outline.scale.copy(block.scale)
    outline.position.copy(block.position)
    outline.visible = false
    g.add(block, outline)
    parts.push({ mesh: block, line: outline, node: n, kind: 'block', depth: 0 })
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

  /**
   * A line's course with its ends `hf` and `ht` above their ground: on the roofs, or on the district
   * slabs (the districts tier). Its drawn geometry (a tube, or a dashed line's points) and its fat
   * invisible pick tube go with it.
   */
  function edgeShape(c: SceneConduit, hf: number, ht: number): EdgeShape {
    const a = vec(c.from).setY(c.from[1] + hf)
    const b = vec(c.to).setY(c.to[1] + ht)
    const ctrl = vec(c.ctrl).setY(c.ctrl[1] + (hf + ht) / 2)
    const curve = new THREE.QuadraticBezierCurve3(a, ctrl, b)
    const geo = c.dashed
      ? new THREE.BufferGeometry().setFromPoints(curve.getPoints(90))
      : new THREE.TubeGeometry(curve, 64, c.width * 0.55 * Math.min(scale, MAX_LINE_SCALE), 6)
    const label = curve.getPoint(0.5)
    label.y += 0.8
    return { curve, path: curve.getPoints(48), geo, pickGeo: new THREE.TubeGeometry(curve, 24, 0.8 * scale, 5), label }
  }

  function buildConduit(c: SceneConduit, heightAt: Map<string, number>, idAt: Map<string, string>, text: SceneText): void {
    const hf = heightAt.get(posKey(c.from)) ?? 0
    const ht = heightAt.get(posKey(c.to)) ?? 0
    const tall = edgeShape(c, hf, ht)
    const low = edgeShape(c, endHeight(idAt.get(posKey(c.from)), hf, 'districts', districtOf, slabHeight), endHeight(idAt.get(posKey(c.to)), ht, 'districts', districtOf, slabHeight))
    const curve = tall.curve
    const col = new THREE.Color(c.color)
    const rec: EdgeRec = { id: c.id, curve, tubeMats: [], packetMats: [], packets: [], pick: null as unknown as THREE.Mesh, label: null as unknown as CSS2DObject, focus: false, chars: 0, path: tall.path, reach: 0, drawn: null as unknown as THREE.Mesh, tall, low }
    if (!c.dashed) {
      const m = trackBase(new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: tubeOpacity }))
      rec.tubeMats.push(m)
      rec.drawn = new THREE.Mesh(tall.geo, m)
      rec.reach = c.width * 0.55 * Math.min(scale, MAX_LINE_SCALE)
    } else {
      const m = trackBase(new THREE.LineDashedMaterial({ color: extras.ghost, dashSize: 1, gapSize: 0.7, transparent: true, opacity: 0.85 }))
      rec.tubeMats.push(m)
      ghostMats.push(m)
      const line = new THREE.Line(low.geo, m)
      line.computeLineDistances() // each course gets its own dash lengths
      line.geometry = tall.geo
      line.computeLineDistances()
      rec.drawn = line
    }
    // After every batch of boxes (LINE_ORDER): a building behind a line is drawn before it and never
    // cut by it (the batches all sort at one point, so a line sorted among them could come first).
    rec.drawn.renderOrder = LINE_ORDER
    world.add(rec.drawn)
    // Fat invisible tube: a thin line is impossible to click. It does not hide a building behind it
    // (pick): there, only the drawn line itself takes the click.
    rec.reach = Math.max(rec.reach * LINE_REACH, MIN_LINE_REACH)
    const pick = new THREE.Mesh(tall.pickGeo, new THREE.MeshBasicMaterial({ visible: false }))
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
    const el = document.createElement('div')
    el.className = 'lw-edge'
    const words = text.edges[c.id] ?? c.id
    el.textContent = words
    const lc = hex(c.dashed ? extras.ghost : col.getHex())
    el.style.borderColor = lc
    el.style.color = lc
    el.addEventListener('click', (ev) => { ev.stopPropagation(); opts.onEdgeLabel?.(c.id) })
    const lo = new CSS2DObject(el)
    lo.position.copy(tall.label)
    // Shown only for the lit lines (animate). Hidden through the object, never the element's
    // display: CSS2DRenderer rewrites style.display on every render, so a display set by hand is lost.
    lo.visible = false
    world.add(lo)
    rec.label = lo
    rec.chars = words.length
    edges.set(c.id, rec)
  }

  /** Whether the overview looks from the portrait direction, and whether it turns the city a quarter (overviewDir). */
  let portrait = false
  let turned = false
  /**
   * The overview frames the whole city: every platform's rim, every building to the top of its name
   * and every external, fitted with OVERVIEW_MARGIN to spare into the part of the picture the legend
   * and the ask bar leave free. It looks from OVERVIEW_DIR in a landscape fit area; in a portrait one,
   * more steeply down, the city turned so its long side runs up the picture (overviewDir). Done again
   * when the view is resized.
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
    }
    const view = overviewDir(fitAspect(false), pts.map((p) => [p[0], p[2]] as const), portrait)
    portrait = view.portrait
    if (view.turned !== turned) {
      turned = view.turned
      // Each district's name sits on the camera's side of its platform.
      for (const d of model.districts) {
        const [nx, nz] = turnGround(0, d.radius + 2, turned)
        districtRecs.get(d.id)?.o.position.set(nx, 0.4, nz)
      }
    }
    const dir = view.dir
    const nameAt = (d: SceneDistrict): [number, number] => {
      const [ox, oz] = turnGround(0, d.radius + 4, turned)
      return [d.pos[0] + ox, d.pos[2] + oz]
    }
    for (const d of model.districts) {
      const [x, z] = nameAt(d)
      pts.push([x, d.pos[1] - 2, z]) // the district's name below its rim
    }
    let fit = fitView(pts, dir, fitFov(false), fitAspect(false), OVERVIEW_MARGIN, 40)
    // A district's name is its measured half width (DISTRICT_NAME_HALF_PX before it is measured) on
    // each side of its point, whatever the distance: at the fitted distance that is so many world
    // units, so the fit is done again with the name's ends in it (twice: the wider fit makes the name
    // a little wider in the world).
    const side = new THREE.Vector3(dir[2], 0, -dir[0]).normalize()
    for (let pass = 0; pass < 2 && model.districts.length > 0; pass++) {
      const perPx = (2 * fit.dist * Math.tan(THREE.MathUtils.degToRad(BASE_FOV / 2))) / height
      const named = [...pts]
      for (const d of model.districts) {
        const half = districtHalfPx(d.id) * perPx
        const drop = districtDropPx(d.id) * perPx
        const [x, z] = nameAt(d)
        for (const k of [-1, 1]) named.push([x + side.x * half * k, d.pos[1] - 2 - drop, z + side.z * half * k])
      }
      fit = fitView(named, dir, fitFov(false), fitAspect(false), OVERVIEW_MARGIN, 40)
    }
    overviewDist = fit.dist
    overviewTarget.set(fit.target[0], fit.target[1], fit.target[2])
    overviewPos.set(overviewTarget.x + dir[0] * overviewDist, overviewTarget.y + dir[1] * overviewDist, overviewTarget.z + dir[2] * overviewDist)
    // Room to step back from the overview of even a very big world.
    controls.maxDistance = Math.max(420, overviewDist * 1.6)
  }

  /** A district name's own half width (measured; the constant when it cannot be) and the height under its point. */
  function districtLabel(id: string): { w: number; h: number } | undefined {
    const rec = districtRecs.get(id)
    if (!rec) return undefined
    measure([rec.o.element])
    return sizes.get(rec.o.element)
  }
  const districtHalfPx = (id: string): number => districtNameHalf(districtLabel(id)?.w ?? 0, DISTRICT_NAME_HALF_PX)
  const districtDropPx = (id: string): number => (districtLabel(id)?.h ?? 0) / 2

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
    grid.renderOrder = BACKDROP_ORDER // shows through the platforms above it
    scene.add(grid)

    for (const d of model.districts) buildDistrict(d, text)
    // Again, now the district names are in the page: the fit keeps their measured widths clear.
    fitOverview(model)
    for (const b of model.buildings) buildBuilding(b, hueColor(hueAt(model, b.pos)), text)
    for (const o of model.orbs) buildOrb(o, text)
    districtOf = districtsOf(model.buildings, model.districts)
    buildSlabs(slabsFor(model.districts, model.buildings), model, districtOf)
    const heightAt = new Map<string, number>()
    const idAt = new Map<string, string>()
    for (const b of model.buildings) { heightAt.set(posKey(b.pos), b.height); idAt.set(posKey(b.pos), b.id) }
    for (const o of model.orbs) heightAt.set(posKey(o.pos), ORB_R * 2)
    for (const c of model.conduits) buildConduit(c, heightAt, idAt, text)
    // At the districts tier a pick sees the slabs, not the buildings hidden under them: only the orbs and
    // the buildings on no district (ownTier) stand on their own.
    farPickables = pickables.filter((o) => {
      const id = o.userData.nodeId
      return typeof id !== 'string' || nodes.get(id)?.orb === true || !districtOf.has(id)
    })
    farPickables.push(...slabMeshes)
    const lines = (n: NodeRec): number => text.importance[n.id] ?? 0
    ranked = [...nodes.values()].sort((a, b) => lines(b) - lines(a) || b.height - a.height || (a.id < b.id ? -1 : 1))
    placed = new Map()

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
    applyTier()
  }

  /**
   * The districts from far away (spec: "districts from far away"): one slab per district, standing on
   * its platform as tall as its buildings are on average (slabsFor), with the district's glow, and its
   * outline in the district's colour, with a seam at every floor. Its buildings hide under it, so it
   * shows what they would (slabSignals): its hottest building's heat in its glow, a proposed-colour
   * outline round it when any of them is planned or changed, and the fog or fading look when all of
   * them have it (a fading slab, like a fading building, writes no depth). One draw call per look for
   * the slabs and one per look for their outlines; drawn at the districts tier only (applyTier).
   */
  function buildSlabs(slabs: Slab[], model: SceneModel, of: ReadonlyMap<string, string>): void {
    slabHeight = new Map(slabs.map((sl) => [sl.id, sl.height]))
    slabLooks = slabSignals(slabs.map((sl) => sl.id), model.buildings, of)
    const hue = new Map(model.districts.map((d) => [d.id, d.hue]))
    const byLook = new Map<SlabLook, number[]>()
    slabLooks.forEach((sg, i) => {
      const k = slabLook(sg)
      byLook.set(k, [...(byLook.get(k) ?? []), i])
    })
    const rim = UNIT_HEX_EDGES.attributes.position as THREE.BufferAttribute
    const heatColor = new THREE.Color(HEAT_COLOR)
    for (const [look, idx] of byLook) {
      const fading = look === 'fading'
      const m = trackBase(new THREE.MeshStandardMaterial({
        color: extras.fill, emissive: 0xffffff, emissiveIntensity: 1, metalness: 0.5, roughness: 0.3, transparent: true,
        opacity: look === 'fog' ? extras.fillOpacity * 0.6 : extras.fillOpacity, depthWrite: writesDepth(true, 1, fading),
      }))
      m.onBeforeCompile = (sh) => {
        sh.fragmentShader = sh.fragmentShader.replace('#include <color_fragment>', '').replace('#include <emissivemap_fragment>', EMISSIVE_TINT)
      }
      m.customProgramCacheKey = () => 'lw-slab'
      const im = new THREE.InstancedMesh(UNIT_HEX, m, idx.length)
      im.userData.slabIds = idx.map((i) => slabs[i].id)
      // The outline, and a seam round the slab at every floor (slabSeams): six segments each.
      const seams = idx.map((i) => slabSeams(slabs[i].height))
      const count = idx.reduce((n, _, j) => n + rim.count + seams[j].length * 12, 0)
      const pos = new Float32Array(count * 3)
      const cols = new Float32Array(pos.length)
      let o = 0
      idx.forEach((i, j) => {
        const sl = slabs[i]
        bm.compose(bv.set(sl.x, sl.y, sl.z), bq, bsc.set(sl.radius, sl.height, sl.radius))
        im.setMatrixAt(j, bm)
        const col = hueColor(hue.get(sl.id) as number) // a slab is a district's (slabsFor): it has a hue
        // The glow a building of this district would have at the slab's heat (buildBuilding's).
        const heat = heatMix(slabLooks[i].heat)
        im.setColorAt(j, bc.copy(col).lerp(heatColor, heat.toward).multiplyScalar(extras.fillGlow * heat.glow))
        // A fogged district's outline washes toward the fog tint, as a fogged building's does.
        const line = look === 'fog' ? col.clone().lerp(new THREE.Color(extras.fogTint), 0.4) : col
        const put = (x: number, y: number, z: number): void => {
          pos[o] = x; pos[o + 1] = y; pos[o + 2] = z
          cols[o] = line.r; cols[o + 1] = line.g; cols[o + 2] = line.b
          o += 3
        }
        for (let k = 0; k < rim.count; k++) {
          bv.fromBufferAttribute(rim, k).applyMatrix4(bm)
          put(bv.x, bv.y, bv.z)
        }
        // The hexagon's corners as CylinderGeometry lays them (x = sin, z = cos of the angle).
        for (const h of seams[j]) {
          for (let k = 0; k < 6; k++) {
            for (const c of [k, k + 1]) {
              const a = (c / 6) * Math.PI * 2
              put(sl.x + Math.sin(a) * sl.radius, sl.y + h, sl.z + Math.cos(a) * sl.radius)
            }
          }
        }
      })
      im.computeBoundingSphere()
      // On the platforms (drawn before it) and under the lines (LINE_ORDER, after it).
      im.renderOrder = LINE_ORDER / 2
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
      g.setAttribute('color', new THREE.BufferAttribute(cols, 3))
      const lm = trackBase(new THREE.LineBasicMaterial({ vertexColors: true, transparent: fading, depthWrite: !fading }))
      const lines = new THREE.LineSegments(g, lm)
      lines.renderOrder = LINE_ORDER / 2
      if (fading) fadeMats.push(m, lm) // pulses out with the buildings it stands for
      slabMeshes.push(im)
      slabLines.push(lines)
    }
    // A planned or changed part under a slab: the proposed-colour outline its buildings wear, round the slab.
    const ringed = slabs.filter((_, i) => slabLooks[i].outline)
    if (ringed.length > 0) {
      const pos = new Float32Array(ringed.length * rim.count * 3)
      let o = 0
      for (const sl of ringed) {
        bm.compose(bv.set(sl.x, sl.y, sl.z), bq, bsc.set(sl.radius * OUTLINE_SCALE, sl.height * OUTLINE_SCALE, sl.radius * OUTLINE_SCALE))
        for (let k = 0; k < rim.count; k++, o += 3) bv.fromBufferAttribute(rim, k).applyMatrix4(bm).toArray(pos, o)
      }
      const om = trackBase(new THREE.LineBasicMaterial({ color: extras.ghost, transparent: true, opacity: 0.8 }))
      ghostMats.push(om) // pulses as a building's outline does
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
      const shell = new THREE.LineSegments(g, om)
      shell.renderOrder = LINE_ORDER / 2
      slabLines.push(shell)
    }
    for (const o of [...slabMeshes, ...slabLines]) {
      o.visible = false
      world.add(o)
    }
  }

  /**
   * Lays the scene out for the camera's tier (semantic zoom), when it changes. At the districts tier
   * the buildings hide under their districts' slabs and every line runs from slab top to slab top,
   * over each end building's place; nearer in the buildings stand and the lines run roof to roof.
   */
  /**
   * The tier for the camera's distance (zoomTierAt), held at the buildings while parts are asked for
   * (heldTier), and drawn. Run every frame, and at once when a focus or selection changes: a click
   * right after a focus (before the next frame) must pick what that focus draws.
   */
  function retier(): void {
    const asked = focusHeld || (selectedId !== null && (nodes.has(selectedId) || edges.has(selectedId)))
    tier = heldTier(zoomTierAt(camera.position.distanceTo(controls.target) / overviewDist), asked)
    applyTier()
  }
  function applyTier(): void {
    if (tier === appliedTier) return
    appliedTier = tier
    const far = tier === 'districts'
    for (const n of nodes.values()) {
      if (n.orb) continue
      n.group.visible = ownTier(n.id, tier, districtOf) !== 'districts'
    }
    for (const o of [...slabMeshes, ...slabLines]) o.visible = far
    for (const e of edges.values()) {
      const sh = far ? e.low : e.tall
      e.curve = sh.curve
      e.path = sh.path
      e.drawn.geometry = sh.geo
      e.pick.geometry = sh.pickGeo
      e.label.position.copy(sh.label)
      for (const pk of e.packets) pk.s.position.copy(sh.curve.getPoint(pk.t))
    }
    placeRing()
    boxFrame = -1 // the buildings' screen boxes
    regroup = true
  }

  function applyFocus(): void {
    const f = focus
    const passive = f?.passive
    for (const n of nodes.values()) {
      const on = !f || f.ids.has(n.id)
      const k = on ? 1 : 0.12
      for (const m of n.mats) {
        m.userData.f = k
        if (!ghostMats.includes(m)) m.opacity = m.userData.base * k
        m.depthWrite = writesDepth(m.userData.depth !== false, k, m.userData.fading === true)
      }
      for (const l of n.labels) { l.dim = on ? 1 : 0.2; l.lit = !!f && on }
    }
    for (const e of edges.values()) {
      const on = !f || f.edgeIds.has(e.id)
      e.focus = !!f && on
      // A hovered building's labels gather over it: they must not catch the click meant for it.
      e.label.element.style.pointerEvents = e.focus && passive?.has(e.id) ? 'none' : ''
      for (const m of e.tubeMats) {
        const base = m.userData.base as number
        const o = f ? focusOpacity(base, on) : base
        m.userData.f = o / base // a line's base is never 0 (MIN_TUBE_OPACITY, a dashed line's 0.85)
        if (!ghostMats.includes(m)) m.opacity = o
        m.depthWrite = writesDepth(m.userData.depth !== false, f && !on ? 0 : 1, false)
      }
      for (const m of e.packetMats) {
        const base = m.userData.base as number
        m.opacity = f ? (on ? Math.min(1, base * 1.9) : base * 0.06) : base
      }
    }
    regroup = true // the opacities the batches are keyed by
  }

  function placeRing(): void {
    if (!selRing) return
    const n = selectedId === null ? undefined : nodes.get(selectedId)
    // A building hidden under its district's slab (the districts tier) shows no ring.
    selRing.visible = !!n && (n.orb || tier !== 'districts')
    if (n) {
      selRing.position.copy(n.group.position)
      selRing.position.y += n.orb ? -0.2 : 0.15
    }
  }

  // ---------------- camera ----------------
  /** Where a framing puts the camera, and what it looks at. */
  interface Shot { pos: THREE.Vector3; target: THREE.Vector3 }
  /** The side a framing looks from, across the ground: that of `from`, the camera's offset from its target. */
  function sideOf(from: THREE.Vector3): THREE.Vector3 {
    const h = from.clone().setY(0)
    if (h.lengthSq() < 1e-12) return h.set(0, 0, 1)
    return h.normalize()
  }
  function shotAt(target: THREE.Vector3, dist: number, from: THREE.Vector3): Shot {
    const pos = target.clone().addScaledVector(sideOf(from), dist)
    pos.y = target.y + dist * 0.5
    return { pos, target }
  }
  function nodeTarget(n: NodeRec): THREE.Vector3 {
    const t = n.anchor.clone()
    t.y -= n.height * 0.45
    return t
  }

  /** Where `ids` are framed from the side of `from` (the camera's offset from its target when asked). */
  function shotFor(ids: string[], around: string[] | undefined, from: THREE.Vector3): Shot | null {
    const pts: THREE.Vector3[] = []
    let single: NodeRec | EdgeRec | null = null
    for (const id of ids) {
      const n = nodes.get(id)
      const e = edges.get(id)
      if (n) { pts.push(nodeTarget(n)); single = n } else if (e) { pts.push(e.curve.getPoint(0.5)); single = e }
    }
    if (pts.length === 0) return null
    if (pts.length === 1 && single) {
      if ('curve' in single) return lineShot(single, from)
      if (single.exploded) return shotAt(pts[0], 22 + single.floors.length * 2.5, from)
      return shotWith(single, pts[0], around ?? [], from)
    }
    const c = pts.reduce((s, p) => s.add(p), new THREE.Vector3()).divideScalar(pts.length)
    const spread = Math.max(...pts.map((p) => p.distanceTo(c)))
    return shotAt(c, Math.max(30, spread * 2.2), from)
  }
  function frame(ids: string[], instant: boolean, around?: string[]): Promise<void> {
    const from = camera.position.clone().sub(controls.target)
    controls.autoRotate = false // a flight ends the idle turn
    return rig.frame({ ids: [...ids], around, from }, instant)
  }
  /** A panel opened, closed or changed size: the picture eases to the new free area and the camera follows. */
  function reframe(): void {
    applyView(false)
    if (!lastModel) return
    fitOverview(lastModel)
    fogTarget = fogFor()
    rig.refit()
  }

  /**
   * One building with its neighbours in view: looking at the building from the current side, as
   * close as the neighbours allow (never closer than the prototype's framing, never further than
   * most of the overview: a neighbour across a big city stays lit by the focus, if out of the picture).
   */
  function shotWith(n: NodeRec, target: THREE.Vector3, around: string[], from: THREE.Vector3): Shot {
    const h = sideOf(from)
    const dir = new THREE.Vector3(h.x, 0.5, h.z).normalize()
    const pts: V3[] = []
    for (const id of [n.id, ...around]) {
      const m = nodes.get(id)
      if (!m) continue
      const base = m.group.position
      pts.push([base.x, base.y, base.z], [m.anchor.x, m.anchor.y + 3, m.anchor.z])
    }
    const t: V3 = [target.x, target.y, target.z]
    const fit = fitDistance(pts, t, [dir.x, dir.y, dir.z], fitFov(), fitAspect(), CLOSE_UP_MARGIN, CLOSE_UP_MIN)
    const dist = clamp(fit, CLOSE_UP_MIN, overviewDist * 0.7)
    return { pos: target.clone().addScaledVector(dir, dist), target }
  }

  /** The building or orb standing at a line's end: the nearest one across the ground, if any is that near. */
  function nodeAt(p: THREE.Vector3): NodeRec | null {
    let best: NodeRec | null = null
    let bestD = FLOOR_W * 1.5
    for (const n of nodes.values()) {
      const d = Math.hypot(n.group.position.x - p.x, n.group.position.z - p.z)
      if (d < bestD) { best = n; bestD = d }
    }
    return best
  }

  /** Whether a camera at `p` would stand inside a building or an orb (or just above its roof). */
  function insideAny(p: THREE.Vector3): boolean {
    for (const n of nodes.values()) {
      const g = n.group.position
      const reach = n.orb ? ORB_R + 1.5 : FLOOR_W + 1.5
      if (Math.hypot(g.x - p.x, g.z - p.z) < reach && p.y < g.y + n.height + 3) return true
    }
    return false
  }

  /**
   * Whether a camera at `eye` looking at `target` stands well clear of every building, orb and
   * other line (`skip` is the line being looked at): the nearest one is at least LINE_CLEAR of the
   * way to the target. A camera skimming the roofs of a busy district passes `insideAny` yet shows
   * nothing but the walls next to it, or the underside of the lines passing just over it.
   */
  function clearOf(eye: THREE.Vector3, target: THREE.Vector3, skip: EdgeRec): boolean {
    const need = eye.distanceTo(target) * LINE_CLEAR
    for (const e of edges.values()) {
      if (e !== skip && e.path.some((p) => p.distanceTo(eye) < need)) return false
    }
    for (const n of nodes.values()) {
      const g = n.group.position
      const r = n.orb ? ORB_R : FLOOR_W * 0.5
      const out = Math.max(0, Math.hypot(g.x - eye.x, g.z - eye.z) - r)
      const up = Math.max(0, g.y - eye.y, eye.y - (g.y + n.height))
      if (Math.hypot(out, up) < need) return false
    }
    return true
  }

  /** A camera for trying a framing before the camera flies there: the view's picture with the card open. */
  const scout = new THREE.PerspectiveCamera(BASE_FOV, 1, camera.near, camera.far)
  const scoutPt = new THREE.Vector3()
  /** The click tests left for the line being framed (LINE_RAY_BUDGET); the first, nearer looks spend none of it. */
  const rays = { left: Infinity }
  /**
   * How many of `ends` show nowhere from `eye` looking at `target`, with the card open. An end shows
   * where one of its probe points (probePoints) lies END_INSET_PX or more inside the part of the
   * view the panels leave free, and a click there picks that end (rayHit), not a tower or a line in
   * front of it: the promise of a line's close-up, both ends in view beside the card.
   */
  function endsHidden(ends: NodeRec[], eye: THREE.Vector3, target: THREE.Vector3): number {
    const a = areaFor(true)
    lens(scout, a)
    scout.position.copy(eye)
    scout.up.copy(camera.up)
    scout.lookAt(target)
    scout.updateMatrixWorld()
    // Where each end falls in the free area first (cheap), then the clicks there (rays).
    const spots = ends.map((m) => probePoints(m).flatMap((p) => {
      scoutPt.copy(p).project(scout)
      return Math.abs(scoutPt.z) <= 1 && inFreeArea(scoutPt.x, scoutPt.y, width, height, a, END_INSET_PX) ? [[scoutPt.x, scoutPt.y] as const] : []
    }))
    let hidden = spots.filter((sp) => sp.length === 0).length
    if (hidden > 0) return hidden
    ends.forEach((m, k) => {
      const shows = spots[k].some(([x, y]) => {
        rays.left--
        const hit = rayHit(scout, x, y)
        return !!hit && hit.kind === 'node' && hit.id === m.id
      })
      if (!shows) hidden++
    })
    return hidden
  }

  /** Whether nothing stands between `eye` and `p`: no building or orb crosses the sight line. */
  function inSight(eye: THREE.Vector3, p: THREE.Vector3): boolean {
    const steps = Math.max(8, Math.ceil(eye.distanceTo(p) / (FLOOR_W * 0.4)))
    const q = new THREE.Vector3()
    for (let i = 1; i < steps; i++) {
      q.lerpVectors(eye, p, i / steps)
      for (const n of nodes.values()) {
        const g = n.group.position
        const r = n.orb ? ORB_R : FLOOR_W * 0.5
        if (Math.hypot(g.x - q.x, g.z - q.z) < r && q.y > g.y - 0.5 && q.y < g.y + n.height) return false
      }
    }
    return true
  }

  /**
   * A line from outside: looking across it from the side the camera is on, a little from above,
   * far enough out that the whole arch and both end buildings (their upper part, to the name) are in the picture,
   * never closer than the prototype's framing, and never from inside a building (the camera steps
   * back until it is clear of them all). Between buildings in a busy district the near towers can
   * hide the arch or its ends, so the camera steps back (LINE_BACKS) and climbs (LINE_LIFTS, up to
   * nearly overhead) until the middle of the line and both end buildings are in clear sight, from
   * a spot well clear of every roof, with a click on each end picking it beside the card (endsHidden).
   * A long line across the city, or ends buried in towers, gets a wider look (LINE_TURNS,
   * LINE_WIDE_LIFTS, backing off up to the controls' reach) until both ends show, else the view
   * that shows the most of them. When nothing shows an end, the camera looks down from high above,
   * backing off until it is clear of the roofs around it.
   */
  function lineShot(e: EdgeRec, from: THREE.Vector3): Shot {
    scene.updateMatrixWorld()
    rays.left = Infinity
    // The arch, and each end building's upper part up to its name: in a tall, busy district the
    // whole towers would fill the picture and squeeze the line itself to a sliver at the top.
    const pts: V3[] = e.path.map((p) => [p.x, p.y, p.z])
    for (const end of [e.curve.v0, e.curve.v2]) {
      const m = nodeAt(end)
      if (!m) continue
      pts.push([m.anchor.x, m.anchor.y - m.height * 0.4, m.anchor.z], [m.anchor.x, m.anchor.y + 3, m.anchor.z])
    }
    const h = sideOf(from)
    const along = e.curve.v2.clone().sub(e.curve.v0).setY(0)
    if (along.lengthSq() > 1e-6) {
      // Across the line, on the camera's side of it.
      const side = new THREE.Vector3(along.z, 0, -along.x).normalize()
      h.copy(side.dot(h) < 0 ? side.negate() : side)
    }
    // What must be in clear sight from `eye`: the middle of the arch, and each end building's face
    // toward the camera at 60% of its height (an orb: its top), so the ends are seen, not peeked at.
    const mids = [0.3, 0.5, 0.7].map((t) => e.curve.getPoint(t))
    const ends = [e.curve.v0, e.curve.v2].map((end) => nodeAt(end)).filter((m): m is NodeRec => !!m)
    const seen = (eye: THREE.Vector3): THREE.Vector3[] => [...mids, ...ends.map((m) => {
      if (m.orb) return m.anchor.clone().setY(m.anchor.y + 0.5)
      const c = m.group.position
      const toward = eye.clone().sub(c).setY(0).normalize() // (a zero vector stays zero)
      return c.clone().addScaledVector(toward, FLOOR_W * 0.5 + 0.3).setY(c.y + m.height * 0.6)
    })]
    // From the camera's side of the line first, then from the other side, before climbing out of
    // reach: towers that hide the line from one side seldom hide it from both.
    for (const across of along.lengthSq() > 1e-6 ? [h, h.clone().negate()] : [h]) {
      for (const lift of LINE_LIFTS) {
        const dir = new THREE.Vector3(across.x, lift, across.z).normalize()
        const fit = fitView(pts, [dir.x, dir.y, dir.z], fitFov(), fitAspect(), CLOSE_UP_MARGIN, CLOSE_UP_MIN)
        const target = new THREE.Vector3(fit.target[0], fit.target[1], fit.target[2])
        const far = Math.max(fit.dist, overviewDist * 0.7)
        let dist = fit.dist
        while (dist < far && insideAny(target.clone().addScaledVector(dir, dist))) dist *= 1.15
        // Step back a little (never past `far`) before climbing: a few metres more often clears the towers.
        for (const back of LINE_BACKS) {
          const eye = target.clone().addScaledVector(dir, Math.min(dist * back, far))
          if (!insideAny(eye) && clearOf(eye, target, e) && seen(eye).every((p) => inSight(eye, p)) && endsHidden(ends, eye, target) === 0) return { pos: eye, target }
        }
      }
    }
    // A long line, or ends buried under the lines and towers around them: from more sides, lower
    // and higher, and as far out as it takes for both ends to show beside the card (and the arch's
    // middle in sight). Failing that, the view that shows the most of them, never one that hides
    // them all: then the overhead view below.
    // The best view so far, by how many ends it hides (0.5: none, but the arch's middle is out of sight).
    let bestShot: Shot | null = null
    let bestScore = Infinity
    rays.left = LINE_RAY_BUDGET
    wide: for (const [x, z] of turnAcross([h.x, h.z], LINE_TURNS)) {
      for (const lift of LINE_WIDE_LIFTS) {
        const dir = new THREE.Vector3(x, lift, z).normalize()
        const fit = fitView(pts, [dir.x, dir.y, dir.z], fitFov(), fitAspect(), CLOSE_UP_MARGIN, CLOSE_UP_MIN)
        const target = new THREE.Vector3(fit.target[0], fit.target[1], fit.target[2])
        for (const dist of backOffs(fit.dist, controls.maxDistance, LINE_BACK_STEP)) {
          const eye = target.clone().addScaledVector(dir, dist)
          // Clear of every roof, as in the near search: an eye grazing a roof whites the picture out.
          if (insideAny(eye) || !clearOf(eye, target, e)) continue
          const hidden = endsHidden(ends, eye, target)
          const midSeen = hidden === 0 && mids.some((p) => inSight(eye, p))
          if (midSeen) return { pos: eye, target }
          const score = hidden === 0 ? 0.5 : hidden
          if (score < bestScore) { bestShot = { pos: eye, target }; bestScore = score }
          if (rays.left <= 0) break wide
        }
      }
    }
    if (bestScore < ends.length) return bestShot as Shot // a finite score was set with its shot
    // Nothing shows an end: from high above, as far back as it takes to clear the roofs.
    const dir = new THREE.Vector3(h.x, LINE_LIFTS[2], h.z).normalize()
    const fit = fitView(pts, [dir.x, dir.y, dir.z], fitFov(), fitAspect(), CLOSE_UP_MARGIN, CLOSE_UP_MIN)
    const target = new THREE.Vector3(fit.target[0], fit.target[1], fit.target[2])
    const far = Math.max(fit.dist, overviewDist * 0.7)
    let dist = fit.dist
    while (dist < far && !clearOf(target.clone().addScaledVector(dir, dist), target, e)) dist *= 1.15
    return { pos: target.clone().addScaledVector(dir, Math.min(dist, far)), target }
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
      const color = (e.packetMats[0] as THREE.MeshBasicMaterial).color.clone() // every line carries packets (buildConduit)
      await new Promise<void>((resolve) => { pulseAnim = { curve: e.curve, t: 0, color, done: resolve } })
    }
  }

  // ---------------- picking ----------------
  const ray = new THREE.Raycaster()
  const mouse = new THREE.Vector2()
  /**
   * What a click or hover at this point picks: what the ray hits (rayPick), or else a building or orb
   * within PICK_TOLERANCE_PX of it on screen (toleratedPick), so a building a few pixels across in a
   * big world's overview still takes a click a pixel or two beside it. The probe's pickAt is this.
   */
  function pick(clientX: number, clientY: number): RenderPick | null {
    const r = renderer.domElement.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) return null
    // At the districts tier the ray sees the slabs, and a building (a tolerated pick, a line's end)
    // stands for its district: a hover or click there is the district's.
    const far = tier === 'districts'
    const hit = toleratedPick(rayPick(clientX, clientY, r, far ? farPickables : pickables), () => ({ boxes: screenBoxes(r), count: boxCount }), clientX, clientY)
    return tierPick(hit, tier, districtOf) as RenderPick | null
  }
  function rayPick(clientX: number, clientY: number, r: DOMRect, objs: THREE.Object3D[]): RenderPick | null {
    scene.updateMatrixWorld()
    camera.updateMatrixWorld()
    return rayHit(camera, ((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1, objs)
  }
  /**
   * What a ray from `cam` through the view point (ndcX, ndcY) picks (rayPick, for any camera: a
   * framing is tried before the flight). The scene's matrices must be current.
   */
  function rayHit(cam: THREE.Camera, ndcX: number, ndcY: number, objs: THREE.Object3D[] = pickables): RenderPick | null {
    mouse.set(ndcX, ndcY)
    ray.setFromCamera(mouse, cam)
    // Hits come nearest first. The nearest one wins, except that a node just behind an edge's
    // fat pick tube (within PICK_NODE_EPS) still wins: a conduit runs into the building it ends
    // at, and its tube must not swallow clicks on that building's face.
    const hits = ray.intersectObjects(objs, false)
    const node = hits.find((h) => typeof h.object.userData.nodeId === 'string' || Array.isArray(h.object.userData.slabIds))
    // In front of a building, only a line the ray really touches counts (LINE_REACH).
    const edge = hits.find((h) => {
      if (typeof h.object.userData.edgeId !== 'string') return false
      if (!node || node.distance <= h.distance) return true
      return touches(edges.get(h.object.userData.edgeId as string) as EdgeRec) // a pick tube is always its line's (both are rebuilt together)
    })
    if (node && (!edge || node.distance <= edge.distance + PICK_NODE_EPS)) {
      const ids = node.object.userData.slabIds as string[] | undefined
      return ids ? { kind: 'district', id: ids[node.instanceId as number] } : { kind: 'node', id: node.object.userData.nodeId as string }
    }
    if (!edge) return null
    const id = edge.object.userData.edgeId as string
    const rec = edges.get(id) as EdgeRec
    const at = world.worldToLocal(edge.point.clone())
    const snap = Math.min(LINE_END_SNAP, rec.curve.v0.distanceTo(rec.curve.v2) * 0.2)
    for (const end of [rec.curve.v0, rec.curve.v2]) {
      const m = at.distanceTo(end) < snap ? nodeAt(end) : null
      if (m) return { kind: 'node', id: m.id }
    }
    return { kind: 'edge', id }
  }

  // Every building's and orb's projected bounding box, for the pick's tolerance. Kept between picks
  // (hover picks once a frame, the probe many times at once) and worked out again only when a frame
  // has been drawn since (the camera, a floor or a rise may have moved) or the view or canvas changed.
  // The boxes and scratch vectors are reused: no allocation per pick.
  function screenBoxes(r: DOMRect): ScreenBox[] {
    boxViewNow.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
    if (boxFrame === frameNo && boxView.equals(boxViewNow) && boxRect[0] === r.left && boxRect[1] === r.top && boxRect[2] === r.width && boxRect[3] === r.height) return boxes
    boxFrame = frameNo
    boxView.copy(boxViewNow)
    boxRect[0] = r.left; boxRect[1] = r.top; boxRect[2] = r.width; boxRect[3] = r.height
    boxCount = 0
    for (const o of pickables) {
      const id = o.userData.nodeId
      if (typeof id !== 'string') continue
      const geo = (o as THREE.Mesh).geometry
      if (!geo.boundingBox) geo.computeBoundingBox()
      const bb = geo.boundingBox as THREE.Box3
      let l = Infinity, t = Infinity, rr = -Infinity, b = -Infinity
      let behind = false
      for (let k = 0; k < 8 && !behind; k++) {
        corner.set(k & 1 ? bb.max.x : bb.min.x, k & 2 ? bb.max.y : bb.min.y, k & 4 ? bb.max.z : bb.min.z).applyMatrix4(o.matrixWorld).project(camera)
        if (corner.z < -1 || corner.z > 1) { behind = true; break }
        const x = r.left + ((corner.x + 1) / 2) * r.width
        const y = r.top + ((1 - corner.y) / 2) * r.height
        if (x < l) l = x
        if (x > rr) rr = x
        if (y < t) t = y
        if (y > b) b = y
      }
      if (behind) continue
      // A building's floors were added one after another: they grow one box.
      const last = boxCount > 0 ? boxes[boxCount - 1] : null
      if (last && last.id === id) {
        last.l = Math.min(last.l, l); last.t = Math.min(last.t, t); last.r = Math.max(last.r, rr); last.b = Math.max(last.b, b)
        continue
      }
      const box = boxes[boxCount] ?? (boxes[boxCount] = { id, l, t, r: rr, b })
      box.id = id; box.l = l; box.t = t; box.r = rr; box.b = b
      boxCount++
    }
    return boxes
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

  /**
   * Where line `id` can be seen: the points along it (every 5% of the way) that are on screen with
   * no building or orb in front of them. A line's close-up promises at least one. Other lines in
   * front do not count: a bundle of lines is still a line to see.
   */
  /** What stands in a ray's way at the tier drawn: the buildings, or at the districts tier the slabs over them (never the hidden buildings). */
  function obstacles(): THREE.Object3D[] {
    return tier === 'districts' ? farPickables : pickables
  }
  /** Whether a hit object is a building, an orb or a slab (not a line's pick tube). */
  function solid(o: THREE.Object3D): boolean {
    return typeof o.userData.nodeId === 'string' || Array.isArray(o.userData.slabIds)
  }

  function linePoints(id: string): Array<{ x: number; y: number }> {
    const e = edges.get(id)
    const r = renderer.domElement.getBoundingClientRect()
    if (!e || r.width === 0 || r.height === 0) return []
    scene.updateMatrixWorld()
    camera.updateMatrixWorld()
    const eye = camera.getWorldPosition(new THREE.Vector3())
    const out: Array<{ x: number; y: number }> = []
    for (let k = 1; k < 20; k++) {
      const p = e.curve.getPoint(k / 20).applyMatrix4(world.matrixWorld)
      const ndc = p.clone().project(camera)
      if (Math.abs(ndc.x) > 1 || Math.abs(ndc.y) > 1 || Math.abs(ndc.z) > 1) continue
      const far = eye.distanceTo(p)
      ray.set(eye, p.clone().sub(eye).normalize())
      const blocked = ray.intersectObjects(obstacles(), false).some((h) => solid(h.object) && h.distance < far - 0.5)
      if (!blocked) out.push({ x: r.left + ((ndc.x + 1) / 2) * r.width, y: r.top + ((1 - ndc.y) / 2) * r.height })
    }
    return out
  }

  function screenPoint(id: string): { x: number; y: number } | null {
    const n = nodes.get(id)
    const e = edges.get(id)
    const r = renderer.domElement.getBoundingClientRect()
    if ((!n && !e) || r.width === 0 || r.height === 0) return null
    scene.updateMatrixWorld()
    camera.updateMatrixWorld()
    const onScreen = (p: THREE.Vector3): { x: number; y: number } | null => {
      p.project(camera)
      if (Math.abs(p.x) > 1 || Math.abs(p.y) > 1 || Math.abs(p.z) > 1) return null
      return { x: r.left + ((p.x + 1) / 2) * r.width, y: r.top + ((1 - p.y) / 2) * r.height }
    }
    if (!n) {
      // A line: a point along it, from the middle outward, over open ground (no building anywhere
      // along the ray) where a click picks this line.
      const line = e as EdgeRec
      for (let k = 0; k <= 16; k++) {
        const t = 0.5 + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.05
        const pt = onScreen(line.curve.getPoint(t).applyMatrix4(world.matrixWorld))
        if (!pt) continue
        const hit = pick(pt.x, pt.y)
        if (hit && hit.kind === 'edge' && hit.id === id && !ray.intersectObjects(obstacles(), false).some((h) => solid(h.object))) return pt
      }
      return null
    }
    for (const p of probePoints(n)) {
      const pt = onScreen(p)
      if (!pt) continue
      const hit = pick(pt.x, pt.y)
      if (hit && hit.kind === 'node' && hit.id === id) return pt
    }
    return null
  }

  /**
   * The points of a building where the probe looks for a click that picks it, in world space: the
   * top floor first, then the floors below, then the roof's corners pulled a little inward. An orb:
   * its centre, then its upper half.
   */
  function probePoints(n: NodeRec): THREE.Vector3[] {
    const points: THREE.Vector3[] = []
    const top = n.floors[n.floors.length - 1]
    if (!top) for (const y of [ORB_R, ORB_R * 1.6]) points.push(n.group.localToWorld(new THREE.Vector3(0, y, 0)))
    for (let k = n.floors.length - 1; k >= 0; k--) points.push(n.floors[k].localToWorld(new THREE.Vector3()))
    if (top) {
      const c = FLOOR_W * 0.35
      for (const [dx, dz] of [[c, c], [-c, c], [c, -c], [-c, -c]]) points.push(top.localToWorld(new THREE.Vector3(dx, 0, dz)))
    }
    return points
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
    if ('wasdqe'.includes(k) && k.length === 1) { controls.autoRotate = false; rig.keys() }
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
    panelBoxes = null
    // The city is fitted again to the new shape; a camera at the overview moves to the new one, a
    // framing on screen is done again for it.
    if (!lastModel) return
    fitOverview(lastModel)
    fogTarget = fogFor()
    rig.resized()
  }
  // One observer watches the host and the panels over it (setPanels): any change has the panels'
  // boxes measured again; the host's own changes resize the view.
  const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver((changed?: ResizeObserverEntry[]) => {
    panelBoxes = null
    if (!changed || changed.some((e) => e.target === host)) resize()
  })
  ro?.observe(host)
  undo.push(() => { ro?.disconnect() })

  /**
   * Which labels show, so that no two overlap on screen (placeLabels), most wanted first:
   *   0. the hovered or selected part's own name, and the open building's floors;
   *   1. the lit lines' labels, nearest the camera first, at most HOVER_EDGE_LABELS for a hover
   *      (FOCUS_EDGE_LABELS for a selection; every line with "all line labels" on);
   *   2. the lit neighbours' names, the busiest first;
   * (these two move a row up or down, or aside, when their point is taken: a busy building's lines
   * and neighbours all end at its top, under its own name);
   *   3. district names and process captions;
   *   4. other building names, by semantic zoom: at the overview only the few busiest
   *      (nameBudget), more as the camera nears;
   *   5. with "all line labels" on, the other lines' labels.
   * A label off the picture or behind the camera takes no room. Sizes are measured once from the
   * DOM. The labels shown last frame need less room to stay (placeLabels), so they hold still.
   */
  const labelAt = new THREE.Vector3()
  let placed = new Map<string, Nudge>()
  const pinned = new Map<string, Nudge>()
  let sizes = new WeakMap<HTMLElement, { w: number; h: number }>()
  /** A district name's size without its subtitle: the form it takes where the whole label finds no room. */
  let compactSizes = new WeakMap<HTMLElement, { w: number; h: number }>()
  /** How many times their base size the labels are drawn (setLabelScale). */
  let labelScale = 1
  /** The panels over the view (setPanels), and their boxes from the view's top left corner (null: to measure again). */
  let panels: readonly HTMLElement[] = []
  let panelBoxes: Rect[] | null = []
  /** The panels' boxes, measured once after each change: a hidden panel has none. */
  function blocked(): Rect[] {
    if (panelBoxes) return panelBoxes
    const at = labelRenderer.domElement.getBoundingClientRect()
    panelBoxes = []
    for (const el of panels) {
      const r = screenRect(el) // a zoomed panel at its real size on every Chromium
      if (r.width > 0 && r.height > 0) panelBoxes.push([r.left - at.left, r.top - at.top, r.right - at.left, r.bottom - at.top])
    }
    return panelBoxes
  }
  /** The district names shown without their subtitle last frame (placeLabels keeps them so until there is room). */
  let compactShown = new Set<string>()
  const subtitleOf = (el: HTMLElement): HTMLElement | null => (el.classList.contains('lw-district') ? el.querySelector('span') : null)
  function measure(els: HTMLElement[]): void {
    const todo = els.filter((el) => !sizes.has(el))
    if (todo.length === 0) return
    const was = todo.map((el) => [el.style.display, el.style.visibility])
    for (const el of todo) {
      if (el.parentNode !== labelRenderer.domElement) labelRenderer.domElement.appendChild(el)
      el.style.display = ''
      el.style.visibility = 'hidden'
    }
    for (const el of todo) {
      // A district name is measured whole, then without its subtitle (shown or hidden as it was).
      const sub = subtitleOf(el)
      const subWas = sub ? sub.style.display : ''
      if (sub) sub.style.display = ''
      if (el.offsetWidth > 0) {
        sizes.set(el, { w: el.offsetWidth, h: el.offsetHeight })
        if (sub && sub.textContent !== '') {
          sub.style.display = 'none'
          compactSizes.set(el, { w: el.offsetWidth, h: el.offsetHeight })
        }
      }
      if (sub) sub.style.display = subWas
    }
    todo.forEach((el, i) => { el.style.display = was[i][0]; el.style.visibility = was[i][1] })
  }
  function candidate(o: CSS2DObject, id: string, tier: number, group?: string, nudge?: boolean | 'vertical', pin?: boolean): LabelCandidate | null {
    o.getWorldPosition(labelAt)
    labelAt.project(camera)
    if (labelAt.z < -1 || labelAt.z > 1) return null
    const { w, h } = sizes.get(o.element) ?? edgeLabelSize((o.element.textContent as string).length, labelScale) // an element's text is never null
    let x = ((labelAt.x + 1) / 2) * width
    let y = ((1 - labelAt.y) / 2) * height
    let keepIn: LabelCandidate['keepIn']
    let compact: LabelCandidate['compact']
    if (pin) {
      // A district's name stays whole inside the view, above the ask bar and left of the legend, and
      // moves up or down only within it; the shift is added back to its nudge (layLabels). Where it
      // finds no room whole, it shows without its subtitle (placeLabels), so neighbours never overlap.
      const [sx, sy] = clampIntoView(x, y, w, h, width - beside, height - below, LABEL_VIEW_INSET)
      x += sx
      y += sy
      if (sx !== 0 || sy !== 0) pinned.set(id, [sx, sy])
      keepIn = [LABEL_VIEW_INSET, LABEL_VIEW_INSET, width - beside - LABEL_VIEW_INSET, height - below - LABEL_VIEW_INSET]
      compact = compactSizes.get(o.element)
    } else if (x + w / 2 < 0 || x - w / 2 > width || y + h / 2 < 0 || y - h / 2 > height) return null
    // A district's name keeps a word's room across from a label on its row, or the two read as one.
    const rowGap = pin ? DISTRICT_ROW_GAP_EM * DISTRICT_FONT_PX * labelScale : 0
    return { id, x, y, w, h, tier, ...(group === undefined ? {} : { group }), ...(nudge ? { nudge } : {}), ...(keepIn ? { keepIn } : {}), ...(compact ? { compact } : {}), ...(rowGap ? { rowGap } : {}) }
  }
  function layLabels(): Map<string, Nudge> {
    camera.updateMatrixWorld()
    const want: { o: CSS2DObject; id: string; tier: number; group?: string; nudge?: boolean | 'vertical'; pin?: boolean }[] = []
    pinned.clear()
    const targets = new Set([hoveredId, selectedId])
    for (const n of nodes.values()) {
      if (floorLabelsShown(tier, n.exploded, targets.has(n.id))) n.floorLabels.forEach((l) => { if (l) want.push({ o: l.o, id: l.key, tier: 0 }) })
      if (targets.has(n.id) && n.group.visible) for (const l of n.labels) want.push({ o: l.o, id: l.key, tier: 0 })
    }
    const lit = [...edges.values()].filter((e) => e.focus)
    const near = (e: EdgeRec): number => e.label.getWorldPosition(labelAt).distanceTo(camera.position)
    for (const e of lit.sort((a, b) => near(a) - near(b))) want.push({ o: e.label, id: 'e:' + e.id, tier: 1, group: 'line', nudge: true })
    // At the districts tier only district names show (and the hovered or selected part's, and its neighbours'),
    // with those of the parts on no district, drawn from far away: they are ranked among themselves.
    const named = ranked.filter((n) => buildingNamesShown(n.id, tier, districtOf))
    const budget = nameBudget(named.length, camera.position.distanceTo(controls.target) / overviewDist)
    named.forEach((n, rank) => {
      if (targets.has(n.id) || !n.group.visible) return
      for (const l of n.labels) {
        if (l.lit) want.push({ o: l.o, id: l.key, tier: 2, nudge: true })
        // A name already on show keeps its place a little past the budget, so a zoom does not flicker it.
        else if (budget > 0 && (rank < budget || (placed.has(l.key) && rank < budget * 1.25 + 1))) want.push({ o: l.o, id: l.key, tier: 4 })
      }
    })
    // A district's name moves a row up or down before it is dropped (another name sits on its point).
    for (const l of labels) {
      if (l.kind === 'district') want.push({ o: l.o, id: l.key, tier: 3, nudge: 'vertical', pin: true })
      else if (l.kind === 'proc' && l.o.parent?.visible !== false) want.push({ o: l.o, id: l.key, tier: 3 })
    }
    // Label every line: each line's label may step aside, as a lit line's does, rather than drop on an overlap.
    if (allLabels) for (const e of edges.values()) if (!e.focus) want.push({ o: e.label, id: 'e:' + e.id, tier: 5, nudge: true })
    measure(want.map((w) => w.o.element))
    const cands: LabelCandidate[] = []
    for (const w of want) {
      const c = candidate(w.o, w.id, w.tier, w.group, w.nudge, w.pin)
      // With every line labelled, a line's label shows even when every place it could step to is taken.
      if (c) cands.push(allLabels && w.id.startsWith('e:') ? { ...c, always: true } : c)
    }
    const compactNow = new Set<string>()
    const room = { bounds: [0, 0, width, height] as const, blocked: blocked() }
    placed = placeLabels(cands, placed, allLabels ? {} : { line: focus?.hover ? HOVER_EDGE_LABELS : FOCUS_EDGE_LABELS }, LABEL_GAP, LABEL_KEEP_GAP, { was: compactShown, now: compactNow }, room)
    compactShown = compactNow
    if (pinned.size === 0) return placed
    const out = new Map(placed)
    for (const [id, [sx, sy]] of pinned) {
      const n = placed.get(id)
      if (n) out.set(id, [n[0] + sx, n[1] + sy])
    }
    return out
  }

  /** Moves a label off its point by its nudge (CSS2DRenderer owns its transform, so the margins). */
  function nudgeLabel(el: HTMLElement, [dx, dy]: Nudge): void {
    const left = dx ? `${dx}px` : ''
    const top = dy ? `${dy}px` : ''
    if (el.style.marginLeft !== left) el.style.marginLeft = left
    if (el.style.marginTop !== top) el.style.marginTop = top
  }

  // ---------------- batches (semantic zoom, instancing) ----------------
  // Every building part keeps its own meshes: the pick target (every raycast, from pick and hover to
  // lineShot and screenPoint, still hits the floor meshes, drawn or not) and the holder of its look
  // (focus, heat and change pulses write to its materials). A part that may be batched is not drawn
  // itself: one InstancedMesh per look draws the boxes with their outlines (the glow, district hue
  // times heat, and the outline's colour go per instance; the outline is drawn on the box's own
  // faces, so a box and its edges keep the order they had as separate objects), and one
  // InstancedMesh per packet shape and opacity draws the conduits' moving packets.
  // The batches are sorted again only when what they hold changes (regroup: a new world, the tier,
  // focus, an opened building), refilled in a new back-to-front order only when the camera or a
  // part moves (refill); between those, a frame only moves the packets.
  const batchLayer = new THREE.Group()
  scene.add(batchLayer)
  renderer.setTransparentSort(transparentOrder as unknown as (a: unknown, b: unknown) => number)
  const instPool = new Map<string, THREE.InstancedMesh>()
  const bm = new THREE.Matrix4()
  const bs = new THREE.Matrix4()
  const bc = new THREE.Color()
  const bv = new THREE.Vector3()
  const bq = new THREE.Quaternion()
  const bsc = new THREE.Vector3()
  interface BoxBatch { im: THREE.InstancedMesh; parts: BatchPart[] }
  let boxBatches: BoxBatch[] = []
  let packetBatches: Array<{ im: THREE.InstancedMesh; objs: THREE.Mesh[] }> = []
  const lastEye = new THREE.Vector3(NaN, NaN, NaN)
  const lastLook = new THREE.Quaternion()
  let changing = false

  /** Parts leaving the batches draw themselves again, as they did before semantic zoom: floors on, blocks off. */
  function unbatch(ps: readonly BatchPart[]): void {
    for (const p of ps) p.mesh.visible = p.line.visible = p.kind === 'floor'
  }

  /**
   * A box batch's material: the source fill's look, with the per-instance colour lighting the
   * emissive (the glow) instead of tinting the fill, and the outline drawn where a face meets its
   * box's edge, in the instance's `lineColor`. Each face draws half a pixel of it, so where two faces
   * meet the line is about one pixel wide, as a GL line is (and as bright: a wider band blooms).
   */
  function boxMaterial(src: THREE.MeshStandardMaterial, lineOpacity: number): THREE.MeshStandardMaterial {
    const m = new THREE.MeshStandardMaterial({
      color: src.color, emissive: 0xffffff, emissiveIntensity: 1, metalness: src.metalness, roughness: src.roughness,
      transparent: src.transparent, opacity: src.opacity, depthWrite: src.depthWrite, fog: src.fog,
      // A box that writes no depth (dimmed or fading) shows its far edges through itself, as its own
      // outline (a GL line on every edge) does: its back faces draw, but only their edges.
      side: src.depthWrite ? THREE.FrontSide : THREE.DoubleSide,
    })
    m.onBeforeCompile = (sh) => {
      sh.uniforms.lineOpacity = { value: lineOpacity }
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec3 lineColor;\nvarying vec3 vLineColor;\nvarying vec3 vBoxPos;\nvarying vec3 vBoxNormal;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLineColor = lineColor;\nvBoxPos = position;\nvBoxNormal = normal;')
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float lineOpacity;\nvarying vec3 vLineColor;\nvarying vec3 vBoxPos;\nvarying vec3 vBoxNormal;')
        .replace('#include <color_fragment>', '')
        .replace('#include <emissivemap_fragment>', EMISSIVE_TINT)
        .replace('#include <opaque_fragment>', [
          'vec3 boxAxis = abs( vBoxNormal );',
          'vec3 boxPx = ( 0.5 - abs( vBoxPos ) ) / max( fwidth( vBoxPos ), vec3( 1e-6 ) );',
          'float edgePx = 1e6;',
          'if ( boxAxis.x < 0.5 ) edgePx = min( edgePx, boxPx.x );',
          'if ( boxAxis.y < 0.5 ) edgePx = min( edgePx, boxPx.y );',
          'if ( boxAxis.z < 0.5 ) edgePx = min( edgePx, boxPx.z );',
          `float edge = 1.0 - smoothstep( ${EDGE_BAND[0].toFixed(2)}, ${EDGE_BAND[1].toFixed(2)}, edgePx );`,
          'outgoingLight = mix( outgoingLight, vLineColor, edge );',
          'diffuseColor.a = mix( gl_FrontFacing ? diffuseColor.a : 0.0, lineOpacity, edge );',
          '#include <opaque_fragment>',
        ].join('\n'))
    }
    m.customProgramCacheKey = () => 'lw-box-batch'
    return m
  }

  function instanced(key: string, geo: () => THREE.BufferGeometry, make: () => THREE.Material, n: number, rank: number): THREE.InstancedMesh {
    let im = instPool.get(key)
    const have = im ? im.instanceMatrix.count : 0
    const cap = batchCapacity(n, have)
    if (!im || cap !== have) {
      if (im) dropBatch(im)
      const g = geo()
      im = new THREE.InstancedMesh(g, make(), cap)
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      im.frustumCulled = false // its instances move: it is never culled as a whole
      // three.js sorts see-through objects by their bounding sphere's centre, which an InstancedMesh
      // computes once from wherever its instances first stood. Pinned at one point, every batch ties
      // and transparentOrder draws them by rank instead.
      im.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity)
      im.setColorAt(0, bc)
      if (g !== UNIT_BOX && !shared.has(g)) g.setAttribute('lineColor', new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3).setUsage(THREE.DynamicDrawUsage))
      instPool.set(key, im)
      batchLayer.add(im)
    }
    im.userData.batchRank = rank
    im.count = n
    return im
  }

  function dropBatch(im: THREE.InstancedMesh): void {
    batchLayer.remove(im)
    ;(im.material as THREE.Material).dispose()
    if (!shared.has(im.geometry)) im.geometry.dispose()
    im.dispose()
  }

  /** Before every render: sorts the parts into batches again, refills them, or only moves the packets. */
  function batchFrame(): void {
    const active = changes.active() > 0
    if (active || changing || !camera.position.equals(lastEye) || !camera.quaternion.equals(lastLook)) refill = true
    changing = active // the frame a change ends refills once more, with its parts at rest
    const filled = regroup || refill
    if (filled) {
      lastEye.copy(camera.position)
      lastLook.copy(camera.quaternion)
      world.updateMatrixWorld()
      if (regroup) regroupBatches()
      fillBoxes()
      regroup = refill = false
    }
    if (filled || !reduced) movePackets()
  }

  /** Which batch each drawn part and packet goes in, and which parts draw themselves (not batchable). */
  function regroupBatches(): void {
    const moving = new Set<THREE.Material>([...ghostMats, ...fadeMats])
    const boxes: Array<{ key: string; depth: number; part: BatchPart }> = []
    for (const p of parts) {
      if (!partDrawn(p.kind, ownTier(p.node.id, tier, districtOf), p.node.exploded)) { p.mesh.visible = p.line.visible = false; continue }
      const f = p.mesh.material as THREE.MeshStandardMaterial
      const l = p.line.material as THREE.LineBasicMaterial
      if (!batchable(p.node.exploded, moving.has(f) || moving.has(l))) { p.mesh.visible = p.line.visible = true; continue }
      p.mesh.visible = p.line.visible = false
      boxes.push({ key: fillKey({ color: f.color.getHex(), metalness: f.metalness, roughness: f.roughness, opacity: f.opacity, lineOpacity: l.opacity, depthWrite: f.depthWrite, fog: f.fog }), depth: 0, part: p })
    }
    const packets: Array<{ key: string; depth: number; obj: THREE.Mesh }> = []
    for (const e of edges.values()) {
      for (const pk of e.packets) {
        const m = pk.s.material as THREE.MeshBasicMaterial
        pk.s.visible = false
        packets.push({ key: packetKey(pk.s.geometry.uuid, m.opacity, m.fog), depth: 0, obj: pk.s })
      }
    }
    const boxGroups = groupBatches(boxes)
    const packetGroups = groupBatches(packets)
    for (const k of poolChanges(instPool.keys(), [...boxGroups.keys(), ...packetGroups.keys()]).drop) {
      dropBatch(instPool.get(k) as THREE.InstancedMesh)
      instPool.delete(k)
    }
    boxBatches = [...boxGroups].map(([key, idx]) => {
      const src = boxes[idx[0]].part
      const f0 = src.mesh.material as THREE.MeshStandardMaterial
      const im = instanced(key, () => UNIT_BOX.clone(), () => boxMaterial(f0, (src.line.material as THREE.Material).opacity), idx.length, batchRank('fill', f0.opacity))
      return { im, parts: idx.map((i) => boxes[i].part) }
    })
    packetBatches = [...packetGroups].map(([key, idx]) => {
      const src = packets[idx[0]].obj
      const sm = src.material as THREE.MeshBasicMaterial
      // With the lines (LINE_ORDER), after every box, and writing no depth: drawn first, a packet (a
      // faint one most of all) would cut the faces of the building behind it out in its shape.
      const im = instanced(key, () => src.geometry, () => new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: sm.transparent, opacity: sm.opacity, depthWrite: false, fog: sm.fog }), idx.length, batchRank('packet', sm.opacity))
      im.renderOrder = LINE_ORDER
      const objs = idx.map((i) => packets[i].obj)
      objs.forEach((o, k) => im.setColorAt(k, (o.material as THREE.MeshBasicMaterial).color))
      ;(im.instanceColor as THREE.InstancedBufferAttribute).needsUpdate = true
      return { im, objs }
    })
  }

  /** Each box batch's instances far first from the camera (see-through boxes paint back to front), with their glow and outline colour. */
  function fillBoxes(): void {
    for (const b of boxBatches) {
      for (const p of b.parts) p.depth = bv.setFromMatrixPosition(p.mesh.matrixWorld).distanceToSquared(camera.position)
      b.parts.sort((x, y) => y.depth - x.depth)
      const lc = b.im.geometry.attributes.lineColor as THREE.InstancedBufferAttribute
      b.parts.forEach((p, k) => {
        const [w, h, d] = p.mesh.userData.size as number[]
        b.im.setMatrixAt(k, bm.multiplyMatrices(p.mesh.matrixWorld, bs.makeScale(w, h, d)))
        const f = p.mesh.material as THREE.MeshStandardMaterial
        b.im.setColorAt(k, bc.copy(f.emissive).multiplyScalar(f.emissiveIntensity))
        const c = (p.line.material as THREE.LineBasicMaterial).color
        lc.setXYZ(k, c.r, c.g, c.b)
      })
      b.im.instanceMatrix.needsUpdate = true
      ;(b.im.instanceColor as THREE.InstancedBufferAttribute).needsUpdate = true
      lc.needsUpdate = true
    }
  }

  /** The packets where animate moved them. */
  function movePackets(): void {
    for (const b of packetBatches) {
      b.objs.forEach((o, k) => {
        o.updateMatrix()
        b.im.setMatrixAt(k, bm.multiplyMatrices(world.matrixWorld, o.matrix))
      })
      b.im.instanceMatrix.needsUpdate = true
    }
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
  let wirePulse = 0.55 + 0.45 * Math.sin(0) // the ghost pulse's level, as the last frame set it
  // dispose() and setPaused(true) cancel the queued frame, so a frame never runs after either.
  function animate(): void {
    raf = requestAnimationFrame(animate)
    frameNo++
    const dt = Math.min(clock.getDelta(), 0.05)
    changes.tick(performance.now()) // wall-clock time: a slow frame rate never stretches a change
    // Reduced motion reads a frozen clock and a zero step: the rings, the fog and the wireframe pulse stand still.
    const t = reduced ? 0 : clock.elapsedTime
    const mdt = reduced ? 0 : dt
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
    if (!sameArea(area, areaGoal)) {
      area = easeArea(area, areaGoal, dt)
      project(area)
    }
    rig.step()
    for (const n of nodes.values()) {
      n.floors.forEach((fl, k) => {
        const d = n.exploded ? fl.userData.explodedY : fl.userData.baseY
        const tr = n.exploded ? (k % 2 ? 0.12 : -0.12) : 0
        if (Math.abs(d - fl.position.y) > EASED || Math.abs(tr - fl.rotation.y) > EASED) refill = true // a closing building's floors settle in their batch
        fl.position.y += (d - fl.position.y) * Math.min(1, dt * 5)
        fl.rotation.y += (tr - fl.rotation.y) * Math.min(1, dt * 4)
        const fLabel = n.floorLabels[k]
        if (fLabel) fLabel.o.element.style.opacity = floorLabelsShown(tier, n.exploded, n.id === hoveredId || n.id === selectedId) ? '1' : '0'
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
    for (const s of seals) s.rotation.z += mdt * 0.8
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
      u.a += u.sp * mdt
      s.position.x = Math.cos(u.a) * u.r
      s.position.z = Math.sin(u.a) * u.r
      s.position.y = u.y + Math.sin(t + u.a) * 0.6
    }
    const gp = 0.55 + 0.45 * Math.sin(t * 2.2)
    wirePulse = gp
    for (const m of ghostMats) m.opacity = Math.min(1, m.userData.base * gp * m.userData.f) // every one went through trackBase
    // A part the proposal takes away pulses between FADE_MIN and FADE_MAX at 0.5 Hz; reduced motion holds it at the middle.
    const fade = reduced ? FADE_MID : FADE_MID + FADE_AMP * Math.sin(t * Math.PI)
    for (const m of fadeMats) m.opacity = fade * m.userData.f
    if (selRing && selRing.visible) selRing.rotation.z += mdt * 0.5
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
    controls.update()
    // Semantic zoom: districts (blocks, district names), buildings (blocks, building names), floors (floors, seams, floor labels).
    retier()
    // Semantic zoom and no overlaps (layLabels); then how strongly each shown label reads. District
    // names read from the overview of any size of world (their fade starts past it); building names
    // read at the overview and fade a little with distance; the hovered or selected part's and its
    // neighbours' names read in full.
    const shown = layLabels()
    const districtFade = Math.max(170, overviewDist * 1.15)
    for (const l of labels) {
      l.o.visible = shown.has(l.key)
      if (l.o.visible) nudgeLabel(l.o.element, shown.get(l.key) as Nudge)
      const sub = l.kind === 'district' ? subtitleOf(l.o.element) : null
      const subShown = compactShown.has(l.key) ? 'none' : ''
      if (sub && sub.style.display !== subShown) sub.style.display = subShown
      if (!l.o.visible || l.kind === 'floor' || l.kind === 'proc') continue
      let o = 1
      if (!l.lit && !hoverLabels.includes(l)) {
        const d = l.o.getWorldPosition(wp).distanceTo(camera.position)
        o = (l.kind === 'district' ? clamp(1.9 - d / districtFade, 0, 1) : clamp(2 - d / overviewDist, 0.55, 1)) * l.dim
      }
      l.o.element.style.opacity = String(o)
    }
    for (const e of edges.values()) {
      e.label.visible = shown.has('e:' + e.id)
      if (e.label.visible) nudgeLabel(e.label.element, shown.get('e:' + e.id) as Nudge)
      if (e.label.visible) e.label.element.style.opacity = String(Math.max(0.35, Math.min(1, 1.8 - e.label.getWorldPosition(wp).distanceTo(camera.position) / 110)))
    }
    batchFrame()
    renderer.info.reset()
    if (composer) composer.render()
    else renderer.render(scene, camera)
    drawCalls = renderer.info.render.calls
    labelRenderer.render(scene, camera)
  }
  raf = requestAnimationFrame(animate)

  return {
    canvas: renderer.domElement,
    draw,
    setRightReserve(px, from) {
      if (px === reserve && from === reserveFrom) return
      reserve = px
      reserveFrom = from
      reframe() // the city is fitted again to the part the legend leaves free
    },
    setBottomReserve(px) {
      if (px === lowReserve) return
      lowReserve = px
      reframe() // the city is fitted again to the part above the ask bar (the answer included)
    },
    setCardReserve(w, h) {
      const box: [number, number] | null = w > 0 && h > 0 ? [w, h] : null
      if (box?.[0] === cardBox?.[0] && box?.[1] === cardBox?.[1]) return
      const closed = cardBox !== null && box === null
      cardBox = box
      // A closed card drops the framing where it is: the camera never flies back into its close-up.
      if (closed) rig.cardClosed()
      reframe() // a focus or a close-up is fitted again around the card
    },
    setPanels(els) {
      for (const el of panels) ro?.unobserve(el)
      panels = [...els]
      for (const el of panels) ro?.observe(el)
      panelBoxes = null
    },
    setLabelScale(v) {
      if (!(v > 0) || v === labelScale) return
      labelScale = v
      labelRenderer.domElement.style.setProperty('--lw-s', String(v))
      // Every label is measured again at its new size.
      sizes = new WeakMap()
      compactSizes = new WeakMap()
    },
    setTheme(name, th) {
      themeName = name
      theme = th
      extras = EXTRAS[themeName]
      fogTarget = fogFor()
      fog.density = fogTarget
      if (lastModel && lastText) draw(lastModel, lastText, allLabels)
      else { scene.background = new THREE.Color(th.background); fog.color.set(th.background) }
    },
    setFocus(f) {
      focus = f
      focusHeld = focusHolds(f)
      applyFocus()
      retier()
    },
    setSelected(id) { selectedId = id; placeRing(); retier() },
    setExploded(id) {
      // Only a building opens: an orb (external) has no floors, so it never thickens the fog.
      const n = id === null ? undefined : nodes.get(id)
      explodedId = n && !n.orb ? n.id : null
      for (const n of nodes.values()) n.exploded = n.id === explodedId && !n.orb
      fogTarget = fogFor()
      regroup = true
    },
    frame,
    // The home view (its free area has no card), from wherever the camera is: any framing is dropped.
    overview(instant) {
      controls.autoRotate = false // a flight ends the idle turn
      return rig.overview(instant)
    },
    getCamera: () => ({ pos: [camera.position.x, camera.position.y, camera.position.z], target: [controls.target.x, controls.target.y, controls.target.z] }),
    flyTo(pose, instant) {
      controls.autoRotate = false // a flight ends the idle turn
      return rig.to(pose, instant)
    },
    pulse,
    stopPulses,
    pick,
    setCursor(pointer) { renderer.domElement.style.cursor = pointer ? 'pointer' : 'default' },
    setHovered(id) { hoveredId = id; hoverLabels = id === null ? [] : nodes.get(id)?.labels ?? [] },
    visibleIds,
    isShown: (id) => { const n = nodes.get(id); return n !== undefined && (n.group.visible || districtOf.has(id)) },
    screenPoint,
    linePoints,
    drawnCounts: () => ({
      processShells: shellCount, conduits: edges.size, changing: changes.active(), tier, drawCalls,
      buildings: [...nodes.values()].filter((n) => !n.orb).length,
      districts: lastModel ? lastModel.districts.length : 0,
      slabs: slabMeshes.reduce((n, im) => n + (im.visible ? im.count : 0), 0),
      slabLooks: tier === 'districts' ? slabLooks.map((sg) => ({ ...sg })) : [],
    }),
    motionState: () => {
      const floorOrder: Record<string, string[]> = {}
      const orbs: string[] = []
      for (const n of nodes.values()) {
        if (n.orb) { orbs.push(n.id); continue }
        const names = n.floors
          .map((fl, k) => ({ y: fl.userData.baseY as number, label: n.floorLabels[k] }))
          .sort((a, b) => a.y - b.y)
          .map((f) => f.label?.o.element.textContent ?? null)
          .filter((t): t is string => t !== null)
        floorOrder[n.id] = names
      }
      const open = explodedId === null ? undefined : nodes.get(explodedId)
      const top = open?.floors[open.floors.length - 1]
      let lineLabels = 0
      for (const e of edges.values()) if (e.label.visible) lineLabels++
      return {
        ringAngle: seals[0]?.rotation.z ?? 0,
        fogDrift: fogSprites[0]?.userData.a ?? 0,
        wirePulse,
        selectionRingAngle: selRing?.rotation.z ?? 0,
        bloom: bloom !== null,
        stars: starGeo.getAttribute('position').count,
        dust: dustGeo ? dustGeo.getAttribute('position').count : 0,
        platformSides: Object.fromEntries(platformSides),
        platformLights,
        floorOrder,
        orbs,
        exploded: explodedId,
        explodeGap: top ? top.position.y - (top.userData.baseY as number) : 0,
        flight: rig.flight(),
        lineLabels,
      }
    },
    keepGhosts(ids) {
      const groups: THREE.Object3D[] = []
      for (const id of ids) {
        const n = nodes.get(id)
        if (n) groups.push(n.group)
      }
      // A kept building fades out on its own meshes: it leaves the batches.
      const kept = new Set(groups)
      unbatch(parts.filter((p) => kept.has(p.node.group)))
      parts = parts.filter((p) => !kept.has(p.node.group))
      regroup = true
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
      refill = true
    },
    stopChanges: () => { changes.stop(); refill = true },
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
      // Off the page first, as the undo path does: a later step that throws leaves no dead canvas or label layer.
      renderer.domElement.remove()
      labelRenderer.domElement.remove()
      changes.stop()
      cancelAnimationFrame(raf)
      ro?.disconnect()
      host.removeEventListener('keydown', onKeyDown)
      host.removeEventListener('keyup', onKeyUp)
      host.removeEventListener('blur', onBlur, true)
      host.removeEventListener('wheel', onWheel, { capture: true })
      controls.removeEventListener('start', onControlStart)
      controls.removeEventListener('change', onControlChange)
      controls.removeEventListener('end', onControlEnd)
      controls.dispose()
      rig.stop()
      stopPulses()
      clearWorld()
      // The batches' materials and their own geometries (a box batch's unit box with its outline colours).
      for (const im of instPool.values()) dropBatch(im)
      instPool.clear()
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
    },
  }
}
