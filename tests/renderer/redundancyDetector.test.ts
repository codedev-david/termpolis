import { describe, it, expect } from 'vitest'
import {
  detectRedundancy,
  normalizeCommand,
  describeFinding,
} from '../../src/renderer/src/lib/redundancyDetector'
import type { AgentActivityEvent, AgentActivityType } from '../../src/renderer/src/types'

let idCounter = 0

function mk(over: Partial<AgentActivityEvent> & { tool?: string; input?: any }): AgentActivityEvent {
  idCounter += 1
  const payload: Record<string, unknown> = { ...(over.payload ?? {}) }
  if (over.tool !== undefined) payload.tool = over.tool
  if (over.input !== undefined) payload.input = over.input
  return {
    id: over.id ?? `e${idCounter}`,
    ts: over.ts ?? 1000,
    terminalId: over.terminalId ?? 't1',
    agentType: (over.agentType ?? 'claude') as AgentActivityType,
    kind: over.kind ?? 'tool_call',
    summary: over.summary ?? '',
    payload,
  }
}

describe('normalizeCommand', () => {
  it('collapses whitespace', () => {
    expect(normalizeCommand('  npm    test   ')).toBe('npm test')
  })
  it('lowercases', () => {
    expect(normalizeCommand('NPM Test')).toBe('npm test')
  })
  it('normalizes operators', () => {
    expect(normalizeCommand('a  &&  b|c || d')).toBe('a && b | c || d')
  })
})

describe('detectRedundancy', () => {
  const now = 2_000_000

  it('returns empty for empty input', () => {
    expect(detectRedundancy([], { now })).toEqual([])
  })

  it('ignores non-tool_call events', () => {
    const events = [
      mk({ kind: 'message', ts: now - 100 }),
      mk({ kind: 'token_update', ts: now - 100, terminalId: 't2' }),
    ]
    expect(detectRedundancy(events, { now })).toEqual([])
  })

  it('flags same file edited by two terminals', () => {
    const events = [
      mk({ ts: now - 100, terminalId: 't1', tool: 'Edit', input: { file_path: '/a/b.ts' } }),
      mk({ ts: now - 50, terminalId: 't2', tool: 'Write', input: { file_path: '/a/b.ts' } }),
    ]
    const findings = detectRedundancy(events, { now })
    expect(findings).toHaveLength(1)
    expect(findings[0].kind).toBe('file_edit')
    expect(findings[0].resource).toBe('/a/b.ts')
    expect(findings[0].uniqueTerminals).toBe(2)
    expect(findings[0].severity).toBe('medium')
  })

  it('upgrades severity to high with 3+ terminals editing', () => {
    const events = [
      mk({ ts: now - 300, terminalId: 't1', tool: 'Edit', input: { file_path: '/x.ts' } }),
      mk({ ts: now - 200, terminalId: 't2', tool: 'Edit', input: { file_path: '/x.ts' } }),
      mk({ ts: now - 100, terminalId: 't3', tool: 'Write', input: { file_path: '/x.ts' } }),
    ]
    const findings = detectRedundancy(events, { now })
    expect(findings[0].severity).toBe('high')
    expect(findings[0].uniqueTerminals).toBe(3)
  })

  it('requires minimum participants', () => {
    const events = [
      mk({ ts: now - 100, terminalId: 't1', tool: 'Edit', input: { file_path: '/solo.ts' } }),
    ]
    expect(detectRedundancy(events, { now })).toEqual([])
  })

  it('same terminal editing same file does not count', () => {
    const events = [
      mk({ ts: now - 300, terminalId: 't1', tool: 'Edit', input: { file_path: '/dup.ts' } }),
      mk({ ts: now - 200, terminalId: 't1', tool: 'Edit', input: { file_path: '/dup.ts' } }),
    ]
    expect(detectRedundancy(events, { now })).toEqual([])
  })

  it('ignores events outside window', () => {
    const events = [
      mk({ ts: now - 10 * 60 * 1000, terminalId: 't1', tool: 'Edit', input: { file_path: '/old.ts' } }),
      mk({ ts: now - 100, terminalId: 't2', tool: 'Edit', input: { file_path: '/old.ts' } }),
    ]
    expect(detectRedundancy(events, { now, windowMs: 5 * 60 * 1000 })).toEqual([])
  })

  it('respects custom window', () => {
    const events = [
      mk({ ts: now - 3_000, terminalId: 't1', tool: 'Edit', input: { file_path: '/foo.ts' } }),
      mk({ ts: now - 1_000, terminalId: 't2', tool: 'Edit', input: { file_path: '/foo.ts' } }),
    ]
    expect(detectRedundancy(events, { now, windowMs: 500 })).toEqual([])
    expect(detectRedundancy(events, { now, windowMs: 5_000 })).toHaveLength(1)
  })

  it('detects duplicate bash commands', () => {
    const events = [
      mk({ ts: now - 200, terminalId: 't1', tool: 'Bash', input: { command: 'npm test' } }),
      mk({ ts: now - 100, terminalId: 't2', tool: 'Bash', input: { command: '  NPM   TEST  ' } }),
    ]
    const findings = detectRedundancy(events, { now })
    expect(findings).toHaveLength(1)
    expect(findings[0].kind).toBe('command')
    expect(findings[0].resource).toBe('npm test')
  })

  it('detects same-file reads as low severity', () => {
    const events = [
      mk({ ts: now - 200, terminalId: 't1', tool: 'Read', input: { file_path: '/r.ts' } }),
      mk({ ts: now - 100, terminalId: 't2', tool: 'Read', input: { file_path: '/r.ts' } }),
    ]
    const findings = detectRedundancy(events, { now })
    expect(findings).toHaveLength(1)
    expect(findings[0].kind).toBe('file_read')
    expect(findings[0].severity).toBe('low')
  })

  it('returns high-severity findings before low-severity', () => {
    const events = [
      mk({ ts: now - 300, terminalId: 't1', tool: 'Read', input: { file_path: '/r.ts' } }),
      mk({ ts: now - 250, terminalId: 't2', tool: 'Read', input: { file_path: '/r.ts' } }),
      mk({ ts: now - 200, terminalId: 't1', tool: 'Edit', input: { file_path: '/e.ts' } }),
      mk({ ts: now - 150, terminalId: 't2', tool: 'Edit', input: { file_path: '/e.ts' } }),
      mk({ ts: now - 100, terminalId: 't3', tool: 'Write', input: { file_path: '/e.ts' } }),
    ]
    const findings = detectRedundancy(events, { now })
    expect(findings[0].kind).toBe('file_edit')
    expect(findings[0].severity).toBe('high')
  })

  it('ignores configured terminals', () => {
    const events = [
      mk({ ts: now - 200, terminalId: 't1', tool: 'Edit', input: { file_path: '/i.ts' } }),
      mk({ ts: now - 100, terminalId: 't2', tool: 'Edit', input: { file_path: '/i.ts' } }),
    ]
    expect(detectRedundancy(events, { now, ignoreTerminalIds: ['t2'] })).toEqual([])
  })

  it('skips tool_call events without recognized tool', () => {
    const events = [
      mk({ ts: now - 100, terminalId: 't1', tool: 'UnknownTool', input: { file_path: '/x' } }),
      mk({ ts: now - 50, terminalId: 't2', tool: 'UnknownTool', input: { file_path: '/x' } }),
    ]
    expect(detectRedundancy(events, { now })).toEqual([])
  })

  it('skips tool_call without required input field', () => {
    const events = [
      mk({ ts: now - 100, terminalId: 't1', tool: 'Edit', input: {} }),
      mk({ ts: now - 50, terminalId: 't2', tool: 'Edit', input: {} }),
    ]
    expect(detectRedundancy(events, { now })).toEqual([])
  })

  it('sorts participants by timestamp', () => {
    const events = [
      mk({ id: 'late', ts: now - 50, terminalId: 't2', tool: 'Edit', input: { file_path: '/s.ts' } }),
      mk({ id: 'early', ts: now - 200, terminalId: 't1', tool: 'Edit', input: { file_path: '/s.ts' } }),
    ]
    const findings = detectRedundancy(events, { now })
    expect(findings[0].participants[0].eventId).toBe('early')
    expect(findings[0].participants[1].eventId).toBe('late')
  })

  it('accepts payload.name alias for tool', () => {
    const events: AgentActivityEvent[] = [
      {
        id: 'a',
        ts: now - 100,
        terminalId: 't1',
        agentType: 'codex',
        kind: 'tool_call',
        summary: '',
        payload: { name: 'Bash', input: { command: 'ls' } },
      },
      {
        id: 'b',
        ts: now - 50,
        terminalId: 't2',
        agentType: 'codex',
        kind: 'tool_call',
        summary: '',
        payload: { name: 'Bash', input: { command: 'ls' } },
      },
    ]
    const findings = detectRedundancy(events, { now })
    expect(findings).toHaveLength(1)
  })
})

describe('sorting + severity edge cases', () => {
  const now = 2_000_000

  it('commands with 3+ terminals become medium severity', () => {
    const events = [
      mk({ ts: now - 300, terminalId: 't1', tool: 'Bash', input: { command: 'test' } }),
      mk({ ts: now - 200, terminalId: 't2', tool: 'Bash', input: { command: 'test' } }),
      mk({ ts: now - 100, terminalId: 't3', tool: 'Bash', input: { command: 'test' } }),
    ]
    const findings = detectRedundancy(events, { now })
    expect(findings[0].severity).toBe('medium')
  })

  it('higher participant count ranks first within same severity', () => {
    const events = [
      mk({ ts: now - 400, terminalId: 't1', tool: 'Read', input: { file_path: '/a' } }),
      mk({ ts: now - 300, terminalId: 't2', tool: 'Read', input: { file_path: '/a' } }),
      mk({ ts: now - 200, terminalId: 't1', tool: 'Read', input: { file_path: '/b' } }),
      mk({ ts: now - 200, terminalId: 't2', tool: 'Read', input: { file_path: '/b' } }),
      mk({ ts: now - 100, terminalId: 't3', tool: 'Read', input: { file_path: '/b' } }),
    ]
    const findings = detectRedundancy(events, { now })
    expect(findings[0].resource).toBe('/b')
    expect(findings[0].uniqueTerminals).toBe(3)
  })

  it('later lastTs ranks first when severity and count tie', () => {
    const events = [
      mk({ ts: now - 400, terminalId: 't1', tool: 'Read', input: { file_path: '/a' } }),
      mk({ ts: now - 390, terminalId: 't2', tool: 'Read', input: { file_path: '/a' } }),
      mk({ ts: now - 200, terminalId: 't1', tool: 'Read', input: { file_path: '/b' } }),
      mk({ ts: now - 100, terminalId: 't2', tool: 'Read', input: { file_path: '/b' } }),
    ]
    const findings = detectRedundancy(events, { now })
    expect(findings[0].resource).toBe('/b')
  })
})

describe('describeFinding', () => {
  const now = 2_000_000
  it('describes edit finding', () => {
    const events = [
      mk({ ts: now - 100, terminalId: 't1', tool: 'Edit', input: { file_path: '/a' } }),
      mk({ ts: now - 50, terminalId: 't2', tool: 'Edit', input: { file_path: '/a' } }),
    ]
    const findings = detectRedundancy(events, { now })
    expect(describeFinding(findings[0])).toMatch(/2 terminals edited \/a/)
  })
  it('describes command finding', () => {
    const events = [
      mk({ ts: now - 100, terminalId: 't1', tool: 'Bash', input: { command: 'ls' } }),
      mk({ ts: now - 50, terminalId: 't2', tool: 'Bash', input: { command: 'ls' } }),
    ]
    const findings = detectRedundancy(events, { now })
    expect(describeFinding(findings[0])).toMatch(/ran/)
  })
  it('describes read finding', () => {
    const events = [
      mk({ ts: now - 100, terminalId: 't1', tool: 'Read', input: { file_path: '/r' } }),
      mk({ ts: now - 50, terminalId: 't2', tool: 'Read', input: { file_path: '/r' } }),
    ]
    const findings = detectRedundancy(events, { now })
    expect(describeFinding(findings[0])).toMatch(/read/)
  })
})
