import React, { useEffect } from 'react'

interface Props {
  suggestion: string
  onAccept: () => void
  onDismiss: () => void
}

export const CommandFixBanner = React.memo(function CommandFixBanner({ suggestion, onAccept, onDismiss }: Props) {
  // Auto-dismiss after 10 seconds
  useEffect(() => {
    const timer = setTimeout(onDismiss, 10000)
    return () => clearTimeout(timer)
  }, [onDismiss])

  // Keyboard handler for Enter/Esc
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        e.stopPropagation()
        onAccept()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onDismiss()
      }
    }

    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [onAccept, onDismiss])

  return (
    <div
      className="absolute bottom-0 left-0 right-0 z-40 flex items-center justify-between px-3 py-2 text-xs"
      style={{
        backgroundColor: '#1e3a1e',
        borderTop: '1px solid #2d5a2d',
      }}
    >
      <div className="flex items-center gap-2 min-w-0">
        <span className="shrink-0" style={{ color: '#7ec87e' }}>
          💡 Fix:
        </span>
        <code
          className="truncate"
          style={{
            color: '#c8e6c8',
            backgroundColor: '#264026',
            padding: '1px 6px',
            borderRadius: 3,
            fontFamily: 'inherit',
          }}
        >
          {suggestion}
        </code>
      </div>
      <span className="shrink-0 ml-3" style={{ color: '#6b9b6b' }}>
        Enter to run · Esc to ignore
      </span>
    </div>
  )
})
