import React, { useCallback, useRef } from 'react'

interface Props {
  direction: 'horizontal' | 'vertical'
  onDrag: (ratio: number) => void
  parentRef: React.RefObject<HTMLDivElement | null>
}

export function SplitDivider({ direction, onDrag, parentRef }: Props) {
  const dragging = useRef(false)

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      dragging.current = true

      const onMouseMove = (ev: MouseEvent) => {
        if (!dragging.current || !parentRef.current) return
        const rect = parentRef.current.getBoundingClientRect()
        let ratio: number
        if (direction === 'horizontal') {
          ratio = (ev.clientY - rect.top) / rect.height
        } else {
          ratio = (ev.clientX - rect.left) / rect.width
        }
        // Clamp between 10% and 90%
        ratio = Math.max(0.1, Math.min(0.9, ratio))
        onDrag(ratio)
      }

      const onMouseUp = () => {
        dragging.current = false
        document.removeEventListener('mousemove', onMouseMove)
        document.removeEventListener('mouseup', onMouseUp)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }

      document.body.style.cursor = direction === 'horizontal' ? 'row-resize' : 'col-resize'
      document.body.style.userSelect = 'none'
      document.addEventListener('mousemove', onMouseMove)
      document.addEventListener('mouseup', onMouseUp)
    },
    [direction, onDrag, parentRef]
  )

  const isHorizontal = direction === 'horizontal'

  return (
    <div
      className={`shrink-0 bg-[#3c3c3c] hover:bg-[#007acc] transition-colors ${
        isHorizontal ? 'cursor-row-resize' : 'cursor-col-resize'
      }`}
      style={{
        width: isHorizontal ? '100%' : 4,
        height: isHorizontal ? 4 : '100%',
      }}
      onMouseDown={handleMouseDown}
    />
  )
}
