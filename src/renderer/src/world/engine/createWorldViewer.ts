// The Lumopolis viewer: wires a WorldDoc to the scene model, the Three.js drawing layer, the
// focus rules, the action queue and the inspector cards. Without WebGL it shows the 2D list
// (fallback2d.ts) instead, and clicks on that list still raise select events.
// Excluded from the coverage gate (its WebGL path needs a GPU): tests/renderer/world/createWorldViewer.test.ts
// pins the 2D path in jsdom, and e2e/world-engine.spec.ts covers the WebGL path.
import { diffSummary, diffWorlds, riseIds, sameParts } from '../../../../shared/world/diff'
import { edgeSummary } from '../../../../shared/world/edgeText'
import type { WorldAction, WorldDoc } from '../../../../shared/world/types'
import { ACTION_GAP_MS, createActionQueue } from './actionQueue'
import { focusHolds } from './batching'
import { createChangeToast } from './changeToast'
import { buildingCard, edgeCard, escapeHtml, techCard, usesTech, type TourStop } from './cards'
import { renderFallback } from './fallback2d'
import { neighbours } from './interaction'
import { buildSceneModel, DEFAULT_LAYERS, type LayerState } from './sceneModel'
import type { SlabSignals } from './slabSignals'
import { createThreeRenderer, type MotionState, type RenderFocus, type RenderPick, type RendererPerf, type SceneText, type ThreeRenderer } from './threeRenderer'
import { frameStats, type FrameStats } from './frameSampler'
import { THEMES, type ThemeName } from './themes'
import type { ZoomTier } from './viewMath'

export type SelectionKind = 'building' | 'edge' | 'district' | 'tech'
export interface WorldSelection { kind: SelectionKind; id: string }

/** Where the camera stands and what it looks at: a bookmark keeps this. */
export interface CameraState { pos: [number, number, number]; target: [number, number, number] }

export interface WorldViewer {
  /**
   * Draws a world. With animateFrom (the previous world of the same project) the parts that changed
   * rise, pulse or fade (not with reduced motion) and a toast such as "+3 parts, 2 changed" shows.
   */
  load(doc: WorldDoc, opts?: WorldLoadOptions): void
  setLayers(l: Partial<LayerState>): void
  setTheme(t: ThemeName): void
  /**
   * Pixels on the right the legend covers now; the overview is fitted to the rest. Ignored without WebGL.
   * `from`: the view width from which that strip is kept clear (by default three times the strip).
   */
  setRightReserve(px: number, from?: number): void
  /** Pixels at the bottom the ask bar covers now; the overview is fitted above it. Ignored without WebGL. */
  setBottomReserve(px: number): void
  /**
   * The open card's box from the view's top left corner (width and height, gaps included; 0, 0 with
   * no card): a focus, a line's close-up or a tour step is framed around it. Ignored without WebGL.
   */
  setCardReserve(w: number, h: number): void
  /**
   * The panels drawn over the view (legend, ask bar, card, toolbar, notices): no map label is drawn
   * under one or cut off at the view's edge. Their boxes are measured again as they change size; call
   * it again when the set changes. Ignored without WebGL.
   */
  setPanels(els: readonly HTMLElement[]): void
  /** How many times their base size the map's labels are drawn: 1, more on a big screen (uiScale). Ignored without WebGL. */
  setLabelScale(s: number): void
  /** Runs one action now: camera flight, highlight, flow pulse, card open, tour, proposal reveal or reset. */
  apply(a: WorldAction): Promise<void>
  play(actions: WorldAction[]): Promise<void>
  /**
   * Stops what is playing: the rest of a play or tour, a pulse, and a camera flight under way (stopped where the
   * camera is). The promises of apply() and play() settle at once.
   */
  cancelActions(): void
  on(ev: 'select', cb: (sel: WorldSelection | null) => void): () => void
  on(ev: 'hover', cb: (id: string | null) => void): () => void
  /** What became of the 3D map's graphics, as onGraphics: for a host that did not make the viewer (the exported page). */
  on(ev: 'graphics', cb: (state: WorldGraphics) => void): () => void
  getSelection(): string[]
  /** Ids of the buildings, externals and edges currently in view. */
  cameraRegion(): string[]
  /** Where a click picks a building, external or line, in client pixels: null when it is not drawn in 3D or no such point is in view. */
  screenPoint(id: string): { x: number; y: number } | null
  /** Where line `id` can be seen, in client pixels: its points on screen with no building in front (none in 2D). */
  linePoints(id: string): Array<{ x: number; y: number }>
  /** What a click at this point (client pixels) picks: a building or external, a line, or null (also in 2D). */
  pickAt(x: number, y: number): RenderPick | null
  /** Where the camera stands now; null in 2D (no camera). */
  cameraState(): CameraState | null
  /** Flies the camera to a saved view (`instant`: lands at once; always instant under reduced motion). Resolves when it lands; nothing in 2D. */
  setCamera(s: CameraState, instant: boolean): Promise<void>
  /** What is drawn now: the layer switches, and the process shells and conduits on the 3D map (0 in 2D). */
  drawn(): WorldDrawn
  /**
   * Cancels running actions, clears the selection (renderCard(null) and a select(null) event) and
   * flies back to the overview.
   *
   * Esc does the same, but only while the viewer container has keyboard focus: it takes focus on
   * pointerdown, and the viewer never listens on window, so it does not steal Esc from the page.
   * A host that shows the card outside the container (or moves focus there) calls resetView()
   * itself, or forwards Esc to it.
   */
  resetView(): void
  /**
   * Stops (true) or restarts (false) drawing frames. The host pauses the viewer while something
   * covers it entirely (the World home, a loading screen), so a hidden world costs no GPU time.
   * Nothing moves while paused; a flight or pulse in progress goes on after the restart.
   */
  setPaused(paused: boolean): void
  /**
   * Draws the next frame of the 3D map though nothing changed: frames are drawn only while something moves, so a
   * capture of the canvas (an image of the city) asks for one first. Nothing in 2D.
   */
  requestFrame(): void
  /** The frame times, as drawn().perf gives them, without the rest of drawn() (what the frame-rate readout reads). */
  perf(): WorldPerf
  /** Starts a frame-time window for the e2e harness (__worldPerf.begin, look spec §6.1). Nothing in 2D. */
  perfBegin(): void
  /** Ends the window perfBegin started and gives its frame times (none in 2D, or with no window started). */
  perfEnd(): FrameStats
  /** The project's display name changed: the 2D map's heading and the 3D map's text alternative follow. */
  setTitle(title: string): void
  /** Removes every listener and frees the renderer. Later calls to load() are ignored. */
  dispose(): void
}

/**
 * What became of the 3D map's graphics: 'lost' (the WebGL context was lost: nothing is drawn until it comes back),
 * 'restored' (it came back and the world was built again), 'flat' (lost a second time: the viewer shows the 2D map),
 * 'watchdog' (the 3D map never presented a frame, or the GPU could not hold even its smallest drawing buffer: the
 * viewer shows the 2D map; look spec §5.3).
 */
export type WorldGraphics = 'lost' | 'restored' | 'flat' | 'watchdog'

/**
 * How long the 3D map may take to present its first frame before the viewer shows the 2D map instead (look spec
 * §5.3): on a GPU, and drawn in software. Only time the view is shown counts: not while paused, on a hidden page, or
 * while a lost context is being waited out.
 */
export const FIRST_FRAME_MS_HW = 4000
export const FIRST_FRAME_MS_SW = 15_000
/** How often the first-frame watchdog looks. */
const WATCH_TICK_MS = 500

export interface WorldLoadOptions {
  animateFrom?: WorldDoc
  /**
   * The newer world changes test status only (CI's late answer: WP4b fix round 1, M6). When its parts are those the
   * viewer holds, in the same places (sameParts), they are restyled in place: nothing under way stops (a tour, a
   * flight, a pulse, a rise), nothing pulses and no toast shows, and the camera, the selection, its card and the open
   * building stay. Any other world is loaded as without it.
   */
  statusOnly?: true
}

/** The motions and the drawn result as the renderer reports them (MotionState); all empty on the 2D fallback. */
export type WorldDrawnVisual = MotionState
const noVisual = (): WorldDrawnVisual => ({
  ringAngle: 0, fogDrift: 0, wirePulse: 0, selectionRingAngle: 0, bloom: false, stars: 0, dust: 0, platformSides: {}, platformLights: 0,
  floorOrder: {}, orbs: [], exploded: null, explodeGap: 0, flight: { active: false, t: 0, eased: 0 }, lineLabels: 0,
})

/** The 3D map's frame times (look spec §6.1), and whether its tier is chosen for you (no quality was asked for). */
export interface WorldPerf extends RendererPerf {
  auto: boolean
}

export interface WorldDrawn {
  layers: LayerState
  processShells: number
  conduits: number
  /** Rises, pulses and fades still running (always 0 in 2D). */
  changing: number
  /** Semantic zoom tier the camera's distance gives ('districts' in 2D). */
  tier: ZoomTier
  /** GL draw calls of the last frame, every pass (0 in 2D). */
  drawCalls: number
  /** Triangles those draw calls drew (0 in 2D). */
  triangles: number
  /** Frames drawn since the 3D map was made: frames are drawn only while something moves (0 in 2D). */
  frames: number
  /** Frames whose render returned, the first-frame watchdog's sign of life (0 in 2D). */
  presented: number
  /** The WebGL context is lost now, its event come or not (false in 2D). */
  contextLost: boolean
  /** The frame times the 3D map drew at (look spec §6.1; no frames in 2D, at the 'flat' tier). */
  perf: WorldPerf
  /**
   * The 3D map is drawn in software: no GPU draws it (a virtual machine, a remote session, a blocked driver), so the
   * page is composited by the CPU too (false in 2D). A host then draws its panels over the map opaque rather than
   * blurring what lies behind them: the blur is drawn again whenever anything on the page changes, and in software
   * that takes every core while it lasts.
   */
  software: boolean
  /** Buildings in the world (drawn or under their slabs), districts, and slabs drawn now (the districts tier; 0 in 2D). */
  buildings: number
  districts: number
  slabs: number
  /**
   * What each slab drawn now shows of the buildings under it (slabSignals: its hottest one's heat, an
   * outline for a planned or changed part, fading or fog when all of them are); empty nearer in and in 2D.
   */
  slabLooks: SlabSignals[]
  /** Ids of the buildings drawn as wireframes: planned parts not built yet (always empty in 2D). */
  wireframes: string[]
  /** The wireframes on screen at the tier drawn: drawn themselves, or under a district slab that stands for them (always empty in 2D). */
  shownWireframes: string[]
  /** Ids of the solid buildings drawn with an outline: parts the code changed since the last reconcile (always empty in 2D). */
  outlined: string[]
  /** Ids of the buildings drawn fading: parts the shown proposal takes away (always empty in 2D). */
  fading: string[]
  /** Ids of the buildings drawn hot: their live latency is above 0 (always empty in 2D). */
  hot: string[]
  /** Ids an answer fogged (the evidence does not support them) until the next reset. */
  fogged: string[]
  /** Ids lit now (the buildings and lines a selection, a tech chip or an action asked for); empty when nothing is. */
  highlighted: string[]
  /** The looping motions now (the seal rings, the fog drift, the wireframe pulse and the selection ring; each holds
   *  still under reduced motion) and the drawn result the renderer reports (all empty in 2D). */
  visual: WorldDrawnVisual
}

export interface WorldViewerOptions {
  /** The project's display name: the 2D map's heading and label (never the hashed project key). */
  title?: string
  quality?: 'high' | 'low'
  reducedMotion?: boolean
  /**
   * Receives the inspector card HTML for the selection, or null when nothing is selected. `fromClick` is
   * true when a click or double-click on the map opened it, so the card can let that double-click through.
   */
  renderCard?: (html: string | null, fromClick?: boolean) => void
  /** Pixels on the right that a panel covers (the legend); the city is framed in the rest. */
  rightReserve?: number
  /** Pixels at the bottom that a panel covers (the ask bar); the city is framed above them. */
  bottomReserve?: number
  /** The exported page: cards have no Confirm or Edit control and show evidence as text, not as buttons. */
  readOnly?: boolean
  /** What became of the 3D map's graphics (a lost WebGL context): the host shows a notice. */
  onGraphics?: (state: WorldGraphics) => void
  /** Each stop a tour shows, then null once a tour that showed one ends: the host says it to a screen reader (T5). */
  onTourStop?: (stop: TourStop | null) => void
  /** Test only: passed to the renderer (RendererOptions.firstFrameSlowdown). */
  firstFrameSlowdown?: () => number
}

/**
 * A WebGL context was made on this page already: the probe answers true at once. Making one can take more than a
 * second (macOS), on the main thread, and a pane opening asks more than once (each mount of WorldView, then the
 * viewer). A renderer that still cannot be made, or a lost context, forgets it (forgetWebGL), so the next open probes again.
 */
let webglFound = false

/** True when this browser can create a WebGL context. */
export function hasWebGL(): boolean {
  if (webglFound) return true
  try {
    const c = document.createElement('canvas')
    const gl = (c.getContext('webgl2') ?? c.getContext('webgl')) as WebGLRenderingContext | null
    if (!gl) return false
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    webglFound = true
    return true
  } catch {
    return false
  }
}

/** The next hasWebGL makes a context again rather than trust one made before. */
export function forgetWebGL(): void {
  webglFound = false
}

const DRAG_PX = 5
const TOUR_STEP_MS = ACTION_GAP_MS * 2

/** The system's reduced-motion setting, or null where it cannot be asked. */
function reducedMotionQuery(): MediaQueryList | null {
  try {
    return typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null
  } catch {
    return null
  }
}

/** The canvas's description for a screen reader: the 3D map cannot be walked with the keyboard, the 2D map can. */
export const CANVAS_DESCRIPTION = 'To go through the parts with the keyboard, switch to the 2D map.'

export function createWorldViewer(container: HTMLElement, opts: WorldViewerOptions = {}): WorldViewer {
  // Without the option the viewer follows the system setting, also when it is switched while the view is open.
  const motionQuery = opts.reducedMotion === undefined ? reducedMotionQuery() : null
  let reduced = opts.reducedMotion ?? motionQuery?.matches === true
  let title = opts.title ?? 'This project'
  const cardOpts = { readOnly: opts.readOnly === true }
  const hostCard = opts.renderCard ?? ((): void => undefined)
  /** Shows a card (null takes it down). The tour's caption marks itself as the tour's after this. */
  function renderCard(html: string | null, fromClick?: boolean): void {
    tourCard = false
    hostCard(html, fromClick)
  }
  const selectCbs = new Set<(sel: WorldSelection | null) => void>()
  const hoverCbs = new Set<(id: string | null) => void>()
  const graphicsCbs = new Set<(state: WorldGraphics) => void>()
  const graphics = (g: WorldGraphics): void => {
    opts.onGraphics?.(g)
    for (const cb of Array.from(graphicsCbs)) cb(g)
  }

  let doc: WorldDoc | null = null
  let layers: LayerState = { ...DEFAULT_LAYERS }
  let themeName: ThemeName = 'neon'
  let revealProposal: string | undefined
  /** Parts an answer fogged; cleared by reset, resetView and load. */
  const fogged = new Set<string>()
  let selection: WorldSelection | null = null
  let exploded: string | null = null
  let hovered: string | null = null
  /** The hovered building or external (a hovered line lights nothing): its connections light up. */
  let hoverNode: string | null = null
  /** The district whose slab the pointer is over (the districts tier). */
  let hoverDistrict: string | null = null
  /** The lit set the selection, a tour or an action asked for; a hovered building overrides it while hovered. */
  let baseFocus: RenderFocus | null = null
  let tourToken = 0
  /** A tour is showing its captions: ending it clears the caption and the highlight. */
  let tourActive = false
  // Whether the card and the highlight showing are the tour's own: its end clears those and nothing else.
  let tourCard = false
  let tourLit = false
  /** The tour under way named a stop to the host (onTourStop), so its end is named too. */
  let tourSaid = false
  let disposed = false
  const toast = createChangeToast(container)
  /** The ask bar's and the legend's strips: the toast keeps out of both (the fit gets them too, in 3D). */
  let lowReserve = opts.bottomReserve ?? 0
  let sideReserve = opts.rightReserve ?? 0
  /** The open card's box from the top left corner (0, 0 with none): the toast keeps out from under it too. */
  let cardReserve: readonly [number, number] = [0, 0]
  toast.place(lowReserve, sideReserve)

  const pos = getComputedStyle(container).position
  if (pos === '' || pos === 'static') container.style.position = 'relative' // '' = not laid out yet
  // No outline override: the host's own focus ring shows when the keyboard reaches the map (A11Y Y6).
  if (!container.hasAttribute('tabindex')) container.tabIndex = 0

  let r3: ThreeRenderer | null = null
  /** WebGL contexts lost so far: the first is waited out, the second drops to the 2D map. */
  let losses = 0
  /** A lost context's event came and its restore has not: the watchdog waits it out. */
  let lossPending = false
  /** Fits that left the drawing buffer shrunk after all its steps (onBufferShrunk). */
  let shrinkFails = 0
  if (hasWebGL()) {
    const before = new Set(Array.from(container.children))
    try {
      r3 = createThreeRenderer(container, {
        quality: opts.quality ?? 'high',
        reducedMotion: reduced,
        onEdgeLabel: (id) => { void select(id) },
        // A loss forgets the context found before (hasWebGL), so the next open probes again: after repeated losses Chromium
        // blocks WebGL for the page, and a cached yes would show the 3D legend over the 2D map (RESP review I-2).
        onContextLost: () => { lossPending = true; forgetWebGL(); if (++losses === 1) graphics('lost'); else dropToFlat() },
        onContextRestored: () => { lossPending = false; if (r3) graphics('restored') },
        // Twice the GPU could not hold even the smallest buffer: one tier down (onTierRequest).
        onBufferShrunk: () => { if (++shrinkFails >= 2) onTierRequest('down') },
        ...(opts.rightReserve !== undefined ? { rightReserve: opts.rightReserve } : {}),
        ...(opts.bottomReserve !== undefined ? { bottomReserve: opts.bottomReserve } : {}),
        ...(opts.firstFrameSlowdown ? { firstFrameSlowdown: opts.firstFrameSlowdown } : {}),
      })
      r3.setTheme(themeName, THEMES[themeName])
    } catch {
      // createThreeRenderer frees what it made before rethrowing; this also covers a throw from
      // setTheme after it returned. Whatever it appended (canvas, label layer) goes before the 2D list.
      try { r3?.dispose() } catch { /* already half torn down */ }
      r3 = null
      forgetWebGL() // WebGL may be gone for good now: the next open probes for it
      for (const el of Array.from(container.children)) if (!before.has(el)) el.remove()
    }
  }

  // ---------------- doc lookups ----------------
  const planBuildings = (d: WorldDoc) => d.layers.plan.flatMap((p) => p.buildings)
  const planEdges = (d: WorldDoc) => d.layers.plan.flatMap((p) => p.edges)
  function kindOf(id: string): SelectionKind | null {
    const d = doc
    if (!d) return null
    if (d.buildings.some((b) => b.id === id) || d.externals.some((x) => x.id === id) || planBuildings(d).some((b) => b.id === id)) return 'building'
    if (d.edges.some((e) => e.id === id) || planEdges(d).some((e) => e.id === id)) return 'edge'
    if (d.districts.some((x) => x.id === id)) return 'district'
    if (Object.prototype.hasOwnProperty.call(d.glossary, id)) return 'tech'
    return null
  }
  function kindMatches(id: string, kind: SelectionKind): boolean {
    const d = doc
    if (!d) return false
    if (kind === 'building') return d.buildings.some((b) => b.id === id) || d.externals.some((x) => x.id === id) || planBuildings(d).some((b) => b.id === id)
    if (kind === 'edge') return d.edges.some((e) => e.id === id) || planEdges(d).some((e) => e.id === id)
    if (kind === 'district') return d.districts.some((x) => x.id === id)
    return Object.prototype.hasOwnProperty.call(d.glossary, id)
  }
  function edgeIdSet(d: WorldDoc): Set<string> {
    return new Set([...d.edges, ...planEdges(d)].map((e) => e.id))
  }

  /** The lit set for a group of ids: the nodes and edges named, plus the edges joining two named nodes. */
  function groupFocus(ids: string[]): RenderFocus {
    const d = doc as WorldDoc // only asked while a world is loaded (an action, a selection)
    const out: RenderFocus = { ids: new Set(), edgeIds: new Set() }
    const edgeIds = edgeIdSet(d)
    const all = [...d.edges, ...(revealProposal === undefined ? [] : planEdges(d))]
    for (const id of ids) {
      if (edgeIds.has(id)) {
        out.edgeIds.add(id)
        const e = all.find((x) => x.id === id)
        if (e) { out.ids.add(e.from); out.ids.add(e.to) }
      } else {
        out.ids.add(id)
      }
    }
    for (const e of all) if (ids.includes(e.from) && ids.includes(e.to)) out.edgeIds.add(e.id)
    return out
  }

  function focusFor(sel: WorldSelection): { focus: RenderFocus; frameIds: string[] } {
    const d = doc as WorldDoc
    const opt = revealProposal === undefined ? undefined : { revealProposal }
    if (sel.kind === 'building' || sel.kind === 'edge') {
      return { focus: neighbours(d, sel.id, opt), frameIds: [sel.id] }
    }
    if (sel.kind === 'district') {
      const ids = d.buildings.filter((b) => b.districtId === sel.id).map((b) => b.id)
      return { focus: groupFocus(ids), frameIds: ids }
    }
    const used = usesTech(d, sel.id)
    return { focus: groupFocus(used), frameIds: used }
  }

  /**
   * Spec line 156: hovering a building lights its connections and dims the rest, until the pointer
   * leaves. The hover's focus says so (`hover`), and its labels that are not the selection's own let a
   * click through to the building under them (`passive`): a busy building's labels gather over it.
   */
  function showFocus(): void {
    if (!r3) return
    const d = doc
    const opt = revealProposal === undefined ? undefined : { revealProposal }
    // From far away a district's slab stands for its buildings: hovering it lights all their connections.
    const hoverIds = !d ? [] : hoverNode !== null ? [hoverNode] : d.buildings.filter((b) => hoverDistrict !== null && b.districtId === hoverDistrict).map((b) => b.id)
    if (!d || hoverIds.length === 0) { r3.setFocus(baseFocus); return }
    const f = { ids: new Set<string>(), edgeIds: new Set<string>() }
    for (const id of hoverIds) {
      const n = neighbours(d, id, opt)
      for (const x of n.ids) f.ids.add(x)
      for (const x of n.edgeIds) f.edgeIds.add(x)
    }
    const passive = new Set([...f.edgeIds].filter((id) => !baseFocus?.edgeIds.has(id)))
    // Over a focus that holds the buildings tier, the hover keeps that hold; with no such focus (Esc) it holds nothing.
    r3.setFocus({ ...f, hover: true, passive, held: focusHolds(baseFocus) })
  }
  function setFocus(f: RenderFocus | null): void {
    tourLit = false
    baseFocus = f
    showFocus()
  }

  function cardFor(sel: WorldSelection): string | null {
    const d = doc as WorldDoc
    // A double-click opens floors only in the 3D city; the 2D list has no such gesture.
    if (sel.kind === 'building') return buildingCard(d, sel.id, r3 ? 'open3d' : 'none', cardOpts)
    if (sel.kind === 'edge') return edgeCard(d, sel.id, cardOpts)
    if (sel.kind === 'tech') return techCard(d, sel.id)
    return null
  }

  function emitSelect(): void {
    const sel = selection ? { ...selection } : null
    for (const cb of selectCbs) cb(sel)
  }

  // ---------------- selection ----------------
  /**
   * Opens what `id` names and, with a renderer, flies to it. `hint` is the kind the 2D list tagged
   * the item with; it wins when the id names more than one thing. `fromClick`: a click on the map chose it.
   */
  function select(id: string, instant = reduced, hint?: SelectionKind, fromClick = false): Promise<void> {
    const kind = hint !== undefined && kindMatches(id, hint) ? hint : kindOf(id)
    if (!kind) return Promise.resolve()
    // A choice of the user's (or an answer's card) ends a tour under way, as Esc does. Its caption is not taken
    // down first: the new card replaces it.
    tourCard = false
    endTour()
    selection = { kind, id }
    const { focus, frameIds } = focusFor(selection)
    renderCard(cardFor(selection), fromClick)
    emitSelect()
    if (!r3) return Promise.resolve()
    r3.setSelected(kind === 'building' || kind === 'edge' ? id : null)
    setFocus(focus)
    return frameOn(r3, selection, focus.ids, frameIds, instant)
  }

  /** Flies to a selection. A building is framed with its neighbours in view, so the click shows where it sits. */
  function frameOn(r: ThreeRenderer, sel: WorldSelection, lit: Set<string>, frameIds: string[], instant: boolean): Promise<void> {
    return sel.kind === 'building' ? r.frame(frameIds, instant, [...lit].filter((x) => x !== sel.id)) : r.frame(frameIds, instant)
  }

  /**
   * True when `next` comes from a Re-layout the person asked for: its layout round differs. Positions alone
   * cannot tell, since a watched change that shrinks a district re-places its outer parts (round 2 N4).
   */
  function relaidSince(prev: WorldDoc, next: WorldDoc): boolean {
    // A world with no round (one compiled with no stored world to carry it) is not known to be a Re-layout: the view stays.
    const round = next.layout.round
    return round !== undefined && round !== (prev.layout.round ?? 0)
  }

  function deselect(): void {
    // Clearing the choice (an empty click, a reset) ends a tour under way too, as a choice does: the card and the
    // highlight are taken down just below, so the tour's end leaves them to that.
    tourCard = false
    tourLit = false
    endTour()
    const had = selection !== null
    selection = null
    renderCard(null)
    if (r3) { r3.setSelected(null); setFocus(null) }
    if (had) emitSelect()
  }

  // ---------------- drawing ----------------
  function sceneText(d: WorldDoc): SceneText {
    const text: SceneText = { labels: {}, floors: {}, districts: {}, edges: {}, processes: d.processes, cargoShapes: {}, importance: {} }
    for (const b of [...d.buildings, ...planBuildings(d)]) {
      if (text.labels[b.id] !== undefined) continue
      text.labels[b.id] = layers.labels === 'tech' ? b.techLabel : b.name
      text.floors[b.id] = b.floors.map((f) => f.name)
    }
    for (const x of d.externals) text.labels[x.id] = x.name
    for (const x of d.districts) text.districts[x.id] = districtSubtitle(d, x)
    for (const e of [...d.edges, ...planEdges(d)]) if (text.edges[e.id] === undefined) text.edges[e.id] = edgeSummary(e.label)
    for (const [k, c] of Object.entries(d.cargo)) text.cargoShapes[k] = c.shape
    for (const e of d.edges) for (const end of new Set([e.from, e.to])) text.importance[end] = (text.importance[end] ?? 0) + 1
    return text
  }

  /**
   * Under a district's name: its role when the model wrote one, else what the code alone shows,
   * how many parts (buildings) and files it holds.
   */
  function districtSubtitle(d: WorldDoc, x: WorldDoc['districts'][number]): string {
    if (x.subtitle.trim() !== '') return x.subtitle
    const parts = d.buildings.filter((b) => b.districtId === x.id)
    const files = parts.reduce((n, b) => n + b.members.length, 0)
    return `${parts.length} ${parts.length === 1 ? 'part' : 'parts'} · ${files} ${files === 1 ? 'file' : 'files'}`
  }

  let wireframes: string[] = []
  const shownWires = (): string[] => {
    const r = r3
    return r ? wireframes.filter((id) => r.isShown(id)) : []
  }
  let outlined: string[] = []
  let fading: string[] = []
  let hot: string[] = []
  function redraw(): void {
    const d = doc
    if (!d) return
    if (!r3) { drawFallback(d); return }
    const model = buildSceneModel(d, layers, { revealProposal, fogged })
    wireframes = model.buildings.filter((b) => b.look === 'wire').map((b) => b.id)
    outlined = model.buildings.filter((b) => b.outline).map((b) => b.id)
    fading = model.buildings.filter((b) => b.look === 'fading').map((b) => b.id)
    hot = model.buildings.filter((b) => b.heat > 0).map((b) => b.id)
    r3.draw(model, sceneText(d), layers.allLineLabels)
    r3.setExploded(exploded)
    if (selection && kindOf(selection.id)) {
      const { focus } = focusFor(selection)
      r3.setSelected(selection.kind === 'building' || selection.kind === 'edge' ? selection.id : null)
      baseFocus = focus
    }
    // The hovered building's name and connections stay lit across a redraw, unless it is gone.
    if (hoverNode !== null && kindOf(hoverNode) === null) hoverNode = null
    r3.setHovered(hoverNode)
    showFocus()
  }

  // ---------------- 2D fallback ----------------
  // renderFallback tags each item with data-kind and data-id; clicks are wired from those.
  function drawFallback(d: WorldDoc): void {
    container.innerHTML = renderFallback(d, title, { planned: layers.planned, proposal: layers.proposal, ...(revealProposal !== undefined ? { reveal: revealProposal } : {}) })
    for (const el of Array.from(container.querySelectorAll<HTMLElement>('[data-id]'))) el.style.cursor = 'pointer'
  }

  // ---------------- input ----------------
  let down: { x: number; y: number } | null = null
  // Chromium reports a click's (and a double-click's) clientX/clientY as whole pixels, cut down,
  // while the pointer events around it carry the true fractional point. A click near a building's
  // edge was picked up to a pixel left of and above where the press landed and missed it (the e2e
  // jitter's -2,0 click: frac hit routes, trunc missed). So a click picks at the pointerup that
  // made it, when there is one under the same whole pixel.
  let up: { x: number; y: number } | null = null
  const clickAt = (e: MouseEvent): { x: number; y: number } =>
    up && Math.floor(up.x) === e.clientX && Math.floor(up.y) === e.clientY ? up : { x: e.clientX, y: e.clientY }
  let hoverRaf = 0
  /** The pointer moved again in the frame its first move picked in: the frame picks again where it is now. */
  let hoverLate = false
  let hoverAt: { x: number; y: number } | null = null
  const canvas = r3 ? r3.canvas : null
  // The canvas is a picture to a screen reader: its name, and where the keyboard can walk the parts.
  const nameCanvas = (): void => { canvas?.setAttribute('aria-label', `Map of ${title}`) }
  if (canvas) {
    canvas.setAttribute('role', 'img')
    canvas.setAttribute('aria-description', CANVAS_DESCRIPTION)
    nameCanvas()
  }
  /**
   * Where the last single click landed and what it picked. A double-click's first click selects, and
   * the camera flies to that part at once, so by the second click something else (or nothing) is under
   * the pointer. The second click and the double-click at the same spot act on what the first one picked.
   */
  let lastClick: { x: number; y: number; hit: RenderPick | null } | null = null
  const sameSpot = (at: { x: number; y: number }): boolean =>
    lastClick !== null && Math.hypot(at.x - lastClick.x, at.y - lastClick.y) <= DRAG_PX

  const onPointerDown = (e: PointerEvent): void => {
    down = { x: e.clientX, y: e.clientY }
    container.focus({ preventScroll: true })
  }
  const onPointerUp = (e: PointerEvent): void => {
    up = { x: e.clientX, y: e.clientY }
  }
  const onClick = (e: MouseEvent): void => {
    if (!r3) return
    const start = down
    down = null
    const at = clickAt(e)
    if (start && Math.hypot(at.x - start.x, at.y - start.y) > DRAG_PX) return
    // The second click of a double-click: the first one chose already.
    if (e.detail > 1 && sameSpot(at)) return
    const hit = r3.pick(at.x, at.y)
    lastClick = { ...at, hit }
    // A district's slab (the districts tier) focuses the district, as choosing it in the tree does.
    if (hit) void select(hit.id, reduced, hit.kind === 'district' ? 'district' : undefined, true)
    else deselect()
  }
  const onDblClick = (e: MouseEvent): void => {
    if (!r3) return
    const at = clickAt(e)
    const hit = sameSpot(at) ? (lastClick as { hit: RenderPick | null }).hit : r3.pick(at.x, at.y)
    if (!hit || hit.kind !== 'node') return
    // Only buildings open floor by floor; an external is an orb with nothing inside.
    if (!doc?.externals.some((x) => x.id === hit.id)) {
      exploded = exploded === hit.id ? null : hit.id
      r3.setExploded(exploded)
    }
    void select(hit.id, reduced, undefined, true)
  }
  /** Picks what is under the pointer and lights it as the hover. */
  const hoverPick = (): void => {
    if (!r3 || !hoverAt || disposed) return
    const hit = r3.pick(hoverAt.x, hoverAt.y)
    const id = hit ? hit.id : null
    r3.setCursor(id !== null)
    if (id !== hovered) {
      hovered = id
      hoverNode = hit && hit.kind === 'node' ? hit.id : null
      hoverDistrict = hit && hit.kind === 'district' ? hit.id : null
      r3.setHovered(hoverNode)
      showFocus()
      for (const cb of hoverCbs) cb(id)
    }
  }
  // A move picks at once, at most once a frame: the renderer's next frame draws the hover. Picked in a frame of its
  // own instead (asked for after the renderer's), the hover was drawn a frame late, and drawn in software a frame
  // there costs up to seconds. A move again in the same frame is picked by that frame, where the pointer is by then.
  const onPointerMove = (e: PointerEvent): void => {
    hoverAt = { x: e.clientX, y: e.clientY }
    if (hoverRaf) { hoverLate = true; return }
    hoverPick()
    hoverRaf = requestAnimationFrame(() => {
      hoverRaf = 0
      if (!hoverLate) return
      hoverLate = false
      hoverPick()
    })
  }
  // The lit connections' labels can appear under the pointer (a busy building's labels gather at
  // its top). Moving onto one leaves the canvas but is still the hover; leaving that label for
  // anything but the canvas or another label ends it. Back on the canvas, pointermove takes over.
  const onLabelLeave = (e: Event): void => {
    if ((e as MouseEvent).relatedTarget !== canvas) onPointerLeave(e as MouseEvent)
  }
  const onPointerLeave = (e: MouseEvent): void => {
    const to = e.relatedTarget as Element | null
    const label = to && typeof to.closest === 'function' ? to.closest('.lw-edge') : null
    if (label && container.contains(label) && hovered !== null) {
      label.addEventListener('pointerleave', onLabelLeave, { once: true })
      return
    }
    hoverAt = null
    if (hovered !== null) {
      hovered = null
      hoverNode = null
      hoverDistrict = null
      r3?.setHovered(null)
      showFocus()
      for (const cb of hoverCbs) cb(null)
    }
  }
  /** Selects the 2D map's item the event came from; false when it came from no item. */
  const selectItem = (e: Event): boolean => {
    if (r3) return false
    const el = (e.target as Element | null)?.closest?.('[data-id]')
    if (!el || !container.contains(el)) return false
    const id = el.getAttribute('data-id')
    const kind = el.getAttribute('data-kind')
    const hint = kind === 'building' || kind === 'edge' || kind === 'district' || kind === 'tech' ? kind : undefined
    if (id) void select(id, reduced, hint)
    return true
  }
  const onFallbackClick = (e: MouseEvent): void => { selectItem(e) }
  // The second press of a double-click would select the nearest page text (the legend's heading): the
  // 3D view, and the names drawn over it, have no text to select. A first press keeps its default.
  const onMouseDown = (e: MouseEvent): void => {
    if (e.detail > 1) e.preventDefault()
  }
  const onKeyDown = (e: KeyboardEvent): void => {
    // Enter or Space on a 2D map item opens it, as a click does (Space would scroll the list instead).
    if ((e.key === 'Enter' || e.key === ' ') && selectItem(e)) { e.preventDefault(); return }
    if (e.key !== 'Escape') return
    cancelActions()
    deselect()
    if (r3) {
      exploded = null
      r3.setExploded(null)
      void r3.overview(reduced)
    }
  }
  if (canvas) {
    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointerup', onPointerUp)
    canvas.addEventListener('click', onClick)
    canvas.addEventListener('dblclick', onDblClick)
    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerleave', onPointerLeave)
    container.addEventListener('mousedown', onMouseDown)
  }
  container.addEventListener('click', onFallbackClick)
  container.addEventListener('keydown', onKeyDown)
  /** Takes the 3D map's listeners off (dispose, and the drop to the 2D map). */
  function unwireCanvas(): void {
    if (hoverRaf) { cancelAnimationFrame(hoverRaf); hoverRaf = 0; hoverLate = false }
    if (!canvas) return
    canvas.removeEventListener('pointerdown', onPointerDown)
    canvas.removeEventListener('pointerup', onPointerUp)
    canvas.removeEventListener('click', onClick)
    canvas.removeEventListener('dblclick', onDblClick)
    canvas.removeEventListener('pointermove', onPointerMove)
    canvas.removeEventListener('pointerleave', onPointerLeave)
    container.removeEventListener('mousedown', onMouseDown)
  }
  /**
   * The WebGL context was lost a second time: the graphics cannot be trusted to come back, so the 3D map is freed and
   * the 2D map drawn in its place, with the selection and its card kept.
   */
  function dropToFlat(state: WorldGraphics = 'flat'): void {
    const gone = r3
    if (!gone || disposed) return
    clearTimeout(watch)
    cancelActions()
    unwireCanvas()
    r3 = null
    try { gone.dispose() } catch { /* the lost context may refuse to be freed: it is off the page either way */ }
    redraw()
    graphics(state)
  }

  // ---------------- first-frame watchdog (look spec §5.3) ----------------
  // A 4K canvas the GPU could not allocate, or a driver that hangs, leaves the 3D map blank with no error. From the first
  // load the watchdog looks every half second until a frame has presented: past the deadline, or with the context lost
  // two looks running and no loss event to wait out, the viewer asks for one tier down (onTierRequest).
  let paused = false
  let watchArmed = false
  let watch: ReturnType<typeof setTimeout> | undefined
  /** Time counted toward the deadline: the view shown, not paused, no loss waited out. */
  let watched = 0
  let lostTicks = 0
  /**
   * The watchdog asks for one tier down (look spec §5.3), and the 2D map is the last step. Until the governor lands
   * there is no drawn tier to step to, so the request goes straight to that last step, the 2D map with the watchdog
   * notice: the look plan's Task 0 has "onTierRequest('down') (stubbed to Flat until Task 3)", and its Task 3 has
   * "Task 0's watchdog stub becomes governor steps".
   */
  function onTierRequest(dir: 'down'): void {
    void dir
    dropToFlat('watchdog')
  }
  /** The frame times of the 2D map: no frames, at the flat tier. */
  const noPerf = (): RendererPerf => ({ tier: 'flat', ...frameStats([]), drops: 0, firstFrameMs: null, resizeWorstMs: 0 })
  /** The counts with whether the tier is chosen for you added to their frame times. */
  const withAuto = <T extends { perf: RendererPerf }>(d: T): T & { perf: WorldPerf } => ({ ...d, perf: { ...d.perf, auto: opts.quality === undefined } })
  function watchTick(): void {
    // dropToFlat and dispose clear the timer, so the renderer is still there.
    const d = (r3 as ThreeRenderer).drawnCounts()
    if (d.presented > 0) return
    if (d.contextLost && !lossPending) {
      if (++lostTicks >= 2) { onTierRequest('down'); return }
    } else lostTicks = 0
    if (!paused && !lossPending && document.visibilityState !== 'hidden') watched += WATCH_TICK_MS
    if (watched >= (d.software ? FIRST_FRAME_MS_SW : FIRST_FRAME_MS_HW)) { onTierRequest('down'); return }
    watch = setTimeout(watchTick, WATCH_TICK_MS)
  }

  // ---------------- actions ----------------
  /** A tour's reading pause: cancelActions and dispose end it at once, its timer cleared. */
  const dwells = new Set<{ timer: ReturnType<typeof setTimeout>; wake: () => void }>()
  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const d = { timer: setTimeout(() => { dwells.delete(d); resolve() }, ms), wake: resolve }
      dwells.add(d)
    })
  }
  function wakeDwells(): void {
    for (const d of dwells) { clearTimeout(d.timer); d.wake() }
    dwells.clear()
  }

  /**
   * The ids an action names, as the map can show them: a district stands for its buildings (the camera frames
   * buildings, and a district id in the lit set would dim every building), and an id the world no longer has is dropped.
   */
  function shownIds(ids: string[]): string[] {
    const d = doc as WorldDoc
    const out = new Set<string>()
    for (const id of ids) {
      const kind = kindOf(id)
      if (kind === 'building' || kind === 'edge') out.add(id)
      else if (kind === 'district') for (const b of d.buildings) if (b.districtId === id) out.add(b.id)
    }
    return [...out]
  }

  /**
   * Ends a tour under way, if any: its camera flight stops, and its caption and highlight are cleared while they
   * are still the tour's own (a card or highlight shown since, by the user or an answer, stays).
   */
  function endTour(): void {
    tourToken++
    wakeDwells()
    if (!tourActive) return
    tourActive = false
    if (tourSaid) { tourSaid = false; opts.onTourStop?.(null) }
    r3?.stopFlight()
    if (disposed) return // the host is taking the view down: nothing is drawn again
    if (tourCard) renderCard(null)
    if (tourLit) setFocus(null)
  }

  async function exec(a: WorldAction, o: { reducedMotion: boolean }): Promise<void> {
    if (!doc || disposed) return
    const instant = o.reducedMotion
    switch (a.type) {
      case 'focus':
      case 'highlight': {
        if (!r3) return
        const ids = shownIds(a.ids)
        if (ids.length === 0) return
        endTour() // a highlight from outside the tour (an answer's) ends it
        setFocus(groupFocus(ids))
        if (a.type === 'focus') await r3.frame(ids, instant)
        return
      }
      case 'flow': {
        if (!r3) return
        endTour()
        setFocus(groupFocus(a.edgeIds))
        await r3.frame(a.edgeIds, instant)
        await r3.pulse(a.edgeIds, instant)
        return
      }
      case 'openCard': {
        // `tech:<term>` opens a glossary card (a term can share its name with a part).
        const tech = a.id.startsWith('tech:')
        await select(tech ? a.id.slice('tech:'.length) : a.id, instant, tech ? 'tech' : undefined)
        return
      }
      case 'tour': {
        endTour()
        const mine = tourToken
        tourActive = true
        // Stops are counted among those on the map as the tour starts: a load that changes the parts ends the tour.
        const of = a.steps.filter((s) => shownIds(s.ids).length > 0).length
        let n = 0
        for (const step of a.steps) {
          if (mine !== tourToken || disposed) return
          // A stop whose parts are all gone from the world is passed over.
          const ids = shownIds(step.ids)
          if (ids.length === 0) continue
          n++
          tourSaid = true
          opts.onTourStop?.({ n, of, caption: step.caption })
          if (selection) { selection = null; emitSelect() }
          renderCard(`<p class="tour-caption">${escapeHtml(step.caption)}</p>`)
          tourCard = true
          if (r3) {
            r3.setSelected(null)
            setFocus(groupFocus(ids))
            tourLit = true
            await r3.frame(ids, instant)
          }
          // Reduced motion drops the flight, not the time to read the caption.
          if (mine === tourToken) await sleep(TOUR_STEP_MS)
        }
        if (mine === tourToken) endTour()
        return
      }
      case 'draftProposal': {
        const p = doc.layers.plan.find((x) => x.id === a.proposalId)
        if (!p) return
        endTour()
        revealProposal = p.id
        redraw()
        const ids = [...p.buildings.map((b) => b.id), ...p.edges.map((e) => e.id)]
        if (r3) {
          setFocus(groupFocus(ids))
          await r3.frame(ids, instant)
        }
        return
      }
      case 'fog': {
        // No ids lifts the fog: the parser never yields that, so only the app asks for it.
        if (a.ids.length === 0) fogged.clear()
        else for (const id of a.ids) fogged.add(id)
        redraw()
        return
      }
      case 'reset': {
        const had = revealProposal !== undefined || fogged.size > 0
        revealProposal = undefined
        fogged.clear()
        exploded = null
        if (had) redraw()
        deselect()
        if (r3) {
          r3.setExploded(null)
          await r3.overview(instant)
        }
        return
      }
    }
  }

  const queue = createActionQueue(exec, undefined, { reducedMotion: () => reduced })

  // The system setting switched while the view is open is followed at once (the queue reads it before each action).
  const onMotionChange = (e: { matches: boolean }): void => {
    if (disposed || e.matches === reduced) return
    reduced = e.matches
    r3?.setReducedMotion(reduced)
  }
  if (motionQuery && typeof motionQuery.addEventListener === 'function') motionQuery.addEventListener('change', onMotionChange)

  /**
   * Stops what is playing: the queue, a tour (its caption and highlight cleared), a pulse, and the camera flight under
   * way, which stops where it is (its promise settles).
   */
  function cancelActions(): void {
    queue.cancel()
    endTour()
    r3?.stopPulses()
    r3?.stopFlight()
  }

  function allIds(): string[] {
    const d = doc
    if (!d) return []
    return [...d.buildings.map((b) => b.id), ...d.externals.map((x) => x.id), ...d.edges.map((e) => e.id)]
  }

  function on(ev: 'select', cb: (sel: WorldSelection | null) => void): () => void
  function on(ev: 'hover', cb: (id: string | null) => void): () => void
  function on(ev: 'graphics', cb: (state: WorldGraphics) => void): () => void
  function on(ev: 'select' | 'hover' | 'graphics', cb: ((sel: WorldSelection | null) => void) | ((id: string | null) => void) | ((state: WorldGraphics) => void)): () => void {
    if (ev === 'graphics') {
      const f = cb as (state: WorldGraphics) => void
      graphicsCbs.add(f)
      return () => { graphicsCbs.delete(f) }
    }
    if (ev === 'select') {
      const f = cb as (sel: WorldSelection | null) => void
      selectCbs.add(f)
      return () => { selectCbs.delete(f) }
    }
    const f = cb as (id: string | null) => void
    hoverCbs.add(f)
    return () => { hoverCbs.delete(f) }
  }

  return {
    load(d, loadOpts = {}) {
      if (disposed) return
      if (r3 && !watchArmed) { watchArmed = true; watch = setTimeout(watchTick, WATCH_TICK_MS) }
      if (loadOpts.statusOnly === true && doc !== null && sameParts(doc, d)) {
        doc = d
        // redraw() lights the selection again, or the tour's or an answer's highlight (baseFocus) while none is open.
        redraw()
        if (selection) renderCard(cardFor(selection))
        return
      }
      cancelActions()
      r3?.stopChanges()
      const diff = loadOpts.animateFrom ? diffWorlds(loadOpts.animateFrom, d) : null
      const motion = r3 !== null && !reduced ? diff : null
      // Removed parts leave the old scene before the redraw clears it, so they can fade out.
      if (motion) r3?.keepGhosts(motion.removed)
      // A newer world of the same project (a watched change, labels that arrived) keeps the view: the
      // camera, the open building and the selection with its card, each while its part still exists.
      // Another project starts afresh from the overview. A Re-layout moves the kept parts: the open
      // building closes, and the camera flies to the kept selection at its new spot, or to the overview.
      const same = doc !== null && doc.projectKey === d.projectKey
      const relaid = same && relaidSince(doc as WorldDoc, d)
      doc = d
      revealProposal = undefined
      fogged.clear()
      if (!same || relaid || (exploded !== null && !d.buildings.some((b) => b.id === exploded))) exploded = null
      const kept = same && selection !== null && kindMatches(selection.id, selection.kind) ? selection : null
      const dropped = selection !== null && kept === null
      selection = kept
      if (dropped) emitSelect()
      // The open card is drawn again from the newer world, so labels that arrived show at once.
      if (kept || dropped) renderCard(kept ? cardFor(kept) : null)
      // redraw() lights the kept selection again.
      if (!kept) baseFocus = null
      redraw()
      if (r3) {
        if (!kept) r3.setSelected(null)
        if (!same) void r3.overview(true)
        else if (relaid) {
          if (kept) {
            const { focus, frameIds } = focusFor(kept)
            void frameOn(r3, kept, focus.ids, frameIds, reduced)
          } else void r3.overview(reduced)
        }
        if (motion) r3.animateChanges({ rise: riseIds(motion), pulse: motion.changed })
      }
      toast.show(diff ? diffSummary(diff) : '', THEMES[themeName])
    },
    setLayers(l) {
      if (disposed) return
      layers = { ...layers, ...l }
      redraw()
    },
    setRightReserve(px, from) {
      if (disposed) return
      sideReserve = px
      toast.place(lowReserve, sideReserve, cardReserve)
      r3?.setRightReserve(px, from)
    },
    setBottomReserve(px) {
      if (disposed) return
      lowReserve = px
      toast.place(lowReserve, sideReserve, cardReserve)
      r3?.setBottomReserve(px)
    },
    setCardReserve(w, h) {
      if (disposed) return
      cardReserve = [w, h]
      toast.place(lowReserve, sideReserve, cardReserve)
      r3?.setCardReserve(w, h)
    },
    setPanels(els) {
      if (!disposed) r3?.setPanels(els)
    },
    setLabelScale(s) {
      if (!disposed) r3?.setLabelScale(s)
    },
    setTheme(t) {
      if (disposed || !THEMES[t]) return
      themeName = t
      r3?.setTheme(t, THEMES[t]) // redraws the current scene with the new palette
    },
    apply: (a) => exec(a, { reducedMotion: reduced }),
    // A newer batch of actions ends a tour still under way, as a newer tour does.
    play: (actions) => { endTour(); return queue.play(actions) },
    cancelActions,
    on,
    getSelection: () => (selection ? [selection.id] : []),
    cameraRegion: () => (r3 ? r3.visibleIds() : allIds()),
    screenPoint: (id) => (r3 ? r3.screenPoint(id) : null),
    linePoints: (id) => (r3 ? r3.linePoints(id) : []),
    pickAt: (x, y) => (r3 ? r3.pick(x, y) : null),
    cameraState: () => (r3 ? r3.getCamera() : null),
    setCamera: (s, instant) => (r3 && !disposed ? r3.flyTo(s, instant || reduced) : Promise.resolve()),
    drawn: () => ({ layers: { ...layers }, ...withAuto(r3 ? r3.drawnCounts() : { processShells: 0, conduits: 0, changing: 0, tier: 'districts' as const, drawCalls: 0, triangles: 0, frames: 0, software: false, presented: 0, contextLost: false, buildings: 0, districts: 0, slabs: 0, slabLooks: [], perf: noPerf() }), wireframes: r3 ? [...wireframes] : [], shownWireframes: shownWires(), outlined: r3 ? [...outlined] : [], fading: r3 ? [...fading] : [], hot: r3 ? [...hot] : [], fogged: [...fogged], highlighted: baseFocus ? [...baseFocus.ids, ...baseFocus.edgeIds] : [], visual: r3 ? r3.motionState() : noVisual() }),
    resetView() {
      cancelActions()
      deselect()
      exploded = null
      if (fogged.size > 0) { fogged.clear(); redraw() }
      if (r3) {
        r3.setExploded(null)
        void r3.overview(reduced)
      }
    },
    setPaused(p) {
      if (disposed) return
      paused = p
      r3?.setPaused(p)
    },
    requestFrame() {
      if (!disposed) r3?.requestFrame()
    },
    perf: () => ({ ...(r3 ? r3.perf() : noPerf()), auto: opts.quality === undefined }),
    perfBegin() {
      r3?.perfBegin()
    },
    perfEnd: () => (r3 ? r3.perfEnd() : frameStats([])),
    setTitle(t) {
      if (disposed || t === title) return
      title = t
      nameCanvas()
      if (!r3) redraw()
    },
    dispose() {
      if (disposed) return
      disposed = true
      clearTimeout(watch)
      cancelActions()
      unwireCanvas()
      if (motionQuery && typeof motionQuery.removeEventListener === 'function') motionQuery.removeEventListener('change', onMotionChange)
      container.removeEventListener('click', onFallbackClick)
      container.removeEventListener('keydown', onKeyDown)
      selectCbs.clear()
      hoverCbs.clear()
      toast.dispose()
      r3?.dispose()
      r3 = null
      if (container.querySelector('section.world-fallback')) container.innerHTML = ''
      doc = null
    },
  }
}
