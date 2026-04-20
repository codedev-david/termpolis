import { describe, it, expect } from 'vitest'
import {
  analyzeEfficiency,
  formatErrorRate,
  formatAvg,
} from '../../src/renderer/src/lib/efficiencyAnalyzer'
import type { AgentActivityEvent, AgentActivityType } from '../../src/renderer/src/types'

let idCounter = 0
function mk(over: Partial<AgentActivityEvent>): AgentActivityEvent {
  idCounter += 1
  return {
    id: over.id ?? `e${idCounter}`,
    ts: over.ts ?? 100,
    terminalId: over.terminalId ?? 't1',
    agentType: (over.agentType ?? 'claude') as AgentActivityType,
    kind: over.kind ?? 'message',
    summary: '',
    payload: over.payload ?? {},
  }
}

describe('analyzeEfficiency', () => {
  const now = 1_000_000

  it('returns empty report with no events', () => {
    const r = analyzeEfficiency([], { now })
    expect(r.perAgent).toEqual([])
    expect(r.totals.events).toBe(0)
    expect(r.totals.agents).toBe(0)
    expect(r.totals.terminals).toBe(0)
    expect(r.leaders.lowestErrorRate).toBeNull()
  })

  it('aggregates per-agent counts', () => {
    const r = analyzeEfficiency(
      [
        mk({ ts: now - 10, agentType: 'claude', kind: 'message' }),
        mk({ ts: now - 10, agentType: 'claude', kind: 'tool_call', payload: { tool: 'Edit', input: { file_path: '/a' } } }),
        mk({ ts: now - 10, agentType: 'claude', kind: 'tool_call', payload: { tool: 'Bash', input: { command: 'ls' } } }),
        mk({ ts: now - 10, agentType: 'claude', kind: 'tool_result', payload: {} }),
        mk({ ts: now - 10, agentType: 'codex', kind: 'message' }),
        mk({ ts: now - 10, agentType: 'codex', kind: 'tool_call', payload: { tool: 'Read', input: { file_path: '/b' } } }),
        mk({ ts: now - 10, agentType: 'codex', kind: 'tool_result', payload: { isError: true } }),
      ],
      { now, minEventsForLeader: 1 },
    )
    expect(r.perAgent.length).toBe(2)
    const claude = r.perAgent.find((p) => p.agentType === 'claude')!
    expect(claude.toolCalls).toBe(2)
    expect(claude.messages).toBe(1)
    expect(claude.toolCallsPerMessage).toBeCloseTo(2)
    expect(claude.uniqueFilesTouched).toBe(1)
    expect(claude.toolMix.Edit).toBe(1)
    expect(claude.toolMix.Bash).toBe(1)

    const codex = r.perAgent.find((p) => p.agentType === 'codex')!
    expect(codex.errors).toBe(1)
    expect(codex.errorRate).toBeCloseTo(1)
  })

  it('picks up token_update totals', () => {
    const r = analyzeEfficiency(
      [
        mk({ ts: now - 100, agentType: 'claude', kind: 'token_update', payload: { inputTokens: 10, outputTokens: 5 } }),
        mk({ ts: now - 50, agentType: 'claude', kind: 'token_update', payload: { inputTokens: 120, outputTokens: 50, cacheReadTokens: 30 } }),
      ],
      { now, minEventsForLeader: 1 },
    )
    const claude = r.perAgent.find((p) => p.agentType === 'claude')!
    expect(claude.tokensIn).toBe(150)
    expect(claude.tokensOut).toBe(50)
  })

  it('drops events outside the window', () => {
    const r = analyzeEfficiency(
      [
        mk({ ts: now - 60 * 60 * 1000, agentType: 'claude', kind: 'message' }),
        mk({ ts: now - 100, agentType: 'claude', kind: 'message' }),
      ],
      { now, windowMs: 5 * 60 * 1000, minEventsForLeader: 1 },
    )
    expect(r.totals.events).toBe(1)
  })

  it('tracks unique terminals', () => {
    const r = analyzeEfficiency(
      [
        mk({ ts: now - 1, terminalId: 't1' }),
        mk({ ts: now - 1, terminalId: 't2' }),
        mk({ ts: now - 1, terminalId: 't1' }),
      ],
      { now },
    )
    expect(r.totals.terminals).toBe(2)
  })

  it('sorts perAgent by total events desc', () => {
    const r = analyzeEfficiency(
      [
        mk({ agentType: 'claude', ts: now - 10 }),
        mk({ agentType: 'codex', ts: now - 10 }),
        mk({ agentType: 'codex', ts: now - 10 }),
        mk({ agentType: 'codex', ts: now - 10 }),
      ],
      { now, minEventsForLeader: 1 },
    )
    expect(r.perAgent[0].agentType).toBe('codex')
    expect(r.perAgent[1].agentType).toBe('claude')
  })

  it('selects leaders with tie-breaking on first seen', () => {
    const events = [
      mk({ agentType: 'claude', kind: 'tool_result', payload: {} }),
      mk({ agentType: 'claude', kind: 'tool_result', payload: {} }),
      mk({ agentType: 'claude', kind: 'tool_result', payload: {} }),
      mk({ agentType: 'codex', kind: 'tool_result', payload: { isError: true } }),
      mk({ agentType: 'codex', kind: 'tool_result', payload: {} }),
      mk({ agentType: 'codex', kind: 'tool_result', payload: {} }),
    ]
    const r = analyzeEfficiency(events, { now, minEventsForLeader: 1 })
    expect(r.leaders.lowestErrorRate).toBe('claude')
  })

  it('counts errors from error-kind events too', () => {
    const r = analyzeEfficiency(
      [
        mk({ agentType: 'claude', kind: 'tool_result' }),
        mk({ agentType: 'claude', kind: 'error' }),
      ],
      { now, minEventsForLeader: 1 },
    )
    expect(r.perAgent[0].errors).toBe(1)
  })

  it('skips leader computation below minEventsForLeader', () => {
    const r = analyzeEfficiency(
      [mk({ agentType: 'claude', kind: 'message' })],
      { now, minEventsForLeader: 5 },
    )
    expect(r.leaders.lowestErrorRate).toBeNull()
    expect(r.leaders.mostFilesTouched).toBeNull()
  })

  it('handles edit tool with no input object', () => {
    const r = analyzeEfficiency(
      [
        mk({ agentType: 'claude', kind: 'tool_call', payload: { tool: 'Edit' } }),
        mk({ agentType: 'claude', kind: 'tool_call', payload: { tool: 'Edit', input: null } }),
      ],
      { now, minEventsForLeader: 1 },
    )
    expect(r.perAgent[0].uniqueFilesTouched).toBe(0)
  })

  it('handles edit tool with input missing path keys', () => {
    const r = analyzeEfficiency(
      [mk({ agentType: 'claude', kind: 'tool_call', payload: { tool: 'Edit', input: {} } })],
      { now, minEventsForLeader: 1 },
    )
    expect(r.perAgent[0].uniqueFilesTouched).toBe(0)
  })

  it('handles tool_call without a tool name', () => {
    const r = analyzeEfficiency(
      [mk({ agentType: 'claude', kind: 'tool_call', payload: { input: { file_path: '/x' } } })],
      { now, minEventsForLeader: 1 },
    )
    expect(r.perAgent[0].toolCalls).toBe(1)
    expect(r.perAgent[0].uniqueFilesTouched).toBe(0)
    expect(r.perAgent[0].toolMix.unknown).toBe(1)
  })

  it('handles snake_case is_error and camelCase isError', () => {
    const r = analyzeEfficiency(
      [
        mk({ agentType: 'codex', kind: 'tool_result', payload: { is_error: true } }),
        mk({ agentType: 'codex', kind: 'tool_result', payload: { isError: true } }),
      ],
      { now, minEventsForLeader: 1 },
    )
    expect(r.perAgent[0].errors).toBe(2)
  })
})

describe('formatters', () => {
  it('formats error rate', () => {
    expect(formatErrorRate(0)).toBe('0%')
    expect(formatErrorRate(0.123)).toBe('12%')
    expect(formatErrorRate(1)).toBe('100%')
    expect(formatErrorRate(-1)).toBe('0%')
    expect(formatErrorRate(NaN)).toBe('0%')
  })
  it('formats averages', () => {
    expect(formatAvg(0)).toBe('0.0')
    expect(formatAvg(1.234)).toBe('1.2')
    expect(formatAvg(50)).toBe('50')
    expect(formatAvg(Infinity)).toBe('0')
  })
})
