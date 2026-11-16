// The Lumopolis viewer: wires a WorldDoc to the scene model, the Three.js drawing layer, the
// focus rules, the action queue and the inspector cards. Without WebGL it shows the 2D list
// (fallback2d.ts) instead, and clicks on that list still raise select events.
// Excluded from the coverage gate (its WebGL path needs a GPU): tests/renderer/world/createWorldViewer.test.ts
// pins the 2D path in jsdom, and e2e/world-engine.spec.ts covers the WebGL path.
import { diffSummary, diffWorlds, riseIds } from '../../../../shared/world/diff'
import type { WorldAction, WorldDoc } from '../../../../shared/world/types'
import { ACTION_GAP_MS, createActionQueue } from './actionQueue'
import { createChangeToast } from './changeToast'
import { buildingCard, edgeCard, escapeHtml, techCard, usesTech } from './cards'
import { renderFallback } from './fallback2d'
import { neighbours } from './interaction'
import { buildSceneModel, DEFAULT_LAYERS, type LayerState } from './sceneModel'
import { createThreeRenderer, type RenderFocus, type SceneText, type ThreeRenderer } from './threeRenderer'
import { THEMES, type ThemeName } from './themes'

export type SelectionKind = 'building' | 'edge' | 'district' | 'tech'
export interface WorldSelection { kind: SelectionKind; id: string }

export interface WorldViewer {
  /**
   * Draws a world. With animateFrom (the previous world of the same project) the parts that changed
   * rise, pulse or fade (not with reduced motion) and a toast such as "+3 parts, 2 changed" shows.
   */
  load(doc: WorldDoc, opts?: WorldLoadOptions): void
  setLayers(l: Partial<LayerState>): void
  setTheme(t: ThemeName): void
  /** Runs one action now: camera flight, highlight, flow pulse, card open, tour, proposal reveal or reset. */
  apply(a: WorldAction): Promise<void>
  play(actions: WorldAction[]): Promise<void>
  cancelActions(): void
  on(ev: 'select', cb: (sel: WorldSelection | null) => void): () => void
  on(ev: 'hover', cb: (id: string | null) => void): () => void
  getSelection(): string[]
  /** Ids of the buildings, externals and edges currently in view. */
  cameraRegion(): string[]
  /** Where a building or external is on screen, in client pixels: null when it is not drawn in 3D or not in view. */
  screenPoint(id: string): { x: number; y: number } | null
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

export interface WorldDrawn {
  layers: LayerState
  processShells: number
  conduits: number
  /** Rises, pulses and fades still running (always 0 in 2D). */
  changing: number
  /** Ids of the buildings drawn as wireframes: planned parts not built yet (always empty in 2D). */
  wireframes: string[]
}

export interface WorldViewerOptions {
  quality?: 'high' | 'low'
  reducedMotion?: boolean
  /** Receives the inspector card HTML for the selection, or null when nothing is selected. */
  renderCard?: (html: string | null) => void
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
  let selection: WorldSelection | null = null
  let exploded: string | null = null
  let hovered: string | null = null
  let tourToken = 0
  let disposed = false
  const toast = createChangeToast(container)

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
        onEdgeLabel: (id) => { void select(id, true) },
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
    const d = doc
    const out: RenderFocus = { ids: new Set(), edgeIds: new Set() }
    if (!d) return out
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
  /** `hint` is the kind the 2D list tagged the item with; it wins when the id names more than one thing. */
  function select(id: string, fly: boolean, instant = reduced, hint?: SelectionKind): Promise<void> {
    const kind = hint !== undefined && kindMatches(id, hint) ? hint : kindOf(id)
    if (!kind) return Promise.resolve()
    selection = { kind, id }
    const { focus, frameIds } = focusFor(selection)
    renderCard(cardFor(selection))
    emitSelect()
    if (!r3) return Promise.resolve()
    r3.setSelected(kind === 'building' ? id : null)
    r3.setFocus(focus)
    return fly ? r3.frame(frameIds, instant) : Promise.resolve()
  }

  function deselect(): void {
    const had = selection !== null
    selection = null
    renderCard(null)
    if (r3) { r3.setSelected(null); r3.setFocus(null) }
    if (had) emitSelect()
  }

  // ---------------- drawing ----------------
  function sceneText(d: WorldDoc): SceneText {
    const text: SceneText = { labels: {}, floors: {}, districts: {}, edges: {}, processes: d.processes, cargoShapes: {} }
    for (const b of [...d.buildings, ...planBuildings(d)]) {
      if (text.labels[b.id] !== undefined) continue
      text.labels[b.id] = layers.labels === 'tech' ? b.techLabel : b.name
      text.floors[b.id] = b.floors.map((f) => f.name)
    }
    for (const x of d.externals) text.labels[x.id] = x.name
    for (const x of d.districts) text.districts[x.id] = x.subtitle
    for (const e of [...d.edges, ...planEdges(d)]) if (text.edges[e.id] === undefined) text.edges[e.id] = e.label
    for (const [k, c] of Object.entries(d.cargo)) text.cargoShapes[k] = c.shape
    return text
  }

  let wireframes: string[] = []
  function redraw(): void {
    const d = doc
    if (!d) return
    if (!r3) { drawFallback(d); return }
    const model = buildSceneModel(d, layers, revealProposal === undefined ? undefined : { revealProposal })
    wireframes = model.buildings.filter((b) => b.look === 'wire').map((b) => b.id)
    r3.draw(model, sceneText(d), layers.allLineLabels)
    r3.setExploded(exploded)
    if (selection && kindOf(selection.id)) {
      const { focus } = focusFor(selection)
      r3.setSelected(selection.kind === 'building' ? selection.id : null)
      r3.setFocus(focus)
    }
  }

  // ---------------- 2D fallback ----------------
  // renderFallback tags each item with data-kind and data-id; clicks are wired from those.
  function drawFallback(d: WorldDoc): void {
    container.innerHTML = renderFallback(d)
    for (const el of Array.from(container.querySelectorAll<HTMLElement>('[data-id]'))) el.style.cursor = 'pointer'
  }

  // ---------------- input ----------------
  let down: { x: number; y: number } | null = null
  let hoverRaf = 0
  let hoverAt: { x: number; y: number } | null = null
  const canvas = r3 ? r3.canvas : null

  const onPointerDown = (e: PointerEvent): void => {
    down = { x: e.clientX, y: e.clientY }
    container.focus({ preventScroll: true })
  }
  const onClick = (e: MouseEvent): void => {
    if (!r3) return
    const start = down
    down = null
    if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > DRAG_PX) return
    const hit = r3.pick(e.clientX, e.clientY)
    if (hit) void select(hit.id, true)
    else deselect()
  }
  const onDblClick = (e: MouseEvent): void => {
    if (!r3) return
    const hit = r3.pick(e.clientX, e.clientY)
    if (!hit || hit.kind !== 'node') return
    // Only buildings open floor by floor; an external is an orb with nothing inside.
    if (!doc?.externals.some((x) => x.id === hit.id)) {
      exploded = exploded === hit.id ? null : hit.id
      r3.setExploded(exploded)
    }
    void select(hit.id, true)
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
        r3.setHovered(hit && hit.kind === 'node' ? hit.id : null)
        for (const cb of hoverCbs) cb(id)
      }
    })
  }
  const onPointerLeave = (): void => {
    hoverAt = null
    if (hovered !== null) {
      hovered = null
      r3?.setHovered(null)
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
    if (id) void select(id, false, reduced, hint)
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
    canvas.addEventListener('click', onClick)
    canvas.addEventListener('dblclick', onDblClick)
    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerleave', onPointerLeave)
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
        r3.setFocus(groupFocus(a.ids))
        if (a.type === 'focus') await r3.frame(a.ids, instant)
        return
      }
      case 'flow': {
        if (!r3) return
        r3.setFocus(groupFocus(a.edgeIds))
        await r3.frame(a.edgeIds, instant)
        await r3.pulse(a.edgeIds, instant)
        return
      }
      case 'openCard':
        await select(a.id, true, instant)
        return
      case 'tour': {
        const mine = ++tourToken
        for (const step of a.steps) {
          if (mine !== tourToken || disposed) return
          if (selection) { selection = null; emitSelect() }
          renderCard(`<p class="tour-caption">${escapeHtml(step.caption)}</p>`)
          if (r3) {
            r3.setSelected(null)
            r3.setFocus(groupFocus(step.ids))
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
          r3.setFocus(groupFocus(ids))
          await r3.frame(ids, instant)
        }
        return
      }
      case 'reset': {
        const had = revealProposal !== undefined
        revealProposal = undefined
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
      doc = d
      revealProposal = undefined
      exploded = null
      const hadSelection = selection !== null
      selection = null
      if (hadSelection) { renderCard(null); emitSelect() }
      redraw()
      if (r3) {
        r3.setSelected(null)
        r3.setFocus(null)
        void r3.overview(true)
        if (motion) r3.animateChanges({ rise: riseIds(motion), pulse: motion.changed })
      }
      toast.show(diff ? diffSummary(diff) : '', THEMES[themeName])
    },
    setLayers(l) {
      if (disposed) return
      layers = { ...layers, ...l }
      redraw()
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
    drawn: () => ({ layers: { ...layers }, ...(r3 ? r3.drawnCounts() : { processShells: 0, conduits: 0, changing: 0 }), wireframes: r3 ? [...wireframes] : [] }),
    resetView() {
      cancelActions()
      deselect()
      exploded = null
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
        canvas.removeEventListener('click', onClick)
        canvas.removeEventListener('dblclick', onDblClick)
        canvas.removeEventListener('pointermove', onPointerMove)
        canvas.removeEventListener('pointerleave', onPointerLeave)
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
