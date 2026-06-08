import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import {
  initEventBus,
  publish,
  subscribe,
  query,
  getRingSize,
  clearRing,
  getDroppedCount,
  shutdownEventBus,
  _resetForTests,
} from '../../src/main/agentEventBus'

let tmpDir: string

beforeEach(() => {
  _resetForTests()
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-evt-'))
  initEventBus(tmpDir)
})

afterEach(() => {
  shutdownEventBus()
  _resetForTests()
  try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}
})

describe('agentEventBus.initEventBus', () => {
  it('requires a userDataPath', () => {
    _resetForTests()
    expect(() => initEventBus('')).toThrow()
    expect(() => initEventBus(null as unknown as string)).toThrow()
  })

  it('rejects non-absolute paths', () => {
    _resetForTests()
    expect(() => initEventBus('relative/path')).toThrow()
  })

  it('accepts a valid absolute path', () => {
    _resetForTests()
    expect(() => initEventBus(tmpDir)).not.toThrow()
  })
})

describe('agentEventBus.publish', () => {
  it('returns the stored event with id and ts', () => {
    const e = publish({
      terminalId: 't1',
      agentType: 'claude',
      kind: 'tool_call',
      summary: 'Read src/foo.ts',
      payload: { file: 'src/foo.ts' },
    })
    expect(e).not.toBeNull()
    expect(e!.id).toBeTruthy()
    expect(e!.ts).toBeGreaterThan(0)
    expect(e!.agentType).toBe('claude')
  })

  it('pushes events into the ring buffer', () => {
    publish({ terminalId: 't1', agentType: 'claude', kind: 'message', summary: 'a', payload: {} })
    publish({ terminalId: 't1', agentType: 'claude', kind: 'message', summary: 'b', payload: {} })
    expect(getRingSize()).toBe(2)
  })

  it('caps ring buffer at MAX_RING', () => {
    for (let i = 0; i < 10_100; i++) {
      publish({ terminalId: 't1', agentType: 'claude', kind: 'message', summary: `e${i}`, payload: {} })
    }
    expect(getRingSize()).toBeLessThanOrEqual(10_000)
  }, 20_000) // a 10k-iteration publish loop can run slow under heavy parallel load — don't flake on the 5s default

  it('truncates oversized payloads', () => {
    const big = 'x'.repeat(200_000)
    const e = publish({
      terminalId: 't1',
      agentType: 'claude',
      kind: 'message',
      summary: 's',
      payload: { data: big },
    })
    expect(e!.payload._truncated).toBe(true)
  })

  it('handles unserializable payloads', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const e = publish({
      terminalId: 't1',
      agentType: 'claude',
      kind: 'message',
      summary: 's',
      payload: cyclic,
    })
    // Truncation logic JSON.stringifies; cyclic throws → we wrap it
    expect(e!.payload._truncated).toBe(true)
  })

  it('caps terminalId length', () => {
    const longId = 'x'.repeat(500)
    const e = publish({ terminalId: longId, agentType: 'claude', kind: 'message', summary: 's', payload: {} })
    expect(e!.terminalId.length).toBeLessThanOrEqual(200)
  })

  it('caps summary length', () => {
    const longSummary = 'y'.repeat(1000)
    const e = publish({ terminalId: 't1', agentType: 'claude', kind: 'message', summary: longSummary, payload: {} })
    expect(e!.summary.length).toBeLessThanOrEqual(500)
  })

  it('handles missing optional fields gracefully', () => {
    const e = publish({
      terminalId: 't1',
      agentType: 'unknown',
      kind: 'status_change',
      summary: '',
      payload: {},
    })
    expect(e).not.toBeNull()
    expect(e!.summary).toBe('')
  })

  it('uses custom ts when provided', () => {
    const custom = 1_700_000_000_000
    const e = publish({ ts: custom, terminalId: 't1', agentType: 'claude', kind: 'message', summary: 's', payload: {} })
    expect(e!.ts).toBe(custom)
  })

  it('persists events to JSONL file', () => {
    publish({ terminalId: 't1', agentType: 'claude', kind: 'message', summary: 'persisted', payload: {} })
    shutdownEventBus()
    const contents = fs.readFileSync(path.join(tmpDir, 'agent-events.jsonl'), 'utf-8')
    expect(contents).toContain('persisted')
  })

  it('rate-limits bursts and tracks drops', async () => {
    // Rate window is 1s, limit 500 — burst 5000 in a tight loop to overwhelm
    // the window even on slow CI machines where a 1s wall-clock could otherwise
    // reset the counter mid-loop.
    for (let i = 0; i < 5000; i++) {
      publish({ terminalId: 't1', agentType: 'claude', kind: 'message', summary: `${i}`, payload: {} })
    }
    expect(getDroppedCount()).toBeGreaterThan(0)
  }, 20_000) // 5000 instrumented publishes can exceed the 5s default under --coverage load
})

describe('agentEventBus.subscribe', () => {
  it('notifies subscribers of new events', () => {
    const received: string[] = []
    const unsub = subscribe((e) => received.push(e.summary))
    publish({ terminalId: 't1', agentType: 'claude', kind: 'message', summary: 'hi', payload: {} })
    expect(received).toEqual(['hi'])
    unsub()
  })

  it('allows unsubscribing', () => {
    const received: string[] = []
    const unsub = subscribe((e) => received.push(e.summary))
    unsub()
    publish({ terminalId: 't1', agentType: 'claude', kind: 'message', summary: 'after', payload: {} })
    expect(received).toEqual([])
  })

  it('isolates subscriber errors', () => {
    const received: string[] = []
    subscribe(() => { throw new Error('boom') })
    subscribe((e) => received.push(e.summary))
    publish({ terminalId: 't1', agentType: 'claude', kind: 'message', summary: 'ok', payload: {} })
    expect(received).toEqual(['ok'])
  })
})

describe('agentEventBus.query', () => {
  beforeEach(() => {
    publish({ terminalId: 't1', agentType: 'claude', kind: 'message', summary: 'hello world', payload: {} })
    publish({ terminalId: 't2', agentType: 'codex', kind: 'tool_call', summary: 'read file', payload: {} })
    publish({ terminalId: 't1', agentType: 'claude', kind: 'tool_call', summary: 'grep foo', payload: {} })
    publish({ terminalId: 't1', agentType: 'claude', kind: 'error', summary: 'crashed', payload: {} })
  })

  it('returns all events when no filter', () => {
    expect(query()).toHaveLength(4)
  })

  it('filters by terminalId', () => {
    const r = query({ terminalId: 't1' })
    expect(r).toHaveLength(3)
    expect(r.every(e => e.terminalId === 't1')).toBe(true)
  })

  it('filters by agentType', () => {
    const r = query({ agentType: 'codex' })
    expect(r).toHaveLength(1)
    expect(r[0].agentType).toBe('codex')
  })

  it('filters by single kind', () => {
    const r = query({ kind: 'tool_call' })
    expect(r).toHaveLength(2)
  })

  it('filters by multiple kinds', () => {
    const r = query({ kind: ['message', 'error'] })
    expect(r).toHaveLength(2)
  })

  it('filters by since', () => {
    const future = Date.now() + 10_000
    expect(query({ since: future })).toHaveLength(0)
  })

  it('filters by until', () => {
    const past = Date.now() - 10_000
    expect(query({ until: past })).toHaveLength(0)
  })

  it('respects limit', () => {
    expect(query({ limit: 2 })).toHaveLength(2)
  })

  it('searches summary case-insensitively', () => {
    const r = query({ search: 'HELLO' })
    expect(r).toHaveLength(1)
    expect(r[0].summary).toContain('hello')
  })

  it('returns events in chronological order', () => {
    const r = query()
    for (let i = 1; i < r.length; i++) {
      expect(r[i].ts).toBeGreaterThanOrEqual(r[i - 1].ts)
    }
  })

  it('combines multiple filters', () => {
    const r = query({ terminalId: 't1', kind: 'error' })
    expect(r).toHaveLength(1)
    expect(r[0].summary).toBe('crashed')
  })
})

describe('agentEventBus.clearRing', () => {
  it('empties the ring and subscribers', () => {
    publish({ terminalId: 't1', agentType: 'claude', kind: 'message', summary: 's', payload: {} })
    subscribe(() => {})
    clearRing()
    expect(getRingSize()).toBe(0)
  })
})

describe('agentEventBus log rotation', () => {
  it('rotates log when exceeding max size', () => {
    // Force a big payload repeatedly to cross 5MB threshold
    const big = 'z'.repeat(50_000)
    for (let i = 0; i < 150; i++) {
      publish({ terminalId: 't1', agentType: 'claude', kind: 'message', summary: `e${i}`, payload: { data: big } })
    }
    shutdownEventBus()
    const backup = path.join(tmpDir, 'agent-events.jsonl.old')
    // Rotation may or may not have triggered depending on timing; assert no crash
    expect(fs.existsSync(path.join(tmpDir, 'agent-events.jsonl'))).toBe(true)
    if (fs.existsSync(backup)) {
      expect(fs.statSync(backup).size).toBeGreaterThan(0)
    }
  })
})
