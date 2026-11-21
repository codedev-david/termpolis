// The Lumopolis toolbar: the world switcher, layer toggles, theme, tours, Export, Build it (design worlds),
// reset, re-layout and close.
import { useState } from 'react'
import type { ReactNode } from 'react'
import type { Tour } from '../../../../shared/world/types'
import { THEMES } from '../../world/engine'
import type { Bookmark, LayerState, ThemeName } from '../../world/engine'
import { ExportMenu } from './ExportMenu'
import type { ExportKind } from './ExportMenu'

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
}

const THEME_NAMES = Object.keys(THEMES) as ThemeName[]
const themeLabel = (t: ThemeName): string => t.charAt(0).toUpperCase() + t.slice(1)

const btn = 'text-xs px-2 py-1 rounded border border-[#3c3c3c] hover:bg-[#37373d] disabled:opacity-50 disabled:hover:bg-transparent'
const toggleCls = (on: boolean): string => `${btn} ${on ? 'bg-[#094771] text-white border-[#0078d4]' : 'text-[#cccccc]'}`

export function WorldToolbar(props: WorldToolbarProps): JSX.Element {
  const { layers, onLayers } = props
  const [menu, setMenu] = useState(false)
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
  return (
    <div
      role="toolbar"
      aria-label="Lumopolis controls"
      className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-[#3c3c3c]"
      // In the pane's flow above the map, opaque, so nothing on the map shows through it.
      style={{ position: 'relative', flex: 'none', zIndex: 6, background: '#252526' }}
    >
      <span className="text-sm font-semibold text-white inline-flex items-center gap-2 mr-2">
        <i className="fa-solid fa-earth-americas text-[#4fc1ff]" aria-hidden="true" />
        Lumopolis
        {props.projectName && <span className="text-xs font-normal text-[#9ca3af] truncate max-w-[16rem]" data-testid="world-project">{props.projectName}</span>}
      </span>
      {props.switcher}
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
          if (tour) props.onTour(tour)
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
      <div className="relative">
        <button
          type="button"
          aria-haspopup="true"
          aria-expanded={menu}
          data-testid="world-bookmarks"
          className={`${btn} text-[#cccccc]`}
          onClick={() => setMenu(!menu)}
          title="Saved views of this map"
        >Bookmarks</button>
        {menu && (
          <div
            role="group"
            aria-label="Bookmarks"
            data-testid="world-bookmarks-menu"
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
                  onClick={() => { props.onBookmark(b); setMenu(false) }}
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
      <div className="flex-1" />
      {props.onExport && <ExportMenu btnClass={`${btn} text-[#cccccc]`} onExport={props.onExport} />}
      {props.onBuildIt && (
        <button
          type="button"
          data-testid="world-build-it-open"
          className="text-xs px-2 py-1 rounded bg-[#0078d4] hover:bg-[#106ebe] text-white inline-flex items-center gap-1.5"
          onClick={props.onBuildIt}
          title="Build this design in a folder with your agent"
        ><i className="fa-solid fa-hammer" aria-hidden="true" />Build it</button>
      )}
      <button type="button" className={`${btn} text-[#cccccc]`} data-testid="world-reset" onClick={props.onResetView} title="Back to the whole map (Esc)">
        Reset view
      </button>
      <button
        type="button"
        className={`${btn} text-[#cccccc]`}
        data-testid="world-relayout"
        disabled={props.relayoutDisabled}
        onClick={props.onRelayout}
        title="Place every part again from scratch"
      >Re-layout</button>
      <button
        type="button"
        aria-label="Close Lumopolis"
        data-testid="world-close"
        title="Close (Esc twice)"
        className="px-2 py-1 rounded text-[#999] hover:text-white hover:bg-[#37373d]"
        onClick={props.onClose}
      ><i className="fa-solid fa-xmark" aria-hidden="true" /></button>
      {props.labelCost && (
        <div className="basis-full text-[11px] leading-snug text-[#9ca3af]" data-testid="world-label-cost">{props.labelCost}</div>
      )}
    </div>
  )
}
