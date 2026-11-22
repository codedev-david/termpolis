// The Lumopolis toolbar: the world switcher, layer toggles, theme, tours, Export, Build it (design worlds),
// reset, re-layout and close. In a narrow pane (`compact`), or wherever the full toolbar would take more than
// TOOLBAR_MAX_ROWS rows (wider fonts on Linux, a pane just over the fold), the secondary controls (the layer
// toggles, the proposal, theme and tours, the 2D map, Reset view and Re-layout) fold into a More menu, so the
// toolbar keeps to a row or two instead of taking a third of the pane. The close button sits in the top right
// corner, out of the wrapping rows, so it is never left alone on a row of its own. One popup (Bookmarks, More,
// Export) is open at a time; Esc shuts it wherever the focus is in the pane, and so does a click outside it.
import { useContext, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { Tour } from '../../../../shared/world/types'
import { THEMES } from '../../world/engine'
import type { Bookmark, LayerState, ThemeName } from '../../world/engine'
import { ExportMenu } from './ExportMenu'
import type { ExportKind } from './ExportMenu'
import { UiScaleContext, useUiZoom } from './worldPane'
import { screenRect } from '../../world/engine/screenRect'

/** Below this width, in the pane's own px (its width over its scale), the toolbar folds its secondary controls into More. */
export const TOOLBAR_FOLD_PX = 440
/** The most rows the full toolbar may take; past it, the secondary controls fold into More, whatever the width. */
export const TOOLBAR_MAX_ROWS = 2
/**
 * How much wider than where it folded the bar must grow before a folded toolbar looks again: a pane dragged a few
 * pixels, or a scrollbar coming and going, does not unfold it for a frame.
 */
export const TOOLBAR_UNFOLD_SLACK_PX = 24

/**
 * The rows the toolbar's controls lie on: its children grouped by their middles (a row's controls are centred
 * on one line), leaving out what takes no room (the spacer) and what is marked `data-world-row-skip` (the close
 * button in the corner, the cost line under the rows).
 */
export function toolbarRows(bar: HTMLElement): number {
  const mids: number[] = []
  for (const el of Array.from(bar.children)) {
    if (el.hasAttribute('data-world-row-skip')) continue
    const r = el.getBoundingClientRect()
    if (r.width >= 1 && r.height >= 1) mids.push(r.top + r.height / 2)
  }
  mids.sort((a, b) => a - b)
  let rows = 0
  let row = -Infinity
  for (const m of mids) {
    if (m - row > 8) { rows++; row = m }
  }
  return rows
}

/** The More menu's width in its own px (w-60), to tell which way it fits: times the pane's scale on screen. */
const MORE_W = 240

export interface WorldToolbarProps {
  projectName: string
  layers: LayerState
  onLayers: (patch: Partial<LayerState>) => void
  /** Every proposal of the world, in plan order; the select offers none first. Empty: no select. */
  proposals: { id: string; title: string }[]
  onProposal: (id: string | null) => void
  theme: ThemeName
  onTheme: (t: ThemeName) => void
  tours: Tour[]
  onTour: (tour: Tour) => void
  onResetView: () => void
  onRelayout: () => void
  relayoutDisabled: boolean
  onClose: () => void
  /** The world switcher (WorldSwitcher), first after the name. */
  switcher?: ReactNode
  /** Set while a world is open: the Export button, whose menu saves it as a page or as documentation. */
  onExport?: (kind: ExportKind) => void
  /** Set on a design world: the Build it button. */
  onBuildIt?: () => void
  /** An Export or Build it dialog is open: both buttons are off until it closes. */
  dialogOpen?: boolean
  /** The last labelling run's cost line, shown small and muted under the controls; absent: nothing. */
  labelCost?: string
  /** The saved views of this world, newest first. */
  bookmarks: Bookmark[]
  /** Saves the camera and what is open now under this name. */
  onSaveBookmark: (name: string) => void
  /** Goes to a saved view. */
  onBookmark: (b: Bookmark) => void
  onRemoveBookmark: (name: string) => void
  /** Saving needs the 3D camera: off while there is none (no WebGL). */
  bookmarkSaveDisabled?: boolean
  /** The 2D map is on: a flat SVG map with a list, for screen readers and machines without WebGL. */
  map2d: boolean
  onMap2d: (on: boolean) => void
  /** A narrow pane: the secondary controls fold into the More menu. */
  compact?: boolean
}

/** The toolbar's popups, one open at a time. */
type Popup = 'bookmarks' | 'more' | 'export'

const THEME_NAMES = Object.keys(THEMES) as ThemeName[]
const themeLabel = (t: ThemeName): string => t.charAt(0).toUpperCase() + t.slice(1)

const btn = 'text-xs px-2 py-1 rounded border border-[#3c3c3c] hover:bg-[#37373d] disabled:opacity-50 disabled:hover:bg-transparent'
const toggleCls = (on: boolean): string => `${btn} ${on ? 'bg-[#094771] text-white border-[#0078d4]' : 'text-[#cccccc]'}`

export function WorldToolbar(props: WorldToolbarProps): JSX.Element {
  const zoom = useUiZoom()
  const scale = useContext(UiScaleContext)
  const { layers, onLayers } = props
  // Folded because the full toolbar took more than TOOLBAR_MAX_ROWS rows at the bar's width then (crowdedAt), with
  // what it held then (crowdedFor): it unfolds to look again once the bar is TOOLBAR_UNFOLD_SLACK_PX wider than that,
  // or what it holds may have shrunk (the zoom, the pane scale, the world's name or the optional controls changed).
  const [crowded, setCrowded] = useState(false)
  const crowdedAt = useRef(0)
  const crowdedFor = useRef('')
  const holds = [zoom, scale, props.projectName, props.proposals.length > 0, props.tours.length > 0, !!props.onExport, !!props.onBuildIt].join('|')
  const compact = props.compact === true || crowded
  const [popup, setPopup] = useState<Popup | null>(null)
  const menu = popup === 'bookmarks'
  const more = popup === 'more'
  const ids = useId()
  const idOf = (p: Popup): string => `${ids}-${p}`
  const [moreSide, setMoreSide] = useState<'left' | 'right'>('left')
  const moreRef = useRef<HTMLDivElement>(null)
  const barRef = useRef<HTMLDivElement>(null)
  /** A popup's wrapper: its button first, then its menu. */
  const wrapOf = (p: Popup): HTMLElement => (barRef.current as HTMLDivElement).querySelector(`[data-world-popup="${p}"]`) as HTMLElement
  /** A button opens its popup, shutting any other, or shuts its own. */
  const toggle = (p: Popup): void => setPopup((open) => (open === p ? null : p))
  /** Shuts the popup `p` after a choice in it, the focus back on its button: the control chosen goes with the menu. */
  const done = (p: Popup): void => {
    if (popup !== p) return
    ;(wrapOf(p).firstElementChild as HTMLElement).focus()
    setPopup(null)
  }
  // A pane widened past the fold puts the controls back in the row: the menu has nothing left to show. A frame later,
  // so a toolbar that unfolds to look again and folds straight back (before paint) keeps its menu open.
  useEffect(() => {
    if (compact) return
    const frame = requestAnimationFrame(() => setPopup((open) => (open === 'more' ? null : open)))
    return () => cancelAnimationFrame(frame)
  }, [compact])
  // Measured after every render (the pane re-renders as it is dragged or the window resized), before paint. It
  // settles: it folds at a width and only looks again once the bar is wider than that.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- no dependency list on purpose: every render is measured
  useLayoutEffect(() => {
    const bar = barRef.current as HTMLDivElement
    const width = bar.clientWidth
    if (crowded) {
      if (width > crowdedAt.current + TOOLBAR_UNFOLD_SLACK_PX || holds !== crowdedFor.current) setCrowded(false)
    } else if (props.compact !== true && toolbarRows(bar) > TOOLBAR_MAX_ROWS) {
      crowdedAt.current = width
      crowdedFor.current = holds
      setCrowded(true)
    }
  })
  // A dialog opened some other way (the palette) shuts the Export menu under it, and a world closed takes it away.
  const exportOff = props.dialogOpen === true || props.onExport === undefined
  useEffect(() => { if (exportOff) setPopup((open) => (open === 'export' ? null : open)) }, [exportOff])
  useEffect(() => {
    if (popup === null) return
    const wrap = wrapOf(popup)
    const onDown = (e: MouseEvent): void => {
      if (!wrap.contains(e.target as Node | null)) setPopup(null)
    }
    // Capture on the document: after the pane's own Esc (on the window), which leaves Esc to an open popup.
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      const at = document.activeElement
      if (wrap.contains(at) || at === document.body) (wrap.firstElementChild as HTMLElement).focus()
      setPopup(null)
      // An Esc from the pane is the popup's alone; one from outside it (a terminal) is still that one's too.
      if (((barRef.current as HTMLDivElement).parentElement as HTMLElement).contains(e.target as Node | null)) {
        e.preventDefault()
        e.stopPropagation()
      }
    }
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [popup])
  /** Runs a control's action; one that leaves the view (a tour, a reset, a re-layout) shuts the More menu too. */
  const andClose = (fn: () => void): (() => void) => () => { done('more'); fn() }
  const [name, setName] = useState('')
  const save = (): void => {
    const n = name.trim()
    if (n === '') return
    props.onSaveBookmark(n)
    setName('')
  }
  const toggles: { key: string; label: string; title: string; on: boolean; patch: Partial<LayerState> }[] = [
    {
      key: 'labels', label: 'Tech names', title: 'Name buildings by their technology instead of their job',
      on: layers.labels === 'tech', patch: { labels: layers.labels === 'tech' ? 'jobs' : 'tech' },
    },
    { key: 'processes', label: 'Processes', title: 'Show which process each part runs in', on: layers.processes, patch: { processes: !layers.processes } },
    { key: 'allLineLabels', label: 'All line labels', title: 'Name every connection, not only the selected ones', on: layers.allLineLabels, patch: { allLineLabels: !layers.allLineLabels } },
    { key: 'planned', label: 'Planned', title: 'Show planned parts that are not built yet', on: layers.planned, patch: { planned: !layers.planned } },
  ]
  const secondary = (
    <>
      {toggles.map((t) => (
        <button
          key={t.key}
          type="button"
          aria-pressed={t.on}
          title={t.title}
          data-testid={`world-layer-${t.key}`}
          className={toggleCls(t.on)}
          onClick={() => onLayers(t.patch)}
        >{t.label}</button>
      ))}
      {props.proposals.length > 0 && (
        <select
          aria-label="Proposal"
          title="Which planned change is drawn over the world"
          data-testid="world-proposal"
          value={layers.proposal ?? ''}
          onChange={(e) => props.onProposal(e.target.value === '' ? null : e.target.value)}
          className="text-xs px-1.5 py-1 rounded border border-[#3c3c3c] bg-[#1e1e1e] text-[#cccccc]"
        >
          <option value="">No proposal</option>
          {props.proposals.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
        </select>
      )}
      <select
        aria-label="Theme"
        data-testid="world-theme"
        value={props.theme}
        onChange={(e) => props.onTheme(e.target.value as ThemeName)}
        className="text-xs px-1.5 py-1 rounded border border-[#3c3c3c] bg-[#1e1e1e] text-[#cccccc]"
      >
        {THEME_NAMES.map((t) => <option key={t} value={t}>{themeLabel(t)}</option>)}
      </select>
      <select
        aria-label="Tours"
        data-testid="world-tours"
        value=""
        disabled={props.tours.length === 0}
        onChange={(e) => {
          const tour = props.tours.find((t) => t.id === e.target.value)
          if (tour) andClose(() => props.onTour(tour))()
        }}
        className="text-xs px-1.5 py-1 rounded border border-[#3c3c3c] bg-[#1e1e1e] text-[#cccccc] disabled:opacity-50"
      >
        <option value="">{props.tours.length === 0 ? 'No tours yet' : 'Take a tour…'}</option>
        {props.tours.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
      </select>
      <button
        type="button"
        role="switch"
        aria-checked={props.map2d}
        title="A flat map with a list instead of the 3D city"
        data-testid="world-map2d"
        className={toggleCls(props.map2d)}
        onClick={() => props.onMap2d(!props.map2d)}
      >2D map</button>
    </>
  )
  const actions = (
    <>
      <button type="button" className={`${btn} text-[#cccccc]`} data-testid="world-reset" onClick={andClose(props.onResetView)} title="Back to the whole map (Esc)">
        Reset view
      </button>
      <button
        type="button"
        className={`${btn} text-[#cccccc]`}
        data-testid="world-relayout"
        disabled={props.relayoutDisabled}
        onClick={andClose(props.onRelayout)}
        title="Place every part again from scratch"
      >Re-layout</button>
    </>
  )
  return (
    <div
      ref={barRef}
      role="toolbar"
      aria-label="Lumopolis controls"
      className="flex flex-wrap items-center gap-2 pl-3 pr-12 py-2 border-b border-[#3c3c3c]"
      // In the pane's flow above the map, opaque, so nothing on the map shows through it. The right padding
      // keeps the rows clear of the close button in the corner.
      style={{ position: 'relative', flex: 'none', zIndex: 6, background: '#252526', ...zoom }}
    >
      <span className="text-sm font-semibold text-white inline-flex items-center gap-2 mr-2">
        <i className="fa-solid fa-earth-americas text-[#4fc1ff]" aria-hidden="true" />
        Lumopolis
        {props.projectName && <span className="text-xs font-normal text-[#9ca3af] truncate max-w-[16rem]" data-testid="world-project">{props.projectName}</span>}
      </span>
      {props.switcher}
      {!compact && secondary}
      <div className="relative" data-world-popup="bookmarks" data-world-own-esc={menu ? '' : undefined}>
        <button
          type="button"
          aria-expanded={menu}
          aria-controls={menu ? idOf('bookmarks') : undefined}
          data-testid="world-bookmarks"
          className={`${btn} text-[#cccccc]`}
          onClick={() => toggle('bookmarks')}
          title="Saved views of this map"
        >Bookmarks</button>
        {menu && (
          <div
            id={idOf('bookmarks')}
            role="group"
            aria-label="Bookmarks"
            data-testid="world-bookmarks-menu" data-map-panel
            className="absolute left-0 top-full mt-1 p-2 rounded border border-[#3c3c3c] shadow-xl flex flex-col gap-1 text-xs w-64"
            style={{ zIndex: 7, background: '#252526' }}
          >
            <div className="flex gap-1">
              <input
                aria-label="Name this view"
                data-testid="world-bookmark-name"
                value={name}
                maxLength={60}
                placeholder="Name this view"
                className="flex-1 min-w-0 px-1.5 py-1 rounded border border-[#3c3c3c] bg-[#1e1e1e] text-[#cccccc]"
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') save() }}
              />
              <button
                type="button"
                data-testid="world-bookmark-save"
                className={`${btn} text-[#cccccc]`}
                disabled={props.bookmarkSaveDisabled === true || name.trim() === ''}
                onClick={save}
              >Save view</button>
            </div>
            {props.bookmarks.length === 0 && <p className="text-[#9ca3af] px-1">No saved views yet</p>}
            {props.bookmarks.map((b) => (
              <div key={b.name} className="flex items-center gap-1">
                <button
                  type="button"
                  data-testid="world-bookmark-go"
                  className="flex-1 min-w-0 text-left truncate px-1.5 py-1 rounded hover:bg-[#37373d] text-[#cccccc]"
                  onClick={() => { props.onBookmark(b); done('bookmarks') }}
                >{b.name}</button>
                <button
                  type="button"
                  aria-label={`Remove ${b.name}`}
                  data-testid="world-bookmark-remove"
                  className="px-1.5 py-1 rounded text-[#999] hover:text-white hover:bg-[#37373d]"
                  onClick={() => props.onRemoveBookmark(b.name)}
                ><i className="fa-solid fa-xmark" aria-hidden="true" /></button>
              </div>
            ))}
          </div>
        )}
      </div>
      {compact && (
        <div
          ref={moreRef}
          className="relative"
          data-world-popup="more"
          // While a popup is open the pane leaves Esc to it (WorldView reads this attribute).
          data-world-own-esc={more ? '' : undefined}
        >
          <button
            type="button"
            aria-expanded={more}
            aria-controls={more ? idOf('more') : undefined}
            data-testid="world-more"
            className={`${btn} text-[#cccccc] inline-flex items-center gap-1.5`}
            title="Layers, theme, tours, the 2D map, Reset view and Re-layout"
            onClick={() => {
              // Toward the side with room, on screen (the toolbar is drawn `scale` times bigger on a big monitor).
              const wrap = screenRect(moreRef.current as HTMLDivElement)
              const bar = screenRect(barRef.current as HTMLDivElement)
              setMoreSide(bar.right - wrap.left >= MORE_W * scale || wrap.right - bar.left < MORE_W * scale ? 'left' : 'right')
              toggle('more')
            }}
          ><i className="fa-solid fa-ellipsis" aria-hidden="true" />More</button>
          {more && (
            <div
              id={idOf('more')}
              role="group"
              aria-label="More"
              data-testid="world-more-menu" data-map-panel
              className={`absolute ${moreSide === 'left' ? 'left-0' : 'right-0'} top-full mt-1 p-2 rounded border border-[#3c3c3c] shadow-xl flex flex-wrap items-center gap-2 w-60`}
              style={{ zIndex: 7, background: '#252526' }}
            >
              {secondary}
              {actions}
            </div>
          )}
        </div>
      )}
      <div className="flex-1" />
      {props.onExport && (
        <ExportMenu
          btnClass={`${btn} text-[#cccccc]`}
          onExport={props.onExport}
          disabled={props.dialogOpen === true}
          open={popup === 'export'}
          onToggle={() => toggle('export')}
          onDone={() => done('export')}
          menuId={idOf('export')}
        />
      )}
      {props.onBuildIt && (
        <button
          type="button"
          data-testid="world-build-it-open"
          className="text-xs px-2 py-1 rounded bg-[#0078d4] hover:bg-[#106ebe] text-white inline-flex items-center gap-1.5 disabled:opacity-50 disabled:hover:bg-[#0078d4]"
          disabled={props.dialogOpen === true}
          onClick={props.onBuildIt}
          title="Build this design in a folder with your agent"
        ><i className="fa-solid fa-hammer" aria-hidden="true" />Build it</button>
      )}
      {!compact && actions}
      <button
        type="button"
        aria-label="Close Lumopolis"
        data-testid="world-close"
        title="Close (Esc twice)"
        data-world-row-skip=""
        className="px-2 py-1 rounded text-[#999] hover:text-white hover:bg-[#37373d]"
        style={{ position: 'absolute', top: 8, right: 8 }}
        onClick={props.onClose}
      ><i className="fa-solid fa-xmark" aria-hidden="true" /></button>
      {props.labelCost && (
        <div className="basis-full text-[11px] leading-snug text-[#9ca3af]" data-testid="world-label-cost" data-world-row-skip="">{props.labelCost}</div>
      )}
    </div>
  )
}
