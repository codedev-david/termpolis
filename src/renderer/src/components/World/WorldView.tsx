// Lumopolis: the full-screen world view. It opens on the active terminal's project (the git root of
// the folder it is given, or that folder), asks main for the stored world, compiles one when there
// is none (showing the compile's progress), and draws it with the engine's viewer. Without WebGL it
// shows the engine's 2D list instead. With no folder it shows the home (WorldHome); the toolbar's
// switcher opens any recent world or the home (useOpenWorld). A design world (design:<id>) loads
// through world:design-get and is drawn with the planned layer on; Build it (design worlds only)
// links the design to a folder, opens the agent there and switches to that folder's world.
//
// Esc: one window listener in the capture phase, so it runs before the viewer's own container
// handler and before App's shortcuts. It only acts when the key comes from inside the pane (or
// from nowhere in particular: body), never from a dialog opened on top of it such as the command
// palette. The first Esc closes the re-layout question if it is open, else resets the view; a
// second Esc in a row closes the pane. Anything the user does in between (selecting, a card, a
// tour, dragging the map) makes the next Esc a reset again.
//
// Focus: the pane is modal. useFocusTrap keeps Tab and Shift+Tab inside it (so no key reaches the
// terminal under it) and, on close, gives the focus back to the control that opened it, or to the
// active terminal.
//
// Layout: the pane sits below the app's title bar (worldPane), toolbar on top and the map under
// it, in the theme's background from the first frame. The map's overlays (legend top right, card
// top left, notices, the ask box) are placed with inline styles. While the home or a loading screen
// covers the map, the viewer is paused so a hidden scene draws no frames.
//
// E2E only (TERMPOLIS_TEST_WORLD_PROBE): window.__termpolis_world, a read-only probe of the map
// (a part's place on screen, what is drawn), so a spec can click a building and see a layer change
// without guessing at the 3D scene. Off in every normal run.
import { useEffect, useRef, useState } from 'react'
import type { MouseEvent, ReactNode } from 'react'
import type { BuildItResult, Tour, WorldDoc } from '../../../../shared/world/types'
import { buildingCard, createWorldViewer, DEFAULT_LAYERS, edgeCard, hasWebGL, renderFallback, THEMES } from '../../world/engine'
import type { LayerState, ThemeName, WorldDrawn, WorldViewer } from '../../world/engine'
import { exposesWorldProbe } from '../../lib/testAgents'
import { WorldToolbar } from './WorldToolbar'
import { WorldCard } from './WorldCard'
import { WorldEmptyState } from './WorldEmptyState'
import { focusTerminal } from '../../lib/accountMenu'
import { useTerminalStore } from '../../store/terminalStore'
import { useOpenWorld } from './useOpenWorld'
import { WorldHome } from './WorldHome'
import { WorldSwitcher } from './WorldSwitcher'
import { BuildItDialog } from './BuildItDialog'
import { legendDefaultOpen, legendReserve, WorldLegend } from './WorldLegend'
import { ASK_BOTTOM_PX, ASK_SLOT_WIDTH, askReserve, cardMaxHeight, cardReserve, worldPaneStyle } from './worldPane'
import { rightInset } from '../../world/engine/viewMath'
import type { BuildAgent } from './BuildItDialog'
import type { OpenTarget } from './worldTargets'

export interface WorldViewProps {
  /** A folder inside the project (the active terminal's cwd). Empty when there is none. */
  root: string
  onClose: () => void
  /**
   * Plan 2's ask box: rendered at the bottom centre with the viewer (null without WebGL), the world,
   * the world's key (the project root it was drawn for, or design:<id> for a design; null until it
   * is known) and the link through which the box takes Esc first, holds newer worlds while it
   * answers and hands back a changed design. Not shown on the home.
   */
  askSlot?: (viewer: WorldViewer | null, doc: WorldDoc | null, worldKey: string | null, link: WorldAskLink) => ReactNode
  /** Build it on design worlds: the agents it can start, and how App opens the agent terminal. */
  buildIt?: { agents: BuildAgent[]; defaultAgent?: string; launch: (res: BuildItResult, agentId: string) => void }
  /** The pane's width in px (App owns it: the divider and the window size change it). */
  width?: number
}

/** The width a pane gets from no one (a test, a stand-alone mount). */
const DEFAULT_WIDTH = 480

/** How the ask box and the pane share Esc and world swaps. */
export interface WorldAskLink {
  /** The box's Esc handler, asked before the pane's own; true when it used the key. null removes it. */
  onEscape(fn: (() => boolean) | null): void
  /** True while an answer is under way: a world update waits, so the answer's tour is not wiped. */
  setBusy(busy: boolean): void
  /** A design changed by the box (design mode): the pane draws it, growing from the one it showed. */
  setDoc(doc: WorldDoc): void
}

/** The e2e probe on window.__termpolis_world. */
export interface WorldProbe {
  screenPoint(id: string): { x: number; y: number } | null
  linePoints(id: string): Array<{ x: number; y: number }>
  pickAt(x: number, y: number): { kind: 'node' | 'edge'; id: string } | null
  drawn(): WorldDrawn
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const baseName = (p: string): string => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() as string
/** A building's or a connection's card, straight from the doc (the 2D view); null when the id names neither. */
const partCard = (d: WorldDoc, id: string): string | null => buildingCard(d, id) || edgeCard(d, id) || null

export function WorldView({ root, onClose, askSlot, buildIt, width = DEFAULT_WIDTH }: WorldViewProps): JSX.Element {
  const { world, open, goHome, entries, refresh } = useOpenWorld(root)
  const [webgl] = useState(() => hasWebGL())
  const [viewer, setViewer] = useState<WorldViewer | null>(null)
  const [resolvedRoot, setResolvedRoot] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [doc, setDoc] = useState<WorldDoc | null>(null)
  const [mapping, setMapping] = useState(false)
  const [progress, setProgress] = useState<{ stage: string; pct: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [card, setCard] = useState<string | null>(null)
  const [layers, setLayersState] = useState<LayerState>(DEFAULT_LAYERS)
  // The legend is expanded on a wide pane and a chip on a narrow one, until the user chooses.
  const [legendChoice, setLegendChoice] = useState<boolean | null>(null)
  const legendOpen = legendChoice ?? legendDefaultOpen(width)
  const legendOpenRef = useRef(legendOpen)
  legendOpenRef.current = legendOpen
  const widthRef = useRef(width)
  widthRef.current = width
  const [theme, setThemeState] = useState<ThemeName>('neon')
  const [confirmRelayout, setConfirmRelayout] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [building, setBuilding] = useState(false)
  // The open world: a folder (its key is the resolved root) or a design.
  const target = world.kind === 'root' ? world.root : ''
  const follow = world.kind === 'root' && world.follow
  const designKey = world.kind === 'design' ? world.key : null
  // A root resolved for an earlier folder is never used for a design or the home.
  const worldRoot = world.kind === 'root' ? resolvedRoot : null

  const dialogRef = useRef<HTMLDivElement>(null)
  // True while the focus is somewhere in the pane. When a focused child unmounts (a card or dialog
  // closes) the browser drops the focus to the body: take it back, so Esc keeps working.
  const hadFocusRef = useRef(false)
  const hostRef = useRef<HTMLDivElement>(null)
  // Latest values for the long-lived listeners (push events, Esc).
  const rootRef = useRef<string | null>(null)
  rootRef.current = worldRoot
  const docRef = useRef<WorldDoc | null>(null)
  docRef.current = doc
  /** True after an Esc reset with nothing done since: the next Esc closes. */
  const armedRef = useRef(false)
  const escRef = useRef<() => void>(onClose) // replaced on every render, below
  /**
   * The doc the viewer holds, so the same world arriving twice (a compile, then its own push) loads
   * once, and a newer world of the same project animates from it.
   */
  const loadedRef = useRef<WorldDoc | null>(null)
  /** The part whose card is open in the 2D view (its card is rebuilt when a newer world arrives). */
  const fallbackIdRef = useRef<string | null>(null)
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])
  // The ask box's side: its Esc handler, whether it is answering, and a world held back meanwhile.
  const askEscRef = useRef<(() => boolean) | null>(null)
  const askBusyRef = useRef(false)
  const heldDocRef = useRef<WorldDoc | null>(null)
  const [askLink] = useState<WorldAskLink>(() => ({
    onEscape: (fn) => { askEscRef.current = fn },
    setBusy: (b) => {
      askBusyRef.current = b
      const held = heldDocRef.current
      if (b || held === null) return
      heldDocRef.current = null
      if (!mountedRef.current) return
      setError(null)
      setDoc(held)
    },
    setDoc: (d) => {
      if (!mountedRef.current) return
      setError(null)
      setDoc(d)
    },
  }))

  // Take the focus on open (so Esc reaches the pane), and give it back on close: to the control that
  // opened it, else to the active terminal. No trap: the terminals beside it stay in reach.
  useEffect(() => {
    const el = dialogRef.current as HTMLDivElement
    const before = document.activeElement as HTMLElement | null
    el.focus()
    return () => {
      if (before && before !== document.body && document.contains(before)) before.focus()
      else {
        const id = useTerminalStore.getState().activeTerminalId
        if (id) focusTerminal(id)
      }
    }
  }, [])

  // A terminal still dictating behind the pane would also type what is said to the Ask mic: stop it.
  useEffect(() => { window.dispatchEvent(new Event('termpolis:stopDictation')) }, [])

  // The project root: for the active terminal's folder, its git root (or the folder itself outside a
  // repository; a cd inside the same repository resolves to the same root, so nothing below runs
  // again). A folder the user chose is used as it is: that is the world they asked for.
  useEffect(() => {
    if (!target) { setResolvedRoot(null); return }
    if (!follow) { setResolvedRoot(target); return }
    let live = true
    window.termpolis.gitFindRoot(target).then(
      (r) => { if (live) setResolvedRoot(r.success && r.data ? r.data : target) },
      () => { if (live) setResolvedRoot(target) },
    )
    return () => { live = false }
  }, [target, follow])

  // The world: a design from the design store; for a folder the stored one, or a fresh compile when
  // none was saved yet. The home: nothing (the viewer is hidden while there is no doc, so no stale
  // map stays up).
  useEffect(() => {
    heldDocRef.current = null
    setDoc(null)
    setError(null)
    setMapping(false)
    setProgress(null)
    setCard(null)
    let live = true
    const api = window.termpolis
    if (designKey !== null) {
      api.worldDesignGet(designKey).then(
        (res) => {
          if (!live) return
          if (res.success) setDoc(res.data)
          else setError(res.error)
        },
        (e: unknown) => { if (live) setError(messageOf(e)) },
      )
      return () => { live = false }
    }
    if (worldRoot === null) return
    const at = worldRoot
    api.worldGet(at)
      .then((res) => {
        if (!live) return
        if (!res.success) { setError(res.error); return }
        if (res.data) { setDoc(res.data); return }
        setMapping(true)
        return api.worldCompile(at).then((c) => {
          if (!live) return
          setMapping(false)
          if (c.success) setDoc(c.data)
          else setError(c.error)
        })
      })
      .catch((e: unknown) => {
        if (!live) return
        setMapping(false)
        setError(messageOf(e))
      })
    return () => { live = false }
  }, [worldRoot, designKey, attempt])

  // Pushes from main: compile progress, and a saved world (a compile, or a watched change).
  useEffect(() => {
    const mine = (e: { root: string; projectKey: string }): boolean =>
      e.root === rootRef.current || (docRef.current !== null && e.projectKey === docRef.current.projectKey)
    const offProgress = window.termpolis.onWorldProgress((e) => {
      if (mine(e)) setProgress({ stage: e.stage, pct: e.pct })
    })
    const offUpdated = window.termpolis.onWorldUpdated((e) => {
      const at = rootRef.current
      if (!mine(e) || at === null) return
      window.termpolis.worldGet(at).then(
        (res) => {
          if (!res.success || !res.data || rootRef.current !== at) return
          // Loading a world stops the answer's tour, so it waits until the answer is over.
          if (askBusyRef.current) { heldDocRef.current = res.data; return }
          setError(null)
          setDoc(res.data)
        },
        () => undefined,
      )
    })
    return () => { offProgress(); offUpdated() }
  }, [])

  // The overview is fitted to what the legend leaves free: it follows the legend and the pane's width.
  const reserve = legendReserve(legendOpen, width)
  useEffect(() => { viewer?.setRightReserve(reserve) }, [viewer, reserve])
  // ...and to what the ask bar leaves free above it: its measured height, which changes as its chips
  // wrap in a narrow pane, or as it thinks and answers.
  const askRef = useRef<HTMLDivElement>(null)
  const [askHeight, setAskHeight] = useState(0)
  const showAsk = !!askSlot && world.kind !== 'home'
  useEffect(() => {
    const el = askRef.current
    if (!el) { setAskHeight(0); return }
    const read = (): void => setAskHeight(el.offsetHeight)
    read()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [showAsk])
  const below = askReserve(askHeight)
  useEffect(() => { viewer?.setBottomReserve(below) }, [viewer, below])
  // A focus, a line's close-up or a tour step is framed beside the open card: its measured box, read
  // again when it opens, shows another part, or changes size; none while it is closed.
  const cardRef = useRef<HTMLElement>(null)
  const [cardSize, setCardSize] = useState<[number, number]>([0, 0])
  useEffect(() => {
    const el = cardRef.current
    if (!el) { setCardSize([0, 0]); return }
    const read = (): void => setCardSize([el.offsetWidth, el.offsetHeight])
    read()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [card])
  const [cardW, cardH] = cardReserve(cardSize[0], cardSize[1])
  // In a narrow pane a tall card is capped so the city keeps room below it (cardMaxHeight): the stage's
  // measured size, read again as the pane or the window changes.
  const stageRef = useRef<HTMLDivElement>(null)
  const [stageSize, setStageSize] = useState<[number, number]>([0, 0])
  useEffect(() => {
    const el = stageRef.current as HTMLDivElement
    const read = (): void => setStageSize([el.clientWidth, el.clientHeight])
    read()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const cardCap = cardMaxHeight(stageSize[0], stageSize[1], rightInset(stageSize[0], reserve), below)
  useEffect(() => { viewer?.setCardReserve(cardW, cardH) }, [viewer, cardW, cardH])

  // The 3D viewer, once, when WebGL is there.
  useEffect(() => {
    if (!webgl) return
    const v = createWorldViewer(hostRef.current as HTMLDivElement, {
      rightReserve: legendReserve(legendOpenRef.current, widthRef.current),
      renderCard: (html) => {
        if (html !== null) armedRef.current = false
        setCard(html)
      },
    })
    const offSelect = v.on('select', (sel) => { if (sel) armedRef.current = false })
    setViewer(v)
    return () => {
      offSelect()
      v.dispose()
    }
  }, [webgl])

  // Nothing to draw while the home or a loading screen covers the map: stop the render loop.
  const covered = world.kind === 'home' || !doc
  useEffect(() => { viewer?.setPaused(covered) }, [viewer, covered])

  // The e2e probe, while this viewer is up (and only under the test flag).
  useEffect(() => {
    if (!viewer || !exposesWorldProbe()) return
    const w = window as unknown as { __termpolis_world?: WorldProbe }
    const probe: WorldProbe = { screenPoint: (id) => viewer.screenPoint(id), linePoints: (id) => viewer.linePoints(id), pickAt: (x, y) => viewer.pickAt(x, y), drawn: () => viewer.drawn() }
    w.__termpolis_world = probe
    return () => { if (w.__termpolis_world === probe) delete w.__termpolis_world }
  }, [viewer])

  useEffect(() => {
    if (!viewer || !doc) return
    const held = loadedRef.current
    if (held && held.projectKey === doc.projectKey && held.generatedAt === doc.generatedAt) return
    loadedRef.current = doc
    // A newer world of the same project (a labelled follow-up, a watched change) keeps the open
    // part: load() clears the selection, so it is opened again when the part still exists.
    const same = held !== null && held.projectKey === doc.projectKey
    const keep = same ? viewer.getSelection()[0] : undefined
    // The same project grows from the world it showed: new parts rise, changed ones pulse.
    if (same) viewer.load(doc, { animateFrom: held })
    else viewer.load(doc)
    if (keep !== undefined) void viewer.apply({ type: 'openCard', id: keep })
  }, [viewer, doc])

  // In 2D the card is built from the doc: a newer world rebuilds the open one (or closes it when
  // its part is gone).
  useEffect(() => {
    const id = fallbackIdRef.current
    if (viewer || !doc || id === null) return
    setCard((c) => (c === null ? null : partCard(doc, id)))
  }, [viewer, doc])

  const onLayers = (patch: Partial<LayerState>): void => {
    setLayersState((l) => ({ ...l, ...patch }))
    viewer?.setLayers(patch)
  }
  const onTheme = (t: ThemeName): void => {
    setThemeState(t)
    viewer?.setTheme(t)
  }
  const onTour = (tour: Tour): void => {
    armedRef.current = false
    if (viewer) void viewer.play([{ type: 'tour', steps: tour.steps }])
    else setCard(null)
  }
  const resetView = (): void => {
    armedRef.current = true
    setCard(null)
    viewer?.resetView()
  }
  /** Open a part's card: through the viewer (it flies there), or straight from the doc in 2D. */
  const openPart = (id: string): void => {
    armedRef.current = false
    if (viewer) { void viewer.apply({ type: 'openCard', id }); return }
    const d = docRef.current as WorldDoc
    fallbackIdRef.current = id
    setCard(partCard(d, id))
  }
  const onFallbackClick = (e: MouseEvent<HTMLDivElement>): void => {
    const item = (e.target as Element).closest('[data-kind][data-id]')
    if (!item) return
    const kind = item.getAttribute('data-kind')
    if (kind === 'district') { armedRef.current = false; setCard(null); return }
    openPart(item.getAttribute('data-id') as string)
  }
  /** Opens a world from the home, the switcher or Build it; `planned` turns the plan overlay on. */
  const openWorld = (t: OpenTarget, planned = t.kind === 'design'): void => {
    armedRef.current = false
    setConfirmRelayout(false)
    setBuilding(false)
    setNotice(null)
    // The root resolved for the world shown before must not load for this one meanwhile.
    setResolvedRoot(null)
    if (planned) onLayers({ planned: true })
    open(t)
  }
  const onBuilt = (res: BuildItResult, agentId: string): void => {
    // The folder's world, with the design's plan over it, while the agent builds there.
    openWorld({ kind: 'root', root: res.root }, true)
    refresh()
    ;(buildIt as NonNullable<WorldViewProps['buildIt']>).launch(res, agentId)
  }
  const relayout = (): void => {
    // The root at click time: an answer for a project the pane has since left is dropped.
    const at = worldRoot as string
    const current = (): boolean => mountedRef.current && rootRef.current === at
    setConfirmRelayout(false)
    setBusy(true)
    setNotice(null)
    window.termpolis.worldRelayout(at)
      .then((res) => {
        if (!current()) return
        if (res.success) setDoc(res.data)
        else setNotice(`Re-layout failed: ${res.error}`)
      })
      .catch((e: unknown) => { if (current()) setNotice(`Re-layout failed: ${messageOf(e)}`) })
      .finally(() => { if (mountedRef.current) setBusy(false) })
  }

  useEffect(() => {
    if (!hadFocusRef.current) return
    const active = document.activeElement
    if (active === document.body) (dialogRef.current as HTMLDivElement).focus()
    else if (!(dialogRef.current as HTMLDivElement).contains(active)) hadFocusRef.current = false
  })

  escRef.current = () => {
    if (confirmRelayout) { setConfirmRelayout(false); return }
    if (building) { setBuilding(false); return }
    // The ask box first: an Esc that stops its speech or its question leaves the camera alone.
    if (askEscRef.current?.()) { armedRef.current = false; return }
    if (armedRef.current && card === null) { onClose(); return }
    resetView()
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      const t = e.target as Node | null
      const inside = (dialogRef.current as HTMLDivElement).contains(t)
      if (!inside) return
      e.preventDefault()
      e.stopPropagation()
      escRef.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  // The folder's name, never doc.projectKey: that is a sha1 slice of the path, not a name. A doc only
  // loads for a resolved root, and WorldDoc carries no root of its own to fall back on. A design is
  // named by its title in the recent worlds.
  const home = world.kind === 'home'
  const designTitle = designKey === null ? '' : entries.find((e) => e.key === designKey)?.title ?? 'Design'
  const projectName = designKey !== null ? designTitle : worldRoot ? baseName(worldRoot) : ''
  const worldKey = worldRoot ?? designKey
  let empty: 'loading' | 'mapping' | 'error' | null = null
  if (home) empty = null
  else if (error !== null) empty = 'error'
  else if (!doc) empty = mapping ? 'mapping' : 'loading'

  return (
    <div
      ref={dialogRef}
      role="region"
      aria-label="Lumopolis"
      tabIndex={-1}
      data-testid="world-view"
      className="outline-none"
      style={worldPaneStyle(THEMES[theme].background, width)}
      onFocusCapture={() => { hadFocusRef.current = true }}
    >
      <WorldToolbar
        projectName={projectName}
        layers={layers}
        onLayers={onLayers}
        theme={theme}
        onTheme={onTheme}
        tours={doc ? doc.tours : []}
        onTour={onTour}
        onResetView={resetView}
        onRelayout={() => setConfirmRelayout(true)}
        relayoutDisabled={worldRoot === null || !doc || busy}
        onClose={onClose}
        switcher={<WorldSwitcher entries={entries} onOpen={(t) => openWorld(t)} onHome={goHome} />}
        onBuildIt={designKey !== null && buildIt && doc ? () => setBuilding(true) : undefined}
      />
      <div ref={stageRef} data-testid="world-stage" style={{ position: 'relative', flex: '1 1 auto', minHeight: 0, overflow: 'hidden' }}>
        {webgl && (
          <div
            ref={hostRef}
            data-testid="world-canvas-host"
            // Its own stacking context beneath the panels: the label layer numbers each label's
            // z-index up from zero, which would otherwise draw names over the card and legend.
            style={{ position: 'absolute', inset: 0, zIndex: 0, isolation: 'isolate', visibility: doc ? 'visible' : 'hidden' }}
            onPointerDown={() => { armedRef.current = false }}
          />
        )}
        {!webgl && doc && (
          <div
            data-testid="world-fallback"
            className="overflow-auto p-6 text-sm [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:mt-3 [&_h3]:font-semibold [&_li]:cursor-pointer [&_ul]:pl-4 [&_p]:text-[#9ca3af]"
            style={{ position: 'absolute', inset: 0 }}
            onClick={onFallbackClick}
            // renderFallback escapes every string from the doc.
            dangerouslySetInnerHTML={{ __html: renderFallback(doc) }}
          />
        )}
        {home && <WorldHome entries={entries} projectCwd={root} onOpen={(t) => openWorld(t)} onChanged={refresh} />}
        {empty && (
          <WorldEmptyState
            mode={empty}
            progress={progress}
            error={error}
            onRetry={() => setAttempt((n) => n + 1)}
          />
        )}
        {webgl && doc && !home && <WorldLegend doc={doc} processes={layers.processes} open={legendOpen} onToggle={() => setLegendChoice(!legendOpen)} />}
        {confirmRelayout && (
          <div
            role="alertdialog"
            aria-label="Confirm re-layout"
            data-testid="world-relayout-confirm"
            className="p-3 rounded border border-[#3c3c3c] shadow-xl flex flex-col gap-2 text-xs"
            style={{ position: 'absolute', top: 12, right: 12, width: 320, zIndex: 5, background: '#252526' }}
          >
            <p>Re-layout places every part again from scratch and forgets the current arrangement. Continue?</p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                data-testid="world-relayout-cancel"
                className="px-2 py-1 rounded border border-[#3c3c3c] hover:bg-[#37373d]"
                onClick={() => setConfirmRelayout(false)}
              >Cancel</button>
              <button
                type="button"
                data-testid="world-relayout-go"
                className="px-2 py-1 rounded bg-[#0078d4] hover:bg-[#106ebe] text-white"
                onClick={relayout}
              >Re-layout</button>
            </div>
          </div>
        )}
        {(busy || notice) && (
          <div
            role="status"
            data-testid="world-notice"
            className="text-xs px-2 py-1 rounded border border-[#3c3c3c]"
            style={{ position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)', zIndex: 4, background: '#252526' }}
          >
            {busy ? 'Re-laying out…' : notice}
          </div>
        )}
        {card !== null && <WorldCard boxRef={cardRef} html={card} maxHeight={cardCap} onClose={() => { setCard(null); viewer?.resetView() }} onOpen={openPart} />}
        {askSlot && !home && (
          <div ref={askRef} style={{ position: 'absolute', bottom: ASK_BOTTOM_PX, left: '50%', transform: 'translateX(-50%)', width: ASK_SLOT_WIDTH, zIndex: 3 }} data-testid="world-ask-slot">
            {askSlot(viewer, doc, worldKey, askLink)}
          </div>
        )}
      </div>
      {building && designKey !== null && buildIt && (
        <BuildItDialog
          designKey={designKey}
          title={designTitle}
          agents={buildIt.agents}
          defaultAgent={buildIt.defaultAgent}
          onBuilt={onBuilt}
          onClose={() => setBuilding(false)}
        />
      )}
    </div>
  )
}
