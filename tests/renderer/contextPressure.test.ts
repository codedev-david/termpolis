import { describe, it, expect } from 'vitest'
import {
  resolveWindowSize,
  extractTokensFromEvents,
  heuristicTokensFromEvents,
  computePressure,
  pressureRatio,
  pressureLevel,
  formatPressure,
} from '../../src/renderer/src/lib/contextPressure'
import type { AgentActivityEvent } from '../../src/renderer/src/types'

function mk(over: Partial<AgentActivityEvent>): AgentActivityEvent {
  return {
    id: over.id ?? 'x',
    ts: over.ts ?? 1,
    terminalId: over.terminalId ?? 't1',
    agentType: over.agentType ?? 'claude',
    kind: over.kind ?? 'message',
    summary: over.summary ?? '',
    payload: over.payload ?? {},
  }
}

describe('resolveWindowSize', () => {
  it('recognizes Claude 4 family', () => {
    const w = resolveWindowSize('claude-opus-4-7')
    expect(w.tokens).toBe(200_000)
    expect(w.label).toContain('Claude')
  })

  it('recognizes GPT-4 turbo as 128K', () => {
    expect(resolveWindowSize('gpt-4o').tokens).toBe(128_000)
  })

  it('recognizes GPT-4 base as 8K', () => {
    expect(resolveWindowSize('gpt-4').tokens).toBe(8_192)
  })

  it('recognizes Gemini 1.5', () => {
    expect(resolveWindowSize('gemini-1.5-pro').tokens).toBe(1_000_000)
  })

  it('falls back for unknown', () => {
    const w = resolveWindowSize('madeup-model-9000')
    expect(w.tokens).toBeGreaterThan(0)
  })

  it('handles empty input', () => {
    const w = resolveWindowSize('')
    expect(w.label).toBe('unknown')
  })
})

describe('extractTokensFromEvents', () => {
  it('returns 0 with no events', () => {
    expect(extractTokensFromEvents([])).toBe(0)
  })

  it('sums input + output + cache', () => {
    const e = mk({
      kind: 'token_update',
      payload: { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 200 },
    })
    expect(extractTokensFromEvents([e])).toBe(350)
  })

  it('accepts OpenAI-style fields', () => {
    const e = mk({
      kind: 'token_update',
      payload: { prompt_tokens: 100, completion_tokens: 50 },
    })
    expect(extractTokensFromEvents([e])).toBe(150)
  })

  it('keeps max when totals fluctuate', () => {
    const a = mk({ id: 'a', kind: 'token_update', payload: { inputTokens: 50 } })
    const b = mk({ id: 'b', kind: 'token_update', payload: { inputTokens: 30 } })
    expect(extractTokensFromEvents([a, b])).toBe(50)
  })

  it('ignores non-token events', () => {
    expect(extractTokensFromEvents([mk({ kind: 'message' })])).toBe(0)
  })

  it('tolerates malformed payload', () => {
    const e = mk({ kind: 'token_update', payload: { inputTokens: 'x' as any } })
    expect(extractTokensFromEvents([e])).toBe(0)
  })
})

describe('heuristicTokensFromEvents', () => {
  it('returns 0 without messages', () => {
    expect(heuristicTokensFromEvents([], 250)).toBe(0)
  })

  it('uses message length / 4 when available', () => {
    const e = mk({ kind: 'message', payload: { length: 4000 } })
    expect(heuristicTokensFromEvents([e], 100)).toBe(1000)
  })

  it('falls back to messages * avg when no lengths', () => {
    const e = mk({ kind: 'message', payload: {} })
    expect(heuristicTokensFromEvents([e, { ...e, id: 'b' }], 250)).toBe(500)
  })

  it('counts only message kind', () => {
    const e1 = mk({ kind: 'tool_call' })
    const e2 = mk({ kind: 'message', payload: {} })
    expect(heuristicTokensFromEvents([e1, e2], 250)).toBe(250)
  })
})

describe('computePressure', () => {
  it('prefers transcript over heuristic', () => {
    const events = [
      mk({ kind: 'message', payload: { length: 99999 } }),
      mk({ kind: 'token_update', payload: { inputTokens: 500 } }),
    ]
    const r = computePressure(events, { model: 'claude-opus-4' })
    expect(r.source).toBe('transcript')
    expect(r.used).toBe(500)
  })

  it('uses heuristic when no token_update', () => {
    const events = [mk({ kind: 'message', payload: { length: 4000 } })]
    const r = computePressure(events, { model: 'gpt-4' })
    expect(r.source).toBe('heuristic')
    expect(r.used).toBe(1000)
  })

  it('respects maxTokens override', () => {
    const events = [mk({ kind: 'token_update', payload: { inputTokens: 50 } })]
    const r = computePressure(events, { maxTokens: 1000 })
    expect(r.total).toBe(1000)
  })

  it('caps used at total', () => {
    const events = [mk({ kind: 'token_update', payload: { inputTokens: 9_999_999 } })]
    const r = computePressure(events, { model: 'gpt-4' })
    expect(r.used).toBe(r.total)
  })

  it('handles empty events', () => {
    const r = computePressure([])
    expect(r.used).toBe(0)
  })

  it('ignores zero or negative maxTokens', () => {
    const r = computePressure(
      [mk({ kind: 'token_update', payload: { inputTokens: 100 } })],
      { maxTokens: 0, model: 'gpt-4' },
    )
    expect(r.total).toBe(8192)
  })
})

describe('pressureRatio', () => {
  it('returns 0.5 for half full', () => {
    expect(pressureRatio({ total: 1000, used: 500, source: 'transcript', model: '' })).toBe(0.5)
  })

  it('returns 0 for zero total', () => {
    expect(pressureRatio({ total: 0, used: 5, source: 'heuristic', model: '' })).toBe(0)
  })

  it('caps at 1', () => {
    expect(pressureRatio({ total: 100, used: 9000, source: 'transcript', model: '' })).toBe(1)
  })

  it('floors at 0', () => {
    expect(pressureRatio({ total: 100, used: -1, source: 'transcript', model: '' })).toBe(0)
  })
})

describe('pressureLevel', () => {
  const w = (used: number) => ({ total: 100, used, source: 'transcript' as const, model: '' })
  it('ok under 60%', () => {
    expect(pressureLevel(w(40))).toBe('ok')
  })
  it('warn at 60-79%', () => {
    expect(pressureLevel(w(70))).toBe('warn')
  })
  it('danger at 80-94%', () => {
    expect(pressureLevel(w(85))).toBe('danger')
  })
  it('critical at 95%+', () => {
    expect(pressureLevel(w(99))).toBe('critical')
  })
})

describe('formatPressure', () => {
  it('formats percent + counts', () => {
    const s = formatPressure({ total: 1000, used: 250, source: 'transcript', model: '' })
    expect(s).toContain('25%')
  })
  it('shortens K', () => {
    const s = formatPressure({ total: 10_000, used: 2_000, source: 'transcript', model: '' })
    expect(s).toMatch(/K/)
  })
  it('shortens M', () => {
    const s = formatPressure({ total: 2_000_000, used: 500_000, source: 'transcript', model: '' })
    expect(s).toMatch(/M/)
  })
  it('handles zero', () => {
    expect(formatPressure({ total: 1000, used: 0, source: 'heuristic', model: '' })).toContain('0%')
  })
})
