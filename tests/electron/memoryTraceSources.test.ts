// 1.54.5 merge, seam 3: lane C's pass counters and the memory host's mode reach the typing trace that
// diagnostics:collect returns (typing.extra.passes and typing.extra.memoryHost).
//
// The typing block is NUMBERS ONLY by contract (diagnosticsFields.test.ts walks every leaf: null, boolean or a
// finite number; a NAME may only be a key). snapshotPasses() carries each recent pass's kind as a string VALUE and
// the host's mode is a word, so both are reshaped by src/main/memoryTraceSources.ts. These tests feed it the REAL
// recordPass / snapshotPasses and walk the leaves of what diagnostics:collect then returns.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import ts from 'typescript'

vi.mock('electron', () => ({
  app: { getVersion: vi.fn(() => '9.9.9') },
}))

const { collectDiagnostics } = await import('../../src/main/diagnostics')
const { registerTypingTraceSource } = await import('../../src/main/typingTrace')
const { recordPass, resetPasses, snapshotPasses } = await import('../../src/main/passCounters')
const {
  MEMORY_HOST_CODES,
  passesForTrace,
  memoryHostForTrace,
  registerMemoryTraceSources,
} = await import('../../src/main/memoryTraceSources')

/** Every leaf of a JSON value, so a string (or NaN, or undefined) anywhere in it can be found. */
function leaves(v: unknown, out: unknown[] = []): unknown[] {
  if (v !== null && typeof v === 'object') Object.values(v).forEach((x) => leaves(x, out))
  else out.push(v)
  return out
}
const numbersOnly = (v: unknown): boolean =>
  leaves(v).every((x) => x === null || typeof x === 'boolean' || (typeof x === 'number' && Number.isFinite(x)))

beforeEach(() => resetPasses())

describe('passesForTrace: the pass counters as numbers only', () => {
  it('control: the raw snapshot is NOT numbers only (each recent pass names its kind as a value), so the reshape is needed', () => {
    recordPass('ingest', { files: 3, mb: 1.5 })
    // the same walk the diagnostics test makes: the unshaped snapshot fails it, the reshaped one passes
    expect(numbersOnly(snapshotPasses())).toBe(false)
    expect(numbersOnly(passesForTrace())).toBe(true)
  })

  it('an empty ring is a valid, numbers-only record', () => {
    const p = passesForTrace()
    expect(p).toEqual({ v: 1, since: 0, records: 0, dropped: 0, kinds: {}, recent: {} })
    expect(numbersOnly(p)).toBe(true)
  })

  it('keeps the per-kind totals exactly as the counters report them', () => {
    recordPass('ingest', { files: 3, written: 10 })
    recordPass('ingest', { files: 5, written: 0 })
    recordPass('reflect', { callers: 2, ms: 40 })
    const p = passesForTrace() as { records: number; kinds: Record<string, { n: number; last: number; sum: Record<string, number>; max: Record<string, number> }> }
    expect(p.records).toBe(3)
    expect(Object.keys(p.kinds).sort()).toEqual(['ingest', 'reflect'])
    expect(p.kinds.ingest.n).toBe(2)
    expect(p.kinds.ingest.sum).toEqual({ files: 8, written: 10 })
    expect(p.kinds.ingest.max).toEqual({ files: 5, written: 10 })
    expect(p.kinds.reflect.sum).toEqual({ callers: 2, ms: 40 })
  })

  it('groups the recent passes under their kind: the kind becomes a key, oldest first, nothing else changes', () => {
    recordPass('ingest', { files: 1 })
    recordPass('reflect', { callers: 1 })
    recordPass('ingest', { files: 2 })
    const p = passesForTrace() as { recent: Record<string, Array<{ at: number; f: Record<string, number> }>> }
    expect(Object.keys(p.recent).sort()).toEqual(['ingest', 'reflect'])
    expect(p.recent.ingest.map((r) => r.f.files)).toEqual([1, 2])
    expect(p.recent.reflect.map((r) => r.f.callers)).toEqual([1])
    for (const list of Object.values(p.recent)) for (const r of list) expect(Number.isFinite(r.at)).toBe(true)
  })

  it('a kind named like an object built-in is an ordinary key, not a prototype write', () => {
    recordPass('__proto__', { n: 1 })
    recordPass('constructor', { n: 2 })
    const p = passesForTrace() as { recent: Record<string, unknown[]> }
    expect(Object.keys(p.recent).sort()).toEqual(['__proto__', 'constructor'])
    expect(Object.getPrototypeOf(p.recent)).toBe(Object.prototype)
    expect(JSON.parse(JSON.stringify(p)).recent['constructor']).toHaveLength(1)
  })

  it('a full ring stays numbers only and inside the ring caps', () => {
    for (let i = 0; i < 300; i++) recordPass(i % 2 ? 'ingest' : 'reflect', { files: i, mb: i / 3 })
    const p = passesForTrace()
    expect(numbersOnly(p)).toBe(true)
    expect(JSON.stringify(p).length).toBeLessThan(40 * 1024)
  })
})

describe('memoryHostForTrace: the host mode as numbers', () => {
  it('gives every mode memoryClient can be in its own code, and the codes are fixed (a graph of them must not change meaning)', () => {
    expect(MEMORY_HOST_CODES).toEqual({ host: 0, inproc: 1, unavailable: 2, starting: 3, unstarted: 4 })
    expect(new Set(Object.values(MEMORY_HOST_CODES)).size).toBe(5)
  })

  it('the brain in its own process: hosted, not on the main thread, nothing to retry', () => {
    const h = memoryHostForTrace('host', {})
    expect(h).toEqual({ mode: 0, hosted: true, onMain: false, unavailable: false, attempt: 0, retrying: false, retryInMs: null, storeMB: null, limitMB: null })
  })

  it('the in-process fallback (the slow one) is the only mode that says onMain', () => {
    expect(memoryHostForTrace('inproc', {}).onMain).toBe(true)
    for (const m of ['host', 'unavailable', 'starting', 'unstarted']) expect(memoryHostForTrace(m, {}).onMain, m).toBe(false)
  })

  it('unavailable carries the retry numbers and NOT the reason sentence (text, and it can name a path)', () => {
    const h = memoryHostForTrace('unavailable', { attempt: 3, retrying: false, retryInMs: 40_000, storeMB: 475, limitMB: 256, reason: 'C:\\Users\\someone\\AppData\\memory.log is too big' })
    expect(h).toEqual({ mode: 2, hosted: false, onMain: false, unavailable: true, attempt: 3, retrying: false, retryInMs: 40_000, storeMB: 475, limitMB: 256 })
    expect(JSON.stringify(h)).not.toContain('Users')
    expect(numbersOnly(h)).toBe(true)
  })

  it('a mode this build does not know is -1, never a string or a throw', () => {
    const h = memoryHostForTrace('from-the-future', {})
    expect(h.mode).toBe(-1)
    expect(numbersOnly(h)).toBe(true)
  })

  it('a field of the unavailable record that is not a finite number is dropped to its default, never copied through', () => {
    const h = memoryHostForTrace('unavailable', { attempt: Number.NaN, retryInMs: Number.POSITIVE_INFINITY, storeMB: 'big' as unknown as number, limitMB: undefined })
    expect(h.attempt).toBe(0)
    expect(h.retryInMs).toBeNull()
    expect(h.storeMB).toBeNull()
    expect(h.limitMB).toBeNull()
    expect(numbersOnly(h)).toBe(true)
  })
})

describe('registerMemoryTraceSources: both sources reach diagnostics:collect', () => {
  it('registers exactly passes and memoryHost, with no side effect beyond the registration', () => {
    const register = vi.fn()
    registerMemoryTraceSources(register, { hostMode: () => 'host', unavailable: () => ({}) })
    expect(register.mock.calls.map((c) => c[0])).toEqual(['passes', 'memoryHost'])
    // registering reads nothing: the readers run only when a snapshot is taken
    const hostMode = vi.fn(() => 'host')
    register.mockClear()
    registerMemoryTraceSources(register, { hostMode, unavailable: () => ({}) })
    expect(hostMode).not.toHaveBeenCalled()
  })

  it('the typing block of diagnostics:collect shows both, and every leaf of it is still a number, a boolean or null', () => {
    recordPass('ingest', { files: 4, bytesRead: 123456, written: 9 })
    recordPass('reflect', { callers: 1, opens: 0, ms: 12 })
    let mode = 'host'
    registerMemoryTraceSources(registerTypingTraceSource, { hostMode: () => mode, unavailable: () => ({}) })

    const t = collectDiagnostics().typing!
    const extra = t.extra as { passes: { kinds: Record<string, { n: number }>; recent: Record<string, unknown[]> }; memoryHost: { mode: number; onMain: boolean } }
    expect(extra.passes.kinds.ingest.n).toBe(1)
    expect(extra.passes.kinds.reflect.n).toBe(1)
    expect(extra.passes.recent.ingest).toHaveLength(1)
    expect(extra.memoryHost.mode).toBe(0)
    expect(extra.memoryHost.onMain).toBe(false)
    expect(numbersOnly(t)).toBe(true)
    expect(JSON.parse(JSON.stringify(t))).toEqual(t)

    // the reader is live: the next snapshot sees the host fall back onto the main thread
    mode = 'inproc'
    const again = collectDiagnostics().typing!.extra as { memoryHost: { mode: number; onMain: boolean } }
    expect(again.memoryHost).toMatchObject({ mode: 1, onMain: true })
  })

  it('a reader that throws leaves its source out of the snapshot and nothing else (the trace does that, this pins it for these two)', () => {
    registerMemoryTraceSources(registerTypingTraceSource, { hostMode: () => { throw new Error('boom') }, unavailable: () => ({}) })
    const extra = collectDiagnostics().typing!.extra as Record<string, unknown>
    expect(extra.memoryHost).toBeUndefined()
    expect(extra.passes).toBeDefined()
  })
})

// The footprint in the shared file: one import and one call in src/main/index.ts, made after startTypingTrace().
describe('src/main/index.ts: the wiring', () => {
  const text = readFileSync(join(__dirname, '..', '..', 'src', 'main', 'index.ts'), 'utf8')
  const sf = ts.createSourceFile('index.ts', text, ts.ScriptTarget.Latest, true)

  const calls = (name: string): ts.CallExpression[] => {
    const out: ts.CallExpression[] = []
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name) out.push(n)
      ts.forEachChild(n, visit)
    }
    visit(sf)
    return out
  }

  it('control: the call finder finds the calls that are known to be there', () => {
    expect(calls('startTypingTrace')).toHaveLength(1)
  })

  it('registerMemoryTraceSources is called exactly once, right after startTypingTrace()', () => {
    const reg = calls('registerMemoryTraceSources')
    expect(reg).toHaveLength(1)
    const start = calls('startTypingTrace')[0]
    expect(reg[0].getStart()).toBeGreaterThan(start.getStart())
    // same block, so it runs in the same whenReady turn as the trace it feeds
    expect(reg[0].parent.parent).toBe(start.parent.parent)
    // and it hands the trace's own registerTypingTraceSource, the live host mode and the unavailable record
    expect(reg[0].arguments[0].getText()).toBe('registerTypingTraceSource')
    expect(reg[0].arguments[1].getText()).toContain('memoryHostMode')
    expect(reg[0].arguments[1].getText()).toContain('memoryUnavailableInfo')
  })

  it('imports it from ./memoryTraceSources, once', () => {
    const imports = sf.statements.filter(
      (s): s is ts.ImportDeclaration => ts.isImportDeclaration(s) && (s.moduleSpecifier as ts.StringLiteral).text === './memoryTraceSources',
    )
    expect(imports).toHaveLength(1)
  })
})
