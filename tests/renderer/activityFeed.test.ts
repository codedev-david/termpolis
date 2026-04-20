import { describe, it, expect } from 'vitest'
import {
  applyFilters,
  mergeEvents,
  formatEventTime,
  kindColor,
  shortLabel,
  MAX_FEED_EVENTS,
} from '../../src/renderer/src/lib/activityFeed'
import type { AgentActivityEvent } from '../../src/renderer/src/types'

function mk(overrides: Partial<AgentActivityEvent>): AgentActivityEvent {
  return {
    id: overrides.id ?? '1',
    ts: overrides.ts ?? 1_000_000,
    terminalId: overrides.terminalId ?? 't1',
    agentType: overrides.agentType ?? 'claude',
    kind: overrides.kind ?? 'message',
    summary: overrides.summary ?? 'hello',
    payload: overrides.payload ?? {},
    taskId: overrides.taskId,
  }
}

describe('applyFilters', () => {
  const events = [
    mk({ id: '1', terminalId: 't1', agentType: 'claude', kind: 'message', summary: 'hello world' }),
    mk({ id: '2', terminalId: 't2', agentType: 'codex', kind: 'tool_call', summary: 'read_file' }),
    mk({ id: '3', terminalId: 't1', agentType: 'claude', kind: 'token_update', summary: 'in:100 out:50' }),
    mk({ id: '4', terminalId: 't3', agentType: 'gemini', kind: 'error', summary: 'bad thing happened' }),
  ]

  it('returns all when no filters', () => {
    expect(applyFilters(events, {})).toHaveLength(4)
  })

  it('returns [] for empty events', () => {
    expect(applyFilters([], { search: 'x' })).toEqual([])
  })

  it('filters by terminalId', () => {
    const r = applyFilters(events, { terminalId: 't1' })
    expect(r.every((e) => e.terminalId === 't1')).toBe(true)
    expect(r).toHaveLength(2)
  })

  it('filters by agentType', () => {
    expect(applyFilters(events, { agentType: 'codex' })).toHaveLength(1)
  })

  it('filters by single kind', () => {
    expect(applyFilters(events, { kinds: ['error'] })).toHaveLength(1)
  })

  it('filters by multiple kinds', () => {
    expect(applyFilters(events, { kinds: ['message', 'error'] })).toHaveLength(2)
  })

  it('ignores empty kinds array', () => {
    expect(applyFilters(events, { kinds: [] })).toHaveLength(4)
  })

  it('search matches summary', () => {
    expect(applyFilters(events, { search: 'hello' })).toHaveLength(1)
  })

  it('search is case-insensitive', () => {
    expect(applyFilters(events, { search: 'READ_FILE' })).toHaveLength(1)
  })

  it('search matches agent and kind', () => {
    expect(applyFilters(events, { search: 'gemini' })).toHaveLength(1)
    expect(applyFilters(events, { search: 'token_update' })).toHaveLength(1)
  })

  it('empty search treated as no filter', () => {
    expect(applyFilters(events, { search: '   ' })).toHaveLength(4)
  })

  it('combines filters (AND)', () => {
    expect(applyFilters(events, { terminalId: 't1', kinds: ['message'] })).toHaveLength(1)
  })

  it('tolerates null input', () => {
    // @ts-expect-error — runtime tolerance
    expect(applyFilters(null, {})).toEqual([])
  })
})

describe('mergeEvents', () => {
  it('preserves existing when no incoming', () => {
    const a = [mk({ id: '1' })]
    expect(mergeEvents(a, [])).toBe(a)
  })

  it('adds new events at end (sorted by ts)', () => {
    const a = [mk({ id: '1', ts: 1000 })]
    const b = [mk({ id: '2', ts: 2000 })]
    const r = mergeEvents(a, b)
    expect(r.map((e) => e.id)).toEqual(['1', '2'])
  })

  it('dedupes by id', () => {
    const a = [mk({ id: '1' })]
    const b = [mk({ id: '1' }), mk({ id: '2' })]
    const r = mergeEvents(a, b)
    expect(r).toHaveLength(2)
  })

  it('sorts by timestamp on out-of-order arrival', () => {
    const a = [mk({ id: '2', ts: 2000 })]
    const b = [mk({ id: '1', ts: 1000 })]
    const r = mergeEvents(a, b)
    expect(r.map((e) => e.id)).toEqual(['1', '2'])
  })

  it('caps at MAX_FEED_EVENTS', () => {
    const existing = Array.from({ length: MAX_FEED_EVENTS }, (_, i) =>
      mk({ id: `old${i}`, ts: i }),
    )
    const incoming = [mk({ id: 'new', ts: MAX_FEED_EVENTS + 1 })]
    const r = mergeEvents(existing, incoming)
    expect(r).toHaveLength(MAX_FEED_EVENTS)
    expect(r[r.length - 1].id).toBe('new')
  })

  it('skips entries without id', () => {
    // @ts-expect-error — runtime defensive
    const r = mergeEvents([mk({ id: '1' })], [{ ts: 5 }])
    expect(r).toHaveLength(1)
  })

  it('handles null incoming', () => {
    const a = [mk({ id: '1' })]
    // @ts-expect-error — runtime tolerance
    expect(mergeEvents(a, null)).toBe(a)
  })
})

describe('formatEventTime', () => {
  const now = 10_000_000_000

  it('"just now" for < 1s', () => {
    expect(formatEventTime(now - 100, now)).toBe('just now')
  })

  it('seconds', () => {
    expect(formatEventTime(now - 45_000, now)).toBe('45s ago')
  })

  it('minutes', () => {
    expect(formatEventTime(now - 3 * 60_000, now)).toBe('3m ago')
  })

  it('hours', () => {
    expect(formatEventTime(now - 5 * 60 * 60_000, now)).toBe('5h ago')
  })

  it('days', () => {
    expect(formatEventTime(now - 3 * 24 * 60 * 60_000, now)).toBe('3d ago')
  })

  it('returns "" for bad timestamps', () => {
    expect(formatEventTime(0, now)).toBe('')
    expect(formatEventTime(NaN, now)).toBe('')
    expect(formatEventTime(-1, now)).toBe('')
  })

  it('clamps future timestamps to "just now"', () => {
    expect(formatEventTime(now + 5000, now)).toBe('just now')
  })
})

describe('kindColor', () => {
  it('returns a known color per kind', () => {
    expect(kindColor('message')).toMatch(/^#/)
    expect(kindColor('error')).toMatch(/^#/)
    expect(kindColor('mcp_audit')).toMatch(/^#/)
  })

  it('falls back for unknown kind', () => {
    // @ts-expect-error — runtime tolerance
    expect(kindColor('nonsense')).toMatch(/^#/)
  })
})

describe('shortLabel', () => {
  it('returns summary when short enough', () => {
    expect(shortLabel(mk({ summary: 'hi' }))).toBe('hi')
  })

  it('truncates with ellipsis', () => {
    const long = 'x'.repeat(200)
    const r = shortLabel(mk({ summary: long }), 80)
    expect(r.length).toBe(80)
    expect(r.endsWith('…')).toBe(true)
  })

  it('falls back to kind when summary empty', () => {
    expect(shortLabel(mk({ summary: '', kind: 'tool_call' }))).toBe('tool_call')
  })

  it('uses "tool result" fallback for empty summary + tool_result', () => {
    expect(shortLabel(mk({ summary: '', kind: 'tool_result' }))).toBe('tool result')
  })

  it('handles non-string summary safely', () => {
    const base = mk({ kind: 'message' })
    // @ts-expect-error — runtime tolerance
    base.summary = null
    expect(shortLabel(base)).toBe('message')
  })
})
