import { useRedundancyFindings } from '../../hooks/useRedundancyFindings'
import { describeFinding } from '../../lib/redundancyDetector'

interface Props {
  onClose: () => void
}

const SEVERITY_COLOR: Record<string, string> = {
  high: '#e06c75',
  medium: '#e5c07b',
  low: '#98c379',
}

export function RedundancyPanel({ onClose }: Props) {
  const { findings, refreshing, refresh } = useRedundancyFindings()

  return (
    <div
      className="flex flex-col h-full border-l border-[#3c3c3c] bg-[#252526] select-none"
      data-testid="redundancy-panel"
      style={{ minWidth: 360 }}
    >
      <div className="flex items-center justify-between px-3 py-2 border-b border-[#3c3c3c]">
        <div className="text-xs font-semibold text-[#cccccc] uppercase tracking-wide">
          Duplicate Work ({findings.length})
        </div>
        <div className="flex items-center gap-1">
          <button
            className="text-[#858585] hover:text-white text-[10px] px-1.5"
            onClick={() => refresh()}
            disabled={refreshing}
            aria-label="Refresh redundancy findings"
          >
            {refreshing ? '…' : '↻'}
          </button>
          <button
            className="text-[#858585] hover:text-white text-xs px-2"
            onClick={onClose}
            aria-label="Close redundancy panel"
          >
            ×
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        {findings.length === 0 && (
          <div className="text-[#6a6a6a] text-xs text-center py-6 px-3">
            No duplicate work detected across terminals in the last few minutes.
          </div>
        )}
        {findings.map((f) => (
          <div
            key={f.id}
            data-testid="redundancy-item"
            className="px-3 py-2 border-b border-[#2d2d2d] text-xs"
          >
            <div className="flex items-center gap-2">
              <span
                className="inline-block w-2 h-2 rounded-full shrink-0"
                style={{ backgroundColor: SEVERITY_COLOR[f.severity] }}
                title={`severity: ${f.severity}`}
              />
              <span className="truncate text-[#cccccc]">{describeFinding(f)}</span>
            </div>
            <div className="text-[10px] text-[#858585] mt-0.5 font-mono break-all">
              {f.kind} · {f.uniqueTerminals} terminals · {f.participants.length} events
            </div>
            <div className="mt-1 flex flex-wrap gap-1">
              {f.participants.map((p) => (
                <span
                  key={p.eventId}
                  className="text-[10px] bg-[#1e1e1e] border border-[#3c3c3c] rounded px-1 py-px text-[#569cd6]"
                  title={new Date(p.ts).toLocaleString()}
                >
                  {p.agentType}·{p.terminalId.slice(0, 6)}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export default RedundancyPanel
