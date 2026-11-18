// The Lumopolis answer panel. The agent's text is only ever rendered as React text nodes: a small
// markdown subset (paragraphs, lists, bold, italic, code) becomes React elements, [E<n>] markers become
// evidence chips, and nothing is parsed as HTML.
import { Fragment, useState, type ReactNode } from 'react'
import { answerText, type WorldAnswer as Answer } from '../../../../shared/world/answerProtocol'
import { parseAnswerMarkdown, type Inline } from '../../../../shared/world/answerMarkdown'
import type { CitedEvidence } from '../../../../shared/world/types'
import { EvidenceView } from './EvidenceView'

export interface WorldAnswerPanelProps {
  answer: Answer
  cited: Record<string, CitedEvidence>
  /** How many sentences are on show: the answer appears one sentence at a time. */
  revealed: number
  onClose: () => void
  onReplay: () => void
  /** Opens the part's card; `highlight` (when not empty) names the parts to highlight with it. */
  onOpenPart: (id: string, highlight: string[]) => void
  /** The name of a building or edge, for the chip that cites it. */
  partName: (id: string) => string | undefined
  /** True when the id is a building or edge in the loaded world. */
  isPart: (id: string) => boolean
}

export function WorldAnswerPanel({ answer, cited, revealed, onClose, onReplay, onOpenPart, partName, isPart }: WorldAnswerPanelProps): JSX.Element {
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const blocks = parseAnswerMarkdown(answerText(answer.sentences, revealed))
  const shown = Object.keys(open).filter((k) => open[k])

  const click = (label: string): void => {
    const ev = cited[label]
    if (isPart(ev.ref)) onOpenPart(ev.ref, ev.items)
    else {
      setOpen((o) => ({ ...o, [label]: !o[label] }))
      if (ev.items.length > 0) onOpenPart(ev.items[0], ev.items)
    }
  }

  /** `E1`, or `E1 · <part name>` when the evidence points at a part. */
  const chipText = (label: string): string => {
    const ev = cited[label]
    const id = isPart(ev.ref) ? ev.ref : ev.items[0]
    const name = id === undefined ? undefined : partName(id)
    return name === undefined ? label : `${label} · ${name}`
  }

  const inline = (nodes: Inline[]): ReactNode[] =>
    nodes.map((n, i) => {
      if (n.t === 'text') return <Fragment key={i}>{n.v}</Fragment>
      if (n.t === 'code') return <code key={i} className="px-1 rounded bg-[#1e1e1e] text-[#ce9178] text-[0.9em]">{n.v}</code>
      if (n.t === 'b') return <strong key={i} className="font-semibold text-white">{inline(n.c)}</strong>
      if (n.t === 'i') return <em key={i}>{inline(n.c)}</em>
      // An unknown marker stays plain text.
      if (!cited[n.v]) return <Fragment key={i}>{`[${n.v}]`}</Fragment>
      return (
        <button
          key={i}
          type="button"
          aria-label={`Evidence ${n.v}`}
          onClick={() => click(n.v)}
          className="mx-0.5 px-1.5 rounded bg-[#0078d4]/30 text-[#4fc1ff] text-xs hover:bg-[#0078d4]/50"
        >
          {chipText(n.v)}
        </button>
      )
    })

  return (
    <div className="w-full rounded border border-[#3c3c3c] bg-[#252526] text-sm text-[#d4d4d4] shadow-lg p-3" data-testid="world-answer">
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0 leading-relaxed space-y-2 break-words" data-testid="world-answer-text">
          {blocks.map((b, i) =>
            b.type === 'p' ? (
              <p key={i}>
                {b.lines.map((l, j) => (
                  <Fragment key={j}>
                    {j > 0 && <br />}
                    {inline(l)}
                  </Fragment>
                ))}
              </p>
            ) : (
              <Fragment key={i}>
                {b.type === 'ul' ? (
                  <ul className="list-disc pl-5 space-y-0.5">{b.items.map((it, j) => <li key={j}>{inline(it)}</li>)}</ul>
                ) : (
                  <ol className="list-decimal pl-5 space-y-0.5">{b.items.map((it, j) => <li key={j}>{inline(it)}</li>)}</ol>
                )}
              </Fragment>
            )
          )}
        </div>
        <button type="button" aria-label="Close answer" onClick={onClose} className="text-[#9ca3af] hover:text-white px-1">
          &times;
        </button>
      </div>
      {(answer.unsupported.length > 0 || answer.uncited) && (
        <div role="note" className="mt-2 text-xs text-[#d7ba7d] space-y-0.5" data-testid="world-answer-honesty">
          {answer.unsupported.length > 0 && <p>The evidence doesn&apos;t say. The fogged parts aren&apos;t supported.</p>}
          {answer.uncited && <p>This answer cites no evidence.</p>}
        </div>
      )}
      {shown.map((label) => (
        <EvidenceView key={label} evidence={cited[label]} />
      ))}
      <div className="mt-2">
        <button type="button" onClick={onReplay} className="text-xs px-2 py-1 rounded border border-[#3c3c3c] hover:bg-[#2a2d2e]">
          Show me again
        </button>
      </div>
    </div>
  )
}
