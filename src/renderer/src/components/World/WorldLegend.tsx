// The Lumopolis legend, top right over the map as in the approved prototype: what the packets on
// the lines carry (the cargo colours this world uses), what solid and dashed lines mean, how a
// building shows its state, and, with the processes layer on, which program each shell colour is.
// Everything is text from the world doc rendered by React (escaped); colours only go into styles.
// Layout and colours are inline styles so the panel looks the same whatever CSS the build ships.
import type { CSSProperties } from 'react'
import type { WorldDoc } from '../../../../shared/world/types'
import { useUiZoom } from './worldPane'

export interface WorldLegendProps {
  doc: WorldDoc
  /** The processes layer is on: list the program colours of the shells. */
  processes: boolean
  /** Expanded, or the compact chip. WorldView owns it: the fit reserves the legend's footprint. */
  open: boolean
  onToggle(): void
  /** The ask bar's reserve at the stage's foot, in the legend's own pixels: an expanded legend stops above it and scrolls. */
  bottom?: number
}

const EDGE = 12
const WIDTH = 220
/** The strip on the right of the map the legend covers, with a margin each side: the overview frames the city in the rest. */
export const LEGEND_RESERVE = EDGE + WIDTH + EDGE
/** The collapsed legend, a chip top right: its footprint with a margin each side. */
const CHIP_WIDTH = 84
export const LEGEND_CHIP_RESERVE = EDGE + CHIP_WIDTH + EDGE
/** From this canvas width the legend starts expanded and its strip is kept out of the fit (three times the strip). */
export const LEGEND_WIDE_PX = 732

/** Whether the legend is expanded when the user has not chosen: only a wide canvas has room for it. */
export const legendDefaultOpen = (canvasWidth: number): boolean => canvasWidth >= LEGEND_WIDE_PX

/**
 * From this canvas width a legend opened by choice has its strip kept out of the fit too: the city still gets about
 * 356 px beside it. (At 1366x768 with the pane dragged to 640 the opened legend once lay over a third of the city.)
 */
export const LEGEND_ASIDE_PX = 600

/**
 * The strip the overview's fit keeps clear. An expanded legend takes its full strip on a canvas from LEGEND_ASIDE_PX
 * wide; on a narrower one it opens over the map (the user asked for it), so only the chip's footprint counts.
 */
export const legendReserve = (open: boolean, canvasWidth: number): number =>
  open && canvasWidth >= LEGEND_ASIDE_PX ? LEGEND_RESERVE : LEGEND_CHIP_RESERVE

/**
 * legendReserve for a legend drawn `scale` times its size (the pane's zoom on a big monitor), in the
 * map's pixels: whether the canvas is wide is judged in the legend's own pixels.
 */
/**
 * The legend's greatest height: the stage less its top gap and the ask bar's reserve under it
 * (`bottom`, which already holds the bar's gap and clearance), and never less room than the
 * 120 px kept free before the ask bar was measured.
 */
export const legendMaxHeight = (bottom: number): string => `calc(100% - ${Math.max(120, EDGE + Math.ceil(bottom))}px)`

export const legendReserveScaled = (open: boolean, canvasWidth: number, scale: number): number =>
  Math.ceil(legendReserve(open, canvasWidth / scale) * scale)

const PANEL: CSSProperties = {
  // Never wider than the pane less its edges (the 28 px of padding and 2 of border are outside the width).
  position: 'absolute', top: EDGE, right: EDGE, width: WIDTH, maxWidth: `calc(100% - ${EDGE * 2 + 30}px)`, overflowY: 'auto', overflowX: 'hidden',
  background: 'rgba(8,12,22,.82)', backdropFilter: 'blur(10px)', border: '1px solid rgba(148,163,184,.18)',
  borderRadius: 12, padding: '10px 14px', fontSize: 12, color: '#e2e8f0', zIndex: 2,
}
const HEAD: CSSProperties = { display: 'block', margin: '8px 0 4px', fontSize: 12, fontWeight: 600 }
const ROW: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, margin: '2px 0', fontSize: 12, overflowWrap: 'anywhere' }
const SWATCH: CSSProperties = { width: 20, height: 10, borderRadius: 3, flex: 'none', boxSizing: 'border-box' }
const MUTED: CSSProperties = { color: '#94a3b8', fontSize: 12, margin: '0 0 4px' }

function Item({ swatch, children }: { swatch: CSSProperties; children: string }): JSX.Element {
  return (
    <div style={ROW}>
      <span aria-hidden="true" style={{ ...SWATCH, ...swatch }} />
      <span>{children}</span>
    </div>
  )
}

/** Keys of `map` in its own order, kept only when `used` has them. */
const usedKeys = (map: Record<string, unknown>, used: Set<string>): string[] => Object.keys(map).filter((k) => used.has(k))

/** The prototype's key is about ten entries: a big project lists the busiest cargo and counts the rest. */
export const LEGEND_MAX_CARGO = 10

/** The cargo the lines carry, busiest first (ties keep the map's order), and how many more there are. */
function busiestCargo(doc: WorldDoc): { shown: string[]; more: number } {
  const count = new Map<string, number>()
  for (const e of doc.edges) count.set(e.cargo, (count.get(e.cargo) ?? 0) + 1)
  const used = usedKeys(doc.cargo, new Set(count.keys()))
  const ranked = used.map((k, i) => ({ k, i, n: count.get(k) as number })).sort((a, b) => b.n - a.n || a.i - b.i).map((x) => x.k)
  return { shown: ranked.slice(0, LEGEND_MAX_CARGO), more: Math.max(0, ranked.length - LEGEND_MAX_CARGO) }
}

/** The cargo's shape in its colour, as the packets on the lines are drawn. */
const SHAPE_PATHS: Record<'cube' | 'sphere' | 'octa' | 'tetra', JSX.Element> = {
  cube: <rect x="3" y="3" width="10" height="10" />,
  sphere: <circle cx="8" cy="8" r="6" />,
  octa: <polygon points="8,1 15,8 8,15 1,8" />,
  tetra: <polygon points="8,2 15,14 1,14" />,
}
function CargoShape({ shape, color }: { shape: 'cube' | 'sphere' | 'octa' | 'tetra'; color: string }): JSX.Element {
  return (
    <svg aria-hidden="true" data-shape={shape} width="16" height="16" viewBox="0 0 16 16" fill={color} style={{ flex: 'none' }}>
      {SHAPE_PATHS[shape]}
    </svg>
  )
}

export function WorldLegend({ doc, processes, open, onToggle, bottom = 0 }: WorldLegendProps): JSX.Element {
  const zoom = useUiZoom()
  const { shown: cargo, more } = busiestCargo(doc)
  const procs = usedKeys(doc.processes, new Set(doc.buildings.map((b) => b.process)))
  return (
    <section aria-label="Lumopolis legend" data-testid="world-legend" style={{ ...PANEL, maxHeight: legendMaxHeight(bottom), ...(open ? {} : { width: CHIP_WIDTH, padding: '8px 12px', boxSizing: 'border-box' }), ...zoom }}>
      <button
        type="button"
        data-testid="world-legend-toggle"
        aria-expanded={open}
        onClick={onToggle}
        style={{ display: 'flex', width: '100%', justifyContent: 'space-between', alignItems: 'center', background: 'none', border: 0, padding: 0, color: 'inherit', font: 'inherit', fontWeight: 600, cursor: 'pointer' }}
      >
        <span>Legend</span>
        <span aria-hidden="true">{open ? '−' : '+'}</span>
      </button>
      {open && (
        <div data-testid="world-legend-body">
          {cargo.length > 0 && (
            <>
              <b style={HEAD}>What&apos;s moving on the lines</b>
              {cargo.map((k) => (
                <div key={k} style={ROW} data-testid="world-legend-cargo">
                  <CargoShape shape={doc.cargo[k].shape} color={doc.cargo[k].color} />
                  <span>{doc.cargo[k].label}</span>
                </div>
              ))}
              {more > 0 && <p style={MUTED} data-testid="world-legend-cargo-more">+{more} more on fewer lines</p>}
            </>
          )}
          <b style={HEAD}>Lines</b>
          <Item swatch={{ height: 4, borderRadius: 2, background: '#94a3b8' }}>Solid: a built connection</Item>
          <Item swatch={{ height: 0, borderRadius: 0, borderTop: '3px dashed #94a3b8' }}>Dashed: planned, or a guess the code does not show</Item>
          <Item swatch={{ height: 6, borderRadius: 3, background: '#94a3b8' }}>Thicker: busier</Item>
          <b style={HEAD}>Buildings</b>
          <Item swatch={{ border: '2px solid #4ade80', borderRadius: 99 }}>Green ring: tests pass</Item>
          <Item swatch={{ border: '2px solid #fbbf24' }}>Amber: no tests</Item>
          <Item swatch={{ border: '2px dashed #93c5fd' }}>Wireframe: planned only</Item>
          <Item swatch={{ background: 'radial-gradient(#cbd5e1aa, transparent 70%)' }}>Fog: partly unknown</Item>
          {processes && procs.length > 0 && (
            <>
              <b style={HEAD}>What runs where</b>
              <p style={MUTED}>Each bubble is a separate program. If one stalls or crashes, the others keep running.</p>
              {procs.map((k) => (
                <div key={k} style={ROW} data-testid="world-legend-process">
                  <span aria-hidden="true" style={{ ...SWATCH, border: `1px dashed ${doc.processes[k].color}` }} />
                  <span style={{ color: doc.processes[k].color, fontWeight: 600 }}>{doc.processes[k].label}</span>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </section>
  )
}
