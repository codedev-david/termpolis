// The frame of the Lumopolis pane: a resizable column in the app's flex row, beside the terminals (like
// the Changes panel), never an overlay. Opaque background from its first frame. Inline styles, so the
// frame never depends on which utility classes the CSS build happens to contain.
//
// Width: the saved width (localStorage) or 40% of the row, kept within [WORLD_PANE_MIN_PX, row minus
// TERMINAL_MIN_PX]. The terminal minimum wins when the row is too narrow for both: the pane shrinks
// under its minimum rather than squeeze the terminals.
//
// App shows WorldPaneOpening while the Lumopolis chunk (the engine and Three.js) loads. This module
// imports nothing from the engine, so it stays small enough for App's main chunk.
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, RefObject } from 'react'
import { uiScale } from '../../../../shared/world/uiScale'

/** The Neon theme's background (themes.ts): the pane always opens in Neon. A test keeps the two equal. */
export const WORLD_OPENING_BACKGROUND = '#03050a'

export const WORLD_PANE_MIN_PX = 360
export const TERMINAL_MIN_PX = 320
export const WORLD_PANE_DEFAULT_FRACTION = 0.4
/** The divider's width: it sits in the same row, between the terminals and the pane. */
export const WORLD_DIVIDER_PX = 4
const WIDTH_KEY = 'termpolis.world.paneWidth'

/** The pane's width within a row `rowWidth` wide (the room for the terminals, the divider and the pane). */
export function clampWorldPaneWidth(px: number, rowWidth: number): number {
  const room = Math.max(0, rowWidth - TERMINAL_MIN_PX - WORLD_DIVIDER_PX)
  return Math.min(Math.max(px, WORLD_PANE_MIN_PX), room)
}

export function loadWorldPaneWidth(): number | null {
  try {
    const n = Number(localStorage.getItem(WIDTH_KEY))
    return Number.isFinite(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

export function saveWorldPaneWidth(px: number): void {
  try {
    localStorage.setItem(WIDTH_KEY, String(Math.round(px)))
  } catch { /* storage unavailable: the width lasts for this session only */ }
}

/** The ask bar's gap to the bottom of the pane. */
export const ASK_BOTTOM_PX = 16
/** The ask bar's width: 34rem, or the pane less 12 px each side when that is narrower. */
export const ASK_SLOT_WIDTH = 'min(34rem, calc(100% - 24px))'
/** Room kept between the city and the top of the ask bar. */
const ASK_CLEARANCE_PX = 8

/**
 * The strip at the bottom of the view the ask bar covers, for the overview's fit (setBottomReserve):
 * its measured height, its gap to the bottom and a little clearance; none while it is not there (0).
 */
export function askReserve(height: number): number {
  return height > 0 ? Math.ceil(height) + ASK_BOTTOM_PX + ASK_CLEARANCE_PX : 0
}

/** The card's gap to the pane's top and left edges (WorldCard), and the room kept between it and the city. */
export const CARD_INSET_PX = 12
const CARD_CLEARANCE_PX = 8
/** The card's box is kept in steps this large, so a pixel's change in its content never moves the camera. */
const CARD_STEP_PX = 8

/**
 * The box from the pane's top left corner the open card covers, for the close-ups' fit
 * (setCardReserve): its measured width and height, its gap to the edges and a little clearance,
 * rounded up to CARD_STEP_PX; 0, 0 while no card is open.
 */
export function cardReserve(width: number, height: number): [number, number] {
  if (!(width > 0) || !(height > 0)) return [0, 0]
  const step = (v: number): number => Math.ceil((v + CARD_INSET_PX + CARD_CLEARANCE_PX) / CARD_STEP_PX) * CARD_STEP_PX
  return [step(width), step(height)]
}

/** The card's width (WorldCard). */
export const CARD_WIDTH_PX = 330
/** The least room the city keeps beside or below the card: viewMath's MIN_FREE_PX, kept equal by a test. */
export const CARD_MIN_FREE_PX = 120
/** In a narrow pane, the share of the stage's height kept free between the card and the ask bar's reserve. */
export const CARD_FREE_SHARE = 0.45
/** The shortest a capped card gets: its title row and a few lines of its body. */
export const CARD_MIN_HEIGHT_PX = 96

/**
 * The open card's greatest height (WorldCard maxHeight), in a stage `width` x `height` whose right
 * `right` pixels the legend covers (viewMath rightInset) and bottom `ask` pixels the ask bar
 * (askReserve). Where the card leaves the city CARD_MIN_FREE_PX beside it, the pane is wide: there the
 * card only stops above the ask bar (which an answer makes taller), and with no ask bar it is not
 * capped (null). In a narrow pane the city can only go below the card, so a tall card
 * (a busy building's) would leave nowhere for the selection and its line labels: there the card is
 * kept short enough that CARD_FREE_SHARE of the height stays free between its reserve
 * (cardReserve, which this lands on a step of) and the ask bar's, and its body scrolls.
 */
export function cardMaxHeight(width: number, height: number, right: number, ask: number): number | null {
  if (!(width > 0) || !(height > 0)) return null
  if (width - right - cardReserve(CARD_WIDTH_PX, 1)[0] >= CARD_MIN_FREE_PX) {
    return ask > 0 ? Math.max(CARD_MIN_HEIGHT_PX, Math.floor(height - ask - CARD_INSET_PX - CARD_CLEARANCE_PX)) : null
  }
  const room = height - ask - Math.ceil(height * CARD_FREE_SHARE)
  const box = Math.floor(room / CARD_STEP_PX) * CARD_STEP_PX - CARD_INSET_PX - CARD_CLEARANCE_PX
  return Math.max(CARD_MIN_HEIGHT_PX, box)
}

/**
 * Whether the open card, at its CARD_WIDTH_PX (held inside a `width` stage's edges), comes within its
 * clearance of the legend drawn `legend` pixels from the right edge (LEGEND_RESERVE expanded,
 * LEGEND_CHIP_RESERVE as a chip): in a narrow pane the two would sit on each other, so the legend is
 * put away while the card is open. An unmeasured stage (0) never puts it away.
 */
export function cardMeetsLegend(width: number, legend: number): boolean {
  return width > 0 && CARD_INSET_PX + Math.min(CARD_WIDTH_PX, width - CARD_INSET_PX * 2) + CARD_CLEARANCE_PX > width - legend
}

export function worldPaneStyle(background: string, width: number): CSSProperties {
  return {
    position: 'relative', flex: '0 0 auto', width, minWidth: width, overflow: 'hidden',
    display: 'flex', flexDirection: 'column', background, color: '#cccccc',
  }
}

/**
 * The pane's width and its divider's drag handler. `mainRef` is the terminals' column: the room is its
 * width plus the pane and divider now beside it, so it holds whatever else shares the row.
 */
export function useWorldPaneWidth(mainRef: RefObject<HTMLElement | null>, active: boolean): { width: number; min: number; max: number; onDrag: (dx: number) => void } {
  const [room, setRoom] = useState(() => window.innerWidth)
  const [saved, setSaved] = useState<number | null>(loadWorldPaneWidth)
  const width = clampWorldPaneWidth(saved ?? Math.round(room * WORLD_PANE_DEFAULT_FRACTION), room)
  const widthRef = useRef(width)
  widthRef.current = width

  useLayoutEffect(() => {
    if (!active) return
    const measure = (): void => setRoom((mainRef.current as HTMLElement).clientWidth + widthRef.current + WORLD_DIVIDER_PX)
    measure()
    window.addEventListener('resize', measure)
    // Anything else that resizes the terminals' column (the Changes panel, the sidebar) re-clamps too.
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(mainRef.current as HTMLElement)
    return () => {
      window.removeEventListener('resize', measure)
      observer?.disconnect()
    }
  }, [active, mainRef])

  const roomRef = useRef(room)
  roomRef.current = room
  /** `dx` is how far the divider moved to the right: to the left makes the pane wider. */
  const onDrag = useCallback((dx: number): void => {
    const next = clampWorldPaneWidth(widthRef.current - dx, roomRef.current)
    widthRef.current = next // the next move may come before the next render
    saveWorldPaneWidth(next)
    setSaved(next)
  }, [])
  return { width, min: clampWorldPaneWidth(0, room), max: clampWorldPaneWidth(Infinity, room), onDrag }
}

/**
 * How much bigger than on a laptop the pane draws its panels (uiScale): 1 up to a 1080p window, more on a
 * big monitor, never so much that a narrow pane (`paneWidth`) loses its room for laptop-sized text. Read
 * again as the window changes size.
 */
export function useUiScale(paneWidth: number): number {
  const [win, setWin] = useState(() => [window.innerWidth, window.innerHeight])
  useEffect(() => {
    const read = (): void => setWin([window.innerWidth, window.innerHeight])
    window.addEventListener('resize', read)
    return () => window.removeEventListener('resize', read)
  }, [])
  return uiScale(win[0], win[1], paneWidth)
}

/** The pane's scale (useUiScale), for the panels over the map: WorldView provides it. */
export const UiScaleContext = createContext(1)

/**
 * The style that draws a panel at the pane's scale: a CSS zoom on its outermost box, so its text, its
 * spacing and its own insets all grow together while percentages still resolve against the pane. Only
 * panels get it, never the map's canvas (its pixels and picking stay one to one). None at scale 1.
 */
export function useUiZoom(): CSSProperties {
  const s = useContext(UiScaleContext)
  return s === 1 ? {} : { zoom: s }
}

export function WorldPaneOpening({ width }: { width: number }): JSX.Element {
  return (
    <div data-testid="world-view-opening" style={worldPaneStyle(WORLD_OPENING_BACKGROUND, width)}>
      <div role="status" style={{ margin: 'auto', fontSize: 14, color: '#9ca3af' }}>Opening Lumopolis…</div>
    </div>
  )
}
