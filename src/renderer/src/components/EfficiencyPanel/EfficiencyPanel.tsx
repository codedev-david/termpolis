import { useEfficiencyReport } from '../../hooks/useEfficiencyReport'
import { formatErrorRate, formatAvg } from '../../lib/efficiencyAnalyzer'
import { formatTokens } from '../../lib/costTracker'

interface Props {
  onClose: () => void
}

const AGENT_COLOR: Record<string, string> = {
  claude: '#d7a45a',
  codex: '#10a37f',
  gemini: '#4285f4',
  aider: '#ce9178',
  unknown: '#858585',
}

export function EfficiencyPanel({ onClose }: Props) {
  const { report, refreshing, refresh } = useEfficiencyReport()
  const perAgent = report?.perAgent ?? []

  return (
    <div
      className="flex flex-col h-full border-l border-[#3c3c3c] bg-[#252526] select-none"
      data-testid="efficiency-panel"
      style={{ minWidth: 380 }}
    >
      <div className="flex items-center justify-between px-3 py-2 border-b border-[#3c3c3c]">
        <div className="text-xs font-semibold text-[#cccccc] uppercase tracking-wide">
          Agent Efficiency
        </div>
        <div className="flex items-center gap-1">
          <button
            className="text-[#858585] hover:text-white text-[10px] px-1.5"
            onClick={() => refresh()}
            disabled={refreshing}
            aria-label="Refresh efficiency report"
          >
            {refreshing ? '…' : '↻'}
          </button>
          <button
            className="text-[#858585] hover:text-white text-xs px-2"
            onClick={onClose}
            aria-label="Close efficiency panel"
          >
            ×
          </button>
        </div>
      </div>

      {report && (
        <div className="px-3 py-2 border-b border-[#3c3c3c] text-[10px] text-[#858585] flex justify-between">
          <span>{report.totals.agents} agents · {report.totals.terminals} terminals</span>
          <span>{report.totals.events} events · {report.totals.errors} errors</span>
        </div>
      )}

      <div className="flex-1 overflow-auto">
        {perAgent.length === 0 && (
          <div className="text-[#6a6a6a] text-xs text-center py-6 px-3">
            No agent activity in the recent window.
          </div>
        )}
        {perAgent.map((s) => (
          <div
            key={s.agentType}
            data-testid="efficiency-row"
            className="px-3 py-2 border-b border-[#2d2d2d] text-xs"
          >
            <div className="flex items-center gap-2">
              <span
                className="inline-block w-2 h-2 rounded-full shrink-0"
                style={{ backgroundColor: AGENT_COLOR[s.agentType] ?? '#858585' }}
              />
              <span className="text-[#cccccc] uppercase tracking-wide">{s.agentType}</span>
              <span className="ml-auto text-[10px] text-[#858585]">{s.totalEvents} events</span>
            </div>
            <div className="grid grid-cols-3 gap-x-3 gap-y-0.5 mt-1 text-[10px] text-[#858585]">
              <div><span className="text-[#cccccc]">{s.toolCalls}</span> tool calls</div>
              <div><span className="text-[#cccccc]">{s.messages}</span> messages</div>
              <div><span className="text-[#cccccc]">{s.uniqueFilesTouched}</span> files</div>
              <div>err <span className={s.errorRate > 0.2 ? 'text-[#e06c75]' : 'text-[#98c379]'}>{formatErrorRate(s.errorRate)}</span></div>
              <div>avg calls/msg <span className="text-[#cccccc]">{formatAvg(s.toolCallsPerMessage)}</span></div>
              <div>
                tokens {formatTokens(s.tokensIn)}/{formatTokens(s.tokensOut)}
              </div>
            </div>
          </div>
        ))}
      </div>

      {report && (
        <div className="border-t border-[#3c3c3c] p-2 text-[10px] text-[#858585] space-y-0.5">
          {report.leaders.lowestErrorRate && (
            <div>lowest error rate: <span className="text-[#cccccc]">{report.leaders.lowestErrorRate}</span></div>
          )}
          {report.leaders.fewestToolCallsPerMessage && (
            <div>fewest tool calls per message: <span className="text-[#cccccc]">{report.leaders.fewestToolCallsPerMessage}</span></div>
          )}
          {report.leaders.mostFilesTouched && (
            <div>most files touched: <span className="text-[#cccccc]">{report.leaders.mostFilesTouched}</span></div>
          )}
        </div>
      )}
    </div>
  )
}

export default EfficiencyPanel
