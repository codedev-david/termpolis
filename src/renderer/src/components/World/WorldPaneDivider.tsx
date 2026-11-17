// The handle between the terminals and the Lumopolis pane: drag it, or focus it and press the arrow
// keys. It reports how far it moved to the right; App turns that into the pane's width.
import { useEffect, useRef } from 'react'
import type { KeyboardEvent, MouseEvent } from 'react'
import { WORLD_DIVIDER_PX } from './worldPane'

export const DIVIDER_KEY_STEP_PX = 24

export function WorldPaneDivider({ onDrag, width, min, max }: { onDrag(dx: number): void; width: number; min: number; max: number }): JSX.Element {
  // Ends a drag in progress: the mouse-up, or the divider unmounting under it (the pane closed by a
  // shortcut mid-drag), which must not leave its listeners on the window.
  const stopRef = useRef<(() => void) | null>(null)
  useEffect(() => () => stopRef.current?.(), [])
  const onMouseDown = (down: MouseEvent): void => {
    down.preventDefault()
    let last = down.clientX
    const move = (e: globalThis.MouseEvent): void => {
      onDrag(e.clientX - last)
      last = e.clientX
    }
    const up = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      stopRef.current = null
    }
    stopRef.current = up
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    onDrag(e.key === 'ArrowLeft' ? -DIVIDER_KEY_STEP_PX : DIVIDER_KEY_STEP_PX)
  }
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-label="Resize Lumopolis"
      tabIndex={0}
      data-testid="world-pane-divider"
      onMouseDown={onMouseDown}
      onKeyDown={onKeyDown}
      className="hover:bg-[#007acc] focus:bg-[#007acc] outline-none"
      style={{ flex: '0 0 auto', width: WORLD_DIVIDER_PX, cursor: 'col-resize', background: '#3c3c3c' }}
    />
  )
}
