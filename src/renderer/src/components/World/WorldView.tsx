// Lumopolis: the full-screen world view of a project. It resolves the project root (the git root
// of the folder it is given, or that folder), asks main for the stored world, compiles one when
// there is none (showing the compile's progress), and draws it with the engine's viewer. Without
// WebGL it shows the engine's 2D list instead.
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
// E2E only (TERMPOLIS_TEST_WORLD_PROBE): window.__termpolis_world, a read-only probe of the map
// (a part's place on screen, what is drawn), so a spec can click a building and see a layer change
// without guessing at the 3D scene. Off in every normal run.
import { useEffect, useRef, useState } from 'react'
import type { MouseEvent, ReactNode } from 'react'
import type { Tour, WorldDoc } from '../../../../shared/world/types'
import { buildingCard, createWorldViewer, DEFAULT_LAYERS, edgeCard, hasWebGL, renderFallback } from '../../world/engine'
import type { LayerState, ThemeName, WorldDrawn, WorldViewer } from '../../world/engine'
import { exposesWorldProbe } from '../../lib/testAgents'
import { WorldToolbar } from './WorldToolbar'
import { WorldCard } from './WorldCard'
import { WorldEmptyState } from './WorldEmptyState'
import { useFocusTrap } from '../../hooks/useFocusTrap'

export interface WorldViewProps {
  /** A folder inside the project (the active terminal's cwd). Empty when there is none. */
  root: string
  onClose: () => void
  /** Plan 2's ask box: rendered at the bottom centre with the viewer (null without WebGL). */
  askSlot?: (viewer: WorldViewer | null, doc: WorldDoc | null) => ReactNode
}

/** The e2e probe on window.__termpolis_world. */
export interface WorldProbe {
  screenPoint(id: string): { x: number; y: number } | null
  drawn(): WorldDrawn
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const baseName = (p: string): string => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() as string

export function WorldView({ root, onClose, askSlot }: WorldViewProps): JSX.Element {
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
  const [theme, setThemeState] = useState<ThemeName>('neon')
  const [confirmRelayout, setConfirmRelayout] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const dialogRef = useRef<HTMLDivElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  // Latest values for the long-lived listeners (push events, Esc).
  const rootRef = useRef<string | null>(null)
  rootRef.current = resolvedRoot
  const docRef = useRef<WorldDoc | null>(null)
  docRef.current = doc
  /** True after an Esc reset with nothing done since: the next Esc closes. */
  const armedRef = useRef(false)
  const escRef = useRef<() => void>(onClose) // replaced on every render, below
  /** The doc the viewer holds, so the same world arriving twice (a compile, then its own push) loads once. */
  const loadedRef = useRef<{ projectKey: string; generatedAt: number } | null>(null)
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  // Keep the keyboard in the pane, and give the focus back when it closes.
  useFocusTrap(dialogRef)

  // The project root: the git root of the folder, or the folder itself outside a repository. A cd
  // inside the same repository resolves to the same root, so nothing below runs again.
  useEffect(() => {
    if (!root) { setResolvedRoot(null); return }
    let live = true
    window.termpolis.gitFindRoot(root).then(
      (r) => { if (live) setResolvedRoot(r.success && r.data ? r.data : root) },
      () => { if (live) setResolvedRoot(root) },
    )
    return () => { live = false }
  }, [root])

  // The world: the stored one, or a fresh compile when none was saved yet.
  // No root: nothing is shown (the viewer is hidden while there is no doc, so no stale map stays up).
  useEffect(() => {
    setDoc(null)
    setError(null)
    setMapping(false)
    setProgress(null)
    setCard(null)
    if (resolvedRoot === null) return
    let live = true
    const api = window.termpolis
    api.worldGet(resolvedRoot)
      .then((res) => {
        if (!live) return
        if (!res.success) { setError(res.error); return }
        if (res.data) { setDoc(res.data); return }
        setMapping(true)
        return api.worldCompile(resolvedRoot).then((c) => {
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
  }, [resolvedRoot, attempt])

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
        (res) => { if (res.success && res.data && rootRef.current === at) { setError(null); setDoc(res.data) } },
        () => undefined,
      )
    })
    return () => { offProgress(); offUpdated() }
  }, [])

  // The 3D viewer, once, when WebGL is there.
  useEffect(() => {
    if (!webgl) return
    const v = createWorldViewer(hostRef.current as HTMLDivElement, {
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

  // The e2e probe, while this viewer is up (and only under the test flag).
  useEffect(() => {
    if (!viewer || !exposesWorldProbe()) return
    const w = window as unknown as { __termpolis_world?: WorldProbe }
    const probe: WorldProbe = { screenPoint: (id) => viewer.screenPoint(id), drawn: () => viewer.drawn() }
    w.__termpolis_world = probe
    return () => { if (w.__termpolis_world === probe) delete w.__termpolis_world }
  }, [viewer])

  useEffect(() => {
    if (!viewer || !doc) return
    const held = loadedRef.current
    if (held && held.projectKey === doc.projectKey && held.generatedAt === doc.generatedAt) return
    loadedRef.current = { projectKey: doc.projectKey, generatedAt: doc.generatedAt }
    viewer.load(doc)
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
    setCard(buildingCard(d, id) || edgeCard(d, id) || null)
  }
  const onFallbackClick = (e: MouseEvent<HTMLDivElement>): void => {
    const item = (e.target as Element).closest('[data-kind][data-id]')
    if (!item) return
    const kind = item.getAttribute('data-kind')
    if (kind === 'district') { armedRef.current = false; setCard(null); return }
    openPart(item.getAttribute('data-id') as string)
  }
  const relayout = (): void => {
    // The root at click time: an answer for a project the pane has since left is dropped.
    const at = resolvedRoot as string
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

  escRef.current = () => {
    if (confirmRelayout) { setConfirmRelayout(false); return }
    if (armedRef.current && card === null) { onClose(); return }
    resetView()
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      const t = e.target as Node | null
      const inside = t === document.body || t === document.documentElement || (dialogRef.current as HTMLDivElement).contains(t)
      if (!inside) return
      e.preventDefault()
      e.stopPropagation()
      escRef.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  // The folder's name, never doc.projectKey: that is a sha1 slice of the path, not a name. A doc only
  // loads for a resolved root, and WorldDoc carries no root of its own to fall back on.
  const projectName = resolvedRoot ? baseName(resolvedRoot) : ''
  let empty: 'noRoot' | 'loading' | 'mapping' | 'error' | null = null
  if (!root) empty = 'noRoot'
  else if (error !== null) empty = 'error'
  else if (!doc) empty = mapping ? 'mapping' : 'loading'

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="Lumopolis"
      tabIndex={-1}
      data-testid="world-view"
      className="fixed inset-0 z-40 bg-[#0b1020] text-[#cccccc] outline-none animate-fadeIn"
    >
      <div className="absolute inset-0 top-11">
        {webgl && (
          <div
            ref={hostRef}
            data-testid="world-canvas-host"
            className={`absolute inset-0${doc ? '' : ' invisible'}`}
            onPointerDown={() => { armedRef.current = false }}
          />
        )}
        {!webgl && doc && (
          <div
            data-testid="world-fallback"
            className="absolute inset-0 overflow-auto p-6 text-sm [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:mt-3 [&_h3]:font-semibold [&_li]:cursor-pointer [&_ul]:pl-4 [&_p]:text-[#9ca3af]"
            onClick={onFallbackClick}
            // renderFallback escapes every string from the doc.
            dangerouslySetInnerHTML={{ __html: renderFallback(doc) }}
          />
        )}
        {empty && (
          <WorldEmptyState
            mode={empty}
            progress={progress}
            error={error}
            onRetry={() => setAttempt((n) => n + 1)}
          />
        )}
      </div>
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
        relayoutDisabled={!root || !doc || busy}
        onClose={onClose}
      />
      {confirmRelayout && (
        <div
          role="alertdialog"
          aria-label="Confirm re-layout"
          data-testid="world-relayout-confirm"
          className="absolute top-12 right-4 w-80 p-3 rounded border border-[#3c3c3c] bg-[#252526] shadow-xl flex flex-col gap-2 text-xs"
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
        <div role="status" data-testid="world-notice" className="absolute top-12 left-4 text-xs px-2 py-1 rounded bg-[#252526] border border-[#3c3c3c]">
          {busy ? 'Re-laying out…' : notice}
        </div>
      )}
      {card !== null && <WorldCard html={card} onClose={() => { setCard(null); viewer?.resetView() }} onOpen={openPart} />}
      {askSlot && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2" data-testid="world-ask-slot">
          {askSlot(viewer, doc)}
        </div>
      )}
    </div>
  )
}
