import React, { useState, useRef } from 'react'
import { createPortal } from 'react-dom'
import { TabPopover } from '../TabPopover/TabPopover'
import type { TerminalSession } from '../../types'

const SHELL_ICON: Record<string, string> = {
  bash: '$', zsh: '%', cmd: '>', powershell: 'PS', gitbash: '$',
}

interface Props {
  terminal: TerminalSession
  index: number
  isActive: boolean
  onClick: () => void
  onClose: () => void
  onUpdate: (patch: Partial<Omit<TerminalSession, 'id'>>) => void
}

export function TerminalTab({ terminal, index, isActive, onClick, onClose, onUpdate }: Props) {
  const [popoverOpen, setPopoverOpen] = useState(false)
  const rowRef = useRef<HTMLDivElement>(null)

  return (
    <div
      ref={rowRef}
      className={`relative flex items-center gap-2 px-3 py-2 cursor-pointer select-none group ${isActive ? 'bg-[#37373d]' : 'hover:bg-[#2a2d2e]'}`}
      style={{ borderLeft: `3px solid ${terminal.color}` }}
      onClick={onClick}
      onContextMenu={e => { e.preventDefault(); setPopoverOpen(true) }}
    >
      <span className="text-[#6b7280] text-xs w-4 text-center font-mono" title={index < 9 ? `Alt+${index + 1}` : undefined}>
        {index < 9 ? index + 1 : SHELL_ICON[terminal.shellType] ?? '$'}
      </span>
      <span className="flex-1 text-sm truncate">{terminal.name}</span>
      <button
        onClick={e => { e.stopPropagation(); setPopoverOpen(true) }}
        className="opacity-0 group-hover:opacity-100 text-[#6b7280] hover:text-white text-xs px-1"
        aria-label="Edit terminal"
      >✎</button>
      <button
        onClick={e => { e.stopPropagation(); onClose() }}
        className="text-[#6b7280] hover:text-white text-xs px-1"
        aria-label={`Close ${terminal.name}`}
      >✕</button>
      {popoverOpen && createPortal(
        <TabPopover
          name={terminal.name}
          color={terminal.color}
          fontSize={terminal.fontSize}
          theme={terminal.theme}
          fontFamily={terminal.fontFamily}
          anchorEl={rowRef.current}
          onSave={patch => { onUpdate(patch); setPopoverOpen(false) }}
          onClose={() => setPopoverOpen(false)}
        />,
        document.body
      )}
    </div>
  )
}
