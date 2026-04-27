import { useMemo } from 'react'
import { useActivityFeed } from '../../hooks/useActivityFeed'
import {
  computePressure,
  pressureRatio,
  pressureLevel,
  formatPressure,
} from '../../lib/contextPressure'

interface Props {
  terminalId: string
  /** Agent model name when known (e.g. "claude-opus-4-7") */
  model?: string
  /** Optional click handler to open the full context pins panel */
  onClick?: () => void
}

const LEVEL_COLOR: Record<string, string> = {
  ok: '#98c379',
  warn: '#e5c07b',
  danger: '#d19a66',
  critical: '#e06c75',
}

export function ContextGauge({ terminalId, model, onClick }: Props) {
  const { events } = useActivityFeed()
  const window = useMemo(() => {
    const scoped = events.filter((e) => e.terminalId === terminalId)
    return computePressure(scoped, { model })
  }, [events, terminalId, model])

  const ratio = pressureRatio(window)
  const level = pressureLevel(window)
  const color = LEVEL_COLOR[level] ?? '#98c379'
  const pct = Math.round(ratio * 100)

  return (
    <button
      type="button"
      className="flex items-center gap-1.5 text-xs px-2 py-0.5 rounded hover:bg-[#2a2d2e]"
      title={`Context ${formatPressure(window)} (${window.source})`}
      onClick={onClick}
      aria-label={`Context pressure ${pct} percent`}
      data-testid="context-gauge"
    >
      <div
        className="w-16 h-2 rounded-sm overflow-hidden bg-[#2d2d2d]"
        aria-hidden="true"
      >
        <div
          style={{
            width: `${pct}%`,
            backgroundColor: color,
            transition: 'width 200ms ease',
            height: '100%',
          }}
        />
      </div>
      <span className="text-[#cccccc] tabular-nums">{pct}%</span>
      {window.source === 'heuristic' && (
        <span className="text-[#858585] text-[10px]" title="Estimated (no transcript tokens)">~</span>
      )}
    </button>
  )
}

export default ContextGauge
