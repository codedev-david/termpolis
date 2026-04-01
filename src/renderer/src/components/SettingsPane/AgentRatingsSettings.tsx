import React, { useState } from 'react'
import { useTerminalStore } from '../../store/terminalStore'
import {
  DEFAULT_AGENT_CAPABILITIES,
  CATEGORY_LABELS,
  STRENGTH_CATEGORIES,
  getEffectiveCapabilities,
  type AgentRatingOverrides,
  type StrengthCategory,
} from '../../lib/agentCapabilities'

export function AgentRatingsSettings() {
  const overrides = useTerminalStore(s => s.agentRatingOverrides)
  const setOverrides = useTerminalStore(s => s.setAgentRatingOverrides)
  const [showResetConfirm, setShowResetConfirm] = useState(false)

  const effective = getEffectiveCapabilities(overrides)

  const handleChange = (agentId: string, category: StrengthCategory, value: number) => {
    const defaultAgent = DEFAULT_AGENT_CAPABILITIES.find(a => a.agentId === agentId)
    if (!defaultAgent) return

    const clamped = Math.max(1, Math.min(5, value))
    const newOverrides = { ...overrides }

    // If value matches default, remove the override
    if (clamped === defaultAgent.strengths[category]) {
      if (newOverrides[agentId]) {
        const { [category]: _, ...rest } = newOverrides[agentId]
        if (Object.keys(rest).length === 0) {
          delete newOverrides[agentId]
        } else {
          newOverrides[agentId] = rest
        }
      }
    } else {
      newOverrides[agentId] = { ...newOverrides[agentId], [category]: clamped }
    }

    setOverrides(newOverrides)
  }

  const isCustomized = (agentId: string, category: StrengthCategory): boolean => {
    return overrides[agentId]?.[category] !== undefined
  }

  const hasAnyOverrides = Object.keys(overrides).length > 0

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-[#d4d4d4]">Agent Capability Ratings</h3>
        {hasAnyOverrides && (
          showResetConfirm ? (
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-[#E57373]">Reset all to defaults?</span>
              <button onClick={() => { setOverrides({}); setShowResetConfirm(false) }} className="text-[10px] px-2 py-0.5 rounded bg-[#E57373]/20 text-[#E57373] hover:bg-[#E57373]/30">Reset</button>
              <button onClick={() => setShowResetConfirm(false)} className="text-[10px] px-2 py-0.5 rounded text-[#999] hover:bg-[#37373d]">Cancel</button>
            </div>
          ) : (
            <button onClick={() => setShowResetConfirm(true)} className="text-[10px] text-[#9ca3af] hover:text-white">
              Reset All
            </button>
          )
        )}
      </div>

      <p className="text-[11px] text-[#9ca3af] mb-3 leading-relaxed">
        These ratings guide the AI conductor and smart router when assigning tasks to agents.
        Defaults are estimated based on general model capabilities as of March 2026.
        The conductor uses these as hints but makes its own judgment — adjust based on your experience.
      </p>

      <div className="space-y-4">
        {effective.map(agent => (
          <div key={agent.agentId} className="p-3 bg-[#1e1e1e] border border-[#3c3c3c] rounded-lg">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-sm font-medium text-[#d4d4d4]">{agent.agentName}</span>
              <span className="text-[10px] text-[#9ca3af] bg-[#2d2d2d] px-1.5 py-0.5 rounded">{agent.tokenCost === 'free' ? 'Free' : agent.tokenCost + ' cost'}</span>
              {agent.hasMcp && <span className="text-[10px] text-[#22D3EE] bg-[#22D3EE]/10 px-1.5 py-0.5 rounded">MCP</span>}
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
              {STRENGTH_CATEGORIES.map(cat => {
                const val = agent.strengths[cat]
                const customized = isCustomized(agent.agentId, cat)
                return (
                  <div key={cat} className="flex items-center gap-2">
                    <span className={`text-[11px] w-24 truncate ${customized ? 'text-[#22D3EE]' : 'text-[#9ca3af]'}`}>
                      {CATEGORY_LABELS[cat]}
                    </span>
                    <div className="flex items-center gap-0.5">
                      {[1, 2, 3, 4, 5].map(n => (
                        <button
                          key={n}
                          onClick={() => handleChange(agent.agentId, cat, n)}
                          className={`w-5 h-5 rounded text-[10px] font-semibold transition-colors ${
                            n <= val
                              ? customized
                                ? 'bg-[#22D3EE]/30 text-[#22D3EE] border border-[#22D3EE]/40'
                                : 'bg-[#3c3c3c] text-[#d4d4d4] border border-[#555]'
                              : 'bg-[#252526] text-[#555] border border-[#3c3c3c] hover:border-[#555]'
                          }`}
                        >
                          {n}
                        </button>
                      ))}
                    </div>
                    {customized && (
                      <button
                        onClick={() => handleChange(agent.agentId, cat, DEFAULT_AGENT_CAPABILITIES.find(a => a.agentId === agent.agentId)!.strengths[cat])}
                        className="text-[9px] text-[#9ca3af] hover:text-white"
                        title="Reset to default"
                      >
                        <i className="fa-solid fa-rotate-left"></i>
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
