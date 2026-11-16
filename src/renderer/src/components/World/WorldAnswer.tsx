// The Lumopolis answer panel. The agent's text is only ever rendered as React text nodes: [E<n>]
// markers are split out of it and become evidence chips, nothing is parsed as HTML.
import { useState } from 'react'
import type { WorldAnswer as Answer } from '../../../../shared/world/answerProtocol'
import type { Evidence } from '../../../../shared/world/types'

export interface WorldAnswerPanelProps {
  answer: Answer
  cited: Record<string, Evidence>
  onClose: () => void
  onReplay: () => void
  onOpenPart: (id: string) => void
  /** True when the id is a building or edge in the loaded world. */
  isPart: (id: string) => boolean
}

const MARKER = /(\[E\d+\])/
const LABEL = /^\[(E\d+)\]$/

export function WorldAnswerPanel({ answer, cited, onClose, onReplay, onOpenPart, isPart }: WorldAnswerPanelProps): JSX.Element {
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const parts = answer.text.split(MARKER)
  const shown = Object.keys(open).filter((k) => open[k])

  const click = (label: string): void => {
    const ev = cited[label]
    if (isPart(ev.ref)) onOpenPart(ev.ref)
    else setOpen((o) => ({ ...o, [label]: !o[label] }))
  }

  return (
    <div className="w-[34rem] max-w-[90vw] rounded border border-[#3c3c3c] bg-[#252526] text-sm text-[#d4d4d4] shadow-lg p-3" data-testid="world-answer">
      <div className="flex items-start gap-2">
        <p className="flex-1 whitespace-pre-wrap leading-relaxed">
          {parts.map((part, i) => {
            const label = LABEL.exec(part)?.[1]
            if (label === undefined || !cited[label]) return <span key={i}>{part}</span>
            return (
              <button
                key={i}
                type="button"
                aria-label={`Evidence ${label}`}
                onClick={() => click(label)}
                className="mx-0.5 px-1.5 rounded bg-[#0078d4]/30 text-[#4fc1ff] text-xs hover:bg-[#0078d4]/50"
              >
                {label}
              </button>
            )
          })}
        </p>
        <button type="button" aria-label="Close answer" onClick={onClose} className="text-[#9ca3af] hover:text-white px-1">
          &times;
        </button>
      </div>
      {shown.map((label) => (
        <div key={label} className="mt-1 text-xs text-[#9ca3af] font-mono break-all">{`${cited[label].kind} ${cited[label].ref}`}</div>
      ))}
      <div className="mt-2">
        <button type="button" onClick={onReplay} className="text-xs px-2 py-1 rounded border border-[#3c3c3c] hover:bg-[#2a2d2e]">
          Show me again
        </button>
      </div>
    </div>
  )
}
