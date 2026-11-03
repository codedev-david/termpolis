// P0 of the 1.54.5 typing-lag hotfix: `diagnostics:collect` carries the typing trace.
//
// The seven fields it always returned say which build and OS someone runs; none of them say whether
// the app, the agent CLI or the machine is the slow part. The trace (src/main/typingTrace.ts) adds the
// loop delay, echo latency, handler timings and memory numbers under `typing`. These tests pin that the
// block is there with every field, that the seven old fields did not move, that it is numbers only, and
// that none of it leaks into the text a Report-a-Problem issue is built from.

import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getVersion: vi.fn(() => '9.9.9') },
}))

const { collectDiagnostics, formatDiagnosticsMarkdown } = await import('../../src/main/diagnostics')
const { registerTypingTraceSource } = await import('../../src/main/typingTrace')

const LEGACY = ['appVersion', 'platform', 'osRelease', 'arch', 'electronVersion', 'nodeVersion', 'chromeVersion']

describe('collectDiagnostics: the typing block', () => {
  it('is present, with every field the plan names', () => {
    const d = collectDiagnostics()
    expect(d.typing).toBeDefined()
    const t = d.typing!
    expect(Object.keys(t).sort()).toEqual(
      ['elu', 'enabled', 'extra', 'gc', 'ipc', 'loopDelay', 'memory', 'sampler', 't1', 't2', 'started', 'uptimeMs'].sort(),
    )
    expect(Object.keys(t.loopDelay).sort()).toEqual(['idleFloorMs', 'last', 'minute', 'net'])
    expect(Object.keys(t.gc).sort()).toEqual(['incrementalCount', 'incrementalMaxMs', 'majorCount', 'majorMaxMs', 'minorCount'])
    expect(Object.keys(t.sampler).sort()).toEqual(['msMax', 'msSum', 'ticks'])
    expect(Object.keys(t.t1).sort()).toEqual(['avg', 'max', 'n'])
    expect(Object.keys(t.t2).sort()).toEqual(['avg', 'expired', 'max', 'n'])
    expect(typeof t.enabled).toBe('boolean')
    expect(typeof t.started).toBe('boolean')
    expect(typeof t.uptimeMs).toBe('number')
    expect(t.ipc).toEqual(expect.any(Object))
    expect(t.extra).toEqual(expect.any(Object))
  })

  it('NEGATIVE CONTROL: the seven fields that were always there are unchanged', () => {
    const d = collectDiagnostics()
    for (const k of LEGACY) expect(typeof (d as unknown as Record<string, unknown>)[k], k).toBe('string')
    expect(d.appVersion).toBe('9.9.9')
    // Since the 1.54.5 merge lane G's `governor` block sits beside `typing`: the only two additions to the seven.
    expect(Object.keys(d).sort()).toEqual([...LEGACY, 'governor', 'typing'].sort())
  })

  it('is JSON-safe and holds only numbers, booleans and nulls', () => {
    const t = collectDiagnostics().typing!
    const leaves: unknown[] = []
    const walk = (v: unknown): void => { if (v !== null && typeof v === 'object') Object.values(v).forEach(walk); else leaves.push(v) }
    walk(t)
    expect(leaves.every((x) => x === null || typeof x === 'boolean' || (typeof x === 'number' && Number.isFinite(x)))).toBe(true)
    expect(JSON.parse(JSON.stringify(t))).toEqual(t)
  })

  it('shows a registered source under extra: the wiring point for the pass counters', () => {
    registerTypingTraceSource('passes-fixture', () => ({ ingestRuns: 3, reflectRuns: 1 }))
    expect(collectDiagnostics().typing!.extra['passes-fixture']).toEqual({ ingestRuns: 3, reflectRuns: 1 })
  })

  it('stays out of the issue text: the markdown block prints the seven old lines and nothing else', () => {
    const md = formatDiagnosticsMarkdown(collectDiagnostics())
    expect(md.split('\n').length).toBe(7 + 2) // 7 lines plus the two fences
    for (const word of ['typing', 'loop', 'elu', 'gc', 'ipc', 'memory']) expect(md.toLowerCase()).not.toContain(word)
  })
})

// 1.54.5 merge, seam 9: lane G's governor and lane B's trace both report how late the event loop is, on different
// bases. Each block carries its own floor next to its net numbers (loopDelayBasis.test.ts proves they agree).
describe('collectDiagnostics: the loop delay says which basis it is on', () => {
  it('the typing block carries the floor and the net numbers beside the raw ones', () => {
    const loop = collectDiagnostics().typing!.loopDelay
    expect(loop.idleFloorMs).toBe(process.platform === 'win32' ? 15.6 : 10)
    expect(Object.keys(loop.net).sort()).toEqual(['last', 'minute'])
    expect(loop.net).toEqual({ last: null, minute: null }) // nothing has been sampled in this test file
  })

  it('the governor block carries its floor too: null while no governor runs, as in the unit suite', () => {
    const g = collectDiagnostics().governor!
    expect(g).toHaveProperty('idleFloorMs', null)
    expect(g.lastP99Ms).toBeNull() // raw and net are both unread: nothing to reconcile yet
    expect(g.lastDelayMs).toBeNull()
  })
})
