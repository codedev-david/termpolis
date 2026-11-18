// The Lumopolis viewer: wires a WorldDoc to the scene model, the Three.js drawing layer, the
// focus rules, the action queue and the inspector cards. Without WebGL it shows the 2D list
// (fallback2d.ts) instead, and clicks on that list still raise select events.
// Excluded from the coverage gate (its WebGL path needs a GPU): tests/renderer/world/createWorldViewer.test.ts
// pins the 2D path in jsdom, and e2e/world-engine.spec.ts covers the WebGL path.
import { diffSummary, diffWorlds, riseIds } from '../../../../shared/world/diff'
import { edgeSummary } from '../../../../shared/world/edgeText'
import type { WorldAction, WorldDoc } from '../../../../shared/world/types'
import { ACTION_GAP_MS, createActionQueue } from './actionQueue'
import { focusHolds } from './batching'
import { createChangeToast } from './changeToast'
import { buildingCard, edgeCard, escapeHtml, techCard, usesTech } from './cards'
import { renderFallback } from './fallback2d'
import { neighbours } from './interaction'
import { buildSceneModel, DEFAULT_LAYERS, type LayerState } from './sceneModel'
import type { SlabSignals } from './slabSignals'
import { createThreeRenderer, type MotionState, type RenderFocus, type RenderPick, type SceneText, type ThreeRenderer } from './threeRenderer'
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
  /** Pixels on the right the legend covers now; the overview is fitted to the rest. Ignored without WebGL. */
  setRightReserve(px: number): void
  /** Pixels at the bottom the ask bar covers now; the overview is fitted above it. Ignored without WebGL. */
  setBottomReserve(px: number): void
  /**
   * The open card's box from the view's top left corner (width and height, gaps included; 0, 0 with
   * no card): a focus, a line's close-up or a tour step is framed around it. Ignored without WebGL.
   */
  setCardReserve(w: number, h: number): void
  /** Runs one action now: camera flight, highlight, flow pulse, card open, tour, proposal reveal or reset. */
  apply(a: WorldAction): Promise<void>
  play(actions: WorldAction[]): Promise<void>
  cancelActions(): void
  on(ev: 'select', cb: (sel: WorldSelection | null) => void): () => void
  on(ev: 'hover', cb: (id: string | null) => void): () => void
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
  /** Removes every listener and frees the renderer. Later calls to load() are ignored. */
  dispose(): void
}

export interface WorldLoadOptions {
  animateFrom?: WorldDoc
}

/** The motions and the drawn result as the renderer reports them (MotionState); all empty on the 2D fallback. */
export type WorldDrawnVisual = MotionState
const noVisual = (): WorldDrawnVisual => ({
  ringAngle: 0, fogDrift: 0, wirePulse: 0, selectionRingAngle: 0, bloom: false, stars: 0, dust: 0, platformSides: {}, platformLights: 0,
  floorOrder: {}, orbs: [], exploded: null, explodeGap: 0, flight: { active: false, t: 0, eased: 0 }, lineLabels: 0,
})

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
}

/** True when this browser can create a WebGL context. */
export function hasWebGL(): boolean {
  try {
    const c = document.createElement('canvas')
    const gl = (c.getContext('webgl2') ?? c.getContext('webgl')) as WebGLRenderingContext | null
    if (!gl) return false
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    return true
  } catch {
    return false
  }
}

const DRAG_PX = 5
const TOUR_STEP_MS = ACTION_GAP_MS * 2

function prefersReducedMotion(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

export function createWorldViewer(container: HTMLElement, opts: WorldViewerOptions = {}): WorldViewer {
  const reduced = opts.reducedMotion ?? prefersReducedMotion()
  const renderCard = opts.renderCard ?? ((): void => undefined)
  const selectCbs = new Set<(sel: WorldSelection | null) => void>()
  const hoverCbs = new Set<(id: string | null) => void>()

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
  let disposed = false
  const toast = createChangeToast(container)
  /** The ask bar's and the legend's strips: the toast keeps out of both (the fit gets them too, in 3D). */
  let lowReserve = opts.bottomReserve ?? 0
  let sideReserve = opts.rightReserve ?? 0
  toast.place(lowReserve, sideReserve)

  const pos = getComputedStyle(container).position
  if (pos === '' || pos === 'static') container.style.position = 'relative' // '' = not laid out yet
  if (!container.hasAttribute('tabindex')) container.tabIndex = 0
  container.style.outline = 'none'

  let r3: ThreeRenderer | null = null
  if (hasWebGL()) {
    const before = new Set(Array.from(container.children))
    try {
      r3 = createThreeRenderer(container, {
        quality: opts.quality ?? 'high',
        reducedMotion: reduced,
        onEdgeLabel: (id) => { void select(id) },
        ...(opts.rightReserve !== undefined ? { rightReserve: opts.rightReserve } : {}),
        ...(opts.bottomReserve !== undefined ? { bottomReserve: opts.bottomReserve } : {}),
      })
      r3.setTheme(themeName, THEMES[themeName])
    } catch {
      // createThreeRenderer frees what it made before rethrowing; this also covers a throw from
      // setTheme after it returned. Whatever it appended (canvas, label layer) goes before the 2D list.
      try { r3?.dispose() } catch { /* already half torn down */ }
      r3 = null
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
    baseFocus = f
    showFocus()
  }

  function cardFor(sel: WorldSelection): string | null {
    const d = doc as WorldDoc
    if (sel.kind === 'building') return buildingCard(d, sel.id)
    if (sel.kind === 'edge') return edgeCard(d, sel.id)
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

  /** True when a part both worlds place stands somewhere else in `next`: a Re-layout moved it. */
  function moved(prev: WorldDoc, next: WorldDoc): boolean {
    return Object.entries(prev.layout.positions).some(([id, p]) => {
      const q = next.layout.positions[id]
      return q !== undefined && (q[0] !== p[0] || q[1] !== p[1] || q[2] !== p[2])
    })
  }

  function deselect(): void {
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
    container.innerHTML = renderFallback(d, opts.title ?? 'This project')
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
  let hoverAt: { x: number; y: number } | null = null
  const canvas = r3 ? r3.canvas : null
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
  const onPointerMove = (e: PointerEvent): void => {
    hoverAt = { x: e.clientX, y: e.clientY }
    if (hoverRaf) return
    hoverRaf = requestAnimationFrame(() => {
      hoverRaf = 0
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
  const onFallbackClick = (e: MouseEvent): void => {
    if (r3) return
    const el = (e.target as Element | null)?.closest?.('[data-id]')
    if (!el || !container.contains(el)) return
    const id = el.getAttribute('data-id')
    const kind = el.getAttribute('data-kind')
    const hint = kind === 'building' || kind === 'edge' || kind === 'district' || kind === 'tech' ? kind : undefined
    if (id) void select(id, reduced, hint)
  }
  // The second press of a double-click would select the nearest page text (the legend's heading): the
  // 3D view, and the names drawn over it, have no text to select. A first press keeps its default.
  const onMouseDown = (e: MouseEvent): void => {
    if (e.detail > 1) e.preventDefault()
  }
  const onKeyDown = (e: KeyboardEvent): void => {
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

  // ---------------- actions ----------------
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

  async function exec(a: WorldAction, o: { reducedMotion: boolean }): Promise<void> {
    if (!doc || disposed) return
    const instant = o.reducedMotion
    switch (a.type) {
      case 'focus':
      case 'highlight': {
        if (!r3) return
        setFocus(groupFocus(a.ids))
        if (a.type === 'focus') await r3.frame(a.ids, instant)
        return
      }
      case 'flow': {
        if (!r3) return
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
        const mine = ++tourToken
        for (const step of a.steps) {
          if (mine !== tourToken || disposed) return
          if (selection) { selection = null; emitSelect() }
          renderCard(`<p class="tour-caption">${escapeHtml(step.caption)}</p>`)
          if (r3) {
            r3.setSelected(null)
            setFocus(groupFocus(step.ids))
            await r3.frame(step.ids, instant)
          }
          if (!instant && mine === tourToken) await sleep(TOUR_STEP_MS)
        }
        return
      }
      case 'draftProposal': {
        const p = doc.layers.plan.find((x) => x.id === a.proposalId)
        if (!p) return
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

  const queue = createActionQueue(exec, undefined, { reducedMotion: reduced })

  function cancelActions(): void {
    queue.cancel()
    tourToken++
    r3?.stopPulses()
  }

  function allIds(): string[] {
    const d = doc
    if (!d) return []
    return [...d.buildings.map((b) => b.id), ...d.externals.map((x) => x.id), ...d.edges.map((e) => e.id)]
  }

  function on(ev: 'select', cb: (sel: WorldSelection | null) => void): () => void
  function on(ev: 'hover', cb: (id: string | null) => void): () => void
  function on(ev: 'select' | 'hover', cb: ((sel: WorldSelection | null) => void) | ((id: string | null) => void)): () => void {
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
      const relaid = same && moved(doc as WorldDoc, d)
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
    setRightReserve(px) {
      if (disposed) return
      sideReserve = px
      toast.place(lowReserve, sideReserve)
      r3?.setRightReserve(px)
    },
    setBottomReserve(px) {
      if (disposed) return
      lowReserve = px
      toast.place(lowReserve, sideReserve)
      r3?.setBottomReserve(px)
    },
    setCardReserve(w, h) {
      if (!disposed) r3?.setCardReserve(w, h)
    },
    setTheme(t) {
      if (disposed || !THEMES[t]) return
      themeName = t
      r3?.setTheme(t, THEMES[t]) // redraws the current scene with the new palette
    },
    apply: (a) => exec(a, { reducedMotion: reduced }),
    play: (actions) => queue.play(actions),
    cancelActions,
    on,
    getSelection: () => (selection ? [selection.id] : []),
    cameraRegion: () => (r3 ? r3.visibleIds() : allIds()),
    screenPoint: (id) => (r3 ? r3.screenPoint(id) : null),
    linePoints: (id) => (r3 ? r3.linePoints(id) : []),
    pickAt: (x, y) => (r3 ? r3.pick(x, y) : null),
    cameraState: () => (r3 ? r3.getCamera() : null),
    setCamera: (s, instant) => (r3 && !disposed ? r3.flyTo(s, instant || reduced) : Promise.resolve()),
    drawn: () => ({ layers: { ...layers }, ...(r3 ? r3.drawnCounts() : { processShells: 0, conduits: 0, changing: 0, tier: 'districts' as const, drawCalls: 0, buildings: 0, districts: 0, slabs: 0, slabLooks: [] }), wireframes: r3 ? [...wireframes] : [], outlined: r3 ? [...outlined] : [], fading: r3 ? [...fading] : [], hot: r3 ? [...hot] : [], fogged: [...fogged], highlighted: baseFocus ? [...baseFocus.ids, ...baseFocus.edgeIds] : [], visual: r3 ? r3.motionState() : noVisual() }),
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
      if (!disposed) r3?.setPaused(p)
    },
    dispose() {
      if (disposed) return
      disposed = true
      cancelActions()
      if (hoverRaf) cancelAnimationFrame(hoverRaf)
      if (canvas) {
        canvas.removeEventListener('pointerdown', onPointerDown)
        canvas.removeEventListener('pointerup', onPointerUp)
        canvas.removeEventListener('click', onClick)
        canvas.removeEventListener('dblclick', onDblClick)
        canvas.removeEventListener('pointermove', onPointerMove)
        canvas.removeEventListener('pointerleave', onPointerLeave)
        container.removeEventListener('mousedown', onMouseDown)
      }
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
