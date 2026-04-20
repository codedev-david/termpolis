import React, { useState } from 'react'
import {
  buildCancelAction,
  buildInterruptAction,
  buildPauseAction,
  buildSteerAction,
  sendIntervention,
} from '../../lib/intervention'

interface Props {
  terminalId: string
  /** Optional label shown above the controls (e.g. the agent's name). */
  agentLabel?: string
  /** Injection point for tests — defaults to window.termpolis. */
  writer?: { writeToTerminal: (id: string, data: string) => void }
}

// User-facing surface for pausing or redirecting an in-flight agent. The
// assumption is that each agent is a pty and writing raw control characters
// or a text prompt is enough to take over. No new IPC surface needed.
export function InterventionControls({ terminalId, agentLabel, writer }: Props) {
  const [steerText, setSteerText] = useState('')
  const [lastAction, setLastAction] = useState<string | null>(null)

  const w = writer ?? (typeof window !== 'undefined' ? window.termpolis : undefined)

  const dispatch = (builder: () => ReturnType<typeof buildPauseAction>) => {
    if (!w) return
    try {
      const action = builder()
      const ok = sendIntervention(w, terminalId, action)
      if (ok) setLastAction(action.label)
    } catch {
      // builder may throw (e.g. empty steer) — already prevented by disabled state
    }
  }

  const handleSteer = () => {
    const text = steerText.trim()
    if (!text) return
    if (!w) return
    const action = buildSteerAction(text)
    const ok = sendIntervention(w, terminalId, action)
    if (ok) {
      setLastAction(action.label)
      setSteerText('')
    }
  }

  const handleSteerKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSteer()
    }
  }

  return (
    <div
      className="border-b border-[#3c3c3c] bg-[#1e1e1e] px-3 py-2 space-y-2"
      data-testid="intervention-controls"
    >
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-[#858585]">
          Intervene
        </span>
        {agentLabel && (
          <span className="text-[10px] text-[#569cd6]" data-testid="intervention-agent-label">
            {agentLabel}
          </span>
        )}
      </div>
      <div className="flex gap-1">
        <button
          type="button"
          onClick={() => dispatch(buildPauseAction)}
          className="px-2 py-1 text-[11px] text-[#cccccc] bg-[#2d2d2d] hover:bg-[#3c3c3c] rounded"
          data-testid="intervention-pause"
          aria-label="Pause agent"
        >
          Pause
        </button>
        <button
          type="button"
          onClick={() => dispatch(buildCancelAction)}
          className="px-2 py-1 text-[11px] text-[#cccccc] bg-[#2d2d2d] hover:bg-[#3c3c3c] rounded"
          data-testid="intervention-cancel"
          aria-label="Cancel current action"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => dispatch(buildInterruptAction)}
          className="px-2 py-1 text-[11px] text-[#ff8a8a] bg-[#2d2d2d] hover:bg-[#3c3c3c] rounded"
          data-testid="intervention-interrupt"
          aria-label="Hard interrupt agent"
        >
          Interrupt
        </button>
      </div>
      <div className="flex gap-1">
        <input
          type="text"
          value={steerText}
          onChange={(e) => setSteerText(e.target.value)}
          onKeyDown={handleSteerKey}
          placeholder="Steer the agent…"
          className="flex-1 bg-[#252526] border border-[#3c3c3c] text-xs text-[#cccccc] px-2 py-1 rounded focus:outline-none focus:border-[#007acc]"
          data-testid="intervention-steer-input"
          aria-label="Steer message"
        />
        <button
          type="button"
          onClick={handleSteer}
          disabled={!steerText.trim()}
          className="px-2 py-1 text-[11px] text-white bg-[#007acc] hover:bg-[#1177bb] rounded disabled:opacity-40"
          data-testid="intervention-steer-send"
          aria-label="Send steer message"
        >
          Steer
        </button>
      </div>
      {lastAction && (
        <div
          className="text-[10px] text-[#6a6a6a] italic"
          data-testid="intervention-last-action"
        >
          {lastAction}
        </div>
      )}
    </div>
  )
}

export default InterventionControls
