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
      ['elu', 'enabled', 'extra', 'gc', 'ipc', 'loopDelay', 'memory', 't1', 't2', 'started', 'uptimeMs'].sort(),
    )
    expect(Object.keys(t.loopDelay).sort()).toEqual(['last', 'minute'])
    expect(Object.keys(t.gc).sort()).toEqual(['incrementalCount', 'incrementalMaxMs', 'majorCount', 'majorMaxMs', 'minorCount'])
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
    expect(Object.keys(d).sort()).toEqual([...LEGACY, 'typing'].sort())
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
