// The frame of the Lumopolis pane: a resizable column in the app's flex row, beside the terminals (like
// the Changes panel), never an overlay. Opaque background from its first frame. Inline styles, so the
// frame never depends on which utility classes the CSS build happens to contain.
//
// Width: the saved width (localStorage) or half the row, kept within [WORLD_PANE_MIN_PX, row minus
// TERMINAL_MIN_PX]. The terminal minimum wins when the row is too narrow for both: the pane shrinks
// under its minimum rather than squeeze the terminals.
//
// App shows WorldPaneOpening while the Lumopolis chunk (the engine and Three.js) loads. This module
// imports nothing from the engine, so it stays small enough for App's main chunk.
import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, RefObject } from 'react'

/** The Neon theme's background (themes.ts): the pane always opens in Neon. A test keeps the two equal. */
export const WORLD_OPENING_BACKGROUND = '#03050a'

export const WORLD_PANE_MIN_PX = 360
export const TERMINAL_MIN_PX = 320
export const WORLD_PANE_DEFAULT_FRACTION = 0.5
/** The divider's width: it sits in the same row, between the terminals and the pane. */
export const WORLD_DIVIDER_PX = 4
const WIDTH_KEY = 'termpolis.world.paneWidth'

/** The pane's width within a row `rowWidth` wide (the room for the terminals and the pane together). */
export function clampWorldPaneWidth(px: number, rowWidth: number): number {
  const room = Math.max(0, rowWidth - TERMINAL_MIN_PX)
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
export function useWorldPaneWidth(mainRef: RefObject<HTMLElement | null>, active: boolean): { width: number; onDrag: (dx: number) => void } {
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
    return () => window.removeEventListener('resize', measure)
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
  return { width, onDrag }
}

export function WorldPaneOpening({ width }: { width: number }): JSX.Element {
  return (
    <div data-testid="world-view-opening" style={worldPaneStyle(WORLD_OPENING_BACKGROUND, width)}>
      <div role="status" style={{ margin: 'auto', fontSize: 14, color: '#9ca3af' }}>Opening Lumopolis…</div>
    </div>
  )
}
