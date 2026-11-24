// Lumopolis: the full-screen world view. It opens on the active terminal's project (the git root of
// the folder it is given, or that folder), asks main for the stored world, compiles one when there
// is none (showing the compile's progress), and draws it with the engine's viewer. Without WebGL it
// shows the engine's 2D list instead. With no folder it shows the home (WorldHome); the toolbar's
// switcher opens any recent world or the home (useOpenWorld). A design world (design:<id>) loads
// through world:design-get and is drawn with the planned layer on; Build it (design worlds only)
// links the design to a folder, opens the agent there and switches to that folder's world. Export (any
// open world) saves it as one offline page (ExportDialog) or as its documentation (DocumentDialog); the
// saved file's toast takes the notice slot. The command palette asks for either through exportRequest.
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
import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, MouseEvent, ReactNode } from 'react'
import type { BuildItResult, Evidence, Tour, WorldAction, WorldDoc, WorldSavedFile } from '../../../../shared/world/types'
import { formatTokens } from '../../../../shared/world/tokens'
import { worldTitle } from '../../../../shared/world/worldTitle'
import { isRuntimeText, runtimeText } from '../../../../shared/world/runtimeNames'
import { buildingCard, createWorldViewer, DEFAULT_LAYERS, edgeCard, hasWebGL, loadBookmarks, removeBookmark, renderFallback, saveBookmark, techCard, THEMES, usesTech } from '../../world/engine'
import type { Bookmark, CameraState, LayerState, ThemeName, WorldDrawn, WorldViewer } from '../../world/engine'
import { exposesWorldProbe } from '../../lib/testAgents'
import { TOOLBAR_FOLD_PX, WorldToolbar } from './WorldToolbar'
import { WorldCard } from './WorldCard'
import { EvidenceView } from './EvidenceView'
import { WorldEmptyState } from './WorldEmptyState'
import { focusTerminal } from '../../lib/accountMenu'
import { useTerminalStore } from '../../store/terminalStore'
import { useOpenWorld, type WorldRequest } from './useOpenWorld'
import { WorldHome } from './WorldHome'
import { SignInNeededNotice } from './SignInNeededNotice'
import { RepoAccessDialog } from './RepoAccessDialog'
import { WorldSwitcher } from './WorldSwitcher'
import { BuildItDialog } from './BuildItDialog'
import { ExportDialog, ExportToast } from './ExportDialog'
import { DocumentDialog } from './DocumentDialog'
import type { ExportKind } from './ExportMenu'
import { LEGEND_CHIP_RESERVE, LEGEND_RESERVE, legendDefaultOpen, legendReserveFrom, legendReserveScaled, WorldLegend } from './WorldLegend'
import { ASK_BOTTOM_PX, ASK_SLOT_WIDTH, askReserve, cardMaxHeight, cardMeetsLegend, cardReserve, noticeBox, UiScaleContext, useUiScale, worldPaneStyle } from './worldPane'
import type { WorldPaneOverlay } from './worldPane'
import { rightInset } from '../../world/engine/viewMath'
import { tourCard } from '../../world/engine/cards'
import type { BuildAgent } from './BuildItDialog'
import type { OpenTarget } from './worldTargets'
import { WORLD_OPENED_EVENT } from './worldOpen'
import { filesNotice, nextFilesNotice } from './worldNotes'

export interface WorldViewProps {
  /** A folder inside the project (the active terminal's cwd). Empty when there is none. */
  root: string
  onClose: () => void
  /**
   * Plan 2's ask box: rendered at the bottom centre with the viewer (null without WebGL), the world,
   * the world's key (the project root it was drawn for, or design:<id> for a design; null until it
   * is known) and the link through which the box takes Esc first, holds newer worlds while it
   * answers and hands back a changed design, and the proposal selected in the toolbar (null: none), which
   * a question carries to the agent. Not shown on the home.
   */
  askSlot?: (viewer: WorldViewer | null, doc: WorldDoc | null, worldKey: string | null, link: WorldAskLink, proposal: string | null) => ReactNode
  /** Build it on design worlds: the agents it can start, and how App opens the agent terminal. */
  buildIt?: { agents: BuildAgent[]; defaultAgent?: string; launch: (res: BuildItResult, agentId: string) => void }
  /** The pane's width in px (App owns it: the divider and the window size change it). */
  width?: number
  /** Set when the row is too narrow for the pane beside the terminals: the pane lies over their column. */
  overlay?: WorldPaneOverlay | null
  /** A folder someone asked for (a terminal's globe, the `lumopolis` command, the file tree): its project
   *  opens, and the pane comes forward. Undefined: the pane follows the active terminal (`root`). */
  request?: WorldRequest
  /** The command palette asked for an export: each new seq opens that dialog once the world is there. */
  exportRequest?: { kind: ExportKind; seq: number }
}

/** The width a pane gets from no one (a test, a stand-alone mount). */
const DEFAULT_WIDTH = 480

/** How the ask box and the pane share Esc and world swaps. */
export interface WorldAskLink {
  /** The box's Esc handler, asked before the pane's own; true when it used the key. null removes it. */
  onEscape(fn: (() => boolean) | null): void
  /** True while an answer is under way: a world update waits, so the answer's tour is not wiped (a first map does not wait). */
  setBusy(busy: boolean): void
  /** A design changed by the box (design mode): the pane draws it, growing from the one it showed. */
  setDoc(doc: WorldDoc): void
  /**
   * Resolves once the pane shows the complete world: at once when it does, else after loading it when it is saved by
   * now (an answer is computed from it), else (none to be had) at once. An answer's tour waits for it (fix round 2, R1).
   */
  whenComplete?(): Promise<void>
}

/** The e2e probe on window.__termpolis_world. */
export interface WorldProbe {
  screenPoint(id: string): { x: number; y: number } | null
  linePoints(id: string): Array<{ x: number; y: number }>
  pickAt(x: number, y: number): { kind: 'node' | 'edge' | 'district'; id: string } | null
  drawn(): WorldDrawn
  cameraState(): CameraState | null
  /** Where the loaded world lays out building `id` (x, y, z), or null. */
  position(id: string): number[] | null
  /** Runs one world action (focus, tour step...) as the agent would. */
  apply(a: WorldAction): Promise<void>
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))
/** A building's or a connection's card, straight from the doc (the 2D view); null when the id names neither. */
/** The toolbar's line about the last labelling run. */
const labelCostLine = (tokens: number): string =>
  tokens > 0 ? `Describing parts: ${formatTokens(tokens)} on the last update` : 'Describing parts: cached, no tokens'

/** True while the 2D map is chosen (kept between sessions). */
const MAP2D_KEY = 'termpolis.world.map2d'
const readMap2d = (): boolean => {
  try { return localStorage.getItem(MAP2D_KEY) === '1' } catch { return false }
}
const hasPart = (d: WorldDoc, id: string): boolean =>
  d.buildings.some((b) => b.id === id) || d.externals.some((x) => x.id === id) || d.edges.some((e) => e.id === id) || d.districts.some((x) => x.id === id)

const partCard = (d: WorldDoc, id: string): string | null => buildingCard(d, id) || edgeCard(d, id) || null

/** The notice while the 3D map waits for its lost graphics to come back (the first loss). */
export const GRAPHICS_LOST = 'The 3D map paused: the graphics stopped. It comes back when they do.'
/** The notice once the graphics were lost a second time: the 2D map shows from then on. */
export const GRAPHICS_FLAT = 'The graphics stopped again, so the map shows in 2D.'

export function WorldView({ root, onClose, askSlot, buildIt, width = DEFAULT_WIDTH, overlay = null, request, exportRequest }: WorldViewProps): JSX.Element {
  const { world, open, goHome, entries, refresh, repoUpdate, repoBusy, repoError, repoChanged, signIn, useToken, dismissRepoUpdate, clearRepoError } = useOpenWorld(root, request)
  const [tokenOpen, setTokenOpen] = useState(false)
  useEffect(() => { if (!repoUpdate) setTokenOpen(false) }, [repoUpdate])
  const [webglFound, setWebglFound] = useState(() => hasWebGL())
  /** The graphics were lost twice while open: the 2D map shows from then on. */
  const [glGone, setGlGone] = useState(false)
  const webgl = webglFound && !glGone
  // WebGL missing at the start (a GPU blocked for a while, a driver update) is looked for again when the window comes
  // back to the front, so the 3D map appears without reopening the pane. Only while it is missing: a live map's own
  // context is never crowded by a test context, and a map that loses its graphics says so itself (onGraphics).
  useEffect(() => {
    if (webglFound || glGone) return
    const recheck = (): void => { if (document.visibilityState !== 'hidden' && hasWebGL()) setWebglFound(true) }
    window.addEventListener('focus', recheck)
    document.addEventListener('visibilitychange', recheck)
    return () => {
      window.removeEventListener('focus', recheck)
      document.removeEventListener('visibilitychange', recheck)
    }
  }, [webglFound, glGone])
  /** The window is on screen (not minimised or hidden): the 3D map draws nothing while it is not. */
  const [shown, setShown] = useState(true)
  useEffect(() => window.windowControls?.onShown?.(setShown), [])
  const [map2d, setMap2d] = useState(readMap2d)
  const map2dRef = useRef(map2d)
  map2dRef.current = map2d
  /**
   * The 3D map's graphics stopped and have not come back yet (the first loss): the 2D map shows meanwhile, so a context
   * that never comes back never leaves a blank map, and the 3D map returns by itself when they do.
   */
  const [glPaused, setGlPaused] = useState(false)
  /** The 2D map shows in place of a live 3D map: the switch is on, or its graphics are lost for now. */
  const shows2d = map2d || glPaused
  /** The flat map shows: no WebGL, or the 2D map in place of the 3D one. */
  const flat = !webgl || shows2d
  const [viewer, setViewer] = useState<WorldViewer | null>(null)
  const [resolvedRoot, setResolvedRoot] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [doc, setDoc] = useState<WorldDoc | null>(null)
  const [mapping, setMapping] = useState(false)
  const [progress, setProgress] = useState<{ stage: string; pct: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  // A world that failed to load has no run going: its last progress must not say one is.
  useEffect(() => { if (error !== null) setProgress(null) }, [error])
  const [card, setCard] = useState<string | null>(null)
  // Whether a click on the map opened the card; a closed card forgets it, so a tree or legend open never inherits it.
  const [clickThrough, setClickThrough] = useState(false)
  useEffect(() => { if (card === null) setClickThrough(false) }, [card])
  /** The evidence a card's button opened, shown under the card until closed or the card changes. */
  const [evidence, setEvidence] = useState<Evidence | null>(null)
  const [layers, setLayersState] = useState<LayerState>(DEFAULT_LAYERS)
  /** The proposal the toolbar chose; undefined until it does: the world's linked design is shown. */
  const [proposalPick, setProposalPick] = useState<string | null | undefined>(undefined)
  const proposal = proposalPick === undefined ? (doc?.layers.plan.find((p) => p.reconcile)?.id ?? null) : proposalPick
  useEffect(() => { viewer?.setLayers({ proposal }) }, [viewer, proposal])
  // How much bigger than on a laptop the panels draw on a big monitor (useUiScale): they are zoomed by
  // it, so every length measured from them below is multiplied by it to get the map's pixels.
  const scale = useUiScale(width)
  const scaleRef = useRef(scale)
  scaleRef.current = scale
  const zoom = scale === 1 ? {} : { zoom: scale }
  // The legend is expanded on a wide pane and a chip on a narrow one, until the user chooses: wide in
  // the panels' own (zoomed) pixels.
  const [legendChoice, setLegendChoice] = useState<boolean | null>(null)
  const legendOpen = legendChoice ?? legendDefaultOpen(width / scale)
  const legendOpenRef = useRef(legendOpen)
  legendOpenRef.current = legendOpen
  const widthRef = useRef(width)
  widthRef.current = width
  const [theme, setThemeState] = useState<ThemeName>('neon')
  const [confirmRelayout, setConfirmRelayout] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [building, setBuilding] = useState(false)
  /** The export dialog open on top of the map; null: none. */
  const [exporting, setExporting] = useState<ExportKind | null>(null)
  /** The file the last export saved: its toast shows in the notice slot until dismissed or replaced. */
  const [saved, setSaved] = useState<WorldSavedFile | null>(null)
  // A notice or a re-layout takes the slot: the toast it replaces is not brought back.
  useEffect(() => { if (busy || notice !== null) setSaved(null) }, [busy, notice])
  // The world's files note (a capped listing, unreadable names: worldNotes.ts) holds the slot whenever it is free, so a
  // Re-layout or a dismissed export toast gives it back.
  const filesNote = filesNotice(doc)
  useEffect(() => { if (!busy && saved === null) setNotice(nextFilesNotice(filesNote, notice)) }, [filesNote, busy, saved, notice])
  /** An export the palette asked for, waiting for the world to load. */
  const [pendingExport, setPendingExport] = useState<ExportKind | null>(null)
  const handledExport = useRef(0)
  /** The world the waiting ask was made on (see the effect that opens it); null until that effect first sees it. */
  const askedOn = useRef<{ world: string; key: string | null } | null>(null)
  useEffect(() => {
    if (exportRequest === undefined || exportRequest.seq === handledExport.current) return
    handledExport.current = exportRequest.seq
    askedOn.current = null
    setPendingExport(exportRequest.kind)
  }, [exportRequest])
  // Describing parts with AI (Settings): while it is off there is nothing to show the cost of. null until the
  // settings answer (or for good if they can't be read): the cost line still shows, and the export dialog names no
  // step that depends on the setting.
  const [labelling, setLabelling] = useState<boolean | null>(null)
  useEffect(() => {
    let live = true
    window.termpolis.worldSettingsGet?.()
      ?.then((res) => { if (live && res.success) setLabelling(res.data.worldLabelling) })
      ?.catch(() => undefined)
    return () => { live = false }
  }, [doc])
  // The open world: a folder (its key is the resolved root) or a design.
  const target = world.kind === 'root' ? world.root : ''
  const follow = world.kind === 'root' && world.follow
  /** The folder opens as its project (its git root): the active terminal's folder, or one asked for. */
  const asProject = follow || (world.kind === 'root' && world.project === true)
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
  const viewerRef = useRef<WorldViewer | null>(null)
  viewerRef.current = viewer
  const asProjectRef = useRef(asProject)
  asProjectRef.current = asProject
  /** True after an Esc reset with nothing done since: the next Esc closes. */
  const armedRef = useRef(false)
  const escRef = useRef<() => void>(onClose) // replaced on every render, below
  /** The home's share of the pane's Esc (WorldHome): true when a dialog open on it took the key. */
  const homeEscRef = useRef<(() => boolean) | null>(null)
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
  /** Tours waiting for the complete world to be shown (askLink.whenComplete): let go when the pane's doc is no first map. */
  const completeWaitersRef = useRef<Array<() => void>>([])
  /** Bumped by every opening of a world (and Try again): a pushed failure read for an earlier one is dropped (m2). */
  const runGenRef = useRef(0)
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
    whenComplete: async () => {
      if (docRef.current?.provisional !== true) return
      const at = rootRef.current as string
      const res = await window.termpolis.worldGet(at).catch(() => null)
      const got = res?.success === true ? res.data : null
      // No complete world to be had (the run failed meanwhile), or the pane moved on: nothing to wait for.
      if (got === null || got.provisional === true || rootRef.current !== at || docRef.current?.provisional !== true) return
      const shown = new Promise<void>((resolve) => { completeWaitersRef.current.push(resolve) })
      heldDocRef.current = null
      setError(null)
      setDoc(got)
      await shown
    },
  }))

  // Take the focus on open (so Esc reaches the pane), and give it back on close: to the control that
  // opened it, else to the active terminal. Beside the terminals there is no trap: they stay in reach. Over
  // them (overlay), their column is inert while the pane covers it (useWorldPaneWidth), so the focus stays here.
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

  // Asked again while open (a globe, the command): the pane comes forward, the same world staying as it is.
  const seq = request ? request.seq : 0
  const firstSeq = useRef(seq)
  useEffect(() => {
    if (seq !== firstSeq.current) (dialogRef.current as HTMLDivElement).focus()
  }, [seq])

  // Lumopolis has been opened: the sidebar's New badge and the first-run hint go, for good (Settings store).
  useEffect(() => {
    window.termpolis.worldSettingsSet?.({ worldOpened: true })?.catch(() => undefined)
    window.dispatchEvent(new Event(WORLD_OPENED_EVENT))
  }, [])

  // A terminal still dictating behind the pane would also type what is said to the Ask mic: stop it.
  useEffect(() => { window.dispatchEvent(new Event('termpolis:stopDictation')) }, [])

  // The project root: for the active terminal's folder or a folder asked for, its git root (or the folder
  // itself outside a repository; a cd inside the same repository resolves to the same root, so nothing
  // below runs again). A folder the user chose in a dialog is used as it is: that is the world they asked for.
  useEffect(() => {
    if (!target) { setResolvedRoot(null); return }
    if (!asProject) { setResolvedRoot(target); return }
    let live = true
    window.termpolis.gitFindRoot(target).then(
      (r) => { if (live) setResolvedRoot(r.success && r.data ? r.data : target) },
      () => { if (live) setResolvedRoot(target) },
    )
    return () => { live = false }
  }, [target, asProject])

  // The world: a design from the design store; for a folder the stored one, or a fresh compile when
  // none was saved yet. The home: nothing (the viewer is hidden while there is no doc, so no stale
  // map stays up).
  useEffect(() => {
    // A tour or a flight over the world being left stops here: paused under the home, it would otherwise caption
    // over it (T4). Nothing can be playing before a world is drawn.
    if (docRef.current !== null) viewerRef.current?.cancelActions()
    runGenRef.current++
    heldDocRef.current = null
    setDoc(null)
    setProposalPick(undefined)
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
          // The compile is over, whatever it ended with: its last progress is not a run still going.
          setProgress(null)
          // A first map drawn while it ran goes with it: the error and its Try again show, never that map for good.
          if (!c.success) { setDoc((d) => (d && d.provisional === true ? null : d)); setError(c.error); return }
          setDoc(c.data)
          // The terminal's project was just mapped: it joins the recent worlds now, not only when it is
          // mapped from the home. A folder main refuses (not a project) stays off the list, silently.
          if (asProjectRef.current) api.worldMapProject(at).then((r) => { if (r.success) refresh() }, () => undefined)
        })
      })
      .catch((e: unknown) => {
        if (!live) return
        setMapping(false)
        setDoc((d) => (d && d.provisional === true ? null : d))
        setError(messageOf(e))
      })
    return () => { live = false }
  }, [worldRoot, designKey, attempt, refresh])

  // A repository update that brought new files down: map the world again. The compile saves it and main
  // pushes it through the listener below, so the new map arrives like any other change.
  // A recompile that fails says so over the saved map, which stays up, and Try again maps the folder again.
  const [recompileError, setRecompileError] = useState<{ at: string; message: string } | null>(null)
  const recompile = (at: string): void => {
    setRecompileError(null)
    // A recompile that fails pushes no world: its last progress must not read as a run still going. A world
    // opened meanwhile has its own runs, so only this folder's progress is cleared, and only it hears the failure.
    const settled = (): boolean => {
      if (!mountedRef.current || rootRef.current !== at) return false
      setProgress(null)
      return true
    }
    window.termpolis.worldCompile(at).then(
      (c) => { if (settled() && !c.success) setRecompileError({ at, message: c.error }) },
      (e: unknown) => { if (settled()) setRecompileError({ at, message: messageOf(e) }) },
    )
  }
  useEffect(() => {
    const at = rootRef.current
    if (repoChanged === 0 || at === null) return
    recompile(at)
  }, [repoChanged])

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
      // A saved world ends the run that made it; a run that goes on reports its progress again.
      setProgress(null)
      // The run that drew the first map ended without a world (it failed, or the world process stopped).
      const failed = typeof e.error === 'string' ? e.error : null
      const gen = runGenRef.current
      window.termpolis.worldGet(at).then(
        (res) => {
          if (rootRef.current !== at || runGenRef.current !== gen) return
          const got = res.success ? res.data : null
          if (failed !== null) {
            // Only a pane still on a first map (or on none) hears of it: one showing a saved world keeps it as it is.
            const shown = docRef.current
            if (shown !== null && shown.provisional !== true) return
            if (got === null || got.provisional === true) {
              setDoc(null)
              setMapping(false)
              setError(failed)
              return
            }
          }
          if (got === null) return
          // Loading a world stops the answer's tour, so it waits until the answer is over. A first map gives way at once:
          // the answer is computed from the complete world and its tour waits for it (whenComplete), never the reverse.
          if (askBusyRef.current && docRef.current?.provisional !== true) { heldDocRef.current = got; return }
          setError(null)
          setDoc(got)
        },
        () => undefined,
      )
    })
    return () => { offProgress(); offUpdated() }
  }, [])

  // The overview is fitted to what the legend leaves free: it follows the legend and the pane's width.
  // The camera is told from what width the strip is kept, or under 732 px it drops the strip the fit was promised.
  const reserve = legendReserveScaled(legendOpen, width, scale)
  const reserveFrom = legendReserveFrom(legendOpen, width, scale)
  useEffect(() => { viewer?.setRightReserve(reserve, reserveFrom) }, [viewer, reserve, reserveFrom])
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
  const below = Math.ceil(askReserve(askHeight) * scale)
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
  const [cardW, cardH] = cardReserve(cardSize[0], cardSize[1]).map((v) => Math.ceil(v * scale))
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
  // The cap is a length on the zoomed card: worked out in its pixels.
  const cardCap = cardMaxHeight(stageSize[0] / scale, stageSize[1] / scale, rightInset(stageSize[0], reserve, reserveFrom) / scale, below / scale)
  useEffect(() => { viewer?.setCardReserve(cardW, cardH) }, [viewer, cardW, cardH])
  // Where the open card would reach the legend (a narrow pane), the legend steps aside until it closes.
  const legendAside = card !== null && cardMeetsLegend(stageSize[0] / scale, legendOpen ? LEGEND_RESERVE : LEGEND_CHIP_RESERVE)
  // The map's labels grow with the panels, and keep out from under every panel over the map: the
  // stage's children but the map itself, handed over after every render, so a panel that moved
  // without changing size is measured again (the viewer re-watches them only when the set changes). An open
  // toolbar popup (data-map-panel) hangs from the toolbar over the map, so it is a panel of its own; it opens
  // and shuts in the toolbar's own render, so a change anywhere in the pane hands the panels over again too.
  useEffect(() => { viewer?.setLabelScale(scale) }, [viewer, scale])
  const handPanels = useCallback((): void => {
    const stage = stageRef.current as HTMLDivElement
    const panels = Array.from(stage.children).filter((el) => el !== hostRef.current) as HTMLElement[]
    viewer?.setPanels([...panels, ...Array.from((dialogRef.current as HTMLDivElement).querySelectorAll<HTMLElement>('[data-map-panel]'))])
  }, [viewer])
  useEffect(() => { if (viewer) handPanels() })
  useEffect(() => {
    if (!viewer) return
    const host = hostRef.current as HTMLDivElement
    // The map's own labels change under the host every frame: only a change outside it counts.
    const mo = new MutationObserver((recs) => { if (recs.some((r) => !host.contains(r.target))) handPanels() })
    mo.observe(dialogRef.current as HTMLDivElement, { childList: true, subtree: true })
    return () => mo.disconnect()
  }, [viewer, handPanels])

  // The 3D viewer, once, when WebGL is there.
  useEffect(() => {
    if (!webgl) return
    const v = createWorldViewer(hostRef.current as HTMLDivElement, {
      rightReserve: legendReserveScaled(legendOpenRef.current, widthRef.current, scaleRef.current),
      renderCard: (html, fromClick) => {
        if (html !== null) armedRef.current = false
        setCard(html)
        setClickThrough(fromClick === true)
      },
      // A lost WebGL context: the first is waited out on the 2D map, the second leaves the 2D map for good.
      onGraphics: (g) => {
        if (g === 'lost') {
          // What plays on the 3D map stops (a tour, an answer's steps); with the 3D map on show its card goes too, as
          // a switch to the 2D map takes it.
          v.cancelActions()
          if (!map2dRef.current) { armedRef.current = false; fallbackIdRef.current = null; setCard(null) }
          setNotice(GRAPHICS_LOST)
          setGlPaused(true)
        } else if (g === 'restored') {
          // A card opened on the 2D map meanwhile has no 3D selection under it: it goes, as a switch back to 3D takes it.
          if (!map2dRef.current) { fallbackIdRef.current = null; setCard(null) }
          setNotice((n) => (n === GRAPHICS_LOST ? null : n))
          setGlPaused(false)
        }
        else { setNotice(GRAPHICS_FLAT); setGlGone(true); setGlPaused(false) }
      },
    })
    const offSelect = v.on('select', (sel) => { if (sel) armedRef.current = false })
    setViewer(v)
    return () => {
      offSelect()
      v.dispose()
      // A viewer made again (WebGL found later) loads the world afresh.
      setViewer(null)
      loadedRef.current = null
    }
  }, [webgl])

  // Nothing to draw while the home or a loading screen covers the map: stop the render loop.
  const covered = world.kind === 'home' || !doc
  useEffect(() => { viewer?.setPaused(covered || shows2d || !shown) }, [viewer, covered, shows2d, shown])

  // The e2e probe, while this viewer is up (and only under the test flag).
  useEffect(() => {
    if (!viewer || !exposesWorldProbe()) return
    const w = window as unknown as { __termpolis_world?: WorldProbe }
    const probe: WorldProbe = { screenPoint: (id) => viewer.screenPoint(id), linePoints: (id) => viewer.linePoints(id), pickAt: (x, y) => viewer.pickAt(x, y), drawn: () => viewer.drawn(), cameraState: () => viewer.cameraState(), position: (id) => docRef.current?.layout.positions[id] ?? null, apply: (a) => viewer.apply(a) }
    w.__termpolis_world = probe
    return () => { if (w.__termpolis_world === probe) delete w.__termpolis_world }
  }, [viewer])

  useEffect(() => {
    if (!viewer || !doc) return
    const held = loadedRef.current
    if (held && held.projectKey === doc.projectKey && held.generatedAt === doc.generatedAt) return
    loadedRef.current = doc
    // The same project grows from the world it showed: new parts rise, changed ones pulse. The viewer
    // keeps the camera, the open building and the selection across it (a labelled follow-up, a
    // watched change), so nothing is opened again here; a Re-layout, which moves the parts, closes the
    // open building and flies to the selection's new spot or the overview.
    if (held !== null && held.projectKey === doc.projectKey) viewer.load(doc, { animateFrom: held })
    else viewer.load(doc)
  }, [viewer, doc])

  // A tour waiting for the complete world (whenComplete) goes once the doc is no first map: it was loaded just above.
  useEffect(() => {
    if (doc?.provisional === true) return
    const waiting = completeWaitersRef.current
    completeWaitersRef.current = []
    for (const go of waiting) go()
  }, [doc])

  // In 2D the card is built from the doc: a newer world rebuilds the open one (or closes it when
  // its part is gone).
  useEffect(() => {
    const id = fallbackIdRef.current
    if ((viewer && !shows2d) || !doc || id === null) return
    setCard((c) => (c === null ? null : partCard(doc, id)))
  }, [viewer, shows2d, doc])

  // Saved views of this world.
  const projectKey = doc ? doc.projectKey : null
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([])
  // A bookmark's restore flies to its part's card first, then takes the saved pose. Anything the user does in
  // between (a drag, a click, the wheel, Esc) or a switch to another world moves this on, and a restore whose number
  // is no longer the latest leaves the camera where it is: the cut-short flight still resolves.
  const bookmarkSeqRef = useRef(0)
  const cancelBookmark = (): void => { bookmarkSeqRef.current++ }
  // Moved on as the new world renders (like docRef), so no restore lands between this render and its effects.
  const bookmarkWorldRef = useRef(projectKey)
  if (bookmarkWorldRef.current !== projectKey) {
    bookmarkWorldRef.current = projectKey
    cancelBookmark()
  }
  // WP5 fix I5: a world opened under a new key brings the views saved under its older keys (copied once, never moved).
  useEffect(() => { setBookmarks(projectKey === null ? [] : loadBookmarks(projectKey, docRef.current?.aliasKeys)) }, [projectKey])
  const onSaveBookmark = (name: string): void => {
    const v = viewer as WorldViewer // the save button is off without a viewer
    const cam = v.cameraState()
    if (!cam) return
    setBookmarks(saveBookmark((docRef.current as WorldDoc).projectKey, { name, camera: cam, selection: v.getSelection() }))
  }
  const onBookmark = (b: Bookmark): void => {
    if (!viewer) return
    const d = docRef.current as WorldDoc
    // A part the world no longer has is skipped.
    const ids = b.selection.filter((id) => hasPart(d, id))
    armedRef.current = false
    const seq = ++bookmarkSeqRef.current
    // The card's own framing flight lands first, then the saved pose takes the camera from it, unless the user moved,
    // picked something else or switched worlds meanwhile.
    const still = (): boolean => seq === bookmarkSeqRef.current && viewer.getSelection()[0] === ids[0]
    if (ids.length > 0) void viewer.apply({ type: 'openCard', id: ids[0] }).then(() => { if (still()) void viewer.setCamera(b.camera, false) })
    else {
      viewer.resetView()
      void viewer.setCamera(b.camera, false)
    }
  }
  const onRemoveBookmark = (name: string): void => setBookmarks(removeBookmark((docRef.current as WorldDoc).projectKey, name))
  const onMap2d = (on: boolean): void => {
    try { localStorage.setItem(MAP2D_KEY, on ? '1' : '0') } catch { /* not remembered */ }
    armedRef.current = false
    fallbackIdRef.current = null
    setCard(null)
    // A bookmark restore in flight is dropped too: the 2D map has no camera for its saved pose (T3).
    cancelBookmark()
    // A tour or a flight under way stops here: paused, it would otherwise caption over the 2D map (T3).
    viewer?.cancelActions()
    setMap2d(on)
  }

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
    if (viewer && !shows2d) { void viewer.play([{ type: 'tour', steps: tour.steps }]); return }
    // The 2D map has no camera to fly: the tour shows as its captions in order (T3).
    fallbackIdRef.current = null
    setCard(tourCard(tour))
  }
  const resetView = (): void => {
    armedRef.current = true
    setCard(null)
    viewer?.resetView()
  }
  /** Open a part's card: through the viewer (it flies there), or straight from the doc in 2D. */
  const openPart = (id: string): void => {
    armedRef.current = false
    if (viewer && !shows2d) { void viewer.apply({ type: 'openCard', id }); return }
    const d = docRef.current as WorldDoc
    fallbackIdRef.current = id
    setCard(partCard(d, id))
  }
  /** A technology chip: the glossary card, and every building and line that uses it lit up. */
  const openTech = (techId: string): void => {
    armedRef.current = false
    const d = docRef.current as WorldDoc
    if (viewer && !shows2d) {
      void viewer.apply({ type: 'openCard', id: 'tech:' + techId })
      void viewer.apply({ type: 'highlight', ids: usesTech(d, techId) })
      return
    }
    fallbackIdRef.current = null
    setCard(techCard(d, techId))
  }
  /** True while the world an annotation write started in is still the one open: its answer belongs to that world only. */
  const stillOn = (d: WorldDoc): (() => boolean) => {
    const at = rootRef.current
    return () => mountedRef.current && docRef.current?.projectKey === d.projectKey && rootRef.current === at
  }
  /** Confirm on an inferred claim: a person's verified copy is stored and the pane shows the doc that comes back. */
  const confirmClaim = (itemId: string, text: string): void => {
    // A claim that reads as service names is changed with the Edit button, never confirmed into a hidden note.
    if (isRuntimeText(text)) { setNotice('Use Edit on the Service names line to change them.'); return }
    const d = docRef.current as WorldDoc
    const still = stillOn(d)
    window.termpolis.worldAnnotate(d.projectKey, itemId, text)
      .then((res) => {
        if (!still()) return
        if (res.success) setDoc(res.data)
        else setNotice(`Couldn't confirm: ${res.error}`)
      })
      .catch((e: unknown) => { if (still()) setNotice(`Couldn't confirm: ${messageOf(e)}`) })
  }
  /** The "Service names" editor saved: the names are stored as an annotation, and the pane shows the doc that comes back. */
  const saveRuntimeNames = (itemId: string, names: string[]): void => {
    const d = docRef.current as WorldDoc
    const still = stillOn(d)
    window.termpolis.worldAnnotate(d.projectKey, itemId, runtimeText(names))
      .then((res) => {
        if (!still()) return
        if (res.success) setDoc(res.data)
        else setNotice(`Couldn't save the service names: ${res.error}`)
      })
      .catch((e: unknown) => { if (still()) setNotice(`Couldn't save the service names: ${messageOf(e)}`) })
  }
  /** Opens the 2D map's item an event came from; false when it came from none. */
  const openItem = (target: Element): boolean => {
    const item = target.closest('[data-kind][data-id]')
    if (!item) return false
    const kind = item.getAttribute('data-kind')
    if (kind === 'district') { armedRef.current = false; setCard(null); return true }
    openPart(item.getAttribute('data-id') as string)
    return true
  }
  const onFallbackClick = (e: MouseEvent<HTMLDivElement>): void => { openItem(e.target as Element) }
  // Enter or Space on an item (each is a Tab stop) opens it as a click does; Space then does not scroll the list.
  const onFallbackKey = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if ((e.key === 'Enter' || e.key === ' ') && openItem(e.target as Element)) e.preventDefault()
  }
  /** Opens a world from the home, the switcher or Build it; `planned` turns the plan overlay on. */
  const openWorld = (t: OpenTarget, planned = t.kind === 'design'): void => {
    armedRef.current = false
    setConfirmRelayout(false)
    setBuilding(false)
    setNotice(null)
    // The root resolved for the world shown before must not load for this one meanwhile. The world already
    // open keeps its root: its folder and how it opens are unchanged, so the resolver would not run again.
    if (t.kind !== 'root' || t.root !== target || (t.follow === true) !== asProject) setResolvedRoot(null)
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
    // A dialog open on the home takes the Esc and does its Cancel: never the pane's close or a camera reset.
    if (world.kind === 'home' && homeEscRef.current?.()) { armedRef.current = false; return }
    if (tokenOpen) { setTokenOpen(false); return }
    cancelBookmark()
    if (confirmRelayout) { setConfirmRelayout(false); return }
    if (building) { setBuilding(false); return }
    if (exporting !== null) { setExporting(null); return }
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
      // An open toolbar popup shuts on Esc wherever the focus is in the pane, and only it: the map and the pane stay
      // as they are (WorldToolbar).
      if ((dialogRef.current as HTMLDivElement).querySelector('[data-world-own-esc]') !== null) return
      e.preventDefault()
      e.stopPropagation()
      escRef.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  // The folder's name, never doc.projectKey: that is a sha1 slice of the path, not a name. A doc only
  // loads for a resolved root, and WorldDoc carries no root of its own to fall back on. A design is
  // named by its title in the recent worlds, and so is a cloned repository: its folder is named by a hash.
  // Main titles an export the same way (shared/world/worldTitle.ts), so the page and the pane never differ.
  const home = world.kind === 'home'
  // The notice slot sits in the free area: beside the legend and the open card, or above the ask bar below a card in a
  // narrow pane (noticeBox), in the slot's zoomed pixels. Centred in the pane until the stage is measured.
  const legendShown = webgl && !shows2d && doc !== null && !home && !legendAside
  const noticeSpot = noticeBox(stageSize[0] / scale, legendShown ? (legendOpen ? LEGEND_RESERVE : LEGEND_CHIP_RESERVE) : 0, card !== null, below / scale)
  const noticeAt: CSSProperties = noticeSpot === null
    ? { top: 12, left: '50%', maxWidth: 'calc(100% - 24px)' }
    : { left: noticeSpot.center, width: 'max-content', maxWidth: noticeSpot.width, ...(noticeSpot.top !== undefined ? { top: noticeSpot.top } : { bottom: noticeSpot.bottom }) }
  const projectName = worldTitle(entries, { root: worldRoot, designKey })
  const worldKey = worldRoot ?? designKey
  // The canvas's text alternative names the project shown.
  useEffect(() => { viewer?.setTitle(projectName) }, [viewer, projectName])
  /** The world as opened, before its folder resolves: a followed folder changes it on every cd. */
  const openedAs = designKey !== null ? `design ${designKey}` : `root ${target}`
  let empty: 'loading' | 'mapping' | 'error' | null = null
  const recompileShown = recompileError !== null && recompileError.at === worldRoot ? recompileError : null
  if (home) empty = null
  else if (error !== null) empty = 'error'
  else if (!doc) empty = mapping ? 'mapping' : 'loading'

  /** The documentation's city picture, taken when its dialog was asked for; and the frame that will take it. */
  const pictureRef = useRef<string | null>(null)
  const pictureFrame = useRef(0)
  useEffect(() => () => cancelAnimationFrame(pictureFrame.current), [])
  // Another world (or the home): an open export dialog and the last toast belonged to the one before.
  useEffect(() => {
    cancelAnimationFrame(pictureFrame.current)
    setExporting(null)
    setSaved(null)
  }, [worldKey])
  /**
   * Opens an export dialog. The documentation's picture is the city as drawn: WebGL clears the canvas once a frame
   * is on screen, so it is read inside the next frame, after the viewer's own draw (the viewer queues each frame at
   * the start of the one before, so its draw runs first). Without the 3D map (no WebGL, the 2D map, no canvas yet)
   * there is no picture.
   */
  /** Export or Build it is open: the toolbar's buttons for both are off, so a running export is never cut short. */
  const dialogOpen = building || exporting !== null
  /** Returns false when a dialog is already open: a palette ask then is dropped, not queued. */
  const openExport = (kind: ExportKind): boolean => {
    // The palette can still ask while a dialog is open: that ask is dropped, and the open dialog keeps going.
    if (dialogOpen) return false
    cancelAnimationFrame(pictureFrame.current)
    pictureRef.current = null
    const canvas = flat ? null : hostRef.current?.querySelector('canvas') ?? null
    if (kind === 'world' || canvas === null) { setExporting(kind); return true }
    // The map draws only while something moves: a frame is asked for, so there is one to read.
    viewer?.requestFrame()
    pictureFrame.current = requestAnimationFrame(() => {
      try {
        pictureRef.current = canvas.toDataURL('image/png')
      } catch {
        pictureRef.current = null
      }
      setExporting('document')
    })
    return true
  }
  // The palette's ask below runs it from an effect: through a ref, so the effect runs on the world's state only.
  const openExportRef = useRef(openExport)
  openExportRef.current = openExport
  useEffect(() => {
    if (pendingExport === null) return
    if (home) { setPendingExport(null); setNotice('Open a world to export it.'); return }
    // The world failed to load: the ask goes with it, so a world that loads later never pops a dialog unasked.
    if (error !== null) { setPendingExport(null); return }
    // The ask is for the world open when it was made: another world opened before it loaded drops it. Its key is
    // known once its folder resolves; until then it is told by the world as opened.
    const asked = askedOn.current ?? (askedOn.current = { world: openedAs, key: worldKey })
    if (asked.key === null) {
      if (openedAs !== asked.world) { setPendingExport(null); return }
      asked.key = worldKey
    } else if (worldKey !== null && worldKey !== asked.key) { setPendingExport(null); return }
    // A first map from the listing is not the world yet: the ask waits for the complete one (fix round 1, I1).
    if (!doc || doc.provisional === true || worldKey === null) return
    setPendingExport(null)
    // The palette has closed: take the focus, so Esc reaches the dialog. A dropped ask leaves the focus alone.
    if (openExportRef.current(pendingExport)) (dialogRef.current as HTMLDivElement).focus()
  }, [pendingExport, home, doc, worldKey, error, openedAs])
  // Build it takes over from a documentation dialog still waiting for its picture frame.
  const openBuildIt = (): void => {
    cancelAnimationFrame(pictureFrame.current)
    setBuilding(true)
  }
  const onSaved = (file: WorldSavedFile): void => {
    setNotice(null)
    setSaved(file)
  }
  /**
   * A compile or labelling run is going (an export uses the map as it was last saved), and what it is doing:
   * describing the parts (the labelling stage), or any other update.
   */
  const mapRun = progress !== null && progress.pct < 100 ? (progress.stage === 'labelling' ? 'describing' : 'updating') : null

  return (
    <UiScaleContext.Provider value={scale}>
    <div
      ref={dialogRef}
      role="region"
      aria-label="Lumopolis"
      tabIndex={-1}
      data-testid="world-view"
      className="outline-none"
      style={worldPaneStyle(THEMES[theme].background, width, overlay)}
      onFocusCapture={() => { hadFocusRef.current = true }}
    >
      <WorldToolbar
        projectName={projectName}
        layers={{ ...layers, proposal }}
        onLayers={onLayers}
        proposals={doc ? doc.layers.plan.map((p) => ({ id: p.id, title: p.title })) : []}
        onProposal={setProposalPick}
        theme={theme}
        onTheme={onTheme}
        tours={doc ? doc.tours : []}
        onTour={onTour}
        onResetView={resetView}
        onRelayout={() => setConfirmRelayout(true)}
        relayoutDisabled={worldRoot === null || !doc || busy}
        onClose={onClose}
        switcher={<WorldSwitcher entries={entries} onOpen={(t) => openWorld(t)} onHome={goHome} />}
        onExport={doc && doc.provisional !== true && worldKey !== null ? openExport : undefined}
        onBuildIt={designKey !== null && buildIt && doc ? openBuildIt : undefined}
        dialogOpen={dialogOpen}
        bookmarks={bookmarks}
        onSaveBookmark={onSaveBookmark}
        onBookmark={onBookmark}
        onRemoveBookmark={onRemoveBookmark}
        bookmarkSaveDisabled={!viewer || !doc}
        // While the graphics are away the switch shows the 2D map that is on show, and waits for them.
        map2d={shows2d}
        map2dDisabled={glPaused}
        onMap2d={onMap2d}
        // Always folded below TOOLBAR_FOLD_PX; above it the toolbar folds itself where it would take too many rows.
        compact={width / scale < TOOLBAR_FOLD_PX}
        labelCost={labelling !== false && doc && doc.labelTokens !== undefined ? labelCostLine(doc.labelTokens) : undefined}
      />
      <div ref={stageRef} data-testid="world-stage" style={{ position: 'relative', flex: '1 1 auto', minHeight: 0, overflow: 'hidden' }}>
        {webgl && (
          <div
            ref={hostRef}
            data-testid="world-canvas-host"
            // Its own stacking context beneath the panels: the label layer numbers each label's
            // z-index up from zero, which would otherwise draw names over the card and legend.
            style={{ position: 'absolute', inset: 0, zIndex: 0, isolation: 'isolate', visibility: doc && !shows2d ? 'visible' : 'hidden' }}
            onPointerDown={() => { armedRef.current = false; cancelBookmark() }}
            onWheel={cancelBookmark}
          />
        )}
        {flat && doc && (
          <div
            data-testid="world-fallback"
            // Drawn at the pane's scale, wrapping long names, and ending above the ask bar laid over the
            // pane's foot, so no row sits under the suggestions or the box. Dark like the pane, so its scrollbar is too.
            className="overflow-auto p-6 text-sm [overflow-wrap:anywhere] [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:mt-3 [&_h3]:font-semibold [&_li]:cursor-pointer [&_ul]:pl-4 [&_p]:text-[#9ca3af]"
            style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: below / scale, colorScheme: 'dark', ...zoom }}
            onClick={onFallbackClick}
            onKeyDown={onFallbackKey}
            // renderFallback escapes every string from the doc. The plan shows as on the 3D map.
            dangerouslySetInnerHTML={{ __html: renderFallback(doc, projectName, { planned: layers.planned, proposal }) }}
          />
        )}
        {home && <WorldHome entries={entries} projectCwd={root} onOpen={(t) => openWorld(t)} onChanged={refresh} escRef={homeEscRef} />}
        {empty && (
          <WorldEmptyState
            mode={empty}
            progress={progress}
            error={error}
            onRetry={() => setAttempt((n) => n + 1)}
          />
        )}
        {legendShown && doc && <WorldLegend doc={doc} processes={layers.processes} open={legendOpen} bottom={below / scale} onToggle={() => setLegendChoice(!legendOpen)} />}
        {confirmRelayout && (
          <div
            role="alertdialog"
            aria-label="Confirm re-layout"
            data-testid="world-relayout-confirm"
            className="p-3 rounded border border-[#3c3c3c] shadow-xl flex flex-col gap-2 text-xs"
            style={{ position: 'absolute', top: 12, right: 12, width: 320, maxWidth: 'calc(100% - 24px)', boxSizing: 'border-box', zIndex: 5, background: '#252526', ...zoom }}
          >
            <p>Re-layout places every part again from scratch and forgets the current arrangement. Continue?</p>
            <div className="flex flex-wrap justify-end gap-2">
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
        {(repoUpdate || busy || notice || saved || recompileShown) && (
          <div style={{ position: 'absolute', ...noticeAt, transform: 'translateX(-50%)', zIndex: 4, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, ...zoom }}>
            {repoUpdate && (
              <SignInNeededNotice
                host={repoUpdate.host}
                helper={repoUpdate.helper}
                busy={repoBusy}
                error={repoError}
                onSignIn={signIn}
                onUseToken={() => { clearRepoError(); setTokenOpen(true) }}
                onDismiss={dismissRepoUpdate}
              />
            )}
            {recompileShown && (
              <div
                role="alert"
                data-testid="world-recompile-error"
                className="text-xs px-2 py-1 rounded border border-[#3c3c3c] flex items-center gap-2 text-[#cccccc]"
                style={{ background: '#252526' }}
              >
                <span>Lumopolis could not map this project. <span className="text-[#f48771] break-words">{recompileShown.message}</span></span>
                <button
                  type="button"
                  className="px-2 py-0.5 rounded bg-[#0078d4] hover:bg-[#106ebe] text-white"
                  onClick={() => recompile(recompileShown.at)}
                >Try again</button>
              </div>
            )}
            {(busy || notice || saved) && (
              <div
                role="status"
                data-testid="world-notice"
                className="text-xs px-2 py-1 rounded border border-[#3c3c3c]"
                style={{ background: '#252526' }}
              >
                {busy ? 'Re-laying out…' : notice ?? <ExportToast file={saved as WorldSavedFile} onDismiss={() => setSaved(null)} />}
              </div>
            )}
          </div>
        )}
        {repoUpdate && tokenOpen && (
          <RepoAccessDialog host={repoUpdate.host} busy={repoBusy} error={repoError} onSubmit={useToken} onCancel={() => setTokenOpen(false)} />
        )}
        {card !== null && <WorldCard boxRef={cardRef} html={card} clickThrough={clickThrough} maxHeight={cardCap} onClose={() => { setCard(null); setEvidence(null); viewer?.resetView() }} onOpen={openPart} onTech={openTech} onConfirm={confirmClaim} onRuntimeNames={saveRuntimeNames} onEvidence={setEvidence} />}
        {card !== null && evidence !== null && (
          <div style={{ position: 'absolute', bottom: 12, left: 12, zIndex: 4, maxWidth: 'min(360px, calc(100% - 24px))', ...zoom }} className="rounded border border-[#3c3c3c] bg-[#252526] px-2 py-1">
            <EvidenceView evidence={evidence} onClose={() => setEvidence(null)} />
          </div>
        )}
        {askSlot && !home && (
          <div ref={askRef} style={{ position: 'absolute', bottom: ASK_BOTTOM_PX, left: '50%', transform: 'translateX(-50%)', width: ASK_SLOT_WIDTH, zIndex: 3, ...zoom }} data-testid="world-ask-slot">
            {askSlot(shows2d ? null : viewer, doc, worldKey, askLink, proposal)}
          </div>
        )}
      </div>
      {building && designKey !== null && buildIt && (
        <BuildItDialog
          designKey={designKey}
          title={projectName}
          agents={buildIt.agents}
          defaultAgent={buildIt.defaultAgent}
          onBuilt={onBuilt}
          onClose={() => setBuilding(false)}
        />
      )}
      {exporting === 'world' && (
        <ExportDialog root={worldRoot ?? undefined} designKey={designKey ?? undefined} mapRun={mapRun} describeOn={labelling} onSaved={onSaved} onClose={() => setExporting(null)} />
      )}
      {exporting === 'document' && (
        <DocumentDialog
          root={worldRoot ?? undefined}
          designKey={designKey ?? undefined}
          projectName={projectName}
          picture={() => pictureRef.current}
          onSaved={onSaved}
          onClose={() => setExporting(null)}
        />
      )}
    </div>
    </UiScaleContext.Provider>
  )
}
