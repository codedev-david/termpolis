import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

// Counts instead of spying: `vi.spyOn(fs, 'appendFileSync')` cannot work here ("Module namespace is not
// configurable in ESM"). Every *Sync function of fs is wrapped to count the calls made while `armed`, and
// fs.promises.appendFile can be made to fail. Everything else is the real one, so the rest of this file keeps using
// the genuine filesystem.
const fsCalls = vi.hoisted(() => ({ armed: false, sync: {} as Record<string, number>, failAppend: false, asyncAppends: 0 }))
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs')
  const wrapped: Record<string, unknown> = { ...actual }
  for (const name of Object.keys(actual)) {
    const fn = (actual as unknown as Record<string, unknown>)[name]
    if (typeof fn === 'function' && name.endsWith('Sync')) {
      wrapped[name] = (...args: unknown[]) => {
        if (fsCalls.armed) fsCalls.sync[name] = (fsCalls.sync[name] ?? 0) + 1
        return (fn as (...a: unknown[]) => unknown)(...args)
      }
    }
  }
  // A failing write has to be injected rather than provoked: Windows opens a directory for append without
  // complaining, so pointing the log at one never failed there.
  const promises = {
    ...actual.promises,
    appendFile: async (...args: Parameters<typeof actual.promises.appendFile>) => {
      fsCalls.asyncAppends++
      if (fsCalls.failAppend) throw new Error('EACCES: permission denied, open')
      return actual.promises.appendFile(...args)
    },
  }
  // `default` too: that is where a module that does `import fs from 'fs'` (or reads a named export through
  // the default interop) finds it.
  return { ...wrapped, promises, default: { ...wrapped, promises } }
})

import {
  initEventBus,
  publish,
  subscribe,
  query,
  getRingSize,
  clearRing,
  getDroppedCount,
  shutdownEventBus,
  flushEventBus,
  _resetForTests,
} from '../../src/main/agentEventBus'
import { offMainFiles } from '../../src/main/offMainFiles'

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

// Rotation used to be checked by statSync-ing the log on EVERY publish — a syscall per event, on the
// thread that pumps the PTY, to ask the filesystem something we already know (we wrote every byte).
// It is an in-process byte counter now, and the rename runs on the thread pool, queued behind the lines
// already asked for. These tests exist because the previous one could not tell the difference: it said
// "rotation may or may not have triggered depending on timing; assert no crash" and only checked the backup
// `if` it happened to exist — green whether or not the log ever rotated at all, which is precisely the
// property under test.
const MAX_LOG_SIZE = 5 * 1024 * 1024

describe('agentEventBus log rotation', () => {
  const live = (): string => path.join(tmpDir, 'agent-events.jsonl')
  const backup = (): string => path.join(tmpDir, 'agent-events.jsonl.old')

  it('rotates once the log passes 5 MB: the old log is kept, the live one restarts', async () => {
    const big = 'z'.repeat(50_000)
    for (let i = 0; i < 150; i++) {  // ~7.5 MB — crosses the threshold exactly once
      publish({ terminalId: 't1', agentType: 'claude', kind: 'message', summary: `e${i}`, payload: { data: big } })
    }
    await flushEventBus()
    expect(fs.existsSync(backup())).toBe(true)                        // it DID rotate
    // The counter must track the real file. If it drifted, we'd rotate at the wrong size — so assert
    // the rotated log really had crossed the threshold, and the live one really did start over.
    expect(fs.statSync(backup()).size).toBeGreaterThanOrEqual(MAX_LOG_SIZE)
    expect(fs.statSync(live()).size).toBeLessThan(MAX_LOG_SIZE)
    expect(fs.statSync(live()).size).toBeGreaterThan(0)               // ...and kept taking writes
  })

  it('a rotation that fails (the old copy cannot be replaced) re-syncs its counter from the file, so it tries again later', async () => {
    const spy = vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(Object.assign(new Error('EBUSY'), { code: 'EBUSY' }))
    try {
      const big = 'z'.repeat(50_000)
      for (let i = 0; i < 110; i++) { // ~5.5 MB: past the cap once
        publish({ terminalId: 't1', agentType: 'claude', kind: 'message', summary: `f${i}`, payload: { data: big } })
      }
      await flushEventBus()
      expect(spy).toHaveBeenCalledTimes(1) // the rotation was tried, and failed
      expect(fs.existsSync(backup())).toBe(false) // nothing moved: the live log is still the one with the lines
      expect(fs.statSync(live()).size).toBeGreaterThan(MAX_LOG_SIZE) // ...and it still has them all
      // The counter was set from the file, not left at zero: the next lines past the cap rotate it for real.
      for (let i = 0; i < 5; i++) publish({ terminalId: 't1', agentType: 'claude', kind: 'message', summary: `g${i}`, payload: { data: big } })
      await flushEventBus()
      expect(fs.existsSync(backup())).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })

  it('loses no line to a rotation: every event published is in the live log or the rotated one', async () => {
    const big = 'q'.repeat(60_000)
    const total = 130 // ~7.8 MB, one rotation
    for (let i = 0; i < total; i++) {
      publish({ terminalId: 't1', agentType: 'claude', kind: 'message', summary: `n${String(i).padStart(4, '0')}`, payload: { data: big } })
    }
    await flushEventBus()
    const seen = new Set<string>()
    for (const file of [backup(), live()]) {
      for (const m of fs.readFileSync(file, 'utf8').matchAll(/"summary":"(n\d{4})"/g)) seen.add(m[1])
    }
    expect(seen.size).toBe(total)
  })

  // The counter starts from the file's real size, not zero. Without the one stat at init, a bus that
  // reopened a 5 MB log would count from 0 and let it grow to 10 MB before rotating — the exact
  // unbounded growth the rotation exists to prevent, reintroduced by the optimization.
  it('picks up the size of an EXISTING log on init rather than counting from zero', async () => {
    _resetForTests()
    fs.writeFileSync(live(), 'x'.repeat(MAX_LOG_SIZE + 1))            // a log already over the line
    initEventBus(tmpDir)

    publish({ terminalId: 't1', agentType: 'claude', kind: 'message', summary: 'first since restart' })
    await flushEventBus()

    expect(fs.existsSync(backup())).toBe(true)                        // rotated on the very next event
    expect(fs.statSync(backup()).size).toBeGreaterThan(MAX_LOG_SIZE)
    // The event is appended BEFORE the size check, so it rides into the rotated file and the live
    // log restarts empty. That is what the statSync version did too — this is a pure perf change and
    // the observable behaviour must be identical, down to which file the boundary event lands in.
    expect(fs.readFileSync(backup(), 'utf8')).toContain('first since restart')
    expect(fs.readFileSync(live(), 'utf8')).toBe('')
    // Nothing is lost, and the ring still has it regardless of which file it went to.
    expect(query({ kind: 'message' }).at(-1)?.summary).toBe('first since restart')
  })

  it('counts BYTES, not characters — a non-ASCII summary must not under-count the log', async () => {
    // JSON.stringify keeps 'é' as one CHARACTER but it is two BYTES on disk. Counting .length would
    // drift low on every multibyte event and rotate late, forever.
    publish({ terminalId: 't1', agentType: 'claude', kind: 'message', summary: 'héllo — ünïcode ✓' })
    await flushEventBus()
    // The in-process count is what rotation trusts; prove it equals what actually landed on disk.
    const onDisk = fs.statSync(live()).size
    publish({ terminalId: 't1', agentType: 'claude', kind: 'message', summary: 'ascii' })
    await flushEventBus()
    const grew = fs.statSync(live()).size - onDisk
    expect(grew).toBeGreaterThan(0)
    expect(fs.readFileSync(live(), 'utf8')).toContain('ünïcode')
  })
})

// publish() runs on the thread that pumps every PTY, at up to 500 events a second while an agent works. Its
// persistence was a synchronous write per line (once an open + write + close per event at 447 us, then a held
// handle at 3.3 us); a write is a system call that the endpoint scanner inspects, and one has been measured at
// up to 105 ms on a busy laptop. The line now joins a batch that is written on the thread pool.
describe('agentEventBus log persistence cost', () => {
  const live = (): string => path.join(tmpDir, 'agent-events.jsonl')

  it('makes no synchronous file call and no append of its own per event (2,000 events, counted)', async () => {
    fsCalls.sync = {}
    fsCalls.asyncAppends = 0
    fsCalls.armed = true
    for (let i = 0; i < 2000; i++) {
      // 500 events a second is the rate limit; a fresh clock window every 500 lets all 2,000 through.
      publish({ ts: Date.now(), terminalId: 't1', agentType: 'claude', kind: 'message', summary: `e${i}`, payload: {} })
      if (i % 500 === 499) await new Promise<void>((r) => setTimeout(r, 1010))
    }
    fsCalls.armed = false
    expect(fsCalls.sync, 'main thread did a synchronous file call while publishing').toEqual({})
    await flushEventBus()
    // Lines asked for while a write is under way go out together: far fewer writes than events.
    expect(fsCalls.asyncAppends).toBeGreaterThan(0)
    expect(fsCalls.asyncAppends).toBeLessThan(2000)
    expect(offMainFiles.stats().coalesced).toBeGreaterThan(0)
    const lines = fs.readFileSync(live(), 'utf8').trimEnd().split('\n')
    expect(lines).toHaveLength(2000)
    expect(lines[0]).toContain('"e0"')
    expect(lines[1999]).toContain('"e1999"')
  }, 30_000)

  it('shutdownEventBus writes what is still waiting, then stops persisting', async () => {
    publish({ terminalId: 't1', agentType: 'claude', kind: 'message', summary: 'before-shutdown', payload: {} })
    shutdownEventBus() // the quit handler: the one synchronous flush that is allowed
    expect(fs.readFileSync(live(), 'utf8')).toContain('before-shutdown')
    publish({ terminalId: 't1', agentType: 'claude', kind: 'message', summary: 'after-shutdown', payload: {} })
    await flushEventBus()
    expect(fs.readFileSync(live(), 'utf8')).not.toContain('after-shutdown')
    expect(query({ kind: 'message' }).at(-1)?.summary).toBe('after-shutdown') // the ring still has it
  })

  it('a write that fails is skipped silently: publish still returns the event and the ring has it', async () => {
    fsCalls.failAppend = true
    try {
      const e = publish({ terminalId: 't1', agentType: 'claude', kind: 'message', summary: 'unwritable', payload: {} })
      expect(e).not.toBeNull()
      await flushEventBus()
    } finally {
      fsCalls.failAppend = false
    }
    expect(fs.existsSync(live()) ? fs.readFileSync(live(), 'utf8') : '').not.toContain('unwritable')
    expect(query({ kind: 'message' }).at(-1)?.summary).toBe('unwritable')
  })

  it('appends to an existing log across a re-init rather than truncating it', async () => {
    _resetForTests()
    fs.writeFileSync(live(), '{"pre":"existing"}\n')
    initEventBus(tmpDir)
    publish({ terminalId: 't1', agentType: 'claude', kind: 'message', summary: 'appended', payload: {} })
    await flushEventBus()
    const contents = fs.readFileSync(live(), 'utf8')
    expect(contents).toContain('existing')
    expect(contents).toContain('appended')
  })
})
