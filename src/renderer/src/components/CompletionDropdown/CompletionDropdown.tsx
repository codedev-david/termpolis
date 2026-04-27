import React from 'react'
import type { CompletionResult } from '../../completions/completionEngine'

interface Props {
  suggestions: CompletionResult[]
  selectedIndex: number
  position: { x: number; y: number }
  onAccept: (suggestion: CompletionResult) => void
  onDismiss: () => void
}

export const CompletionDropdown = React.memo(function CompletionDropdown({ suggestions, selectedIndex, position, onAccept }: Props) {
  if (suggestions.length === 0) return null

  return (
    <div
      style={{
        position: 'fixed',
        left: position.x,
        top: position.y,
        zIndex: 100,
      }}
      className="bg-[#252526] border border-[#3c3c3c] rounded shadow-xl min-w-[240px] max-w-[360px] overflow-hidden"
    >
      {suggestions.map((s, i) => (
        <div
          key={s.text}
          data-selected={i === selectedIndex ? '' : undefined}
          onClick={() => onAccept(s)}
          className={`flex items-center justify-between px-3 py-1.5 text-xs cursor-pointer ${
            i === selectedIndex ? 'bg-[#04395e] text-white' : 'text-[#d4d4d4] hover:bg-[#2a2d2e]'
          }`}
        >
          <span className="font-medium truncate">{s.text}</span>
          <span className="text-[#999] ml-3 truncate text-[10px]">{s.description}</span>
        </div>
      ))}
      <div className="px-3 py-1 text-[10px] text-[#999] border-t border-[#3c3c3c]">
        {'\u2191\u2193 navigate \u00b7 Tab accept \u00b7 Esc dismiss'}
      </div>
    </div>
  )
})
