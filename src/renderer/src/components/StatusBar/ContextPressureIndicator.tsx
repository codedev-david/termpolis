import {
  type ContextWindow,
  type PressureLevel,
  pressureLevel,
  pressureRatio,
  formatPressure,
} from '../../lib/contextPressure'

// How full is the focused agent's context window right now — so you can SEE
// compaction coming. Pure presentation: the hook computes the ContextWindow, this
// renders a compact colored pill. Renders nothing until there's a real signal, so it
// never clutters the status bar for a fresh or non-agent terminal.

const TONE: Record<PressureLevel, { dot: string; text: string; label: string }> = {
  ok: { dot: 'bg-[#3fb950]', text: 'text-[#7ee2a3]', label: 'healthy' },
  warn: { dot: 'bg-[#d4a72c]', text: 'text-[#e3b341]', label: 'filling up' },
  danger: { dot: 'bg-[#db6d28]', text: 'text-[#f0883e]', label: 'nearly full' },
  critical: { dot: 'bg-[#f85149]', text: 'text-[#ff7b72]', label: 'compaction imminent' },
}

export function ContextPressureIndicator({
  pressure,
}: {
  pressure: ContextWindow | null
}): React.JSX.Element | null {
  if (!pressure || pressure.total <= 0 || pressure.used <= 0) return null
  const level = pressureLevel(pressure)
  const pct = Math.round(pressureRatio(pressure) * 100)
  const tone = TONE[level]
  const estimated = pressure.source === 'heuristic' ? ' (estimated)' : ''
  return (
    <span
      className={`inline-flex items-center gap-1 ${tone.text}`}
      data-testid="context-pressure-indicator"
      data-level={level}
      aria-label={`Context window ${pct}% full — ${tone.label}`}
      title={
        `${pressure.model} context ${tone.label}: ${formatPressure(pressure)}${estimated}. ` +
        `Your memory brain holds the rest — Termpolis auto-recalls after compaction.`
      }
    >
      <span className={`inline-block h-2 w-2 rounded-full ${tone.dot}`} aria-hidden="true" />
      <span>ctx {pct}%</span>
    </span>
  )
}
