import { describe, it, expect } from 'vitest'
import {
  parseEventToTrace,
  parseEventsToTrace,
  detectHandoff,
} from '../../src/renderer/src/lib/conductorTraceParser'
import type { AgentActivityEvent } from '../../src/renderer/src/types'

function mk(over: Partial<AgentActivityEvent>): AgentActivityEvent {
  return {
    id: over.id ?? 'x',
    ts: over.ts ?? 1,
    terminalId: over.terminalId ?? 'c1',
    agentType: over.agentType ?? 'claude',
    kind: over.kind ?? 'message',
    summary: over.summary ?? '',
    payload: over.payload ?? {},
  }
}

describe('parseEventToTrace', () => {
  it('returns null for blank message', () => {
    expect(parseEventToTrace(mk({ kind: 'message', payload: { text: '' } }))).toBeNull()
    expect(parseEventToTrace(mk({ kind: 'message', payload: { text: '  ' } }))).toBeNull()
  })

  it('parses generic message', () => {
    const t = parseEventToTrace(mk({ kind: 'message', payload: { text: 'hello world' } }))
    expect(t?.kind).toBe('message')
    expect(t?.title).toBe('hello world')
  })

  it('detects task assignment with target', () => {
    const t = parseEventToTrace(
      mk({ kind: 'message', payload: { text: 'Assigning task to codex-reviewer' } }),
    )
    expect(t?.kind).toBe('task_assigned')
    expect(t?.target).toBe('codex-reviewer')
  })

  it('detects handoff phrasing', () => {
    const t = parseEventToTrace(
      mk({ kind: 'message', payload: { text: 'handing off to gemini-worker' } }),
    )
    expect(t?.kind).toBe('task_assigned')
    expect(t?.target).toBe('gemini-worker')
  })

  it('detects task completion', () => {
    const t = parseEventToTrace(
      mk({ kind: 'message', payload: { text: 'Task complete — moving on' } }),
    )
    expect(t?.kind).toBe('task_completed')
  })

  it('detects error in message', () => {
    const t = parseEventToTrace(mk({ kind: 'message', payload: { text: 'Error: boom' } }))
    expect(t?.kind).toBe('error')
  })

  it('parses tool_call with file path', () => {
    const t = parseEventToTrace(
      mk({
        kind: 'tool_call',
        payload: { tool: 'Edit', input: { file_path: '/a/b.ts' } },
      }),
    )
    expect(t?.kind).toBe('tool_call')
    expect(t?.title).toContain('Edit')
    expect(t?.title).toContain('/a/b.ts')
    expect(t?.tool).toBe('Edit')
  })

  it('parses tool_call with command', () => {
    const t = parseEventToTrace(
      mk({
        kind: 'tool_call',
        payload: { tool: 'Bash', input: { command: 'npm test' } },
      }),
    )
    expect(t?.title).toBe('Bash: npm test')
  })

  it('parses tool_call without known input key', () => {
    const t = parseEventToTrace(
      mk({
        kind: 'tool_call',
        payload: { tool: 'Magic', input: { weird: true } },
      }),
    )
    expect(t?.title).toBe('Magic')
  })

  it('parses error event', () => {
    const t = parseEventToTrace(
      mk({ kind: 'error', summary: 'kaboom', payload: { message: 'details' } }),
    )
    expect(t?.kind).toBe('error')
    expect(t?.detail).toBe('details')
  })

  it('returns null for unsupported kinds', () => {
    expect(parseEventToTrace(mk({ kind: 'token_update' }))).toBeNull()
    expect(parseEventToTrace(mk({ kind: 'status_change' }))).toBeNull()
  })

  it('clips very long titles', () => {
    const long = 'x'.repeat(500)
    const t = parseEventToTrace(mk({ kind: 'message', payload: { text: long } }))
    expect(t?.title.length).toBeLessThanOrEqual(200)
  })

  it('returns null for null event', () => {
    expect(parseEventToTrace(null as any)).toBeNull()
  })

  it('defaults tool_call tool to "tool" when missing', () => {
    const t = parseEventToTrace(mk({ kind: 'tool_call', payload: {} }))
    expect(t?.tool).toBe('tool')
    expect(t?.title).toBe('tool')
  })

  it('falls back to "error" title and empty detail on empty error payload', () => {
    const t = parseEventToTrace(mk({ kind: 'error', summary: '', payload: {} }))
    expect(t?.kind).toBe('error')
    expect(t?.title).toBe('error')
    expect(t?.detail).toBe('')
  })

  it('uses summary as fallback for message text', () => {
    const t = parseEventToTrace(mk({ kind: 'message', summary: 'from summary', payload: {} }))
    expect(t?.kind).toBe('message')
    expect(t?.title).toBe('from summary')
  })

  it('treats non-string message text as blank', () => {
    const t = parseEventToTrace(mk({ kind: 'message', payload: { text: 42 } }))
    expect(t).toBeNull()
  })
})

describe('parseEventsToTrace', () => {
  it('sorts by ts ascending and skips unsupported', () => {
    const trace = parseEventsToTrace([
      mk({ id: 'b', ts: 2, kind: 'message', payload: { text: 'second' } }),
      mk({ id: 'a', ts: 1, kind: 'message', payload: { text: 'first' } }),
      mk({ id: 'c', ts: 3, kind: 'token_update' }),
    ])
    expect(trace.map((t) => t.id)).toEqual(['a', 'b'])
  })
})

describe('detectHandoff', () => {
  it('returns latest task_assigned', () => {
    const entries = parseEventsToTrace([
      mk({ id: '1', ts: 1, kind: 'message', payload: { text: 'Assigning task to foo' } }),
      mk({ id: '2', ts: 2, kind: 'message', payload: { text: 'Assigning task to bar' } }),
      mk({ id: '3', ts: 3, kind: 'message', payload: { text: 'random' } }),
    ])
    const h = detectHandoff(entries)
    expect(h?.target).toBe('bar')
  })
  it('returns null when no handoff', () => {
    const entries = parseEventsToTrace([
      mk({ id: '1', ts: 1, kind: 'message', payload: { text: 'random talk' } }),
    ])
    expect(detectHandoff(entries)).toBeNull()
  })
})
