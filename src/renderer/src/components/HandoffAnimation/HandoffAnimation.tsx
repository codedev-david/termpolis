import { useEffect, useState } from 'react'

interface Props {
  fromAgent?: string
  toAgent: string
  durationMs?: number
  onComplete?: () => void
}

export function HandoffAnimation({
  fromAgent,
  toAgent,
  durationMs = 1800,
  onComplete,
}: Props) {
  const [visible, setVisible] = useState(true)

  useEffect(() => {
    const t = setTimeout(() => {
      setVisible(false)
      onComplete?.()
    }, durationMs)
    return () => clearTimeout(t)
  }, [durationMs, onComplete])

  if (!visible) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none"
      data-testid="handoff-animation"
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center gap-4 bg-[#1e1e1e]/90 backdrop-blur-sm border border-[#3c5f8a] rounded-full px-6 py-3 shadow-xl">
        <span className="text-[#cccccc] text-sm font-medium">
          {fromAgent ?? 'Conductor'}
        </span>
        <span
          className="inline-block w-16 h-[2px] bg-gradient-to-r from-[#22d3ee] to-[#d7a45a] animate-pulse"
          data-testid="handoff-arrow"
        />
        <i className="fa-solid fa-arrow-right text-[#22d3ee] text-xs"></i>
        <span className="text-[#d7a45a] text-sm font-semibold">{toAgent}</span>
      </div>
    </div>
  )
}

export default HandoffAnimation
