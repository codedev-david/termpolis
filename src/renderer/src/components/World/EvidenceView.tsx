// One piece of evidence, shown as plain text (its kind and where it points, and for a test where its result came
// from). Shared by the answer
// panel and the part cards, so an evidence link looks and reads the same wherever it is opened.
import type { Evidence } from '../../../../shared/world/types'
import { evidenceText } from '../../../../shared/world/cardFacts'

export interface EvidenceViewProps {
  evidence: Evidence
  /** When given, a close button is shown (the card's evidence is dismissed; an answer's is toggled by its chip). */
  onClose?: () => void
  className?: string
}

export function EvidenceView({ evidence, onClose, className }: EvidenceViewProps): JSX.Element {
  return (
    <div className={className ?? 'mt-1 text-xs text-[#9ca3af] font-mono break-all'} data-testid="evidence-view">
      <span>{evidenceText(evidence)}</span>
      {onClose && (
        <button type="button" aria-label="Close evidence" onClick={onClose} className="ml-2 text-[#9ca3af] hover:text-white">
          &times;
        </button>
      )}
    </div>
  )
}
